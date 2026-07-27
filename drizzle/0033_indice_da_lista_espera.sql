-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Alinhamento de baseline: o índice único da lista de espera                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── Não muda nada no banco ─────────────────────────────────────────────────
-- `DROP` + `CREATE` do MESMO índice, conferido `indexdef` a `indexdef` contra
-- `pg_indexes` antes de aplicar. O que muda é o snapshot do drizzle-kit.
--
-- ── Por que existe ─────────────────────────────────────────────────────────
-- O índice nasceu na `0031` como `unique (paciente_id, procedimento_id) where
-- situacao = 'aguardando'` — e **não travava o caso mais comum**: dois `NULL` em
-- `procedimento_id` não colidem em índice único, e `procedimento_id IS NULL` é
-- exatamente "qualquer vaga mais cedo", que é o que a maioria pede. Duas linhas
-- ativas para o mesmo paciente passavam, com o índice parecendo correto.
--
-- A correção foi `coalesce(procedimento_id, '00000000-…-000000000000')`. O schema TS
-- foi corrigido junto, o banco recebeu a versão certa à mão — e o **snapshot** ficou
-- com a versão antiga, então `db:generate` passou a pedir esta migration a cada
-- execução. Baseline velha é dívida silenciosa: o SQL reapareceria de carona na
-- próxima mexida em qualquer tabela vizinha.
--
-- É a quinta vez que este procedimento aparece (ver o `CLAUDE.md`): gerar, conferir o
-- que veio, e decidir entre aplicar ou descartar o SQL mantendo o snapshot. Aqui
-- aplicar é seguro porque o efeito é nulo.

DROP INDEX "lista_espera_um_ativo_uk";--> statement-breakpoint
CREATE UNIQUE INDEX "lista_espera_um_ativo_uk" ON "lista_espera" USING btree ("paciente_id",coalesce("procedimento_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "lista_espera"."situacao" = 'aguardando';