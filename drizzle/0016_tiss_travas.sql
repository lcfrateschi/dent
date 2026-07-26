-- ════════════════════════════════════════════════════════════════════════════
-- Fase 13 — travas do faturamento por convênio.
--
-- O que está em jogo aqui é dinheiro que vem de terceiro, com prazo e com
-- possibilidade de recusa. As regras:
--
--   1. O gancho da Fase 1 finalmente ganha FK.
--   2. Guia enviada é documento apresentado: imutável no que foi apresentado.
--   3. Glosa é append-only — é a posição da operadora, não anotação nossa.
--   4. Repasse não distribui mais do que recebeu.
--   5. valor_apresentado da guia = soma dos itens, conferido no COMMIT.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1. O gancho da Fase 1, fechado.
--
--    `item_plano.guia_tiss_id` existe desde a migration 0000 SEM FK, porque
--    `guia_tiss` não existia. A decisão 4 do CLAUDE.md dizia que o modelo
--    financeiro não precisaria ser refatorado para receber o TISS — isto é a
--    prova: uma constraint, nenhuma coluna movida, nenhum dado convertido.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE "item_plano"
  ADD CONSTRAINT "item_plano_guia_tiss_id_fk"
  FOREIGN KEY ("guia_tiss_id") REFERENCES "guia_tiss"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- Item de convênio é o único que pode ir para guia. Particular numa guia TISS
-- seria cobrar da operadora o que o paciente já pagou.
ALTER TABLE "item_plano"
  ADD CONSTRAINT "item_plano_guia_exige_convenio"
  CHECK ("guia_tiss_id" IS NULL OR "cobertura" = 'convenio');
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Guia enviada é imutável no que foi apresentado.
--
--    Depois do protocolo, mudar valor ou paciente da guia faria o nosso registro
--    divergir do documento que está com a operadora — e numa discussão de glosa é
--    o nosso registro que perde credibilidade.
--
--    O que PODE mudar depois do envio: situação, valor pago, protocolo, retorno e
--    previsão de repasse. Tudo isso é resposta da operadora, não conteúdo nosso.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "guia_congelada_apos_envio"() RETURNS trigger AS $$
BEGIN
  IF OLD."enviada_em" IS NULL THEN
    RETURN NEW;  -- rascunho: livre
  END IF;

  IF NEW."numero" IS DISTINCT FROM OLD."numero"
     OR NEW."convenio_id" IS DISTINCT FROM OLD."convenio_id"
     OR NEW."paciente_id" IS DISTINCT FROM OLD."paciente_id"
     OR NEW."numero_carteirinha" IS DISTINCT FROM OLD."numero_carteirinha"
     OR NEW."profissional_id" IS DISTINCT FROM OLD."profissional_id"
     OR NEW."valor_apresentado" IS DISTINCT FROM OLD."valor_apresentado" THEN
    RAISE EXCEPTION
      'guia % foi enviada e o que foi apresentado nao muda mais. Para corrigir, cancele e emita outra.',
      OLD."numero"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."enviada_em" IS DISTINCT FROM OLD."enviada_em" THEN
    RAISE EXCEPTION 'a data de envio da guia % nao se reescreve.', OLD."numero"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "guia_congela_apos_envio"
  BEFORE UPDATE ON "guia_tiss"
  FOR EACH ROW EXECUTE FUNCTION "guia_congelada_apos_envio"();
--> statement-breakpoint

CREATE TRIGGER "guia_toca_atualizado_em"
  BEFORE UPDATE ON "guia_tiss"
  FOR EACH ROW EXECUTE FUNCTION "toca_atualizado_em"();
--> statement-breakpoint

