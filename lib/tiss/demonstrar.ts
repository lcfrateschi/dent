import { gerarHashSenha } from '@/lib/auth/senha'
import type { Ator } from '@/lib/authz/sessao'
import { db, pool } from '@/lib/db'
import {
  convenio,
  execucao,
  glosa,
  guiaTiss,
  itemGuia,
  itemPlano,
  paciente,
  pacienteConvenio,
  planoTratamento,
  precoConvenio,
  procedimento,
  profissional,
  repasse,
  usuario,
} from '@/lib/db/schema'
import {
  avaliarElegibilidade,
  conciliarRepasse,
  precoVigenteEm,
  previsaoDeRepasse,
  ratearCobertura,
} from '@/lib/domain/convenio'
import { somar } from '@/lib/domain/dinheiro'
import { instanteDe } from '@/lib/domain/fuso'
import { eq } from 'drizzle-orm'
import { desligarTriggersDeAplicacao, religarTriggersDeAplicacao } from '@/lib/demo/triggers'
import { comContextoDeClinica } from '@/lib/tenant/contexto'
import { clinicaDaExecucao, idDaPrimeiraClinica } from '@/lib/demo/clinicaDaDemo'

/**
 * Demonstração da Fase 13 contra o Postgres.
 *
 * `npm run convenio:demo`
 *
 * O ciclo inteiro, com valores escolhidos para as somas serem conferíveis à mão:
 *
 *   tabela negociada → elegibilidade → execução → guia → envio → glosa parcial →
 *   recurso → repasse conciliado item a item
 *
 * Cada indicador é comparado com o valor esperado. Um módulo de convênio que
 * "funciona" mas erra R$ 0,01 na coparticipação é um módulo que gera glosa da guia
 * inteira — daí a insistência em conferir número, não fluxo.
 */

const MARCA = 'CONV-DEMO'
let falhas = 0

function passo(n: number, texto: string): void {
  console.log(`\n\x1b[36m${n}.\x1b[0m ${texto}`)
}

function conferir(condicao: boolean, texto: string): void {
  if (condicao) {
    console.log(`   \x1b[32m✓\x1b[0m ${texto}`)
  } else {
    console.error(`   \x1b[31m✗ ${texto}\x1b[0m`)
    falhas++
    throw new Error(texto)
  }
}

