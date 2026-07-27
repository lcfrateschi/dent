-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Fase 17 — os FKs compostos que a 0023 criou, agora DECLARADOS no schema   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── O que esta migration muda no banco: NADA ────────────────────────────────
-- São 50 `DROP CONSTRAINT` seguidos de 50 `ADD CONSTRAINT` **idênticos** ao que
-- já existe. O banco sai igual ao que entrou. O que muda é o *snapshot* do
-- drizzle-kit (`meta/0025_snapshot.json`), e é para isso que ela existe.
--
-- ── Por que isso não é trabalho inútil ─────────────────────────────────────
-- A `drizzle/0023` converteu 80 FKs entre tabelas de tenant em compostos
-- `(pai_id, clinica_id)` → `(id, clinica_id)`. É o que torna impossível uma
-- `parcela` apontar para `cobranca` de outra clínica: a redundância de
-- `clinica_id` nas filhas fica travada, não confiada.
--
-- Mas o `drizzle-kit` compara o schema TS com o **snapshot**, nunca com o banco.
-- O TS declarava referência de UMA coluna e o snapshot concordava, então ele não
-- reclamava de nada — e a próxima mexida em qualquer uma dessas tabelas geraria
-- `DROP` + `ADD` de uma coluna só, **revertendo a trava num SQL que parece
-- arrumação**. Ninguém veria. Esta migration alinha a baseline.
--
-- ── Por que 50 e não 80 ────────────────────────────────────────────────────
-- Os outros 29 usam `ON DELETE SET NULL (coluna)` — a forma com lista de colunas
-- do Postgres 15+, que anula só a coluna do pai e **preserva `clinica_id`**. O
-- Drizzle não sabe expressar isso: `UpdateDeleteAction` só tem `'set null'`, sem
-- lista. Declarar os 29 geraria `SET NULL` puro, que anula `clinica_id` também —
-- e como a coluna é `NOT NULL`, o `DELETE` do pai passaria a **falhar**:
--
--   ERROR: null value in column "clinica_id" violates not-null constraint
--   CONTEXT: UPDATE ... SET "criado_por_id" = NULL, "clinica_id" = NULL
--
-- Ou seja: apagar um `usuario` deixaria de funcionar, com mensagem que não
-- menciona FK nem tenant. Medido em banco descartável antes de decidir. Os 29
-- ficam declarados como referência de uma coluna, com o aviso no topo de
-- `lib/db/schema/tenant.ts`, e a defesa deles é `exigir_isolamento_estrutural()`
-- da 0023 — que derruba o deploy em vez de deixar reverter em silêncio.
--
-- ── O que foi RETIRADO do arquivo gerado ───────────────────────────────────
-- O `drizzle-kit` também gerou `ADD COLUMN clinica.whatsapp_phone_number_id` e o
-- `CREATE UNIQUE INDEX clinica_whatsapp_numero_uk`, porque o snapshot não sabia
-- deles. **A `drizzle/0024` já os criou** — aplicar como veio falharia com "column
-- already exists", e é o mesmo motivo de sempre: o gerador conhece o snapshot, não
-- o banco. O snapshot desta migration os registra; o SQL não os repete.

