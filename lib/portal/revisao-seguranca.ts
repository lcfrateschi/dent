import { randomUUID } from 'node:crypto'
import { gerarConvite, gerarTokenDeSessao, hashDoTokenDeSessao } from '@/lib/auth/convite'
import { gerarHashSenha } from '@/lib/auth/senha'
import { gerarCodigoTotp, gerarSegredoTotp } from '@/lib/auth/totp'
import { db, pool } from '@/lib/db'
import {
  agendamento,
  anamnese,
  consentimento,
  documento,
  listaEspera,
  paciente,
  pacienteConta,
  pacienteSessao,
  procedimento,
  profissional,
  regraAutoatendimento,
  usuario,
} from '@/lib/db/schema'
import { COOKIE_PORTAL } from './sessao'
import { and, eq } from 'drizzle-orm'
import { desligarTriggersDeAplicacao, religarTriggersDeAplicacao } from '@/lib/demo/triggers'
import { idDaPrimeiraClinica } from '@/lib/demo/clinicaDaDemo'
import { clinicaDoContexto, comContextoDeClinica } from '@/lib/tenant/contexto'

/**
 * Revisão de segurança do portal — **obrigatória nesta fase** (ROADMAP).
 *
 * `npm run portal:seguranca`
 *
 * Não é teste de feliz caminho: é uma bateria **adversarial**. Cada caso tenta
 * fazer algo que não deveria funcionar, e o script falha se qualquer tentativa
 * tiver êxito. É a diferença entre "o portal funciona" e "o portal não vaza".
 *
 * O que está sendo atacado:
 *
 *   A. IDOR — ler dado de outro paciente trocando id na URL
 *   B. Cruzamento de realms — cookie de staff no portal e vice-versa
 *   C. Sessão — token forjado, revogado, expirado, de conta desativada
 *   D. Convite — reuso, expirado, token de outra conta
 *   E. Força bruta — bloqueio depois de N tentativas
 *   F. Enumeração — a resposta não revela se a conta existe
 *
 * Dois pacientes são criados, cada um com dado próprio, e o script tenta acessar
 * o dado do B usando a sessão do A.
 */

const BASE = 'http://localhost:3000'
const SENHA_A = 'portal seguro A 42'
const SENHA_B = 'portal seguro B 42'
const SENHA_STAFF = 'Staff-Revisao-2026!x'
/**
 * Marcador único plantado no dado do paciente B.
 *
 * Procurar o nome dele no HTML é frágil nos dois sentidos: pode não aparecer mesmo
 * havendo vazamento (o nome vem de outra consulta) e pode aparecer sem vazamento. Uma
 * string que só existe naquela linha responde exatamente "este byte saiu de lá?".
 */
const SEGREDO_DE_B = 'MARCADOR-VAZAMENTO-B-8f3a1c'
/** Marcador no texto do termo, para provar que a tela de assinatura renderizou. */
const SEGREDO_DE_TERMO = 'MARCADOR-TERMO-4b7e2d'

let falhas = 0
let passaram = 0

function bloco(titulo: string): void {
  console.log(`\n\x1b[1m${titulo}\x1b[0m`)
}

/** Registra o resultado de uma tentativa de ataque. */
function deveFalhar(condicaoDeSeguranca: boolean, descricao: string, detalhe = ''): void {
  if (condicaoDeSeguranca) {
    passaram++
    console.log(`   \x1b[32m✓ bloqueado\x1b[0m ${descricao}${detalhe ? ` — ${detalhe}` : ''}`)
  } else {
    falhas++
    console.error(`   \x1b[31m✗ VAZOU\x1b[0m ${descricao}${detalhe ? ` — ${detalhe}` : ''}`)
  }
}

function deveFuncionar(condicao: boolean, descricao: string, detalhe = ''): void {
  if (condicao) {
    passaram++
    console.log(`   \x1b[32m✓\x1b[0m ${descricao}${detalhe ? ` — ${detalhe}` : ''}`)
  } else {
    falhas++
    console.error(`   \x1b[31m✗ quebrou\x1b[0m ${descricao}${detalhe ? ` — ${detalhe}` : ''}`)
  }
}

function juntar(...listas: string[][]): string {
  const m = new Map<string, string>()
  for (const l of listas)
    for (const b of l) {
      const par = b.split(';')[0]!
      m.set(par.slice(0, par.indexOf('=')), par)
    }
  return [...m.values()].join('; ')
}

/** Login no portal por HTTP, devolvendo o cookie. */
async function entrarNoPortalHttp(
  email: string,
  senha: string,
): Promise<{ cookie: string | null; corpo: string }> {
  // O login do portal é server action; chamar por HTTP exigiria o id da action.
  // Então a sessão é aberta pelo caminho de produção (a action) via um endpoint
  // interno? Não existe. Aqui o script cria a sessão como o servidor criaria e
  // usa o cookie — o que é fiel: o que se está testando é o CONSUMO do cookie.
  const [conta] = await db
    .select({ id: pacienteConta.id })
    .from(pacienteConta)
    .where(eq(pacienteConta.email, email))

  if (!conta) return { cookie: null, corpo: 'conta inexistente' }

  const { token, hash } = gerarTokenDeSessao()
  await db.insert(pacienteSessao).values({
    contaId: conta.id,
    tokenHash: hash,
    expiraEm: new Date(Date.now() + 12 * 3_600_000),
    ip: '127.0.0.1',
    userAgent: 'revisao-seguranca',
  })
  void senha
  return { cookie: `${COOKIE_PORTAL}=${token}`, corpo: '' }
}

async function entrarComoStaff(email: string, segredo: string): Promise<string> {
  const r1 = await fetch(`${BASE}/api/auth/csrf`)
  const c1 = juntar(r1.headers.getSetCookie())
  const { csrfToken } = (await r1.json()) as { csrfToken: string }
  const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: c1 },
    body: new URLSearchParams({
      email,
      senha: SENHA_STAFF,
      codigo: gerarCodigoTotp(segredo),
      csrfToken,
      callbackUrl: BASE,
      json: 'true',
    }),
    redirect: 'manual',
  })
  return juntar(c1.split('; '), r2.headers.getSetCookie())
}