async function main(): Promise<void> {
  console.log('\n═══ Fase 13: o ciclo do convênio, com os números conferidos ═══')

  const marcaTempo = Date.now()

  // Usuário e profissional na MESMA transação — a trava deferida de
  // `drizzle/0021` cobra no commit que dentista ativo tenha cadastro de
  // profissional, e dois inserts soltos comitam separado.
  const { u, prof } = await db.transaction(async (tx) => {
    const [novoUsuario] = await tx
      .insert(usuario)
      .values({
        nome: `${MARCA} Dra. Vera`,
        email: `conv-${marcaTempo}@local`,
        senhaHash: await gerarHashSenha('x'.repeat(20)),
        perfil: 'dentista',
      })
      // `clinicaId` no returning: o tenant do Ator é o do USUÁRIO, lido da linha que
      // acabou de nascer. Ler de `clinicaAtual()` compilaria igual e seria o andaime
      // — e num banco com duas clínicas montaria um ator cuja clínica não é a do seu
      // próprio usuário, que é precisamente o que a sessão real nunca faz.
      .returning({ id: usuario.id, clinicaId: usuario.clinicaId })
    const [novoProf] = await tx
      .insert(profissional)
      .values({ usuarioId: novoUsuario!.id, cro: `C${marcaTempo % 100000}`, ufCro: 'sp' })
      .returning({ id: profissional.id })
    return { u: novoUsuario, prof: novoProf }
  })

  const ator: Ator = {
    usuarioId: u!.id,
    clinicaId: u!.clinicaId,
    nome: `${MARCA} Dra. Vera`,
    email: 'conv@local',
    perfil: 'dentista',
    profissionalId: prof!.id,
  }

  const [pac] = await db
    .insert(paciente)
    .values({ nome: `${MARCA} Paciente`, dataNascimento: '1985-05-05' })
    .returning({ id: paciente.id })
  const pacienteId = pac!.id

  const [conv] = await db
    .insert(convenio)
    .values({
      nome: `${MARCA} Operadora`,
      registroAns: '412345',
      prazoPagamentoDias: 30,
    })
    .returning({ id: convenio.id })
  const convenioId = conv!.id

  /*
   * O filtro por `clinica_id` não é redundante enquanto o app conecta como dono
   * das tabelas: **dono ignora política de RLS**, então esta consulta vê o
   * catálogo de TODAS as clínicas. Sem o filtro ela devolvia o procedimento de uma
   * clínica enquanto o script gravava na outra, e o FK composto da `drizzle/0023`
   * recusava o `item_plano` — que é o banco fazendo o trabalho certo.
   *
   * Quando a aplicação passar a conectar com a role sem BYPASSRLS, a política
   * cobrirá isso sozinha. Até então, o filtro é o que existe.
   */
  const [proc] = await db
    .select({ id: procedimento.id, nome: procedimento.nome })
    .from(procedimento)
    .where(eq(procedimento.clinicaId, clinicaDaExecucao()))
    .orderBy(procedimento.codigo)
    .limit(1)

  try {
    // ── Tabela negociada: duas vigências ─────────────────────────────────────
    passo(1, 'Tabela negociada com duas vigências: 2025 a 80,00 e 2026 a 100,00')
    await db.insert(precoConvenio).values([
      {
        convenioId,
        procedimentoId: proc!.id,
        valor: '80.00',
        coberturaPct: '100',
        vigenciaInicio: '2025-01-01',
        vigenciaFim: '2025-12-31',
      },
      {
        convenioId,
        procedimentoId: proc!.id,
        valor: '100.00',
        coberturaPct: '70',
        carenciaDias: 180,
        vigenciaInicio: '2026-01-01',
      },
    ])

    const precos = await db
      .select({
        convenioId: precoConvenio.convenioId,
        procedimentoId: precoConvenio.procedimentoId,
        valor: precoConvenio.valor,
        coberturaPct: precoConvenio.coberturaPct,
        carenciaDias: precoConvenio.carenciaDias,
        vigenciaInicio: precoConvenio.vigenciaInicio,
        vigenciaFim: precoConvenio.vigenciaFim,
      })
      .from(precoConvenio)
      .where(eq(precoConvenio.convenioId, convenioId))

    conferir(
      precoVigenteEm(precos, '2025-06-15')?.valor === '80.00',
      'procedimento de junho/2025 vale 80,00 (a tabela da época)',
    )
    conferir(
      precoVigenteEm(precos, '2026-06-15')?.valor === '100.00',
      'procedimento de junho/2026 vale 100,00',
    )

    // ── Elegibilidade: carência ──────────────────────────────────────────────
    passo(2, 'Carteirinha com adesão em 01/03/2026 e carência de 180 dias')
    await db.insert(pacienteConvenio).values({
      pacienteId,
      convenioId,
      numeroCarteirinha: `CART-${marcaTempo}`,
      adesaoEm: '2026-03-01',
      validade: '2027-12-31',
    })

    const [carteirinha] = await db
      .select({
        numeroCarteirinha: pacienteConvenio.numeroCarteirinha,
        ativo: pacienteConvenio.ativo,
        adesaoEm: pacienteConvenio.adesaoEm,
        validade: pacienteConvenio.validade,
      })
      .from(pacienteConvenio)
      .where(eq(pacienteConvenio.pacienteId, pacienteId))

    const preco2026 = precoVigenteEm(precos, '2026-06-15')!

    const dentroDaCarencia = avaliarElegibilidade({
      carteirinha: carteirinha!,
      preco: preco2026,
      dataIso: '2026-05-01',
    })
    conferir(
      !dentroDaCarencia.elegivel && dentroDaCarencia.motivo === 'dentro_da_carencia',
      `01/05/2026 está na carência: ${dentroDaCarencia.explicacao?.slice(0, 50)}…`,
    )
    // 180 dias de 01/03/2026 = 28/08/2026.
    conferir(
      dentroDaCarencia.carenciaTerminaEm === '2026-08-28',
      `carência termina em ${dentroDaCarencia.carenciaTerminaEm} (esperado 2026-08-28)`,
    )

    const depoisDaCarencia = avaliarElegibilidade({
      carteirinha: carteirinha!,
      preco: preco2026,
      dataIso: '2026-09-01',
    })
    conferir(depoisDaCarencia.elegivel, '01/09/2026 já está coberto')

    // ── Rateio da coparticipação ─────────────────────────────────────────────
    passo(3, 'Cobertura de 70% sobre 100,00: operadora 70,00, paciente 30,00')
    const rateio = ratearCobertura(preco2026.valor, preco2026.coberturaPct)
    conferir(rateio.convenio === '70.00', `operadora: ${rateio.convenio}`)
    conferir(rateio.paciente === '30.00', `paciente: ${rateio.paciente}`)
    conferir(
      somar(rateio.convenio, rateio.paciente) === rateio.total,
      'as duas partes somam exatamente o total',
    )

    // ── Execução de dois procedimentos ───────────────────────────────────────
    passo(4, 'Dois procedimentos executados em setembro, a 70,00 cada (parte da operadora)')
    const [plano] = await db
      .insert(planoTratamento)
      .values({ pacienteId, profissionalId: prof!.id, status: 'ativo', titulo: `${MARCA} plano` })
      .returning({ id: planoTratamento.id })

    const itens: string[] = []
    for (const dia of ['05', '12']) {
      const [item] = await db
        .insert(itemPlano)
        .values({
          planoId: plano!.id,
          procedimentoId: proc!.id,
          cobertura: 'convenio',
          convenioId,
          // O que se apresenta à operadora é a PARTE DELA. A coparticipação é
          // cobrada do paciente pelo financeiro, não pedida na guia.
          valor: rateio.convenio,
          valorCoparticipacao: rateio.paciente,
          status: 'executado',
        })
        .returning({ id: itemPlano.id })
      itens.push(item!.id)

      await db.insert(execucao).values({
        itemPlanoId: item!.id,
        profissionalId: prof!.id,
        executadoEm: instanteDe(`2026-09-${dia}`, '10:00'),
      })
    }
    conferir(itens.length === 2, '2 procedimentos com execução registrada')

    // ── Montar e enviar a guia ───────────────────────────────────────────────
    passo(5, 'Montar a guia: 2 × 70,00 = 140,00')
    const { montarGuiaComAtor } = await import('./montar')
    const r = await montarGuiaComAtor(ator, { itemPlanoIds: itens, profissionalId: prof!.id })
    conferir(r.ok, r.ok ? `guia ${r.numero} montada` : r.mensagem)
    if (!r.ok) return

    const guiaId = r.id!
    const [g1] = await db
      .select({
        valorApresentado: guiaTiss.valorApresentado,
        situacao: guiaTiss.situacao,
        numeroCarteirinha: guiaTiss.numeroCarteirinha,
      })
      .from(guiaTiss)
      .where(eq(guiaTiss.id, guiaId))

    conferir(g1!.valorApresentado === '140.00', `total apresentado: ${g1!.valorApresentado}`)
    conferir(g1!.situacao === 'rascunho', 'nasce como rascunho')
    conferir(
      g1!.numeroCarteirinha === `CART-${marcaTempo}`,
      'a carteirinha foi COPIADA na emissão (não é referência)',
    )

    const [travado] = await db
      .select({ guiaTissId: itemPlano.guiaTissId, status: itemPlano.status })
      .from(itemPlano)
      .where(eq(itemPlano.id, itens[0]!))
    conferir(
      travado!.guiaTissId === guiaId && travado!.status === 'faturado',
      'o gancho item_plano.guia_tiss_id foi preenchido — o item sai da fila',
    )

    passo(6, 'Enviar: previsão de repasse é 30 dias do ENVIO')
    const hoje = new Date().toISOString().slice(0, 10)
    await db
      .update(guiaTiss)
      .set({
        situacao: 'enviada',
        enviadaEm: new Date(),
        numeroLote: 'LOTE-DEMO',
        previsaoRepasse: previsaoDeRepasse(hoje, 30),
      })
      .where(eq(guiaTiss.id, guiaId))

    const [g2] = await db
      .select({ previsao: guiaTiss.previsaoRepasse, situacao: guiaTiss.situacao })
      .from(guiaTiss)
      .where(eq(guiaTiss.id, guiaId))
    conferir(g2!.previsao === previsaoDeRepasse(hoje, 30), `previsão: ${g2!.previsao}`)

    passo(7, 'Guia enviada é IMUTÁVEL no que foi apresentado')
    let recusou = false
    try {
      await db
        .update(guiaTiss)
        .set({ valorApresentado: '999.00' })
        .where(eq(guiaTiss.id, guiaId))
    } catch {
      recusou = true
    }
    conferir(recusou, 'o banco recusou alterar o valor de guia enviada')

    // ── Retorno com glosa parcial ────────────────────────────────────────────
    passo(8, 'Operadora paga 70,00 num item e 40,00 no outro: glosa de 30,00')
    const itensGuia = await db
      .select({ id: itemGuia.id, valorApresentado: itemGuia.valorApresentado })
      .from(itemGuia)
      .where(eq(itemGuia.guiaId, guiaId))

    const { registrarRetornoComAtor } = await import('./montar')
    const r1 = await registrarRetornoComAtor(ator, {
      itemGuiaId: itensGuia[0]!.id,
      valorPago: '70.00',
    })
    conferir(r1.ok, r1.ok ? 'primeiro item pago integralmente' : r1.mensagem)

    const semMotivo = await registrarRetornoComAtor(ator, {
      itemGuiaId: itensGuia[1]!.id,
      valorPago: '40.00',
    })
    conferir(
      !semMotivo.ok,
      `glosa SEM motivo é recusada: ${!semMotivo.ok ? semMotivo.mensagem : ''}`,
    )

    const r2 = await registrarRetornoComAtor(ator, {
      itemGuiaId: itensGuia[1]!.id,
      valorPago: '40.00',
      classeGlosa: 'erro_de_envio',
      motivoGlosa: 'Dente divergente do informado na guia',
      codigoOperadora: '1707',
    })
    conferir(r2.ok, r2.ok ? 'segundo item com glosa registrada' : r2.mensagem)

    const [g3] = await db
      .select({ situacao: guiaTiss.situacao })
      .from(guiaTiss)
      .where(eq(guiaTiss.id, guiaId))
    conferir(
      g3!.situacao === 'glosada_parcial',
      `situação derivada dos itens: ${g3!.situacao} (não "paga" — há o que recorrer)`,
    )

    const [gl] = await db
      .select({ id: glosa.id, valor: glosa.valor, classe: glosa.classe })
      .from(glosa)
      .where(eq(glosa.itemGuiaId, itensGuia[1]!.id))
    conferir(gl!.valor === '30.00', `glosa CALCULADA (70 − 40): ${gl!.valor}`)

    passo(9, 'Glosa é imutável e não se apaga')
    let recusouGlosa = false
    try {
      await db.update(glosa).set({ valor: '10.00' }).where(eq(glosa.id, gl!.id))
    } catch {
      recusouGlosa = true
    }
    conferir(recusouGlosa, 'o banco recusou editar a glosa')

    // ── Recurso ──────────────────────────────────────────────────────────────
    passo(10, 'Recorrer da glosa (classe "erro de envio" é recorrível)')
    const { recorrerComAtor } = await import('./montar')
    const rec = await recorrerComAtor(
      ator,
      gl!.id,
      'O dente 36 confere com a radiografia periapical anexa ao prontuário.',
    )
    conferir(rec.ok, rec.ok ? 'recurso registrado' : rec.mensagem)

    const curto = await recorrerComAtor(ator, gl!.id, 'não concordo')
    conferir(!curto.ok, 'recurso sem argumento consistente é recusado')

    // ── Repasse conciliado item a item ───────────────────────────────────────
    passo(11, 'Repasse de 110,00 conciliado item a item')
    const [rep] = await db
      .insert(repasse)
      .values({
        convenioId,
        valorTotal: '110.00',
        recebidoEm: hoje,
        demonstrativo: 'DEMO-1',
        criadoPorId: u!.id,
      })
      .returning({ id: repasse.id })

    const { conciliarComAtor } = await import('./montar')
    const conc = await conciliarComAtor(ator, rep!.id, [
      { itemGuiaId: itensGuia[0]!.id, valor: '70.00' },
      { itemGuiaId: itensGuia[1]!.id, valor: '40.00' },
    ])
    conferir(conc.ok, conc.ok ? '2 itens conciliados' : conc.mensagem)

    const [g4] = await db
      .select({ valorPago: guiaTiss.valorPago, valorApresentado: guiaTiss.valorApresentado })
      .from(guiaTiss)
      .where(eq(guiaTiss.id, guiaId))
    conferir(
      g4!.valorPago === '110.00',
      `o BANCO recalculou o valor pago da guia: ${g4!.valorPago}`,
    )

    passo(12, 'Conciliação confere item a item, não pelo total')
    const paraConciliar = await db
      .select({
        id: itemGuia.id,
        valorApresentado: itemGuia.valorApresentado,
        valorPago: itemGuia.valorPago,
      })
      .from(itemGuia)
      .where(eq(itemGuia.guiaId, guiaId))

    const conciliacao = conciliarRepasse(
      paraConciliar.map((i) => ({
        id: i.id,
        valorApresentado: i.valorApresentado,
        valorPago: i.valorPago,
      })),
    )
    conferir(conciliacao.totalApresentado === '140.00', `apresentado: ${conciliacao.totalApresentado}`)
    conferir(conciliacao.totalPago === '110.00', `pago: ${conciliacao.totalPago}`)
    conferir(conciliacao.totalGlosado === '30.00', `glosado: ${conciliacao.totalGlosado}`)
    conferir(conciliacao.itensPagosIntegralmente === 1, '1 item pago integralmente')
    conferir(conciliacao.itensGlosadosParcialmente === 1, '1 item glosado em parte')

    passo(13, 'Repasse não distribui mais do que recebeu')
    const [rep2] = await db
      .insert(repasse)
      .values({ convenioId, valorTotal: '50.00', recebidoEm: hoje, criadoPorId: u!.id })
      .returning({ id: repasse.id })

    const demais = await conciliarComAtor(ator, rep2!.id, [
      { itemGuiaId: itensGuia[0]!.id, valor: '80.00' },
    ])
    conferir(!demais.ok, `recusado: ${!demais.ok ? demais.mensagem.slice(0, 60) : ''}`)

    passo(14, 'A folha de conferência avisa do que falta para faturar')
    const { folhaDeConferencia, conferirAntesDeEnviar } = await import('./exportar')
    const dados = {
      numero: r.numero!,
      registroAns: '412345',
      convenioNome: `${MARCA} Operadora`,
      numeroLote: 'LOTE-DEMO',
      pacienteNome: `${MARCA} Paciente`,
      pacienteCpf: null,
      pacienteNascimento: '1985-05-05',
      numeroCarteirinha: `CART-${marcaTempo}`,
      profissionalNome: `${MARCA} Dra. Vera`,
      cro: `C${marcaTempo % 100000}`,
      ufCro: 'sp',
      clinicaNome: 'Clínica',
      clinicaCnpj: null,
      emitidaEm: new Date(),
      valorApresentado: '140.00',
      itens: itensGuia.map((i) => ({
        codigoTuss: null,
        descricao: proc!.nome,
        denteFdi: null,
        faces: null,
        quantidade: 1,
        dataExecucao: '2026-09-05',
        valorApresentado: i.valorApresentado,
      })),
    }
    const pendencias = conferirAntesDeEnviar(dados)
    conferir(
      pendencias.some((p) => p.includes('TUSS')),
      'aponta a falta de código TUSS (a dívida da ANS)',
    )
    conferir(
      pendencias.some((p) => p.includes('CNPJ')),
      'aponta a falta de CNPJ da clínica',
    )
    const folha = folhaDeConferencia(dados)
    // O pontilhado fica ENTRE o rótulo e o valor: `CRO .......... SP 54321`.
    conferir(
      /CRO \.+ SP /.test(folha),
      'a folha traz a UF em maiúscula, como o portal exige',
    )
    conferir(folha.includes('!! SEM TUSS'), 'marca visualmente o item sem TUSS')

    console.log(
      '\n\x1b[32m═══ Ciclo do convênio verificado, com os valores conferidos ═══\x1b[0m\n',
    )
  } finally {
    await limpar(pacienteId, u!.id, convenioId)
  }
}

