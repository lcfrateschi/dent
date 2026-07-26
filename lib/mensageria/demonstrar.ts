import { db } from '@/lib/db'
import {
  agendamento,
  cadeira,
  consentimento,
  mensagemWhatsapp,
  paciente,
  profissional,
  respostaWhatsapp,
  usuario,
} from '@/lib/db/schema'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { assinar, verificarAssinatura } from './assinatura'
import { FINALIDADE_WHATSAPP, VERSAO_TERMO_WHATSAPP } from './consentimento'
import { despacharPendentes } from './despachar'
import { enfileirarLembrete } from './fila'
import { extrairEventos } from './payload'
import { ProvedorSimulado } from './provedor'
import { aplicarStatus, processarMensagemRecebida } from './receber'

/**
 * Demonstração ponta a ponta da Fase 9, contra o Postgres de verdade.
 *
 * `npm run whatsapp:demo` (dentro do container, ver README).
 *
 * Existe porque o fluxo atravessa camadas que os testes unitários cobrem
 * separadamente — decisão de horário, fila, provedor, webhook, agenda — e o que
 * pode dar errado é a costura entre elas. Aqui o caminho inteiro roda:
 *
 *   agenda → lembrete enfileirado → despachado → paciente responde →
 *   webhook assinado → agenda confirmada/cancelada
 *
 * Sem nenhuma credencial da Meta: o provedor simulado ocupa o lugar dela, e o
 * webhook é montado e assinado localmente com o mesmo HMAC que a Meta usaria.
 *
 * Limpa o que criou no final. Usa nomes com prefixo `[DEMO]` para nada se
 * confundir com paciente real.
 */

const SEGREDO_DEMO = 'segredo-de-demonstracao'

function passo(n: number, texto: string): void {
  console.log(`\n\x1b[36m${n}.\x1b[0m ${texto}`)
}

function ok(texto: string): void {
  console.log(`   \x1b[32m✓\x1b[0m ${texto}`)
}

function falhou(texto: string): never {
  console.error(`   \x1b[31m✗ ${texto}\x1b[0m`)
  process.exitCode = 1
  throw new Error(texto)
}

/**
 * Mensagem real do Postgres.
 *
 * O Drizzle embrulha o erro em "Failed query: insert into …" e põe o texto do
 * `RAISE EXCEPTION` no `cause`. Quem só lê `e.message` mostra SQL ao usuário em
 * vez de "paciente não tem consentimento" — vale para esta demonstração e vale
 * para as telas.
 */
function mensagemDoBanco(e: unknown): string {
  let atual: unknown = e
  const partes: string[] = []
  while (atual instanceof Error) {
    partes.push(atual.message)
    atual = (atual as { cause?: unknown }).cause
  }
  return partes.join(' | ')
}

function conferir(condicao: boolean, texto: string): void {
  if (condicao) ok(texto)
  else falhou(texto)
}

/** Monta um webhook igual ao da Meta e o assina. */
function webhookDeTexto(remetente: string, texto: string, wamid: string): { corpo: string; assinatura: string } {
  const corpo = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'demo',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              messages: [
                {
                  from: remetente,
                  id: wamid,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: texto },
                },
              ],
            },
          },
        ],
      },
    ],
  })
  return { corpo, assinatura: assinar(corpo, SEGREDO_DEMO) }
}

/** Repete o que a rota faz: verifica a assinatura, só então processa. */
async function entregarWebhook(remetente: string, texto: string, wamid: string, agora: Date) {
  const { corpo, assinatura } = webhookDeTexto(remetente, texto, wamid)

  const v = verificarAssinatura(corpo, assinatura, SEGREDO_DEMO)
  if (!v.valida) falhou(`assinatura própria não validou: ${v.motivo}`)

  const eventos = extrairEventos(JSON.parse(corpo))
  const resultados = []
  for (const m of eventos.mensagens) resultados.push(await processarMensagemRecebida(m, agora))
  return resultados
}

