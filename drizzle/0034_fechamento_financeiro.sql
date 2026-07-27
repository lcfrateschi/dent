-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Fase 20 — fechamento financeiro: o dinheiro que SAI                       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── O que estava errado ─────────────────────────────────────────────────────
-- `caixaDoPeriodo` somava **apenas entradas**, e isso não é "incompleto": é uma
-- mentira por omissão do tipo confortável. O número saía maior que a realidade todo
-- mês, e ninguém desconfia de um caixa generoso. Uma clínica que fecha julho com
-- "R$ 62 mil recebidos" sem saber que pagou R$ 48 mil não tem informação — tem
-- sensação.
--
-- ── A decisão que organiza tudo: obrigação ≠ pagamento ─────────────────────
-- `despesa` é a obrigação (o aluguel de julho pertence a julho, pago ou não);
-- `pagamento_despesa` é o movimento de caixa (saiu do banco em 5 de agosto). Duas
-- tabelas, pelo mesmo motivo que `parcela` e `pagamento` são duas do lado da receita:
--
--   • **competência** responde "quanto custou julho?" → soma `despesa.competencia`
--   • **caixa** responde "quanto saiu em agosto?"     → soma `pagamento_despesa.pago_em`
--
-- Um `pago boolean` na despesa responderia a primeira e destruiria a segunda: sem data
-- de saída, sem pagamento parcial, sem saber que a conta de julho foi paga em duas
-- vezes. Confundir os regimes é o erro clássico deste módulo, e o sintoma não é um
-- erro na tela — é um relatório que a contadora recusa.
--
-- ── Escrita à mão, como as anteriores ──────────────────────────────────────
-- `drizzle-kit generate` não sabe expressar EXCLUDE constraint, trigger, política de
-- RLS nem a trava de suspensão. O snapshot vem dele; o SQL é este.

-- ── 1. Enums ───────────────────────────────────────────────────────────────
CREATE TYPE natureza_despesa AS ENUM ('fixa', 'variavel');
--> statement-breakpoint
CREATE TYPE situacao_pix AS ENUM ('pendente', 'pago', 'expirado', 'cancelado');
--> statement-breakpoint

-- ── 2. A escolha da base da comissão: bruto ou líquido ─────────────────────
--
-- **Esta coluna existe porque a pergunta NÃO é técnica.** O paciente paga R$ 100 no
-- crédito e caem R$ 97,51. A comissão é sobre "valor recebido" (decisão fechada da
-- clínica) — sobre 100 ou sobre 97,51?
--
-- A diferença sai do bolso de alguém: é contrato de trabalho, não modelagem. Então o
-- sistema **suporta as duas respostas** e nasce com a que **não muda nada** para quem
-- já está em operação (`false` = bruto, o comportamento de hoje). Trocar é um UPDATE,
-- reversível, e o valor fica visível na folha.
--
-- O default NÃO é "o certo": é "o que não altera a folha de ninguém em silêncio numa
-- migration". Ver o pedido de decisão no relatório da Fase 20.
ALTER TABLE clinica
  ADD COLUMN comissao_sobre_liquido boolean NOT NULL DEFAULT false;
--> statement-breakpoint

COMMENT ON COLUMN clinica.comissao_sobre_liquido IS
  'Base da comissão quando ha taxa de meio de pagamento: false = valor bruto pago pelo '
  'paciente (padrao, preserva a folha atual), true = valor liquido que entrou na conta. '
  'Decisao contratual da clinica, nao tecnica.';
--> statement-breakpoint

