import { registrarDoPaciente } from '@/lib/auditoria/registrar'
import { db } from '@/lib/db'
import {
  agendamento,
  anamnese,
  listaEspera,
  procedimento,
  regraAutoatendimento,
  cobranca,
  consentimento,
  documento,
  orcamento,
  orcamentoItem,
  pagamento,
  parcela,
  paciente,
  profissional,
  usuario,
} from '@/lib/db/schema'
import {
  REGRA_PADRAO,
  type RegraAutoatendimento,
  idadeEmAnos,
  janelaDeDias,
} from '@/lib/domain/autoatendimento'
import { horariosLivres } from '@/lib/agenda/consultas'
import { somar, subtrair } from '@/lib/domain/dinheiro'
import { FUSO_PADRAO, diaLocalIso } from '@/lib/domain/fuso'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import type { SessaoPortal } from './sessao'

/**
 * Consultas do portal do paciente.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  A REGRA DESTE ARQUIVO
 *
 *  Toda função recebe `SessaoPortal` e filtra por `sessao.pacienteId`.
 *  **Nenhuma recebe `pacienteId` como parâmetro.**
 *
 *  É a defesa contra IDOR, e ela é estrutural, não disciplinar: como o id só
 *  existe dentro da sessão, não há assinatura de função em que um id vindo da
 *  URL possa entrar. Trocar `/meu/consultas?id=outro` não muda nada, porque
 *  nenhuma consulta lê `id` da URL.
 *
 *  E **nada aqui é compartilhado com `lib/pacientes/`, `lib/agenda/` ou
 *  `lib/financeiro/`** — CLAUDE.md, decisão 2. As consultas do staff recebem
 *  `pacienteId` por parâmetro (correto lá: a recepção escolhe o paciente).
 *  Reusar uma delas aqui seria trazer esse parâmetro para dentro do portal, e é
 *  exatamente ali que nasce o vazamento.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── O que o paciente NÃO vê ─────────────────────────────────────────────────
 * Evolução clínica em texto. O prontuário é dele por direito (CFO), mas a evolução
 * é escrita em linguagem técnica para outro profissional — "sangramento à sondagem
 * em 4 sítios" lido sem contexto assusta sem informar. O portal mostra o
 * **histórico de atendimentos** (quando, com quem, o que foi feito) e a via formal
 * de pedir a íntegra é a clínica, com exportação auditada.
 */

// ── Próximas consultas ───────────────────────────────────────────────────────

export interface ConsultaDoPortal {
  readonly id: string
  readonly inicio: Date
  readonly fim: Date
  readonly status: string
  readonly confirmadoEm: Date | null
  readonly profissionalNome: string
}

export async function proximasConsultas(
  sessao: SessaoPortal,
  agora: Date = new Date(),
): Promise<readonly ConsultaDoPortal[]> {
  return db
    .select({
      id: agendamento.id,
      inicio: agendamento.inicio,
      fim: agendamento.fim,
      status: agendamento.status,
      confirmadoEm: agendamento.confirmadoEm,
      profissionalNome: usuario.nome,
    })
    .from(agendamento)
    .innerJoin(profissional, eq(profissional.id, agendamento.profissionalId))
    .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
    .where(
      and(
        // ⚠️ O filtro que importa. Vem da SESSÃO.
        eq(agendamento.pacienteId, sessao.pacienteId),
        sql`${agendamento.inicio} >= ${agora.toISOString()}::timestamptz`,
        sql`${agendamento.status} in ('agendado','confirmado')`,
      ),
    )
    .orderBy(asc(agendamento.inicio))
    .limit(20)
}

/** Histórico de atendimentos: o que aconteceu, sem o texto da evolução. */
export async function historicoDeAtendimentos(sessao: SessaoPortal, limite = 30) {
  return db
    .select({
      id: agendamento.id,
      inicio: agendamento.inicio,
      status: agendamento.status,
      profissionalNome: usuario.nome,
    })
    .from(agendamento)
    .innerJoin(profissional, eq(profissional.id, agendamento.profissionalId))
    .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
    .where(
      and(
        eq(agendamento.pacienteId, sessao.pacienteId),
        sql`${agendamento.status} in ('concluido','faltou')`,
      ),
    )
    .orderBy(desc(agendamento.inicio))
    .limit(limite)
}

