-- ════════════════════════════════════════════════════════════════════════════
-- Fase 10 — travas do documento anexado ao prontuário.
--
-- Radiografia e foto clínica são prontuário: guarda mínima de 20 anos (CFO), e
-- a mesma lógica da evolução se aplica. O que este arquivo garante:
--
--   1. Não existe DELETE. Exclusão é lógica, com motivo e autor.
--   2. O vínculo com o arquivo é imutável: storage_key, sha256, tamanho e mime.
--   3. O paciente não muda. Anexo no paciente errado se resolve removendo e
--      enviando de novo — não movendo, que apagaria o registro do erro.
--   4. Remover é de mão única.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Nada de DELETE físico.
--
--    Um DELETE aqui deixaria o arquivo órfão no bucket e sumiria com a única
--    prova de que aquele exame existiu.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "documento_nao_exclui"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'documento nao pode ser excluido (guarda legal de 20 anos). Use removido_em com motivo.'
    USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "documento_bloqueia_exclusao"
  BEFORE DELETE ON "documento"
  FOR EACH ROW EXECUTE FUNCTION "documento_nao_exclui"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 2, 3 e 4. Campos congelados e remoção de mão única.
--
--    `sha256` imutável é o que dá sentido à conferência de integridade na
--    leitura: se o hash pudesse ser reescrito, trocar o arquivo no bucket e
--    ajustar a coluna passaria despercebido.
--
--    `storage_key` imutável evita o pior tipo de bug silencioso: dois registros
--    apontando para o mesmo objeto, ou um registro apontando para o objeto de
--    outro paciente.
--
--    O que PODE mudar: nome, descrição, tipo, etapa, dente, data do exame,
--    profissional e o vínculo com a evolução — metadado que a clínica corrige.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "documento_campos_congelados"() RETURNS trigger AS $$
BEGIN
  IF NEW."storage_key" IS DISTINCT FROM OLD."storage_key" THEN
    RAISE EXCEPTION
      'storage_key e imutavel (documento %). O arquivo gravado nao muda de lugar.', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."sha256" IS DISTINCT FROM OLD."sha256"
     OR NEW."tamanho_bytes" IS DISTINCT FROM OLD."tamanho_bytes"
     OR NEW."mime_type" IS DISTINCT FROM OLD."mime_type" THEN
    RAISE EXCEPTION
      'sha256, tamanho e mime_type sao imutaveis (documento %) — sao a identidade do arquivo.',
      OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."paciente_id" IS DISTINCT FROM OLD."paciente_id" THEN
    RAISE EXCEPTION
      'documento nao troca de paciente (documento %). Remova com motivo e envie de novo no paciente certo.',
      OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."removido_em" IS NOT NULL AND NEW."removido_em" IS NULL THEN
    RAISE EXCEPTION
      'remocao de documento nao se desfaz (documento %). Esconder e reexibir sem rastro e o que a guarda legal impede.',
      OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."removido_em" IS NOT NULL AND NEW."removido_em" IS DISTINCT FROM OLD."removido_em" THEN
    RAISE EXCEPTION
      'a data de remocao do documento % nao pode ser reescrita.', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "documento_congela_campos"
  BEFORE UPDATE ON "documento"
  FOR EACH ROW EXECUTE FUNCTION "documento_campos_congelados"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Remoção exige autor, não só motivo.
--
--    O CHECK da tabela já exige motivo. Quem removeu é igualmente necessário
--    para a pergunta que a auditoria faz de verdade: "quem decidiu tirar isto
--    do prontuário?".
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "documento_remocao_tem_autor"() RETURNS trigger AS $$
BEGIN
  IF NEW."removido_em" IS NOT NULL AND NEW."removido_por_id" IS NULL THEN
    RAISE EXCEPTION
      'remocao de documento exige removido_por_id — motivo sem autor nao responde quem decidiu.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "documento_valida_remocao"
  BEFORE INSERT OR UPDATE ON "documento"
  FOR EACH ROW EXECUTE FUNCTION "documento_remocao_tem_autor"();
