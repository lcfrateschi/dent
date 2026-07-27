'use server'

import { createHash } from 'node:crypto'
import { registrarDoPaciente } from '@/lib/auditoria/registrar'
import { conferirConvite, conviteExpirou, hashDoToken } from '@/lib/auth/convite'
import { avaliarSenhaPaciente, gerarHashSenha, verificarSenha } from '@/lib/auth/senha'
import { db } from '@/lib/db'
import {
  agendamento,
  anamnese,
  auditLog,
  consentimento,
  listaEspera,
  orcamento,
  paciente,
  pacienteConta,
  procedimento,
} from '@/lib/db/schema'
import { mensagemDoBanco } from '@/lib/db/mensagemDoBanco'
import {
  FINALIDADES_DO_PORTAL,
  type FinalidadeDoPortal,
  NIVEL_ASSINATURA,
  avaliarPedido,
  idadeEmAnos,
  podeDesmarcarSozinho,
  quemAssina,
} from '@/lib/domain/autoatendimento'
import { diaLocalIso } from '@/lib/domain/fuso'
import {
  FUSO_DO_PORTAL,
  horariosParaOPaciente,
  meusFuturosAtivos,
  regraDoAutoatendimento,
} from './consultas'
import {
  MENSAGEM_CREDENCIAL_INVALIDA,
  bloqueioAtivo,
  decidirBloqueio,
  esperaRestante,
  ipExcedeu,
  JANELA_MINUTOS,
} from '@/lib/domain/bloqueio'
import { FINALIDADE_WHATSAPP } from '@/lib/mensageria/consentimento'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { abrirSessao, exigirSessao, revogarSessoes } from './sessao'

/**
 * Ações do portal do paciente.
 *
 * Toda ação que lê ou muda dado usa `exigirSessao()` — **nenhuma recebe
 * `pacienteId`**. As duas exceções aparentes são o login e o primeiro acesso, que
 * por definição acontecem antes de haver sessão; nelas a identidade sai da
 * credencial conferida, nunca de um parâmetro da tela.
 */

export type ResultadoPortal = { ok: true; mensagem: string } | { ok: false; mensagem: string }

async function ipAtual(): Promise<string | null> {
  try {
    const h = await headers()
    const encaminhado = h.get('x-forwarded-for')
    const ip = encaminhado?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null
    return ip && ip.length <= 45 ? ip : null
  } catch {
    return null
  }
}

/** O `user-agent` da requisição. Parte do rastro da assinatura eletrônica simples. */
async function userAgentAtual(): Promise<string | null> {
  try {
    const ua = (await headers()).get('user-agent')
    return ua ? ua.slice(0, 500) : null
  } catch {
    return null
  }
}

/**
 * Conta falhas recentes de login.
 *
 * Lê do `audit_log`, que é **append-only por trigger** desde a Fase 1. Isso
 * importa: um contador em tabela comum poderia ser zerado por quem estivesse
 * atacando, e um contador em memória se perderia a cada deploy e não valeria entre
 * instâncias.
 */
async function falhasRecentes(email: string, ip: string | null): Promise<{ conta: number; doIp: number }> {
  const desde = sql`now() - ${`${JANELA_MINUTOS} minutes`}::interval`

  const [porConta] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.acao, 'login_falho'),
        eq(auditLog.entidade, 'paciente_conta'),
        sql`lower(${auditLog.atorEmail}) = ${email.toLowerCase()}`,
        sql`${auditLog.criadoEm} > ${desde}`,
      ),
    )

  const [porIp] = ip
    ? await db
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.acao, 'login_falho'),
            eq(auditLog.entidade, 'paciente_conta'),
            eq(auditLog.ip, ip),
            sql`${auditLog.criadoEm} > ${desde}`,
          ),
        )
    : [{ n: 0 }]

  return { conta: porConta?.n ?? 0, doIp: porIp?.n ?? 0 }
}

/** Registra a falha na trilha. É o que alimenta a contagem acima. */
async function registrarFalha(email: string, motivo: string): Promise<void> {
  const ip = await ipAtual()
  try {
    await db.insert(auditLog).values({
      atorTipo: 'paciente',
      atorId: null,
      atorEmail: email.slice(0, 200),
      acao: 'login_falho',
      entidade: 'paciente_conta',
      ip,
      // `motivo` é metadado de diagnóstico e **não** volta para a tela: a tela
      // sempre diz a mesma coisa, para não revelar se a conta existe.
      detalhes: { motivo, realm: 'portal' },
    })
  } catch (e) {
    console.error('[portal] falha ao registrar tentativa', e)
  }
}

/**
 * Login do paciente.
 *
 * A resposta é **sempre a mesma** para e-mail inexistente, senha errada, conta sem
 * senha definida e conta inativa. Distinguir seria útil para o paciente e útil
 * demais para quem ataca: revelaria quem é paciente da clínica, e isso já é
 * informação de saúde.
 */
