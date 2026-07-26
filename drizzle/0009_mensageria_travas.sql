-- ════════════════════════════════════════════════════════════════════════════
-- Fase 9 — travas da mensageria.
--
-- A promessa "nunca manda duas vezes" não pode depender de o código lembrar.
-- Uma mensagem enviada é um efeito irreversível no mundo: o paciente leu. Então
-- as regras ficam aqui, onde nenhum caminho de código escapa:
--
--   1. `enviado_em` é imutável depois de preenchido.
--   2. A situação só anda para frente, pelo caminho previsto.
--   3. Destino e corpo congelam no enfileiramento.
--   4. Sem consentimento LGPD ativo, não entra na fila.
--   5. Nada se apaga — nem o que enviamos, nem o que o paciente respondeu.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Campos congelados e `enviado_em` de mão única.
--
--    O caso que isto impede: um retry que reusa a linha, chama a Meta de novo e
--    sobrescreve `enviado_em`. O relatório continuaria dizendo "1 mensagem" e o
--    paciente teria recebido duas.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "mensagem_whatsapp_campos_congelados"() RETURNS trigger AS $$
BEGIN
  IF OLD."enviado_em" IS NOT NULL AND NEW."enviado_em" IS DISTINCT FROM OLD."enviado_em" THEN
    RAISE EXCEPTION
      'enviado_em nao pode ser alterado depois do envio (mensagem %). Uma mensagem enviada nao se reenvia na mesma linha.',
      OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."chave_idempotencia" IS DISTINCT FROM OLD."chave_idempotencia" THEN
    RAISE EXCEPTION 'chave_idempotencia e imutavel (mensagem %).', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."paciente_id" IS DISTINCT FROM OLD."paciente_id"
     OR NEW."tipo" IS DISTINCT FROM OLD."tipo" THEN
    RAISE EXCEPTION 'paciente e tipo da mensagem sao imutaveis (mensagem %).', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Destino e corpo congelam quando a linha sai de 'pendente': daí em diante
  -- alterar seria mentir sobre o que foi dito e para quem.
  IF OLD."situacao" <> 'pendente' THEN
    IF NEW."destino" IS DISTINCT FROM OLD."destino" THEN
      RAISE EXCEPTION 'destino nao muda depois de a mensagem sair da fila (mensagem %).', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."corpo" IS DISTINCT FROM OLD."corpo" THEN
      RAISE EXCEPTION 'corpo nao muda depois de a mensagem sair da fila (mensagem %).', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "mensagem_whatsapp_congela_campos"
  BEFORE UPDATE ON "mensagem_whatsapp"
  FOR EACH ROW EXECUTE FUNCTION "mensagem_whatsapp_campos_congelados"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Máquina de estados.
--
--    `enviando` é a reivindicação de um worker e NÃO volta para `pendente`.
--    Se o processo morreu entre a chamada HTTP e o UPDATE, ninguém sabe se a
--    Meta entregou. Devolver para a fila arrisca duplicar; então a linha fica
--    travada em `enviando`, aparece na tela como travada, e um humano decide.
--    Perder um lembrete é barato; mandar dois é perder a confiança do paciente.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "mensagem_whatsapp_transicao_valida"() RETURNS trigger AS $$
BEGIN
  IF NEW."situacao" = OLD."situacao" THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD."situacao" = 'pendente'  AND NEW."situacao" IN ('enviando', 'cancelada', 'falhou')) OR
    (OLD."situacao" = 'enviando'  AND NEW."situacao" IN ('enviada', 'falhou')) OR
    -- 'enviada' -> 'falhou' existe porque a Meta responde 200 com wamid e só
    -- depois avisa por webhook que o número não recebe. A chamada deu certo; a
    -- entrega, não. A linha guarda enviado_em e falhou_em.
    (OLD."situacao" = 'enviada'   AND NEW."situacao" IN ('entregue', 'lida', 'falhou')) OR
    (OLD."situacao" = 'entregue'  AND NEW."situacao" IN ('lida', 'falhou'))
  ) THEN
    RAISE EXCEPTION
      'transicao de situacao invalida: % -> % (mensagem %).',
      OLD."situacao", NEW."situacao", OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "mensagem_whatsapp_valida_transicao"
  BEFORE UPDATE ON "mensagem_whatsapp"
  FOR EACH ROW EXECUTE FUNCTION "mensagem_whatsapp_transicao_valida"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Consentimento LGPD para contato por WhatsApp.
