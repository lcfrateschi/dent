import { registrar } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { convenio, pacienteConvenio, precoConvenio, procedimento } from '@/lib/db/schema'
import { encaixarVigencia } from '@/lib/domain/administracao'
import { cnpjEhValido, normalizarCnpj } from '@/lib/domain/cnpj'
import { apenasDigitos } from '@/lib/domain/cpf'
import { paraCentavos } from '@/lib/domain/dinheiro'
import { and, eq } from 'drizzle-orm'

/**
 * Cadastro de operadora, tabela negociada e carteirinha.
 * **Núcleo, sem `'use server'`.**
 *
 * A parte delicada é a tabela negociada, por causa de uma decisão fechada: **o
 * preço faturado é o da DATA DA EXECUÇÃO**, nunca o vigente hoje. Isso tem duas
 * consequências que a tela precisa respeitar, e não são intuitivas:
 *
 * 1. **Reajuste não é edição.** Mudar o valor de uma linha existente reescreve o
 *    que já foi apresentado à operadora, e a conciliação do repasse passa a não
 *    fechar sem que nada indique por quê. Reajuste é linha nova, e a vigência
 *    anterior é fechada no dia anterior — automaticamente, porque pedir as duas
 *    datas à pessoa produz um dia sem preço ou, pior, dois preços válidos.
 *
 * 2. **Preço já faturado não se apaga.** Ele é o histórico do que foi
 *    apresentado. `drizzle/0021` recusa; aqui a mensagem explica.
 */

export type ResultadoCadastro =
  | { readonly ok: true; readonly mensagem: string; readonly id?: string }
  | { readonly ok: false; readonly mensagem: string }

// ── Operadora ─────────────────────────────────────────────────────────────────

export interface DadosDoConvenio {
  readonly nome: string
  readonly registroAns?: string
  /**
   * O código DESTA clínica NESTA operadora, como a operadora o atribuiu.
   *
   * Sem validação de formato de propósito, ao contrário do CNES e do registro ANS:
   * cada operadora usa o seu, com letras, hífen e tamanhos diferentes. Um formato
   * inventado por nós recusaria dado legítimo do cliente — e o erro apareceria como
   * "código inválido" para um código que a operadora emitiu.
   */
  readonly codigoPrestador?: string
  readonly cnpj?: string
  readonly prazoPagamentoDias?: number
  readonly diaFechamento?: number
  readonly contatoNome?: string
  readonly contatoTelefone?: string
  readonly observacoes?: string
}

export async function salvarConvenioComAtor(
  ator: Ator,
  dados: DadosDoConvenio,
  id?: string,
): Promise<ResultadoCadastro> {
  const nome = dados.nome?.trim()
  if (!nome || nome.length < 2) return { ok: false, mensagem: 'Informe o nome da operadora.' }

  const cnpj = dados.cnpj ? normalizarCnpj(dados.cnpj) : ''
  if (cnpj && !cnpjEhValido(cnpj)) {
    return { ok: false, mensagem: 'CNPJ inválido (dígitos verificadores não conferem).' }
  }

  const registro = dados.registroAns ? apenasDigitos(dados.registroAns) : ''
  if (registro && (registro.length < 5 || registro.length > 6)) {
    // O registro ANS da operadora tem 5 ou 6 dígitos e vai no XML TISS. Um
    // registro errado invalida o lote inteiro na recepção da operadora.
    return { ok: false, mensagem: 'Registro ANS deve ter 5 ou 6 dígitos.' }
  }

  const prazo = dados.prazoPagamentoDias ?? 30
  if (!Number.isInteger(prazo) || prazo < 1 || prazo > 180) {
    return { ok: false, mensagem: 'Prazo de pagamento deve ser entre 1 e 180 dias.' }
  }

  const dia = dados.diaFechamento
  if (dia !== undefined && dia !== null && (!Number.isInteger(dia) || dia < 1 || dia > 31)) {
    return { ok: false, mensagem: 'Dia de fechamento deve ser entre 1 e 31.' }
  }

  const valores = {
    nome,
    registroAns: registro || null,
    codigoPrestador: dados.codigoPrestador?.trim() || null,
    cnpj: cnpj || null,
    prazoPagamentoDias: prazo,
    diaFechamento: dia ?? null,
    contatoNome: dados.contatoNome?.trim() || null,
    contatoTelefone: dados.contatoTelefone ? apenasDigitos(dados.contatoTelefone) : null,
    observacoes: dados.observacoes?.trim() || null,
  }

  try {
    if (id) {
      await db.update(convenio).set(valores).where(eq(convenio.id, id))
      await registrar({ ator, acao: 'atualizacao', entidade: 'convenio', entidadeId: id, detalhes: { nome } })
      return { ok: true, id, mensagem: `${nome} atualizada.` }
    }
    const [nova] = await db.insert(convenio).values(valores).returning({ id: convenio.id })
    await registrar({ ator, acao: 'criacao', entidade: 'convenio', entidadeId: nova?.id, detalhes: { nome } })
    return { ok: true, id: nova?.id, mensagem: `${nome} cadastrada. Agora informe a tabela negociada.` }
  } catch (e) {
    if (bruto(e).includes('convenio_nome_unique')) {
      return { ok: false, mensagem: 'Já existe operadora com esse nome.' }
    }
    return { ok: false, mensagem: 'Não foi possível salvar a operadora.' }
  }
}

