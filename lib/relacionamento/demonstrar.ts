import { gerarHashSenha } from '@/lib/auth/senha'
import type { Ator } from '@/lib/authz/sessao'
import { db, pool } from '@/lib/db'
import {
  agendamento,
  cadeira,
  cobranca,
  contatoRelacionamento,
  execucao,
  itemPlano,
  orcamento,
  orcamentoItem,
  paciente,
  parcela,
  planoTratamento,
  procedimento,
  profissional,
  regraRetorno,
  tarefaRelacionamento,
  usuario,
} from '@/lib/db/schema'
import { chaveDaTarefa } from '@/lib/domain/relacionamento'
import { clinicaParaScript } from '@/lib/demo/clinicaDaDemo'
import { comContextoDeClinica } from '@/lib/tenant/contexto'
import { desligarTriggersDeAplicacao, religarTriggersDeAplicacao } from '@/lib/demo/triggers'
import {
  dispensarTarefaComAtor,
  registrarContatoComAtor,
} from './tarefas'
import { filaDeRelacionamento, resumoDaFila } from './consultas'
import {
  gerarAprovadoNaoExecutado,
  gerarFaltaSemRemarcar,
  gerarInadimplencia,
  gerarOrcamentoSemResposta,
  gerarRetornoProgramado,
  gerarTodasAsTarefas,
} from './geradores'
import { conversaoDeOrcamento, recuperacaoDaFila } from '@/lib/domain/indicadores'
import { conversaoNoPeriodo, recuperacaoNoPeriodo } from '@/lib/relatorios/relacionamento'
import { and, eq, inArray, sql } from 'drizzle-orm'

/**
 * Fase 18 verificada contra o Postgres — **confere número, não fluxo**.
 *
 * `npm run relacionamento:demo`
 *
 * A pergunta que este script responde não é "o código roda?". É: os cinco geradores
 * encontram exatamente o que deviam encontrar, ignoram o que deviam ignorar, e a
 * segunda passada não cria nada? E a pergunta que dá valor às outras: **a tarefa
 * dispensada volta?**
 *
 * Cada afirmação tem contraprova. A mais importante mede o gerador ERRADO ao lado do
 * certo, na mesma transação, para o número mostrar a diferença.
 */

const MARCA = '[REL]'
let falhas = 0

function titulo(t: string): void {
  console.log(`\n\x1b[36m${t}\x1b[0m`)
}

function conferir(ok: boolean, texto: string): void {
  if (ok) {
    console.log(`   \x1b[32m✓\x1b[0m ${texto}`)
  } else {
    falhas++
    console.log(`   \x1b[31m✗ ${texto}\x1b[0m`)
  }
}

function conferirIgual(obtido: unknown, esperado: unknown, texto: string): void {
  conferir(
    JSON.stringify(obtido) === JSON.stringify(esperado),
    `${texto} (esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)})`,
  )
}

interface Fixture {
  readonly ator: Ator
  readonly pacienteA: string
  readonly pacienteB: string
  readonly orcamentoId: string
  readonly parcelaId: string
  readonly itemAprovadoId: string
  readonly agendamentoFaltouId: string
  readonly execucaoId: string
}

/**
 * Monta o cenário. Tudo dentro de UMA transação: a trava deferida de
 * `drizzle/0021` cobra no commit que usuário `dentista` ativo tenha linha em
 * `profissional`, e dois inserts soltos comitam separado.
 */
