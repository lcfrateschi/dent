'use server'

import { createHash } from 'node:crypto'
import { registrarDoPaciente } from '@/lib/auditoria/registrar'
import { conferirConvite, conviteExpirou, hashDoToken } from '@/lib/auth/convite'
import { avaliarSenhaPaciente, gerarHashSenha, verificarSenha } from '@/lib/auth/senha'
import { db } from '@/lib/db'
import { agendamento, auditLog, consentimento, orcamento, paciente, pacienteConta } from '@/lib/db/schema'
import {
  MENSAGEM_CREDENCIAL_INVALIDA,
  bloqueioAtivo,
  decidirBloqueio,
  esperaRestante,
  ipExcedeu,
  JANELA_MINUTOS,
} from '@/lib/domain/bloqueio'
import { FINALIDADE_WHATSAPP } from '@/lib/mensageria/consentimento'
import { and, eq, isNull, sql } from 'drizzle-orm'
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