export async function entrarNoPortal(entrada: {
  readonly email: string
  readonly senha: string
}): Promise<ResultadoPortal> {
  const email = entrada.email.trim().toLowerCase()
  const ip = await ipAtual()

  if (email.length === 0 || entrada.senha.length === 0) {
    return { ok: false, mensagem: MENSAGEM_CREDENCIAL_INVALIDA }
  }

  const falhas = await falhasRecentes(email, ip)

  if (ipExcedeu(falhas.doIp)) {
    await registrarFalha(email, 'ip_excedeu')
    return { ok: false, mensagem: 'Muitas tentativas desta rede. Tente mais tarde.' }
  }

  const bloqueio = decidirBloqueio(falhas.conta, new Date())
  if (bloqueio.bloqueado) {
    await registrarFalha(email, 'bloqueado')
    return { ok: false, mensagem: bloqueio.mensagem! }
  }

  const [conta] = await db
    .select({
      id: pacienteConta.id,
      pacienteId: pacienteConta.pacienteId,
      senhaHash: pacienteConta.senhaHash,
      ativo: pacienteConta.ativo,
      bloqueadoAte: pacienteConta.bloqueadoAte,
      statusPaciente: paciente.status,
    })
    .from(pacienteConta)
    .innerJoin(paciente, eq(paciente.id, pacienteConta.pacienteId))
    .where(sql`lower(${pacienteConta.email}) = ${email}`)

  // Conta inexistente ainda paga o custo de um hash, para o tempo de resposta não
  // revelar a diferença entre "não existe" e "senha errada".
  if (!conta || !conta.senhaHash) {
    await verificarSenha(entrada.senha, HASH_ISCA)
    await registrarFalha(email, conta ? 'sem_senha_definida' : 'conta_inexistente')
    return { ok: false, mensagem: MENSAGEM_CREDENCIAL_INVALIDA }
  }

  if (bloqueioAtivo(conta.bloqueadoAte)) {
    await registrarFalha(email, 'bloqueado_na_conta')
    return {
      ok: false,
      mensagem: `Muitas tentativas. Tente de novo em ${esperaRestante(conta.bloqueadoAte)}.`,
    }
  }

  if (!(await verificarSenha(entrada.senha, conta.senhaHash))) {
    await registrarFalha(email, 'senha_incorreta')

    // Grava o bloqueio na conta considerando ESTA falha, que ainda não estava na
    // contagem lida acima.
    const novo = decidirBloqueio(falhas.conta + 1, new Date())
    if (novo.bloqueado) {
      await db
        .update(pacienteConta)
        .set({ bloqueadoAte: novo.ate })
        .where(eq(pacienteConta.id, conta.id))
    }
    return { ok: false, mensagem: MENSAGEM_CREDENCIAL_INVALIDA }
  }

  if (!conta.ativo || conta.statusPaciente === 'arquivado') {
    await registrarFalha(email, 'conta_inativa')
    return { ok: false, mensagem: MENSAGEM_CREDENCIAL_INVALIDA }
  }

  await abrirSessao({ contaId: conta.id, pacienteId: conta.pacienteId })
  return { ok: true, mensagem: 'Entrou.' }
}

/**
 * Hash de isca, para o tempo de resposta não delatar conta inexistente.
 *
 * Mesmo padrão do login do staff (`lib/auth/config.ts`). Sem isto, "e-mail não
 * cadastrado" responderia em 1 ms e "senha errada" em 100 ms, e a diferença
 * responderia a pergunta que a mensagem única se recusa a responder.
 */
const HASH_ISCA =
  'scrypt$32768$8$1$aXNjYWlzY2Fpc2NhaXNjYQ$ZGV2ZXJpYVNlclVtSGFzaFJlYWxEZUlzY2FQYXJhVGVtcG8='

/**
 * Primeiro acesso: valida o convite e define a senha.
 *
 * O convite é consumido na MESMA instrução que grava a senha, e a trigger de
 * `drizzle/0013` recusa o contrário. Assim o token que circulou por WhatsApp deixa
 * de valer no instante em que a senha existe.
 */
export async function definirSenhaComConvite(entrada: {
  readonly token: string
  readonly senha: string
  readonly repetirSenha: string
}): Promise<ResultadoPortal> {
  if (entrada.senha !== entrada.repetirSenha) {
    return { ok: false, mensagem: 'As duas senhas não são iguais.' }
  }

  const hash = hashDoToken(entrada.token)

  const [conta] = await db
    .select({
      id: pacienteConta.id,
      pacienteId: pacienteConta.pacienteId,
      email: pacienteConta.email,
      tokenConviteHash: pacienteConta.tokenConviteHash,
      tokenConviteExpiraEm: pacienteConta.tokenConviteExpiraEm,
      ativo: pacienteConta.ativo,
      nome: paciente.nome,
      nascimento: paciente.dataNascimento,
      cpf: paciente.cpf,
    })
    .from(pacienteConta)
    .innerJoin(paciente, eq(paciente.id, pacienteConta.pacienteId))
    .where(eq(pacienteConta.tokenConviteHash, hash))

  // Mensagem única também aqui: token inválido, expirado e conta inativa dizem a
  // mesma coisa, porque distinguir ajudaria quem estivesse tentando adivinhar.
  const RECUSA = 'Convite inválido ou expirado. Peça um novo na clínica.'

  if (!conta || !conta.ativo) return { ok: false, mensagem: RECUSA }
  if (!conferirConvite(entrada.token, conta.tokenConviteHash)) {
    return { ok: false, mensagem: RECUSA }
  }
  if (conviteExpirou(conta.tokenConviteExpiraEm)) {
    return { ok: false, mensagem: RECUSA }
  }

  const avaliacao = avaliarSenhaPaciente(entrada.senha, {
    nome: conta.nome,
    email: conta.email,
    nascimento: conta.nascimento,
    cpf: conta.cpf ?? undefined,
  })
  if (!avaliacao.aceita) {
    return { ok: false, mensagem: avaliacao.problemas.join(' ') }
  }

  const senhaHash = await gerarHashSenha(entrada.senha)

  await db
    .update(pacienteConta)
    .set({
      senhaHash,
      senhaDefinidaEm: new Date(),
      // Consome o convite na mesma instrução. A trigger exige.
      tokenConviteHash: null,
      tokenConviteExpiraEm: null,
      bloqueadoAte: null,
      emailVerificadoEm: new Date(),
    })
    .where(eq(pacienteConta.id, conta.id))

  await registrarDoPaciente({
    acao: 'atualizacao',
    entidade: 'paciente_conta',
    entidadeId: conta.id,
    pacienteId: conta.pacienteId,
    detalhes: { primeiroAcesso: true, realm: 'portal' },
  })

  await abrirSessao({ contaId: conta.id, pacienteId: conta.pacienteId })
  return { ok: true, mensagem: 'Senha definida. Bem-vindo!' }
}

