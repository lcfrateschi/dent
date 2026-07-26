-- ============================================================================
-- O orçamento é um documento CONGELADO. Aqui isso deixa de ser convenção e
-- passa a ser garantia do banco.
--
-- Por que no banco: documento comercial que muda depois de entregue ao paciente
-- é problema jurídico, não bug de tela. E o valor congelado é a base da cobrança
-- da Fase 8 — se ele puder mudar, o financeiro não fecha.
--
-- Ver também lib/domain/orcamento.ts, que espelha estas regras com mensagens
-- apresentáveis, e drizzle/0001_constraints.sql, que usa o mesmo padrão para
-- `evolucao` e `audit_log`.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. `valor_bruto` é EXATAMENTE a soma das linhas.
--
--    Deferido porque orçamento e itens nascem na mesma transação — a checagem
--    acontece no COMMIT. Mesmo padrão de `parcela_soma_confere`.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "verifica_soma_orcamento"() RETURNS trigger AS $$
DECLARE
  v_orcamento uuid;
  v_bruto     numeric(10,2);
  v_soma      numeric(10,2);
BEGIN
  v_orcamento := COALESCE(NEW."orcamento_id", OLD."orcamento_id");

  SELECT "valor_bruto" INTO v_bruto FROM "orcamento" WHERE "id" = v_orcamento;

  -- Orçamento apagado na mesma transação: nada a verificar.
  IF v_bruto IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM("valor_unitario" * "quantidade"), 0) INTO v_soma
    FROM "orcamento_item" WHERE "orcamento_id" = v_orcamento;

  IF v_soma <> v_bruto THEN
    RAISE EXCEPTION
      'soma das linhas (%) difere do valor bruto do orcamento (%) [orcamento=%]',
      v_soma, v_bruto, v_orcamento
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "orcamento_item_soma_confere"
  AFTER INSERT OR UPDATE OR DELETE ON "orcamento_item"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "verifica_soma_orcamento"();
--> statement-breakpoint

-- Mexer no valor bruto também dispara a verificação.
CREATE OR REPLACE FUNCTION "verifica_soma_orcamento_por_pai"() RETURNS trigger AS $$
DECLARE v_soma numeric(10,2);
BEGIN
  SELECT COALESCE(SUM("valor_unitario" * "quantidade"), 0) INTO v_soma
    FROM "orcamento_item" WHERE "orcamento_id" = NEW."id";

  IF v_soma <> NEW."valor_bruto" THEN
    RAISE EXCEPTION
      'soma das linhas (%) difere do valor bruto do orcamento (%) [orcamento=%]',
      v_soma, NEW."valor_bruto", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "orcamento_soma_confere"
  AFTER INSERT OR UPDATE OF "valor_bruto" ON "orcamento"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "verifica_soma_orcamento_por_pai"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Orçamento fora de rascunho é IMUTÁVEL no conteúdo.
--
--    Só o que registra o andamento pode mudar: `status`, os carimbos de tempo e
--    a chave do PDF. Valor, itens, validade e desconto ficam como o paciente
--    recebeu. Mudou de ideia? Gera-se outro orçamento.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "orcamento_congelado"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'rascunho' THEN
    RETURN NEW;  -- rascunho ainda é editável
  END IF;

  IF NEW."valor_bruto"  <> OLD."valor_bruto"
     OR NEW."desconto"   <> OLD."desconto"
     OR NEW."valor_total" <> OLD."valor_total"
     OR NEW."validade_ate" <> OLD."validade_ate"
     OR NEW."paciente_id" <> OLD."paciente_id"
     OR NEW."numero"      <> OLD."numero"
     OR COALESCE(NEW."observacao", '') <> COALESCE(OLD."observacao", '') THEN
    RAISE EXCEPTION
      'orcamento % ja foi enviado ao paciente e seu conteudo e imutavel. Gere um novo orcamento.',
      OLD."numero"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "orcamento_bloqueia_alteracao"
  BEFORE UPDATE ON "orcamento"
  FOR EACH ROW EXECUTE FUNCTION "orcamento_congelado"();
--> statement-breakpoint

-- Excluir orçamento já enviado apagaria a prova do que foi combinado.
CREATE OR REPLACE FUNCTION "orcamento_nao_exclui_enviado"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'rascunho' THEN
    RAISE EXCEPTION
      'orcamento % ja foi enviado e nao pode ser excluido.', OLD."numero"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "orcamento_bloqueia_exclusao"
  BEFORE DELETE ON "orcamento"
  FOR EACH ROW EXECUTE FUNCTION "orcamento_nao_exclui_enviado"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Linha de orçamento acompanha o congelamento do pai.
--
--    Sem isto, o conteúdo do documento poderia mudar por baixo: bastaria editar
--    a descrição ou o valor de um item para o papel entregue não valer mais.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "orcamento_item_congelado"() RETURNS trigger AS $$
DECLARE v_status text;
BEGIN
  SELECT "status"::text INTO v_status
    FROM "orcamento"
    WHERE "id" = COALESCE(NEW."orcamento_id", OLD."orcamento_id");

  -- Pai removido na mesma transação (cascade): deixa passar.
  IF v_status IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_status <> 'rascunho' THEN
    RAISE EXCEPTION
      'as linhas de um orcamento enviado sao imutaveis (% em %). Gere um novo orcamento.',
      TG_OP, v_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "orcamento_item_bloqueia_alteracao"
  BEFORE INSERT OR UPDATE OR DELETE ON "orcamento_item"
  FOR EACH ROW EXECUTE FUNCTION "orcamento_item_congelado"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Um orçamento enviado precisa ter ao menos uma linha.
--    Documento vazio entregue ao paciente não significa nada.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "orcamento_enviado_tem_linha"() RETURNS trigger AS $$
DECLARE v_linhas int;
BEGIN
  IF NEW."status" = 'rascunho' THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_linhas FROM "orcamento_item" WHERE "orcamento_id" = NEW."id";

  IF v_linhas = 0 THEN
    RAISE EXCEPTION
      'orcamento % nao pode ser enviado sem nenhuma linha.', NEW."numero"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "orcamento_enviado_com_linha"
  AFTER UPDATE OF "status" ON "orcamento"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "orcamento_enviado_tem_linha"();
