-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Fase 18 — filas de relacionamento ativo                                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Três tabelas e uma coluna. O assunto é a **idempotência**, e o que ela protege
-- não é o banco — é o paciente que pediu para não ser incomodado.
--
-- ── A decisão que manda nesta migration ─────────────────────────────────────
-- `tarefa_relacionamento.chave_idempotencia` é única e existe **uma por FATO**
-- gerador: este orçamento, esta falta, esta execução. Os geradores rodam no laço do
-- despachante a cada dez minutos, para sempre, com `ON CONFLICT DO NOTHING`.
--
-- O ponto sutil: a chave **ignora a situação da tarefa**. Um gerador escrito como
-- "existe tarefa ABERTA para este orçamento? se não, cria" passaria em qualquer
-- teste de idempotência que rodasse duas vezes seguidas — e falharia no cenário que
-- importa. A recepção dispensa ("paciente pediu para não ligar"), o job roda de
-- novo, a tarefa volta, alguém liga outra vez. O paciente não vê um bug; vê uma
-- clínica que não escuta.
--
-- Por isso as FKs das referências são todas `RESTRICT`, inclusive as opcionais:
-- `SET NULL` ou `CASCADE` apagariam a tarefa dispensada, a chave deixaria de
-- colidir, e o gerador a recriaria. **O `RESTRICT` é load-bearing.**
--
-- ── Escrita à mão porque o gerador não expressa três coisas ────────────────
-- Políticas de RLS, a trava de assinatura e a asserção estrutural. O
-- `drizzle-kit generate` roda depois só para o snapshot (ver `CLAUDE.md`).

-- ── 1. Enums ───────────────────────────────────────────────────────────────
CREATE TYPE tipo_tarefa_relacionamento AS ENUM (
  'orcamento_sem_resposta',
  'inadimplencia',
  'aprovado_nao_executado',
  'falta_sem_remarcar',
  'retorno_programado'
);
--> statement-breakpoint

CREATE TYPE situacao_tarefa AS ENUM ('aberta', 'em_andamento', 'resolvida', 'dispensada');
--> statement-breakpoint

CREATE TYPE canal_contato AS ENUM ('telefone', 'whatsapp', 'email', 'presencial');
--> statement-breakpoint

CREATE TYPE resultado_contato AS ENUM (
  'falou', 'nao_atendeu', 'numero_errado', 'remarcou', 'nao_quer'
);
--> statement-breakpoint

CREATE TYPE tipo_retorno AS ENUM (
  'exame', 'profilaxia', 'periodontal', 'ortodontia', 'controle'
);
--> statement-breakpoint

-- ── 2. O opt-out do paciente ───────────────────────────────────────────────
--
-- Um dia civil, **inclusivo**: "não me liguem até dia 30" significa que dia 30
-- ainda não. A comparação exclusiva produziria uma ligação no único dia em que a
-- pessoa lembra do pedido (`podeContatar` em `lib/domain/relacionamento.ts`).
--
-- Data e não booleano: "não quero por enquanto" é o pedido comum, e um booleano
-- transformaria todos eles em "nunca mais". Quem quer nunca mais recebe uma data
-- distante, e isso fica visível na tela em vez de virar um estado sem volta.
ALTER TABLE paciente ADD COLUMN nao_contatar_ate date;
--> statement-breakpoint

ALTER TABLE paciente ADD COLUMN nao_contatar_motivo text;
--> statement-breakpoint

COMMENT ON COLUMN paciente.nao_contatar_ate IS
  'Opt-out das filas de relacionamento, até este dia INCLUSIVE. NULL = pode contatar.';
--> statement-breakpoint

