import type { Ator } from '@/lib/authz/sessao'
import { formatarCnpj } from '@/lib/domain/cnpj'
import { db } from '@/lib/db'
import { clinica, documento, orcamento, paciente, profissional, usuario } from '@/lib/db/schema'
import { formatarCpf, formatarTelefone } from '@/lib/domain/cpf'
import { multiplicar } from '@/lib/domain/dinheiro'
import {
  type DadosAtestado,
  type Impresso,
  type Medicamento,
  dataCurta,
  montarAtestado,
  montarReceita,
} from '@/lib/domain/impressos'
import { linhasDoOrcamento } from '@/lib/orcamento/consultas'
import { reais } from '@/lib/ui/moeda'
import { DA_CLINICA_ATUAL } from '@/lib/tenant/sql'
import { eq } from 'drizzle-orm'
import { anexarComAtor, type ResultadoDocumento } from './anexar'
import { type Linha, gerarPdf } from './pdf'

/**
 * Emissão de impressos: atestado, receita e o PDF do orçamento.
 *
 * O caminho é sempre o mesmo, e a ordem importa:
 *
 *   dados do banco → texto (domínio puro) → PDF → anexa como documento
 *
 * O anexo é o ponto: o impresso entregue ao paciente fica **arquivado com hash**
 * no prontuário. Sem isso, "vocês me deram um atestado de 3 dias, não de 1" não
 * tem resposta — e um atestado é documento que vai para o RH de terceiros.
 */

export interface DadosProfissional {
  readonly nome: string
  readonly cro: string
  readonly ufCro: string
}

async function dadosDoProfissional(ator: Ator): Promise<DadosProfissional | null> {
  if (!ator.profissionalId) return null
  const [p] = await db
    .select({ nome: usuario.nome, cro: profissional.cro, ufCro: profissional.ufCro })
    .from(profissional)
    .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
    .where(eq(profissional.id, ator.profissionalId))
  return p ?? null
}

async function dadosDaClinica(): Promise<{
  nome: string
  cidade: string
  linhasCabecalho: readonly string[]
}> {
  const [c] = await db
    .select({
      razaoSocial: clinica.razaoSocial,
      nomeFantasia: clinica.nomeFantasia,
      cnpj: clinica.cnpj,
      telefone: clinica.telefone,
      logradouro: clinica.logradouro,
      numero: clinica.numero,
      bairro: clinica.bairro,
      cidade: clinica.cidade,
      uf: clinica.uf,
    })
    .from(clinica)
    // O pior dos dez: sem filtro, o atestado do paciente sairia com o nome, o CNPJ
    // e o CRO de outra clínica — documento com valor legal, assinado por quem não
    // atendeu.
    .where(DA_CLINICA_ATUAL)

  const nome = c?.nomeFantasia ?? c?.razaoSocial ?? 'Clínica'
  const endereco = [c?.logradouro, c?.numero, c?.bairro].filter(Boolean).join(', ')
  const local = [c?.cidade, c?.uf].filter(Boolean).join(' / ')

  return {
    nome,
    // Cidade vazia deixaria "  , 26 de julho de 2026" no rodapé — pior que um
    // marcador explícito de configuração pendente.
    cidade: c?.cidade ?? '(cidade não configurada)',
    /**
     * Telefone e CNPJ **formatados**, e isto só apareceu quando alguém rasterizou o
     * PDF e olhou: o cabeçalho saía `Telefone: 1133334444` e
     * `CNPJ: 11222333000181`, enquanto o CPF do paciente, três linhas abaixo, saía
     * `127.933.468-10`.
     *
     * A inconsistência é o problema, não a estética. O atestado costuma ir para o RH
     * da empresa e a receita para a farmácia; um documento com valor legal em que a
     * clínica não formata o próprio CNPJ e formata o CPF do paciente parece gerado
     * por engano. E os formatadores já existiam (`lib/domain/cpf.ts`,
     * `lib/domain/cnpj.ts`) — não era decisão, era descuido que nenhum teste pega,
     * porque `pdftotext` extrai o texto certo dos dois jeitos.
     */
    linhasCabecalho: [
      nome,
      ...(endereco ? [endereco] : []),
      ...(local ? [local] : []),
      ...(c?.telefone ? [`Telefone: ${formatarTelefone(c.telefone)}`] : []),
      ...(c?.cnpj ? [`CNPJ: ${formatarCnpj(c.cnpj)}`] : []),
    ],
  }
}