async function montar(): Promise<Fixture> {
  return await db.transaction(async (tx) => {
    const [proc] = await tx
      .select({ id: procedimento.id })
      .from(procedimento)
      .where(and(eq(procedimento.clinicaId, sql`app_clinica_id()`), eq(procedimento.codigo, 'PREV-001')))
      .limit(1)
    if (!proc) throw new Error('PREV-001 não existe nesta clínica — rode `npm run db:seed`.')

    const [regra] = await tx
      .select({ meses: regraRetorno.meses })
      .from(regraRetorno)
      .where(
        and(eq(regraRetorno.clinicaId, sql`app_clinica_id()`), eq(regraRetorno.procedimentoId, proc.id)),
      )
      .limit(1)
    if (!regra) throw new Error('Sem regra de retorno para PREV-001 — rode `npm run db:seed`.')

    const [u] = await tx
      .insert(usuario)
      .values({
        nome: `${MARCA} Dra. Fila`,
        email: `rel-${Date.now()}@demo.local`,
        senhaHash: await gerarHashSenha('Rel-Demo-2026'),
        perfil: 'dentista',
        mfaAtivo: true,
      })
      .returning({ id: usuario.id, clinicaId: usuario.clinicaId })

    const [prof] = await tx
      .insert(profissional)
      .values({ usuarioId: u!.id, cro: `9${String(Date.now()).slice(-5)}`, ufCro: 'SP' })
      .returning({ id: profissional.id })

    const [cad] = await tx
      .insert(cadeira)
      .values({ nome: `${MARCA} Cadeira ${Date.now()}`, ordem: 90 })
      .returning({ id: cadeira.id })

    const [pa] = await tx
      .insert(paciente)
      .values({ nome: `${MARCA} Paciente A`, dataNascimento: '1990-05-10', telefone: '11999990001' })
      .returning({ id: paciente.id })
    const [pb] = await tx
      .insert(paciente)
      .values({ nome: `${MARCA} Paciente B`, dataNascimento: '1988-02-02', telefone: '11999990002' })
      .returning({ id: paciente.id })

    /**
     * ── O orçamento segue o FLUXO REAL: rascunho, linhas, depois enviar ───────
     *
     * Duas travas de `drizzle/0004` cobraram as duas tentativas anteriores desta
     * fixture, e as duas estavam certas:
     *
     *   1. inserir já como `enviado` sem linhas → *"soma das linhas (0.00) difere do
     *      valor bruto (800.00)"*, no commit (constraint DEFERIDA);
     *   2. inserir a linha depois de `enviado` → *"as linhas de um orçamento enviado
     *      são imutáveis. Gere um novo orçamento."*
     *
     * Orçamento é **documento congelado** — decisão fechada do projeto. Uma fixture
     * que contornasse isso (desligando trigger, por exemplo) estaria testando um
     * sistema que não existe.
     */
    const orcamentoEnviadoHa = async (
      pacienteId: string,
      valor: string,
      descricao: string,
      dias: number,
    ): Promise<string> => {
      const [o] = await tx
        .insert(orcamento)
        .values({
          pacienteId,
          status: 'rascunho',
          validadeAte: sql`(hoje_na_clinica() + 20)`,
          valorBruto: valor,
          valorTotal: valor,
        })
        .returning({ id: orcamento.id })
      await tx.insert(orcamentoItem).values({
        orcamentoId: o!.id,
        descricao,
        quantidade: 1,
        valorUnitario: valor,
      })
      await tx
        .update(orcamento)
        .set({ status: 'enviado', enviadoEm: sql`now() - (${dias} || ' days')::interval` })
        .where(eq(orcamento.id, o!.id))
      return o!.id
    }

    // Enviado há 10 dias, ainda válido: DEVE gerar tarefa.
    const orcId = await orcamentoEnviadoHa(pa!.id, '800.00', `${MARCA} Profilaxia`, 10)
    // Enviado ONTEM: NÃO deve gerar (ainda dentro dos 7 dias).
    await orcamentoEnviadoHa(pb!.id, '300.00', `${MARCA} Consulta`, 1)

    // ── Cobrança com parcela vencida: DEVE gerar ─────────────────────────────
    const [cob] = await tx
      .insert(cobranca)
      .values({ pacienteId: pa!.id, valorTotal: '400.00', forma: 'boleto' })
      .returning({ id: cobranca.id })
    const [par] = await tx
      .insert(parcela)
      .values({
        cobrancaId: cob!.id,
        numero: 1,
        vencimento: sql`(hoje_na_clinica() - 5)`,
        valor: '400.00',
        status: 'aberta',
      })
      .returning({ id: parcela.id })

    // ── Plano com item aprovado há 40 dias: DEVE gerar ───────────────────────
    const [plano] = await tx
      .insert(planoTratamento)
      .values({
        pacienteId: pa!.id,
        profissionalId: prof!.id,
        titulo: `${MARCA} Plano`,
        // `ativo` e não 'aprovado': quem aprova é o ITEM, não o plano. Ver o
        // GLOSSARIO — `plano_tratamento` é o que se pretende fazer, `item_plano` é a
        // linha que o paciente aprova.
        status: 'ativo',
      })
      .returning({ id: planoTratamento.id })
    const [itemAprovado] = await tx
      .insert(itemPlano)
      .values({
        planoId: plano!.id,
        procedimentoId: proc.id,
        valor: '150.00',
        status: 'aprovado',
        criadoEm: sql`now() - interval '40 days'`,
      })
      .returning({ id: itemPlano.id })

    // ── Item executado há 7 meses, com regra de 6: DEVE gerar retorno ────────
    const [itemExecutado] = await tx
      .insert(itemPlano)
      .values({ planoId: plano!.id, procedimentoId: proc.id, valor: '150.00', status: 'executado' })
      .returning({ id: itemPlano.id })
    const [exec] = await tx
      .insert(execucao)
      .values({
        itemPlanoId: itemExecutado!.id,
        profissionalId: prof!.id,
        executadoEm: sql`now() - interval '7 months'`,
      })
      .returning({ id: execucao.id })

    // ── Faltou e não remarcou: DEVE gerar ────────────────────────────────────
    const [faltou] = await tx
      .insert(agendamento)
      .values({
        pacienteId: pa!.id,
        profissionalId: prof!.id,
        cadeiraId: cad!.id,
        inicio: sql`now() - interval '3 days'`,
        fim: sql`now() - interval '3 days' + interval '30 minutes'`,
        status: 'faltou',
      })
      .returning({ id: agendamento.id })

    // ── Paciente B faltou E REMARCOU: NÃO deve gerar ─────────────────────────
    await tx.insert(agendamento).values({
      pacienteId: pb!.id,
      profissionalId: prof!.id,
      cadeiraId: cad!.id,
      inicio: sql`now() - interval '4 days'`,
      fim: sql`now() - interval '4 days' + interval '30 minutes'`,
      status: 'faltou',
    })
    await tx.insert(agendamento).values({
      pacienteId: pb!.id,
      profissionalId: prof!.id,
      cadeiraId: cad!.id,
      inicio: sql`now() + interval '5 days'`,
      fim: sql`now() + interval '5 days' + interval '30 minutes'`,
      status: 'agendado',
    })

    return {
      ator: {
        usuarioId: u!.id,
        nome: `${MARCA} Dra. Fila`,
        email: 'rel@demo.local',
        perfil: 'dentista',
        profissionalId: prof!.id,
        clinicaId: u!.clinicaId,
      },
      pacienteA: pa!.id,
      pacienteB: pb!.id,
      orcamentoId: orcId,
      parcelaId: par!.id,
      itemAprovadoId: itemAprovado!.id,
      agendamentoFaltouId: faltou!.id,
      execucaoId: exec!.id,
    }
  })
}