// ── Financeiro ───────────────────────────────────────────────────────────────

export interface ParcelaDoPortal {
  readonly id: string
  readonly numero: number
  readonly valor: string
  readonly vencimento: string
  readonly saldo: string
  readonly pago: string
  readonly vencida: boolean
}

export interface FinanceiroDoPortal {
  readonly parcelas: readonly ParcelaDoPortal[]
  readonly totalEmAberto: string
  readonly totalVencido: string
}

/**
 * Parcelas do paciente.
 *
 * Mostra o que ele deve e o que já pagou — e **nada além disso**. Sem comissão do
 * profissional, sem custo da clínica, sem valor de convênio: são números da
 * clínica, não do paciente, e o portal não é lugar de negociação interna.
 */
export async function financeiroDoPortal(
  sessao: SessaoPortal,
  hojeIso: string,
): Promise<FinanceiroDoPortal> {
  const linhas = await db
    .select({
      id: parcela.id,
      numero: parcela.numero,
      valor: parcela.valor,
      vencimento: parcela.vencimento,
      pago: sql<string>`coalesce((
        select sum(pg.valor) from pagamento pg
        where pg.parcela_id = ${parcela.id} and pg.estornado_em is null
      ), 0)::text`,
    })
    .from(parcela)
    .innerJoin(cobranca, eq(cobranca.id, parcela.cobrancaId))
    .where(
      and(
        eq(cobranca.pacienteId, sessao.pacienteId),
        isNull(cobranca.canceladoEm),
        sql`${parcela.status} <> 'cancelada'`,
      ),
    )
    .orderBy(asc(parcela.vencimento), asc(parcela.numero))

  const parcelas = linhas.map((l) => {
    const saldo = subtrair(l.valor, l.pago)
    return {
      id: l.id,
      numero: l.numero,
      valor: l.valor,
      vencimento: l.vencimento,
      pago: l.pago,
      saldo,
      // `vencida` é derivada da data de hoje, não de um campo gravado — o mesmo
      // cuidado da Fase 8: flag gravada fica velha à meia-noite.
      vencida: Number(saldo) > 0 && l.vencimento < hojeIso,
    }
  })

  const emAberto = parcelas.filter((p) => Number(p.saldo) > 0)
  const vencidas = emAberto.filter((p) => p.vencida)

  return {
    parcelas,
    totalEmAberto: somaDeStrings(emAberto.map((p) => p.saldo)),
    totalVencido: somaDeStrings(vencidas.map((p) => p.saldo)),
  }
}

/** Recibos: pagamentos que o paciente fez. */
export async function pagamentosDoPortal(sessao: SessaoPortal, limite = 50) {
  return db
    .select({
      id: pagamento.id,
      valor: pagamento.valor,
      pagoEm: pagamento.pagoEm,
      meio: pagamento.meio,
      parcelaNumero: parcela.numero,
    })
    .from(pagamento)
    .innerJoin(parcela, eq(parcela.id, pagamento.parcelaId))
    .innerJoin(cobranca, eq(cobranca.id, parcela.cobrancaId))
    .where(and(eq(cobranca.pacienteId, sessao.pacienteId), isNull(pagamento.estornadoEm)))
    .orderBy(desc(pagamento.pagoEm))
    .limit(limite)
}

// ── Orçamentos ───────────────────────────────────────────────────────────────

/**
 * Orçamentos enviados ao paciente.
 *
 * Só os que a clínica **enviou** — rascunho é trabalho interno em andamento, e
 * mostrar preço em rascunho gera conversa sobre número que ainda vai mudar.
 */
