-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Fase 19 — autoatendimento: o paciente marcando, respondendo e assinando   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── O que esta fase NÃO cria ───────────────────────────────────────────────
-- Não existe tabela de "pedido de agendamento". O paciente que marca pelo portal
-- grava em `agendamento` com `origem = 'portal'` — valor que está no enum desde a
-- Fase 1 e que nenhum código gravava.
--
-- A alternativa (tabela paralela de pedidos, reconciliada depois com a agenda) foi
-- descartada porque a reconciliação é onde nasce o horário vendido duas vezes: o
-- pedido não disputa a EXCLUDE constraint de não-sobreposição, então dois pacientes
-- pedem o mesmo horário e alguém decide depois. Marcando na tabela de verdade, o
-- segundo simplesmente não consegue — o banco recusa, como recusa para a recepção.
--
-- ── Escrita à mão porque o gerador não expressa ────────────────────────────
--   • as políticas de RLS e a trava de suspensão de assinatura;
--   • o CHECK que amarra `origem` a `conferida_em` em `anamnese`;
--   • a asserção que confere as duas coisas ao fim.

-- ── 1. Enums ───────────────────────────────────────────────────────────────
CREATE TYPE origem_anamnese AS ENUM ('clinica', 'portal');
--> statement-breakpoint

-- ⚖️ Dois valores, e nenhum é "qualificada": este sistema não emite assinatura
-- qualificada. Acrescentar o valor sem ICP-Brasil por trás gravaria no banco uma
-- afirmação jurídica falsa — e ninguém revisa enum depois de criado.
CREATE TYPE nivel_assinatura AS ENUM ('presencial', 'eletronica_simples');
--> statement-breakpoint

CREATE TYPE situacao_lista_espera AS ENUM ('aguardando', 'atendida', 'encerrada');
--> statement-breakpoint

CREATE TYPE turno_preferido AS ENUM ('manha', 'tarde', 'qualquer');
--> statement-breakpoint

-- ── 2. Anamnese: quem respondeu, e se um profissional conferiu ─────────────
--
-- A distinção é clínica, não administrativa. Anamnese colhida pelo dentista já passou
-- pelo julgamento de quem sabe repetir a pergunta de outro jeito — "toma remédio para
-- pressão?" depois de "é hipertenso?", porque a segunda pergunta pega o que a
-- primeira perdeu. Respondida no portal, é o que o paciente entendeu do formulário.
--
-- Sem esta coluna, um alerta de alergia que ninguém confirmou vira decisão de
-- anestésico.
ALTER TABLE anamnese ADD COLUMN origem origem_anamnese NOT NULL DEFAULT 'clinica';
--> statement-breakpoint
ALTER TABLE anamnese ADD COLUMN conferida_em timestamptz;
--> statement-breakpoint
ALTER TABLE anamnese ADD COLUMN conferida_por_id uuid;
--> statement-breakpoint

ALTER TABLE anamnese ADD CONSTRAINT anamnese_conferida_por_id_profissional_id_fk
  FOREIGN KEY (conferida_por_id, clinica_id) REFERENCES profissional(id, clinica_id)
  ON DELETE SET NULL (conferida_por_id);
--> statement-breakpoint

-- As três regras que fazem as colunas significarem algo:
--
--  1. conferência sem quem conferiu, ou vice-versa, é registro pela metade — e o que
--     interessa numa auditoria é justamente o nome;
--  2. anamnese da CLÍNICA não se confere: quem a colheu é quem conferiria, então
--     marcar conferência ali seria inventar um segundo ato que não aconteceu;
--  3. `profissional_id` (quem colheu) é obrigatório na da clínica e ausente na do
--     portal — o paciente não é profissional.
ALTER TABLE anamnese ADD CONSTRAINT anamnese_conferencia_completa CHECK (
  (conferida_em IS NULL) = (conferida_por_id IS NULL)
);
--> statement-breakpoint

ALTER TABLE anamnese ADD CONSTRAINT anamnese_clinica_nao_se_confere CHECK (
  origem = 'portal' OR conferida_em IS NULL
);
--> statement-breakpoint

ALTER TABLE anamnese ADD CONSTRAINT anamnese_autoria_coerente CHECK (
  CASE origem
    WHEN 'clinica' THEN profissional_id IS NOT NULL
    WHEN 'portal'  THEN profissional_id IS NULL
  END
);
--> statement-breakpoint