ALTER TABLE "profissional" DROP CONSTRAINT "profissional_usuario_id_usuario_id_fk";
--> statement-breakpoint
ALTER TABLE "consentimento" DROP CONSTRAINT "consentimento_paciente_id_paciente_id_fk";
--> statement-breakpoint
ALTER TABLE "paciente_conta" DROP CONSTRAINT "paciente_conta_paciente_id_paciente_id_fk";
--> statement-breakpoint
ALTER TABLE "paciente_sessao" DROP CONSTRAINT "paciente_sessao_conta_id_paciente_conta_id_fk";
--> statement-breakpoint
ALTER TABLE "paciente_convenio" DROP CONSTRAINT "paciente_convenio_paciente_id_paciente_id_fk";
--> statement-breakpoint
ALTER TABLE "paciente_convenio" DROP CONSTRAINT "paciente_convenio_convenio_id_convenio_id_fk";
--> statement-breakpoint
ALTER TABLE "preco_convenio" DROP CONSTRAINT "preco_convenio_convenio_id_convenio_id_fk";
--> statement-breakpoint
ALTER TABLE "preco_convenio" DROP CONSTRAINT "preco_convenio_procedimento_id_procedimento_id_fk";
--> statement-breakpoint
ALTER TABLE "agendamento" DROP CONSTRAINT "agendamento_paciente_id_paciente_id_fk";
--> statement-breakpoint
ALTER TABLE "agendamento" DROP CONSTRAINT "agendamento_profissional_id_profissional_id_fk";
--> statement-breakpoint
ALTER TABLE "bloqueio_agenda" DROP CONSTRAINT "bloqueio_agenda_profissional_id_profissional_id_fk";
--> statement-breakpoint
ALTER TABLE "bloqueio_agenda" DROP CONSTRAINT "bloqueio_agenda_cadeira_id_cadeira_id_fk";
--> statement-breakpoint
ALTER TABLE "alerta_clinico" DROP CONSTRAINT "alerta_clinico_paciente_id_paciente_id_fk";
--> statement-breakpoint
ALTER TABLE "anamnese" DROP CONSTRAINT "anamnese_paciente_id_paciente_id_fk";
--> statement-breakpoint
ALTER TABLE "dente_paciente" DROP CONSTRAINT "dente_paciente_paciente_id_paciente_id_fk";
--> statement-breakpoint
ALTER TABLE "evolucao" DROP CONSTRAINT "evolucao_paciente_id_paciente_id_fk";
--> statement-breakpoint
ALTER TABLE "evolucao" DROP CONSTRAINT "evolucao_profissional_id_profissional_id_fk";
--> statement-breakpoint
ALTER TABLE "evolucao" DROP CONSTRAINT "evolucao_retifica_id_evolucao_id_fk";
--> statement-breakpoint
ALTER TABLE "execucao" DROP CONSTRAINT "execucao_item_plano_id_item_plano_id_fk";
--> statement-breakpoint
ALTER TABLE "execucao" DROP CONSTRAINT "execucao_profissional_id_profissional_id_fk";
--> statement-breakpoint
ALTER TABLE "item_plano" DROP CONSTRAINT "item_plano_plano_id_plano_tratamento_id_fk";
--> statement-breakpoint
ALTER TABLE "item_plano" DROP CONSTRAINT "item_plano_procedimento_id_procedimento_id_fk";
--> statement-breakpoint
ALTER TABLE "item_plano" DROP CONSTRAINT "item_plano_convenio_id_convenio_id_fk";
--> statement-breakpoint
ALTER TABLE "plano_tratamento" DROP CONSTRAINT "plano_tratamento_paciente_id_paciente_id_fk";
--> statement-breakpoint
ALTER TABLE "plano_tratamento" DROP CONSTRAINT "plano_tratamento_profissional_id_profissional_id_fk";
--> statement-breakpoint
ALTER TABLE "cobranca" DROP CONSTRAINT "cobranca_paciente_id_paciente_id_fk";
--> statement-breakpoint
ALTER TABLE "orcamento" DROP CONSTRAINT "orcamento_paciente_id_paciente_id_fk";
--> statement-breakpoint
ALTER TABLE "orcamento_item" DROP CONSTRAINT "orcamento_item_orcamento_id_orcamento_id_fk";
--> statement-breakpoint
ALTER TABLE "pagamento" DROP CONSTRAINT "pagamento_parcela_id_parcela_id_fk";
--> statement-breakpoint
ALTER TABLE "parcela" DROP CONSTRAINT "parcela_cobranca_id_cobranca_id_fk";
--> statement-breakpoint
ALTER TABLE "glosa" DROP CONSTRAINT "glosa_item_guia_id_item_guia_id_fk";
--> statement-breakpoint
ALTER TABLE "guia_tiss" DROP CONSTRAINT "guia_tiss_convenio_id_convenio_id_fk";
--> statement-breakpoint
ALTER TABLE "guia_tiss" DROP CONSTRAINT "guia_tiss_paciente_id_paciente_id_fk";
--> statement-breakpoint
ALTER TABLE "guia_tiss" DROP CONSTRAINT "guia_tiss_profissional_id_profissional_id_fk";
--> statement-breakpoint
ALTER TABLE "item_guia" DROP CONSTRAINT "item_guia_guia_id_guia_tiss_id_fk";
--> statement-breakpoint
ALTER TABLE "item_guia" DROP CONSTRAINT "item_guia_item_plano_id_item_plano_id_fk";
--> statement-breakpoint
ALTER TABLE "recurso_glosa" DROP CONSTRAINT "recurso_glosa_glosa_id_glosa_id_fk";
--> statement-breakpoint
ALTER TABLE "repasse" DROP CONSTRAINT "repasse_convenio_id_convenio_id_fk";
--> statement-breakpoint
ALTER TABLE "repasse_item" DROP CONSTRAINT "repasse_item_repasse_id_repasse_id_fk";
--> statement-breakpoint
ALTER TABLE "repasse_item" DROP CONSTRAINT "repasse_item_item_guia_id_item_guia_id_fk";
--> statement-breakpoint
ALTER TABLE "insumo_procedimento" DROP CONSTRAINT "insumo_procedimento_procedimento_id_procedimento_id_fk";
--> statement-breakpoint
ALTER TABLE "insumo_procedimento" DROP CONSTRAINT "insumo_procedimento_material_id_material_id_fk";
--> statement-breakpoint
ALTER TABLE "lote_material" DROP CONSTRAINT "lote_material_material_id_material_id_fk";
--> statement-breakpoint
ALTER TABLE "movimento_estoque" DROP CONSTRAINT "movimento_estoque_lote_id_lote_material_id_fk";
--> statement-breakpoint
ALTER TABLE "movimento_estoque" DROP CONSTRAINT "movimento_estoque_material_id_material_id_fk";
--> statement-breakpoint
ALTER TABLE "movimento_estoque" DROP CONSTRAINT "movimento_estoque_execucao_id_execucao_id_fk";
--> statement-breakpoint
ALTER TABLE "movimento_estoque" DROP CONSTRAINT "movimento_estoque_profissional_id_profissional_id_fk";
--> statement-breakpoint
ALTER TABLE "documento" DROP CONSTRAINT "documento_paciente_id_paciente_id_fk";
--> statement-breakpoint
ALTER TABLE "mensagem_whatsapp" DROP CONSTRAINT "mensagem_whatsapp_paciente_id_paciente_id_fk";
--> statement-breakpoint
ALTER TABLE "mensagem_whatsapp" DROP CONSTRAINT "mensagem_whatsapp_agendamento_id_agendamento_id_fk";
--> statement-breakpoint
ALTER TABLE "profissional" ADD CONSTRAINT "profissional_usuario_id_usuario_id_fk" FOREIGN KEY ("usuario_id","clinica_id") REFERENCES "public"."usuario"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consentimento" ADD CONSTRAINT "consentimento_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id","clinica_id") REFERENCES "public"."paciente"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paciente_conta" ADD CONSTRAINT "paciente_conta_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id","clinica_id") REFERENCES "public"."paciente"("id","clinica_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paciente_sessao" ADD CONSTRAINT "paciente_sessao_conta_id_paciente_conta_id_fk" FOREIGN KEY ("conta_id","clinica_id") REFERENCES "public"."paciente_conta"("id","clinica_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paciente_convenio" ADD CONSTRAINT "paciente_convenio_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id","clinica_id") REFERENCES "public"."paciente"("id","clinica_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paciente_convenio" ADD CONSTRAINT "paciente_convenio_convenio_id_convenio_id_fk" FOREIGN KEY ("convenio_id","clinica_id") REFERENCES "public"."convenio"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preco_convenio" ADD CONSTRAINT "preco_convenio_convenio_id_convenio_id_fk" FOREIGN KEY ("convenio_id","clinica_id") REFERENCES "public"."convenio"("id","clinica_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preco_convenio" ADD CONSTRAINT "preco_convenio_procedimento_id_procedimento_id_fk" FOREIGN KEY ("procedimento_id","clinica_id") REFERENCES "public"."procedimento"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agendamento" ADD CONSTRAINT "agendamento_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id","clinica_id") REFERENCES "public"."paciente"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agendamento" ADD CONSTRAINT "agendamento_profissional_id_profissional_id_fk" FOREIGN KEY ("profissional_id","clinica_id") REFERENCES "public"."profissional"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bloqueio_agenda" ADD CONSTRAINT "bloqueio_agenda_profissional_id_profissional_id_fk" FOREIGN KEY ("profissional_id","clinica_id") REFERENCES "public"."profissional"("id","clinica_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bloqueio_agenda" ADD CONSTRAINT "bloqueio_agenda_cadeira_id_cadeira_id_fk" FOREIGN KEY ("cadeira_id","clinica_id") REFERENCES "public"."cadeira"("id","clinica_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerta_clinico" ADD CONSTRAINT "alerta_clinico_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id","clinica_id") REFERENCES "public"."paciente"("id","clinica_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anamnese" ADD CONSTRAINT "anamnese_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id","clinica_id") REFERENCES "public"."paciente"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dente_paciente" ADD CONSTRAINT "dente_paciente_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id","clinica_id") REFERENCES "public"."paciente"("id","clinica_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolucao" ADD CONSTRAINT "evolucao_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id","clinica_id") REFERENCES "public"."paciente"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolucao" ADD CONSTRAINT "evolucao_profissional_id_profissional_id_fk" FOREIGN KEY ("profissional_id","clinica_id") REFERENCES "public"."profissional"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolucao" ADD CONSTRAINT "evolucao_retifica_id_evolucao_id_fk" FOREIGN KEY ("retifica_id","clinica_id") REFERENCES "public"."evolucao"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execucao" ADD CONSTRAINT "execucao_item_plano_id_item_plano_id_fk" FOREIGN KEY ("item_plano_id","clinica_id") REFERENCES "public"."item_plano"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execucao" ADD CONSTRAINT "execucao_profissional_id_profissional_id_fk" FOREIGN KEY ("profissional_id","clinica_id") REFERENCES "public"."profissional"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_plano" ADD CONSTRAINT "item_plano_plano_id_plano_tratamento_id_fk" FOREIGN KEY ("plano_id","clinica_id") REFERENCES "public"."plano_tratamento"("id","clinica_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_plano" ADD CONSTRAINT "item_plano_procedimento_id_procedimento_id_fk" FOREIGN KEY ("procedimento_id","clinica_id") REFERENCES "public"."procedimento"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_plano" ADD CONSTRAINT "item_plano_convenio_id_convenio_id_fk" FOREIGN KEY ("convenio_id","clinica_id") REFERENCES "public"."convenio"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plano_tratamento" ADD CONSTRAINT "plano_tratamento_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id","clinica_id") REFERENCES "public"."paciente"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plano_tratamento" ADD CONSTRAINT "plano_tratamento_profissional_id_profissional_id_fk" FOREIGN KEY ("profissional_id","clinica_id") REFERENCES "public"."profissional"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca" ADD CONSTRAINT "cobranca_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id","clinica_id") REFERENCES "public"."paciente"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orcamento" ADD CONSTRAINT "orcamento_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id","clinica_id") REFERENCES "public"."paciente"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orcamento_item" ADD CONSTRAINT "orcamento_item_orcamento_id_orcamento_id_fk" FOREIGN KEY ("orcamento_id","clinica_id") REFERENCES "public"."orcamento"("id","clinica_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamento" ADD CONSTRAINT "pagamento_parcela_id_parcela_id_fk" FOREIGN KEY ("parcela_id","clinica_id") REFERENCES "public"."parcela"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parcela" ADD CONSTRAINT "parcela_cobranca_id_cobranca_id_fk" FOREIGN KEY ("cobranca_id","clinica_id") REFERENCES "public"."cobranca"("id","clinica_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glosa" ADD CONSTRAINT "glosa_item_guia_id_item_guia_id_fk" FOREIGN KEY ("item_guia_id","clinica_id") REFERENCES "public"."item_guia"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guia_tiss" ADD CONSTRAINT "guia_tiss_convenio_id_convenio_id_fk" FOREIGN KEY ("convenio_id","clinica_id") REFERENCES "public"."convenio"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guia_tiss" ADD CONSTRAINT "guia_tiss_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id","clinica_id") REFERENCES "public"."paciente"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guia_tiss" ADD CONSTRAINT "guia_tiss_profissional_id_profissional_id_fk" FOREIGN KEY ("profissional_id","clinica_id") REFERENCES "public"."profissional"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_guia" ADD CONSTRAINT "item_guia_guia_id_guia_tiss_id_fk" FOREIGN KEY ("guia_id","clinica_id") REFERENCES "public"."guia_tiss"("id","clinica_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_guia" ADD CONSTRAINT "item_guia_item_plano_id_item_plano_id_fk" FOREIGN KEY ("item_plano_id","clinica_id") REFERENCES "public"."item_plano"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurso_glosa" ADD CONSTRAINT "recurso_glosa_glosa_id_glosa_id_fk" FOREIGN KEY ("glosa_id","clinica_id") REFERENCES "public"."glosa"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repasse" ADD CONSTRAINT "repasse_convenio_id_convenio_id_fk" FOREIGN KEY ("convenio_id","clinica_id") REFERENCES "public"."convenio"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repasse_item" ADD CONSTRAINT "repasse_item_repasse_id_repasse_id_fk" FOREIGN KEY ("repasse_id","clinica_id") REFERENCES "public"."repasse"("id","clinica_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repasse_item" ADD CONSTRAINT "repasse_item_item_guia_id_item_guia_id_fk" FOREIGN KEY ("item_guia_id","clinica_id") REFERENCES "public"."item_guia"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insumo_procedimento" ADD CONSTRAINT "insumo_procedimento_procedimento_id_procedimento_id_fk" FOREIGN KEY ("procedimento_id","clinica_id") REFERENCES "public"."procedimento"("id","clinica_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insumo_procedimento" ADD CONSTRAINT "insumo_procedimento_material_id_material_id_fk" FOREIGN KEY ("material_id","clinica_id") REFERENCES "public"."material"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lote_material" ADD CONSTRAINT "lote_material_material_id_material_id_fk" FOREIGN KEY ("material_id","clinica_id") REFERENCES "public"."material"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimento_estoque" ADD CONSTRAINT "movimento_estoque_lote_id_lote_material_id_fk" FOREIGN KEY ("lote_id","clinica_id") REFERENCES "public"."lote_material"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimento_estoque" ADD CONSTRAINT "movimento_estoque_material_id_material_id_fk" FOREIGN KEY ("material_id","clinica_id") REFERENCES "public"."material"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimento_estoque" ADD CONSTRAINT "movimento_estoque_execucao_id_execucao_id_fk" FOREIGN KEY ("execucao_id","clinica_id") REFERENCES "public"."execucao"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimento_estoque" ADD CONSTRAINT "movimento_estoque_profissional_id_profissional_id_fk" FOREIGN KEY ("profissional_id","clinica_id") REFERENCES "public"."profissional"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documento" ADD CONSTRAINT "documento_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id","clinica_id") REFERENCES "public"."paciente"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mensagem_whatsapp" ADD CONSTRAINT "mensagem_whatsapp_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id","clinica_id") REFERENCES "public"."paciente"("id","clinica_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mensagem_whatsapp" ADD CONSTRAINT "mensagem_whatsapp_agendamento_id_agendamento_id_fk" FOREIGN KEY ("agendamento_id","clinica_id") REFERENCES "public"."agendamento"("id","clinica_id") ON DELETE restrict ON UPDATE no action;