export async function orcamentosDoPortal(sessao: SessaoPortal, hojeIso: string) {
  const linhas = await db
    .select({
      id: orcamento.id,
      numero: orcamento.numero,
      status: orcamento.status,
      validadeAte: orcamento.validadeAte,
      valorTotal: orcamento.valorTotal,
      desconto: orcamento.desconto,
      enviadoEm: orcamento.enviadoEm,
      decididoEm: orcamento.decididoEm,
    })
    .from(orcamento)
    .where(
      and(
        eq(orcamento.pacienteId, sessao.pacienteId),
        sql`${orcamento.status} in ('enviado','aprovado','recusado','expirado')`,
      ),
    )
    .orderBy(desc(orcamento.numero))

  return linhas.map((o) => ({
    ...o,
    // Expirado é derivado da validade, como na Fase 6.
    expirado: o.status === 'enviado' && o.validadeAte < hojeIso,
  }))
}

/**
 * Itens de um orçamento.
 *
 * Recebe o id do orçamento — **e confere que ele é do paciente da sessão**. Este é
 * o único ponto do portal em que um id vem de fora, porque a tela precisa abrir um
 * orçamento específico; a defesa é o `and` com o `pacienteId` da sessão, não a
 * confiança no id.
 */
export async function itensDoOrcamentoDoPortal(sessao: SessaoPortal, orcamentoId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(orcamentoId)) return null

  const [dono] = await db
    .select({ id: orcamento.id, numero: orcamento.numero })
    .from(orcamento)
    .where(
      and(
        eq(orcamento.id, orcamentoId),
        // ⚠️ Sem esta linha, qualquer paciente leria o orçamento de qualquer
        // outro trocando o id na URL.
        eq(orcamento.pacienteId, sessao.pacienteId),
        sql`${orcamento.status} in ('enviado','aprovado','recusado','expirado')`,
      ),
    )

  if (!dono) return null

  const itens = await db
    .select({
      id: orcamentoItem.id,
      descricao: orcamentoItem.descricao,
      detalhe: orcamentoItem.detalhe,
      quantidade: orcamentoItem.quantidade,
      valorUnitario: orcamentoItem.valorUnitario,
    })
    .from(orcamentoItem)
    .where(eq(orcamentoItem.orcamentoId, dono.id))
    .orderBy(asc(orcamentoItem.ordem))

  return { numero: dono.numero, itens }
}

// ── Documentos ───────────────────────────────────────────────────────────────

/**
 * Documentos que o paciente pode ver.
 *
 * **Nem todo anexo do prontuário vai para o portal.** Atestado, receita, orçamento
 * em PDF e termo assinado são documentos *dele* — foram feitos para ele levar.
 * Radiografia e foto clínica ficam de fora por decisão: são insumo de diagnóstico,
 * e uma imagem sem laudo gera interpretação errada e ligação assustada. Quem quiser
 * as imagens pede na clínica, e aí a entrega é acompanhada de explicação.
 */
const TIPOS_VISIVEIS = ['atestado', 'receita', 'orcamento_pdf', 'termo_consentimento'] as const

export async function documentosDoPortal(sessao: SessaoPortal) {
  return db
    .select({
      id: documento.id,
      tipo: documento.tipo,
      nome: documento.nome,
      criadoEm: documento.criadoEm,
      dataExame: documento.dataExame,
      tamanhoBytes: documento.tamanhoBytes,
    })
    .from(documento)
    .where(
      and(
        eq(documento.pacienteId, sessao.pacienteId),
        isNull(documento.removidoEm),
        sql`${documento.tipo} in ('atestado','receita','orcamento_pdf','termo_consentimento')`,
      ),
    )
    .orderBy(desc(documento.criadoEm))
    .limit(100)
}

/**
 * Um documento para download pelo portal.
 *
 * Confere as três coisas na mesma consulta: é do paciente da sessão, não foi
 * removido, e é de um tipo que o portal expõe. Faltar qualquer uma delas é
 * vazamento.
 */
export async function documentoDoPortalParaDownload(sessao: SessaoPortal, documentoId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(documentoId)) return null

  const [linha] = await db
    .select({
      id: documento.id,
      nome: documento.nome,
      storageKey: documento.storageKey,
      mimeType: documento.mimeType,
      sha256: documento.sha256,
      tipo: documento.tipo,
    })
    .from(documento)
    .where(
      and(
        eq(documento.id, documentoId),
        eq(documento.pacienteId, sessao.pacienteId),
        isNull(documento.removidoEm),
        sql`${documento.tipo} in ('atestado','receita','orcamento_pdf','termo_consentimento')`,
      ),
    )

  return linha ?? null
}

