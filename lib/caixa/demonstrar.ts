import { gerarHashSenha } from '@/lib/auth/senha'
import type { Ator } from '@/lib/authz/sessao'
import { db, pool } from '@/lib/db'
import {
  categoriaDespesa,
  cobranca,
  despesa,
  eventoPix,
  intencaoPix,
  pagamento,
  pagamentoDespesa,
  paciente,
  parcela,
  profissional,
  regraDespesaRecorrente,
  taxaMeioPagamento,
  usuario,
} from '@/lib/db/schema'
import { clinicaParaScript } from '@/lib/demo/clinicaDaDemo'
import { comContextoDeClinica } from '@/lib/tenant/contexto'
import { desligarTriggersDeAplicacao, religarTriggersDeAplicacao } from '@/lib/demo/triggers'
import { subtrair } from '@/lib/domain/dinheiro'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  cancelarDespesaComAtor,
  lancarDespesaComAtor,
  materializarRecorrentes,
  pagarDespesaComAtor,
} from './despesas'
import { despesasPorCompetencia, fluxoDeCaixaDoPeriodo, contasAPagar } from './consultas'
import { conciliarLiquidacao, emitirCobrancaPix } from './pix/conciliar'
import { ProvedorPixSimulado } from './pix/simulado'

/**
 * Fase 20 ponta a ponta, contra o Postgres. **Confere número, não fluxo.**
 *
 *   npm run caixa:demo
 *
 * ── O caso que dá sentido a tudo ────────────────────────────────────────────
 * Uma despesa de **julho** paga em **agosto**. Ela aparece em julho na competência e em
 * agosto no caixa, e os dois números são calculados à mão aqui. Se algum dia alguém
 * "simplificar" os dois regimes num só, este é o caso que reprova.
 */

const MARCA = `CX-${Date.now()}`
const SENHA = 'Caixa-Demo-2026'

let falhas = 0
function conferir(ok: boolean, texto: string): void {
  if (ok) console.log(`   \x1b[32m✓\x1b[0m ${texto}`)
  else {
    console.log(`   \x1b[31m✗ ${texto}\x1b[0m`)
    falhas++
  }
}
function titulo(t: string): void {
  console.log(`\n\x1b[36m${t}\x1b[0m`)
}

interface Fixture {
  readonly ator: Ator
  readonly usuarioId: string
  readonly profissionalId: string
  readonly pacienteId: string
  readonly parcelaId: string
  readonly cobrancaId: string
  readonly categoriaFixaId: string
  readonly categoriaVariavelId: string
}