/**
 * Troca de senha pelo próprio paciente.
 *
 * Exige a senha atual e **derruba todas as outras sessões**. Trocar senha sem
 * encerrar sessões abertas deixaria quem já está dentro continuar dentro, que é
 * exatamente o cenário do celular perdido.
 */
export async function trocarMinhaSenha(entrada: {
  readonly senhaAtual: string
  readonly nova: string
  readonly repetir: string
}): Promise<ResultadoPortal> {
  const sessao = await exigirSessao()

  if (entrada.nova !== entrada.repetir) {
    return { ok: false, mensagem: 'As duas senhas não são iguais.' }
  }

  const [conta] = await db
    .select({
      id: pacienteConta.id,
      senhaHash: pacienteConta.senhaHash,
      email: pacienteConta.email,
      nome: paciente.nome,
      nascimento: paciente.dataNascimento,
      cpf: paciente.cpf,
    })
    .from(pacienteConta)
    .innerJoin(paciente, eq(paciente.id, pacienteConta.pacienteId))
    .where(eq(pacienteConta.id, sessao.contaId))

  if (!conta?.senhaHash || !(await verificarSenha(entrada.senhaAtual, conta.senhaHash))) {
    return { ok: false, mensagem: 'A senha atual está incorreta.' }
  }

  const avaliacao = avaliarSenhaPaciente(entrada.nova, {
    nome: conta.nome,
    email: conta.email,
    nascimento: conta.nascimento,
    cpf: conta.cpf ?? undefined,
  })
  if (!avaliacao.aceita) return { ok: false, mensagem: avaliacao.problemas.join(' ') }

  await db
    .update(pacienteConta)
    .set({ senhaHash: await gerarHashSenha(entrada.nova), senhaDefinidaEm: new Date() })
    .where(eq(pacienteConta.id, conta.id))

  await revogarSessoes(conta.id)

  await registrarDoPaciente({
    acao: 'atualizacao',
    entidade: 'paciente_conta',
    entidadeId: conta.id,
    pacienteId: sessao.pacienteId,
    detalhes: { trocaDeSenha: true, sessoesEncerradas: true, realm: 'portal' },
  })

  return { ok: true, mensagem: 'Senha alterada. Entre de novo com a nova senha.' }
}

/**
 * O paciente confirma a própria consulta.
 *
 * Mesmo efeito da confirmação por WhatsApp, com outro canal registrado. O filtro
 * inclui `pacienteId` da sessão: sem ele, trocar o id na requisição confirmaria a
 * consulta de outra pessoa.
 */
export async function confirmarMinhaConsulta(agendamentoId: string): Promise<ResultadoPortal> {
  const sessao = await exigirSessao()

  if (!/^[0-9a-f-]{36}$/i.test(agendamentoId)) {
    return { ok: false, mensagem: 'Consulta não encontrada.' }
  }

  const feitas = await db
    .update(agendamento)
    .set({ status: 'confirmado', confirmadoEm: new Date(), confirmadoVia: 'portal' })
    .where(
      and(
        eq(agendamento.id, agendamentoId),
        // ⚠️ Sem esta linha, é IDOR.
        eq(agendamento.pacienteId, sessao.pacienteId),
        eq(agendamento.status, 'agendado'),
        isNull(agendamento.confirmadoEm),
        sql`${agendamento.inicio} > now()`,
      ),
    )
    .returning({ id: agendamento.id })

  if (feitas.length === 0) {
    return { ok: false, mensagem: 'Esta consulta não pode ser confirmada por aqui.' }
  }

  await registrarDoPaciente({
    acao: 'atualizacao',
    entidade: 'agendamento',
    entidadeId: agendamentoId,
    pacienteId: sessao.pacienteId,
    detalhes: { confirmadoVia: 'portal', realm: 'portal' },
  })

  revalidatePath('/meu')
  return { ok: true, mensagem: 'Consulta confirmada. Até lá!' }
}