export { TIPOS_VISIVEIS }

// ── Dados cadastrais e LGPD ──────────────────────────────────────────────────

export async function meusDados(sessao: SessaoPortal) {
  const [p] = await db
    .select({
      nome: paciente.nome,
      nomeSocial: paciente.nomeSocial,
      dataNascimento: paciente.dataNascimento,
      telefone: paciente.telefone,
      telefoneWhatsapp: paciente.telefoneWhatsapp,
      email: paciente.email,
      cidade: paciente.cidade,
      uf: paciente.uf,
    })
    .from(paciente)
    .where(eq(paciente.id, sessao.pacienteId))

  const consentimentos = await db
    .select({
      id: consentimento.id,
      finalidade: consentimento.finalidade,
      baseLegal: consentimento.baseLegal,
      versaoTermo: consentimento.versaoTermo,
      aceitoEm: consentimento.aceitoEm,
      revogadoEm: consentimento.revogadoEm,
    })
    .from(consentimento)
    .where(eq(consentimento.pacienteId, sessao.pacienteId))
    .orderBy(desc(consentimento.aceitoEm))

  return { paciente: p ?? null, consentimentos }
}

// ── Auditoria da leitura ─────────────────────────────────────────────────────

/**
 * Registra que o paciente olhou o próprio dado.
 *
 * Parece excesso — é o dono olhando o que é dele. Mas a trilha responde outra
 * pergunta: *de onde* essa conta foi acessada. Um acesso de madrugada, de outro
 * estado, é o sinal que aparece depois de um vazamento de senha, e sem o registro
 * ninguém consegue reconstituir nada.
 */
export async function registrarAcessoDoPortal(
  sessao: SessaoPortal,
  tela: string,
  detalhes: Record<string, unknown> = {},
): Promise<void> {
  await registrarDoPaciente({
    acao: 'leitura',
    entidade: 'portal',
    entidadeId: sessao.sessaoId,
    pacienteId: sessao.pacienteId,
    detalhes: { tela, realm: 'portal', ...detalhes },
  })
}

export const FUSO_DO_PORTAL = FUSO_PADRAO

/**
 * Soma de dinheiro pela aritmética de centavos do domínio.
 *
 * `somar` de `lib/domain/dinheiro.ts`, não `Number(a) + Number(b)`: a convenção do
 * projeto é dinheiro em centavos inteiros, e o portal mostra saldo ao paciente —
 * é o último lugar onde um centavo de erro de float é aceitável.
 */
function somaDeStrings(valores: readonly string[]): string {
  return valores.length === 0 ? '0.00' : somar(...valores)
}

// ── Autoatendimento (Fase 19) ────────────────────────────────────────────────
//
// A regra do arquivo continua valendo aqui: nenhuma função abaixo aceita
// `pacienteId`. As que precisam do paciente o tiram de `sessao.pacienteId`.

/** A configuração do autoatendimento desta clínica. */
export async function regraDoAutoatendimento(): Promise<RegraAutoatendimento & {
  readonly termoDeAtendimento: string | null
  readonly versaoTermo: string
}> {
  const [linha] = await db
    .select({
      ativo: regraAutoatendimento.ativo,
      antecedenciaMinimaHoras: regraAutoatendimento.antecedenciaMinimaHoras,
      antecedenciaMaximaDias: regraAutoatendimento.antecedenciaMaximaDias,
      maximoFuturosPorPaciente: regraAutoatendimento.maximoFuturosPorPaciente,
      termoDeAtendimento: regraAutoatendimento.termoDeAtendimento,
      versaoTermo: regraAutoatendimento.versaoTermo,
    })
    .from(regraAutoatendimento)
    // Sem filtro explícito: a política de RLS já restringe à clínica do contexto, e
    // a tabela tem uma linha por clínica. Um `where` aqui seria redundante sob a
    // role da aplicação — mas ATENÇÃO: script rodando como DONO não tem política, e
    // por isso `lib/autoatendimento/demonstrar.ts` filtra explicitamente.
    .limit(1)

  /**
   * Sem linha, devolve o padrão DESLIGADO — nunca "ligado por omissão".
   *
   * A `drizzle/0031` cria a linha para toda clínica existente e o onboarding a cria
   * para as novas, então este caminho é teórico. Ele existe porque a alternativa
   * (estourar) derrubaria a tela inicial do portal por causa de uma configuração
   * ausente, e a alternativa oposta (assumir ligado) abriria a agenda.
   */
  if (!linha) {
    return { ...REGRA_PADRAO, termoDeAtendimento: null, versaoTermo: 'v1' }
  }
  return linha
}