async function main(): Promise<void> {
  const marca = `[DEMO ${new Date().toISOString().slice(11, 19)}]`
  console.log(`\n═══ Fase 9 ponta a ponta ${marca} ═══`)

  const [dentista] = await db
    .insert(usuario)
    .values({
      // Marca no FIM do nome: `primeiroNome` usa o primeiro token, e um prefixo
      // faria o lembrete cumprimentar "Olá, [DEMO".
      nome: `Dra. Demo ${marca}`,
      email: `demo-${Date.now()}@demo.local`,
      senhaHash: 'x',
      perfil: 'dentista',
    })
    .returning({ id: usuario.id })

  const [prof] = await db
    .insert(profissional)
    .values({ usuarioId: dentista!.id, cro: `D${Date.now() % 100000}`, ufCro: 'SP' })
    .returning({ id: profissional.id })

  const [cad] = await db
    .insert(cadeira)
    .values({ nome: `${marca} Cadeira` })
    .returning({ id: cadeira.id })

  // Telefone escrito como a recepção digitaria, com 8 dígitos (cadastro antigo):
  // o sistema tem de achar o nono dígito sozinho.
  const [pac] = await db
    .insert(paciente)
    .values({
      nome: `Joana Pereira da Silva ${marca}`,
      dataNascimento: '1988-03-14',
      telefone: '(11) 8765-4321',
    })
    .returning({ id: paciente.id })

  const pacienteId = pac!.id
  const agora = new Date()
  const inicio = new Date(agora.getTime() + 30 * 3_600_000) // 30h à frente

  const [ag] = await db
    .insert(agendamento)
    .values({
      pacienteId,
      profissionalId: prof!.id,
      cadeiraId: cad!.id,
      inicio,
      fim: new Date(inicio.getTime() + 3_600_000),
    })
    .returning({ id: agendamento.id })

  const agendamentoId = ag!.id
  const criados = { usuarioId: dentista!.id, profId: prof!.id, cadeiraId: cad!.id, pacienteId, agendamentoId }

  try {
    passo(1, 'Sem consentimento LGPD, o banco recusa enfileirar')
    let erroLgpd = ''
    try {
      await enfileirarLembrete(agendamentoId, agora)
      erroLgpd = ''
    } catch (e) {
      erroLgpd = mensagemDoBanco(e)
    }
    const doTrigger = erroLgpd.split(' | ').find((p) => p.includes('consentimento')) ?? erroLgpd
    conferir(erroLgpd.includes('consentimento'), `recusado pelo banco: ${doTrigger}`)

    passo(2, 'Paciente assina o termo de contato por WhatsApp')
    await db.insert(consentimento).values({
      pacienteId,
      baseLegal: 'consentimento',
      finalidade: FINALIDADE_WHATSAPP,
      versaoTermo: VERSAO_TERMO_WHATSAPP,
      textoHash: createHash('sha256').update('termo demo').digest('hex'),
    })
    ok('consentimento registrado')

    passo(3, 'Enfileirar o lembrete')
    const primeiro = await enfileirarLembrete(agendamentoId, agora)
    conferir(primeiro.enfileirada, `enfileirado: ${primeiro.id}`)

    const [msg] = await db
      .select({
        destino: mensagemWhatsapp.destino,
        corpo: mensagemWhatsapp.corpo,
        agendadoPara: mensagemWhatsapp.agendadoPara,
        situacao: mensagemWhatsapp.situacao,
      })
      .from(mensagemWhatsapp)
      .where(eq(mensagemWhatsapp.id, primeiro.id!))

    conferir(msg!.destino === '5511987654321', `telefone '(11) 8765-4321' virou ${msg!.destino}`)
    conferir(msg!.situacao === 'pendente', 'situação inicial: pendente')
    const hora = msg!.agendadoPara.getHours()
    console.log(`   texto:\n${msg!.corpo.split('\n').map((l) => `      │ ${l}`).join('\n')}`)
    ok(`agendado para ${msg!.agendadoPara.toISOString()} (hora local do servidor: ${hora}h)`)

    passo(4, 'Rodar o job de novo NÃO cria segunda mensagem')
    const segundo = await enfileirarLembrete(agendamentoId, agora)
    conferir(!segundo.enfileirada, `recusado: ${segundo.motivo}`)
    const quantas = await db
      .select({ id: mensagemWhatsapp.id })
      .from(mensagemWhatsapp)
      .where(eq(mensagemWhatsapp.agendamentoId, agendamentoId))
    conferir(quantas.length === 1, `${quantas.length} mensagem na fila para este atendimento`)

    passo(5, 'Despachar pelo provedor simulado')
    // A mensagem está agendada para o futuro; o despacho usa um "agora" adiante
    // para exercitar o caminho sem esperar de verdade.
    const provedor = new ProvedorSimulado()
    const depois = new Date(msg!.agendadoPara.getTime() + 1000)
    const resumo = await despacharPendentes(depois, { provedor })
    conferir(resumo.enviadas === 1, `enviadas=${resumo.enviadas} falhadas=${resumo.falhadas}`)
    conferir(provedor.enviados.length === 1, `provedor recebeu ${provedor.enviados.length} envio`)

    const [enviada] = await db
      .select({
        situacao: mensagemWhatsapp.situacao,
        idExterno: mensagemWhatsapp.idExterno,
        enviadoEm: mensagemWhatsapp.enviadoEm,
      })
      .from(mensagemWhatsapp)
      .where(eq(mensagemWhatsapp.id, primeiro.id!))
    conferir(enviada!.situacao === 'enviada', `situação: ${enviada!.situacao}`)
    conferir(enviada!.idExterno !== null, `wamid gravado: ${enviada!.idExterno}`)

    passo(6, 'Despachar de novo não reenvia')
    const provedor2 = new ProvedorSimulado()
    const resumo2 = await despacharPendentes(depois, { provedor: provedor2 })
    conferir(
      resumo2.reivindicadas === 0 && provedor2.enviados.length === 0,
      'nada pendente para reivindicar',
    )

    passo(7, 'Webhook de status: entregue e lida')
    conferir(
      await aplicarStatus({ idExterno: enviada!.idExterno!, situacao: 'entregue', em: new Date() }),
      'entregue aplicado',
    )
    conferir(
      await aplicarStatus({ idExterno: enviada!.idExterno!, situacao: 'lida', em: new Date() }),
      'lida aplicado',
    )
    const [lida] = await db
      .select({ situacao: mensagemWhatsapp.situacao })
      .from(mensagemWhatsapp)
      .where(eq(mensagemWhatsapp.id, primeiro.id!))
    conferir(lida!.situacao === 'lida', `situação final: ${lida!.situacao}`)

    passo(8, 'Status fora de ordem não retrocede')
    const retrocedeu = await aplicarStatus({
      idExterno: enviada!.idExterno!,
      situacao: 'entregue',
      em: new Date(),
    })
    conferir(!retrocedeu, 'entregue depois de lida foi ignorado, sem erro')

    passo(9, 'Paciente responde "Sim" — webhook assinado')
    const r1 = await entregarWebhook('5511987654321', 'Sim', `wamid.DEMO${Date.now()}A`, new Date())
    conferir(r1.length === 1 && r1[0]!.interpretacao === 'confirmou', `ação: ${r1[0]?.acao}`)

    const [agConfirmado] = await db
      .select({
        status: agendamento.status,
        via: agendamento.confirmadoVia,
        em: agendamento.confirmadoEm,
      })
      .from(agendamento)
      .where(eq(agendamento.id, agendamentoId))
    conferir(agConfirmado!.status === 'confirmado', `agenda: status=${agConfirmado!.status}`)
    conferir(agConfirmado!.via === 'whatsapp', `canal registrado: ${agConfirmado!.via}`)

    passo(10, 'Reentrega do MESMO webhook não conta de novo')
    const wamidRepetido = `wamid.DEMO${Date.now()}B`
    await entregarWebhook('5511987654321', 'Sim', wamidRepetido, new Date())
    const r2 = await entregarWebhook('5511987654321', 'Sim', wamidRepetido, new Date())
    conferir(!r2[0]!.registrada, `reentrega detectada: ${r2[0]!.acao}`)

    passo(11, 'Resposta ambígua não mexe na agenda')
    const r3 = await entregarWebhook(
      '5511987654321',
      'assim que eu puder eu confirmo com voces',
      `wamid.DEMO${Date.now()}C`,
      new Date(),
    )
    conferir(r3[0]!.interpretacao === 'nao_entendido', `interpretação: ${r3[0]!.interpretacao}`)
    conferir(r3[0]!.acao.includes('recepção'), `ação: ${r3[0]!.acao}`)
    const [aindaConfirmado] = await db
      .select({ status: agendamento.status })
      .from(agendamento)
      .where(eq(agendamento.id, agendamentoId))
    conferir(aindaConfirmado!.status === 'confirmado', 'agenda intacta')

    passo(12, 'Paciente pede para cancelar')
    const r4 = await entregarWebhook(
      '5511987654321',
      'Infelizmente vou precisar remarcar, surgiu um compromisso',
      `wamid.DEMO${Date.now()}D`,
      new Date(),
    )
    conferir(r4[0]!.interpretacao === 'cancelou', `interpretação: ${r4[0]!.interpretacao}`)
    const [cancelado] = await db
      .select({ status: agendamento.status, motivo: agendamento.motivoCancelamento })
      .from(agendamento)
      .where(eq(agendamento.id, agendamentoId))
    conferir(cancelado!.status === 'cancelado', `agenda: status=${cancelado!.status}`)
    conferir(
      (cancelado!.motivo ?? '').includes('remarcar'),
      `motivo guarda o texto do paciente: "${(cancelado!.motivo ?? '').slice(0, 60)}…"`,
    )

    passo(13, 'Número desconhecido não altera agenda de ninguém')
    const r5 = await entregarWebhook('5511900000001', 'Não', `wamid.DEMO${Date.now()}E`, new Date())
    conferir(r5[0]!.registrada, 'resposta registrada para a recepção ver')
    conferir(r5[0]!.agendamentoId === undefined, `sem vínculo: ${r5[0]!.acao}`)

    passo(14, 'A trilha de auditoria guarda quem pediu')
    const respostas = await db
      .select({ texto: respostaWhatsapp.texto, interp: respostaWhatsapp.interpretacao })
      .from(respostaWhatsapp)
      .where(eq(respostaWhatsapp.pacienteId, pacienteId))
    // 4 = "Sim" (9) + a primeira entrega do wamid repetido (10) + ambígua (11)
    // + cancelamento (12). A REENTREGA do passo 10 não gerou linha — é a trava.
    conferir(respostas.length === 4, `${respostas.length} respostas gravadas deste paciente`)
    conferir(
      respostas.filter((r) => r.interp === 'confirmou').length === 2,
      'as duas confirmações distintas foram gravadas, a reentrega não',
    )

    console.log('\n\x1b[32m═══ Fluxo completo verificado, sem credencial da Meta ═══\x1b[0m\n')
  } finally {
    await limpar(criados)
  }
}