/**
 * O paciente avisa que não poderá vir.
 *
 * **Não cancela sozinho.** Registra o pedido e deixa a agenda como está, porque
 * liberar o horário automaticamente com base num clique tem dois riscos: o clique
 * errado perde o horário do paciente, e a clínica precisa saber para remarcar. O
 * cancelamento efetivo é da recepção, que já tem a tela para isso.
 */
export async function avisarQueNaoVou(
  agendamentoId: string,
  motivo: string,
): Promise<ResultadoPortal> {
  const sessao = await exigirSessao()

  if (!/^[0-9a-f-]{36}$/i.test(agendamentoId)) {
    return { ok: false, mensagem: 'Consulta não encontrada.' }
  }

  const [alvo] = await db
    .select({ id: agendamento.id, inicio: agendamento.inicio })
    .from(agendamento)
    .where(
      and(
        eq(agendamento.id, agendamentoId),
        eq(agendamento.pacienteId, sessao.pacienteId),
        sql`${agendamento.status} in ('agendado','confirmado')`,
      ),
    )

  if (!alvo) return { ok: false, mensagem: 'Esta consulta não está mais aberta.' }

  await registrarDoPaciente({
    acao: 'atualizacao',
    entidade: 'agendamento',
    entidadeId: agendamentoId,
    pacienteId: sessao.pacienteId,
    detalhes: {
      pedidoDeCancelamento: true,
      motivo: motivo.trim().slice(0, 300),
      realm: 'portal',
    },
  })

  revalidatePath('/meu')
  return {
    ok: true,
    mensagem: 'Avisamos a clínica. Alguém vai entrar em contato para remarcar.',
  }
}

/**
 * O paciente aprova ou recusa um orçamento.
 *
 * A decisão é dele e vale como aceite. O orçamento é documento congelado desde a
 * Fase 6: aprovar não muda valor nem item, só grava a decisão.
 */
export async function decidirOrcamento(
  orcamentoId: string,
  decisao: 'aprovado' | 'recusado',
): Promise<ResultadoPortal> {
  const sessao = await exigirSessao()

  if (!/^[0-9a-f-]{36}$/i.test(orcamentoId)) {
    return { ok: false, mensagem: 'Orçamento não encontrado.' }
  }

  const feitas = await db
    .update(orcamento)
    .set({ status: decisao, decididoEm: new Date() })
    .where(
      and(
        eq(orcamento.id, orcamentoId),
        eq(orcamento.pacienteId, sessao.pacienteId),
        eq(orcamento.status, 'enviado'),
        // Orçamento vencido não é decidido pelo portal: o preço pode ter mudado, e
        // aceitar um valor expirado criaria discussão na hora de pagar.
        sql`${orcamento.validadeAte} >= current_date`,
      ),
    )
    .returning({ id: orcamento.id, numero: orcamento.numero })

  if (feitas.length === 0) {
    return {
      ok: false,
      mensagem: 'Este orçamento não pode mais ser decidido aqui. Fale com a clínica.',
    }
  }

  await registrarDoPaciente({
    acao: 'atualizacao',
    entidade: 'orcamento',
    entidadeId: orcamentoId,
    pacienteId: sessao.pacienteId,
    detalhes: { decisao, numero: feitas[0]!.numero, realm: 'portal' },
  })

  revalidatePath('/meu/orcamentos')
  return {
    ok: true,
    mensagem: decisao === 'aprovado' ? 'Orçamento aprovado.' : 'Orçamento recusado.',
  }
}

/**
 * O paciente revoga o consentimento de contato por WhatsApp.
 *
 * LGPD: o titular revoga quando quiser, e o caminho tem de ser dele, não uma
 * ligação para a clínica. Revogar cancela o que ainda não saiu.
 */
export async function revogarMeuConsentimentoWhatsapp(): Promise<ResultadoPortal> {
  const sessao = await exigirSessao()

  const revogados = await db
    .update(consentimento)
    .set({ revogadoEm: new Date() })
    .where(
      and(
        eq(consentimento.pacienteId, sessao.pacienteId),
        eq(consentimento.finalidade, FINALIDADE_WHATSAPP),
        isNull(consentimento.revogadoEm),
      ),
    )
    .returning({ id: consentimento.id })

  if (revogados.length === 0) {
    return { ok: false, mensagem: 'Não há autorização de WhatsApp ativa.' }
  }

  // Sem autorização, o que estava na fila não sai.
  await db.execute(sql`
    update mensagem_whatsapp set situacao = 'cancelada'
     where paciente_id = ${sessao.pacienteId} and situacao = 'pendente'
  `)

  await registrarDoPaciente({
    acao: 'atualizacao',
    entidade: 'consentimento',
    pacienteId: sessao.pacienteId,
    detalhes: { revogado: FINALIDADE_WHATSAPP, porOTitular: true, realm: 'portal' },
  })

  revalidatePath('/meu/dados')
  return {
    ok: true,
    mensagem: 'Autorização revogada. Não enviaremos mais lembretes por WhatsApp.',
  }
}

/**
 * O paciente aceita receber lembretes por WhatsApp.
 *
 * O mesmo termo que a recepção lê em voz alta, aceito pelo titular no portal —
 * com IP e hash do texto, como manda a LGPD.
 */