async function montarFixture(): Promise<Fixture> {
  const { u, profissionalId } = await db.transaction(async (tx) => {
    // As duas linhas na MESMA transação: a trava deferida da `0021` cobra no commit que
    // dentista ativo tenha cadastro de profissional.
    const [novo] = await tx
      .insert(usuario)
      .values({
        nome: `Financeiro ${MARCA}`,
        email: `caixa-${MARCA}@demo.local`,
        senhaHash: await gerarHashSenha(SENHA),
        perfil: 'dentista',
        mfaAtivo: false,
      })
      .returning({ id: usuario.id, clinicaId: usuario.clinicaId })
    const [p] = await tx
      .insert(profissional)
      .values({ usuarioId: novo!.id, cro: MARCA.slice(-6), ufCro: 'SP' })
      .returning({ id: profissional.id })
    return { u: novo!, profissionalId: p!.id }
  })

  const [pac] = await db
    .insert(paciente)
    .values({ nome: `Paciente ${MARCA}`, dataNascimento: '1990-01-01' })
    .returning({ id: paciente.id })

  const { cobrancaId, parcelaId } = await db.transaction(async (tx) => {
    const [cob] = await tx
      .insert(cobranca)
      .values({ pacienteId: pac!.id, valorTotal: '500.00', forma: 'pix' })
      .returning({ id: cobranca.id })
    const [par] = await tx
      .insert(parcela)
      .values({
        cobrancaId: cob!.id,
        numero: 1,
        vencimento: sql`hoje_na_clinica()`,
        valor: '500.00',
        status: 'aberta',
      })
      .returning({ id: parcela.id })
    return { cobrancaId: cob!.id, parcelaId: par!.id }
  })

  // Categorias: as do seed desta clínica. Filtro explícito por clínica porque este
  // script roda como DONO, onde não há política de RLS filtrando por ninguém.
  const cats = await db
    .select({ id: categoriaDespesa.id, nome: categoriaDespesa.nome, natureza: categoriaDespesa.natureza })
    .from(categoriaDespesa)
    .where(
      and(
        eq(categoriaDespesa.clinicaId, sql`app_clinica_id()`),
        inArray(categoriaDespesa.nome, ['Aluguel e condomínio', 'Laboratório de prótese']),
      ),
    )
  const fixa = cats.find((c) => c.natureza === 'fixa')
  const variavel = cats.find((c) => c.natureza === 'variavel')
  if (!fixa || !variavel) {
    throw new Error(
      'Categorias do seed não encontradas nesta clínica. A drizzle/0034 as cria — rode as migrations.',
    )
  }

  return {
    ator: {
      usuarioId: u.id,
      clinicaId: u.clinicaId,
      nome: `Financeiro ${MARCA}`,
      email: `caixa-${MARCA}@demo.local`,
      perfil: 'dentista',
      profissionalId,
    },
    usuarioId: u.id,
    profissionalId,
    pacienteId: pac!.id,
    parcelaId,
    cobrancaId,
    categoriaFixaId: fixa.id,
    categoriaVariavelId: variavel.id,
  }
}

/**
 * Remove o que a demonstração criou.
 *
 * ── Por que precisa desligar triggers ──────────────────────────────────────
 * `pagamento` é append-only por trigger (`pagamento_nao_exclui`): a correção de um
 * lançamento errado é **estorno com motivo**, não `DELETE`. Está certo, e é justamente
 * por isso que dado de demonstração precisa do helper — que desliga por tabela com
 * `DISABLE TRIGGER USER` (nunca `session_replication_role`, que derruba também as
 * triggers de FK) e **religa conferindo**, porque `DISABLE TRIGGER` é DDL e comitar
 * desligada a deixa desligada para sempre.
 *
 * Parcela e cobrança saem na mesma transação: `verifica_soma_parcelas` é DEFERIDA e
 * cobra no commit que a soma das parcelas seja o total da cobrança. Apagar a parcela
 * sozinha comita um estado em que a cobrança de R$ 500 tem R$ 0 em parcelas, e a trava
 * dispara com uma mensagem que parece bug do financeiro. Mesma lição do fixture de
 * dentista, do outro lado.
 */
