-- Alinhamento de baseline: as três colunas do cadastro TISS no snapshot.
--
-- Não muda nada no banco. `drizzle-kit generate` produziu os três `ADD COLUMN` que a
-- `0039` já aplicou — conferido linha a linha antes de descartar. O que fica é o
-- snapshot, que é a base das gerações futuras; sem isso o SQL reapareceria de carona
-- na próxima mexida em `clinica`, `convenio` ou `profissional`.
--
-- Sétima vez que este procedimento aparece no projeto (ver `CLAUDE.md`): gerar,
-- conferir o que veio, e decidir entre aplicar ou descartar mantendo o snapshot.
SELECT 1 WHERE false;