export async function aceitarWhatsappNoPortal(): Promise<ResultadoPortal> {
  const sessao = await exigirSessao()
  const { TEXTO_TERMO_WHATSAPP, VERSAO_TERMO_WHATSAPP, temConsentimentoWhatsapp } = await import(
    '@/lib/mensageria/consentimento'
  )

  if (await temConsentimentoWhatsapp(sessao.pacienteId)) {
    return { ok: false, mensagem: 'Você já autorizou o contato por WhatsApp.' }
  }

  const ip = await ipAtual()
  let userAgent: string | null = null
  try {
    userAgent = (await headers()).get('user-agent')
  } catch {
    userAgent = null
  }

  await db.insert(consentimento).values({
    pacienteId: sessao.pacienteId,
    baseLegal: 'consentimento',
    finalidade: FINALIDADE_WHATSAPP,
    versaoTermo: VERSAO_TERMO_WHATSAPP,
    textoHash: createHash('sha256').update(TEXTO_TERMO_WHATSAPP, 'utf8').digest('hex'),
    ip,
    userAgent,
  })

  await registrarDoPaciente({
    acao: 'criacao',
    entidade: 'consentimento',
    pacienteId: sessao.pacienteId,
    detalhes: { finalidade: FINALIDADE_WHATSAPP, porOTitular: true, realm: 'portal' },
  })

  revalidatePath('/meu/dados')
  return { ok: true, mensagem: 'Autorização registrada. Enviaremos os lembretes por WhatsApp.' }
}

/** Sair do portal. */
export async function sairDoPortal(): Promise<void> {
  const { encerrarSessao } = await import('./sessao')
  await encerrarSessao()
}

// ── Autoatendimento (Fase 19) ────────────────────────────────────────────────

/**
 * O paciente marca uma consulta.
 *
 * ── Por que grava em `agendamento`, e não numa tabela de pedidos ────────────
 * Porque um agendamento é um agendamento: ocupa a mesma cadeira e disputa a mesma
 * EXCLUDE constraint que o da recepção. Tabela paralela de "pedido" teria de ser
 * reconciliada com a agenda depois, e a reconciliação é onde nasce o horário vendido
 * duas vezes — dois pacientes pedem o mesmo minuto e alguém decide no dia.
 *
 * Aqui o segundo simplesmente não consegue: o banco recusa, como recusa para a
 * recepção. A corrida é resolvida pelo Postgres, não por nós.
 */
export async function marcarMinhaConsulta(entrada: {
  readonly profissionalId: string
  readonly procedimentoId: string
  /** ISO do instante escolhido, como veio da grade. */
  readonly inicioIso: string
  /** Aceite do termo, quando a clínica configurou um. */
  readonly aceitouTermo?: boolean
}): Promise<ResultadoPortal> {
  const sessao = await exigirSessao()

  const inicio = new Date(entrada.inicioIso)
  if (Number.isNaN(inicio.getTime())) return { ok: false, mensagem: 'Horário inválido.' }
  if (!/^[0-9a-f-]{36}$/i.test(entrada.profissionalId) || !/^[0-9a-f-]{36}$/i.test(entrada.procedimentoId)) {
    return { ok: false, mensagem: 'Escolha inválida.' }
  }

  const [regra, futuros] = await Promise.all([
    regraDoAutoatendimento(),
    meusFuturosAtivos(sessao),
  ])

  const [proc] = await db
    .select({
      duracao: procedimento.duracaoMinutos,
      liberado: procedimento.permiteAutoagendamento,
      nome: procedimento.nome,
    })
    .from(procedimento)
    .where(and(eq(procedimento.id, entrada.procedimentoId), eq(procedimento.ativo, true)))
    .limit(1)

  /**
   * A regra é avaliada no SERVIDOR, com os números do banco.
   *
   * A tela já filtrou a janela e a lista de procedimentos — e isso não vale nada
   * aqui: quem manda o POST escolhe o que manda. `procedimentoLiberado` e
   * `futurosDoPaciente` vêm do banco, não do formulário.
   */
  const recusa = avaliarPedido({
    inicio,
    agora: new Date(),
    procedimentoLiberado: proc?.liberado === true,
    futurosDoPaciente: futuros,
    regra,
  })
  if (recusa) return { ok: false, mensagem: recusa.mensagem }

  // O termo, quando existe, é condição para marcar — e o aceite é registrado como
  // consentimento com o hash do texto que a clínica mostrou.
  const termo = regra.termoDeAtendimento?.trim()
  if (termo && !entrada.aceitouTermo) {
    return { ok: false, mensagem: 'Para marcar, é necessário aceitar o termo de atendimento.' }
  }

  const fim = new Date(inicio.getTime() + (proc?.duracao ?? 30) * 60_000)
  const ip = await ipAtual()
  const agente = await userAgentAtual()

  try {
    const marcado = await db.transaction(async (tx) => {
      const [novo] = await tx
        .insert(agendamento)
        .values({
          pacienteId: sessao.pacienteId,
          profissionalId: entrada.profissionalId,
          inicio,
          fim,
          status: 'agendado',
          // ⚠️ O valor que existia no enum desde a Fase 1 e que nenhum código
          // gravava. É por ele que a recepção distingue na grade o que veio de fora.
          origem: 'portal',
        })
        .returning({ id: agendamento.id })

      if (termo) {
        await tx.insert(consentimento).values({
          pacienteId: sessao.pacienteId,
          baseLegal: 'consentimento',
          finalidade: FINALIDADES_DO_PORTAL.termoDeAtendimento,
          versaoTermo: regra.versaoTermo,
          // Hash do texto EXIBIDO, não de um arquivo no repositório: é o que permite
          // provar depois qual redação a pessoa leu.
          textoHash: createHash('sha256').update(termo).digest('hex'),
          nivelAssinatura: NIVEL_ASSINATURA,
          ip,
          userAgent: agente,
        })
      }

      return novo!
    })

    await registrarDoPaciente({
      acao: 'criacao',
      entidade: 'agendamento',
      entidadeId: marcado.id,
      pacienteId: sessao.pacienteId,
      detalhes: { origem: 'portal', realm: 'portal', procedimento: proc?.nome ?? null },
    })

    revalidatePath('/meu')
    return { ok: true, mensagem: 'Consulta marcada. Você recebe a confirmação por WhatsApp.' }
  } catch (e) {
    /**
     * A EXCLUDE constraint da Fase 4 recusando sobreposição.
     *
     * Acontece de verdade: dois pacientes na mesma tela, o mesmo horário, segundos de
     * diferença. A mensagem não diz "ocupado por outro paciente" — diz que o horário
     * saiu, que é a informação de que ele precisa e nada além.
     */
    const texto = mensagemDoBanco(e)
    if (texto.includes('agendamento_sem_sobreposicao') || texto.includes('conflicting key')) {
      return {
        ok: false,
        mensagem: 'Este horário acabou de ser ocupado. Escolha outro, por favor.',
      }
    }
    throw e
  }
}