async function limpar(f: Fixture): Promise<void> {
  const like = `%${MARCA}%`
  const c = await db.$client.connect()
  try {
    await c.query('begin')
    const desligadas = await desligarTriggersDeAplicacao(c)

    await c.query(
      `delete from pagamento_despesa where despesa_id in (
         select id from despesa where descricao like $1)`,
      [like],
    )
    await c.query('delete from despesa where descricao like $1', [like])
    await c.query('delete from regra_despesa_recorrente where descricao like $1', [like])
    await c.query('delete from taxa_meio_pagamento where observacao = $1', [MARCA])
    await c.query(
      'delete from evento_pix where txid in (select txid from intencao_pix where parcela_id = $1) or txid like $2',
      [f.parcelaId, like],
    )
    await c.query('delete from intencao_pix where parcela_id = $1', [f.parcelaId])
    await c.query('delete from pagamento where parcela_id = $1', [f.parcelaId])
    await c.query('delete from parcela where cobranca_id = $1', [f.cobrancaId])
    await c.query('delete from cobranca where id = $1', [f.cobrancaId])
    await c.query('delete from audit_log where paciente_id = $1', [f.pacienteId])
    await c.query('delete from paciente where id = $1', [f.pacienteId])
    await c.query('delete from profissional where id = $1', [f.profissionalId])
    await c.query('delete from usuario where id = $1', [f.usuarioId])

    await religarTriggersDeAplicacao(c, desligadas)
    await c.query('commit')
  } catch (e) {
    await c.query('rollback')
    throw e
  } finally {
    c.release()
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('caixa:demo cria pessoas e lançamentos fictícios. Não roda em produção.')
  }
  console.log('\n═══ Fase 20: fechamento financeiro, contra o Postgres ═══')

  /**
   * Linha de base ANTES de qualquer lançamento.
   *
   * As asserções medem **diferença**, não valor absoluto. A primeira versão comparava o
   * total da clínica com um número calculado à mão, e passou — até sobrar dado de uma
   * execução anterior: setembro mediu 700,00 onde a fixture põe 350,00, e a falha
   * apontava para a taxa de MDR em vez de para o dado velho.
   *
   * Um teste cujo número depende do que mais existe na clínica é um teste que vai falhar
   * pelo motivo errado — e "pelo motivo errado" já é a forma mais frequente de erro
   * neste projeto.
   */
  const base = {
    compJulho: (await despesasPorCompetencia({ de: '2026-07-01', ate: '2026-07-31' })).total,
    caixaJulho: (await fluxoDeCaixaDoPeriodo({ de: '2026-07-01', ate: '2026-07-31' })).saidas,
    caixaAgosto: (await fluxoDeCaixaDoPeriodo({ de: '2026-08-01', ate: '2026-08-31' })).saidas,
    setembroBruto: (await fluxoDeCaixaDoPeriodo({ de: '2026-09-01', ate: '2026-09-30' }))
      .entradasBrutas,
    setembroTaxa: (await fluxoDeCaixaDoPeriodo({ de: '2026-09-01', ate: '2026-09-30' })).taxas,
  }

  const f = await montarFixture()
  try {
    // ── 1. Os dois regimes, com número calculado à mão ──────────────────────
    titulo('1. Competência × caixa — a despesa de julho paga em agosto')

    const julho = await lancarDespesaComAtor(f.ator, {
      categoriaId: f.categoriaFixaId,
      descricao: `Aluguel de julho ${MARCA}`,
      valor: '3200.00',
      competencia: '2026-07-01',
      vencimento: '2026-07-10',
    })
    conferir(julho.ok, julho.mensagem)

    const lab = await lancarDespesaComAtor(f.ator, {
      categoriaId: f.categoriaVariavelId,
      descricao: `Prótese do Sr. Bruno ${MARCA}`,
      valor: '850.00',
      competencia: '2026-07-01',
      vencimento: '2026-07-20',
    })
    conferir(lab.ok, lab.mensagem)

    // O aluguel sai do banco em AGOSTO; o laboratório em JULHO.
    const pagoEmAgosto = await pagarDespesaComAtor(f.ator, {
      despesaId: julho.ok ? julho.id! : '',
      valor: '3200.00',
      pagoEm: '2026-08-05',
      meio: 'transferencia',
    })
    conferir(pagoEmAgosto.ok, pagoEmAgosto.mensagem)

    const pagoEmJulho = await pagarDespesaComAtor(f.ator, {
      despesaId: lab.ok ? lab.id! : '',
      valor: '850.00',
      pagoEm: '2026-07-22',
      meio: 'pix',
    })
    conferir(pagoEmJulho.ok, pagoEmJulho.mensagem)

    const compJulho = await despesasPorCompetencia({ de: '2026-07-01', ate: '2026-07-31' })
    // 3200 + 850 = 4050 — a conta feita à mão, medida como DIFERENÇA sobre a base.
    const deltaComp = subtrair(compJulho.total, base.compJulho)
    conferir(
      deltaComp === '4050.00',
      `julho CUSTOU +4050,00 → ${deltaComp} (aluguel 3200 + laboratório 850)`,
    )

    const caixaJulho = await fluxoDeCaixaDoPeriodo({ de: '2026-07-01', ate: '2026-07-31' })
    const caixaAgosto = await fluxoDeCaixaDoPeriodo({ de: '2026-08-01', ate: '2026-08-31' })
    const deltaCaixaJulho = subtrair(caixaJulho.saidas, base.caixaJulho)
    const deltaCaixaAgosto = subtrair(caixaAgosto.saidas, base.caixaAgosto)
    conferir(
      deltaCaixaJulho === '850.00',
      `saiu do banco em julho: +850,00 → ${deltaCaixaJulho} (só o laboratório)`,
    )
    conferir(
      deltaCaixaAgosto === '3200.00',
      `saiu do banco em agosto: +3200,00 → ${deltaCaixaAgosto} (o aluguel DE JULHO)`,
    )
    conferir(
      deltaComp !== deltaCaixaJulho,
      `os dois regimes DIFEREM: competência +4050,00 ≠ caixa +850,00 — se algum dia forem iguais aqui, alguém colapsou os dois`,
    )

    // ── 2. A soma dos pagamentos não passa do valor ─────────────────────────
    titulo('2. Pagamento não passa do valor da despesa')
    const excesso = await pagarDespesaComAtor(f.ator, {
      despesaId: lab.ok ? lab.id! : '',
      valor: '0.01',
      pagoEm: '2026-07-23',
      meio: 'pix',
    })
    conferir(!excesso.ok, `recusado: "${excesso.ok ? '' : excesso.mensagem}"`)

    // E a trava de verdade é no BANCO, não no `if` acima: `INSERT` direto também é
    // recusado. Sem isto, um script de importação futuro furaria a regra.
    let trigger = false
    try {
      await db.insert(pagamentoDespesa).values({
        despesaId: lab.ok ? lab.id! : '',
        valor: '0.01',
        pagoEm: '2026-07-23',
        meio: 'pix',
      })
    } catch {
      trigger = true
    }
    conferir(trigger, 'e o INSERT direto no banco também é recusado — a trava é trigger, não `if`')

    // ── 3. Cancelar despesa paga é recusado ────────────────────────────────
    titulo('3. Despesa com pagamento não se cancela')
    const cancelar = await cancelarDespesaComAtor(f.ator, lab.ok ? lab.id! : '', 'teste')
    conferir(
      !cancelar.ok,
      `recusado: "${cancelar.ok ? '' : cancelar.mensagem}" — cancelar deixaria a saída de caixa sem obrigação`,
    )

    // ── 4. Taxa do meio de pagamento, com a conta à mão ────────────────────
    titulo('4. MDR: bruto, taxa e líquido')
    await db.insert(taxaMeioPagamento).values({
      meio: 'credito',
      percentual: '2.49',
      valorFixo: '0.00',
      vigenciaInicio: '2026-01-01',
      observacao: MARCA,
    })
    const [parcelaCredito] = await db
      .insert(pagamento)
      .values({
        parcelaId: f.parcelaId,
        valor: '350.00',
        pagoEm: '2026-09-10',
        meio: 'credito',
        conciliado: false,
      })
      .returning({ id: pagamento.id })

    const setembro = await fluxoDeCaixaDoPeriodo({ de: '2026-09-01', ate: '2026-09-30' })
    // 2,49% de 350,00 = 8,715 → 8,72. Líquido 341,28.
    const deltaBruto = subtrair(setembro.entradasBrutas, base.setembroBruto)
    const deltaTaxa = subtrair(setembro.taxas, base.setembroTaxa)
    conferir(deltaBruto === '350.00', `bruto +350,00 → ${deltaBruto}`)
    conferir(deltaTaxa === '8.72', `taxa 2,49% de 350,00 = 8,72 → ${deltaTaxa}`)
    conferir(
      subtrair(deltaBruto, deltaTaxa) === '341.28',
      `líquido 341,28 → ${subtrair(deltaBruto, deltaTaxa)} (é este que bate com o extrato)`,
    )
    /**
     * ESTORNO, não `DELETE`. `pagamento` é append-only por trigger, e a correção de um
     * lançamento é estorno com motivo — a tentativa de apagar aqui é o que fez esta
     * demonstração falhar na terceira execução, com a trava fazendo o trabalho dela.
     *
     * E de lambuja isto prova uma propriedade que ninguém tinha medido: estornado SAI
     * do fluxo de caixa.
     */
    await db
      .update(pagamento)
      .set({ estornadoEm: sql`now()`, motivoEstorno: `demonstração ${MARCA}` })
      .where(eq(pagamento.id, parcelaCredito!.id))

    const setembroApos = await fluxoDeCaixaDoPeriodo({ de: '2026-09-01', ate: '2026-09-30' })
    conferir(
      setembroApos.entradasBrutas === base.setembroBruto,
      `depois do estorno, setembro volta à base → ${setembroApos.entradasBrutas} (estornado não é caixa)`,
    )

    // ── 5. Recorrente: uma regra, N competências, idempotente ──────────────
    titulo('5. Recorrente materializa uma vez por competência')
    await db.insert(regraDespesaRecorrente).values({
      categoriaId: f.categoriaFixaId,
      descricao: `Software de gestão ${MARCA}`,
      valor: '199.00',
      diaVencimento: 10,
      inicioEm: '2026-05-01',
    })
    const primeira = await materializarRecorrentes()
    conferir(primeira.criadas >= 3, `materializou ${primeira.criadas} competência(s) (maio a hoje)`)

    const segunda = await materializarRecorrentes()
    conferir(
      segunda.criadas === 0,
      `rodar de novo cria 0 — a idempotência é o índice (recorrente_id, competencia), não uma verificação`,
    )

    // ── 6. Pix: conciliação por txid, e a reentrega não duplica ────────────
    titulo('6. Pix — conciliação idempotente')
    const provedor = new ProvedorPixSimulado()
    const emissao = await emitirCobrancaPix(f.parcelaId, provedor)
    conferir(emissao.ok, emissao.ok ? `cobrança emitida (txid ${emissao.txid.slice(0, 12)}…)` : emissao.mensagem)
    if (!emissao.ok) throw new Error('sem cobrança não há o que conciliar')

    const e2e = ProvedorPixSimulado.endToEndIdDeTeste()
    const notificacao = provedor.notificacaoDeTeste({ endToEndId: e2e, txid: emissao.txid, valor: '500.00' })

    const lida = provedor.lerNotificacao(notificacao.corpo, notificacao.cabecalhos)
    conferir(lida.valida, 'a assinatura da notificação confere')
    if (!lida.valida) throw new Error('notificação inválida')

    const r1 = await conciliarLiquidacao(lida.liquidacoes[0]!, JSON.parse(notificacao.corpo))
    conferir(r1.situacao === 'conciliado', `primeira entrega: ${r1.situacao}`)

    // A REENTREGA — mesmo endToEndId, que é o que o PSP manda quando não recebe 200.
    const r2 = await conciliarLiquidacao(lida.liquidacoes[0]!, JSON.parse(notificacao.corpo))
    conferir(r2.situacao === 'repetido', `reentrega: ${r2.situacao} — não moveu dinheiro`)

    const [contagemPag] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pagamento)
      .where(and(eq(pagamento.parcelaId, f.parcelaId), eq(pagamento.meio, 'pix')))
    const nPag = contagemPag?.n ?? -1
    conferir(nPag === 1, `e existe UM pagamento Pix na parcela, não dois → ${nPag}`)

    // Assinatura errada é recusada — o endpoint é público por necessidade.
    const forjada = provedor.lerNotificacao(notificacao.corpo, { 'x-pix-signature': 'a'.repeat(64) })
    conferir(!forjada.valida, `assinatura forjada recusada: "${forjada.valida ? '' : forjada.motivo}"`)

    // Liquidação sem cobrança fica visível, não é descartada.
    const orfa = await conciliarLiquidacao(
      {
        endToEndId: ProvedorPixSimulado.endToEndIdDeTeste('semdono0000'),
        txid: `naoexiste-${MARCA}`,
        valor: '10.00',
        liquidadoEm: new Date(),
      },
      { teste: true },
    )
    conferir(
      orfa.situacao === 'sem_cobranca',
      `Pix sem cobrança correspondente fica registrado como "${orfa.situacao}" — dinheiro sem dono é visível`,
    )

    // ── 7. CONTRAPROVA: sem o índice único, a reentrega duplicaria ─────────
    titulo('7. Contraprova — o que o índice único compra')
    const duplicou = await db.transaction(async (tx) => {
      await tx.execute(sql`drop index evento_pix_e2e_uk`)
      const e2eTeste = ProvedorPixSimulado.endToEndIdDeTeste('contrapr0va')
      for (let i = 0; i < 2; i++) {
        await tx.execute(sql`
          insert into evento_pix (clinica_id, end_to_end_id, txid, valor, liquidado_em, payload, motivo_nao_processado)
          values (app_clinica_id(), ${e2eTeste}, ${'t-' + MARCA}, '1.00', now(), '{}'::jsonb, 'contraprova')
        `)
      }
      const r = await tx.execute(sql`
        select count(*)::int as n from evento_pix where end_to_end_id = ${e2eTeste}
      `)
      const n = Number((r.rows[0] as { n: number }).n)
      // Desfaz TUDO, inclusive o DROP INDEX: DDL é transacional no Postgres.
      throw Object.assign(new Error('contraprova concluída'), { n })
    }).catch((e: Error & { n?: number }) => e.n ?? -1)

    conferir(
      duplicou === 2,
      `sem o índice, a mesma liquidação entrou ${duplicou}× — logo é o índice que impede, e não sorte`,
    )
    const [contagemIndice] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sql`pg_indexes`)
      .where(sql`indexname = 'evento_pix_e2e_uk'`)
    conferir(
      (contagemIndice?.n ?? 0) === 1,
      'e o índice voltou com o rollback — a contraprova não deixou o banco pior',
    )

    // ── 8. Contas a pagar ──────────────────────────────────────────────────
    titulo('8. Contas a pagar')
    const contas = await contasAPagar()
    const doMarca = contas.filter((c) => c.descricao.includes(MARCA))
    conferir(
      doMarca.length >= 3,
      `${doMarca.length} conta(s) em aberto desta demonstração (as recorrentes materializadas)`,
    )
    conferir(
      doMarca.every((c) => c.situacao !== 'paga'),
      'e nenhuma paga aparece na fila — quem já foi pago sai de vista',
    )
  } finally {
    /**
     * A limpeza NÃO pode mascarar o erro original.
     *
     * Um `throw` dentro de `finally` substitui a exceção que estava subindo — e foi
     * exactamente o que aconteceu na primeira execução: a falha da limpeza (trava
     * deferida da soma das parcelas) apagou o erro de verdade, e o relatório apontava
     * para o lugar errado.
     */
    try {
      await limpar(f)
      console.log('\nDados da demonstração removidos.')
    } catch (e) {
      console.error(
        `\n\x1b[31m⚠ A LIMPEZA falhou: ${e instanceof Error ? e.message : String(e)}\x1b[0m`,
      )
      console.error('  Os dados desta demonstração ficaram no banco (procure por ' + MARCA + ').')
      falhas++
    }
  }
}

clinicaParaScript()
  .then((clinicaId) => comContextoDeClinica(clinicaId, main))
  .then(async () => {
    await pool.end()
    console.log(
      falhas === 0
        ? '\n\x1b[32m═══ Fechamento financeiro verificado ═══\x1b[0m\n'
        : `\n\x1b[31m${falhas} falha(s).\x1b[0m\n`,
    )
    process.exit(falhas > 0 ? 1 : 0)
  })
  .catch(async (e) => {
    console.error(e)
    await pool.end()
    process.exit(1)
  })
