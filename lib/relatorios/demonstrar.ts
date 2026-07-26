import { gerarHashSenha } from '@/lib/auth/senha'
import { gerarSegredoTotp } from '@/lib/auth/totp'
import type { Ator } from '@/lib/authz/sessao'
import { db, pool } from '@/lib/db'
import {
  agendamento,
  cadeira,
  cobranca,
  execucao,
  itemPlano,
  pagamento,
  paciente,
  planoTratamento,
  procedimento,
  profissional,
  usuario,
} from '@/lib/db/schema'
import { somar } from '@/lib/domain/dinheiro'
import { instanteDe } from '@/lib/domain/fuso'
import { mesDe, periodoAnterior } from '@/lib/domain/periodo'
import { caixaDoPeriodo, montarPainel, producaoDoPeriodo } from './consultas'

/**
 * Demonstração da Fase 11 contra o Postgres.
 *
 * `npm run relatorios:demo`
 *
 * O que precisa ser provado aqui não é "a tela abre": é que **os números batem**.
 * Um painel plausível e errado é pior que um painel ausente, porque vira decisão.
 * Então a demonstração monta um cenário com valores escolhidos à mão, cujas somas
 * são conhecidas de antemão, e confere cada indicador contra o valor esperado —
 * incluindo o que NÃO deve entrar em cada conta.
 */

const MARCA = 'REL-DEMO'

function passo(n: number, texto: string): void {
  console.log(`\n\x1b[36m${n}.\x1b[0m ${texto}`)
}

function conferir(condicao: boolean, texto: string): void {
  if (condicao) {
    console.log(`   \x1b[32m✓\x1b[0m ${texto}`)
  } else {
    console.error(`   \x1b[31m✗ ${texto}\x1b[0m`)
    process.exitCode = 1
    throw new Error(texto)
  }
}

/** O mês da demonstração: fixo, para as somas serem verificáveis. */
const MES = '2026-05'
const PERIODO = mesDe(`${MES}-15`)
const ANTERIOR = periodoAnterior(PERIODO)