-- Item de guia enviada também não muda no que foi apresentado, e não se apaga:
-- apagar linha de guia protocolada é perder a prova do que foi pedido.
CREATE OR REPLACE FUNCTION "item_guia_congelado_apos_envio"() RETURNS trigger AS $$
DECLARE v_enviada timestamptz; v_numero numeric;
BEGIN
  SELECT g."enviada_em", g."numero" INTO v_enviada, v_numero
    FROM "guia_tiss" g
   WHERE g."id" = COALESCE(NEW."guia_id", OLD."guia_id");

  IF v_enviada IS NULL THEN
    RETURN COALESCE(NEW, OLD);  -- rascunho: livre
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'item de guia enviada (guia %) nao pode ser excluido — e a prova do que foi apresentado.',
      v_numero
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."valor_apresentado" IS DISTINCT FROM OLD."valor_apresentado"
     OR NEW."item_plano_id" IS DISTINCT FROM OLD."item_plano_id"
     OR NEW."codigo_tuss" IS DISTINCT FROM OLD."codigo_tuss"
     OR NEW."descricao" IS DISTINCT FROM OLD."descricao"
     OR NEW."quantidade" IS DISTINCT FROM OLD."quantidade"
     OR NEW."data_execucao" IS DISTINCT FROM OLD."data_execucao" THEN
    RAISE EXCEPTION
      'item de guia enviada (guia %) e imutavel no que foi apresentado.', v_numero
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "item_guia_congela_apos_envio"
  BEFORE UPDATE OR DELETE ON "item_guia"
  FOR EACH ROW EXECUTE FUNCTION "item_guia_congelado_apos_envio"();
--> statement-breakpoint

CREATE TRIGGER "item_guia_toca_atualizado_em"
  BEFORE UPDATE ON "item_guia"
  FOR EACH ROW EXECUTE FUNCTION "toca_atualizado_em"();
--> statement-breakpoint

-- Item só entra em guia JÁ ENVIADA se for reapresentação — e reapresentação cria
-- item novo em guia nova, nunca acrescenta linha a um protocolo existente.
CREATE OR REPLACE FUNCTION "item_guia_nao_entra_em_guia_enviada"() RETURNS trigger AS $$
DECLARE v_enviada timestamptz; v_numero numeric;
BEGIN
  SELECT g."enviada_em", g."numero" INTO v_enviada, v_numero
    FROM "guia_tiss" g WHERE g."id" = NEW."guia_id";

  IF v_enviada IS NOT NULL THEN
    RAISE EXCEPTION
      'nao se acrescenta item a guia ja enviada (guia %). Reapresentacao vai em guia nova.',
      v_numero
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "item_guia_valida_insercao"
  BEFORE INSERT ON "item_guia"
  FOR EACH ROW EXECUTE FUNCTION "item_guia_nao_entra_em_guia_enviada"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Glosa é append-only.
--
--    É a posição da operadora sobre um item, registrada com data. Editar depois
--    apagaria a razão de um recurso já protocolado; apagar apagaria o motivo de a
--    clínica não ter recebido. Correção se faz registrando o recurso e o retorno.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "glosa_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'glosa nao pode ser excluida — e o motivo registrado de a clinica nao ter recebido.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RAISE EXCEPTION
    'glosa e imutavel. Para contestar, registre um recurso em recurso_glosa.'
    USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "glosa_bloqueia_alteracao"
  BEFORE UPDATE OR DELETE ON "glosa"
  FOR EACH ROW EXECUTE FUNCTION "glosa_append_only"();
--> statement-breakpoint

-- Glosa não pode ser maior que o apresentado no item.
CREATE OR REPLACE FUNCTION "glosa_nao_excede_item"() RETURNS trigger AS $$
DECLARE v_apresentado numeric; v_glosado numeric;
BEGIN
  SELECT "valor_apresentado" INTO v_apresentado FROM "item_guia" WHERE "id" = NEW."item_guia_id";

  SELECT coalesce(sum("valor"), 0) INTO v_glosado
    FROM "glosa" WHERE "item_guia_id" = NEW."item_guia_id";

  IF v_glosado + NEW."valor" > v_apresentado THEN
    RAISE EXCEPTION
      'glosa acumulada (%) excede o valor apresentado no item (%).',
      v_glosado + NEW."valor", v_apresentado
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "glosa_valida_valor"
  BEFORE INSERT ON "glosa"
  FOR EACH ROW EXECUTE FUNCTION "glosa_nao_excede_item"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Repasse não distribui mais do que recebeu.