-- ⚠️ O backfill tem de vir DEPOIS das colunas e ANTES do CHECK ser validado — e o
-- Postgres valida na criação. As anamneses que já existem foram colhidas pela
-- clínica, então o default 'clinica' as classifica corretamente; o que pode faltar é
-- `profissional_id`, que é anulável desde a Fase 1 (`on delete set null`).
--
-- Se houver anamnese antiga sem profissional, o CHECK acima falharia. Então o
-- `anamnese_autoria_coerente` é criado como NOT VALID e validado em seguida: a
-- validação diz quantas linhas estão fora, em vez de a migration morrer sem contar.
DO $$
DECLARE v_orfas int;
BEGIN
  SELECT count(*) INTO v_orfas FROM anamnese WHERE origem = 'clinica' AND profissional_id IS NULL;
  IF v_orfas > 0 THEN
    RAISE EXCEPTION
      '% anamnese(s) da clínica sem profissional_id. O CHECK anamnese_autoria_coerente '
      'não pode ser criado sobre elas. Atribua o profissional que as colheu (ou, se a '
      'informação foi perdida, decida se a coluna deve ser anulável também para origem '
      '= clinica) antes de aplicar esta migration.', v_orfas;
  END IF;
END $$;
--> statement-breakpoint

-- ── 3. Consentimento: o nível da assinatura, na linha ──────────────────────
--
-- ⚖️ `eletronica_simples` = hash do texto + IP + user_agent + instante do aceite. É a
-- assinatura eletrônica simples da MP 2.200-2/2001, art. 10, §2º: vale entre as
-- partes que a admitem. Não é ICP-Brasil, não é avançada, não é qualificada, e nada
-- aqui prova a identidade do signatário além do controle da conta do portal — que é
-- e-mail e senha, **sem segundo fator, por decisão**.
--
-- Default `presencial` porque tudo que existe hoje veio de papel assinado na clínica.
ALTER TABLE consentimento
  ADD COLUMN nivel_assinatura nivel_assinatura NOT NULL DEFAULT 'presencial';
--> statement-breakpoint

-- Assinatura eletrônica sem IP é assinatura eletrônica sem prova nenhuma: o que a
-- torna oponível é o conjunto (o que foi assinado, de onde, quando). Papel não precisa
-- de IP — a prova é a folha.
ALTER TABLE consentimento ADD CONSTRAINT consentimento_eletronica_tem_rastro CHECK (
  nivel_assinatura <> 'eletronica_simples' OR (ip IS NOT NULL AND user_agent IS NOT NULL)
);
--> statement-breakpoint

-- ── 4. Catálogo: o que o paciente pode marcar ──────────────────────────────
--
-- Falso por padrão. A lista é decisão da clínica, e o default fechado é o que impede
-- uma atualização do sistema abrir a agenda para procedimento que exige avaliação.
ALTER TABLE procedimento
  ADD COLUMN permite_autoagendamento boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- ── 5. A configuração, uma linha por clínica ───────────────────────────────