-- ── 3. Categoria de despesa ────────────────────────────────────────────────
--
-- Lista rasa, e os valores do seed são **de partida** — como os mínimos de estoque e
-- as fichas técnicas. Não é plano de contas: hierarquia, código contábil e amarração
-- fiscal são decisão de quem faz a contabilidade da clínica, e um esboço nosso viraria
-- quarenta campos que ninguém preenche.
CREATE TABLE categoria_despesa (
  clinica_id uuid NOT NULL DEFAULT app_clinica_id()
    REFERENCES clinica(id) ON DELETE RESTRICT,
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome       text NOT NULL,
  natureza   natureza_despesa NOT NULL DEFAULT 'variavel',
  ativo      boolean NOT NULL DEFAULT true,
  criado_em  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX categoria_despesa_clinica_idx ON categoria_despesa (clinica_id);
--> statement-breakpoint
CREATE UNIQUE INDEX categoria_despesa_nome_uk ON categoria_despesa (clinica_id, nome);
--> statement-breakpoint
-- Necessário para os FKs compostos de `despesa` e `regra_despesa_recorrente`.
CREATE UNIQUE INDEX categoria_despesa_id_clinica_uk ON categoria_despesa (id, clinica_id);
--> statement-breakpoint

-- ── 4. A regra recorrente ──────────────────────────────────────────────────
--
-- **Uma linha por regra, não 240 por aluguel.** Materializar o futuro parece
-- simétrico ao parcelamento de uma cobrança, mas parcelamento tem fim conhecido e
-- valor acordado; aluguel é uma regra que dura enquanto durar o contrato. Materializá-la
-- criaria três problemas: o reajuste anual passaria a exigir editar 240 linhas futuras
-- (ou editar algumas e esquecer), o fim do contrato deixaria lixo vencendo em 2046, e a
-- fila de contas a pagar ficaria cheia do que ninguém deve ainda.
--
-- `dia_vencimento` para em 28 de propósito: 29, 30 e 31 não existem em todo mês, e
-- "dia 31" viraria uma regra que se comporta diferente em fevereiro sem avisar.
CREATE TABLE regra_despesa_recorrente (
  clinica_id     uuid NOT NULL DEFAULT app_clinica_id()
    REFERENCES clinica(id) ON DELETE RESTRICT,
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  categoria_id   uuid NOT NULL,
  descricao      text NOT NULL,
  valor          numeric(10,2) NOT NULL,
  dia_vencimento smallint NOT NULL,
  inicio_em      date NOT NULL,
  fim_em         date,
  ativo          boolean NOT NULL DEFAULT true,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT regra_despesa_categoria_id_categoria_despesa_id_fk
    FOREIGN KEY (categoria_id, clinica_id)
    REFERENCES categoria_despesa (id, clinica_id) ON DELETE RESTRICT,
  CONSTRAINT regra_despesa_valor_positivo CHECK (valor > 0),
  CONSTRAINT regra_despesa_dia_valido CHECK (dia_vencimento >= 1 AND dia_vencimento <= 28),
  CONSTRAINT regra_despesa_periodo_coerente CHECK (fim_em IS NULL OR fim_em >= inicio_em)
);
--> statement-breakpoint

CREATE INDEX regra_despesa_recorrente_clinica_idx ON regra_despesa_recorrente (clinica_id);
--> statement-breakpoint
CREATE UNIQUE INDEX regra_despesa_recorrente_id_clinica_uk
  ON regra_despesa_recorrente (id, clinica_id);
--> statement-breakpoint

-- ── 5. A despesa ───────────────────────────────────────────────────────────
CREATE TABLE despesa (
  clinica_id          uuid NOT NULL DEFAULT app_clinica_id()
    REFERENCES clinica(id) ON DELETE RESTRICT,
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  categoria_id        uuid NOT NULL,
  descricao           text NOT NULL,
  valor               numeric(10,2) NOT NULL,
  competencia         date NOT NULL,
  vencimento          date NOT NULL,
  fornecedor          text,
  documento           text,
  observacao          text,
  recorrente_id       uuid,
  criado_por_id       uuid,
  criado_em           timestamptz NOT NULL DEFAULT now(),
  cancelado_em        timestamptz,
  motivo_cancelamento text,
  CONSTRAINT despesa_categoria_id_categoria_despesa_id_fk
    FOREIGN KEY (categoria_id, clinica_id)
    REFERENCES categoria_despesa (id, clinica_id) ON DELETE RESTRICT,
  CONSTRAINT despesa_recorrente_id_regra_despesa_recorrente_id_fk
    FOREIGN KEY (recorrente_id, clinica_id)
    REFERENCES regra_despesa_recorrente (id, clinica_id) ON DELETE RESTRICT,
  /*
   * FK composto com `ON DELETE SET NULL (criado_por_id)` — a forma com LISTA DE
   * COLUNAS do Postgres 15+.
   *
   * `SET NULL` puro anularia `clinica_id` também, que é `NOT NULL`, e o `DELETE` do
   * usuário passaria a FALHAR com uma mensagem que não menciona tenant nem FK. A lista
   * anula só a coluna do pai e preserva o tenant.
   *
   * O Drizzle **não sabe expressar isso** (`UpdateDeleteAction` só tem `'set null'`),
   * então estas duas entram na lista das ~30 divergências conhecidas entre schema TS e
   * banco, com a mesma defesa: `exigir_isolamento_estrutural()`, que derruba o deploy se
   * alguém reverter. Está escrito no topo de `lib/db/schema/tenant.ts`.
   */
  CONSTRAINT despesa_criado_por_id_usuario_id_fk
    FOREIGN KEY (criado_por_id, clinica_id)
    REFERENCES usuario (id, clinica_id) ON DELETE SET NULL (criado_por_id),
  CONSTRAINT despesa_valor_positivo CHECK (valor > 0),
  CONSTRAINT despesa_cancelamento_justificado
    CHECK (cancelado_em IS NULL OR motivo_cancelamento IS NOT NULL)
);
--> statement-breakpoint

CREATE INDEX despesa_clinica_idx ON despesa (clinica_id);
--> statement-breakpoint
CREATE INDEX despesa_competencia_idx ON despesa (clinica_id, competencia);
--> statement-breakpoint
CREATE INDEX despesa_vencimento_idx ON despesa (clinica_id, vencimento);
--> statement-breakpoint

-- Idempotência da materialização: rodar o gerador duas vezes no mesmo mês não
-- duplica o aluguel.
--
-- Parcial, e aqui o parcial é o uso CORRETO: `recorrente_id IS NULL` são os
-- lançamentos manuais, e dois lançamentos manuais na mesma competência são normais
-- (duas notas de laboratório em julho). Contraste com `lista_espera_um_ativo_uk`, onde
-- o `NULL` era o caso comum e o índice parcial deixava passar o que devia travar —
-- lá a correção foi `coalesce`, aqui o `NULL` é justamente o que não deve colidir.
CREATE UNIQUE INDEX despesa_recorrente_competencia_uk
  ON despesa (recorrente_id, competencia) WHERE recorrente_id IS NOT NULL;
--> statement-breakpoint

-- Necessário para o FK composto de `pagamento_despesa`.
CREATE UNIQUE INDEX despesa_id_clinica_uk ON despesa (id, clinica_id);
--> statement-breakpoint

-- ── 6. O pagamento da despesa ──────────────────────────────────────────────
CREATE TABLE pagamento_despesa (
  clinica_id       uuid NOT NULL DEFAULT app_clinica_id()
    REFERENCES clinica(id) ON DELETE RESTRICT,
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  despesa_id       uuid NOT NULL,
  valor            numeric(10,2) NOT NULL,
  pago_em          date NOT NULL,
  meio             forma_pagamento NOT NULL,
  comprovante      text,
  observacao       text,
  registrado_por_id uuid,
  criado_em        timestamptz NOT NULL DEFAULT now(),
  estornado_em     timestamptz,
  motivo_estorno   text,
  CONSTRAINT pagamento_despesa_despesa_id_despesa_id_fk
    FOREIGN KEY (despesa_id, clinica_id)
    REFERENCES despesa (id, clinica_id) ON DELETE RESTRICT,
  -- Mesma forma da `despesa.criado_por_id`: `SET NULL (coluna)` preserva o tenant.
  CONSTRAINT pagamento_despesa_registrado_por_id_usuario_id_fk
    FOREIGN KEY (registrado_por_id, clinica_id)
    REFERENCES usuario (id, clinica_id) ON DELETE SET NULL (registrado_por_id),
  CONSTRAINT pagamento_despesa_valor_positivo CHECK (valor > 0),
  -- Convênio é origem de RECEITA, não jeito de pagar aluguel. Enum quase-igual só
  -- para remover um valor custaria mais que a checagem.
  CONSTRAINT pagamento_despesa_meio_nao_convenio CHECK (meio <> 'convenio'),
  CONSTRAINT pagamento_despesa_estorno_justificado
    CHECK (estornado_em IS NULL OR motivo_estorno IS NOT NULL)
);
--> statement-breakpoint

CREATE INDEX pagamento_despesa_clinica_idx ON pagamento_despesa (clinica_id);
--> statement-breakpoint
CREATE INDEX pagamento_despesa_despesa_idx ON pagamento_despesa (despesa_id);
--> statement-breakpoint
CREATE INDEX pagamento_despesa_data_idx ON pagamento_despesa (clinica_id, pago_em);
--> statement-breakpoint

-- ── 7. A soma dos pagamentos nunca passa do valor da despesa ───────────────
--
-- Mesmo molde do que já impede pagamento acima do valor da parcela. Sem isto, o fluxo
-- de caixa mostraria saída maior que a obrigação e a conciliação com o extrato
-- passaria a "sobrar" dinheiro que nunca existiu.
--
-- Estornado não conta: o dinheiro voltou.
CREATE OR REPLACE FUNCTION pagamento_despesa_nao_excede() RETURNS trigger AS $$
DECLARE
  v_valor numeric(10,2);
  v_pago  numeric(10,2);
  v_cancelada timestamptz;
BEGIN
  -- `FOR UPDATE` serializa dois pagamentos simultâneos da mesma despesa. Sem o lock,
  -- duas transações leem o mesmo total pago, ambas passam, e a soma estoura — o mesmo
  -- cuidado que a trigger de saldo de estoque toma.
  SELECT valor, cancelado_em INTO v_valor, v_cancelada
    FROM despesa WHERE id = NEW.despesa_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Despesa % nao existe.', NEW.despesa_id;
  END IF;

  IF v_cancelada IS NOT NULL THEN
    RAISE EXCEPTION
      'Despesa % esta cancelada e nao aceita pagamento. Se o dinheiro saiu, a despesa nao devia estar cancelada.',
      NEW.despesa_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT coalesce(sum(valor), 0) INTO v_pago
    FROM pagamento_despesa
   WHERE despesa_id = NEW.despesa_id
     AND estornado_em IS NULL
     AND id <> NEW.id;

  IF v_pago + NEW.valor > v_valor THEN
    RAISE EXCEPTION
      'Pagamentos (% + %) excedem o valor da despesa (%).',
      v_pago, NEW.valor, v_valor
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER pagamento_despesa_soma
  BEFORE INSERT OR UPDATE ON pagamento_despesa
  FOR EACH ROW EXECUTE FUNCTION pagamento_despesa_nao_excede();
--> statement-breakpoint

-- ── 8. A taxa do meio de pagamento, com vigência que não se sobrepõe ───────
CREATE TABLE taxa_meio_pagamento (
  clinica_id      uuid NOT NULL DEFAULT app_clinica_id()
    REFERENCES clinica(id) ON DELETE RESTRICT,
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meio            forma_pagamento NOT NULL,
  percentual      numeric(5,2) NOT NULL DEFAULT 0,
  valor_fixo      numeric(10,2) NOT NULL DEFAULT 0,
  observacao      text,
  vigencia_inicio date NOT NULL,
  vigencia_fim    date,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT taxa_meio_percentual_faixa CHECK (percentual >= 0 AND percentual <= 100),
  CONSTRAINT taxa_meio_fixo_nao_negativo CHECK (valor_fixo >= 0),
  CONSTRAINT taxa_meio_vigencia_coerente
    CHECK (vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio),
  -- Dinheiro em espécie não tem MDR. Uma linha dizendo que tem aparece como caixa
  -- menor sem explicação.
  CONSTRAINT taxa_meio_dinheiro_sem_taxa CHECK (meio <> 'dinheiro')
);
--> statement-breakpoint

CREATE INDEX taxa_meio_pagamento_clinica_idx ON taxa_meio_pagamento (clinica_id);
--> statement-breakpoint
CREATE INDEX taxa_meio_idx ON taxa_meio_pagamento (clinica_id, meio, vigencia_inicio);
--> statement-breakpoint

-- Uma taxa por dia, por meio, por clínica.
--
-- É a mesma constraint de `preco_convenio_sem_sobreposicao`, e pelo mesmo motivo: com
-- duas linhas válidas no mesmo dia, o valor líquido de um pagamento passa a depender da
-- ordem da consulta. Aqui o efeito chega na folha, porque a base da comissão pode ser o
-- líquido.
--
-- `[inicio, fim+1)` porque a vigência inclui o dia do fim; fim nulo é aberta.
ALTER TABLE taxa_meio_pagamento
  ADD CONSTRAINT taxa_meio_sem_sobreposicao
  EXCLUDE USING gist (
    clinica_id WITH =,
    -- `meio` direto, sem `::text`: o cast de enum para texto é STABLE (rótulo de enum
    -- pode ser renomeado), e índice exige IMMUTABLE. `btree_gist` — já presente por
    -- causa das outras EXCLUDE constraints — dá classe de operador para enum.
    meio WITH =,
    daterange(
      vigencia_inicio,
      CASE WHEN vigencia_fim IS NULL THEN NULL ELSE vigencia_fim + 1 END,
      '[)'
    ) WITH &&
  );
--> statement-breakpoint

-- ── 9. Cobrança Pix e o log de eventos ─────────────────────────────────────
--
-- `intencao_pix.pagamento_id` é FK composto para `pagamento`, e FK composto exige
-- unicidade em EXATAMENTE `(id, clinica_id)` no pai. `pagamento` não tinha esse índice:
-- a `0023` criou-o só para os 25 pais que precisavam na época, e `pagamento` não era
-- pai de ninguém. Redundante com a PK? Sim — e é o que o Postgres cobra para aceitar o
-- FK, então redundância declarada é melhor que FK de uma coluna só.
CREATE UNIQUE INDEX pagamento_id_clinica_uk ON pagamento (id, clinica_id);
--> statement-breakpoint

CREATE TABLE intencao_pix (
  clinica_id    uuid NOT NULL DEFAULT app_clinica_id()
    REFERENCES clinica(id) ON DELETE RESTRICT,
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parcela_id    uuid NOT NULL,
  txid          text NOT NULL,
  valor         numeric(10,2) NOT NULL,
  situacao      situacao_pix NOT NULL DEFAULT 'pendente',
  copia_e_cola  text,
  expira_em     timestamptz NOT NULL,
  end_to_end_id text,
  pagamento_id  uuid,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  liquidado_em  timestamptz,
  CONSTRAINT intencao_pix_parcela_id_parcela_id_fk
    FOREIGN KEY (parcela_id, clinica_id)
    REFERENCES parcela (id, clinica_id) ON DELETE RESTRICT,
  CONSTRAINT intencao_pix_pagamento_id_pagamento_id_fk
    FOREIGN KEY (pagamento_id, clinica_id)
    REFERENCES pagamento (id, clinica_id) ON DELETE RESTRICT,
  CONSTRAINT intencao_pix_valor_positivo CHECK (valor > 0),
  -- Estado e evidência andam juntos. `pago` sem `end_to_end_id` é liquidação sem
  -- prova; `end_to_end_id` sem `pagamento_id` é dinheiro que caiu e não entrou no
  -- caixa. Os dois são conciliação que não fecha, e o CHECK os torna impossíveis.
  CONSTRAINT intencao_pix_liquidacao_coerente
    CHECK ((situacao = 'pago') = (end_to_end_id IS NOT NULL
           AND pagamento_id IS NOT NULL AND liquidado_em IS NOT NULL))
);
--> statement-breakpoint

CREATE INDEX intencao_pix_clinica_idx ON intencao_pix (clinica_id);
--> statement-breakpoint
CREATE UNIQUE INDEX intencao_pix_txid_uk ON intencao_pix (clinica_id, txid);
--> statement-breakpoint
CREATE INDEX intencao_pix_parcela_idx ON intencao_pix (parcela_id);
--> statement-breakpoint

-- **É aqui que a idempotência mora.**
--
-- PSP reentrega — é o comportamento correto dele: se não recebeu 200, tenta de novo,
-- depois de um timeout nosso, de um deploy no meio, de um 500. A segunda notificação
-- carrega o MESMO `end_to_end_id`, porque é a mesma liquidação.
--
-- Então o INSERT aqui vem primeiro e `(clinica_id, end_to_end_id)` é único: a
-- reentrega colide no índice e o processamento nem começa. A alternativa ("verifica se
-- já existe, se não existe processa") tem janela entre ler e escrever, e duas entregas
-- simultâneas conciliam duas vezes — dinheiro em dobro no caixa, com o extrato
-- mostrando uma entrada só.
CREATE TABLE evento_pix (
  clinica_id            uuid NOT NULL DEFAULT app_clinica_id()
    REFERENCES clinica(id) ON DELETE RESTRICT,
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  end_to_end_id         text NOT NULL,
  txid                  text NOT NULL,
  valor                 numeric(10,2) NOT NULL,
  liquidado_em          timestamptz NOT NULL,
  recebido_em           timestamptz NOT NULL DEFAULT now(),
  payload               jsonb NOT NULL,
  processado_em         timestamptz,
  motivo_nao_processado text,
  criado_em             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evento_pix_valor_positivo CHECK (valor > 0),
  CONSTRAINT evento_pix_nao_processado_justificado
    CHECK (processado_em IS NOT NULL OR motivo_nao_processado IS NOT NULL)
);
--> statement-breakpoint

CREATE INDEX evento_pix_clinica_idx ON evento_pix (clinica_id);
--> statement-breakpoint
CREATE UNIQUE INDEX evento_pix_e2e_uk ON evento_pix (clinica_id, end_to_end_id);
--> statement-breakpoint
CREATE INDEX evento_pix_txid_idx ON evento_pix (clinica_id, txid);
--> statement-breakpoint
CREATE INDEX evento_pix_pendentes_idx
  ON evento_pix (clinica_id, recebido_em) WHERE processado_em IS NULL;
--> statement-breakpoint

-- ── 10. Row Level Security ─────────────────────────────────────────────────
--
-- `USING` **e** `WITH CHECK`. Só `USING` deixaria o INSERT gravar na clínica alheia.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'categoria_despesa', 'regra_despesa_recorrente', 'despesa', 'pagamento_despesa',
    'taxa_meio_pagamento', 'intencao_pix', 'evento_pix'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolamento ON %I FOR ALL '
      'USING (clinica_id = app_clinica_id()) WITH CHECK (clinica_id = app_clinica_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO facilident_app', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ── 11. A trava de suspensão, que a 0027 NÃO alcança ───────────────────────
--
-- O laço da `drizzle/0027` varreu o catálogo **uma vez**. Tabela criada depois não
-- recebe política restritiva nenhuma, e uma clínica suspensa escreveria nela
-- livremente. O cabeçalho da 0027 afirmava o contrário e a frase foi corrigida.
--
-- INSERT e UPDATE, não DELETE: `WITH CHECK` que reprova produz ERRO; `USING` que
-- reprova produz silêncio (a linha não é vista, o comando volta "com sucesso" tendo
-- casado zero linhas). Travar DELETE por RLS diria "apagado" para quem não apagou.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'categoria_despesa', 'regra_despesa_recorrente', 'despesa', 'pagamento_despesa',
    'taxa_meio_pagamento', 'intencao_pix', 'evento_pix'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY assinatura_trava_insert ON %I AS RESTRICTIVE FOR INSERT '
      'WITH CHECK (assinatura_permite_escrita(clinica_id))', t);
    EXECUTE format(
      'CREATE POLICY assinatura_trava_update ON %I AS RESTRICTIVE FOR UPDATE '
      'WITH CHECK (assinatura_permite_escrita(clinica_id))', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ── 12. As asserções, rodando agora ───────────────────────────────────────
SELECT exigir_isolamento_estrutural();
--> statement-breakpoint

-- E a trava de suspensão nas sete tabelas novas, conferida aqui. Criar política dentro
-- de um `format()` num laço e não conferir é exatamente onde mora o erro que ninguém vê.
DO $$
DECLARE v_faltando text[];
BEGIN
  SELECT coalesce(array_agg(t ORDER BY t), ARRAY[]::text[]) INTO v_faltando
    FROM unnest(ARRAY[
      'categoria_despesa', 'regra_despesa_recorrente', 'despesa', 'pagamento_despesa',
      'taxa_meio_pagamento', 'intencao_pix', 'evento_pix'
    ]) AS t
   WHERE (SELECT count(*) FROM pg_policies p
           WHERE p.tablename = t AND p.policyname LIKE 'assinatura_trava_%') <> 2;

  IF array_length(v_faltando, 1) > 0 THEN
    RAISE EXCEPTION
      'Tabelas sem a trava de suspensao: %. Clinica suspensa escreveria nelas.',
      array_to_string(v_faltando, ', ');
  END IF;
END $$;
--> statement-breakpoint

-- ── 13. Categorias de partida ──────────────────────────────────────────────
--
-- O que um consultório de duas cadeiras realmente paga. **De partida**: a clínica
-- ajusta, acrescenta e desativa.
--
-- `Comissão de profissionais` existe aqui porque comissão paga É despesa — mas nada
-- no sistema cria essa despesa automaticamente a partir de `comissaoDoPeriodo`.
-- Derivar seria contagem dupla esperando acontecer: alguém vai lançar o pagamento à mão
-- (porque saiu do banco) e o caixa registraria a mesma saída duas vezes. A apuração é a
-- fonte do número; o lançamento é ato humano.
--
-- Sem `ON CONFLICT DO NOTHING` mudo: se rodar duas vezes, o índice único acusa, e é bom
-- que acuse — seed de categoria não é operação repetível por acidente.
INSERT INTO categoria_despesa (clinica_id, nome, natureza)
SELECT c.id, v.nome, v.natureza::natureza_despesa
  FROM clinica c
 CROSS JOIN (VALUES
   ('Aluguel e condomínio',        'fixa'),
   ('Água, luz e internet',        'fixa'),
   ('Salários e encargos',         'fixa'),
   ('Comissão de profissionais',   'variavel'),
   ('Material de consumo',         'variavel'),
   ('Laboratório de prótese',      'variavel'),
   ('Manutenção de equipamento',   'variavel'),
   ('Software e sistemas',         'fixa'),
   ('Contabilidade',               'fixa'),
   ('Impostos e taxas',            'fixa'),
   ('Marketing',                   'variavel'),
   ('Descarte de resíduos (RSS)',  'fixa')
 ) AS v(nome, natureza)
ON CONFLICT (clinica_id, nome) DO NOTHING;