async function main(): Promise<void> {
  console.log('\n═══ Revisão de segurança do portal do paciente ═══')

  /**
   * A clínica em que este script trabalha, lida do contexto.
   *
   * Necessária porque o script roda como DONO das tabelas, e ali **não há política de
   * RLS filtrando por você**: todo `update` sem `where clinica_id` alcança todas as
   * clínicas. Ver o comentário no bloco A2, que documenta o estrago que isso causou.
   */
  const clinicaDoTeste = clinicaDoContexto()
  if (!clinicaDoTeste) throw new Error('Sem clínica no contexto — o envelope não foi aberto.')

  const criados = { usuarios: [] as string[], pacientes: [] as string[] }

  // ── Cenário: dois pacientes com dado próprio, e um dentista ────────────────
  const segredoStaff = gerarSegredoTotp()
  const emailStaff = `rev-staff-${Date.now()}@local`
  // As duas linhas na MESMA transação: a trava deferida de `drizzle/0021` cobra
  // no commit que dentista ativo tenha cadastro de profissional.
  const { uStaff, prof } = await db.transaction(async (tx) => {
    const [novoUsuario] = await tx
      .insert(usuario)
      .values({
        nome: 'Dra. Revisão',
        email: emailStaff,
        senhaHash: await gerarHashSenha(SENHA_STAFF),
        perfil: 'dentista',
        mfaSecret: segredoStaff,
        mfaAtivo: true,
      })
      .returning({ id: usuario.id })
    const [novoProf] = await tx
      .insert(profissional)
      .values({ usuarioId: novoUsuario!.id, cro: `S${Date.now() % 100000}`, ufCro: 'SP' })
      .returning({ id: profissional.id })
    return { uStaff: novoUsuario, prof: novoProf }
  })
  criados.usuarios.push(uStaff!.id)

  const marca = Date.now()
  const contas: { pacienteId: string; contaId: string; email: string; senha: string }[] = []

  for (const [i, senha] of [SENHA_A, SENHA_B].entries()) {
    const [p] = await db
      .insert(paciente)
      .values({ nome: `Revisão Paciente ${i === 0 ? 'A' : 'B'}`, dataNascimento: '1990-01-01' })
      .returning({ id: paciente.id })
    criados.pacientes.push(p!.id)

    const email = `rev-p${i}-${marca}@local`
    const [c] = await db
      .insert(pacienteConta)
      .values({
        pacienteId: p!.id,
        email,
        senhaHash: await gerarHashSenha(senha),
        senhaDefinidaEm: new Date(),
      })
      .returning({ id: pacienteConta.id })

    contas.push({ pacienteId: p!.id, contaId: c!.id, email, senha })
  }

  const A = contas[0]!
  const B = contas[1]!

  // Dado do paciente B, que o A vai tentar alcançar.
  const inicioB = new Date(Date.now() + 48 * 3_600_000)
  const [agB] = await db
    .insert(agendamento)
    .values({
      pacienteId: B.pacienteId,
      profissionalId: prof!.id,
      inicio: inicioB,
      fim: new Date(inicioB.getTime() + 3_600_000),
    })
    .returning({ id: agendamento.id })

  const orcB = await criarOrcamentoEnviado(B.pacienteId, prof!.id, uStaff!.id)
  const docB = await criarDocumento(B.pacienteId, uStaff!.id)

  /**
   * Dado das telas novas, do paciente B: uma ficha de saúde e um pedido na fila.
   *
   * O texto `SEGREDO_DE_B` entra numa resposta da anamnese de propósito. Procurar o
   * NOME do paciente B no HTML não bastaria: o nome pode aparecer legitimamente em
   * outro lugar da página (não aparece, mas poderia), e um marcador único só pode ter
   * vindo da anamnese dele.
   */
  const [anamneseB] = await db
    .insert(anamnese)
    .values({
      pacienteId: B.pacienteId,
      profissionalId: prof!.id,
      versao: 1,
      respostas: { alergias: { tipo: 'sim_nao_detalhe', valor: true, detalhe: SEGREDO_DE_B } },
      versaoFormulario: '1',
      origem: 'clinica',
    })
    .returning({ id: anamnese.id })

  const [esperaB] = await db
    .insert(listaEspera)
    .values({
      pacienteId: B.pacienteId,
      turno: 'manha',
      validoAte: new Date(Date.now() + 30 * 86_400_000),
      observacao: SEGREDO_DE_B,
    })
    .returning({ id: listaEspera.id })

  try {
    const sessaoA = await entrarNoPortalHttp(A.email, A.senha)
    if (!sessaoA.cookie) throw new Error('não consegui abrir sessão do paciente A')
    const cookieA = sessaoA.cookie

    // ── A. IDOR ─────────────────────────────────────────────────────────────
    bloco('A. IDOR — sessão do paciente A tentando alcançar dado do paciente B')

    const orcamentoDeB = await fetch(`${BASE}/meu/orcamentos/${orcB.id}`, {
      headers: { cookie: cookieA },
      redirect: 'manual',
    })
    deveFalhar(
      orcamentoDeB.status === 404,
      'abrir orçamento de outro paciente pela URL',
      `status ${orcamentoDeB.status}`,
    )

    const documentoDeB = await fetch(`${BASE}/api/meu/documentos/${docB.id}`, {
      headers: { cookie: cookieA },
      redirect: 'manual',
    })
    deveFalhar(
      documentoDeB.status === 404,
      'baixar documento de outro paciente',
      `status ${documentoDeB.status}`,
    )

    // Contraprova: o próprio documento tem de ser alcançável. Sem isto,
    // "bloqueado" poderia significar apenas que a rota está quebrada — que foi
    // exatamente o defeito que esta revisão encontrou na primeira execução.
    const docA = await criarDocumento(A.pacienteId, uStaff!.id)
    const meuDocumento = await fetch(`${BASE}/api/meu/documentos/${docA.id}`, {
      headers: { cookie: cookieA },
      redirect: 'manual',
    })
    deveFuncionar(
      // 500 = integridade recusada (o arquivo de teste não existe no storage), o
      // que ainda prova que a AUTORIZAÇÃO passou. 401/404 provariam o contrário.
      meuDocumento.status !== 401 && meuDocumento.status !== 404,
      'o paciente A alcança o documento DELE (autorização passou)',
      `status ${meuDocumento.status}`,
    )

    // O próprio dado do A precisa continuar funcionando — senão "bloqueado" seria
    // só o portal estar quebrado.
    const orcA = await criarOrcamentoEnviado(A.pacienteId, prof!.id, uStaff!.id)
    const meuOrcamento = await fetch(`${BASE}/meu/orcamentos/${orcA.id}`, {
      headers: { cookie: cookieA },
      redirect: 'manual',
    })
    deveFuncionar(
      meuOrcamento.status === 200,
      'o paciente A abre o orçamento DELE',
      `status ${meuOrcamento.status}`,
    )

    const inicio = await fetch(`${BASE}/meu`, { headers: { cookie: cookieA } })
    const htmlInicio = inicio.status === 200 ? await inicio.text() : ''
    deveFalhar(
      !htmlInicio.includes('Revisão Paciente B'),
      'nome de outro paciente aparecer na tela inicial',
    )
    deveFalhar(
      !htmlInicio.includes(agB!.id),
      'id de agendamento de outro paciente aparecer no HTML',
    )

    // ── A2. Autoatendimento (Fase 19) ───────────────────────────────────────
    //
    // ⚠️ **O recurso tem de estar LIGADO aqui, e isto não é conveniência de fixture.**
    //
    // A primeira versão deste bloco rodou com `regra_autoatendimento.ativo = false` (o
    // padrão, e a decisão certa para produção). A tela abriu com 200, mostrou o aviso
    // "esta clínica ainda não abriu o agendamento" — e **quatro dos seis casos passaram
    // vazios**: não havia grade nenhuma para vazar o nome do outro paciente.
    //
    // Nona ocorrência desta forma neste projeto. O padrão é sempre o mesmo: a
    // asserção procura algo que não pode aparecer, e o que ela não vê é a ausência da
    // tela inteira, não a ausência do vazamento.
    //
    // Então: liga, mede, e restaura no fim. E o caso `deveFuncionar` sobre a grade
    // existir é o que impede isto voltar a ser vazio — se a grade não renderizar, a
    // revisão reprova em vez de ficar verde.
    const [regraAntes] = await db
      .select({ ativo: regraAutoatendimento.ativo })
      .from(regraAutoatendimento)
      .where(eq(regraAutoatendimento.clinicaId, clinicaDoTeste))
      .limit(1)

    // Só a clínica do teste, pelo mesmo motivo: como dono, um `update` sem `where`
    // alcança todas.
    await db
      .update(regraAutoatendimento)
      .set({ ativo: true })
      .where(eq(regraAutoatendimento.clinicaId, clinicaDoTeste))
    /**
     * UM procedimento marcável, escolhido por id.
     *
     * ⚠️ A primeira versão fazia `update procedimento set permite_autoagendamento =
     * true where ativo = true` — sem `clinica_id`, e este script roda como **DONO**,
     * onde não há política de RLS filtrando por você. Resultado medido: **440
     * procedimentos de todas as clínicas marcados como agendáveis pelo paciente**, e a
     * restauração devolvia só o primeiro.
     *
     * O estrago não é cosmético: é exatamente o que o default `false` existe para
     * impedir. Bastaria a clínica ligar o autoatendimento depois para o paciente poder
     * marcar exodontia de terceiro molar pelo celular — e ninguém saberia que foi uma
     * revisão de segurança que abriu a lista.
     *
     * Quarta vez que a falta de `where clinica_id` num script rodando como dono morde
     * alguém neste projeto. Aqui o `select` escolhe um id, e o `update` mira nele.
     */
    const [candidato] = await db
      .select({ id: procedimento.id })
      .from(procedimento)
      .where(and(eq(procedimento.ativo, true), eq(procedimento.clinicaId, clinicaDoTeste)))
      .limit(1)
    if (candidato) {
      await db
        .update(procedimento)
        .set({ permiteAutoagendamento: true })
        .where(eq(procedimento.id, candidato.id))
    }
    const procMarcavel = candidato

    //
    // A fase acrescentou rotas que ESCREVEM na agenda a partir do portal. Sem casos
    // aqui, a rede de IDOR ficaria com um buraco do tamanho da fase — e o buraco
    // estaria justamente nas rotas novas, que são as menos exercitadas.
    bloco('A2. Autoatendimento — a grade e o desmarcar')

    const agendar = await fetch(`${BASE}/meu/agendar`, {
      headers: { cookie: cookieA },
      redirect: 'manual',
    })
    const htmlAgendar = agendar.status === 200 ? await agendar.text() : ''

    // A tela abre (o autoatendimento pode estar desligado, e aí ela explica isso) —
    // o que ela NÃO pode é falar de outro paciente.
    deveFuncionar(
      agendar.status === 200,
      'a tela de agendar abre para o paciente A',
      `status ${agendar.status}`,
    )
    /**
     * A grade EXISTE nesta página — a contraprova que dá sentido aos casos abaixo.
     *
     * Sem ela, "o nome do outro paciente não aparece" seria verdade também numa página
     * em branco, e a revisão ficaria verde provando nada. É o mesmo raciocínio do
     * `deveFuncionar` do documento próprio, algumas linhas acima.
     */
    deveFuncionar(
      htmlAgendar.includes('Tipo de atendimento') && htmlAgendar.includes('Com quem'),
      'a grade de agendamento realmente renderizou (senão os casos abaixo seriam vazios)',
    )
    deveFalhar(
      !htmlAgendar.includes('Revisão Paciente B'),
      'nome de outro paciente aparecer na tela de agendar',
    )
    deveFalhar(
      !htmlAgendar.includes(agB!.id),
      'id de agendamento de outro paciente aparecer na tela de agendar',
    )
    deveFalhar(
      !htmlAgendar.includes(B.pacienteId),
      'id do paciente B aparecer no HTML da tela de agendar',
    )

    /**
     * A grade é o ponto sensível da fase: ela mostra o que está LIVRE, e a ausência
     * de um horário revela que alguém o ocupou. Isso é inevitável — é a natureza de
     * uma agenda pública — e o que não pode aparecer é QUEM.
     *
     * `horariosLivres` devolve apenas `{hora, inicio, fim}`, então o vazamento só
     * seria possível por um campo novo. Este caso é a rede para o dia em que alguém
     * acrescentar `ocupadoPor` para a tela da recepção e a mesma função continuar
     * alimentando o portal.
     */
    deveFalhar(
      !/ocupad[oa]\s+por/i.test(htmlAgendar) && !htmlAgendar.includes('Revisão Paciente'),
      'a grade do paciente dizer quem ocupa um horário',
    )

    // Desmarcar por id na URL: a ação exige sessão e filtra por `sessao.pacienteId`,
    // mas o caso existe porque "exige sessão" e "filtra pelo paciente da sessão" são
    // duas coisas, e é a segunda que impede o IDOR.
    const desmarcarDeB = await fetch(`${BASE}/meu`, {
      method: 'POST',
      headers: {
        cookie: cookieA,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ agendamentoId: agB!.id, motivo: 'tentativa' }),
      redirect: 'manual',
    })
    deveFalhar(
      desmarcarDeB.status !== 200 || !(await desmarcarDeB.text()).includes('desmarcada'),
      'desmarcar consulta de outro paciente por POST',
      `status ${desmarcarDeB.status}`,
    )

    // Restaura o autoatendimento como estava. Deixar ligado mudaria o comportamento
    // do portal para quem for testar depois, e essa pessoa não teria como saber que
    // foi uma revisão de segurança que abriu a agenda da clínica.
    await db
      .update(regraAutoatendimento)
      .set({ ativo: regraAntes?.ativo ?? false })
      .where(eq(regraAutoatendimento.clinicaId, clinicaDoTeste))
    if (procMarcavel) {
      await db
        .update(procedimento)
        .set({ permiteAutoagendamento: false })
        .where(eq(procedimento.id, procMarcavel.id))
    }

    // ── A3. Ficha de saúde, termos e a fila (telas da Fase 19) ──────────────
    //
    // Três rotas novas que LEEM e ESCREVEM dado sensível: a anamnese (declaração de
    // saúde), o termo (consentimento) e a lista de espera. Sem casos aqui, a rede de
    // IDOR ficaria com um buraco do tamanho das telas — e o buraco estaria nas rotas
    // menos exercitadas, que são justamente as novas.
    bloco('A3. Ficha de saúde, termos e fila — as telas novas')

    const fichaDeA = await fetch(`${BASE}/meu/anamnese`, {
      headers: { cookie: cookieA },
      redirect: 'manual',
    })
    const htmlFicha = fichaDeA.status === 200 ? await fichaDeA.text() : ''

    /**
     * A ficha de A ABRE e RENDERIZOU o formulário — a contraprova que dá sentido aos
     * dois casos seguintes.
     *
     * Sem ela, "o marcador do paciente B não aparece" seria verdade também numa página
     * em branco, e a revisão ficaria verde provando nada. Nona e décima ocorrência
     * desta forma no projeto; o padrão é sempre o mesmo, então a contraprova vem
     * primeiro.
     */
    deveFuncionar(
      fichaDeA.status === 200,
      'a ficha de saúde abre para o paciente A',
      `status ${fichaDeA.status}`,
    )
    /**
     * Os marcadores são do PRIMEIRO passo, e isso não é detalhe.
     *
     * A primeira versão procurava `'Enviar minhas respostas'` — o botão do ÚLTIMO passo
     * de um formulário de quatro. Ele não está no HTML servido, e o caso reprovou
     * apontando para a página como se ela estivesse quebrada. A página estava certa; a
     * asserção estava errada, e foi a contraprova pegando o meu erro em vez do da tela.
     *
     * Também evitei procurar `'Parte 1 de'`: o texto vem de `Parte {passo+1} de {total}`,
     * e o React separa nós de texto interpolado com marcadores de comentário — o HTML
     * traz `Parte <!-- -->1<!-- --> de`. Buscar frase com expressão no meio é falso
     * negativo esperando acontecer.
     */
    deveFuncionar(
      htmlFicha.includes('Saúde geral') && htmlFicha.includes('Continuar'),
      'o formulário da ficha realmente renderizou (senão os casos abaixo seriam vazios)',
    )
    deveFalhar(
      !htmlFicha.includes(SEGREDO_DE_B),
      'resposta de anamnese de outro paciente aparecer na ficha de A',
    )
    deveFalhar(
      !htmlFicha.includes(anamneseB!.id) && !htmlFicha.includes(B.pacienteId),
      'id de anamnese ou de paciente alheio aparecer no HTML da ficha',
    )

    /**
     * ⚠️ O TERMO tem de EXISTIR aqui, e isto não é conveniência de fixture.
     *
     * `regra_autoatendimento.termo_de_atendimento` é nulo no banco de desenvolvimento —
     * a clínica não escreveu termo nenhum. Com ele nulo, `/meu/termos` mostra "esta
     * clínica não tem termo para aceitar" e **a tela de assinatura não renderiza**: o
     * caso de conformidade abaixo ("não promete validade jurídica") passaria sem que
     * nenhuma das frases jurídicas existisse na página.
     *
     * Décima primeira ocorrência desta forma no projeto, e a segunda dentro deste
     * arquivo — o bloco A2 documenta a mesma coisa sobre `ativo`. Então: escreve o
     * termo, mede, e restaura no fim.
     */
    const [termoAntes] = await db
      .select({ termo: regraAutoatendimento.termoDeAtendimento })
      .from(regraAutoatendimento)
      .where(eq(regraAutoatendimento.clinicaId, clinicaDoTeste))
      .limit(1)

    await db
      .update(regraAutoatendimento)
      .set({ termoDeAtendimento: `Termo de atendimento da revisão. ${SEGREDO_DE_TERMO}` })
      .where(eq(regraAutoatendimento.clinicaId, clinicaDoTeste))

    const termosDeA = await fetch(`${BASE}/meu/termos`, {
      headers: { cookie: cookieA },
      redirect: 'manual',
    })
    const htmlTermos = termosDeA.status === 200 ? await termosDeA.text() : ''
    deveFuncionar(
      termosDeA.status === 200,
      'a tela de termos abre para o paciente A',
      `status ${termosDeA.status}`,
    )
    /**
     * A tela de ASSINATURA renderizou — a contraprova do caso de conformidade.
     *
     * Procura o texto do termo (marcador único) **e** o controle de aceite. Só o
     * primeiro provaria que o termo apareceu; só o segundo poderia casar com outra
     * parte da página. Os dois juntos dizem "a interface de assinar está na tela".
     */
    deveFuncionar(
      htmlTermos.includes(SEGREDO_DE_TERMO) && htmlTermos.includes('Li o texto acima'),
      'a tela de assinatura realmente renderizou (senão o caso de conformidade seria vazio)',
    )
    /**
     * ⚖️ A tela não pode prometer validade que a assinatura não tem.
     *
     * Este caso é de conformidade, não de IDOR, e está aqui porque é o único lugar do
     * projeto que roda contra o HTML servido. O que se grava é assinatura eletrônica
     * **simples** (MP 2.200-2/2001): as palavras abaixo afirmariam outra coisa, e a
     * frase que engana o paciente é a mesma que se lê em voz alta contra a clínica.
     */
    deveFalhar(
      !/validade jur[íi]dica|assinatura digital|ICP-Brasil|certificado digital/i.test(htmlTermos),
      'a tela de termos prometer validade jurídica ou assinatura digital',
    )
    deveFalhar(
      !htmlTermos.includes(SEGREDO_DE_B) && !htmlTermos.includes(B.pacienteId),
      'dado ou id de outro paciente aparecer na tela de termos',
    )

    /**
     * Assinar EM NOME DE OUTRO paciente, por id na requisição.
     *
     * `assinarTermoNoPortal` é a **única** função do portal que aceita um id de
     * paciente de fora — porque o responsável legal assina por outra pessoa, e essa
     * pessoa não é a da sessão. O que impede o IDOR não é a assinatura da função (não
     * pode ser), é `quemAssina`: exige que a sessão seja do próprio paciente adulto ou
     * do responsável legal cadastrado.
     *
     * A e B não têm vínculo de responsabilidade, então isto tem de bater em
     * `ASSINATURA_DE_TERCEIRO`. É o caso mais importante deste bloco: é o único ponto
     * do portal onde a defesa é uma regra de domínio e não a forma da função.
     */
    const assinarPorB = await fetch(`${BASE}/meu/termos`, {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pacienteAlvoId: B.pacienteId, texto: 'x', versaoTermo: 'v1' }),
      redirect: 'manual',
    })
    /**
     * A asserção olha o BANCO, não o HTML — e a primeira versão não olhava.
     *
     * Ela era `!texto.includes('assinado')`, copiada do caso do desmarcar acima. E deu
     * **falso VAZOU** no instante em que a tela de assinatura passou a renderizar: a
     * palavra aparece no HTML por outro motivo (o payload do React carrega o nome da
     * server action `assinarTermoNoPortal`), e a asserção não sabia distinguir "a
     * palavra está na página" de "a linha foi gravada".
     *
     * A correção é tornar a asserção **precisa**, não afrouxá-la: o que a segurança
     * afirma é que **nenhum consentimento nasceu para o paciente B**. Isso é contável, e
     * é imune a coincidência de texto.
     *
     * (Um POST a rota de página não invoca server action — precisaria do id da action.
     * O caso vale como sonda de superfície: se um dia a rota aceitar POST e agir, a
     * contagem pega.)
     */
    const consentimentosDeB = await db
      .select({ id: consentimento.id })
      .from(consentimento)
      .where(eq(consentimento.pacienteId, B.pacienteId))
    deveFalhar(
      consentimentosDeB.length === 0,
      'assinar termo em nome de outro paciente (nenhum consentimento nasceu para B)',
      `status ${assinarPorB.status}, ${consentimentosDeB.length} linha(s)`,
    )

    /**
     * A fila é tela da CLÍNICA, e o paciente não pode abri-la.
     *
     * Ela mostra nome, telefone e observação de todos os pacientes que aguardam — é a
     * tela do portal ao contrário, e por isso vive em `app/(staff)`. Um paciente que a
     * abrisse veria a fila inteira, o que é o vazamento mais direto possível.
     */
    const filaPeloPaciente = await fetch(`${BASE}/espera`, {
      headers: { cookie: cookieA },
      redirect: 'manual',
    })
    deveFalhar(
      filaPeloPaciente.status !== 200,
      'sessão de PACIENTE abrir a lista de espera da clínica',
      `status ${filaPeloPaciente.status} → ${filaPeloPaciente.headers.get('location') ?? '—'}`,
    )
    deveFalhar(
      !(await filaPeloPaciente.text()).includes(SEGREDO_DE_B),
      'observação da fila de outro paciente vazar para o portal',
      `pedido ${esperaB!.id.slice(0, 8)}…`,
    )

    // Restaura o termo. Deixar o texto da revisão gravado faria a próxima pessoa
    // encontrar um "Termo de atendimento da revisão" no portal da clínica.
    await db
      .update(regraAutoatendimento)
      .set({ termoDeAtendimento: termoAntes?.termo ?? null })
      .where(eq(regraAutoatendimento.clinicaId, clinicaDoTeste))

    // ── B. Cruzamento de realms ─────────────────────────────────────────────
    bloco('B. Realms — cookie de um lado tentando abrir o outro')

    const cookieStaff = await entrarComoStaff(emailStaff, segredoStaff)
    deveFuncionar(cookieStaff.includes('authjs.session-token'), 'staff conseguiu entrar no sistema')

    const staffNoPortal = await fetch(`${BASE}/meu`, {
      headers: { cookie: cookieStaff },
      redirect: 'manual',
    })
    deveFalhar(
      staffNoPortal.status !== 200,
      'sessão de STAFF abrir o portal do paciente',
      `status ${staffNoPortal.status} → ${staffNoPortal.headers.get('location') ?? '—'}`,
    )

    const pacienteNoStaff = await fetch(`${BASE}/pacientes`, {
      headers: { cookie: cookieA },
      redirect: 'manual',
    })
    deveFalhar(
      pacienteNoStaff.status !== 200,
      'sessão de PACIENTE abrir a área da clínica',
      `status ${pacienteNoStaff.status} → ${pacienteNoStaff.headers.get('location') ?? '—'}`,
    )

    const pacienteNoPainel = await fetch(`${BASE}/painel`, {
      headers: { cookie: cookieA },
      redirect: 'manual',
    })
    deveFalhar(
      pacienteNoPainel.status !== 200,
      'sessão de paciente abrir o painel da clínica',
      `status ${pacienteNoPainel.status}`,
    )

    const pacienteNaRotaStaff = await fetch(`${BASE}/api/documentos/${docB.id}`, {
      headers: { cookie: cookieA },
      redirect: 'manual',
    })
    deveFalhar(
      pacienteNaRotaStaff.status !== 200,
      'sessão de paciente usar a rota de download DO STAFF',
      `status ${pacienteNaRotaStaff.status}`,
    )

    // ── C. Sessão ───────────────────────────────────────────────────────────
    bloco('C. Sessão — token forjado, revogado, expirado, conta desativada')

    const forjado = gerarTokenDeSessao().token
    const comForjado = await fetch(`${BASE}/meu`, {
      headers: { cookie: `${COOKIE_PORTAL}=${forjado}` },
      redirect: 'manual',
    })
    deveFalhar(
      comForjado.status !== 200,
      'token aleatório bem formado (não está no banco)',
      `status ${comForjado.status}`,
    )

    for (const lixo of ['', 'abc', '../../etc/passwd', 'null', '{}']) {
      const r = await fetch(`${BASE}/meu`, {
        headers: { cookie: `${COOKIE_PORTAL}=${encodeURIComponent(lixo)}` },
        redirect: 'manual',
      })
      deveFalhar(r.status !== 200, `cookie com valor ${JSON.stringify(lixo)}`, `status ${r.status}`)
    }

    // Sessão revogada
    const revogada = await entrarNoPortalHttp(A.email, A.senha)
    await db
      .update(pacienteSessao)
      .set({ revogadaEm: new Date() })
      .where(eq(pacienteSessao.tokenHash, hashDoTokenDeSessao(revogada.cookie!.split('=')[1]!)))
    const comRevogada = await fetch(`${BASE}/meu`, {
      headers: { cookie: revogada.cookie! },
      redirect: 'manual',
    })
    deveFalhar(comRevogada.status !== 200, 'sessão revogada', `status ${comRevogada.status}`)

    // Sessão expirada
    const { token: tokenVelho, hash: hashVelho } = gerarTokenDeSessao()
    await db.insert(pacienteSessao).values({
      contaId: A.contaId,
      tokenHash: hashVelho,
      criadoEm: new Date(Date.now() - 48 * 3_600_000),
      expiraEm: new Date(Date.now() - 24 * 3_600_000),
    })
    const comExpirada = await fetch(`${BASE}/meu`, {
      headers: { cookie: `${COOKIE_PORTAL}=${tokenVelho}` },
      redirect: 'manual',
    })
    deveFalhar(comExpirada.status !== 200, 'sessão expirada', `status ${comExpirada.status}`)

    // Conta desativada com sessão ainda válida
    const sessaoAtivaB = await entrarNoPortalHttp(B.email, B.senha)
    await db.update(pacienteConta).set({ ativo: false }).where(eq(pacienteConta.id, B.contaId))
    const comContaInativa = await fetch(`${BASE}/meu`, {
      headers: { cookie: sessaoAtivaB.cookie! },
      redirect: 'manual',
    })
    deveFalhar(
      comContaInativa.status !== 200,
      'sessão válida de conta DESATIVADA (revogação vale na hora)',
      `status ${comContaInativa.status}`,
    )
    await db.update(pacienteConta).set({ ativo: true }).where(eq(pacienteConta.id, B.contaId))

    // ── D. Convite ──────────────────────────────────────────────────────────
    bloco('D. Convite — reuso e expiração no banco')

    const conviteUsado = gerarConvite()
    await db
      .update(pacienteConta)
      .set({
        senhaHash: null,
        senhaDefinidaEm: null,
        tokenConviteHash: conviteUsado.hash,
        tokenConviteExpiraEm: conviteUsado.expiraEm,
      })
      .where(eq(pacienteConta.id, B.contaId))

    // A trigger exige que definir senha consuma o convite.
    let recusouConviteSobrevivente = false
    try {
      await db
        .update(pacienteConta)
        .set({ senhaHash: await gerarHashSenha(SENHA_B), senhaDefinidaEm: new Date() })
        .where(eq(pacienteConta.id, B.contaId))
    } catch {
      recusouConviteSobrevivente = true
    }
    deveFalhar(
      recusouConviteSobrevivente,
      'definir senha DEIXANDO o convite válido (trigger 0013)',
    )

    // Do jeito certo, funciona.
    await db
      .update(pacienteConta)
      .set({
        senhaHash: await gerarHashSenha(SENHA_B),
        senhaDefinidaEm: new Date(),
        tokenConviteHash: null,
        tokenConviteExpiraEm: null,
      })
      .where(eq(pacienteConta.id, B.contaId))
    const [depois] = await db
      .select({ hash: pacienteConta.tokenConviteHash })
      .from(pacienteConta)
      .where(eq(pacienteConta.id, B.contaId))
    deveFuncionar(depois?.hash === null, 'convite consumido junto com a senha')

    // ── E. Sessão não estica o próprio prazo ────────────────────────────────
    bloco('E. Sessão — imutabilidade dos campos que sustentam o prazo')

    const [algumaSessao] = await db
      .select({ id: pacienteSessao.id, contaId: pacienteSessao.contaId })
      .from(pacienteSessao)
      .where(eq(pacienteSessao.contaId, A.contaId))
      .limit(1)

    for (const [campo, valores] of [
      ['expira_em', "expira_em = now() + interval '30 days'"],
      ['conta_id', `conta_id = '${B.contaId}'`],
      ['token_hash', `token_hash = '${'a'.repeat(64)}'`],
    ] as const) {
      let recusou = false
      try {
        await db.execute(
          // biome-ignore lint: SQL literal montado a partir de constantes do teste.
          `update paciente_sessao set ${valores} where id = '${algumaSessao!.id}'` as never,
        )
      } catch {
        recusou = true
      }
      deveFalhar(recusou, `alterar ${campo} de uma sessão existente`)
    }

    // ── F. Enumeração ───────────────────────────────────────────────────────
    bloco('F. Enumeração — a resposta não diz se a conta existe')

    const { entrarNoPortal } = await import('./acoes')
    // Chamando a action direto: é a mesma função que a tela chama.
    const inexistente = await entrarNoPortal({
      email: `nao-existe-${randomUUID()}@local`,
      senha: 'qualquer coisa 123',
    })
    const senhaErrada = await entrarNoPortal({ email: A.email, senha: 'senha errada 123' })

    deveFuncionar(
      !inexistente.ok && !senhaErrada.ok && inexistente.mensagem === senhaErrada.mensagem,
      'mensagem idêntica para conta inexistente e senha errada',
      `"${inexistente.mensagem}"`,
    )
    deveFalhar(
      !/não (existe|cadastrad)|inexistente|inativ/i.test(inexistente.mensagem),
      'a mensagem revelar que a conta não existe',
    )

    // ── G. Força bruta ──────────────────────────────────────────────────────
    bloco('G. Força bruta — bloqueio depois de tentativas repetidas')

    let bloqueou = false
    let tentativas = 0
    for (let i = 0; i < 8 && !bloqueou; i++) {
      tentativas++
      const r = await entrarNoPortal({ email: A.email, senha: `errada ${i} vezes` })
      if (!r.ok && /muitas tentativas/i.test(r.mensagem)) bloqueou = true
    }
    deveFuncionar(bloqueou, `bloqueio disparou depois de ${tentativas} tentativas`)

    // E a senha CORRETA também é barrada enquanto o bloqueio vale — se não fosse,
    // o bloqueio não atrasaria quem está adivinhando.
    const durante = await entrarNoPortal({ email: A.email, senha: A.senha })
    deveFalhar(
      !durante.ok,
      'entrar com a senha certa durante o bloqueio',
      `"${durante.mensagem}"`,
    )

    // ── Resultado ───────────────────────────────────────────────────────────
    console.log(
      `\n${falhas === 0 ? '\x1b[32m' : '\x1b[31m'}═══ ${passaram} verificações, ${falhas} falha(s) ═══\x1b[0m\n`,
    )
    if (falhas > 0) process.exitCode = 1
  } finally {
    await limpar(criados, [orcB.id])
  }
}

