import { gerarHashSenha } from '@/lib/auth/senha'
import type { Ator } from '@/lib/authz/sessao'
import { db, pool } from '@/lib/db'
import {
  autoclave,
  cicloEsterilizacao,
  itemPlano,
  laboratorio,
  ordemLaboratorio,
  paciente,
  periograma,
  planoTratamento,
  procedimento,
  profissional,
  usuario,
} from '@/lib/db/schema'
import { clinicaParaScript } from '@/lib/demo/clinicaDaDemo'
import { desligarTriggersDeAplicacao, religarTriggersDeAplicacao } from '@/lib/demo/triggers'
import {
  compararPeriogramas,
  formatarMm,
  mediaNivelInsercaoDecimos,
  mediaProfundidadeDecimos,
  sangramentoDecimosPct,
  sitiosDe,
} from '@/lib/domain/periograma'
import { comContextoDeClinica } from '@/lib/tenant/contexto'
import { and, eq, sql } from 'drizzle-orm'
import {
  abrirPeriogramaComAtor,
  compararUltimosDoisComAtor,
  concluirPeriogramaComAtor,
  dentesDoPeriograma,
  registrarMedidasComAtor,
  sitiosDoPeriogramaComAtor,
} from './periograma'

/**
 * Fase 21 ponta a ponta, contra o Postgres.
 *
 *   npm run periograma:demo
 *
 * Confere **número**, não fluxo — e o número que importa é o da seção 4: dois exames
 * do mesmo paciente com um molar extraído no meio, e a comparação **não** contando
 * isso como melhora. Os valores estão calculados à mão no comentário de cada seção,
 * e a asserção compara com eles.
 */

const MARCA = `PERIO-${Date.now().toString().slice(-6)}`
const SENHA = 'Periograma-Demo-2026'

let falhas = 0
function conferir(ok: boolean, texto: string): void {
  if (ok) {
    console.log(`   \x1b[32m✓\x1b[0m ${texto}`)
  } else {
    console.log(`   \x1b[31m✗ ${texto}\x1b[0m`)
    falhas++
  }
}
function titulo(t: string): void {
  console.log(`\n\x1b[36m${t}\x1b[0m`)
}

async function criarDentista(): Promise<Ator> {
  // As duas linhas na MESMA transação: a trava deferida de `drizzle/0021` cobra no
  // commit que dentista ativo tenha cadastro de profissional.
  const { u, profissionalId } = await db.transaction(async (tx) => {
    const [novo] = await tx
      .insert(usuario)
      .values({
        nome: `[${MARCA}] Dra. Periodontia`,
        email: `perio-${Date.now()}@demo.local`,
        senhaHash: await gerarHashSenha(SENHA),
        perfil: 'dentista',
      })
      .returning({ id: usuario.id, clinicaId: usuario.clinicaId, email: usuario.email })
    const [p] = await tx
      .insert(profissional)
      .values({ usuarioId: novo!.id, cro: MARCA.slice(-5), ufCro: 'SP' })
      .returning({ id: profissional.id })
    return { u: novo!, profissionalId: p!.id }
  })

  return {
    usuarioId: u.id,
    clinicaId: u.clinicaId,
    nome: `[${MARCA}] Dra. Periodontia`,
    email: u.email,
    perfil: 'dentista',
    profissionalId,
  }
}