async function main(): Promise<void> {
  console.log('\n═══ Fase 11: os números batem? ═══')
  console.log(`   período: ${PERIODO.rotulo} (anterior: ${ANTERIOR.rotulo})`)

  const criados = { usuarios: [] as string[], pacientes: [] as string[], cadeiras: [] as string[] }

  // ── Cenário ────────────────────────────────────────────────────────────────
  const segredo = gerarSegredoTotp()
  const [uDentista] = await db
    .insert(usuario)
    .values({
      nome: `${MARCA} Dra. Ana`,
      email: `rel-dentista-${Date.now()}@local`,
      senhaHash: await gerarHashSenha('Relatorio-Demo-2026!x'),
      perfil: 'dentista',
      mfaSecret: segredo,
      mfaAtivo: true,
    })
    .returning({ id: usuario.id })
  criados.usuarios.push(uDentista!.id)

  const [prof] = await db
    .insert(profissional)
    .values({ usuarioId: uDentista!.id, cro: `R${Date.now() % 100000}`, ufCro: 'SP' })
    .returning({ id: profissional.id })

  const [cad] = await db
    .insert(cadeira)
    .values({ nome: `${MARCA} Cadeira` })
    .returning({ id: cadeira.id })
  criados.cadeiras.push(cad!.id)

  const ator: Ator = {
    usuarioId: uDentista!.id,
    nome: `${MARCA} Dra. Ana`,
    email: 'rel@local',
    perfil: 'dentista',
    profissionalId: prof!.id,
  }

  // Dois pacientes, para o ticket médio ter divisor conhecido.
  const pacientes: string[] = []
  for (const nome of ['Ana Paciente', 'Bruno Paciente']) {
    const [p] = await db
      .insert(paciente)
      .values({ nome: `${MARCA} ${nome}`, dataNascimento: '1985-01-01' })
      .returning({ id: paciente.id })
    pacientes.push(p!.id)
    criados.pacientes.push(p!.id)
  }

  const [proc] = await db
    .select({ id: procedimento.id, nome: procedimento.nome })
    .from(procedimento)
    .limit(1)

  try {
    // ── Produção: 3 execuções no mês, 1 no mês anterior ───────────────────────
    // Valores escolhidos para a soma ser óbvia: 300 + 200 + 100 = 600 no mês.
    const planos: string[] = []
    for (const pacienteId of pacientes) {
      const [plano] = await db
        .insert(planoTratamento)
        .values({ pacienteId, profissionalId: prof!.id, status: 'ativo', titulo: `${MARCA} plano` })
        .returning({ id: planoTratamento.id })
      planos.push(plano!.id)
    }

    async function executar(planoIndice: number, valor: string, quando: string): Promise<void> {
      const [item] = await db
        .insert(itemPlano)
        .values({
          planoId: planos[planoIndice]!,
          procedimentoId: proc!.id,
          valor,
          status: 'executado',
        })
        .returning({ id: itemPlano.id })

      await db.insert(execucao).values({
        itemPlanoId: item!.id,
        profissionalId: prof!.id,
        executadoEm: instanteDe(quando, '10:00'),
      })
    }

    await executar(0, '300.00', `${MES}-05`)
    await executar(0, '200.00', `${MES}-12`)
    await executar(1, '100.00', `${MES}-20`)
    // Fora do período: não pode aparecer no mês.
    await executar(1, '999.00', '2026-04-10')

    passo(1, 'Produção do mês soma só o que foi executado NO mês')
    const producao = await producaoDoPeriodo(PERIODO)
    conferir(
      producao.valorExecutado === '600.00',
      `valor executado = ${producao.valorExecutado} (esperado 600.00)`,
    )
    conferir(producao.execucoes === 3, `${producao.execucoes} execuções (esperado 3)`)
    conferir(
      producao.pacientesAtendidos === 2,
      `${producao.pacientesAtendidos} pacientes distintos (esperado 2)`,
    )

    passo(2, 'A execução de abril aparece no mês anterior, não neste')
    const producaoAnterior = await producaoDoPeriodo(ANTERIOR)
    conferir(
      producaoAnterior.valorExecutado === '999.00',
      `abril = ${producaoAnterior.valorExecutado} (esperado 999.00)`,
    )

    // ── Caixa: pagamentos com datas e conciliação conhecidas ──────────────────
    // A cobrança exige orçamento aprovado (trigger da Fase 8, e está certa). O
    // que interessa aqui é conferir SOMA de caixa, não repetir o fluxo comercial
    // inteiro — então a cobrança e as parcelas entram com as triggers desligadas,
    // e isso é artifício exclusivo desta demonstração.
    const cliente = await pool.connect()
    let cobrancaId: string
    let parcelaIds: string[]
    try {
      await cliente.query('begin')
      await cliente.query("set local session_replication_role = 'replica'")
      const r = await cliente.query(
        `insert into cobranca (paciente_id, valor_total, forma, criado_por_id)
         values ($1, '600.00', 'pix', $2) returning id`,
        [pacientes[0]!, uDentista!.id],
      )
      cobrancaId = r.rows[0].id
      const p1 = await cliente.query(
        `insert into parcela (cobranca_id, numero, valor, vencimento)
         values ($1, 1, '400.00', $2), ($1, 2, '200.00', $3) returning id`,
        [cobrancaId, `${MES}-10`, `${MES}-25`],
      )
      parcelaIds = p1.rows.map((x: { id: string }) => x.id)
      await cliente.query('commit')
    } catch (e) {
      await cliente.query('rollback')
      throw e
    } finally {
      cliente.release()
    }

    // 400 conciliado + 200 não conciliado = 600 recebido, 400 conciliado.
    await db.insert(pagamento).values([
      {
        parcelaId: parcelaIds[0]!,
        valor: '400.00',
        pagoEm: `${MES}-10`,
        meio: 'pix',
        // `conciliado_em` é exigido pelo CHECK da Fase 8 quando conciliado é
        // verdadeiro — conciliado sem data é conciliação que ninguém fez.
        conciliado: true,
        conciliadoEm: new Date(`${MES}-11T12:00:00Z`),
        registradoPorId: uDentista!.id,
      },
      {
        parcelaId: parcelaIds[1]!,
        valor: '200.00',
        pagoEm: `${MES}-25`,
        meio: 'dinheiro',
        conciliado: false,
        registradoPorId: uDentista!.id,
      },
    ])

    passo(3, 'Caixa separa recebido de conciliado')
    const caixa = await caixaDoPeriodo(PERIODO)
    conferir(caixa.recebido === '600.00', `recebido = ${caixa.recebido} (esperado 600.00)`)
    conferir(caixa.conciliado === '400.00', `conciliado = ${caixa.conciliado} (esperado 400.00)`)
    conferir(
      caixa.porForma.length === 2,
      `${caixa.porForma.length} formas de pagamento (esperado 2)`,
    )
    conferir(
      somar(...caixa.porForma.map((f) => f.valor)) === caixa.recebido,
      'a soma por forma bate com o recebido',
    )

    passo(4, 'Ticket médio divide por paciente distinto')
    conferir(
      caixa.pacientesQuePagaram === 1,
      `${caixa.pacientesQuePagaram} paciente pagou (esperado 1)`,
    )
    conferir(
      caixa.ticketMedioCentavos === 60_000,
      `ticket = ${caixa.ticketMedioCentavos} centavos (esperado 60000)`,
    )

    passo(5, 'Produção e caixa são números DIFERENTES e não se somam')
    // Neste cenário coincidem em 600 por construção; o que se prova é que são
    // consultas independentes, com origens distintas.
    conferir(
      producao.valorExecutado === '600.00' && caixa.recebido === '600.00',
      'produção e caixa calculados separadamente, cada um da sua fonte',
    )
    conferir(
      producaoAnterior.valorExecutado === '999.00' &&
        (await caixaDoPeriodo(ANTERIOR)).recebido === '0.00',
      'em abril houve produção (999,00) e nenhum caixa (0,00) — a diferença é o ponto',
    )

    // ── Agenda: 4 concluídos, 2 faltas, 3 cancelados ─────────────────────────
    async function agendar(
      pacienteIndice: number,
      dia: string,
      hora: string,
      status: 'concluido' | 'faltou' | 'cancelado',
      confirmado: boolean,
    ): Promise<void> {
      const inicio = instanteDe(`${MES}-${dia}`, hora)
      await db.insert(agendamento).values({
        pacienteId: pacientes[pacienteIndice]!,
        profissionalId: prof!.id,
        cadeiraId: cad!.id,
        inicio,
        fim: new Date(inicio.getTime() + 60 * 60_000),
        status,
        confirmadoEm: confirmado ? new Date(inicio.getTime() - 86_400_000) : null,
        confirmadoVia: confirmado ? 'whatsapp' : null,
        motivoCancelamento: status === 'cancelado' ? 'demonstração' : null,
        canceladoEm: status === 'cancelado' ? new Date() : null,
      })
    }

    // 12 confirmados que vieram, 2 confirmados que faltaram → 14,3% de falta
    // 10 não confirmados que vieram, 5 que faltaram → 33,3% de falta
    let dia = 4
    for (let i = 0; i < 12; i++) await agendar(0, String(dia++).padStart(2, '0'), '08:00', 'concluido', true)
    dia = 4
    for (let i = 0; i < 2; i++) await agendar(0, String(dia++).padStart(2, '0'), '09:00', 'faltou', true)
    dia = 4
    for (let i = 0; i < 10; i++) await agendar(1, String(dia++).padStart(2, '0'), '10:00', 'concluido', false)
    dia = 4
    for (let i = 0; i < 5; i++) await agendar(1, String(dia++).padStart(2, '0'), '11:00', 'faltou', false)
    dia = 4
    for (let i = 0; i < 3; i++) await agendar(0, String(dia++).padStart(2, '0'), '14:00', 'cancelado', false)

    passo(6, 'Taxa de falta NÃO inclui cancelamento na base')
    const painel = await montarPainel(ator, PERIODO, new Date('2026-06-30T12:00:00Z'))
    const comp = painel.agenda.comparecimento
    conferir(comp.concluidos === 22, `${comp.concluidos} concluídos (esperado 22)`)
    conferir(comp.faltas === 7, `${comp.faltas} faltas (esperado 7)`)
    conferir(comp.cancelados === 3, `${comp.cancelados} cancelados (esperado 3)`)
    // 7 / (22 + 7) = 24,1%. Com cancelado na base daria 21,9% — o erro que a
    // separação evita.
    conferir(comp.taxaDeFalta === 24.1, `taxa de falta = ${comp.taxaDeFalta}% (esperado 24.1)`)
    conferir(
      comp.taxaDeCancelamento === 9.4,
      `taxa de cancelamento = ${comp.taxaDeCancelamento}% (esperado 9.4)`,
    )

    passo(7, 'Efeito da confirmação sai comparável com amostra suficiente')
    const efeito = painel.agenda.efeitoConfirmacao
    conferir(efeito.baseConfirmados === 14, `base confirmados = ${efeito.baseConfirmados}`)
    conferir(efeito.baseNaoConfirmados === 15, `base não confirmados = ${efeito.baseNaoConfirmados}`)
    conferir(
      efeito.faltaComConfirmacao === 14.3,
      `falta com confirmação = ${efeito.faltaComConfirmacao}%`,
    )
    conferir(
      efeito.faltaSemConfirmacao === 33.3,
      `falta sem confirmação = ${efeito.faltaSemConfirmacao}%`,
    )
    conferir(
      efeito.diferencaEmPontos === 19,
      `confirmar reduziu ${efeito.diferencaEmPontos} pontos (esperado 19)`,
    )

    passo(8, 'Ocupação usa os minutos disponíveis da clínica, não 24 h')
    const oc = painel.agenda.ocupacao
    conferir(oc.minutosDisponiveis > 0, `${oc.minutosDisponiveis} minutos disponíveis no mês`)
    // 29 agendamentos não cancelados × 60 min = 1740.
    conferir(oc.minutosReservados === 1740, `${oc.minutosReservados} min reservados (esperado 1740)`)
    conferir(oc.minutosRealizados === 1320, `${oc.minutosRealizados} min realizados (esperado 1320)`)
    conferir(oc.minutosPerdidosPorFalta === 420, `${oc.minutosPerdidosPorFalta} min perdidos`)
    conferir(
      oc.reservada !== null && oc.reservada > 0 && oc.reservada < 100,
      `ocupação reservada = ${oc.reservada}%`,
    )
    conferir(
      (oc.realizada ?? 0) < (oc.reservada ?? 0),
      'realizada é menor que reservada — é o efeito das faltas',
    )

    passo(9, 'Cancelado não ocupa agenda')
    // 3 cancelados × 60 = 180 min que NÃO entram nos reservados.
    conferir(oc.minutosReservados === 1740, 'os 180 min dos cancelados ficaram fora')

    console.log('\n\x1b[32m═══ Todos os números conferidos contra valores esperados ═══\x1b[0m\n')
  } finally {
    await limpar(criados)
  }
}