/** Cabeçalho da clínica: nome em destaque, dados de contato miúdos. */
function linhasDeCabecalho(cabecalho: readonly string[]): Linha[] {
  return cabecalho.map((l, i) => ({
    texto: l,
    fonte: i === 0 ? ('negrito' as const) : ('normal' as const),
    tamanho: i === 0 ? 13 : 9,
    centralizado: true,
  }))
}

/**
 * Transforma um `Impresso` do domínio em linhas de PDF.
 *
 * `antesDoCorpo` entra entre o título e o conteúdo — é onde a receita põe o nome
 * do paciente, que a farmácia confere.
 */
function paginar(
  impresso: Impresso,
  cabecalho: readonly string[],
  antesDoCorpo: readonly Linha[] = [],
): readonly Linha[] {
  const linhas: Linha[] = linhasDeCabecalho(cabecalho)

  linhas.push({
    texto: impresso.titulo,
    fonte: 'negrito',
    tamanho: 15,
    centralizado: true,
    espacoAntes: 26,
  })

  linhas.push(...antesDoCorpo)

  for (const p of impresso.paragrafos) {
    // O domínio marca continuação (a posologia de um medicamento) com espaços à
    // esquerda. Espaço não recua nada no PDF — a quebra de linha normaliza o
    // branco —, então aqui vira recuo de verdade, em pontos.
    const continuacao = p.startsWith('    ')
    linhas.push({
      texto: continuacao ? p.trimStart() : p,
      espacoAntes: continuacao ? 2 : 14,
      recuo: continuacao ? 16 : 0,
    })
  }

  linhas.push({ texto: '', espacoAntes: 34 })
  for (const l of impresso.rodape) {
    linhas.push({
      texto: l,
      centralizado: l.includes('___') || l.startsWith('CRO') || !l.includes(','),
    })
  }

  return linhas
}

export interface ResultadoEmissao {
  readonly resultado: ResultadoDocumento
  /** Avisos do domínio: CID não impresso, medicamento controlado. */
  readonly avisos: readonly string[]
}

export async function emitirAtestado(
  ator: Ator,
  entrada: {
    readonly pacienteId: string
    readonly atendidoEm: Date
    readonly diasAfastamento?: number
    readonly cid?: string
    readonly cidAutorizadoPeloPaciente?: boolean
    readonly observacao?: string
  },
): Promise<ResultadoEmissao> {
  const prof = await dadosDoProfissional(ator)
  if (!prof) {
    return {
      resultado: {
        ok: false,
        mensagem: 'Só um dentista com CRO cadastrado pode emitir atestado.',
      },
      avisos: [],
    }
  }

  const [pac] = await db
    .select({ nome: paciente.nome, nomeSocial: paciente.nomeSocial, cpf: paciente.cpf })
    .from(paciente)
    .where(eq(paciente.id, entrada.pacienteId))
  if (!pac) {
    return { resultado: { ok: false, mensagem: 'Paciente não encontrado.' }, avisos: [] }
  }

  const info = await dadosDaClinica()

  const dados: DadosAtestado = {
    // Nome social tem precedência: o atestado circula fora da clínica.
    pacienteNome: pac.nomeSocial ?? pac.nome,
    pacienteCpf: pac.cpf,
    profissionalNome: prof.nome,
    cro: prof.cro,
    ufCro: prof.ufCro,
    clinicaNome: info.nome,
    cidade: info.cidade,
    atendidoEm: entrada.atendidoEm,
    diasAfastamento: entrada.diasAfastamento,
    cid: entrada.cid,
    cidAutorizadoPeloPaciente: entrada.cidAutorizadoPeloPaciente,
    observacao: entrada.observacao,
  }

  let impresso: Impresso
  try {
    impresso = montarAtestado(dados)
  } catch (e) {
    return {
      resultado: { ok: false, mensagem: e instanceof Error ? e.message : 'Atestado inválido.' },
      avisos: [],
    }
  }

  const pdf = gerarPdf(paginar(impresso, info.linhasCabecalho), {
    titulo: `Atestado — ${dados.pacienteNome}`,
    autor: prof.nome,
  })

  const resultado = await anexarComAtor(
    ator,
    {
      pacienteId: entrada.pacienteId,
      tipo: 'atestado',
      nome: `Atestado ${dataCurta(entrada.atendidoEm)}.pdf`,
      descricao:
        entrada.diasAfastamento !== undefined
          ? `Afastamento de ${entrada.diasAfastamento} dia(s)`
          : 'Comparecimento',
      dataExame: entrada.atendidoEm.toISOString(),
      profissionalId: ator.profissionalId ?? undefined,
    },
    pdf,
    'application/pdf',
  )

  return { resultado, avisos: impresso.avisos }
}