/**
 * O paciente desmarca o que ELE marcou.
 *
 * A permissão é estreita e cada condição está justificada em
 * `podeDesmarcarSozinho` (`lib/domain/autoatendimento.ts`) — em resumo: só o que veio
 * do portal, só enquanto a clínica não confirmou, e só fora da antecedência mínima.
 * Fora disso, o caminho continua sendo `avisarQueNaoVou`, que **não** cancela.
 *
 * Cancela de verdade (libera o horário) porque o contrário seria pior: um horário
 * ocupado por um atendimento que não vai acontecer bloqueia quem queria marcar, e o
 * paciente que não pode desmarcar liga para a recepção — ou seja, o autoatendimento
 * gerando a ligação que existia para evitar.
 */
export async function desmarcarQueEuMarquei(
  agendamentoId: string,
  motivo: string,
): Promise<ResultadoPortal> {
  const sessao = await exigirSessao()
  if (!/^[0-9a-f-]{36}$/i.test(agendamentoId)) {
    return { ok: false, mensagem: 'Consulta não encontrada.' }
  }

  const [alvo] = await db
    .select({
      id: agendamento.id,
      origem: agendamento.origem,
      status: agendamento.status,
      inicio: agendamento.inicio,
    })
    .from(agendamento)
    .where(
      and(
        eq(agendamento.id, agendamentoId),
        // ⚠️ Sem esta linha, é IDOR.
        eq(agendamento.pacienteId, sessao.pacienteId),
      ),
    )
    .limit(1)

  if (!alvo) return { ok: false, mensagem: 'Consulta não encontrada.' }

  const regra = await regraDoAutoatendimento()
  if (!podeDesmarcarSozinho({ ...alvo, agora: new Date(), regra })) {
    return {
      ok: false,
      mensagem:
        'Esta consulta não pode ser desmarcada por aqui. Use "Não vou poder ir" e a clínica entra em contato.',
    }
  }

  const feitas = await db
    .update(agendamento)
    .set({
      status: 'cancelado',
      /**
       * `motivoCancelamento`, não `motivo`.
       *
       * São colunas diferentes: `motivo` é a razão do atendimento, `motivo_cancelamento`
       * é por que ele não vai acontecer. A primeira versão escreveu na errada e o CHECK
       * `agendamento_cancelado_tem_motivo` recusou — com o `motivo` preenchido, o que
       * fez o erro parecer defeito da trava. Quem pegou foi o `autoatendimento:demo`
       * rodando contra o Postgres; nenhum teste de unidade veria isso.
       */
      motivoCancelamento: `Desmarcado pelo paciente: ${motivo.trim().slice(0, 200)}`,
      canceladoEm: new Date(),
    })
    .where(
      and(
        eq(agendamento.id, agendamentoId),
        eq(agendamento.pacienteId, sessao.pacienteId),
        // Reconfere no UPDATE o que foi lido no SELECT: entre os dois, a recepção
        // pode ter confirmado. Sem isto, a leitura decidiria e a escrita obedeceria.
        eq(agendamento.status, 'agendado'),
        eq(agendamento.origem, 'portal'),
      ),
    )
    .returning({ id: agendamento.id })

  if (feitas.length === 0) {
    return { ok: false, mensagem: 'Esta consulta mudou de situação. Recarregue a página.' }
  }

  await registrarDoPaciente({
    acao: 'atualizacao',
    entidade: 'agendamento',
    entidadeId: agendamentoId,
    pacienteId: sessao.pacienteId,
    detalhes: { desmarcadoPeloPaciente: true, motivo: motivo.trim().slice(0, 300), realm: 'portal' },
  })

  revalidatePath('/meu')
  return { ok: true, mensagem: 'Consulta desmarcada. O horário voltou a ficar livre.' }
}