async function limpar(criados: {
  usuarios: string[]
  pacientes: string[]
  cadeiras: string[]
}): Promise<void> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query("set local session_replication_role = 'replica'")
    await c.query(
      `delete from pagamento where parcela_id in (
         select pa.id from parcela pa join cobranca co on co.id = pa.cobranca_id
         where co.paciente_id = any($1))`,
      [criados.pacientes],
    )
    await c.query(
      'delete from parcela where cobranca_id in (select id from cobranca where paciente_id = any($1))',
      [criados.pacientes],
    )
    await c.query('delete from cobranca where paciente_id = any($1)', [criados.pacientes])
    await c.query(
      `delete from execucao where item_plano_id in (
         select ip.id from item_plano ip join plano_tratamento pt on pt.id = ip.plano_id
         where pt.paciente_id = any($1))`,
      [criados.pacientes],
    )
    await c.query(
      'delete from item_plano where plano_id in (select id from plano_tratamento where paciente_id = any($1))',
      [criados.pacientes],
    )
    await c.query('delete from plano_tratamento where paciente_id = any($1)', [criados.pacientes])
    await c.query('delete from agendamento where paciente_id = any($1)', [criados.pacientes])
    await c.query('delete from audit_log where paciente_id = any($1)', [criados.pacientes])
    await c.query('delete from paciente where id = any($1)', [criados.pacientes])
    await c.query('delete from profissional where usuario_id = any($1)', [criados.usuarios])
    await c.query('delete from usuario where id = any($1)', [criados.usuarios])
    await c.query('delete from cadeira where id = any($1)', [criados.cadeiras])
    await c.query('commit')
    console.log('Dados da demonstração removidos.')
  } catch (e) {
    await c.query('rollback')
    console.error('Falha ao limpar:', e)
  } finally {
    c.release()
  }
}

main()
  .then(async () => {
    await pool.end()
    process.exit(process.exitCode ?? 0)
  })
  .catch(async (e) => {
    console.error(e)
    await pool.end()
    process.exit(1)
  })
