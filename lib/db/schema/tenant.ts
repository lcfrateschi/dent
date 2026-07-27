import { sql } from 'drizzle-orm'
import { uuid } from 'drizzle-orm/pg-core'
import { clinica } from './acesso'

/**
 * A coluna de tenant, em um lugar só.
 *
 * ── Por que TODA tabela de dados a tem, inclusive as filhas ─────────────────
 * `parcela` sabe quem é a clínica pelo caminho `cobranca`; `item_guia`, pela
 * `guia_tiss`. Mesmo assim as duas carregam `clinica_id`, por dois motivos:
 *
 * 1. **Row Level Security precisa da coluna na própria tabela.** Política que
 *    resolve o tenant por subconsulta funciona, mas é lenta e difícil de auditar
 *    — e política de RLS é justamente o lugar onde ninguém quer ser esperto.
 * 2. **A redundância é travada, não confiada.** Cada filha tem FK COMPOSTO para
 *    o pai `(pai_id, clinica_id)`, então é impossível uma parcela apontar para
 *    cobrança de outra clínica. É o mesmo truque que já protege
 *    `movimento_estoque` → `lote_material` em `drizzle/0019_estoque_travas.sql`
 *    (constraint `movimento_lote_do_mesmo_material`): redundância sem trava vira
 *    divergência.
 *
 * ── Quem NÃO tem ───────────────────────────────────────────────────────────
 * - `clinica`: é o tenant.
 * - `dente`: os 52 dentes da notação FDI são padrão internacional. Duplicá-los
 *   por cliente seria copiar uma tabela imutável centenas de vezes.
 *
 * `procedimento`, por outro lado, **tem**: valor particular, `requerDente` e
 * ficha técnica são decisão de cada clínica. O catálogo do seed é o molde
 * copiado no onboarding, e `dados/tuss22-odontologia.csv` continua referência
 * global.
 *
 * ── `onDelete: 'restrict'` ─────────────────────────────────────────────────
 * Apagar uma clínica com dado dentro não é operação de sistema: prontuário tem
 * guarda de 20 anos (CFO). O que existe é encerrar o contrato e exportar. Um
 * `cascade` aqui seria um `DROP DATABASE` disfarçado de UPDATE.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ⚠️ 29 FKs COMPOSTOS ESTÃO NO BANCO E **NÃO** ESTÃO DECLARADOS AQUI
 * ══════════════════════════════════════════════════════════════════════════
 * O banco tem 81 FKs compostos (`drizzle/0023_rls.sql`). Deste arquivo e dos
 * outros de `lib/db/schema/`, 50 estão declarados com `foreignKey({ columns:
 * [x, clinicaId], foreignColumns: [pai.id, pai.clinicaId] })`. Os outros 29
 * continuam declarados com `.references()` de UMA coluna — de propósito, e não
 * por esquecimento.
 *
 * **O motivo:** os 29 são `ON DELETE SET NULL`, e no banco eles usam a forma com
 * lista de colunas do Postgres 15+:
 *
 *     ON DELETE SET NULL (criado_por_id)
 *
 * que anula **só** a coluna do pai e preserva `clinica_id`. O Drizzle não sabe
 * expressar isso: `UpdateDeleteAction` é `'set null'` e nada mais
 * (`drizzle-orm/pg-core/foreign-keys.d.ts`), e o `drizzle-kit` gera sempre
 * `ON DELETE set null` sem lista. A diferença não é cosmética — está medida:
 *
 *     -- forma do banco:    DELETE passa, pai_id vira NULL, clinica_id preservado
 *     -- forma do drizzle:  ERROR: null value in column "clinica_id" ...
 *                           violates not-null constraint
 *                           CONTEXT: UPDATE ... SET "pai_id" = NULL,
 *                                                  "clinica_id" = NULL
 *
 * Ou seja: declarar esses 29 aqui produziria uma migration que transforma um
 * `DELETE` que funciona em erro de NOT NULL. Um `usuario` deixaria de poder ser
 * apagado, com uma mensagem que não menciona nem FK nem tenant.
 *
 * ── O que isso custa, e o que protege ──────────────────────────────────────
 * O snapshot do drizzle-kit (`drizzle/meta/*.json`) descreve esses 29 como FK de
 * uma coluna. Ele está errado, e o risco é concreto: `db:generate` compara o
 * schema TS com o SNAPSHOT (nunca com o banco), então uma futura mexida em
 * qualquer uma dessas tabelas pode gerar um `DROP CONSTRAINT` + `ADD CONSTRAINT`
 * de uma coluna só — **revertendo em silêncio a trava de tenant**, num SQL que
 * parece arrumação.
 *
 * A defesa é `exigir_isolamento_estrutural()`, a asserção que a `0023` deixou:
 * ela confere que todo FK entre tabelas de tenant tem `clinica_id` nas duas
 * pontas, e **derruba o deploy** em vez de deixar reverter. Migration que mexer
 * em FK dessas tabelas tem de chamá-la no fim.
 *
 * **Nunca troque `.references()` por `foreignKey()` nestes 29 sem antes conferir
 * `confdelsetcols` no `pg_constraint`:**
 *
 *     select conname, conrelid::regclass, confdelsetcols
 *       from pg_constraint
 *      where contype = 'f' and confdeltype = 'n' and confdelsetcols is not null;
 *
 * São estes (tabela → colunas que apontam para pai de tenant com SET NULL):
 *
 *   agendamento         cadeira_id, criado_por_id
 *   alerta_clinico      origem_anamnese_id
 *   anamnese            profissional_id
 *   bloqueio_agenda     criado_por_id
 *   cobranca            criado_por_id, orcamento_id
 *   consentimento       assinado_por_id
 *   dente_paciente      profissional_id
 *   documento           criado_por_id, evolucao_id, profissional_id, removido_por_id
 *   evolucao            agendamento_id
 *   execucao            agendamento_id
 *   glosa               registrada_por_id
 *   guia_tiss           criado_por_id
 *   lote_material       criado_por_id
 *   movimento_estoque   registrado_por_id
 *   orcamento           criado_por_id, plano_id
 *   orcamento_item      item_plano_id
 *   paciente            responsavel_legal_id
 *   pagamento           registrado_por_id
 *   recurso_glosa       enviado_por_id
 *   repasse             criado_por_id
 *   resposta_whatsapp   agendamento_id, mensagem_id, paciente_id
 */
export function clinicaId() {
  return uuid('clinica_id')
    .notNull()
    .default(sql`app_clinica_id()`)
    .references(() => clinica.id, { onDelete: 'restrict' })
}