/** Os 6 sítios de um dente, com o mesmo valor em todos — mantém a conta à mão viável. */
function seisSitios(denteFdi: number, ps: number, recessao: number, sangra: boolean) {
  return sitiosDe(denteFdi).map((sitio) => ({
    denteFdi,
    sitio,
    profundidadeMm: ps,
    recessaoMm: recessao,
    sangramento: sangra,
  }))
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('periograma:demo cria pessoas fictícias. Não roda em produção.')
  }

  console.log('\n═══ Fase 21: profundidade clínica, contra o Postgres ═══')

  const ator = await criarDentista()
  const [pac] = await db
    .insert(paciente)
    .values({ nome: `[${MARCA}] Paciente Periodontal`, dataNascimento: '1975-04-22' })
    .returning({ id: paciente.id })
  const pacienteId = pac!.id

  // ── 1. O NIC é derivado ───────────────────────────────────────────────────
  titulo('1. O nível de inserção é DERIVADO, não digitado')
  const exame1 = await abrirPeriogramaComAtor(ator, {
    pacienteId,
    observacao: 'Exame inicial',
  })

  /*
   * A boca deste exame, escolhida para a conta ser conferível à mão:
   *
   *   dente 11 (incisivo, sem furca)   6 sítios · PS 3 · recessão 0 → NIC 3
   *   dente 16 (molar superior)        6 sítios · PS 4 · recessão 1 → NIC 5
   *   dente 26 (molar superior)        6 sítios · PS 9 · recessão 3 → NIC 12  ← condenado
   *   dente 36 (molar inferior)        6 sítios · PS 4 · recessão 1 → NIC 5
   *
   *   24 sítios · soma PS = 18+24+54+24 = 120 → média 5,0 mm
   *              soma NIC = 18+30+72+30 = 150 → média 6,25 → 6,3 mm (arredondado)
   */
  await registrarMedidasComAtor(
    ator,
    exame1.id,
    [
      { denteFdi: 11, mobilidade: 0 },
      { denteFdi: 16, mobilidade: 1, furca: 1 },
      { denteFdi: 26, mobilidade: 2, furca: 3 },
      { denteFdi: 36, mobilidade: 0, furca: 0 },
    ],
    [
      ...seisSitios(11, 3, 0, false),
      ...seisSitios(16, 4, 1, true),
      ...seisSitios(26, 9, 3, true),
      ...seisSitios(36, 4, 1, true),
    ],
  )
  await concluirPeriogramaComAtor(ator, exame1.id)

  const sitios1 = await sitiosDoPeriogramaComAtor(ator, exame1.id)
  conferir(sitios1.length === 24, `${sitios1.length} sítios gravados (4 dentes × 6)`)

  // O NIC vem do BANCO, coluna gerada. Se ele fosse digitável, esta leitura não
  // provaria nada — provaria que o script sabe somar.
  const [nicDoBanco] = await db.execute(
    sql`select nivel_insercao_mm from periograma_sitio
         where periograma_id = ${exame1.id} and dente_fdi = 26 limit 1`,
  ).then((r) => r.rows as { nivel_insercao_mm: number }[])
  conferir(
    Number(nicDoBanco!.nivel_insercao_mm) === 12,
    `NIC do 26 calculado pelo banco: ${nicDoBanco!.nivel_insercao_mm} (PS 9 + recessão 3)`,
  )

  const [soma] = await db.execute(
    sql`select sum(profundidade_sondagem_mm)::int as ps, sum(nivel_insercao_mm)::int as nic
          from periograma_sitio where periograma_id = ${exame1.id}`,
  ).then((r) => r.rows as { ps: number; nic: number }[])
  conferir(Number(soma!.ps) === 120, `soma das sondagens = ${soma!.ps} mm (esperado 120)`)
  conferir(Number(soma!.nic) === 150, `soma dos NIC = ${soma!.nic} mm (esperado 150)`)

  // ── 2. Furca só em multirradicular ────────────────────────────────────────
  titulo('2. Furca só existe em dente multirradicular')
  const dentes1 = await dentesDoPeriograma(exame1.id)
  const incisivo = dentes1.find((d) => d.denteFdi === 11)
  conferir(incisivo?.furca === null, 'o incisivo 11 ficou sem furca')

  let recusouFurca = false
  try {
    await registrarMedidasComAtor(ator, exame1.id, [{ denteFdi: 31, furca: 2 }], [])
  } catch (e) {
    recusouFurca = e instanceof Error && e.message.includes('raiz única')
  }
  conferir(recusouFurca, 'furca no incisivo inferior 31 foi recusada, dizendo por quê')

  let recusouDeciduo = false
  try {
    await registrarMedidasComAtor(ator, exame1.id, [{ denteFdi: 55 }], [])
  } catch (e) {
    recusouDeciduo = e instanceof Error && e.message.includes('decíduo')
  }
  conferir(recusouDeciduo, 'dente decíduo 55 foi recusado')

  let recusouSitio = false
  try {
    await registrarMedidasComAtor(ator, exame1.id, [], [
      { denteFdi: 36, sitio: 'palatina', profundidadeMm: 3 },
    ])
  } catch (e) {
    recusouSitio = e instanceof Error && e.message.includes('inferior')
  }
  conferir(recusouSitio, 'sítio palatino no dente inferior 36 foi recusado')

  // ── 3. O segundo exame, com o 26 extraído ─────────────────────────────────
  titulo('3. Seis meses depois — o 26 foi extraído')
  const exame2 = await abrirPeriogramaComAtor(ator, {
    pacienteId,
    observacao: 'Reavaliação após raspagem',
  })

  /*
   * A boca do segundo exame:
   *
   *   dente 11   PS 3 · recessão 0 → NIC 3   (igual)
   *   dente 16   PS 3 · recessão 2 → NIC 5   (bolsa −1, recessão +1 → NIC IGUAL)
   *   dente 36   PS 3 · recessão 1 → NIC 4   (melhorou de verdade: −1 em PS e em NIC)
   *   dente 26   AUSENTE — extraído
   *
   *   18 sítios · soma PS = 18+18+18 = 54 → média 3,0 mm
   *              soma NIC = 18+30+24 = 72 → média 4,0 mm
   */
  await registrarMedidasComAtor(
    ator,
    exame2.id,
    [
      { denteFdi: 11, mobilidade: 0 },
      { denteFdi: 16, mobilidade: 1, furca: 1 },
      { denteFdi: 36, mobilidade: 0, furca: 0 },
    ],
    [
      ...seisSitios(11, 3, 0, false),
      ...seisSitios(16, 3, 2, false),
      ...seisSitios(36, 3, 1, false),
    ],
  )
  await concluirPeriogramaComAtor(ator, exame2.id)

  // ── 4. A comparação — o número que sustenta a fase ────────────────────────
  titulo('4. Dente extraído NÃO é melhora')
  const c = await compararUltimosDoisComAtor(ator, pacienteId)
  if (!c) throw new Error('a comparação devolveu nulo — deveria haver dois exames')

  /*
   * A leitura INGÊNUA, sobre todos os sítios de cada exame:
   *   antes  24 sítios · PS média 5,0 mm
   *   depois 18 sítios · PS média 3,0 mm
   * "A profundidade caiu 40 %." É o gráfico que uma clínica mostraria de boa-fé.
   */
  const ingenuaAntes = mediaProfundidadeDecimos(c.completo.antes)
  const ingenuaDepois = mediaProfundidadeDecimos(c.completo.depois)
  conferir(
    ingenuaAntes === 50 && ingenuaDepois === 30,
    `leitura ingênua: ${formatarMm(ingenuaAntes)} → ${formatarMm(ingenuaDepois)} (mentira)`,
  )

  /*
   * A EMPARELHADA, só nos 18 sítios presentes nos dois exames (11, 16 e 36):
   *   antes  soma PS = 18+24+24 = 66 → 66*10/18 = 36,67 → 37 décimos = 3,7 mm
   *   depois soma PS = 18+18+18 = 54 → 54*10/18 = 30      = 3,0 mm
   * Melhora real de 0,7 mm — não de 2,0.
   */
  const parAntes = mediaProfundidadeDecimos(c.emparelhado.antes)
  const parDepois = mediaProfundidadeDecimos(c.emparelhado.depois)
  conferir(
    c.emparelhado.antes.sitios === 18 && c.emparelhado.depois.sitios === 18,
    `emparelhados: ${c.emparelhado.antes.sitios} sítios nos dois exames`,
  )
  conferir(
    parAntes === 37 && parDepois === 30,
    `leitura honesta: ${formatarMm(parAntes)} → ${formatarMm(parDepois)} (melhora de 0,7 mm)`,
  )
  conferir(
    c.dentesPerdidos.length === 1 && c.dentesPerdidos[0] === 26,
    `perda dentária nomeada: dente ${c.dentesPerdidos.join(', ')}`,
  )
  conferir(c.parcial, 'a comparação está marcada como PARCIAL — a boca mudou')

  /*
   * E o NIC emparelhado, que é o número que diz se a doença progrediu:
   *   antes  soma NIC = 18+30+30 = 78 → 78*10/18 = 43,3 → 43 = 4,3 mm
   *   depois soma NIC = 18+30+24 = 72 → 72*10/18 = 40      = 4,0 mm
   *
   * A PS do 16 caiu 1 mm e o NIC dele **não mudou** (recessão subiu 1). Só o 36
   * melhorou de verdade. O NIC médio anda 0,3 mm; a PS média anda 0,7 mm — e é
   * essa diferença que separa tratamento que funcionou de gengiva que retraiu.
   */
  const nicAntes = mediaNivelInsercaoDecimos(c.emparelhado.antes)
  const nicDepois = mediaNivelInsercaoDecimos(c.emparelhado.depois)
  conferir(
    nicAntes === 43 && nicDepois === 40,
    `NIC emparelhado: ${formatarMm(nicAntes)} → ${formatarMm(nicDepois)} (anda menos que a PS)`,
  )

  // Sangramento: antes 18 de 18 sangravam nos pares (16 e 36 sangravam, 11 não →
  // 12 de 18 = 66,7 %); depois nenhum → 0 %.
  const sangAntes = sangramentoDecimosPct(c.emparelhado.antes)
  const sangDepois = sangramentoDecimosPct(c.emparelhado.depois)
  conferir(
    sangAntes === 667 && sangDepois === 0,
    `sangramento: ${sangAntes! / 10}% → ${sangDepois! / 10}%`,
  )

  // ── 5. CONTRAPROVA: sem extração, as duas leituras coincidem ──────────────
  titulo('5. CONTRAPROVA — sem extração, ingênua e emparelhada dão o mesmo')
  /*
   * Sem isto, a seção 4 provaria apenas que as duas contas são diferentes — o que
   * seria compatível com o emparelhamento estar simplesmente errado. Aqui os dois
   * conjuntos são idênticos, então qualquer divergência acusaria bug na função.
   */
  const mesmos = await sitiosDoPeriogramaComAtor(ator, exame2.id)
  const semMudanca = compararPeriogramas(mesmos, mesmos)
  conferir(!semMudanca.parcial, 'sem perda dentária, a comparação não é parcial')
  conferir(
    mediaProfundidadeDecimos(semMudanca.completo.antes) ===
      mediaProfundidadeDecimos(semMudanca.emparelhado.antes),
    'ingênua e emparelhada coincidem quando a boca é a mesma',
  )

  // ── 6. Ordem de laboratório ───────────────────────────────────────────────
  titulo('6. Ordem de laboratório: custo combinado, sem contagem dupla')
  const [lab] = await db
    .insert(laboratorio)
    .values({ nome: `[${MARCA}] Laboratório`, prazoPadraoDias: 10 })
    .returning({ id: laboratorio.id })

  const [plano] = await db
    .insert(planoTratamento)
    .values({
      pacienteId,
      profissionalId: ator.profissionalId!,
      titulo: `[${MARCA}] Reabilitação`,
      status: 'rascunho',
    })
    .returning({ id: planoTratamento.id })

  const [proc] = await db
    .select({ id: procedimento.id })
    .from(procedimento)
    // Filtro por clínica explícito: este script roda como DONO em operação, e ali
    // não há RLS filtrando. Sem ele, `codigo` (único POR CLÍNICA desde a 0022)
    // devolveria o procedimento de outra clínica — quarta ocorrência dessa armadilha
    // no projeto, e o FK composto é quem avisa.
    .where(and(eq(procedimento.clinicaId, ator.clinicaId), eq(procedimento.codigo, 'PROT-002')))
    .limit(1)

  const [item] = await db
    .insert(itemPlano)
    .values({
      planoId: plano!.id,
      procedimentoId: proc!.id,
      denteFdi: 16,
      valor: '1600.00',
    })
    .returning({ id: itemPlano.id })

  const [ordem] = await db
    .insert(ordemLaboratorio)
    .values({
      laboratorioId: lab!.id,
      itemPlanoId: item!.id,
      especificacao: 'Coroa metalocerâmica sobre 16',
      cor: 'A2',
      custo: '480.00',
    })
    .returning({ id: ordemLaboratorio.id, numero: ordemLaboratorio.numero })
  conferir(ordem!.numero >= 1, `ordem numerada por clínica: nº ${ordem!.numero}`)

  // A ordem NÃO cria despesa: o laboratório fatura por mês, e uma despesa por peça
  // produziria N lançamentos que não casam com a nota.
  const [despesas] = await db.execute(
    sql`select count(*)::int as n from despesa where descricao like ${'%' + MARCA + '%'}`,
  ).then((r) => r.rows as { n: number }[])
  conferir(
    Number(despesas!.n) === 0,
    'a ordem não gerou despesa automática (o laboratório fatura por mês)',
  )

  let recusouRefacao = false
  try {
    await db.insert(ordemLaboratorio).values({
      laboratorioId: lab!.id,
      itemPlanoId: item!.id,
      especificacao: 'Refação',
      refazId: ordem!.id,
    })
  } catch {
    recusouRefacao = true
  }
  conferir(recusouRefacao, 'refação sem motivo escrito foi recusada pelo banco')

  // ── 7. Ciclo de esterilização ─────────────────────────────────────────────
  titulo('7. Esterilização: o biológico chega depois')
  const [auto] = await db
    .insert(autoclave)
    .values({ nome: `[${MARCA}] Autoclave`, fabricante: 'Teste' })
    .returning({ id: autoclave.id })

  const [ciclo] = await db
    .insert(cicloEsterilizacao)
    .values({
      numero: 1,
      autoclaveId: auto!.id,
      responsavelId: ator.usuarioId,
      iniciadoEm: new Date(),
      conteudo: 'Kit periodontia — sondas Williams, cureta Gracey 5/6',
      indicadorQuimico: 'aprovado',
      temperaturaC: 134,
      duracaoMin: 20,
    })
    .returning({ id: cicloEsterilizacao.id, certificado: cicloEsterilizacao.certificado })
  conferir(
    ciclo!.certificado === false,
    'ciclo nasce NÃO certificado — o biológico está pendente',
  )

  await db
    .update(cicloEsterilizacao)
    .set({ biologicoResultado: 'negativo', biologicoLidoEm: new Date() })
    .where(eq(cicloEsterilizacao.id, ciclo!.id))
  const [depoisDaLeitura] = await db
    .select({ certificado: cicloEsterilizacao.certificado })
    .from(cicloEsterilizacao)
    .where(eq(cicloEsterilizacao.id, ciclo!.id))
  conferir(
    depoisDaLeitura!.certificado === true,
    'biológico negativo certifica (contraprova: o mesmo ciclo, dias depois)',
  )

  await db
    .update(cicloEsterilizacao)
    .set({ biologicoResultado: 'positivo' })
    .where(eq(cicloEsterilizacao.id, ciclo!.id))
  const [comPositivo] = await db
    .select({ certificado: cicloEsterilizacao.certificado })
    .from(cicloEsterilizacao)
    .where(eq(cicloEsterilizacao.id, ciclo!.id))
  conferir(comPositivo!.certificado === false, 'biológico positivo DESCERTIFICA o ciclo')

  console.log('\n\x1b[32m═══ Fase 21 verificada contra o Postgres ═══\x1b[0m')
  console.log('\nO que ficou provado, e não só executado:')
  console.log('  • o NIC é calculado pelo banco (coluna gerada), não digitado')
  console.log('  • furca em raiz única, sítio do lado errado e decíduo são recusados')
  console.log('  • dente extraído aparece como PERDA, não como melhora de 40 %')
  console.log('  • o NIC anda menos que a sondagem quando a gengiva retrai')
  console.log('  • a ordem de laboratório não gera despesa (sem contagem dupla)')
  console.log('  • ciclo com biológico pendente não está certificado')
  console.log('\n⚠️  O que NÃO está provado: nada disto foi validado por um dentista.')
  console.log('    Ver a lista de ⚠️ no GLOSSARIO.md — faixas, furca do pré-molar')
  console.log('    superior, exclusão dos decíduos, e a RDC 15 além do registro.')

  await limpar()
}