/** Procedimentos que o paciente pode marcar sozinho. */
export async function procedimentosDoPortal(): Promise<
  readonly { readonly id: string; readonly nome: string; readonly duracaoMinutos: number }[]
> {
  return db
    .select({
      id: procedimento.id,
      nome: procedimento.nome,
      duracaoMinutos: procedimento.duracaoMinutos,
    })
    .from(procedimento)
    .where(and(eq(procedimento.ativo, true), eq(procedimento.permiteAutoagendamento, true)))
    .orderBy(asc(procedimento.nome))
}

/** Quantos agendamentos futuros ativos o paciente já tem — entrada do teto. */
export async function meusFuturosAtivos(sessao: SessaoPortal): Promise<number> {
  const [linha] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agendamento)
    .where(
      and(
        eq(agendamento.pacienteId, sessao.pacienteId),
        sql`${agendamento.inicio} > now()`,
        sql`${agendamento.status} in ('agendado','confirmado')`,
      ),
    )
  return linha?.n ?? 0
}

/**
 * Profissionais que atendem, para o paciente escolher.
 *
 * Só nome e id. **Nada de especialidade, CRO ou agenda** — o paciente escolhe entre
 * pessoas, não entre currículos, e cada campo extra aqui é um campo que a tela de um
 * paciente passa a expor sobre um funcionário.
 */
export async function profissionaisDoPortal(): Promise<
  readonly { readonly id: string; readonly nome: string }[]
> {
  return db
    .select({ id: profissional.id, nome: usuario.nome })
    .from(profissional)
    .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
    .where(and(eq(profissional.ativo, true), eq(usuario.ativo, true)))
    .orderBy(asc(usuario.nome))
}