async function main(): Promise<void> {
  console.log('\n═══ Fase 18: filas de relacionamento, contra o Postgres ═══')

  const f = await montar()

  // ── 1. Cada gerador encontra o que deve ───────────────────────────────────
  titulo('1. Os cinco geradores encontram exatamente o que deviam')

  const orcResultado = await gerarOrcamentoSemResposta()
  conferirIgual(orcResultado.criadas, 1, 'orçamento parado há 10 dias gerou 1 tarefa')

  const inadResultado = await gerarInadimplencia()
  conferirIgual(inadResultado.criadas, 1, 'parcela vencida há 5 dias gerou 1 tarefa')

  const aprResultado = await gerarAprovadoNaoExecutado()
  conferirIgual(aprResultado.criadas, 1, 'item aprovado há 40 dias gerou 1 tarefa')

  const faltaResultado = await gerarFaltaSemRemarcar()
  conferirIgual(faltaResultado.criadas, 1, 'faltou e não remarcou gerou 1 tarefa')

  const retResultado = await gerarRetornoProgramado()
  conferirIgual(retResultado.criadas, 1, 'execução de 7 meses com regra de 6 gerou 1 tarefa')

  // ── 2. E ignora o que deve ignorar ────────────────────────────────────────
  titulo('2. O que NÃO deve entrar na fila')

  const doPacienteB = await db
    .select({ tipo: tarefaRelacionamento.tipo })
    .from(tarefaRelacionamento)
    .where(eq(tarefaRelacionamento.pacienteId, f.pacienteB))
  conferirIgual(
    doPacienteB.length,
    0,
    'paciente B não entrou: orçamento de ontem (dentro dos 7 dias) e falta JÁ REMARCADA',
  )

  // ── 3. Idempotência: a segunda passada não cria nada ──────────────────────
  titulo('3. Rodar de novo não duplica')

  const segunda = await gerarTodasAsTarefas()
  const totalSegunda = segunda.reduce((s, g) => s + g.criadas, 0)
  conferirIgual(totalSegunda, 0, 'segunda passada dos cinco geradores criou 0 tarefas')

  const total = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tarefaRelacionamento)
    .where(eq(tarefaRelacionamento.pacienteId, f.pacienteA))
  conferirIgual(total[0]?.n, 5, 'o paciente A tem exatamente 5 tarefas, uma por fila')

  // A chave que o SQL montou é a mesma que o domínio monta?
  const chaveNoBanco = await db
    .select({ chave: tarefaRelacionamento.chaveIdempotencia })
    .from(tarefaRelacionamento)
    .where(eq(tarefaRelacionamento.orcamentoId, f.orcamentoId))
  conferirIgual(
    chaveNoBanco[0]?.chave,
    chaveDaTarefa('orcamento_sem_resposta', f.orcamentoId),
    'a chave gravada pelo SQL é idêntica à que `chaveDaTarefa` monta em TypeScript',
  )

  // ── 4. A prova que dá sentido à fase: DISPENSADA NÃO REABRE ───────────────
  titulo('4. Dispensada NÃO reabre — e o gerador ingênuo reabriria')

  const [tarefaOrc] = await db
    .select({ id: tarefaRelacionamento.id })
    .from(tarefaRelacionamento)
    .where(eq(tarefaRelacionamento.orcamentoId, f.orcamentoId))

  const disp = await dispensarTarefaComAtor(f.ator, {
    tarefaId: tarefaOrc!.id,
    motivo: 'Paciente disse que vai fazer em outro lugar.',
  })
  conferir(disp.ok, `dispensada: "${disp.mensagem}"`)

  const depoisDaDispensa = await gerarOrcamentoSemResposta()
  conferirIgual(depoisDaDispensa.criadas, 0, 'o gerador NÃO recriou a tarefa dispensada')

  const aindaUma = await db
    .select({ n: sql<number>`count(*)::int`, situacao: tarefaRelacionamento.situacao })
    .from(tarefaRelacionamento)
    .where(eq(tarefaRelacionamento.orcamentoId, f.orcamentoId))
    .groupBy(tarefaRelacionamento.situacao)
  conferirIgual(aindaUma[0]?.n, 1, 'continua existindo UMA tarefa para aquele orçamento')
  conferirIgual(aindaUma[0]?.situacao, 'dispensada', 'e ela continua dispensada')

  /**
   * A contraprova, medida em SQL: o gerador que filtrasse por `situacao` acharia a
   * linha para reinserir. Sem este número, "não recriou" poderia ser porque não
   * havia nada elegível — e eu teria assinado a garantia sem tê-la medido.
   */
  const ingenuoResultado = await db.execute<{ recriaria: number }>(sql`
    select count(*)::int as recriaria
      from orcamento o
     where o.id = ${f.orcamentoId}
       and o.status = 'enviado'
       and not exists (
         select 1 from tarefa_relacionamento t
          where t.orcamento_id = o.id and t.situacao in ('aberta', 'em_andamento')
       )
  `)
  // `db.execute` devolve o `QueryResult` do `pg`, não um array — as linhas estão em
  // `.rows`. Desestruturar direto dá "(intermediate value) is not iterable".
  const ingenuo = (ingenuoResultado as unknown as { rows: { recriaria: number }[] }).rows[0]
  conferirIgual(
    Number(ingenuo?.recriaria),
    1,
    'CONTRAPROVA: o gerador ingênuo ("existe tarefa aberta?") recriaria 1 — a chave é o que impede',
  )

  // ── 5. Não incomodar: o opt-out silencia TODAS as filas ───────────────────
  titulo('5. `nao_contatar_ate` silencia todas as filas, não só uma')

  const [tarefaFalta] = await db
    .select({ id: tarefaRelacionamento.id })
    .from(tarefaRelacionamento)
    .where(eq(tarefaRelacionamento.agendamentoId, f.agendamentoFaltouId))

  await dispensarTarefaComAtor(f.ator, {
    tarefaId: tarefaFalta!.id,
    motivo: 'Paciente pediu para não receber ligações por três meses.',
    naoContatarAte: '2099-12-31',
  })

  // Apaga as tarefas do paciente A para provar que NENHUMA volta enquanto o
  // opt-out vale. Sem apagar, a chave sozinha explicaria o zero.
  await db
    .delete(contatoRelacionamento)
    .where(
      inArray(
        contatoRelacionamento.tarefaId,
        db
          .select({ id: tarefaRelacionamento.id })
          .from(tarefaRelacionamento)
          .where(eq(tarefaRelacionamento.pacienteId, f.pacienteA)),
      ),
    )
  await db.delete(tarefaRelacionamento).where(eq(tarefaRelacionamento.pacienteId, f.pacienteA))

  const comOptOut = await gerarTodasAsTarefas()
  conferirIgual(
    comOptOut.reduce((s, g) => s + g.criadas, 0),
    0,
    'com o opt-out em vigor, os CINCO geradores criam 0 — mesmo com as tarefas apagadas',
  )

  // Contraprova: sem o opt-out, os mesmos fatos voltam a gerar.
  await db
    .update(paciente)
    .set({ naoContatarAte: null, naoContatarMotivo: null })
    .where(eq(paciente.id, f.pacienteA))
  const semOptOut = await gerarTodasAsTarefas()
  conferirIgual(
    semOptOut.reduce((s, g) => s + g.criadas, 0),
    5,
    'CONTRAPROVA: retirado o opt-out, os mesmos fatos geram as 5 de volta',
  )

  // ── 6. Trabalhar a fila ───────────────────────────────────────────────────
  titulo('6. A fila é trabalhável, e o resultado do contato decide o resto')

  const fila = await filaDeRelacionamento()
  const doA = fila.filter((l) => l.pacienteId === f.pacienteA)
  conferirIgual(doA.length, 5, 'a fila mostra as 5 tarefas do paciente A')
  conferir(
    doA.every((l) => l.detalhe.length > 0),
    'toda linha tem contexto para a recepção ler antes de ligar',
  )
  conferir(
    doA.every((l) => l.tentativas === 0),
    'nenhuma tentativa ainda — a contagem vem do log, não de contador',
  )

  const [alvo] = doA
  const c1 = await registrarContatoComAtor(f.ator, {
    tarefaId: alvo!.id,
    canal: 'telefone',
    resultado: 'nao_atendeu',
  })
  conferir(c1.ok, `"não atendeu" registrado: ${c1.mensagem}`)

  const filaDepois = await filaDeRelacionamento()
  const alvoDepois = filaDepois.find((l) => l.id === alvo!.id)
  conferirIgual(alvoDepois?.tentativas, 1, 'a tentativa apareceu na fila')
  conferirIgual(alvoDepois?.situacao, 'em_andamento', '"não atendeu" mantém a tarefa em andamento')

  const c2 = await registrarContatoComAtor(f.ator, {
    tarefaId: alvo!.id,
    canal: 'telefone',
    resultado: 'remarcou',
  })
  conferir(c2.ok, `"remarcou" resolveu sozinho: ${c2.mensagem}`)
  const [resolvida] = await db
    .select({ situacao: tarefaRelacionamento.situacao })
    .from(tarefaRelacionamento)
    .where(eq(tarefaRelacionamento.id, alvo!.id))
  conferirIgual(resolvida?.situacao, 'resolvida', 'sem segundo clique — o resultado já decidiu')

  const c3 = await registrarContatoComAtor(f.ator, {
    tarefaId: alvo!.id,
    canal: 'telefone',
    resultado: 'falou',
  })
  conferir(
    c3.ok,
    'contato ainda é ACEITO numa tarefa resolvida — registrar fato não é reabrir',
  )
  const [continuaResolvida] = await db
    .select({ situacao: tarefaRelacionamento.situacao })
    .from(tarefaRelacionamento)
    .where(eq(tarefaRelacionamento.id, alvo!.id))
  conferirIgual(continuaResolvida?.situacao, 'resolvida', 'e ela NÃO voltou para em andamento')

  const semMotivo = await dispensarTarefaComAtor(f.ator, { tarefaId: alvo!.id, motivo: '  ' })
  conferir(!semMotivo.ok, `dispensar sem motivo recusado: "${semMotivo.mensagem}"`)

  // ── 7. Resumo e indicadores, com número calculado à mão ───────────────────
  titulo('7. Resumo e indicadores')

  const resumo = await resumoDaFila()
  const somaAbertas = resumo.reduce((s, r) => s + r.abertas, 0)
  const abertasNoBanco = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tarefaRelacionamento)
    .where(inArray(tarefaRelacionamento.situacao, ['aberta', 'em_andamento']))
  conferirIgual(somaAbertas, abertasNoBanco[0]?.n, 'o resumo soma exatamente as tarefas abertas')

  // Conversão: 10 enviados, 4 aprovados, 2 recusados, 2 expirados, 2 em aberto.
  // À mão: 4/10 = 40%; decididos = 8, 4/8 = 50%.
  const conv = conversaoDeOrcamento({
    enviados: 10,
    aprovados: 4,
    recusados: 2,
    expirados: 2,
    emAberto: 2,
  })
  conferirIgual([conv.taxa, conv.taxaDecidida], [40, 50], 'conversão: 4/10 = 40% e 4/8 = 50%')

  const semBase = conversaoDeOrcamento({
    enviados: 0,
    aprovados: 0,
    recusados: 0,
    expirados: 0,
    emAberto: 0,
  })
  conferirIgual(
    [semBase.taxa, semBase.taxaDecidida],
    [null, null],
    'mês sem orçamento enviado não tem taxa de 0% — não tem taxa',
  )

  // Recuperação: 10 criadas, 3 resolvidas, 2 dispensadas → 30% e 3/5 = 60%.
  const rec = recuperacaoDaFila({ criadas: 10, resolvidas: 3, dispensadas: 2, pendentes: 5 })
  conferirIgual([rec.taxa, rec.taxaTrabalhada], [30, 60], 'recuperação: 3/10 = 30% e 3/5 = 60%')

  /**
   * E os mesmos indicadores lendo o BANCO, conferidos contra contagem própria.
   *
   * As duas asserções acima provam a aritmética; esta prova que a consulta conta as
   * linhas certas. São coisas diferentes, e a segunda é a que quebra quando alguém
   * mexe num `filter (where …)`.
   */
  const hojeIso = (await db.execute<{ d: string }>(sql`select to_char(hoje_na_clinica(), 'YYYY-MM-DD') as d`)) as unknown as { rows: { d: string }[] }
  const dia = hojeIso.rows[0]!.d
  const periodo = { de: dia, ate: dia, tipo: 'livre' as const, rotulo: dia }

  const recBanco = await recuperacaoNoPeriodo(periodo)
  const criadasNoBanco = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tarefaRelacionamento)
    .where(sql`("tarefa_relacionamento"."criado_em" at time zone 'UTC')::date = ${dia}::date`)
  conferirIgual(
    recBanco.reduce((s, r) => s + r.indicador.criadas, 0),
    Number(criadasNoBanco[0]?.n),
    'recuperação lida do banco soma exatamente as tarefas criadas hoje',
  )

  const convBanco = await conversaoNoPeriodo(periodo)
  const enviadosNoBanco = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orcamento)
    .where(
      sql`"orcamento"."enviado_em" is not null
          and ("orcamento"."enviado_em" at time zone 'UTC')::date = ${dia}::date
          and "orcamento"."status" <> 'rascunho'`,
    )
  conferirIgual(
    convBanco.enviados,
    Number(enviadosNoBanco[0]?.n),
    'conversão lida do banco conta exatamente os orçamentos enviados hoje',
  )

  // ── Limpeza ───────────────────────────────────────────────────────────────
  await limpar()
  console.log('\nDados da demonstração removidos.')

  console.log('\n\x1b[32m═══ Fase 18 verificada contra o Postgres ═══\x1b[0m\n')
  console.log('O que ficou provado, e não só executado:')
  console.log('  • os cinco geradores encontram o que devem e ignoram o resto')
  console.log('  • a segunda passada cria zero — idempotência por CHAVE, não por consulta')
  console.log('  • tarefa DISPENSADA não volta, e o gerador ingênuo a recriaria (medido)')
  console.log('  • o opt-out do paciente silencia as CINCO filas, não só a que o originou')
  console.log('  • o resultado do contato decide sozinho: "remarcou" resolve, "não quer" dispensa')
  console.log('  • registrar contato numa tarefa fechada é aceito e NÃO a reabre')
  console.log('  • taxa sem base é "—", nunca 0%')
}