/**
 * Desativa a operadora. Nunca apaga: guia, repasse e carteirinha apontam para
 * ela, e o histórico de faturamento é a prova do que foi apresentado.
 */
export async function alternarConvenioComAtor(
  ator: Ator,
  id: string,
  ativo: boolean,
): Promise<ResultadoCadastro> {
  await db.update(convenio).set({ ativo }).where(eq(convenio.id, id))
  await registrar({ ator, acao: 'atualizacao', entidade: 'convenio', entidadeId: id, detalhes: { ativo } })
  return {
    ok: true,
    id,
    mensagem: ativo
      ? 'Operadora reativada.'
      : 'Operadora desativada. O histórico de guias e repasses permanece.',
  }
}

// ── Tabela negociada ──────────────────────────────────────────────────────────

export interface DadosDoPreco {
  readonly convenioId: string
  readonly procedimentoId: string
  readonly valor: string
  readonly coberturaPct?: string
  readonly carenciaDias?: number
  readonly vigenciaInicio: string
  readonly vigenciaFim?: string | null
}

/**
 * Cadastra um preço negociado, fechando a vigência anterior quando é reajuste.
 *
 * As duas operações vão na mesma transação **nesta ordem**: fecha a antiga,
 * insere a nova. Na ordem inversa, a EXCLUDE constraint de `drizzle/0021`
 * recusaria — as duas vigências se sobreporiam por um instante. É um caso em que
 * a trava do banco dita a ordem do código, e isso é bom: a alternativa seria
 * descobrir a sobreposição meses depois, na conciliação.
 */
