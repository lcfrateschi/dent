import { db } from '@/lib/db'
import { convenio, pacienteConvenio, precoConvenio, procedimento } from '@/lib/db/schema'
import { and, asc, desc, eq, sql } from 'drizzle-orm'

/**
 * Leituras do CADASTRO de convênio — operadora, tabela negociada e carteirinha.
 *
 * Separado de `lib/tiss/consultas.ts` de propósito: aquele arquivo é sobre
 * faturamento (guia, glosa, repasse) e este é sobre cadastro. Misturar faria uma
 * tela de cadastro carregar consultas de dinheiro sem precisar.
 */

export interface ConvenioNaTela {
  readonly id: string
  readonly nome: string
  readonly registroAns: string | null
  readonly cnpj: string | null
  readonly prazoPagamentoDias: number
  readonly diaFechamento: number | null
  readonly contatoNome: string | null
  readonly contatoTelefone: string | null
  readonly observacoes: string | null
  readonly ativo: boolean
  /** Quantos procedimentos têm preço vigente hoje. */
  readonly precosVigentes: number
  readonly precosTotais: number
  readonly pacientes: number
}

export async function conveniosCadastrados(hoje: string): Promise<readonly ConvenioNaTela[]> {
  return db
    .select({
      id: convenio.id,
      nome: convenio.nome,
      registroAns: convenio.registroAns,
      cnpj: convenio.cnpj,
      prazoPagamentoDias: convenio.prazoPagamentoDias,
      diaFechamento: convenio.diaFechamento,
      contatoNome: convenio.contatoNome,
      contatoTelefone: convenio.contatoTelefone,
      observacoes: convenio.observacoes,
      ativo: convenio.ativo,
      precosVigentes: sql<number>`(
        select count(*)::int from preco_convenio p
         where p."convenio_id" = "convenio"."id"
           and p."vigencia_inicio" <= ${hoje}::date
           and (p."vigencia_fim" is null or p."vigencia_fim" >= ${hoje}::date)
      )`,
      precosTotais: sql<number>`(
        select count(*)::int from preco_convenio p where p."convenio_id" = "convenio"."id"
      )`,
      pacientes: sql<number>`(
        select count(*)::int from paciente_convenio pc
         where pc."convenio_id" = "convenio"."id" and pc."ativo"
      )`,
    })
    .from(convenio)
    .orderBy(sql`${convenio.ativo} desc`, asc(convenio.nome))
}

export async function acharConvenio(id: string, hoje: string): Promise<ConvenioNaTela | null> {
  const todos = await conveniosCadastrados(hoje)
  return todos.find((c) => c.id === id) ?? null
}

export interface PrecoNaTela {
  readonly id: string
  readonly procedimentoId: string
  readonly codigo: string
  readonly procedimentoNome: string
  readonly codigoTuss: string | null
  readonly valorParticular: string
  readonly valor: string
  readonly coberturaPct: string
  readonly carenciaDias: number
  readonly vigenciaInicio: string
  readonly vigenciaFim: string | null
  readonly vigenteHoje: boolean
  /** Itens de guia já apresentados sob este preço. Acima de zero, ele é histórico. */
  readonly usosEmGuia: number
}

/**
 * Tabela negociada de uma operadora, em ordem de procedimento e vigência.
 *
 * `usosEmGuia` é o que a tela usa para decidir entre oferecer "apagar" ou só
 * "fechar vigência". Sem esse número, o botão de apagar apareceria sempre e
 * falharia na trava do banco — erro que parece bug em vez de regra.
 */
