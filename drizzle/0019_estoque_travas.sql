-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  Fase 14 — Estoque: as travas que não são disciplina de código            ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- Seis garantias, todas no banco:
--
--   1. saldo é derivado dos movimentos — e ninguém escreve nele à mão
--   2. saldo nunca fica negativo (não se consome o que não existe)
--   3. o livro é append-only: sem UPDATE, sem DELETE
--   4. lote vencido não é consumido — só descartado
--   5. material controlado (Portaria 344/98) não sai sem responsável e motivo
--   6. material de rastreabilidade obrigatória não entra sem lote do fabricante
--
-- Nada disso pode morar só na server action: um `npm run db:seed`, um importador
-- de planilha ou um psql aberto na madrugada passariam por cima. Estoque que
-- fecha por convenção não fecha.

-- ── 1. Coerência material × lote, provada pelo banco ────────────────────────
-- `movimento_estoque.material_id` é redundante com o do lote — existe para as
-- consultas por material não precisarem de join. Redundância sem trava vira
-- divergência: este FK composto torna impossível um movimento apontar para um
-- lote de outro material.
ALTER TABLE "movimento_estoque"
  ADD CONSTRAINT "movimento_lote_do_mesmo_material"
  FOREIGN KEY ("lote_id", "material_id")
  REFERENCES "lote_material" ("id", "material_id");
--> statement-breakpoint

-- ── 2. O dia civil da clínica, em SQL ───────────────────────────────────────
-- Validade é dia civil. Um lote que vence 31/07 ainda serve às 22h de 31/07 em
-- São Paulo — que já é 01/08 em UTC. Comparar com `current_date` do servidor
-- descartaria material bom (ou aprovaria vencido, no outro sentido).
-- Mesma decisão de `lib/domain/fuso.ts`, agora do lado do banco.
CREATE OR REPLACE FUNCTION hoje_na_clinica() RETURNS date AS $$
  SELECT (now() AT TIME ZONE coalesce(
    (SELECT fuso_horario FROM clinica WHERE id = 1),
    'America/Sao_Paulo'
  ))::date;
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- ── 3. Saldo derivado, e as regras da baixa ─────────────────────────────────
CREATE OR REPLACE FUNCTION estoque_aplicar_movimento() RETURNS trigger AS $$
DECLARE
  v_lote     lote_material;
  v_material material;
  v_novo     numeric(12,3);
BEGIN
  -- FOR UPDATE serializa duas baixas simultâneas do mesmo lote. Sem o lock, duas
  -- transações leem saldo 1, ambas passam na verificação e o saldo vai a -1 —
  -- e aí só o CHECK salva, com mensagem que ninguém entende.
  SELECT * INTO v_lote FROM lote_material WHERE id = NEW.lote_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lote % não existe.', NEW.lote_id;
  END IF;

  SELECT * INTO v_material FROM material WHERE id = v_lote.material_id;

  -- Lote vencido: descarte sim, consumo não. Devolução ao fornecedor também é
  -- legítima (é justamente o que se faz com lote vencido que ele aceita trocar).
  IF NEW.tipo = 'consumo' AND v_lote.validade IS NOT NULL
     AND v_lote.validade < hoje_na_clinica() THEN
    RAISE EXCEPTION
      'Lote % (%) venceu em % e não pode ser consumido em paciente — registre descarte.',
      v_lote.id, coalesce(v_lote.codigo_fabricante, 'sem código'), v_lote.validade;
  END IF;

  -- Portaria 344/98: saída de controlado sem responsável e sem motivo é
  -- exatamente o que a fiscalização cobra. Entrada não precisa (a nota é a prova).
  IF v_material.controlado AND NEW.quantidade < 0 THEN
    IF NEW.profissional_id IS NULL THEN
      RAISE EXCEPTION
        'Material controlado (%): saída exige o profissional responsável.', v_material.codigo;
    END IF;
    IF NEW.motivo IS NULL OR btrim(NEW.motivo) = '' THEN
      RAISE EXCEPTION
        'Material controlado (%): saída exige motivo registrado.', v_material.codigo;
    END IF;
  END IF;

  v_novo := v_lote.saldo + NEW.quantidade;

  IF v_novo < 0 THEN
    RAISE EXCEPTION
      'Saldo insuficiente no lote %: há % e a baixa pede %.',
      v_lote.id, v_lote.saldo, abs(NEW.quantidade);
  END IF;

  UPDATE lote_material
     SET saldo = v_novo, atualizado_em = now()
   WHERE id = NEW.lote_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER movimento_estoque_aplicar
  BEFORE INSERT ON movimento_estoque
  FOR EACH ROW EXECUTE FUNCTION estoque_aplicar_movimento();
