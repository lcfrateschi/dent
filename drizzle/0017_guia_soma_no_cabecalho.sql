-- ════════════════════════════════════════════════════════════════════════════
-- Fase 13 — a conferência da soma também tem de disparar pelo CABEÇALHO.
--
-- A trigger de 0016 (`item_guia_confere_soma`) só dispara quando um ITEM muda.
-- Isso deixava um furo: alterar `guia_tiss.valor_apresentado` direto, sem tocar em
-- item nenhum, passava sem conferência — e uma guia pode então ser enviada
-- declarando um total que não corresponde aos procedimentos nela.
--
-- Encontrado por `npm run db:verificar`: o caso "enviar guia com soma dos itens
-- diferente do total" era ACEITO. É o tipo de furo que só aparece quando alguém
-- testa o lado errado da relação.
--
-- A conferência agora existe nas duas pontas, e é a mesma função.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION "verifica_soma_guia_pelo_cabecalho"() RETURNS trigger AS $$
DECLARE v_soma numeric;
BEGIN
  -- Rascunho está em construção; a conferência vale de 'enviada' em diante.
  IF NEW."situacao" = 'rascunho' OR NEW."situacao" = 'cancelada' THEN RETURN NULL; END IF;

  SELECT coalesce(sum("valor_apresentado"), 0) INTO v_soma
    FROM "item_guia" WHERE "guia_id" = NEW."id";

  IF v_soma <> NEW."valor_apresentado" THEN
    RAISE EXCEPTION
      'soma dos itens (%) difere do valor apresentado da guia % (%)',
      v_soma, NEW."numero", NEW."valor_apresentado"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "guia_confere_soma"
  AFTER INSERT OR UPDATE ON "guia_tiss"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "verifica_soma_guia_pelo_cabecalho"();
