import { categoriaDespesa } from '@/lib/db/schema'
import type { Executor } from '@/lib/tenant/executar'

/**
 * Categorias de despesa de partida — o que um consultório de duas cadeiras paga.
 *
 * ── Por que isto existe fora da migration ───────────────────────────────────
 * A `drizzle/0034` semeia estas mesmas doze categorias, e parecia suficiente. Não é:
 * ela faz `INSERT … FROM clinica CROSS JOIN (VALUES …)`, ou seja semeia para as
 * clínicas que existiam **no instante em que a migration rodou**.
 *
 * Numa instalação nova a ordem é migration → seed → clínica, então quando a 0034
 * executa não existe clínica nenhuma e ela semeia zero linhas. Medido num banco
 * virgem: duas clínicas, **zero categorias**. O efeito é que o módulo de caixa nasce
 * inutilizável — não há como lançar despesa sem categoria, e a tela não explica por
 * quê, porque "lista vazia" é um estado legítimo.
 *
 * É a mesma família do backfill de `assinatura`, que a Fase 20 já tinha corrigido pela
 * mesma razão: **backfill em migration resolve o passado, não o futuro.** Dado que toda
 * clínica precisa ter pertence ao caminho que cria clínica — seed e onboarding.
 *
 * ── São de PARTIDA ─────────────────────────────────────────────────────────
 * Como os mínimos de estoque e as fichas técnicas. A clínica acrescenta, renomeia e
 * desativa. `Comissão de profissionais` está aqui porque comissão paga É despesa — e
 * **nada no sistema cria essa despesa automaticamente** a partir da apuração:
 * derivar seria contagem dupla, porque alguém vai lançar o pagamento à mão de todo
 * jeito (ele saiu do banco). A apuração é a fonte do número; o lançamento é ato humano.
 */
const PADROES: readonly { readonly nome: string; readonly natureza: 'fixa' | 'variavel' }[] = [
  { nome: 'Aluguel e condomínio', natureza: 'fixa' },
  { nome: 'Água, luz e internet', natureza: 'fixa' },
  { nome: 'Salários e encargos', natureza: 'fixa' },
  { nome: 'Comissão de profissionais', natureza: 'variavel' },
  { nome: 'Material de consumo', natureza: 'variavel' },
  { nome: 'Laboratório de prótese', natureza: 'variavel' },
  { nome: 'Manutenção de equipamento', natureza: 'variavel' },
  { nome: 'Software e sistemas', natureza: 'fixa' },
  { nome: 'Contabilidade', natureza: 'fixa' },
  { nome: 'Impostos e taxas', natureza: 'fixa' },
  { nome: 'Marketing', natureza: 'variavel' },
  { nome: 'Descarte de resíduos (RSS)', natureza: 'fixa' },
]

/**
 * Semeia as categorias da clínica do CONTEXTO. Idempotente.
 *
 * `clinica_id` sai do `DEFAULT app_clinica_id()` — não é passado. Sem contexto, a
 * função do banco estoura, que é o comportamento certo: melhor falhar alto do que
 * semear na clínica errada.
 */
export async function seedCategoriasDespesa(db: Executor): Promise<number> {
  await db
    .insert(categoriaDespesa)
    .values(PADROES.map((p) => ({ nome: p.nome, natureza: p.natureza })))
    // `DO NOTHING` e não `DO UPDATE`: a clínica pode ter renomeado ou desativado uma
    // categoria, e reimportar o seed não deve desfazer isso.
    .onConflictDoNothing({ target: [categoriaDespesa.clinicaId, categoriaDespesa.nome] })
  return PADROES.length
}