export async function salvarPrecoComAtor(
  ator: Ator,
  dados: DadosDoPreco,
): Promise<ResultadoCadastro> {
  if (paraCentavos(dados.valor) < 0) {
    return { ok: false, mensagem: 'Valor não pode ser negativo.' }
  }
  const cobertura = Number(dados.coberturaPct ?? '100')
  if (!Number.isFinite(cobertura) || cobertura < 0 || cobertura > 100) {
    return { ok: false, mensagem: 'Cobertura deve ser um percentual entre 0 e 100.' }
  }
  const carencia = dados.carenciaDias ?? 0
  if (!Number.isInteger(carencia) || carencia < 0 || carencia > 3650) {
    return { ok: false, mensagem: 'Carência deve ser em dias, de 0 a 3650.' }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dados.vigenciaInicio)) {
    return { ok: false, mensagem: 'Informe a data de início da vigência.' }
  }

  const existentes = await db
    .select({
      id: precoConvenio.id,
      vigenciaInicio: precoConvenio.vigenciaInicio,
      vigenciaFim: precoConvenio.vigenciaFim,
    })
    .from(precoConvenio)
    .where(
      and(
        eq(precoConvenio.convenioId, dados.convenioId),
        eq(precoConvenio.procedimentoId, dados.procedimentoId),
      ),
    )

  const encaixe = encaixarVigencia(existentes, {
    vigenciaInicio: dados.vigenciaInicio,
    vigenciaFim: dados.vigenciaFim ?? null,
  })
  if (!encaixe.ok) return { ok: false, mensagem: encaixe.motivo }

  try {
    const id = await db.transaction(async (tx) => {
      if (encaixe.fechar) {
        await tx
          .update(precoConvenio)
          .set({ vigenciaFim: encaixe.fechar.em })
          .where(eq(precoConvenio.id, encaixe.fechar.id))
      }
      const [novo] = await tx
        .insert(precoConvenio)
        .values({
          convenioId: dados.convenioId,
          procedimentoId: dados.procedimentoId,
          valor: dados.valor,
          coberturaPct: cobertura.toFixed(2),
          carenciaDias: carencia,
          vigenciaInicio: dados.vigenciaInicio,
          vigenciaFim: dados.vigenciaFim ?? null,
        })
        .returning({ id: precoConvenio.id })
      return novo?.id
    })

    const [proc] = await db
      .select({ nome: procedimento.nome })
      .from(procedimento)
      .where(eq(procedimento.id, dados.procedimentoId))
      .limit(1)

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'preco_convenio',
      entidadeId: id,
      detalhes: {
        convenioId: dados.convenioId,
        procedimento: proc?.nome ?? null,
        valor: dados.valor,
        vigenciaInicio: dados.vigenciaInicio,
        fechouAnterior: encaixe.fechar?.em ?? null,
      },
    })

    return {
      ok: true,
      id,
      mensagem: encaixe.fechar
        ? `Preço cadastrado. A vigência anterior foi fechada em ${encaixe.fechar.em}.`
        : 'Preço cadastrado.',
    }
  } catch (e) {
    const b = bruto(e)
    if (b.includes('preco_convenio_sem_sobreposicao')) {
      return {
        ok: false,
        mensagem:
          'Já existe preço vigente nesse período. Dois preços válidos no mesmo dia tornariam ' +
          'indefinido o valor a faturar.',
      }
    }
    return { ok: false, mensagem: 'Não foi possível cadastrar o preço.' }
  }
}

/** Fecha uma vigência aberta — o caso de "não atendemos mais este procedimento". */
export async function fecharVigenciaComAtor(
  ator: Ator,
  precoId: string,
  em: string,
): Promise<ResultadoCadastro> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(em)) return { ok: false, mensagem: 'Informe a data de fim.' }
  try {
    await db.update(precoConvenio).set({ vigenciaFim: em }).where(eq(precoConvenio.id, precoId))
    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'preco_convenio',
      entidadeId: precoId,
      detalhes: { vigenciaFim: em },
    })
    return { ok: true, id: precoId, mensagem: `Vigência fechada em ${em}.` }
  } catch (e) {
    const b = bruto(e)
    if (b.includes('não se altera')) {
      return { ok: false, mensagem: 'Só a data de fim pode ser alterada num preço já cadastrado.' }
    }
    return { ok: false, mensagem: 'Não foi possível fechar a vigência.' }
  }
}

/** Apaga um preço — só enquanto nada foi faturado sob ele (erro de digitação). */
export async function apagarPrecoComAtor(ator: Ator, precoId: string): Promise<ResultadoCadastro> {
  try {
    await db.delete(precoConvenio).where(eq(precoConvenio.id, precoId))
    await registrar({ ator, acao: 'exclusao', entidade: 'preco_convenio', entidadeId: precoId })
    return { ok: true, mensagem: 'Preço removido.' }
  } catch (e) {
    if (bruto(e).includes('já foi usado em')) {
      return {
        ok: false,
        mensagem:
          'Este preço já foi usado em guia: ele é o histórico do que foi apresentado à operadora. ' +
          'Feche a vigência em vez de apagar.',
      }
    }
    return { ok: false, mensagem: 'Não foi possível remover o preço.' }
  }
}

// ── Carteirinha do paciente ───────────────────────────────────────────────────

export interface DadosDaCarteirinha {
  readonly pacienteId: string
  readonly convenioId: string
  readonly numeroCarteirinha: string
  readonly plano?: string
  readonly ehTitular?: boolean
  readonly nomeTitular?: string
  readonly adesaoEm?: string
  readonly validade?: string
}

