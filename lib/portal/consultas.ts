import { registrarDoPaciente } from '@/lib/auditoria/registrar'
import { db } from '@/lib/db'
import {
  agendamento,
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
import { somar, subtrair } from '@/lib/domain/dinheiro'
import { FUSO_PADRAO } from '@/lib/domain/fuso'
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