export async function emitirReceita(
  ator: Ator,
  entrada: {
    readonly pacienteId: string
    readonly medicamentos: readonly Medicamento[]
    readonly orientacoes?: string
  },
): Promise<ResultadoEmissao> {
  const prof = await dadosDoProfissional(ator)
  if (!prof) {
    return {
      resultado: { ok: false, mensagem: 'Só um dentista com CRO cadastrado pode prescrever.' },
      avisos: [],
    }
  }

  const [pac] = await db
    .select({ nome: paciente.nome, nomeSocial: paciente.nomeSocial, cpf: paciente.cpf })
    .from(paciente)
    .where(eq(paciente.id, entrada.pacienteId))
  if (!pac) {
    return { resultado: { ok: false, mensagem: 'Paciente não encontrado.' }, avisos: [] }
  }

  const info = await dadosDaClinica()
  const agora = new Date()

  let impresso: Impresso
  try {
    impresso = montarReceita({
      pacienteNome: pac.nomeSocial ?? pac.nome,
      pacienteCpf: pac.cpf,
      profissionalNome: prof.nome,
      cro: prof.cro,
      ufCro: prof.ufCro,
      clinicaNome: info.nome,
      cidade: info.cidade,
      emitidaEm: agora,
      medicamentos: entrada.medicamentos,
      orientacoes: entrada.orientacoes,
    })
  } catch (e) {
    return {
      resultado: { ok: false, mensagem: e instanceof Error ? e.message : 'Receita inválida.' },
      avisos: [],
    }
  }

  // O nome do paciente entra no corpo da receita — a farmácia confere.
  const linhas = paginar(impresso, info.linhasCabecalho, [
    { texto: `Paciente: ${pac.nomeSocial ?? pac.nome}`, espacoAntes: 20 },
  ])

  const pdf = gerarPdf(linhas, {
    titulo: `Receita — ${pac.nomeSocial ?? pac.nome}`,
    autor: prof.nome,
  })

  const resultado = await anexarComAtor(
    ator,
    {
      pacienteId: entrada.pacienteId,
      tipo: 'receita',
      nome: `Receita ${dataCurta(agora)}.pdf`,
      descricao: entrada.medicamentos.map((m) => m.nome).join('; ').slice(0, 300),
      dataExame: agora.toISOString(),
      profissionalId: ator.profissionalId ?? undefined,
    },
    pdf,
    'application/pdf',
  )

  return { resultado, avisos: impresso.avisos }
}

/**
 * Arquiva o PDF do orçamento e preenche `orcamento.pdf_key`.
 *
 * A coluna existe desde a Fase 1 e ficou vazia até aqui, o que era uma lacuna
 * real: o orçamento é **documento congelado** (triggers em `drizzle/0004`), mas
 * até agora só existia como tela. Se o paciente aparecer com um papel, a clínica
 * precisa ter o mesmo papel — não uma view que reimprime a partir dos dados.
 *
 * Idempotente: orçamento que já tem PDF arquivado não gera outro.
 */