/**
 * Limpeza.
 *
 * As triggers proíbem DELETE em `mensagem_whatsapp` e `resposta_whatsapp`, de
 * propósito — é a garantia legal. Para a demonstração não deixar lixo, a limpeza
 * usa `session_replication_role = 'replica'`, que desliga as triggers de usuário
 * dentro da transação.
 *
 * ⚠️ Isto exige superusuário e existe **apenas aqui**. Nenhum caminho de
 * aplicação faz isso; se algum dia fizer, a garantia de retenção deixou de valer.
 */
async function limpar(c: {
  usuarioId: string
  profId: string
  cadeiraId: string
  pacienteId: string
  agendamentoId: string
}): Promise<void> {
  const cliente = await db.$client.connect()
  try {
    await cliente.query('begin')
    await cliente.query("set local session_replication_role = 'replica'")
    await cliente.query('delete from resposta_whatsapp where paciente_id = $1 or remetente = $2', [
      c.pacienteId,
      '5511900000001',
    ])
    await cliente.query('delete from mensagem_whatsapp where paciente_id = $1', [c.pacienteId])
    await cliente.query('delete from audit_log where paciente_id = $1', [c.pacienteId])
    await cliente.query('delete from agendamento where id = $1', [c.agendamentoId])
    await cliente.query('delete from consentimento where paciente_id = $1', [c.pacienteId])
    await cliente.query('delete from paciente where id = $1', [c.pacienteId])
    await cliente.query('delete from profissional where id = $1', [c.profId])
    await cliente.query('delete from usuario where id = $1', [c.usuarioId])
    await cliente.query('delete from cadeira where id = $1', [c.cadeiraId])
    await cliente.query('commit')
    console.log('Dados da demonstração removidos.')
  } catch (e) {
    await cliente.query('rollback')
    console.error('Falha ao limpar a demonstração:', e)
  } finally {
    cliente.release()
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