/**
 * Limpeza.
 *
 * `DISABLE TRIGGER USER` por tabela e **nunca** `session_replication_role =
 * 'replica'`: o atalho desliga também as triggers de FK, e foi assim que 5
 * movimentos de estoque órfãos entraram no banco de desenvolvimento e derrubaram
 * uma migration. `lib/demo/triggers.ts` religa antes do commit **e confere**.
 */
async function limpar(): Promise<void> {
  const like = `${MARCA}%`
  /**
   * Cliente cru do pool, e não `db.transaction`: os helpers de trigger recebem uma
   * conexão `pg` (é `ALTER TABLE`, não consulta do ORM), e é assim que os outros
   * `demonstrar.ts` fazem. O contexto de clínica vem da acquisição do pool
   * (`lib/db/index.ts`), então a RLS continua valendo aqui.
   */
  const c = await db.$client.connect()
  try {
    await c.query('begin')
    const desligadas = await desligarTriggersDeAplicacao(c)

    const doPaciente = 'select id from paciente where nome like $1'
    await c.query(
      `delete from contato_relacionamento where tarefa_id in (
         select id from tarefa_relacionamento where paciente_id in (${doPaciente}))`,
      [like],
    )
    await c.query(`delete from tarefa_relacionamento where paciente_id in (${doPaciente})`, [like])
    await c.query(`delete from audit_log where paciente_id in (${doPaciente})`, [like])
    await c.query(
      `delete from execucao where item_plano_id in (
         select ip.id from item_plano ip join plano_tratamento p on p.id = ip.plano_id
          where p.paciente_id in (${doPaciente}))`,
      [like],
    )
    await c.query(
      `delete from item_plano where plano_id in (
         select id from plano_tratamento where paciente_id in (${doPaciente}))`,
      [like],
    )
    await c.query(`delete from plano_tratamento where paciente_id in (${doPaciente})`, [like])
    await c.query(
      `delete from parcela where cobranca_id in (
         select id from cobranca where paciente_id in (${doPaciente}))`,
      [like],
    )
    await c.query(`delete from cobranca where paciente_id in (${doPaciente})`, [like])
    await c.query(
      `delete from orcamento_item where orcamento_id in (
         select id from orcamento where paciente_id in (${doPaciente}))`,
      [like],
    )
    await c.query(`delete from orcamento where paciente_id in (${doPaciente})`, [like])
    await c.query(`delete from agendamento where paciente_id in (${doPaciente})`, [like])
    /**
     * `documento` também: a limpeza precisa dar conta de TODA filha, e esta apareceu
     * de surpresa — um `orcamento_pdf` gravado para o paciente da demonstração por
     * outro script rodando no mesmo banco. Cleanup incompleto deixa o banco de
     * desenvolvimento num estado que a próxima execução não consegue limpar, e foi
     * assim que 5 movimentos órfãos derrubaram uma migration neste projeto.
     */
    await c.query(`delete from documento where paciente_id in (${doPaciente})`, [like])
    await c.query('delete from paciente where nome like $1', [like])
    await c.query(
      'delete from profissional where usuario_id in (select id from usuario where nome like $1)',
      [like],
    )
    await c.query('delete from usuario where nome like $1', [like])
    await c.query('delete from cadeira where nome like $1', [like])

    // ANTES do commit, sempre: `DISABLE TRIGGER` é DDL, e comitar desligada a deixa
    // desligada para sempre. `religar` confere que religou.
    await religarTriggersDeAplicacao(c, desligadas)
    await c.query('commit')
  } catch (e) {
    await c.query('rollback')
    throw e
  } finally {
    c.release()
  }
}

clinicaParaScript()
  .then((clinicaId) => comContextoDeClinica(clinicaId, main))
  .then(async () => {
    await pool.end()
    if (falhas > 0) console.log(`\x1b[31m${falhas} falha(s).\x1b[0m`)
    process.exit(falhas > 0 ? 1 : 0)
  })
  .catch(async (e) => {
    console.error('\nFalha:', e instanceof Error ? e.message : e)
    if (e instanceof Error && 'cause' in e) console.error('causa:', (e as { cause?: unknown }).cause)
    await pool.end()
    process.exit(1)
  })
