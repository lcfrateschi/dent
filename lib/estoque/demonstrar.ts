import { gerarHashSenha } from '@/lib/auth/senha'
import type { Ator } from '@/lib/authz/sessao'
import { db, pool } from '@/lib/db'
import {
  execucao,
  insumoProcedimento,
  itemPlano,
  loteMaterial,
  material,
  movimentoEstoque,
  paciente,
  planoTratamento,
  procedimento,
  profissional,
  usuario,
} from '@/lib/db/schema'
import { avaliarReposicao, classificarValidade, consolidarInsumos } from '@/lib/domain/estoque'
import { addDias } from '@/lib/domain/datas'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import {
  consumoDoMaterial,
  lotesDoMaterial,
  lotesVencendo,
  pacientesQueReceberamOLote,
  posicaoDeEstoque,
} from './consultas'
import {
  ajustarInventarioComAtor,
  darBaixaComAtor,
  descartarLoteComAtor,
  registrarEntradaComAtor,
} from './movimentar'
import { eq, sql } from 'drizzle-orm'

/**
 * Demonstração da Fase 14 contra o Postgres.
 *
 *   npm run estoque:demo
 *
 * Prova o que a tela promete, com números conferidos à mão:
 *
 *   entrada por embalagem → FEFO atravessando lotes → lote vencido recusado →
 *   descarte → contagem de inventário → alerta de mínimo → rastreabilidade
 *   (lote recolhido → paciente) → append-only
 *
 * O caso que mais importa é o **FEFO**: um lote comprado depois, mas que vence
 * antes, tem de sair primeiro. É a diferença entre estoque controlado e material
 * vencendo na prateleira com saldo — e é o tipo de coisa que passa em teste
 * unitário e falha no banco, porque a ordenação real depende do índice.
 */

