-- ============================================================================
-- Invariantes que o Drizzle não expressa. Estas regras existem no BANCO de
-- propósito: são garantias legais e financeiras, não convenções de código.
-- Aplicação com bug não pode furá-las.
--
-- ATENÇÃO: nunca use `drizzle-kit push` neste projeto — ele desconhece
-- EXCLUDE constraints e triggers e pode derrubá-las. Use generate + migrate.
-- ============================================================================

-- Necessária para EXCLUDE com uuid WITH = (gist não indexa uuid nativamente).
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Agenda: dois atendimentos não podem ocupar o mesmo profissional nem a
--    mesma cadeira ao mesmo tempo. Cancelados e faltas liberam o horário.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE "agendamento"
  ADD CONSTRAINT "agendamento_sem_conflito_profissional"
  EXCLUDE USING gist (
    "profissional_id" WITH =,
    tstzrange("inicio", "fim", '[)') WITH &&
  ) WHERE ("status" NOT IN ('cancelado', 'faltou'));
--> statement-breakpoint

ALTER TABLE "agendamento"
  ADD CONSTRAINT "agendamento_sem_conflito_cadeira"
  EXCLUDE USING gist (
    "cadeira_id" WITH =,
    tstzrange("inicio", "fim", '[)') WITH &&
  ) WHERE ("cadeira_id" IS NOT NULL AND "status" NOT IN ('cancelado', 'faltou'));
--> statement-breakpoint

-- Um profissional não pode ter dois bloqueios sobrepostos (férias dentro de férias).
ALTER TABLE "bloqueio_agenda"
  ADD CONSTRAINT "bloqueio_sem_sobreposicao_profissional"
  EXCLUDE USING gist (
    "profissional_id" WITH =,
    tstzrange("inicio", "fim", '[)') WITH &&
  ) WHERE ("profissional_id" IS NOT NULL);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Evolução clínica: append-only.
--    Rascunho (assinado_em IS NULL) ainda pode ser editado pelo autor.
--    Assinada, torna-se imutável para sempre — exigência do CFO.
--    Corrigir evolução assinada = inserir nova linha com retifica_id.
--    DELETE nunca, em nenhuma hipótese: guarda mínima de 20 anos.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "evolucao_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'evolucao nao pode ser excluida (guarda legal de 20 anos). Registre uma retificacao.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."assinado_em" IS NOT NULL THEN
    RAISE EXCEPTION
      'evolucao % ja esta assinada e e imutavel. Insira nova evolucao com retifica_id = % e motivo_retificacao.',
      OLD."id", OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Mesmo em rascunho, a autoria e o vínculo não mudam.
  IF NEW."paciente_id" <> OLD."paciente_id"
     OR NEW."profissional_id" <> OLD."profissional_id"
     OR NEW."criado_em" <> OLD."criado_em"
     OR COALESCE(NEW."retifica_id"::text, '') <> COALESCE(OLD."retifica_id"::text, '') THEN
    RAISE EXCEPTION
      'paciente_id, profissional_id, criado_em e retifica_id de uma evolucao sao imutaveis.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "evolucao_bloqueia_update"
  BEFORE UPDATE ON "evolucao"
  FOR EACH ROW EXECUTE FUNCTION "evolucao_append_only"();
--> statement-breakpoint

CREATE TRIGGER "evolucao_bloqueia_delete"
  BEFORE DELETE ON "evolucao"
  FOR EACH ROW EXECUTE FUNCTION "evolucao_append_only"();
--> statement-breakpoint

-- Uma evolução não pode retificar a si mesma.
ALTER TABLE "evolucao"
  ADD CONSTRAINT "evolucao_nao_retifica_a_si"
  CHECK ("retifica_id" IS NULL OR "retifica_id" <> "id");
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 3. audit_log: append-only absoluto. Trilha que se pode editar não é trilha.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "audit_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log e append-only: % nao e permitido.', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "audit_log_bloqueia_alteracao"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_append_only"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Financeiro: a soma das parcelas não canceladas é exatamente o total da
--    cobrança. DEFERRABLE porque cobrança e parcelas nascem na mesma
--    transação — a checagem acontece no COMMIT, não a cada INSERT.
--    Cobrança cancelada está isenta.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "verifica_soma_parcelas"() RETURNS trigger AS $$
DECLARE
  v_cobranca  uuid;
  v_total     numeric(10,2);
  v_cancelada timestamptz;
  v_soma      numeric(10,2);