async function limpar(pacienteId: string, usuarioId: string, convenioId: string): Promise<void> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    // Desliga só as triggers de APLICAÇÃO — as de FK ficam de pé. O
    // `session_replication_role` que estava aqui desligava as duas, e já deixou
    // 5 linhas órfãs em movimento_estoque, o que derrubou a 0023. Ver
    // lib/demo/triggers.ts.
    const tabelasDesligadas = await desligarTriggersDeAplicacao(c)
    await c.query(
      `delete from repasse_item where item_guia_id in (
         select ig.id from item_guia ig join guia_tiss g on g.id = ig.guia_id
         where g.paciente_id = $1)`,
      [pacienteId],
    )
    await c.query('delete from repasse where convenio_id = $1', [convenioId])
    await c.query(
      `delete from recurso_glosa where glosa_id in (
         select gl.id from glosa gl join item_guia ig on ig.id = gl.item_guia_id
         join guia_tiss g on g.id = ig.guia_id where g.paciente_id = $1)`,
      [pacienteId],
    )
    await c.query(
      `delete from glosa where item_guia_id in (
         select ig.id from item_guia ig join guia_tiss g on g.id = ig.guia_id
         where g.paciente_id = $1)`,
      [pacienteId],
    )
    await c.query(
      'delete from item_guia where guia_id in (select id from guia_tiss where paciente_id = $1)',
      [pacienteId],
    )
    await c.query('delete from guia_tiss where paciente_id = $1', [pacienteId])
    await c.query(
      `delete from execucao where item_plano_id in (
         select ip.id from item_plano ip join plano_tratamento pt on pt.id = ip.plano_id
         where pt.paciente_id = $1)`,
      [pacienteId],
    )
    await c.query(
      'delete from item_plano where plano_id in (select id from plano_tratamento where paciente_id = $1)',
      [pacienteId],
    )
    await c.query('delete from plano_tratamento where paciente_id = $1', [pacienteId])
    await c.query('delete from paciente_convenio where paciente_id = $1', [pacienteId])
    await c.query('delete from preco_convenio where convenio_id = $1', [convenioId])
    await c.query('delete from audit_log where paciente_id = $1', [pacienteId])
    await c.query('delete from paciente where id = $1', [pacienteId])
    await c.query('delete from convenio where id = $1', [convenioId])
    await c.query('delete from profissional where usuario_id = $1', [usuarioId])
    await c.query('delete from usuario where id = $1', [usuarioId])
    // ANTES do commit: `disable trigger` é DDL — comitar desligado deixaria o
    // prontuário editável para sempre, em silêncio.
    await religarTriggersDeAplicacao(c, tabelasDesligadas)
    await c.query('commit')
    console.log('Dados da demonstração removidos.')
  } catch (e) {
    await c.query('rollback')
    console.error('Falha ao limpar:', e)
  } finally {
    c.release()
  }
}

/**
 * O contexto de clínica é aberto AQUI, envolvendo o `main()` inteiro.
 *
 * Script de linha de comando não tem sessão de onde herdar o tenant, e desde a
 * `drizzle/0022` toda escrita depende de `app.clinica_id` — `app_clinica_id()`
 * estoura sem ele, de propósito, para "esqueci o contexto" não virar linha gravada
 * na clínica errada.
 *
 * Envolver no ponto de entrada, e não dentro de `main()`, é de propósito: qualquer
 * função que `main()` chame, hoje ou amanhã, herda o contexto pelo
 * `AsyncLocalStorage`. Espalhar `comContextoDeClinica` por dentro deixaria brecha
 * na próxima função acrescentada.
 */
idDaPrimeiraClinica()
  .then((clinicaId) => comContextoDeClinica(clinicaId, main))
  .then(async () => {
    await pool.end()
    process.exit(falhas > 0 ? 1 : 0)
  })
  .catch(async (e) => {
    console.error(e)
    await pool.end()
    process.exit(1)
  })