/**
 * A grade que o paciente vê num dia.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ── Isto viola a decisão 2 ("nunca compartilhe query entre staff e portal")? ──
 *  **Não, e vale ser explícito porque parece que sim.**
 *
 *  A decisão está escrita com o motivo dela: *"as consultas do staff recebem
 *  `pacienteId` por parâmetro (correto lá: a recepção escolhe o paciente). Reusar
 *  uma delas aqui seria trazer esse parâmetro para dentro do portal, e é exatamente
 *  ali que nasce o vazamento."*
 *
 *  `horariosLivres` não tem `pacienteId` na assinatura, não lê paciente nenhum e não
 *  devolve dado de paciente — ela recebe dia, profissional e duração, e devolve
 *  intervalos vazios. Não há por onde um id da URL decidir de quem é o dado, porque
 *  não há dado de ninguém no retorno.
 *
 *  A regra proíbe compartilhar consulta **de dado de paciente**. Reescrever a grade
 *  aqui não aumentaria isolamento nenhum e criaria uma segunda implementação de
 *  horário de funcionamento, que divergiria no primeiro feriado.
 *
 *  ── Os dois motivos para reusar, e o segundo é de segurança ────────────────
 *
 *   1. aquela função já respeita horário de funcionamento, bloqueio de agenda e a
 *      EXCLUDE constraint. Uma segunda implementação divergiria no primeiro
 *      feriado;
 *   2. ela devolve **apenas os livres** — `{hora, inicio, fim}`. Não existe caminho
 *      em que "ocupado por Fulano" chegue aqui, porque a informação não sai de lá.
 *      Se um dia alguém acrescentar `ocupadoPor` ao retorno dela para a tela da
 *      recepção, este ponto passa a precisar de filtro — e é por isso que o teste
 *      por HTTP procura nome e id de terceiro no HTML.
 *
 *  Exceção consciente à regra do arquivo: `dia`, `profissionalId` e
 *  `procedimentoId` vêm de fora. São escolhas do paciente na tela, não identidade —
 *  o que a regra proíbe é `pacienteId` por parâmetro, porque é ele que decide de
 *  QUEM é o dado.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function horariosParaOPaciente(
  sessao: SessaoPortal,
  entrada: { readonly diaIso: string; readonly profissionalId: string; readonly procedimentoId: string },
  agora: Date = new Date(),
): Promise<
  | { readonly ok: true; readonly horarios: readonly { readonly hora: string; readonly inicio: Date }[] }
  | { readonly ok: false; readonly mensagem: string }
> {
  const regra = await regraDoAutoatendimento()
  if (!regra.ativo) {
    return { ok: false, mensagem: 'Esta clínica ainda não abriu o agendamento pelo portal.' }
  }

  const [proc] = await db
    .select({ duracao: procedimento.duracaoMinutos, liberado: procedimento.permiteAutoagendamento })
    .from(procedimento)
    .where(and(eq(procedimento.id, entrada.procedimentoId), eq(procedimento.ativo, true)))
    .limit(1)

  if (!proc || !proc.liberado) {
    return {
      ok: false,
      mensagem: 'Este atendimento precisa ser combinado com a clínica. Fale com a recepção.',
    }
  }

  const livres = await horariosLivres({
    diaIso: entrada.diaIso,
    profissionalId: entrada.profissionalId,
    duracaoMin: proc.duracao,
  })

  /**
   * A janela da regra é aplicada AQUI, sobre os horários que a agenda considera
   * livres — a grade não pode oferecer o que `avaliarPedido` vai recusar. Oferecer e
   * depois recusar é a pior combinação: o paciente escolhe e leva um "não" que
   * parece defeito do sistema.
   */
  const { de, ate } = janelaDeDias(regra, agora)
  const dentroDaJanela = livres.filter((h) => h.inicio >= de && h.inicio <= ate)

  await registrarAcessoDoPortal(sessao, 'agendar', { dia: entrada.diaIso })

  // Só `hora` e `inicio`. `fim` sairia daqui sem uso na tela e permitiria inferir a
  // duração — que é o procedimento — de quem marcou antes.
  return { ok: true, horarios: dentroDaJanela.map((h) => ({ hora: h.hora, inicio: h.inicio })) }
}

/** Minha posição na lista de espera. */
export async function minhaListaDeEspera(sessao: SessaoPortal) {
  return db
    .select({
      id: listaEspera.id,
      turno: listaEspera.turno,
      validoAte: listaEspera.validoAte,
      situacao: listaEspera.situacao,
      criadoEm: listaEspera.criadoEm,
      procedimentoNome: procedimento.nome,
    })
    .from(listaEspera)
    .leftJoin(procedimento, eq(procedimento.id, listaEspera.procedimentoId))
    .where(and(eq(listaEspera.pacienteId, sessao.pacienteId), eq(listaEspera.situacao, 'aguardando')))
    .orderBy(desc(listaEspera.criadoEm))
}

/**
 * A anamnese que o paciente respondeu, e se um profissional já conferiu.
 *
 * Devolve `conferidaEm` de propósito: o paciente vê "enviado, aguardando conferência
 * da clínica". Sem isso ele acha que respondeu e está resolvido — e no dia da
 * consulta a auxiliar pede tudo de novo, o que faz o recurso parecer inútil.
 */
export async function minhaAnamnese(sessao: SessaoPortal) {
  const [linha] = await db
    .select({
      id: anamnese.id,
      versao: anamnese.versao,
      origem: anamnese.origem,
      preenchidaEm: anamnese.preenchidaEm,
      conferidaEm: anamnese.conferidaEm,
    })
    .from(anamnese)
    .where(eq(anamnese.pacienteId, sessao.pacienteId))
    .orderBy(desc(anamnese.versao))
    .limit(1)
  return linha ?? null
}