const MARCA = 'EST-DEMO'
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
  console.log('\n═══ Fase 14: estoque, com FEFO e rastreabilidade conferidos ═══')

  const t = Date.now()
  const hoje = await hojeDaClinica()

  // Usuário e profissional na MESMA transação: a trava deferida de
  // `drizzle/0021` cobra no commit que dentista ativo tenha cadastro de
  // profissional, e dois inserts soltos comitam separado.
  const { u, prof } = await db.transaction(async (tx) => {
    const [novoUsuario] = await tx
      .insert(usuario)
      .values({
        nome: `${MARCA} Dra. Rita`,
        email: `est-${t}@local`,
        senhaHash: await gerarHashSenha('x'.repeat(20)),
        perfil: 'dentista',
      })
      .returning({ id: usuario.id })
    const [novoProf] = await tx
      .insert(profissional)
      .values({ usuarioId: novoUsuario!.id, cro: `E${t % 100000}`, ufCro: 'SP' })
      .returning({ id: profissional.id })
    return { u: novoUsuario, prof: novoProf }
  })

  const ator: Ator = {
    usuarioId: u!.id,
    nome: `${MARCA} Dra. Rita`,
    email: 'est@local',
    perfil: 'dentista',
    profissionalId: prof!.id,
  }

  const [pac] = await db
    .insert(paciente)
    .values({ nome: `${MARCA} Paciente`, dataNascimento: '1990-03-03' })
    .returning({ id: paciente.id })
  const pacienteId = pac!.id

  const [luva] = await db
    .insert(material)
    .values({
      codigo: `${MARCA}-LUVA-${t}`,
      nome: `${MARCA} Luva de procedimento`,
      categoria: 'descartavel',
      unidade: 'par',
      unidadesPorEmbalagem: 50,
      embalagem: 'caixa com 100 unidades (50 pares)',
      quantidadeMinima: '30',
    })
    .returning({ id: material.id })
  const luvaId = luva!.id

  const [implante] = await db
    .insert(material)
    .values({
      codigo: `${MARCA}-IMPL-${t}`,
      nome: `${MARCA} Implante de titânio`,
      categoria: 'cirurgia',
      unidade: 'unidade',
      quantidadeMinima: '2',
      exigeLoteDoFabricante: true,
    })
    .returning({ id: material.id })
  const implanteId = implante!.id

  try {
    // ── 1. Entrada por embalagem ─────────────────────────────────────────────
    passo(1, 'Recebimento de 2 caixas de luva (50 pares cada) — lançado como EMBALAGEM')
    const entrada = await registrarEntradaComAtor(ator, {
      materialId: luvaId,
      quantidade: '2',
      porEmbalagem: true,
      custoUnitario: '1.20',
      validade: addDias(hoje, 400),
      codigoFabricante: 'CX-LONGE',
      notaFiscal: 'NF-1001',
      recebidoEm: hoje,
    })
    conferir(entrada.ok, entrada.mensagem)

    const [saldo1] = await db
      .select({ saldo: sql<string>`coalesce(sum(saldo),0)::text` })
      .from(loteMaterial)
      .where(eq(loteMaterial.materialId, luvaId))
    conferir(
      saldo1?.saldo === '100.000',
      `2 embalagens × 50 = 100 pares no saldo (lançar "2" daria 2 — obtido ${saldo1?.saldo})`,
    )

    // ── 2. FEFO: lote recebido DEPOIS, vencendo ANTES ───────────────────────
    passo(2, 'Nova compra, recebida hoje, mas com validade CURTA (fornecedor escoando estoque)')
    const entradaCurta = await registrarEntradaComAtor(ator, {
      materialId: luvaId,
      quantidade: '20',
      custoUnitario: '1.50',
      validade: addDias(hoje, 25),
      codigoFabricante: 'CX-CURTO',
      recebidoEm: hoje,
    })
    conferir(entradaCurta.ok, entradaCurta.mensagem)

    const lotes = await lotesDoMaterial(luvaId, { apenasComSaldo: true })
    conferir(
      lotes[0]?.codigoFabricante === 'CX-CURTO',
      `a fila de saída começa pelo lote que vence primeiro (${lotes[0]?.codigoFabricante})`,
    )
    conferir(
      lotes[1]?.codigoFabricante === 'CX-LONGE',
      'e o lote de validade longa fica atrás, mesmo tendo chegado antes',
    )

    // ── 3. Baixa atravessando dois lotes ────────────────────────────────────
    passo(3, 'Consumo de 30 pares: o lote curto tem 20, então a baixa atravessa dois lotes')
    const baixa = await darBaixaComAtor(ator, {
      materialId: luvaId,
      quantidade: '30',
      tipo: 'consumo',
    })
    conferir(baixa.ok, baixa.mensagem)
    conferir(
      (baixa.ok ? baixa.ids?.length : 0) === 2,
      'gerou DOIS movimentos, um por lote — é o que preserva a rastreabilidade',
    )

    const depois = await lotesDoMaterial(luvaId, { apenasComSaldo: true })
    conferir(
      depois.length === 1 && depois[0]?.codigoFabricante === 'CX-LONGE',
      'o lote curto zerou primeiro; sobrou só o de validade longa',
    )
    conferir(
      depois[0]?.saldo === '90.000',
      `sobraram 90 no lote longo (100 − 10) — obtido ${depois[0]?.saldo}`,
    )

    // ── 4. Lote vencido: consumo recusado, descarte aceito ──────────────────
    passo(4, 'Lote que JÁ venceu: o banco recusa consumo e aceita descarte')
    const [loteVencido] = await db
      .insert(loteMaterial)
      .values({
        materialId: luvaId,
        codigoFabricante: 'CX-VENCIDA',
        validade: addDias(hoje, -10),
        custoUnitario: '1.20',
        recebidoEm: addDias(hoje, -400),
        criadoPorId: ator.usuarioId,
      })
      .returning({ id: loteMaterial.id })
    await db.insert(movimentoEstoque).values({
      loteId: loteVencido!.id,
      materialId: luvaId,
      tipo: 'entrada',
      quantidade: '15.000',
      custoUnitario: '1.20',
      registradoPorId: ator.usuarioId,
    })

    const consumoDoVencido = await darBaixaComAtor(ator, {
      materialId: luvaId,
      quantidade: '100',
      tipo: 'consumo',
    })
    conferir(
      !consumoDoVencido.ok && consumoDoVencido.mensagem.includes('vencido'),
      'pedir mais do que há de material bom NÃO cai no lote vencido — a mensagem avisa dele',
    )

    const avaliacao = classificarValidade(addDias(hoje, -10), hoje)
    conferir(
      avaliacao.situacao === 'vencido' && avaliacao.rotulo === 'vencido há 10 dias',
      `o domínio classifica igual ao banco: "${avaliacao.rotulo}"`,
    )

    const descarte = await descartarLoteComAtor(
      ator,
      loteVencido!.id,
      'vencido — descarte conferido na contagem',
    )
    conferir(descarte.ok, descarte.mensagem)

    const [saldoVencido] = await db
      .select({ saldo: loteMaterial.saldo })
      .from(loteMaterial)
      .where(eq(loteMaterial.id, loteVencido!.id))
    conferir(saldoVencido?.saldo === '0.000', 'o lote vencido foi a zero pelo descarte, com motivo no livro')

    // ── 5. Contagem de inventário ───────────────────────────────────────────
    passo(5, 'Contagem física acha 88 onde o sistema diz 90')
    const ajuste = await ajustarInventarioComAtor(ator, {
      loteId: depois[0]!.id,
      quantidadeContada: '88',
      motivo: 'contagem mensal — 2 pares danificados na caixa',
    })
    conferir(ajuste.ok && ajuste.mensagem.includes('falta de 2.000'), ajuste.mensagem)

    const semMotivo = await ajustarInventarioComAtor(ator, {
      loteId: depois[0]!.id,
      quantidadeContada: '80',
      motivo: '   ',
    })
    conferir(
      !semMotivo.ok,
      'ajuste sem motivo é recusado: perda e erro de lançamento não podem ficar indistinguíveis',
    )

    // ── 6. Alerta de mínimo ─────────────────────────────────────────────────
    passo(6, 'Consumo derruba o saldo abaixo do mínimo (30) e o alerta aparece')
    const grande = await darBaixaComAtor(ator, {
      materialId: luvaId,
      quantidade: '70',
      tipo: 'consumo',
    })
    conferir(grande.ok, grande.mensagem)

    const posicao = await posicaoDeEstoque({ apenasAtencao: true })
    const linhaLuva = posicao.find((l) => l.materialId === luvaId)
    conferir(
      linhaLuva?.reposicao.situacao === 'abaixo_do_minimo',
      `luva entrou na lista de reposição com saldo ${linhaLuva?.saldo} contra mínimo ${linhaLuva?.quantidadeMinima}`,
    )
    conferir(
      linhaLuva?.reposicao.sugestaoDeCompra === '42.000',
      `sugestão repõe ao DOBRO do mínimo: 60 − 18 = 42 (obtido ${linhaLuva?.reposicao.sugestaoDeCompra})`,
    )

    const conferencia = avaliarReposicao('18.000', '30.000')
    conferir(
      conferencia.sugestaoDeCompra === '42.000',
      'e o domínio, chamado direto, dá o mesmo número — a tela não tem regra própria',
    )

    // ── 7. Validade próxima com valor em risco ──────────────────────────────
    passo(7, 'Lote vencendo em 20 dias entra no alerta de validade, com o valor em risco')
    const entradaVencendo = await registrarEntradaComAtor(ator, {
      materialId: luvaId,
      quantidade: '10',
      custoUnitario: '2.00',
      validade: addDias(hoje, 20),
      codigoFabricante: 'CX-VENCE-EM-20',
      recebidoEm: hoje,
    })
    conferir(entradaVencendo.ok, entradaVencendo.mensagem)

    const vencendo = await lotesVencendo(60)
    const alerta = vencendo.find((l) => l.codigoFabricante === 'CX-VENCE-EM-20')
    conferir(alerta !== undefined, 'o lote apareceu na lista de validade')
    conferir(
      alerta?.avaliacao.situacao === 'vence_em_breve' && alerta?.avaliacao.rotulo === 'vence em 20 dias',
      `com o rótulo certo: "${alerta?.avaliacao.rotulo}"`,
    )
    conferir(
      alerta?.valorEmRisco === '20.00',
      `e o valor em risco é 10 × R$ 2,00 = R$ 20,00 (obtido ${alerta?.valorEmRisco}) — "3 lotes vencendo" não move ninguém; R$ 20 em risco move`,
    )

    // Zerado por descarte, ele SAI da lista: alerta que persiste depois de
    // resolvido é alerta que a clínica aprende a ignorar.
    const descarteDoAlerta = await descartarLoteComAtor(
      ator,
      alerta!.loteId,
      'descarte preventivo — demonstração',
    )
    conferir(descarteDoAlerta.ok, descarteDoAlerta.mensagem)
    const depoisDoDescarte = await lotesVencendo(60)
    conferir(
      !depoisDoDescarte.some((l) => l.codigoFabricante === 'CX-VENCE-EM-20'),
      'lote zerado não polui mais a lista de validade',
    )

    // ── 8. Rastreabilidade: lote recolhido → paciente ───────────────────────
    passo(8, 'Implante consumido numa execução: o recolhimento do lote responde o paciente')
    const [proc] = await db
      .select({ id: procedimento.id, nome: procedimento.nome })
      .from(procedimento)
      .where(eq(procedimento.codigo, 'IMP-001'))
      .limit(1)

    const [plano] = await db
      .insert(planoTratamento)
      .values({
        pacienteId,
        profissionalId: prof!.id,
        status: 'ativo',
        titulo: `${MARCA} Plano`,
      })
      .returning({ id: planoTratamento.id })

    const [item] = await db
      .insert(itemPlano)
      .values({
        planoId: plano!.id,
        procedimentoId: proc!.id,
        valor: '3200.00',
        denteFdi: 36,
        status: 'executado',
      })
      .returning({ id: itemPlano.id })

    const [exec] = await db
      .insert(execucao)
      .values({
        itemPlanoId: item!.id,
        profissionalId: prof!.id,
        executadoEm: new Date(),
      })
      .returning({ id: execucao.id })

    const entradaImplante = await registrarEntradaComAtor(ator, {
      materialId: implanteId,
      quantidade: '3',
      custoUnitario: '900.00',
      codigoFabricante: 'LOTE-RECOLHIDO-2026',
      validade: addDias(hoje, 900),
      recebidoEm: hoje,
    })
    conferir(entradaImplante.ok, entradaImplante.mensagem)

    const semLote = await registrarEntradaComAtor(ator, {
      materialId: implanteId,
      quantidade: '1',
      custoUnitario: '900.00',
      recebidoEm: hoje,
    })
    conferir(
      !semLote.ok && semLote.mensagem.includes('lote do fabricante'),
      'implante SEM número de lote é recusado pelo banco — sem ele o recolhimento não tem resposta',
    )

    const consumoImplante = await darBaixaComAtor(ator, {
      materialId: implanteId,
      quantidade: '1',
      tipo: 'consumo',
      execucaoId: exec!.id,
      profissionalId: prof!.id,
    })
    conferir(consumoImplante.ok, consumoImplante.mensagem)

    const lotesImplante = await lotesDoMaterial(implanteId, { apenasComSaldo: true })
    const recebedores = await pacientesQueReceberamOLote(lotesImplante[0]!.id)
    conferir(
      recebedores.some((r) => r.pacienteId === pacienteId),
      `o lote recolhido aponta para ${recebedores.length} paciente(s) — o do demo entre eles`,
    )
    conferir(
      recebedores[0]?.procedimentoNome === proc!.nome,
      `e diz em que procedimento foi usado: ${recebedores[0]?.procedimentoNome}`,
    )

    // ── 9. Ficha técnica propõe a baixa ─────────────────────────────────────
    passo(9, 'Ficha técnica: o que o procedimento consome, consolidado')
    await db.insert(insumoProcedimento).values([
      { procedimentoId: proc!.id, materialId: luvaId, quantidade: '2' },
      { procedimentoId: proc!.id, materialId: implanteId, quantidade: '1' },
    ])
    const consolidado = consolidarInsumos([
      [
        { materialId: luvaId, quantidade: '2' },
        { materialId: implanteId, quantidade: '1' },
      ],
      [{ materialId: luvaId, quantidade: '2' }],
    ])
    const luvaConsolidada = consolidado.find((i) => i.materialId === luvaId)
    conferir(
      luvaConsolidada?.quantidade === '4.000',
      `dois procedimentos na mesma sessão somam a luva: ${luvaConsolidada?.quantidade}`,
    )

    // ── 10. Consumo médio e cobertura ───────────────────────────────────────
    passo(10, 'Consumo médio e dias de cobertura')
    const consumo = await consumoDoMaterial(luvaId, 30)
    conferir(
      Number(consumo.consumoMedioDiario) > 0,
      `média de ${consumo.consumoMedioDiario} par/dia nos últimos 30 dias`,
    )
    conferir(
      consumo.diasDeCobertura !== null,
      `cobertura estimada de ${consumo.diasDeCobertura} dias com o saldo atual`,
    )

    // ── 11. O livro não se apaga ────────────────────────────────────────────
    passo(11, 'Append-only: nem UPDATE nem DELETE no livro de movimentos')
    let recusouUpdate = false
    try {
      await db
        .update(movimentoEstoque)
        .set({ quantidade: '-999.000' })
        .where(eq(movimentoEstoque.materialId, luvaId))
    } catch {
      recusouUpdate = true
    }
    conferir(recusouUpdate, 'UPDATE em movimento é recusado pela trigger de 0019')

    let recusouDelete = false
    try {
      await db.delete(movimentoEstoque).where(eq(movimentoEstoque.materialId, luvaId))
    } catch {
      recusouDelete = true
    }
    conferir(recusouDelete, 'DELETE também — a correção é ajuste em sentido contrário')

    let recusouSaldo = false
    try {
      await db.update(loteMaterial).set({ saldo: '999.000' }).where(eq(loteMaterial.materialId, luvaId))
    } catch {
      recusouSaldo = true
    }
    conferir(recusouSaldo, 'e saldo digitado à mão é recusado: ele é derivado dos movimentos')

    console.log('\n\x1b[32m═══ Fase 14 verificada contra o Postgres ═══\x1b[0m')
    console.log('\nO que ficou provado, e não só executado:')
    console.log('  • entrada por embalagem grava a quantidade de consumo, não a de compra')
    console.log('  • FEFO sai pelo que vence primeiro, mesmo tendo chegado depois')
    console.log('  • baixa que atravessa lotes gera um movimento por lote')
    console.log('  • lote vencido não é consumido; é descartado com motivo')
    console.log('  • contagem ajusta pelo que foi contado, com motivo obrigatório')
    console.log('  • o mínimo sugere reposição ao dobro, não ao próprio mínimo')
    console.log('  • lote recolhido responde em qual paciente foi usado')
    console.log('  • o livro do estoque não se altera nem se apaga')
  } finally {
    await limpar(pacienteId, u!.id, [luvaId, implanteId])
  }
}