--> statement-breakpoint

-- ── 4. O livro é append-only ────────────────────────────────────────────────
-- Mesma razão da `evolucao` do prontuário: apagar a linha apagaria a prova de
-- que a contagem já não fechava. Erro de lançamento se corrige com `ajuste` no
-- sentido contrário, com motivo — que é o que um inventário de verdade faz.
CREATE OR REPLACE FUNCTION movimento_estoque_imutavel() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'movimento_estoque é append-only. Para corrigir, insira um ajuste em sentido contrário com motivo.';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER movimento_estoque_sem_update
  BEFORE UPDATE ON movimento_estoque
  FOR EACH ROW EXECUTE FUNCTION movimento_estoque_imutavel();
--> statement-breakpoint

CREATE TRIGGER movimento_estoque_sem_delete
  BEFORE DELETE ON movimento_estoque
  FOR EACH ROW EXECUTE FUNCTION movimento_estoque_imutavel();
--> statement-breakpoint

-- ── 5. Saldo não se digita ──────────────────────────────────────────────────
-- A trava anterior mantém o saldo certo quando a escrita passa pelo movimento.
-- Esta impede o outro caminho: `UPDATE lote_material SET saldo = 999`.
-- Constraint trigger DEFERRABLE porque a própria trigger de aplicação atualiza o
-- saldo dentro da transação — a verificação tem de acontecer no commit.
CREATE OR REPLACE FUNCTION lote_saldo_bate_com_movimentos() RETURNS trigger AS $$
DECLARE
  v_id       uuid := coalesce(NEW.id, OLD.id);
  v_saldo    numeric(12,3);
  v_soma     numeric(12,3);
BEGIN
  SELECT saldo INTO v_saldo FROM lote_material WHERE id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT coalesce(sum(quantidade), 0) INTO v_soma
    FROM movimento_estoque WHERE lote_id = v_id;

  IF v_saldo <> v_soma THEN
    RAISE EXCEPTION
      'Saldo do lote % (%) não é a soma dos movimentos (%). Saldo é derivado: mexa nos movimentos.',
      v_id, v_saldo, v_soma;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER lote_saldo_derivado
  AFTER INSERT OR UPDATE OF saldo ON lote_material
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION lote_saldo_bate_com_movimentos();
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER movimento_confere_saldo
  AFTER INSERT ON movimento_estoque
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION lote_saldo_bate_com_movimentos();
--> statement-breakpoint

-- ── 6. Rastreabilidade obrigatória entra com lote do fabricante ─────────────
-- Implante, enxerto e membrana: se o fabricante recolher um lote, a clínica tem
-- de dizer em quem foi usado. Sem o número do lote na entrada, essa pergunta não
-- tem resposta possível depois — nenhum campo posterior recupera o dado.
CREATE OR REPLACE FUNCTION lote_exige_codigo_do_fabricante() RETURNS trigger AS $$
DECLARE
  v_material material;
BEGIN
  SELECT * INTO v_material FROM material WHERE id = NEW.material_id;
  IF v_material.exige_lote_do_fabricante
     AND (NEW.codigo_fabricante IS NULL OR btrim(NEW.codigo_fabricante) = '') THEN
    RAISE EXCEPTION
      'Material % exige o número do lote do fabricante (rastreabilidade de recolhimento).',
      v_material.codigo;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER lote_codigo_fabricante_obrigatorio
  BEFORE INSERT OR UPDATE OF codigo_fabricante, material_id ON lote_material
  FOR EACH ROW EXECUTE FUNCTION lote_exige_codigo_do_fabricante();
--> statement-breakpoint

-- ── 7. Lote não troca de material depois de ter movimento ───────────────────
-- O FK composto já impediria a divergência, mas o erro que ele dá é obscuro.
-- Este é explícito, e cobre também o lote ainda sem movimento nenhum.
CREATE OR REPLACE FUNCTION lote_material_nao_muda() RETURNS trigger AS $$
BEGIN
  IF NEW.material_id <> OLD.material_id THEN
    RAISE EXCEPTION
      'Lote não troca de material. Se o recebimento foi lançado no material errado, zere por ajuste e lance de novo.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER lote_material_imutavel
  BEFORE UPDATE OF material_id ON lote_material
  FOR EACH ROW EXECUTE FUNCTION lote_material_nao_muda();