BEGIN
  v_cobranca := COALESCE(NEW."cobranca_id", OLD."cobranca_id");

  SELECT "valor_total", "cancelado_em" INTO v_total, v_cancelada
    FROM "cobranca" WHERE "id" = v_cobranca;

  -- Cobrança apagada na mesma transação, ou cancelada: nada a verificar.
  IF v_total IS NULL OR v_cancelada IS NOT NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM("valor"), 0) INTO v_soma
    FROM "parcela"
    WHERE "cobranca_id" = v_cobranca AND "status" <> 'cancelada';

  IF v_soma <> v_total THEN
    RAISE EXCEPTION
      'soma das parcelas (%) difere do total da cobranca (%) [cobranca=%]',
      v_soma, v_total, v_cobranca
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "parcela_soma_confere"
  AFTER INSERT OR UPDATE OR DELETE ON "parcela"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "verifica_soma_parcelas"();
--> statement-breakpoint

-- Mexer no total da cobrança também dispara a verificação.
CREATE OR REPLACE FUNCTION "verifica_soma_parcelas_por_cobranca"() RETURNS trigger AS $$
DECLARE
  v_soma numeric(10,2);
BEGIN
  IF NEW."cancelado_em" IS NOT NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM("valor"), 0) INTO v_soma
    FROM "parcela"
    WHERE "cobranca_id" = NEW."id" AND "status" <> 'cancelada';

  IF v_soma <> NEW."valor_total" THEN
    RAISE EXCEPTION
      'soma das parcelas (%) difere do total da cobranca (%) [cobranca=%]',
      v_soma, NEW."valor_total", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "cobranca_soma_confere"
  AFTER INSERT OR UPDATE OF "valor_total", "cancelado_em" ON "cobranca"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "verifica_soma_parcelas_por_cobranca"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Pagamentos de uma parcela não podem exceder o valor dela
--    (somando os lançados, ignorando estornados).
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "verifica_pagamento_nao_excede_parcela"() RETURNS trigger AS $$
DECLARE
  v_parcela numeric(10,2);
  v_pago    numeric(10,2);
BEGIN
  SELECT "valor" INTO v_parcela FROM "parcela" WHERE "id" = NEW."parcela_id";

  SELECT COALESCE(SUM("valor"), 0) INTO v_pago
    FROM "pagamento"
    WHERE "parcela_id" = NEW."parcela_id" AND "estornado_em" IS NULL;

  IF v_pago > v_parcela THEN
    RAISE EXCEPTION
      'pagamentos (%) excedem o valor da parcela (%) [parcela=%]',
      v_pago, v_parcela, NEW."parcela_id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "pagamento_nao_excede_parcela"
  AFTER INSERT OR UPDATE OF "valor", "estornado_em" ON "pagamento"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "verifica_pagamento_nao_excede_parcela"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 6. atualizado_em mantido pelo banco. Timestamp que depende de a aplicação
--    lembrar de setar é timestamp que mente.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "toca_atualizado_em"() RETURNS trigger AS $$
BEGIN
  NEW."atualizado_em" := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "clinica_toca_atualizado_em" BEFORE UPDATE ON "clinica"
  FOR EACH ROW EXECUTE FUNCTION "toca_atualizado_em"();
--> statement-breakpoint
CREATE TRIGGER "usuario_toca_atualizado_em" BEFORE UPDATE ON "usuario"
  FOR EACH ROW EXECUTE FUNCTION "toca_atualizado_em"();
--> statement-breakpoint
CREATE TRIGGER "profissional_toca_atualizado_em" BEFORE UPDATE ON "profissional"
  FOR EACH ROW EXECUTE FUNCTION "toca_atualizado_em"();
--> statement-breakpoint
CREATE TRIGGER "paciente_toca_atualizado_em" BEFORE UPDATE ON "paciente"
  FOR EACH ROW EXECUTE FUNCTION "toca_atualizado_em"();
--> statement-breakpoint
CREATE TRIGGER "agendamento_toca_atualizado_em" BEFORE UPDATE ON "agendamento"
  FOR EACH ROW EXECUTE FUNCTION "toca_atualizado_em"();
--> statement-breakpoint
CREATE TRIGGER "plano_tratamento_toca_atualizado_em" BEFORE UPDATE ON "plano_tratamento"
  FOR EACH ROW EXECUTE FUNCTION "toca_atualizado_em"();
--> statement-breakpoint
CREATE TRIGGER "item_plano_toca_atualizado_em" BEFORE UPDATE ON "item_plano"
  FOR EACH ROW EXECUTE FUNCTION "toca_atualizado_em"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Paciente não pode ser responsável legal de si mesmo.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE "paciente"
  ADD CONSTRAINT "paciente_nao_e_responsavel_de_si"
  CHECK ("responsavel_legal_id" IS NULL OR "responsavel_legal_id" <> "id");
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 8. Número de orçamento: sequência legível, para o paciente citar ao telefone.
-- ────────────────────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS "orcamento_numero_seq" AS integer START 1;
--> statement-breakpoint
ALTER TABLE "orcamento"
  ALTER COLUMN "numero" SET DEFAULT nextval('orcamento_numero_seq');