--
--    Conferido no COMMIT (constraint trigger deferida), como a soma das parcelas
--    da Fase 1: a conciliação lança várias linhas e só ao final o total fecha.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "verifica_soma_repasse"() RETURNS trigger AS $$
DECLARE v_total numeric; v_soma numeric; v_id uuid;
BEGIN
  v_id := COALESCE(NEW."repasse_id", OLD."repasse_id");

  SELECT "valor_total" INTO v_total FROM "repasse" WHERE "id" = v_id;
  IF v_total IS NULL THEN RETURN NULL; END IF;  -- repasse apagado na mesma transação

  SELECT coalesce(sum("valor"), 0) INTO v_soma FROM "repasse_item" WHERE "repasse_id" = v_id;

  IF v_soma > v_total THEN
    RAISE EXCEPTION
      'a conciliacao (%) distribui mais do que o repasse recebeu (%) [repasse=%]',
      v_soma, v_total, v_id
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE "repasse" SET "valor_conciliado" = v_soma WHERE "id" = v_id;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "repasse_item_confere_soma"
  AFTER INSERT OR UPDATE OR DELETE ON "repasse_item"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "verifica_soma_repasse"();
--> statement-breakpoint

-- Repasse fechado não recebe mais atribuição: fechar significa "conferi".
CREATE OR REPLACE FUNCTION "repasse_fechado_nao_muda"() RETURNS trigger AS $$
DECLARE v_fechado timestamptz;
BEGIN
  SELECT "fechado_em" INTO v_fechado FROM "repasse"
   WHERE "id" = COALESCE(NEW."repasse_id", OLD."repasse_id");

  IF v_fechado IS NOT NULL THEN
    RAISE EXCEPTION
      'repasse fechado em % nao aceita mudanca na conciliacao. Reabrir e decisao humana.',
      v_fechado
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "repasse_item_respeita_fechamento"
  BEFORE INSERT OR UPDATE OR DELETE ON "repasse_item"
  FOR EACH ROW EXECUTE FUNCTION "repasse_fechado_nao_muda"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 5. `guia.valor_pago` mantido pelo banco, somando os itens.
--
--    Mesma razão de `parcela.status` na Fase 8: valor derivado que a aplicação
--    precisa lembrar de atualizar é valor que um dia fica errado. Aqui o banco
--    recalcula a cada mudança de item.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "recalcula_valor_pago_guia"() RETURNS trigger AS $$
DECLARE v_guia uuid;
BEGIN
  SELECT "guia_id" INTO v_guia FROM "item_guia"
   WHERE "id" = COALESCE(NEW."item_guia_id", OLD."item_guia_id");
  IF v_guia IS NULL THEN RETURN NULL; END IF;

  UPDATE "item_guia" ig
     SET "valor_pago" = (
       SELECT coalesce(sum(ri."valor"), 0) FROM "repasse_item" ri
        WHERE ri."item_guia_id" = ig."id"
     )
   WHERE ig."id" = COALESCE(NEW."item_guia_id", OLD."item_guia_id");

  UPDATE "guia_tiss" g
     SET "valor_pago" = (
       SELECT coalesce(sum(ig."valor_pago"), 0) FROM "item_guia" ig WHERE ig."guia_id" = g."id"
     )
   WHERE g."id" = v_guia;

  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "repasse_item_atualiza_pago"
  AFTER INSERT OR UPDATE OR DELETE ON "repasse_item"
  FOR EACH ROW EXECUTE FUNCTION "recalcula_valor_pago_guia"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 6. `guia.valor_apresentado` = soma dos itens, conferida no COMMIT.
--
--    Deferida porque a guia é montada em duas etapas: cria o cabeçalho, depois
--    insere os itens. Conferir na hora impediria o passo intermediário.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "verifica_soma_guia"() RETURNS trigger AS $$
DECLARE v_id uuid; v_declarado numeric; v_soma numeric; v_situacao text;
BEGIN
  v_id := COALESCE(NEW."guia_id", OLD."guia_id");

  SELECT "valor_apresentado", "situacao"::text INTO v_declarado, v_situacao
    FROM "guia_tiss" WHERE "id" = v_id;
  IF v_declarado IS NULL THEN RETURN NULL; END IF;

  -- Rascunho pode estar em construção; a conferência vale de 'enviada' em diante.
  IF v_situacao = 'rascunho' OR v_situacao = 'cancelada' THEN RETURN NULL; END IF;

  SELECT coalesce(sum("valor_apresentado"), 0) INTO v_soma
    FROM "item_guia" WHERE "guia_id" = v_id;

  IF v_soma <> v_declarado THEN
    RAISE EXCEPTION
      'soma dos itens (%) difere do valor apresentado da guia (%) [guia=%]',
      v_soma, v_declarado, v_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "item_guia_confere_soma"
  AFTER INSERT OR UPDATE OR DELETE ON "item_guia"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "verifica_soma_guia"();