export async function arquivarOrcamento(
  ator: Ator,
  orcamentoId: string,
): Promise<ResultadoEmissao> {
  const [orc] = await db
    .select({
      id: orcamento.id,
      numero: orcamento.numero,
      pacienteId: orcamento.pacienteId,
      pacienteNome: paciente.nome,
      pacienteNomeSocial: paciente.nomeSocial,
      pacienteCpf: paciente.cpf,
      status: orcamento.status,
      validadeAte: orcamento.validadeAte,
      valorBruto: orcamento.valorBruto,
      desconto: orcamento.desconto,
      valorTotal: orcamento.valorTotal,
      observacao: orcamento.observacao,
      criadoEm: orcamento.criadoEm,
      enviadoEm: orcamento.enviadoEm,
      pdfKey: orcamento.pdfKey,
    })
    .from(orcamento)
    .innerJoin(paciente, eq(paciente.id, orcamento.pacienteId))
    .where(eq(orcamento.id, orcamentoId))

  if (!orc) {
    return { resultado: { ok: false, mensagem: 'Orçamento não encontrado.' }, avisos: [] }
  }
  if (orc.pdfKey) {
    return {
      resultado: { ok: false, mensagem: 'Este orçamento já tem PDF arquivado.' },
      avisos: [],
    }
  }

  const itens = await linhasDoOrcamento(orcamentoId)
  const info = await dadosDaClinica()
  const nomePaciente = orc.pacienteNomeSocial ?? orc.pacienteNome

  const linhas: Linha[] = linhasDeCabecalho(info.linhasCabecalho)

  linhas.push({
    texto: `ORÇAMENTO Nº ${orc.numero}`,
    fonte: 'negrito',
    tamanho: 15,
    centralizado: true,
    espacoAntes: 26,
  })
  linhas.push({ texto: `Paciente: ${nomePaciente}`, espacoAntes: 20 })
  if (orc.pacienteCpf) linhas.push({ texto: `CPF: ${formatarCpf(orc.pacienteCpf)}` })
  linhas.push({ texto: `Emitido em: ${dataCurta(orc.enviadoEm ?? orc.criadoEm)}` })
  linhas.push({ texto: `Válido até: ${orc.validadeAte.split('-').reverse().join('/')}` })

  linhas.push({ texto: 'Procedimentos', fonte: 'negrito', espacoAntes: 20 })
  itens.forEach((item, i) => {
    // Multiplicação em centavos inteiros — nunca `Number * qtd` para dinheiro.
    const total = reais(multiplicar(item.valorUnitario, item.quantidade))
    linhas.push({
      texto: `${i + 1}. ${item.descricao}${item.detalhe ? ` (${item.detalhe})` : ''} — ${item.quantidade} × ${reais(item.valorUnitario)} = ${total}`,
      espacoAntes: 6,
    })
  })

  linhas.push({ texto: `Subtotal: ${reais(orc.valorBruto)}`, espacoAntes: 18 })
  if (Number(orc.desconto) > 0) {
    linhas.push({ texto: `Desconto: ${reais(orc.desconto)}` })
  }
  linhas.push({ texto: `TOTAL: ${reais(orc.valorTotal)}`, fonte: 'negrito', tamanho: 13 })

  if (orc.observacao) {
    linhas.push({ texto: `Observação: ${orc.observacao}`, espacoAntes: 16 })
  }

  linhas.push({
    texto: `${info.cidade}, ${dataCurta(new Date())}.`,
    espacoAntes: 30,
  })
  linhas.push({ texto: '', espacoAntes: 20 })
  linhas.push({ texto: '_______________________________________', centralizado: true })
  linhas.push({ texto: nomePaciente, centralizado: true })
  linhas.push({ texto: 'Ciente e de acordo', tamanho: 9, centralizado: true })

  const pdf = gerarPdf(linhas, {
    titulo: `Orçamento ${orc.numero} — ${nomePaciente}`,
  })

  const resultado = await anexarComAtor(
    ator,
    {
      pacienteId: orc.pacienteId,
      tipo: 'orcamento_pdf',
      nome: `Orcamento ${orc.numero}.pdf`,
      descricao: `Orçamento nº ${orc.numero} — ${reais(orc.valorTotal)}`,
    },
    pdf,
    'application/pdf',
  )

  if (resultado.ok) {
    // Liga o documento arquivado ao orçamento. `pdf_key` guarda a chave do
    // storage, que é o que permite achar o arquivo sem passar pela tabela de
    // documentos.
    const [doc] = await db
      .select({ chave: documento.storageKey })
      .from(documento)
      .where(eq(documento.id, resultado.id))

    if (doc) {
      await db.update(orcamento).set({ pdfKey: doc.chave }).where(eq(orcamento.id, orcamentoId))
    }
  }

  return { resultado, avisos: [] }
}