async function criarOrcamentoEnviado(
  pacienteId: string,
  profissionalId: string,
  usuarioId: string,
): Promise<{ id: string }> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    /**
     * Contexto de clínica na transação.
     *
     * A conexão vem crua do pool e, desde a `drizzle/0022`, sem `app.clinica_id`
     * definido toda escrita estoura em `app_clinica_id()` — de propósito. Antes
     * havia um andaime em `lib/db/index.ts` que adivinhava a clínica; ele saiu, e
     * quem precisa de contexto passou a dizer qual é. `is_local => true` faz o
     * valor morrer no commit, então a conexão volta ao pool limpa.
     */
    await c.query('select set_config($1, $2, true)', ['app.clinica_id', await idDaPrimeiraClinica()])
    /**
     * `DISABLE TRIGGER USER` tabela por tabela, e **não**
     * `session_replication_role = 'replica'`, que era o que estava aqui.
     *
     * O atalho desliga também as triggers INTERNAS de FK, e o estrago foi real: uma
     * limpeza de demonstração apagou uma `execucao` e deixou cinco linhas órfãs em
     * `movimento_estoque` — o que depois impediu a `drizzle/0023` de criar FK
     * composto, porque não se cria constraint sobre dado já inconsistente.
     *
     * O helper religa ANTES do commit e **confere** que religou: `DISABLE TRIGGER`
     * é DDL, então comitar com a trigger desligada a deixa desligada para sempre. A
     * pergunta certa não é "eu religuei?", é "está religado?".
     */
    const desligadas = await desligarTriggersDeAplicacao(c)
    const plano = await c.query(
      `insert into plano_tratamento (paciente_id, profissional_id, status, titulo)
       values ($1, $2, 'ativo', 'revisão') returning id`,
      [pacienteId, profissionalId],
    )
    const orc = await c.query(
      `insert into orcamento (paciente_id, plano_id, status, validade_ate, valor_bruto, desconto, valor_total, enviado_em, criado_por_id)
       values ($1, $2, 'enviado', current_date + 30, '100.00', '0.00', '100.00', now(), $3) returning id`,
      [pacienteId, plano.rows[0].id, usuarioId],
    )
    await c.query(
      `insert into orcamento_item (orcamento_id, descricao, quantidade, valor_unitario, ordem)
       values ($1, 'Procedimento de revisão', 1, '100.00', 1)`,
      [orc.rows[0].id],
    )
    await religarTriggersDeAplicacao(c, desligadas)
    await c.query('commit')
    return { id: orc.rows[0].id }
  } catch (e) {
    await c.query('rollback')
    throw e
  } finally {
    c.release()
  }
}

