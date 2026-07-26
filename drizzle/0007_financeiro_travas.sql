-- ============================================================================
-- Invariantes do financeiro.
--
-- A Fase 1 já pôs no banco a soma das parcelas e o limite de pagamento por
-- parcela. Aqui entram as que faltavam, e a mais interessante delas:
-- `parcela.status` deixa de ser um campo que a aplicação lembra de atualizar e
-- passa a ser mantido pelo BANCO a cada pagamento.
--
-- Por que isso importa: status de parcela desatualizado é a origem clássica de
-- "o sistema diz que ele deve, mas ele pagou". Se o campo existe, ele tem que
-- ser verdade — ou não deveria existir.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. `parcela.status` mantido pelo banco a partir dos pagamentos.
--
--    `vencida` NÃO entra aqui de propósito: depende de "hoje" e viraria trabalho
--    de cron. É derivada na leitura, em lib/domain/cobranca.ts.
--    `cancelada` também não: é decisão humana, e o trigger a preserva.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "recalcula_status_parcela"() RETURNS trigger AS $$
DECLARE
  v_parcela uuid;
  v_valor   numeric(10,2);
  v_status  text;
  v_pago    numeric(10,2);
BEGIN
  v_parcela := COALESCE(NEW."parcela_id", OLD."parcela_id");

  SELECT "valor", "status"::text INTO v_valor, v_status
    FROM "parcela" WHERE "id" = v_parcela;

  -- Parcela apagada na mesma transação, ou cancelada: não mexe.
  IF v_valor IS NULL OR v_status = 'cancelada' THEN
    RETURN NULL;
  END IF;

  -- Estornado não conta. Conciliado ou não, ainda quita a dívida do paciente —
  -- a conciliação importa para comissão, não para o saldo devedor.
  SELECT COALESCE(SUM("valor"), 0) INTO v_pago
    FROM "pagamento"
    WHERE "parcela_id" = v_parcela AND "estornado_em" IS NULL;

  UPDATE "parcela"
     SET "status" = CASE
           WHEN v_pago >= v_valor THEN 'paga'::status_parcela
           WHEN v_pago > 0        THEN 'parcial'::status_parcela
           ELSE 'aberta'::status_parcela
         END
   WHERE "id" = v_parcela;

  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "pagamento_atualiza_status_parcela"
  AFTER INSERT OR DELETE OR UPDATE OF "valor", "estornado_em" ON "pagamento"
  FOR EACH ROW EXECUTE FUNCTION "recalcula_status_parcela"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Um orçamento gera UMA cobrança.
--
--    Sem isto, dois cliques no botão faturam o mesmo tratamento duas vezes — e
--    o paciente recebe duas cobranças do mesmo orçamento.
--    Cobrança cancelada libera, para permitir refazer.
-- ────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "cobranca_uma_por_orcamento"
  ON "cobranca" ("orcamento_id")
  WHERE ("orcamento_id" IS NOT NULL AND "cancelado_em" IS NULL);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Cobrança com pagamento não se exclui.
--
--    Dinheiro que entrou é fato contábil. Cancelar (preencher `cancelado_em`)
--    preserva o histórico; DELETE apagaria a prova de que houve recebimento.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "cobranca_nao_exclui_com_pagamento"() RETURNS trigger AS $$
DECLARE v_pagamentos int;
BEGIN
  SELECT count(*) INTO v_pagamentos
    FROM "pagamento" p
    JOIN "parcela" pa ON pa."id" = p."parcela_id"
   WHERE pa."cobranca_id" = OLD."id";

  IF v_pagamentos > 0 THEN
    RAISE EXCEPTION
      'cobranca com % pagamento(s) registrado(s) nao pode ser excluida. Cancele em vez de excluir.',
      v_pagamentos
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "cobranca_bloqueia_exclusao_com_pagamento"
  BEFORE DELETE ON "cobranca"
  FOR EACH ROW EXECUTE FUNCTION "cobranca_nao_exclui_com_pagamento"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Só orçamento APROVADO gera cobrança.
--
--    Cobrar sobre rascunho, ou sobre orçamento que o paciente recusou, é o tipo
--    de erro que chega ao paciente antes de chegar a quem programou.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "cobranca_exige_orcamento_aprovado"() RETURNS trigger AS $$
DECLARE v_status text; v_numero int;
BEGIN
  IF NEW."orcamento_id" IS NULL THEN
    RETURN NEW;  -- cobrança avulsa, sem orçamento, é permitida
  END IF;

  SELECT "status"::text, "numero" INTO v_status, v_numero
    FROM "orcamento" WHERE "id" = NEW."orcamento_id";

  IF v_status IS DISTINCT FROM 'aprovado' THEN
    RAISE EXCEPTION
      'orcamento % esta em "%" — so orcamento aprovado gera cobranca.', v_numero, v_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "cobranca_valida_orcamento"
  BEFORE INSERT ON "cobranca"
  FOR EACH ROW EXECUTE FUNCTION "cobranca_exige_orcamento_aprovado"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Pagamento em parcela cancelada não faz sentido.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "pagamento_recusa_parcela_cancelada"() RETURNS trigger AS $$
DECLARE v_status text;
BEGIN
  SELECT "status"::text INTO v_status FROM "parcela" WHERE "id" = NEW."parcela_id";

  IF v_status = 'cancelada' THEN
    RAISE EXCEPTION 'nao e possivel receber numa parcela cancelada.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "pagamento_valida_parcela"
  BEFORE INSERT ON "pagamento"
  FOR EACH ROW EXECUTE FUNCTION "pagamento_recusa_parcela_cancelada"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Pagamento não se exclui — estorna-se.
--
--    Mesma razão da evolução e do audit_log: apagar recebimento apaga a
--    contabilidade. `estornado_em` + `motivo_estorno` preservam a história.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "pagamento_nao_exclui"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'pagamento nao pode ser excluido. Registre um estorno com motivo.'
    USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "pagamento_bloqueia_exclusao"
  BEFORE DELETE ON "pagamento"
  FOR EACH ROW EXECUTE FUNCTION "pagamento_nao_exclui"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Índices para as listagens que a recepção usa todo dia.
-- ────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "parcela_inadimplencia_idx"
  ON "parcela" ("vencimento")
  WHERE ("status" IN ('aberta', 'parcial'));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "pagamento_conciliacao_idx"
  ON "pagamento" ("conciliado", "pago_em")
  WHERE ("estornado_em" IS NULL);