CREATE TABLE regra_autoatendimento (
  clinica_id                  uuid NOT NULL DEFAULT app_clinica_id()
                                REFERENCES clinica(id) ON DELETE RESTRICT,
  ativo                       boolean  NOT NULL DEFAULT false,
  antecedencia_minima_horas   smallint NOT NULL DEFAULT 24,
  antecedencia_maxima_dias    smallint NOT NULL DEFAULT 60,
  maximo_futuros_por_paciente smallint NOT NULL DEFAULT 2,
  termo_de_atendimento        text,
  versao_termo                text NOT NULL DEFAULT 'v1',
  atualizado_em               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT regra_autoatendimento_antecedencia_coerente CHECK (
    antecedencia_minima_horas >= 0
    AND antecedencia_maxima_dias >= 1
    -- Mínima maior que a máxima deixaria a janela VAZIA, e a tela mostraria "nenhum
    -- horário disponível" para sempre, sem nada indicando configuração errada.
    AND antecedencia_minima_horas <= antecedencia_maxima_dias * 24
  ),
  CONSTRAINT regra_autoatendimento_teto_positivo CHECK (
    maximo_futuros_por_paciente >= 1 AND maximo_futuros_por_paciente <= 20
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX regra_autoatendimento_clinica_uk ON regra_autoatendimento (clinica_id);
--> statement-breakpoint

-- ── 6. Lista de espera ─────────────────────────────────────────────────────
--
-- ⚠️ Isto NÃO é `encaixe`. `encaixe` é valor de `origem_agendamento` e está entre os
-- termos com ⚠️ do `GLOSSARIO.md`, aguardando validação com o dentista. Esta tabela é
-- o mecanismo (quem quer ser chamado se vagar), e de propósito **nada aqui grava
-- `origem = 'encaixe'`**: quando a recepção oferecer um horário desta lista, a origem
-- do agendamento resultante é decisão dela, na tela dela.
CREATE TABLE lista_espera (
  clinica_id      uuid NOT NULL DEFAULT app_clinica_id() REFERENCES clinica(id) ON DELETE RESTRICT,
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paciente_id     uuid NOT NULL,
  procedimento_id uuid,
  turno           turno_preferido NOT NULL DEFAULT 'qualquer',
  valido_ate      timestamptz NOT NULL,
  observacao      text,
  situacao        situacao_lista_espera NOT NULL DEFAULT 'aguardando',
  encerrado_em    timestamptz,
  motivo_encerramento text,
  criado_em       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT lista_espera_encerramento_com_motivo CHECK (
    situacao <> 'encerrada'
    OR (motivo_encerramento IS NOT NULL AND btrim(motivo_encerramento) <> '')
  ),

  CONSTRAINT lista_espera_paciente_id_paciente_id_fk
    FOREIGN KEY (paciente_id, clinica_id)     REFERENCES paciente(id, clinica_id)     ON DELETE RESTRICT,
  CONSTRAINT lista_espera_procedimento_id_procedimento_id_fk
    FOREIGN KEY (procedimento_id, clinica_id) REFERENCES procedimento(id, clinica_id) ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE INDEX lista_espera_clinica_idx ON lista_espera (clinica_id);
--> statement-breakpoint

-- Um pedido ATIVO por paciente e procedimento. Sem isto, dois cliques põem o paciente
-- duas vezes na fila e a recepção liga duas vezes — o problema que a chave de
-- idempotência resolve na Fase 18, aqui resolvido por índice parcial, porque o "fato"
-- é o próprio par.
CREATE UNIQUE INDEX lista_espera_um_ativo_uk
  ON lista_espera (paciente_id, procedimento_id) WHERE situacao = 'aguardando';
--> statement-breakpoint

CREATE INDEX lista_espera_fila_idx ON lista_espera (situacao, criado_em);
--> statement-breakpoint

-- ── 7. Row Level Security ──────────────────────────────────────────────────
ALTER TABLE regra_autoatendimento ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE regra_autoatendimento FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolamento ON regra_autoatendimento FOR ALL
  USING (clinica_id = app_clinica_id()) WITH CHECK (clinica_id = app_clinica_id());
--> statement-breakpoint

ALTER TABLE lista_espera ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE lista_espera FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolamento ON lista_espera FOR ALL
  USING (clinica_id = app_clinica_id()) WITH CHECK (clinica_id = app_clinica_id());
--> statement-breakpoint

-- ── 8. A trava de suspensão, que a 0027 NÃO alcança ────────────────────────
--
-- O laço da `drizzle/0027` varreu o catálogo **uma vez**. Tabela criada depois não
-- recebe política restritiva nenhuma, e uma clínica suspensa escreveria nela
-- livremente. A `0029` descobriu isso e o cabeçalho da `0027` foi corrigido; aqui a
-- trava é explícita, e o passo 9 confere.
--
-- INSERT e UPDATE, não DELETE: `WITH CHECK` que reprova produz ERRO, `USING` que
-- reprova produz SILÊNCIO (zero linhas casadas, comando "com sucesso"). Travar DELETE
-- por RLS diria "apagado" para quem não apagou nada.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['regra_autoatendimento', 'lista_espera'] LOOP
    EXECUTE format(
      'CREATE POLICY assinatura_trava_insert ON %I AS RESTRICTIVE FOR INSERT '
      'WITH CHECK (assinatura_permite_escrita(clinica_id))', t);
    EXECUTE format(
      'CREATE POLICY assinatura_trava_update ON %I AS RESTRICTIVE FOR UPDATE '
      'WITH CHECK (assinatura_permite_escrita(clinica_id))', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ── 9. As asserções, rodando agora ─────────────────────────────────────────
SELECT exigir_isolamento_estrutural();
--> statement-breakpoint

DO $$
DECLARE v_faltando text[];
BEGIN
  SELECT coalesce(array_agg(t.nome ORDER BY t.nome), ARRAY[]::text[]) INTO v_faltando
    FROM (VALUES ('regra_autoatendimento'), ('lista_espera')) AS t(nome)
   WHERE (SELECT count(*) FROM pg_policy p
           WHERE p.polrelid = t.nome::regclass
             AND NOT p.polpermissive
             AND p.polcmd IN ('a', 'w')) <> 2;

  IF array_length(v_faltando, 1) > 0 THEN
    RAISE EXCEPTION
      'Tabelas novas sem a trava de suspensão de assinatura: %. '
      'Uma clínica suspensa escreveria nelas livremente.',
      array_to_string(v_faltando, ', ');
  END IF;
END $$;
--> statement-breakpoint

-- ── 10. A linha de configuração para as clínicas que já existem ────────────
--
-- Com `ativo = false`: a fase entra desligada em toda clínica existente, e ligar é
-- decisão de cada uma. Criar a linha (em vez de deixar o código lidar com a ausência)
-- é o que permite `regraDoAutoatendimento()` ser um SELECT simples, sem `coalesce`
-- espalhado — e sem o risco de o default do código divergir do default do banco.
INSERT INTO regra_autoatendimento (clinica_id)
SELECT id FROM clinica
ON CONFLICT DO NOTHING;