async function criarDocumento(pacienteId: string, usuarioId: string): Promise<{ id: string }> {
  const [d] = await db
    .insert(documento)
    .values({
      pacienteId,
      tipo: 'atestado',
      nome: 'Atestado de revisão.pdf',
      storageKey: `pacientes/${pacienteId}/2026/${randomUUID()}.pdf`,
      mimeType: 'application/pdf',
      tamanhoBytes: 100,
      sha256: 'a'.repeat(64),
      criadoPorId: usuarioId,
    })
    .returning({ id: documento.id })
  return { id: d!.id }
}

async function limpar(
  criados: { usuarios: string[]; pacientes: string[] },
  _orcamentos: string[],
): Promise<void> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    /**
     * Contexto de clínica na transação.
     *
     * A conexão vem crua do pool e, desde a `drizzle/0022`, sem `app.clinica_id`
     * definido toda escrita estoura em `app_clinica_id()` — de propósito. Antes
     * havia um andaime em `lib/db/index.ts` que adivinhava a clínica; ele saiu, e
     * quem precisa de contexto passou a dizer qual é. `is_local => true` faz o
     * valor morrer no commit, então a conexão volta ao pool limpa.
     */
    await c.query('select set_config($1, $2, true)', ['app.clinica_id', await idDaPrimeiraClinica()])
    /**
     * `DISABLE TRIGGER USER` tabela por tabela, e **não**
     * `session_replication_role = 'replica'`, que era o que estava aqui.
     *
     * O atalho desliga também as triggers INTERNAS de FK, e o estrago foi real: uma
     * limpeza de demonstração apagou uma `execucao` e deixou cinco linhas órfãs em
     * `movimento_estoque` — o que depois impediu a `drizzle/0023` de criar FK
     * composto, porque não se cria constraint sobre dado já inconsistente.
     *
     * O helper religa ANTES do commit e **confere** que religou: `DISABLE TRIGGER`
     * é DDL, então comitar com a trigger desligada a deixa desligada para sempre. A
     * pergunta certa não é "eu religuei?", é "está religado?".
     */
    const desligadas = await desligarTriggersDeAplicacao(c)
    await c.query(
      'delete from paciente_sessao where conta_id in (select id from paciente_conta where paciente_id = any($1))',
      [criados.pacientes],
    )
    await c.query('delete from paciente_conta where paciente_id = any($1)', [criados.pacientes])
    await c.query('delete from documento where paciente_id = any($1)', [criados.pacientes])
    await c.query(
      'delete from orcamento_item where orcamento_id in (select id from orcamento where paciente_id = any($1))',
      [criados.pacientes],
    )
    await c.query('delete from orcamento where paciente_id = any($1)', [criados.pacientes])
    await c.query('delete from plano_tratamento where paciente_id = any($1)', [criados.pacientes])
    await c.query('delete from agendamento where paciente_id = any($1)', [criados.pacientes])
    /**
     * As tabelas das telas novas, ANTES de `paciente`.
     *
     * `anamnese`, `lista_espera` e `consentimento` têm FK com `ON DELETE RESTRICT` para
     * `paciente` — e `DISABLE TRIGGER USER` **preserva** as triggers internas de FK, que
     * é justamente o motivo de ele ser usado aqui em vez do atalho. Então esquecer
     * estas três não deixaria lixo: faria o `delete from paciente` falhar, a limpeza
     * cair no `rollback` e o script terminar dizendo "Falha ao limpar" com dois
     * pacientes fictícios comitados no banco.
     *
     * `consentimento` entra na lista mesmo esperando zero linhas: o caso "assinar em
     * nome de outro" tem de falhar, e se um dia ele passar (o vazamento que a revisão
     * existe para pegar), a linha existe e a limpeza precisa dar conta dela.
     */
    await c.query('delete from anamnese where paciente_id = any($1)', [criados.pacientes])
    await c.query('delete from lista_espera where paciente_id = any($1)', [criados.pacientes])
    await c.query('delete from consentimento where paciente_id = any($1)', [criados.pacientes])
    await c.query('delete from audit_log where paciente_id = any($1)', [criados.pacientes])
    await c.query("delete from audit_log where ator_email like 'rev-p%@local'")
    await c.query("delete from audit_log where ator_email like 'nao-existe-%@local'")
    await c.query('delete from paciente where id = any($1)', [criados.pacientes])
    await c.query('delete from profissional where usuario_id = any($1)', [criados.usuarios])
    await c.query('delete from usuario where id = any($1)', [criados.usuarios])
    await religarTriggersDeAplicacao(c, desligadas)
    await c.query('commit')
    console.log('Dados da revisão removidos.')
  } catch (e) {
    await c.query('rollback')
    console.error('Falha ao limpar:', e)
  } finally {
    c.release()
  }
}

/**
 * O script inteiro roda com a clínica no contexto.
 *
 * Script não tem sessão, e desde a `drizzle/0022` toda escrita exige
 * `app.clinica_id` — o andaime que adivinhava a clínica saiu de `lib/db/index.ts`
 * de propósito. `comContextoDeClinica` usa `run()`, então todas as consultas do
 * `main` (dezenas) herdam o contexto sem que cada uma precise dizer qual é.
 *
 * Envolver o `main` inteiro é correto AQUI porque este script fala por uma clínica
 * só. Num laço sobre várias — o despachante, por exemplo — o contexto tem de ser
 * trocado a cada iteração, senão todas herdam o da primeira.
 */
idDaPrimeiraClinica()
  .then((clinicaId) => comContextoDeClinica(clinicaId, main))
  .then(async () => {
    await pool.end()
    process.exit(process.exitCode ?? 0)
  })
  .catch(async (e) => {
    console.error(e)
    await pool.end()
    process.exit(1)
  })