/**
 * As RESPOSTAS da última anamnese, para o formulário do portal abrir preenchido.
 *
 * Separada de `minhaAnamnese` de propósito: aquela é o cabeçalho que a página inicial
 * mostra, e carregar o JSONB inteiro ali seria pagar por um dado que ninguém lê.
 *
 * ── Por que devolve as respostas ANTERIORES, inclusive as da clínica ────────
 * Anamnese não se responde do zero a cada versão. O paciente que preencheu há oito
 * meses vai mudar duas linhas, e apresentar o formulário vazio faz ele desistir na
 * terceira pergunta — ou pior, responder "não" para tudo por pressa, o que produz
 * declaração falsa sobre alergia.
 *
 * Isso **não** apaga nada: `responderMinhaAnamnese` sempre grava uma versão nova
 * (`anamnese_paciente_versao_uk`), e a anterior continua no prontuário.
 */
export async function minhasRespostasDeAnamnese(sessao: SessaoPortal): Promise<{
  readonly respostas: Record<string, unknown>
  readonly versaoFormulario: string | null
} | null> {
  const [linha] = await db
    .select({
      respostas: anamnese.respostas,
      versaoFormulario: anamnese.versaoFormulario,
    })
    .from(anamnese)
    .where(eq(anamnese.pacienteId, sessao.pacienteId))
    .orderBy(desc(anamnese.versao))
    .limit(1)

  if (!linha) return null
  return {
    respostas: (linha.respostas ?? {}) as Record<string, unknown>,
    versaoFormulario: linha.versaoFormulario,
  }
}

/**
 * Quem esta sessão pode assinar por: ela mesma, e os menores sob responsabilidade.
 *
 * ── Por que a lista de dependentes sai daqui, e por que isso NÃO fura a regra ──
 * A regra do arquivo é que nenhuma função aceite `pacienteId` — e nenhuma aceita.
 * Esta **descobre** os ids a partir de `sessao.pacienteId`, consultando quem tem
 * `responsavel_legal_id` apontando para ele. O id vem do banco, não da requisição, e é
 * o mesmo caminho que `quemAssina` valida de novo na hora de gravar.
 *
 * Dupla verificação de propósito: a tela precisa saber quem oferecer (senão o
 * responsável não tem como assinar pelo filho), e a ação precisa validar de novo
 * (senão a tela seria a única defesa, e tela não é defesa).
 *
 * ── E o caso que a tela tem de EXPLICAR ────────────────────────────────────
 * Um paciente menor com conta própria no portal não pode assinar nada — `quemAssina`
 * levanta `MENOR_NAO_ASSINA`. Devolver `souMenor` deixa a tela dizer isso em vez de
 * simplesmente não mostrar o botão, que é o que faz alguém ligar para a clínica
 * perguntando por que a tela está quebrada.
 */
export async function quemEuAssinoPor(sessao: SessaoPortal): Promise<{
  readonly souMenor: boolean
  readonly meuNome: string
  readonly dependentes: readonly { readonly id: string; readonly nome: string }[]
}> {
  const hoje = diaLocalIso(new Date(), FUSO_DO_PORTAL)

  const [eu] = await db
    .select({ nome: paciente.nome, nascimento: paciente.dataNascimento })
    .from(paciente)
    .where(eq(paciente.id, sessao.pacienteId))
    .limit(1)

  const dependentes = await db
    .select({ id: paciente.id, nome: paciente.nome, nascimento: paciente.dataNascimento })
    .from(paciente)
    .where(eq(paciente.responsavelLegalId, sessao.pacienteId))
    .orderBy(asc(paciente.nome))

  return {
    souMenor: eu ? idadeEmAnos(eu.nascimento, hoje) < 18 : false,
    meuNome: eu?.nome ?? sessao.nome,
    // Só os que ainda são menores: dependente que fez 18 assina o próprio termo, e
    // oferecê-lo aqui produziria `ASSINATURA_DE_TERCEIRO` na gravação.
    dependentes: dependentes
      .filter((d) => idadeEmAnos(d.nascimento, hoje) < 18)
      .map((d) => ({ id: d.id, nome: d.nome })),
  }
}