/**
 * O paciente responde a anamnese antes da consulta.
 *
 * ── Entra como versão NOVA, e marcada como autodeclarada ───────────────────
 * O versionamento existe desde a Fase 5 (`anamnese_paciente_versao_uk`) e não é
 * tocado: nada é sobrescrito. O que a Fase 19 acrescenta é `origem = 'portal'` e
 * `conferida_em = null` — ou seja, a linha diz de si mesma que **ainda não passou por
 * profissional**.
 *
 * Essa distinção é clínica, não administrativa. Uma alergia autodeclarada que ninguém
 * confirmou não pode virar decisão de anestésico, e o CHECK da `0031` garante que a
 * anamnese do portal nasça sem `profissional_id` — porque o paciente não é
 * profissional.
 */
export async function responderMinhaAnamnese(entrada: {
  readonly respostas: Record<string, unknown>
  readonly versaoFormulario: string
}): Promise<ResultadoPortal> {
  const sessao = await exigirSessao()

  if (typeof entrada.respostas !== 'object' || entrada.respostas === null) {
    return { ok: false, mensagem: 'Respostas inválidas.' }
  }

  const [ultima] = await db
    .select({ versao: anamnese.versao })
    .from(anamnese)
    .where(eq(anamnese.pacienteId, sessao.pacienteId))
    .orderBy(desc(anamnese.versao))
    .limit(1)

  const proxima = (ultima?.versao ?? 0) + 1

  const [nova] = await db
    .insert(anamnese)
    .values({
      pacienteId: sessao.pacienteId,
      // Sem `profissionalId`: o CHECK `anamnese_autoria_coerente` da 0031 exige que
      // seja nulo quando a origem é o portal.
      versao: proxima,
      respostas: entrada.respostas,
      versaoFormulario: entrada.versaoFormulario.slice(0, 20),
      origem: 'portal',
    })
    .returning({ id: anamnese.id })

  await registrarDoPaciente({
    acao: 'criacao',
    entidade: 'anamnese',
    entidadeId: nova!.id,
    pacienteId: sessao.pacienteId,
    detalhes: { origem: 'portal', versao: proxima, realm: 'portal' },
  })

  revalidatePath('/meu')
  return {
    ok: true,
    mensagem: 'Respostas enviadas. A clínica confere com você no dia da consulta.',
  }
}

/**
 * O paciente (ou o responsável legal) assina um termo pelo portal.
 *
 * ⚖️ Produz `nivel_assinatura = 'eletronica_simples'` — hash do texto, IP,
 * `user_agent` e instante. É a assinatura eletrônica simples da MP 2.200-2/2001:
 * vale entre as partes que a admitem. **Não** é ICP-Brasil e não prova identidade além
 * do controle da conta do portal, que é e-mail e senha sem segundo fator, por decisão.
 *
 * **Menor não assina o próprio termo.** `quemAssina` decide, e a linha registra os
 * dois lados: `paciente_id` é o menor, `assinado_por_id` é quem assinou.
 */
export async function assinarTermoNoPortal(entrada: {
  readonly finalidade: FinalidadeDoPortal
  readonly texto: string
  readonly versaoTermo: string
  /** Quando o responsável assina pelo menor. Ausente = assina para si. */
  readonly pacienteAlvoId?: string
}): Promise<ResultadoPortal> {
  const sessao = await exigirSessao()

  const texto = entrada.texto?.trim()
  if (!texto) return { ok: false, mensagem: 'Termo vazio não pode ser assinado.' }

  const alvoId = entrada.pacienteAlvoId ?? sessao.pacienteId
  if (!/^[0-9a-f-]{36}$/i.test(alvoId)) return { ok: false, mensagem: 'Paciente inválido.' }

  const [alvo] = await db
    .select({
      id: paciente.id,
      nascimento: paciente.dataNascimento,
      responsavelLegalId: paciente.responsavelLegalId,
    })
    .from(paciente)
    .where(eq(paciente.id, alvoId))
    .limit(1)

  /**
   * ⚠️ Aqui `pacienteAlvoId` VEM DE FORA, e é a única função do portal em que isso
   * acontece — porque o responsável legal assina por outra pessoa, e essa pessoa não
   * é a da sessão.
   *
   * O que impede o IDOR não é a assinatura da função (não pode), é `quemAssina`:
   * ela exige que a sessão seja do próprio paciente (adulto) ou do responsável legal
   * cadastrado (menor). Um id qualquer na requisição bate em `MENOR_NAO_ASSINA` ou
   * em `ASSINATURA_DE_TERCEIRO`.
   */
  if (!alvo) return { ok: false, mensagem: 'Paciente não encontrado.' }

  const hoje = diaLocalIso(new Date(), FUSO_DO_PORTAL)
  const ehMenor = idadeEmAnos(alvo.nascimento, hoje) < 18

  let quem: { pacienteId: string; assinadoPorId: string | null }
  try {
    quem = quemAssina({
      pacienteId: alvo.id,
      responsavelLegalId: alvo.responsavelLegalId,
      ehMenor,
      sessaoPacienteId: sessao.pacienteId,
    })
  } catch (e) {
    return { ok: false, mensagem: e instanceof Error ? e.message : 'Não foi possível assinar.' }
  }

  const ip = await ipAtual()
  const agente = await userAgentAtual()
  if (!ip || !agente) {
    // O CHECK `consentimento_eletronica_tem_rastro` recusaria, e a mensagem do banco
    // não diria nada útil ao paciente. Assinatura eletrônica sem rastro é assinatura
    // sem prova — melhor recusar dizendo isso.
    return {
      ok: false,
      mensagem: 'Não foi possível registrar a assinatura com segurança. Tente de outro navegador.',
    }
  }

  const [assinado] = await db
    .insert(consentimento)
    .values({
      pacienteId: quem.pacienteId,
      baseLegal: 'consentimento',
      finalidade: entrada.finalidade,
      versaoTermo: entrada.versaoTermo.slice(0, 20),
      textoHash: createHash('sha256').update(texto).digest('hex'),
      assinadoPorId: quem.assinadoPorId,
      nivelAssinatura: NIVEL_ASSINATURA,
      ip,
      userAgent: agente,
    })
    .returning({ id: consentimento.id })

  await registrarDoPaciente({
    acao: 'criacao',
    entidade: 'consentimento',
    entidadeId: assinado!.id,
    pacienteId: quem.pacienteId,
    detalhes: {
      finalidade: entrada.finalidade,
      nivelAssinatura: NIVEL_ASSINATURA,
      assinadoPorResponsavel: quem.assinadoPorId !== null,
      realm: 'portal',
    },
  })

  revalidatePath('/meu')
  return { ok: true, mensagem: 'Termo assinado. Você pode ver o registro em "Meus dados".' }
}