--
--    Mandar mensagem para paciente que não consentiu é tratamento de dado sem
--    base legal — e o WhatsApp é canal de terceiro, então o dado sai da clínica.
--    A checagem fica no banco porque existe mais de um caminho para enfileirar
--    (ação da recepção, job de lembrete, importação futura) e todos precisam
--    obedecer.
--
--    A finalidade é a string 'contato_whatsapp'. Ela também está em
--    lib/mensageria/consentimento.ts — as duas precisam continuar iguais, e é o
--    caso 59 de docker/verificar-invariantes.sql que garante isso.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "mensagem_whatsapp_exige_consentimento"() RETURNS trigger AS $$
DECLARE
  v_nome text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "consentimento" c
     WHERE c."paciente_id" = NEW."paciente_id"
       AND c."finalidade" = 'contato_whatsapp'
       AND c."revogado_em" IS NULL
  ) THEN
    SELECT "nome" INTO v_nome FROM "paciente" WHERE "id" = NEW."paciente_id";
    RAISE EXCEPTION
      'paciente % nao tem consentimento ativo para contato por WhatsApp (LGPD).',
      coalesce(v_nome, NEW."paciente_id"::text)
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "mensagem_whatsapp_valida_consentimento"
  BEFORE INSERT ON "mensagem_whatsapp"
  FOR EACH ROW EXECUTE FUNCTION "mensagem_whatsapp_exige_consentimento"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Nada se apaga.
--
--    "Vocês nunca me avisaram" e "vocês me mandaram o horário errado" só têm
--    resposta se a mensagem continuar lá. Idem para a resposta do paciente, que
--    é a justificativa de um cancelamento na agenda.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "mensagem_whatsapp_nao_exclui"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'mensagem de WhatsApp nao pode ser excluida — e o registro do que foi dito ao paciente. Use situacao = cancelada.'
    USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "mensagem_whatsapp_bloqueia_exclusao"
  BEFORE DELETE ON "mensagem_whatsapp"
  FOR EACH ROW EXECUTE FUNCTION "mensagem_whatsapp_nao_exclui"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Resposta do paciente é append-only no que ela afirma.
--
--    O texto recebido, quem mandou, quando chegou e como foi interpretado são
--    fato registrado. O que a recepção pode preencher depois é só o
--    encaminhamento: processado_em, acao_tomada, tratado_em e os vínculos que a
--    máquina não soube resolver na hora (paciente, mensagem, agendamento).
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "resposta_whatsapp_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'resposta de WhatsApp nao pode ser excluida — e a prova do que o paciente pediu.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."id_externo"     IS DISTINCT FROM OLD."id_externo"
     OR NEW."remetente"    IS DISTINCT FROM OLD."remetente"
     OR NEW."texto"        IS DISTINCT FROM OLD."texto"
     OR NEW."interpretacao" IS DISTINCT FROM OLD."interpretacao"
     OR NEW."recebido_em"  IS DISTINCT FROM OLD."recebido_em" THEN
    RAISE EXCEPTION
      'resposta de WhatsApp e imutavel no conteudo recebido (resposta %). Só o encaminhamento pode ser preenchido.',
      OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "resposta_whatsapp_bloqueia_update"
  BEFORE UPDATE ON "resposta_whatsapp"
  FOR EACH ROW EXECUTE FUNCTION "resposta_whatsapp_append_only"();
--> statement-breakpoint

CREATE TRIGGER "resposta_whatsapp_bloqueia_delete"
  BEFORE DELETE ON "resposta_whatsapp"
  FOR EACH ROW EXECUTE FUNCTION "resposta_whatsapp_append_only"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 6. `atualizado_em` mantido pelo banco, como nas outras tabelas.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TRIGGER "mensagem_whatsapp_toca_atualizado_em"
  BEFORE UPDATE ON "mensagem_whatsapp"
  FOR EACH ROW EXECUTE FUNCTION "toca_atualizado_em"();
