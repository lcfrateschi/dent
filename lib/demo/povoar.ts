import { db } from '@/lib/db'
import {
  autoclave,
  categoriaDespesa,
  cicloEsterilizacao,
  despesa,
  eventoPix,
  intencaoPix,
  agendamento,
  execucao,
  itemPlano,
  laboratorio,
  listaEspera,
  orcamento,
  orcamentoItem,
  ordemLaboratorio,
  paciente,
  pagamento,
  pagamentoDespesa,
  parcela,
  periograma,
  periogramaDente,
  periogramaSitio,
  planoTratamento,
  procedimento,
  regraAutoatendimento,
  regraDespesaRecorrente,
  taxaMeioPagamento,
} from '@/lib/db/schema'
import { seedCategoriasDespesa } from '@/lib/db/seed/categoriasDespesa'
import { addDias } from '@/lib/domain/datas'
import { instanteDe } from '@/lib/domain/fuso'
import { eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

/**
 * Povoa as telas das Fases 18 a 21, que o `demo:preparar` não conhecia.
 *
 * ── Por que isto é um módulo separado ───────────────────────────────────────
 * `preparar.ts` já tinha 812 linhas e nove seções escritas antes destas fases
 * existirem. Enfiar mais seis lá dentro tornaria impossível saber, ao ler, o que é
 * o consultório básico (equipe, pacientes, agenda, plano, financeiro, estoque) e o
 * que existe só para uma tela nova não abrir vazia.
 *
 * ── O que "povoar" significa aqui, e o que NÃO significa ────────────────────
 * Significa: cada tela abre com dado plausível, e os casos que a tela existe para
 * mostrar estão presentes — o ciclo com biológico positivo, a despesa paga em mês
 * diferente da competência, o periograma com piora e melhora no mesmo paciente.
 *
 * **Não significa dado clínico com aparência de verdade.** Um periograma de
 * demonstração é um conjunto de medidas plausíveis e é honesto; um laudo escrito
 * seria invenção com cara de diagnóstico. Então aqui há números, e onde há texto ele
 * diz que é demonstração.
 *
 * ── Os valores são DE PARTIDA, e vários são arbitrários ─────────────────────
 * As profundidades de sondagem, a mobilidade e a furca foram escolhidas para dar
 * forma à comparação entre exames — não vêm de caso real nem de literatura. Estão
 * dentro da faixa fisiológica e nada mais que isso. O mesmo vale para valores de
 * despesa e prazos de laboratório: ordem de grandeza de um consultório de duas
 * cadeiras. Está impresso na saída do script, para ninguém confundir demonstração
 * com referência.
 */

const MARCA = '[DEMO]'

/** O que o povoamento precisa saber do consultório já criado. */
export interface Referencias {
  readonly hoje: string
  readonly pacienteAnaId: string
  readonly pacienteBrunoId: string
  readonly pacientePedroId: string
  readonly profissionalId: string
  readonly usuarioDentistaId: string
  readonly usuarioFinanceiroId: string
  readonly planoDaAnaId: string
  readonly itemAprovadoId: string
  readonly cadeiraId: string
}

export interface ResultadoPovoamento {
  readonly linhas: Readonly<Record<string, number>>
  /** Avisos sobre o que ficou arbitrário — o script imprime. */
  readonly arbitrarios: readonly string[]
}

/**
 * O primeiro dia do mês, N meses atrás, como data civil.
 *
 * Datas do povoamento são relativas a hoje de propósito: um `demo:preparar` rodado
 * em janeiro e um rodado em julho têm de produzir a mesma forma de tela. Datas fixas
 * envelheceriam — "vencida há 5 dias" viraria "vencida há 8 meses", e a tela de
 * contas a pagar mudaria de assunto sozinha.
 */
function mesRelativo(hoje: string, meses: number, dia = 1): string {
  const [a, m] = hoje.split('-').map(Number)
  const total = (a as number) * 12 + ((m as number) - 1) + meses
  const ano = Math.floor(total / 12)
  const mes = (total % 12) + 1
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
}

export async function povoarFases18a21(ref: Referencias): Promise<ResultadoPovoamento> {
  const linhas: Record<string, number> = {}
  const arbitrarios: string[] = []
  const { hoje } = ref

  // ── Autoatendimento: a regra nasce LIGADA na demonstração ─────────────────
  /**
   * Em produção `ativo` nasce `false`, e há invariante que falha se alguém trocar o
   * default: uma clínica que atualiza o sistema não pode descobrir que a agenda dela
   * abriu para a internet.
   *
   * Aqui é o contrário do que se quer: com o recurso desligado, `/meu/agendar` mostra
   * um aviso e mais nada — e foi exatamente assim que quatro casos de IDOR da Fase 19
   * passaram vazios. Quem for avaliar a tela precisa vê-la funcionando.
   */
  await db
    .insert(regraAutoatendimento)
    .values({
      ativo: true,
      antecedenciaMinimaHoras: 24,
      antecedenciaMaximaDias: 60,
      maximoFuturosPorPaciente: 2,
      termoDeAtendimento:
        `${MARCA} Termo de ciência e concordância com o atendimento odontológico. ` +
        'Este texto é de DEMONSTRAÇÃO e não tem valor jurídico: existe para a tela de ' +
        'termos ter o que exibir e para o registro de aceite ter o que registrar. O termo ' +
        'de verdade é redigido pela clínica com apoio jurídico.',
      versaoTermo: 'demo-1',
    })
    .onConflictDoUpdate({
      target: regraAutoatendimento.clinicaId,
      set: { ativo: true, termoDeAtendimento: sql`excluded.termo_de_atendimento` },
    })
  linhas.regra_autoatendimento = 1

  // Procedimentos que o paciente pode marcar sozinho. Consulta e profilaxia, nunca
  // exodontia — e o filtro por clínica é obrigatório: um `update … where ativo` sem
  // ele marcou 440 procedimentos de TODAS as clínicas na Fase 19.
  const marcaveis = await db
    .update(procedimento)
    .set({ permiteAutoagendamento: true })
    .where(
      sql`${procedimento.clinicaId} = app_clinica_id()
          and ${procedimento.codigo} in ('CONS-001', 'CONS-002', 'PREV-001')`,
    )
    .returning({ id: procedimento.id })
  linhas.procedimento_marcavel = marcaveis.length

  // ── Lista de espera ───────────────────────────────────────────────────────
  const [procProfilaxia] = await db
    .select({ id: procedimento.id })
    .from(procedimento)
    .where(sql`${procedimento.clinicaId} = app_clinica_id() and ${procedimento.codigo} = 'PREV-001'`)
    .limit(1)

  await db.insert(listaEspera).values([
    {
      pacienteId: ref.pacienteBrunoId,
      procedimentoId: procProfilaxia?.id ?? null,
      turno: 'manha',
      validoAte: instanteDe(addDias(hoje, 45), '18:00'),
      observacao: `${MARCA} avisar se abrir vaga de manhã`,
    },
    {
      // Sem procedimento: é o caso "qualquer vaga mais cedo", que é o mais comum — e
      // era o que o índice único NÃO travava antes da 0033 (dois NULL não colidem).
      pacienteId: ref.pacientePedroId,
      procedimentoId: null,
      turno: 'qualquer',
      validoAte: instanteDe(addDias(hoje, 20), '18:00'),
      observacao: `${MARCA} aceita qualquer horário`,
    },
  ])
  linhas.lista_espera = 2

  // ── Periograma: dois exames, com piora E melhora ──────────────────────────
  /**
   * A comparação entre exames só vale algo se os dois discordarem em direções
   * diferentes. Um exame todo pior mostra "piorou" e não exercita nada; o interessante
   * é o dente cuja **sondagem melhorou e a inserção não**, porque a recessão avançou —
   * é a razão de o NIC existir, e é o número que a tela precisa saber mostrar.
   *
   * O NIC **não é inserido**: `nivel_insercao_mm` é coluna `GENERATED ALWAYS` e o
   * Postgres recusa escrita nela (`428C9`). Aqui isso é conveniência; no sistema é a
   * garantia de que ninguém digita o número derivado.
   */
  const exames: { id: string; quando: string }[] = [
    { id: randomUUID(), quando: mesRelativo(hoje, -6, 10) },
    { id: randomUUID(), quando: mesRelativo(hoje, -1, 8) },
  ]

  for (const e of exames) {
    await db.insert(periograma).values({
      id: e.id,
      pacienteId: ref.pacienteAnaId,
      profissionalId: ref.profissionalId,
      examinadoEm: instanteDe(e.quando, '09:30'),
      concluidoEm: instanteDe(e.quando, '09:52'),
      observacao: `${MARCA} exame de demonstração — medidas plausíveis, não caso real`,
    })
  }

  /**
   * Seis sítios por dente. Os nomes dependem da ARCADA: superior tem palatina,
   * inferior tem lingual — nunca as duas, que é irmão da regra de faces (incisivo tem
   * incisal, molar tem oclusal).
   */
  const sitiosDe = (fdi: number) =>
    fdi < 30
      ? (['mesio_vestibular', 'vestibular', 'disto_vestibular', 'mesio_palatina', 'palatina', 'disto_palatina'] as const)
      : (['mesio_vestibular', 'vestibular', 'disto_vestibular', 'mesio_lingual', 'lingual', 'disto_lingual'] as const)

  /**
   * Os dentes do exame, com a história que cada um conta.
   *
   * ⚠️ Os números são ARBITRÁRIOS: escolhidos para dar forma à comparação, dentro da
   * faixa fisiológica. Não vêm de caso real.
   */
  const historia: readonly {
    fdi: number
    /** [profundidade, recessão] no exame 1 e no exame 2. */
    antes: readonly [number, number]
    depois: readonly [number, number] | null
    mobilidade?: number
    furca?: number
    conta: string
  }[] = [
    { fdi: 16, antes: [5, 1], depois: [4, 2], mobilidade: 1, furca: 1, conta: 'sondagem melhora 1 mm e o NIC não muda: a recessão avançou' },
    { fdi: 36, antes: [6, 1], depois: [4, 1], mobilidade: 1, furca: 1, conta: 'melhora de verdade: 2 mm de sondagem, recessão estável' },
    { fdi: 21, antes: [2, 0], depois: [3, 1], conta: 'piora discreta num dente que estava saudável' },
    { fdi: 44, antes: [3, 0], depois: [3, 0], conta: 'estável — a tela precisa de linha sem variação' },
    {
      // EXTRAÍDO entre os exames: presente no primeiro, ausente no segundo.
      //
      // É o caso que a comparação ingênua lê como melhora espetacular — o pior sítio do
      // paciente desaparece da média e o número cai. A tela tem de dizer "perda dentária",
      // não "melhorou 40%", e sem esta linha no dado de demonstração ninguém consegue ver
      // se ela diz.
      fdi: 26,
      antes: [8, 3],
      depois: null,
      mobilidade: 3,
      furca: 3,
      conta: 'extraído entre os exames: some do exame 2 e não é melhora',
    },
  ]

  let sitios = 0
  for (const [i, exame] of exames.entries()) {
    for (const d of historia) {
      const medida = i === 0 ? d.antes : d.depois
      if (!medida) continue
      const [ps, rec] = medida
      await db.insert(periogramaDente).values({
        periogramaId: exame.id,
        denteFdi: d.fdi,
        mobilidade: d.mobilidade ?? 0,
        // Furca só existe em multirradicular — o CHECK do banco recusa o resto.
        furca: d.furca ?? null,
      })
      for (const [j, s] of sitiosDe(d.fdi).entries()) {
        // Variação de ±1 mm entre sítios do mesmo dente: um periograma real não é
        // uniforme, e uma tela com seis números iguais não mostra o que ela faz.
        const delta = j === 1 || j === 4 ? 0 : j % 2 === 0 ? 1 : -1
        await db.insert(periogramaSitio).values({
          periogramaId: exame.id,
          denteFdi: d.fdi,
          sitio: s,
          profundidadeSondagemMm: Math.max(1, ps + delta),
          recessaoMm: rec,
          sangramento: ps + delta >= 4,
          supuracao: false,
        })
        sitios++
      }
    }
  }
  linhas.periograma = exames.length
  linhas.periograma_sitio = sitios
  arbitrarios.push(
    'periograma: profundidades, recessões, mobilidade e furca são arbitrárias (faixa fisiológica), escolhidas para a comparação entre exames ter forma',
  )

  // ── Laboratório ───────────────────────────────────────────────────────────
  const [lab] = await db
    .insert(laboratorio)
    .values({
      nome: `${MARCA} Prótese Precisa Ltda`,
      contatoNome: 'Sr. Lauro',
      contatoTelefone: '1133221100',
      prazoPadraoDias: 10,
      observacoes: `${MARCA} retira e entrega às terças`,
    })
    .returning({ id: laboratorio.id })

  await db
    .insert(ordemLaboratorio)
    .values({
      laboratorioId: lab!.id,
      itemPlanoId: ref.itemAprovadoId,
      especificacao: `${MARCA} coroa metalocerâmica, dente 46`,
      cor: 'A2',
      situacao: 'enviada',
      enviadaEm: instanteDe(addDias(hoje, -6), '11:00'),
      prazoEm: addDias(hoje, 4),
      custo: '420.00',
    })

  const [ordemRecebida] = await db
    .insert(ordemLaboratorio)
    .values({
      laboratorioId: lab!.id,
      itemPlanoId: ref.itemAprovadoId,
      especificacao: `${MARCA} provisório, dente 24`,
      cor: 'A1',
      situacao: 'recebida',
      enviadaEm: instanteDe(addDias(hoje, -30), '11:00'),
      prazoEm: addDias(hoje, -20),
      recebidaEm: instanteDe(addDias(hoje, -19), '16:20'),
      custo: '180.00',
    })
    .returning({ id: ordemLaboratorio.id })

  /**
   * Refação é ordem NOVA apontando para a anterior, com motivo — não é situação.
   * "Quem paga" precisa das duas linhas: a peça foi feita duas vezes, e a segunda
   * pode ser cortesia do laboratório ou não.
   */
  await db.insert(ordemLaboratorio).values({
    laboratorioId: lab!.id,
    itemPlanoId: ref.itemAprovadoId,
    especificacao: `${MARCA} provisório, dente 24 — refação`,
    cor: 'A1',
    situacao: 'enviada',
    enviadaEm: instanteDe(addDias(hoje, -12), '09:00'),
    prazoEm: addDias(hoje, -2),
    custo: '0.00',
    refazId: ordemRecebida!.id,
    motivoRefacao: `${MARCA} desadaptação cervical — refeita sem custo`,
  })
  linhas.laboratorio = 1
  linhas.ordem_laboratorio = 3

  // ── Esterilização ─────────────────────────────────────────────────────────
  const [autoclaveDemo] = await db
    .insert(autoclave)
    .values({
      nome: `${MARCA} Autoclave 1`,
      fabricante: 'Cristófoli',
      modelo: 'Vitale Class 21',
      numeroSerie: 'DEMO-0001',
    })
    .returning({ id: autoclave.id })

  /**
   * Três ciclos, e cada um existe por um motivo de tela:
   *
   *   • certificado (químico aprovado + biológico negativo) — o caso normal;
   *   • **biológico PENDENTE** — o ciclo nasce sem veredito, porque o resultado sai
   *     dias depois. É o estado que a tela precisa distinguir de "reprovado";
   *   • **biológico POSITIVO** — falha de esterilização, o caso que a tela mostra em
   *     destaque. Aqui é que dói a ausência de rastreabilidade: o sistema diz o ciclo
   *     e o dia, **não a lista de pacientes** atendidos com aquele instrumental.
   *
   * `certificado` é coluna GENERATED — não se insere.
   */
  const ciclos = [
    {
      numero: 1,
      dia: mesRelativo(hoje, 0, 3),
      indicadorQuimico: 'aprovado' as const,
      biologicoResultado: 'negativo' as const,
      biologicoLidoEm: instanteDe(mesRelativo(hoje, 0, 5), '08:00'),
      conteudo: `${MARCA} 2 kits de exodontia, 1 kit de dentística`,
    },
    {
      numero: 2,
      dia: addDias(hoje, -1),
      indicadorQuimico: 'aprovado' as const,
      biologicoResultado: 'pendente' as const,
      biologicoLidoEm: null,
      conteudo: `${MARCA} 3 kits de periodontia`,
    },
    {
      numero: 3,
      dia: addDias(hoje, -9),
      indicadorQuimico: 'aprovado' as const,
      biologicoResultado: 'positivo' as const,
      biologicoLidoEm: instanteDe(addDias(hoje, -7), '08:10'),
      conteudo: `${MARCA} 2 kits de endodontia`,
    },
  ]
  for (const c of ciclos) {
    await db.insert(cicloEsterilizacao).values({
      numero: c.numero,
      autoclaveId: autoclaveDemo!.id,
      responsavelId: ref.usuarioDentistaId,
      iniciadoEm: instanteDe(c.dia, '07:30'),
      dia: c.dia,
      programa: 'Instrumental embalado 121 °C',
      temperaturaC: 121,
      duracaoMin: 30,
      conteudo: c.conteudo,
      indicadorQuimico: c.indicadorQuimico,
      biologicoResultado: c.biologicoResultado,
      biologicoLidoEm: c.biologicoLidoEm,
      observacao:
        c.biologicoResultado === 'positivo'
          ? `${MARCA} carga reprocessada; instrumental recolhido`
          : null,
    })
  }
  linhas.autoclave = 1
  linhas.ciclo_esterilizacao = ciclos.length

  // ── Propostas alternativas (A/B) ──────────────────────────────────────────
  /**
   * `plano_um_ativo_por_paciente` NÃO foi tocado: alternativas vivem em `rascunho`,
   * agrupadas por `grupo_proposta`, e uma vira `ativo`. O plano ativo da Ana já existe
   * (criado no `preparar.ts`), então as propostas são do BRUNO — senão o índice
   * recusaria, com razão.
   */
  const grupo = randomUUID()
  const [propA] = await db
    .insert(planoTratamento)
    .values({
      pacienteId: ref.pacienteBrunoId,
      profissionalId: ref.profissionalId,
      status: 'rascunho',
      titulo: `${MARCA} Proposta A — resina`,
      grupoProposta: grupo,
    })
    .returning({ id: planoTratamento.id })
  const [propB] = await db
    .insert(planoTratamento)
    .values({
      pacienteId: ref.pacienteBrunoId,
      profissionalId: ref.profissionalId,
      status: 'rascunho',
      titulo: `${MARCA} Proposta B — coroa`,
      grupoProposta: grupo,
    })
    .returning({ id: planoTratamento.id })

  const catalogo = await db
    .select({ id: procedimento.id, codigo: procedimento.codigo })
    .from(procedimento)
    .where(sql`${procedimento.clinicaId} = app_clinica_id()`)
  const porCodigo = new Map(catalogo.map((p) => [p.codigo, p.id]))

  await db.insert(itemPlano).values([
    { planoId: propA!.id, procedimentoId: porCodigo.get('DENT-002')!, valor: '300.00', denteFdi: 26, faces: ['oclusal', 'mesial'], status: 'proposto' },
    { planoId: propB!.id, procedimentoId: porCodigo.get('PROT-002')!, valor: '1600.00', denteFdi: 26, status: 'proposto' },
  ])
  linhas.plano_proposta = 2

  // ── Caixa: categorias, recorrente, despesas e pagamentos ──────────────────
  /**
   * Garante as categorias antes de ler: numa clínica criada DEPOIS da `drizzle/0034`
   * elas não existem, e `cats[0]!.id` estourava com "Cannot read properties of
   * undefined" — mensagem que não diz nada sobre categoria de despesa. Ver
   * `lib/db/seed/categoriasDespesa.ts`.
   */
  await seedCategoriasDespesa(db)
  const cats = await db
    .select({ id: categoriaDespesa.id, nome: categoriaDespesa.nome })
    .from(categoriaDespesa)
    .where(sql`${categoriaDespesa.clinicaId} = app_clinica_id()`)
  const cat = (nome: string) => cats.find((c) => c.nome.toLowerCase().includes(nome))?.id ?? cats[0]!.id

  const [recorrente] = await db
    .insert(regraDespesaRecorrente)
    .values({
      categoriaId: cat('aluguel'),
      descricao: `${MARCA} Aluguel da sala`,
      valor: '3200.00',
      diaVencimento: 5,
      inicioEm: mesRelativo(hoje, -4, 1),
    })
    .returning({ id: regraDespesaRecorrente.id })
  linhas.regra_despesa_recorrente = 1

  /**
   * O caso que separa os dois regimes, e a razão de as telas do caixa terem rótulo:
   * o aluguel do mês passado foi **pago neste mês**. "Quanto custou o mês passado"
   * inclui os 3.200; "quanto saiu do banco no mês passado" não.
   *
   * Sem uma linha assim, as duas telas mostram o mesmo número e ninguém percebe que
   * são perguntas diferentes — inclusive quem as escreveu.
   */
  const despesasCriadas: { id: string; valor: string; pagoEm: string | null }[] = []
  for (const m of [-3, -2, -1]) {
    const [d] = await db
      .insert(despesa)
      .values({
        categoriaId: cat('aluguel'),
        descricao: `${MARCA} Aluguel da sala — ${mesRelativo(hoje, m).slice(0, 7)}`,
        valor: '3200.00',
        competencia: mesRelativo(hoje, m, 1),
        vencimento: mesRelativo(hoje, m, 5),
        fornecedor: 'Imobiliária Demo',
        recorrenteId: recorrente!.id,
        criadoPorId: ref.usuarioFinanceiroId,
      })
      .returning({ id: despesa.id })
    // Os dois primeiros pagos no próprio mês; o último pago NO MÊS SEGUINTE.
    const pagoEm = m === -1 ? mesRelativo(hoje, 0, 4) : mesRelativo(hoje, m, 5)
    despesasCriadas.push({ id: d!.id, valor: '3200.00', pagoEm })
  }

  // Pontual paga no mês: material de consumo.
  const [dMaterial] = await db
    .insert(despesa)
    .values({
      categoriaId: cat('material'),
      descricao: `${MARCA} Reposição de material de consumo`,
      valor: '850.00',
      competencia: mesRelativo(hoje, -1, 1),
      vencimento: mesRelativo(hoje, -1, 20),
      fornecedor: 'Dental Distribuidora Demo',
      documento: 'NF 12345',
      criadoPorId: ref.usuarioFinanceiroId,
    })
    .returning({ id: despesa.id })
  despesasCriadas.push({ id: dMaterial!.id, valor: '850.00', pagoEm: mesRelativo(hoje, -1, 20) })

  // VENCIDA e não paga — é o que faz "o que eu ainda devo" ter linha vermelha.
  await db.insert(despesa).values({
    categoriaId: cat('laboratório') ?? cat('material'),
    descricao: `${MARCA} Fatura do laboratório de prótese`,
    valor: '600.00',
    competencia: mesRelativo(hoje, -1, 1),
    vencimento: addDias(hoje, -8),
    fornecedor: `${MARCA} Prótese Precisa Ltda`,
    criadoPorId: ref.usuarioFinanceiroId,
  })
  // A VENCER.
  await db.insert(despesa).values({
    categoriaId: cat('energia') ?? cat('aluguel'),
    descricao: `${MARCA} Energia elétrica`,
    valor: '410.00',
    competencia: mesRelativo(hoje, 0, 1),
    vencimento: addDias(hoje, 9),
    fornecedor: 'Concessionária Demo',
    criadoPorId: ref.usuarioFinanceiroId,
  })
  linhas.despesa = despesasCriadas.length + 2

  for (const d of despesasCriadas) {
    if (!d.pagoEm) continue
    await db.insert(pagamentoDespesa).values({
      despesaId: d.id,
      valor: d.valor,
      pagoEm: d.pagoEm,
      meio: 'transferencia',
      registradoPorId: ref.usuarioFinanceiroId,
    })
  }
  linhas.pagamento_despesa = despesasCriadas.length
  arbitrarios.push(
    'despesas: aluguel 3.200, material 850, laboratório 600, energia 410 — ordem de grandeza de consultório de duas cadeiras, não orçamento real',
  )

  // ── Taxa de meio de pagamento e conciliação do Pix ────────────────────────
  /**
   * A taxa existe para a tela mostrar bruto e líquido — e é a razão da pergunta que
   * está aberta com a clínica: comissão sobre o que o paciente pagou ou sobre o que
   * entrou na conta? `clinica.comissao_sobre_liquido` nasce `false` (bruto).
   */
  /**
   * ── A vigência TEM FIM, e isso não é detalhe ───────────────────────────────
   *
   * A primeira versão criava as taxas com `vigencia_fim` nulo — aberta para sempre. Elas
   * passaram a **colidir com qualquer faixa futura**, e o `caixa:demo` quebrou:
   *
   *   constraint: taxa_meio_sem_sobreposicao
   *
   * Aquele script cria as próprias taxas em datas dois anos à frente, e a EXCLUDE
   * constraint (que existe para que nunca haja duas taxas válidas no mesmo dia — senão o
   * líquido calculado dependeria da ordem da consulta) recusava. Ou seja: o povoamento
   * de demonstração **quebrou uma verificação**, que é o pior efeito colateral possível
   * para um script cujo propósito é ajudar a avaliar o sistema.
   *
   * Fechar em 60 dias resolve e é mais honesto: taxa de exemplo com data de fim diz que
   * é exemplo. Taxa de verdade vem do contrato da adquirente.
   *
   * `onConflictDoNothing` não ajudaria aqui: `ON CONFLICT` age sobre índice único, e
   * sobreposição de intervalo é EXCLUDE — o Postgres levanta erro, não conflito.
   */
  const inicioTaxa = mesRelativo(hoje, -6, 1)
  const fimTaxa = addDias(hoje, 60)
  const jaTemTaxa = await db
    .select({ meio: taxaMeioPagamento.meio })
    .from(taxaMeioPagamento)
    .where(sql`${taxaMeioPagamento.clinicaId} = app_clinica_id()`)
  const meiosComTaxa = new Set(jaTemTaxa.map((t) => t.meio))
  const novasTaxas = (
    [
      /**
       * **`credito` fica FORA, de propósito.** O `caixa:demo` cria a taxa de crédito
       * dele começando em 2026-01-01 **sem data de fim**, e a EXCLUDE constraint recusa
       * qualquer outra faixa de crédito que toque esse intervalo — inclusive uma fechada
       * dentro dele. Ou seja: não existe vigência de crédito que eu possa criar sem
       * quebrar aquela verificação.
       *
       * Entre povoar uma tela e manter uma verificação funcionando, a verificação ganha:
       * o povoamento é conveniência, e `caixa:demo` é o que prova que o módulo calcula
       * certo. O efeito visível é que a dedução de taxa aparece como R$ 0,00 na tela,
       * porque o único pagamento da demonstração é Pix (0%).
       *
       * ⚠️ Isto é acoplamento entre dois scripts pela mesma tabela da mesma clínica, e a
       * saída melhor seria o `caixa:demo` usar clínica própria ou tolerar taxa existente
       * — não é arquivo meu, está no relatório.
       */
      { meio: 'debito' as const, percentual: '1.29', observacao: `${MARCA} taxa de exemplo` },
      { meio: 'pix' as const, percentual: '0.00', observacao: `${MARCA} Pix sem taxa` },
    ] as const
  ).filter((t) => !meiosComTaxa.has(t.meio))
  if (novasTaxas.length > 0) {
    await db
      .insert(taxaMeioPagamento)
      .values(novasTaxas.map((t) => ({ ...t, vigenciaInicio: inicioTaxa, vigenciaFim: fimTaxa })))
  }
  linhas.taxa_meio_pagamento = novasTaxas.length
  arbitrarios.push('taxas de cartão (2,49% crédito, 1,29% débito) são de exemplo — a real vem do contrato da adquirente')

  /**
   * Conciliação: uma intenção **paga** (com pagamento e evento casados) e uma
   * **pendente**. E um evento **sem dono** — liquidação que chegou e não casou com
   * nenhuma intenção, que é o caso que a tela de conciliação existe para mostrar.
   *
   * Não há botão de "casar à mão", de propósito: liquidação sem dono quase nunca é
   * lançar pagamento, é devolver.
   */
  /**
   * A parcela do Pix é a de vencimento MAIS DISTANTE, não "uma aberta qualquer".
   *
   * A primeira versão fazia `where(status = 'aberta').limit(1)` — sem ordem — e pegou a
   * parcela **vencida**. O pagamento a quitou (a trigger de status faz o certo), e com
   * isso o povoamento **destruiu o caso de inadimplência** que ele mesmo tinha criado:
   * as cinco filas de relacionamento nasceram com zero tarefas e a tela abria vazia.
   *
   * `limit 1` sem `order by` não é consulta, é sorteio — o mesmo defeito que a Fase 17
   * corrigiu em dez lugares da aplicação, cometido aqui.
   */
  const [parcelaAberta] = await db
    .select({ id: parcela.id, valor: parcela.valor })
    .from(parcela)
    .where(eq(parcela.status, 'aberta'))
    .orderBy(sql`${parcela.vencimento} desc`)
    .limit(1)

  if (parcelaAberta) {
    const txidPago = `DEMOPIX${Date.now().toString().slice(-10)}A`
    const e2e = `E${Date.now().toString().slice(-11)}DEMOA`
    const [pg] = await db
      .insert(pagamento)
      .values({
        parcelaId: parcelaAberta.id,
        valor: parcelaAberta.valor,
        meio: 'pix',
        // `pagamento.pago_em` é DATE (dia civil), não timestamptz: o extrato bancário
        // fala em dias. `pagamento_despesa.pago_em` também.
        pagoEm: addDias(hoje, -2),
        // `conciliado` e `conciliado_em` andam juntos: o CHECK
        // `pagamento_conciliacao_coerente` recusa "conciliado sem quando", e está certo —
        // conciliação sem instante não se audita contra o extrato.
        conciliado: true,
        conciliadoEm: instanteDe(addDias(hoje, -2), '10:20'),
        registradoPorId: ref.usuarioFinanceiroId,
      })
      .returning({ id: pagamento.id })

    await db.insert(intencaoPix).values({
      parcelaId: parcelaAberta.id,
      txid: txidPago,
      valor: parcelaAberta.valor,
      situacao: 'pago',
      copiaECola: `00020126...${txidPago}`,
      expiraEm: instanteDe(addDias(hoje, -1), '23:59'),
      endToEndId: e2e,
      pagamentoId: pg!.id,
      liquidadoEm: instanteDe(addDias(hoje, -2), '10:15'),
    })
    await db.insert(eventoPix).values({
      endToEndId: e2e,
      txid: txidPago,
      valor: parcelaAberta.valor,
      liquidadoEm: instanteDe(addDias(hoje, -2), '10:15'),
      payload: { demo: true, origem: 'demo:preparar', txid: txidPago },
      processadoEm: instanteDe(addDias(hoje, -2), '10:15'),
    })
    linhas.intencao_pix = 1
    linhas.evento_pix = 1
  }

  // Intenção pendente e evento órfão — não dependem de parcela aberta.
  const [outraParcela] = await db.select({ id: parcela.id, valor: parcela.valor }).from(parcela).limit(1)
  if (outraParcela) {
    const txidPendente = `DEMOPIX${Date.now().toString().slice(-10)}B`
    await db.insert(intencaoPix).values({
      parcelaId: outraParcela.id,
      txid: txidPendente,
      valor: '300.00',
      situacao: 'pendente',
      copiaECola: `00020126...${txidPendente}`,
      expiraEm: instanteDe(addDias(hoje, 1), '23:59'),
    })
    linhas.intencao_pix = (linhas.intencao_pix ?? 0) + 1
  }

  await db.insert(eventoPix).values({
    endToEndId: `E${Date.now().toString().slice(-11)}ORFAO`,
    txid: 'DEMOPIXSEMDONO',
    valor: '75.00',
    liquidadoEm: instanteDe(addDias(hoje, -1), '14:02'),
    payload: { demo: true, observacao: 'liquidação sem intenção correspondente' },
    motivoNaoProcessado: 'txid não corresponde a nenhuma intenção desta clínica',
  })
  linhas.evento_pix = (linhas.evento_pix ?? 0) + 1

  // ── História que as CINCO filas de relacionamento exigem ──────────────────
  /**
   * Os geradores procuram FATOS com idade mínima, e o consultório da demonstração é
   * recém-criado: sem isto, quatro das cinco filas nascem vazias e a tela de
   * relacionamento — a fase inteira — abre em branco.
   *
   * Não dá para "criar a tarefa direto": a chave de idempotência é por fato, e uma
   * tarefa sem o fato que a origina seria duplicada pelo próximo despacho. Então o que
   * se cria é o fato, com a data que o gerador exige, e os geradores fazem o resto —
   * o mesmo caminho da produção.
   *
   *   orçamento sem resposta  → enviado há mais de 7 dias e ainda válido
   *   aprovado não executado  → item aprovado criado há mais de 30 dias
   *   faltou e não remarcou   → falta SEM agendamento posterior (o Bruno remarcou,
   *                             então precisa de um paciente que não)
   *   retorno programado      → execução mais antiga que o intervalo da regra
   */
  /**
   * Um paciente PRÓPRIO para estas duas filas, e não o Pedro.
   *
   * "Faltou e não remarcou" e "retorno programado" ambos exigem **nenhum agendamento
   * posterior** — e o Pedro tem consulta hoje, então as duas filas o ignoram, com razão:
   * quem remarcou não está sem remarcar, e quem já vem não precisa ser chamado.
   *
   * Tentei usar o Pedro e as filas ficaram em zero. A leitura errada seria "o gerador
   * está quebrado"; a certa é que faltava o fato. E o fato é uma pessoa específica: quem
   * faltou e desapareceu, que é justamente quem estas filas existem para recuperar.
   */
  const [pacSumido] = await db
    .insert(paciente)
    .values({
      nome: `${MARCA} Carla Ausente`,
      dataNascimento: '1979-11-03',
      telefone: '11955443322',
      observacoes: `${MARCA} faltou e não remarcou — existe para as filas de recuperação`,
    })
    .returning({ id: paciente.id })

  const [planoAntigo] = await db
    .insert(planoTratamento)
    .values({
      pacienteId: pacSumido!.id,
      profissionalId: ref.profissionalId,
      status: 'ativo',
      titulo: `${MARCA} Plano antigo da Carla`,
      criadoEm: instanteDe(mesRelativo(hoje, -8, 12), '09:00'),
    })
    .returning({ id: planoTratamento.id })

  // Aprovado há 40 dias e nunca executado — é "o dinheiro mais fácil da clínica",
  // porque o paciente já disse sim.
  await db.insert(itemPlano).values({
    planoId: planoAntigo!.id,
    procedimentoId: porCodigo.get('ENDO-001')!,
    valor: '850.00',
    denteFdi: 37,
    status: 'aprovado',
    aprovadoEm: instanteDe(addDias(hoje, -40), '10:00'),
    criadoEm: instanteDe(addDias(hoje, -40), '10:00'),
  })

  // Execução antiga de periodontia (regra de retorno: 3 meses) — vencida há muito.
  const [itemExecAntigo] = await db
    .insert(itemPlano)
    .values({
      planoId: planoAntigo!.id,
      procedimentoId: porCodigo.get('PERIO-002')!,
      valor: '320.00',
      denteFdi: 46,
      status: 'executado',
      aprovadoEm: instanteDe(mesRelativo(hoje, -8, 12), '09:10'),
      criadoEm: instanteDe(mesRelativo(hoje, -8, 12), '09:10'),
    })
    .returning({ id: itemPlano.id })
  await db.insert(execucao).values({
    itemPlanoId: itemExecAntigo!.id,
    profissionalId: ref.profissionalId,
    executadoEm: instanteDe(mesRelativo(hoje, -7, 12), '09:30'),
    observacao: `${MARCA} execução antiga, para a fila de retorno programado ter fato`,
  })

  /**
   * Orçamento enviado há 10 dias, ainda válido, sem resposta.
   *
   * Nasce `rascunho`, recebe as linhas, e só então é ENVIADO — porque a `drizzle/0004`
   * recusa enviar orçamento sem nenhuma linha ("orcamento % nao pode ser enviado sem
   * nenhuma linha"). Inserir já como `enviado` falha, e está certo: orçamento vazio
   * chegando ao paciente é pior que orçamento nenhum.
   *
   * É o mesmo caminho da aplicação, e é por isso que vale fazer assim em vez de
   * contornar a trava: se o fluxo real quebrar, este script quebra também.
   */
  await db.transaction(async (tx) => {
    /**
     * Orçamento e linhas na MESMA transação: a soma das linhas ter de bater com
     * `valor_bruto` é constraint **DEFERIDA**, conferida no commit. Inserir o orçamento
     * sozinho comita um documento de R$ 1.170 com zero linhas, e o banco recusa —
     * mesma família de `cobranca`/`parcela`, cuja lição o `preparar.ts` já registrava
     * na seção 7. Eu a redescobri aqui, e a mensagem que resolveu foi
     * "soma das linhas (0.00) difere do valor bruto do orcamento (1170.00)".
     */
    const [orcPedro] = await tx
      .insert(orcamento)
      .values({
        pacienteId: pacSumido!.id,
        planoId: planoAntigo!.id,
        validadeAte: addDias(hoje, 20),
        valorBruto: '1170.00',
        desconto: '0',
        valorTotal: '1170.00',
        criadoEm: instanteDe(addDias(hoje, -11), '16:00'),
      })
      .returning({ id: orcamento.id })

    await tx.insert(orcamentoItem).values([
      { orcamentoId: orcPedro!.id, descricao: `${MARCA} Tratamento endodôntico — dente 37`, quantidade: 1, valorUnitario: '850.00' },
      { orcamentoId: orcPedro!.id, descricao: `${MARCA} Raspagem subgengival — sextante`, quantidade: 1, valorUnitario: '320.00' },
    ])

    // Enviar só depois das linhas: a `drizzle/0004` recusa enviar orçamento vazio.
    await tx
      .update(orcamento)
      .set({ status: 'enviado', enviadoEm: instanteDe(addDias(hoje, -10), '16:00') })
      .where(eq(orcamento.id, orcPedro!.id))
  })

  /**
   * Faltou e NÃO remarcou. Precisa de paciente sem agendamento posterior — o Bruno
   * tem, e por isso a fila dele fica (corretamente) vazia: quem remarcou não está
   * "sem remarcar".
   */
  await db.insert(agendamento).values({
    pacienteId: pacSumido!.id,
    profissionalId: ref.profissionalId,
    cadeiraId: ref.cadeiraId,
    inicio: instanteDe(addDias(hoje, -9), '14:00'),
    fim: instanteDe(addDias(hoje, -9), '14:45'),
    status: 'faltou',
    observacao: `${MARCA} falta sem remarcação`,
  })
  linhas.historico_para_filas = 5

  return { linhas, arbitrarios }
}