/**
 * Remove o que este script criou.
 *
 * `DISABLE TRIGGER USER` e não `session_replication_role = 'replica'`: aquele desliga
 * também as triggers de FK e já deixou 5 linhas órfãs neste projeto, que derrubaram
 * uma migration. `religar` confere que religou — é DDL, e comitar desligada a deixa
 * desligada para sempre.
 */
async function limpar(): Promise<void> {
  const c = await db.$client.connect()
  try {
    await c.query('begin')
    const desligadas = await desligarTriggersDeAplicacao(c)
    const like = `%${MARCA}%`

    await c.query('delete from periograma_sitio where periograma_id in (select id from periograma where paciente_id in (select id from paciente where nome like $1))', [like])
    await c.query('delete from periograma_dente where periograma_id in (select id from periograma where paciente_id in (select id from paciente where nome like $1))', [like])
    await c.query('delete from periograma where paciente_id in (select id from paciente where nome like $1)', [like])
    await c.query('delete from ciclo_esterilizacao where autoclave_id in (select id from autoclave where nome like $1)', [like])
    await c.query('delete from autoclave where nome like $1', [like])
    await c.query('delete from ordem_laboratorio where laboratorio_id in (select id from laboratorio where nome like $1)', [like])
    await c.query('delete from laboratorio where nome like $1', [like])
    await c.query('delete from item_plano where plano_id in (select id from plano_tratamento where titulo like $1)', [like])
    await c.query('delete from plano_tratamento where titulo like $1', [like])
    await c.query('delete from audit_log where paciente_id in (select id from paciente where nome like $1)', [like])
    await c.query('delete from paciente where nome like $1', [like])
    await c.query('delete from profissional where usuario_id in (select id from usuario where nome like $1)', [like])
    await c.query('delete from usuario where nome like $1', [like])

    // ANTES do commit, sempre.
    await religarTriggersDeAplicacao(c, desligadas)
    await c.query('commit')
    console.log('\nDados da demonstração removidos.')
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