/**
 * Vincula o paciente a um convênio.
 *
 * `adesaoEm` não é enfeite: é dela que sai a contagem de **carência**. Sem a data
 * de adesão, `avaliarElegibilidade` não consegue dizer se o procedimento está
 * coberto, e o resultado aparece como glosa por carência semanas depois.
 */
export async function salvarCarteirinhaComAtor(
  ator: Ator,
  dados: DadosDaCarteirinha,
  id?: string,
): Promise<ResultadoCadastro> {
  const numero = dados.numeroCarteirinha?.trim()
  if (!numero) return { ok: false, mensagem: 'Informe o número da carteirinha.' }

  const ehTitular = dados.ehTitular ?? true
  if (!ehTitular && !dados.nomeTitular?.trim()) {
    // Dependente sem titular nomeado: a operadora recusa a guia, porque o
    // contrato está no nome de outra pessoa.
    return { ok: false, mensagem: 'Dependente exige o nome do titular do plano.' }
  }

  const valores = {
    pacienteId: dados.pacienteId,
    convenioId: dados.convenioId,
    numeroCarteirinha: numero,
    plano: dados.plano?.trim() || null,
    ehTitular,
    nomeTitular: ehTitular ? null : (dados.nomeTitular?.trim() ?? null),
    adesaoEm: dados.adesaoEm || null,
    validade: dados.validade || null,
  }

  try {
    if (id) {
      await db.update(pacienteConvenio).set(valores).where(eq(pacienteConvenio.id, id))
      await registrar({
        ator,
        acao: 'atualizacao',
        entidade: 'paciente_convenio',
        entidadeId: id,
        pacienteId: dados.pacienteId,
        detalhes: { convenioId: dados.convenioId },
      })
      return { ok: true, id, mensagem: 'Carteirinha atualizada.' }
    }

    const [nova] = await db
      .insert(pacienteConvenio)
      .values(valores)
      .returning({ id: pacienteConvenio.id })
    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'paciente_convenio',
      entidadeId: nova?.id,
      pacienteId: dados.pacienteId,
      detalhes: { convenioId: dados.convenioId },
    })
    return { ok: true, id: nova?.id, mensagem: 'Carteirinha cadastrada.' }
  } catch (e) {
    const b = bruto(e)
    if (b.includes('paciente_convenio_uma_ativa_uk')) {
      return {
        ok: false,
        mensagem:
          'Este paciente já tem carteirinha ativa nesta operadora. Inative a anterior antes — ' +
          'duas ativas tornariam indefinido qual número vai na guia.',
      }
    }
    if (b.includes('paciente_convenio_carteirinha_uk')) {
      return { ok: false, mensagem: 'Este número de carteirinha já está cadastrado nesta operadora.' }
    }
    return { ok: false, mensagem: 'Não foi possível salvar a carteirinha.' }
  }
}

export async function alternarCarteirinhaComAtor(
  ator: Ator,
  id: string,
  ativo: boolean,
): Promise<ResultadoCadastro> {
  const [linha] = await db
    .select({ pacienteId: pacienteConvenio.pacienteId })
    .from(pacienteConvenio)
    .where(eq(pacienteConvenio.id, id))
    .limit(1)

  try {
    await db.update(pacienteConvenio).set({ ativo }).where(eq(pacienteConvenio.id, id))
  } catch (e) {
    if (bruto(e).includes('paciente_convenio_uma_ativa_uk')) {
      return {
        ok: false,
        mensagem: 'Já existe outra carteirinha ativa deste paciente nesta operadora.',
      }
    }
    throw e
  }

  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'paciente_convenio',
    entidadeId: id,
    pacienteId: linha?.pacienteId ?? null,
    detalhes: { ativo },
  })
  return { ok: true, id, mensagem: ativo ? 'Carteirinha reativada.' : 'Carteirinha inativada.' }
}

function bruto(e: unknown): string {
  const partes: string[] = []
  let atual: unknown = e
  for (let i = 0; i < 5 && atual instanceof Error; i++) {
    partes.push(atual.message)
    atual = (atual as { cause?: unknown }).cause
  }
  return partes.join(' | ')
}