-- ── 3. Regra de retorno: o motor do recall ─────────────────────────────────
CREATE TABLE regra_retorno (
  clinica_id      uuid NOT NULL DEFAULT app_clinica_id() REFERENCES clinica(id) ON DELETE RESTRICT,
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  procedimento_id uuid NOT NULL,
  meses           smallint NOT NULL,
  tipo            tipo_retorno NOT NULL,
  ativo           boolean NOT NULL DEFAULT true,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  atualizado_em   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT regra_retorno_meses_positivo CHECK (meses BETWEEN 1 AND 120),
  CONSTRAINT regra_retorno_procedimento_id_procedimento_id_fk
    FOREIGN KEY (procedimento_id, clinica_id)
    REFERENCES procedimento(id, clinica_id) ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE INDEX regra_retorno_clinica_idx ON regra_retorno (clinica_id);
--> statement-breakpoint

-- Uma regra por procedimento: duas tornariam indefinido em quantos meses chamar, e
-- o gerador escolheria "alguma" — o modo de falha que a Fase 17 passou inteira
-- eliminando.
CREATE UNIQUE INDEX regra_retorno_procedimento_uk ON regra_retorno (clinica_id, procedimento_id);
--> statement-breakpoint

-- ── 4. A tarefa ────────────────────────────────────────────────────────────
CREATE TABLE tarefa_relacionamento (
  clinica_id      uuid NOT NULL DEFAULT app_clinica_id() REFERENCES clinica(id) ON DELETE RESTRICT,
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo            tipo_tarefa_relacionamento NOT NULL,
  paciente_id     uuid NOT NULL,
  chave_idempotencia text NOT NULL,
  orcamento_id    uuid,
  agendamento_id  uuid,
  item_plano_id   uuid,
  parcela_id      uuid,
  execucao_id     uuid,
  prazo           date NOT NULL,
  situacao        situacao_tarefa NOT NULL DEFAULT 'aberta',
  responsavel_id  uuid,
  motivo_dispensa text,
  resolvido_em    timestamptz,
  dispensado_em   timestamptz,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  atualizado_em   timestamptz NOT NULL DEFAULT now(),

  -- `tipo` e referência têm de combinar. Sem isto, um gerador novo que esquecesse a
  -- referência produziria uma linha "falar com o paciente" sem nada em que clicar —
  -- e a recepção teria de adivinhar o assunto.
  CONSTRAINT tarefa_relacionamento_referencia_coerente CHECK (
    CASE tipo
      WHEN 'orcamento_sem_resposta' THEN orcamento_id   IS NOT NULL
      WHEN 'inadimplencia'          THEN parcela_id     IS NOT NULL
      WHEN 'aprovado_nao_executado' THEN item_plano_id  IS NOT NULL
      WHEN 'falta_sem_remarcar'     THEN agendamento_id IS NOT NULL
      WHEN 'retorno_programado'     THEN execucao_id    IS NOT NULL
    END
  ),
  CONSTRAINT tarefa_relacionamento_dispensa_com_motivo CHECK (
    situacao <> 'dispensada' OR (motivo_dispensa IS NOT NULL AND btrim(motivo_dispensa) <> '')
  ),

  CONSTRAINT tarefa_relacionamento_paciente_id_paciente_id_fk
    FOREIGN KEY (paciente_id, clinica_id)   REFERENCES paciente(id, clinica_id)    ON DELETE RESTRICT,
  CONSTRAINT tarefa_relacionamento_orcamento_id_orcamento_id_fk
    FOREIGN KEY (orcamento_id, clinica_id)  REFERENCES orcamento(id, clinica_id)   ON DELETE RESTRICT,
  CONSTRAINT tarefa_relacionamento_agendamento_id_agendamento_id_fk
    FOREIGN KEY (agendamento_id, clinica_id) REFERENCES agendamento(id, clinica_id) ON DELETE RESTRICT,
  CONSTRAINT tarefa_relacionamento_item_plano_id_item_plano_id_fk
    FOREIGN KEY (item_plano_id, clinica_id) REFERENCES item_plano(id, clinica_id)  ON DELETE RESTRICT,
  CONSTRAINT tarefa_relacionamento_parcela_id_parcela_id_fk
    FOREIGN KEY (parcela_id, clinica_id)    REFERENCES parcela(id, clinica_id)     ON DELETE RESTRICT,
  CONSTRAINT tarefa_relacionamento_execucao_id_execucao_id_fk
    FOREIGN KEY (execucao_id, clinica_id)   REFERENCES execucao(id, clinica_id)    ON DELETE RESTRICT,
  CONSTRAINT tarefa_relacionamento_responsavel_id_usuario_id_fk
    FOREIGN KEY (responsavel_id, clinica_id) REFERENCES usuario(id, clinica_id)    ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE INDEX tarefa_relacionamento_clinica_idx ON tarefa_relacionamento (clinica_id);
--> statement-breakpoint

-- Única no MUNDO, não por clínica. A chave carrega o uuid da referência, então não
-- colide entre clínicas por construção — e global é a versão mais forte: nenhuma
-- duplicata escapa nem por engano de contexto. Mesmo raciocínio de
-- `mensagem_whatsapp_chave_idempotencia_unique`.
CREATE UNIQUE INDEX tarefa_relacionamento_chave_idempotencia_unique
  ON tarefa_relacionamento (chave_idempotencia);
--> statement-breakpoint

CREATE INDEX tarefa_relacionamento_fila_idx ON tarefa_relacionamento (situacao, prazo);
--> statement-breakpoint
CREATE INDEX tarefa_relacionamento_paciente_idx ON tarefa_relacionamento (paciente_id, situacao);
--> statement-breakpoint

-- Necessário para o FK composto de `contato_relacionamento`.
CREATE UNIQUE INDEX tarefa_relacionamento_id_clinica_uk
  ON tarefa_relacionamento (id, clinica_id);
--> statement-breakpoint

-- ── 5. O log de contatos ───────────────────────────────────────────────────
--
-- **Não existe coluna `tentativas` na tarefa, de propósito.** Um contador
-- desnormalizado seria uma segunda verdade, livre para divergir do log — e o
-- projeto acabou de pagar caro por exatamente isso no saldo de estoque, onde 5
-- lotes ficaram com saldo diferente da soma dos movimentos. A contagem sai de
-- `count(*)` daqui.
CREATE TABLE contato_relacionamento (
  clinica_id      uuid NOT NULL DEFAULT app_clinica_id() REFERENCES clinica(id) ON DELETE RESTRICT,
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tarefa_id       uuid NOT NULL,
  canal           canal_contato NOT NULL,
  resultado       resultado_contato NOT NULL,
  observacao      text,
  registrado_por_id uuid,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  -- `CASCADE` aqui, e `RESTRICT` em tudo o mais, não é incoerência: o contato não
  -- tem sentido sem a tarefa, e a tarefa não é apagável (nada no sistema a apaga).
  -- O cascade existe para o caso de manutenção, não para o fluxo.
  CONSTRAINT contato_relacionamento_tarefa_id_tarefa_relacionamento_id_fk
    FOREIGN KEY (tarefa_id, clinica_id)
    REFERENCES tarefa_relacionamento(id, clinica_id) ON DELETE CASCADE,
  CONSTRAINT contato_relacionamento_registrado_por_id_usuario_id_fk
    FOREIGN KEY (registrado_por_id, clinica_id)
    REFERENCES usuario(id, clinica_id) ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE INDEX contato_relacionamento_clinica_idx ON contato_relacionamento (clinica_id);
--> statement-breakpoint
CREATE INDEX contato_relacionamento_tarefa_idx ON contato_relacionamento (tarefa_id, criado_em);
--> statement-breakpoint

-- ── 6. Row Level Security ──────────────────────────────────────────────────
--
-- `USING` **e** `WITH CHECK`. Só `USING` deixaria o `INSERT` gravar na clínica
-- alheia — está no `CLAUDE.md` e é o erro que a `0023` existe para não repetir.
ALTER TABLE regra_retorno ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE regra_retorno FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolamento ON regra_retorno FOR ALL
  USING (clinica_id = app_clinica_id()) WITH CHECK (clinica_id = app_clinica_id());
--> statement-breakpoint

ALTER TABLE tarefa_relacionamento ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tarefa_relacionamento FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolamento ON tarefa_relacionamento FOR ALL
  USING (clinica_id = app_clinica_id()) WITH CHECK (clinica_id = app_clinica_id());
--> statement-breakpoint

ALTER TABLE contato_relacionamento ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE contato_relacionamento FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolamento ON contato_relacionamento FOR ALL
  USING (clinica_id = app_clinica_id()) WITH CHECK (clinica_id = app_clinica_id());
--> statement-breakpoint

-- ── 7. A trava de assinatura, que a 0027 NÃO alcança ───────────────────────
--
-- Isto é um achado, não uma formalidade.
--
-- A `drizzle/0027` diz no cabeçalho: *"Tabela nova nasce TRAVADA (o laço varre o
-- catálogo)"*. **Não nasce.** O laço dela varreu o catálogo **uma vez**, quando
-- rodou; tabela criada depois não recebe política restritiva nenhuma, e uma clínica
-- suspensa escreveria nela livremente.
--
-- Ninguém perceberia: a asserção `exigir_isolamento_estrutural()` (0023) confere
-- `clinica_id`, RLS, FORCE e política de isolamento — **não** confere a trava de
-- suspensão. E `docker/verificar-assinatura.sql` prova uma tabela por caso, mais um
-- caso estrutural que garante que restritiva nenhuma alcança SELECT (o que é o
-- oposto: garante que a leitura NÃO é travada).
--
-- Então: as três tabelas recebem a trava aqui, com o mesmo nome e a mesma forma da
-- 0027 — e `docker/verificar-invariantes.sql` ganhou o caso de catálogo que teria
-- pegado isto, para a próxima tabela não depender de alguém lembrar.
--
-- Por que INSERT e UPDATE e não DELETE: `WITH CHECK` que reprova produz ERRO;
-- `USING` que reprova produz **silêncio** (a linha não é vista, o comando volta
-- "com sucesso" tendo casado zero linhas). Travar DELETE por RLS diria "apagado"
-- para quem não apagou nada. Está escrito por extenso na 0027.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['regra_retorno', 'tarefa_relacionamento', 'contato_relacionamento'] LOOP
    EXECUTE format(
      'CREATE POLICY assinatura_trava_insert ON %I AS RESTRICTIVE FOR INSERT '
      'WITH CHECK (assinatura_permite_escrita(clinica_id))', t);
    EXECUTE format(
      'CREATE POLICY assinatura_trava_update ON %I AS RESTRICTIVE FOR UPDATE '
      'WITH CHECK (assinatura_permite_escrita(clinica_id))', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ── 8. As asserções, rodando agora ─────────────────────────────────────────
SELECT exigir_isolamento_estrutural();
--> statement-breakpoint

-- E a trava de assinatura nas três tabelas novas, conferida aqui mesmo. Criar a
-- política e não conferir seria confiar num `format()` dentro de um laço — que é
-- exatamente onde o erro que ninguém vê mora.
DO $$
DECLARE v_faltando text[];
BEGIN
  SELECT coalesce(array_agg(t.nome ORDER BY t.nome), ARRAY[]::text[]) INTO v_faltando
    FROM (VALUES ('regra_retorno'), ('tarefa_relacionamento'), ('contato_relacionamento')) AS t(nome)
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