export async function tabelaNegociada(
  convenioId: string,
  hoje: string,
): Promise<readonly PrecoNaTela[]> {
  return db
    .select({
      id: precoConvenio.id,
      procedimentoId: precoConvenio.procedimentoId,
      codigo: procedimento.codigo,
      procedimentoNome: procedimento.nome,
      codigoTuss: procedimento.codigoTuss,
      valorParticular: procedimento.valorParticular,
      valor: precoConvenio.valor,
      coberturaPct: precoConvenio.coberturaPct,
      carenciaDias: precoConvenio.carenciaDias,
      vigenciaInicio: precoConvenio.vigenciaInicio,
      vigenciaFim: precoConvenio.vigenciaFim,
      vigenteHoje: sql<boolean>`(
        "preco_convenio"."vigencia_inicio" <= ${hoje}::date
        and ("preco_convenio"."vigencia_fim" is null or "preco_convenio"."vigencia_fim" >= ${hoje}::date)
      )`,
      usosEmGuia: sql<number>`(
        select count(*)::int
          from item_guia ig
          join guia_tiss g on g.id = ig."guia_id"
          join item_plano ip on ip.id = ig."item_plano_id"
         where g."convenio_id" = "preco_convenio"."convenio_id"
           and ip."procedimento_id" = "preco_convenio"."procedimento_id"
           and ig."data_execucao" >= "preco_convenio"."vigencia_inicio"
           and ("preco_convenio"."vigencia_fim" is null
                or ig."data_execucao" <= "preco_convenio"."vigencia_fim")
      )`,
    })
    .from(precoConvenio)
    .innerJoin(procedimento, eq(procedimento.id, precoConvenio.procedimentoId))
    .where(eq(precoConvenio.convenioId, convenioId))
    .orderBy(asc(procedimento.nome), desc(precoConvenio.vigenciaInicio))
}

export interface CarteirinhaNaTela {
  readonly id: string
  readonly convenioId: string
  readonly convenioNome: string
  readonly registroAns: string | null
  readonly numeroCarteirinha: string
  readonly plano: string | null
  readonly ehTitular: boolean
  readonly nomeTitular: string | null
  readonly adesaoEm: string | null
  readonly validade: string | null
  readonly ativo: boolean
}

export async function carteirinhasDoPaciente(
  pacienteId: string,
): Promise<readonly CarteirinhaNaTela[]> {
  return db
    .select({
      id: pacienteConvenio.id,
      convenioId: pacienteConvenio.convenioId,
      convenioNome: convenio.nome,
      registroAns: convenio.registroAns,
      numeroCarteirinha: pacienteConvenio.numeroCarteirinha,
      plano: pacienteConvenio.plano,
      ehTitular: pacienteConvenio.ehTitular,
      nomeTitular: pacienteConvenio.nomeTitular,
      adesaoEm: pacienteConvenio.adesaoEm,
      validade: pacienteConvenio.validade,
      ativo: pacienteConvenio.ativo,
    })
    .from(pacienteConvenio)
    .innerJoin(convenio, eq(convenio.id, pacienteConvenio.convenioId))
    .where(eq(pacienteConvenio.pacienteId, pacienteId))
    .orderBy(sql`${pacienteConvenio.ativo} desc`, asc(convenio.nome))
}

/** Operadoras ativas, para os seletores. */
export async function conveniosAtivos(): Promise<readonly { id: string; nome: string }[]> {
  return db
    .select({ id: convenio.id, nome: convenio.nome })
    .from(convenio)
    .where(eq(convenio.ativo, true))
    .orderBy(asc(convenio.nome))
}

/**
 * Procedimentos que ainda NÃO têm preço vigente nesta operadora.
 *
 * É a lista que a tela oferece para cadastrar, e a ordem importa: procedimento
 * sem preço é procedimento que não pode ser faturado por convênio. Mostrar o que
 * falta é mais útil do que mostrar o que já existe.
 */
export async function procedimentosSemPreco(
  convenioId: string,
  hoje: string,
): Promise<readonly { id: string; codigo: string; nome: string; valorParticular: string }[]> {
  return db
    .select({
      id: procedimento.id,
      codigo: procedimento.codigo,
      nome: procedimento.nome,
      valorParticular: procedimento.valorParticular,
    })
    .from(procedimento)
    .where(
      and(
        eq(procedimento.ativo, true),
        sql`not exists (
          select 1 from preco_convenio p
           where p."convenio_id" = ${convenioId}
             and p."procedimento_id" = "procedimento"."id"
             and p."vigencia_inicio" <= ${hoje}::date
             and (p."vigencia_fim" is null or p."vigencia_fim" >= ${hoje}::date)
        )`,
      ),
    )
    .orderBy(asc(procedimento.nome))
}