/**
 * Remove o que a demonstração criou.
 *
 * `session_replication_role = 'replica'` desliga as triggers de usuário na
 * sessão, o que é a ÚNICA forma de apagar `movimento_estoque` — que é append-only
 * de propósito. Vale para o script de demonstração; a aplicação nunca faz isso.
 */
async function limpar(
  pacienteId: string,
  usuarioId: string,
  materiaisIds: readonly string[],
): Promise<void> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query("set local session_replication_role = 'replica'")
    await c.query('delete from movimento_estoque where material_id = any($1::uuid[])', [materiaisIds])
    await c.query('delete from lote_material where material_id = any($1::uuid[])', [materiaisIds])
    await c.query('delete from insumo_procedimento where material_id = any($1::uuid[])', [materiaisIds])
    await c.query('delete from material where id = any($1::uuid[])', [materiaisIds])
    await c.query(
      `delete from execucao where item_plano_id in
         (select i.id from item_plano i join plano_tratamento pt on pt.id = i.plano_id
           where pt.paciente_id = $1)`,
      [pacienteId],
    )
    await c.query(
      'delete from item_plano where plano_id in (select id from plano_tratamento where paciente_id = $1)',
      [pacienteId],
    )
    await c.query('delete from plano_tratamento where paciente_id = $1', [pacienteId])
    await c.query('delete from audit_log where paciente_id = $1', [pacienteId])
    await c.query('delete from audit_log where ator_id = $1', [usuarioId])
    await c.query('delete from paciente where id = $1', [pacienteId])
    await c.query('delete from profissional where usuario_id = $1', [usuarioId])
    await c.query('delete from usuario where id = $1', [usuarioId])
    await c.query('commit')
    console.log('\nDados da demonstração removidos.')
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
    process.exit(falhas > 0 ? 1 : 0)
  })
  .catch(async (e) => {
    console.error(e)
    await pool.end()
    process.exit(1)
  })