/** O paciente pede para ser chamado se vagar um horário mais cedo. */
export async function entrarNaListaDeEspera(entrada: {
  readonly procedimentoId?: string
  readonly turno: 'manha' | 'tarde' | 'qualquer'
  readonly diasDeValidade: number
  readonly observacao?: string
}): Promise<ResultadoPortal> {
  const sessao = await exigirSessao()

  const dias = Math.min(Math.max(Math.trunc(entrada.diasDeValidade), 1), 180)
  if (entrada.procedimentoId && !/^[0-9a-f-]{36}$/i.test(entrada.procedimentoId)) {
    return { ok: false, mensagem: 'Escolha inválida.' }
  }

  const regra = await regraDoAutoatendimento()
  if (!regra.ativo) {
    return { ok: false, mensagem: 'Esta clínica ainda não abriu o autoatendimento pelo portal.' }
  }

  try {
    const [novo] = await db
      .insert(listaEspera)
      .values({
        pacienteId: sessao.pacienteId,
        procedimentoId: entrada.procedimentoId ?? null,
        turno: entrada.turno,
        validoAte: new Date(Date.now() + dias * 86_400_000),
        observacao: entrada.observacao?.trim().slice(0, 300) ?? null,
      })
      .returning({ id: listaEspera.id })

    await registrarDoPaciente({
      acao: 'criacao',
      entidade: 'lista_espera',
      entidadeId: novo!.id,
      pacienteId: sessao.pacienteId,
      detalhes: { turno: entrada.turno, realm: 'portal' },
    })

    revalidatePath('/meu')
    return { ok: true, mensagem: 'Pronto. Se vagar um horário, a clínica entra em contato.' }
  } catch (e) {
    // O índice parcial `lista_espera_um_ativo_uk` recusando o segundo clique. Não é
    // erro do paciente — ele já está na fila, e dizer isso é melhor que "já existe".
    if (mensagemDoBanco(e).includes('lista_espera_um_ativo_uk')) {
      return { ok: true, mensagem: 'Você já está na lista de espera para isto.' }
    }
    throw e
  }
}

/**
 * A grade de horários, chamável do cliente.
 *
 * Server action e não rota de API: é leitura que depende da sessão, e o mesmo
 * `exigirSessao()` que protege as escritas protege esta — sem precisar de um segundo
 * mecanismo de autorização para rota.
 *
 * Delega para `horariosParaOPaciente`, que aplica a regra e reusa `horariosLivres`.
 */
export async function horariosDoDia(entrada: {
  readonly diaIso: string
  readonly profissionalId: string
  readonly procedimentoId: string
}): Promise<
  | { readonly ok: true; readonly horarios: readonly { readonly hora: string; readonly inicioIso: string }[] }
  | { readonly ok: false; readonly mensagem: string }
> {
  const sessao = await exigirSessao()

  if (!/^\d{4}-\d{2}-\d{2}$/.test(entrada.diaIso)) {
    return { ok: false, mensagem: 'Dia inválido.' }
  }
  if (
    !/^[0-9a-f-]{36}$/i.test(entrada.profissionalId) ||
    !/^[0-9a-f-]{36}$/i.test(entrada.procedimentoId)
  ) {
    return { ok: false, mensagem: 'Escolha inválida.' }
  }

  const r = await horariosParaOPaciente(sessao, entrada)
  if (!r.ok) return r

  // `inicioIso` e não o `Date`: o valor volta ao servidor no POST de confirmação, e
  // serializar aqui deixa explícito que é isso que atravessa a fronteira.
  return {
    ok: true,
    horarios: r.horarios.map((h) => ({ hora: h.hora, inicioIso: h.inicio.toISOString() })),
  }
}
