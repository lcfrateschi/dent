-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Fase 17 — o contrato: assinatura, e a trava de suspensão                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Duas tabelas e uma trava. A trava é o assunto todo.
--
-- ── A decisão que manda nesta migration ─────────────────────────────────────
-- **Suspensão bloqueia ESCRITA e NUNCA a leitura nem a exportação do prontuário.**
--
-- Não é generosidade comercial. Prontuário tem guarda mínima de 20 anos (CFO) e a
-- íntegra dele é direito do paciente — não é garantia de pagamento da clínica.
-- Retê-lo como alavanca de cobrança é indefensável em juízo e é o tipo de coisa
-- que se implementa "só por enquanto" e vira notícia. Por isso a trava está no
-- BANCO, com a exceção embutida na forma dela, e não num `if` de TypeScript que a
-- próxima refatoração remove sem perceber.
--
-- Leitura também continua livre por um motivo mais imediato: a recepção da clínica
-- suspensa precisa ver a agenda de hoje para avisar os pacientes. Um sistema que
-- apaga a agenda no dia em que o boleto atrasa não cobra a clínica — atrapalha o
-- paciente, que não deve nada a ninguém.
--
-- ── Por que política RESTRITIVA, e não trocar a política existente ──────────
-- As políticas de `drizzle/0023` (`tenant_isolamento`) são PERMISSIVAS, e
-- permissivas se somam com OR. Se eu implementasse a trava editando-as, bastaria
-- alguém recriar uma `FOR ALL` permissiva — o próprio laço da 0023, rodado de novo
-- — para **destravar a escrita sem nenhum aviso**.
--
-- `AS RESTRICTIVE` se combina com AND. Nenhuma política nova consegue afrouxá-la, e
-- a 0023 continua intacta: as duas camadas coexistem sem uma saber da outra.
--
-- ── Por que INSERT e UPDATE, e por que NÃO DELETE ──────────────────────────
-- Numa política de RLS, `WITH CHECK` que reprova produz ERRO ("new row violates
-- row-level security policy"). `USING` que reprova produz **silêncio**: a linha
-- simplesmente não é vista, o `UPDATE`/`DELETE` casa zero linhas e o comando volta
-- com sucesso.
--
-- INSERT e UPDATE são cobrados por `WITH CHECK` — falham alto. DELETE só tem
-- `USING`, então uma trava de DELETE por RLS diria "apagado" para uma clínica
-- suspensa que não apagou nada. Isso é exatamente o modo de falha plausível-e-errado
-- que este projeto recusa em todo lugar (é o motivo de `app_clinica_id()` estourar
-- em vez de devolver NULL). Travar DELETE de verdade pediria trigger em 36 tabelas.
--
-- **Então DELETE não é travado, e está escrito aqui em vez de ficar implícito.** O
-- risco residual é pequeno: o que é prontuário já é append-only por trigger
-- (`evolucao`, `movimento_estoque`, `audit_log`), documento tem remoção de mão
-- única (`drizzle/0011`), e o resto é dado da própria clínica. Uma clínica suspensa
-- apagando um bloqueio de agenda dela não é o problema que esta trava existe para
-- resolver.
--
-- ── O que continua escrevendo mesmo suspensa, e por quê ────────────────────
-- A lista é curta e cada linha tem consequência concreta se sair dela:
--
--   • `audit_log` — leitura de prontuário é evento auditável na LGPD, e o app
--     GRAVA no audit_log ao ler. Travá-lo travaria a leitura, ou seja, exatamente o
--     que esta migration promete não travar. Além disso: trilha de auditoria que
--     para quando o boleto atrasa não é trilha.
--   • `paciente_sessao` — login e **logout** do portal. Travar impediria o paciente
--     de entrar (logo, de ler) e faria o "sair" não revogar a sessão, que é uma
--     regressão de segurança de verdade.
--   • `usuario` e `paciente_conta`, só UPDATE — `ultimo_login_em`, troca de senha e
--     o contador de tentativas de `lib/domain/bloqueio.ts`. Sem isso ninguém entra,
--     nem para ler. INSERT segue travado: clínica suspensa não cadastra staff novo.
--   • `assinatura` e `plano_assinatura` — é a própria cobrança. Travar a tabela que
--     diz "está suspensa" com base nela mesma é a recursão óbvia.
--
-- ⚠️ **CORREÇÃO desta migration, escrita depois.** A frase que estava aqui dizia
-- "tabela nova nasce TRAVADA (o laço varre o catálogo)". **É falsa.** O laço varre o
-- catálogo UMA VEZ, no momento em que esta migration roda: tabela criada depois não
-- recebe política restritiva nenhuma, e uma clínica suspensa escreve nela livremente.
--
-- Descoberto na Fase 18, quando três tabelas novas nasceram destravadas. E
-- `exigir_isolamento_estrutural()` não pega: ela confere `clinica_id`, RLS, `FORCE` e a
-- política de **isolamento** — não a de suspensão, que é outra coisa.
--
-- Fail closed continua sendo o certo (escrita recusada numa clínica que não paga é
-- melhor que escrita liberada em silêncio), e é justamente por isso que a afirmação
-- falsa era perigosa: ela convidava a próxima pessoa a **não** travar a tabela nova,
-- confiando num laço que já tinha passado. Quem cobra isso agora é um caso de catálogo
-- em `docker/verificar-invariantes.sql`, não a memória de quem escreve a migration.

-- ── 1. O catálogo comercial (global) e a assinatura (por clínica) ───────────
CREATE TYPE situacao_assinatura AS ENUM ('ativa', 'suspensa', 'cancelada');
--> statement-breakpoint

CREATE TABLE plano_assinatura (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo        text NOT NULL,
  nome          text NOT NULL,
  preco_mensal  numeric(10,2) NOT NULL,
  limite_profissionais smallint,
  limite_cadeiras      smallint,
  ativo         boolean NOT NULL DEFAULT true,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plano_preco_nao_negativo CHECK (preco_mensal >= 0),
  -- `NULL` é sem limite; zero seria "não pode cadastrar nenhum", que nenhum plano
  -- vendável significa. Ver o comentário em lib/db/schema/assinatura.ts.
  CONSTRAINT plano_limites_positivos CHECK (
    (limite_profissionais IS NULL OR limite_profissionais > 0) AND
    (limite_cadeiras      IS NULL OR limite_cadeiras > 0)
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX plano_assinatura_codigo_uk ON plano_assinatura (codigo);
--> statement-breakpoint

CREATE TABLE assinatura (
  clinica_id      uuid NOT NULL DEFAULT app_clinica_id() REFERENCES clinica(id) ON DELETE RESTRICT,
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plano_id        uuid NOT NULL REFERENCES plano_assinatura(id) ON DELETE RESTRICT,
  situacao        situacao_assinatura NOT NULL DEFAULT 'ativa',
  iniciada_em     timestamptz NOT NULL DEFAULT now(),
  situacao_desde  timestamptz NOT NULL DEFAULT now(),
  motivo_situacao text,
  retencao_ate    date,
  atualizado_em   timestamptz NOT NULL DEFAULT now(),
  -- Suspender ou cancelar sem dizer por quê deixa a recepção descobrindo com o
  -- paciente na cadeira que o sistema não grava, e ninguém sabendo o motivo.
  CONSTRAINT assinatura_motivo_fora_de_ativa CHECK (
    situacao = 'ativa' OR (motivo_situacao IS NOT NULL AND btrim(motivo_situacao) <> '')
  )
);
--> statement-breakpoint

CREATE INDEX assinatura_clinica_idx ON assinatura (clinica_id);
--> statement-breakpoint

-- Uma por clínica: duas tornariam indefinido se a clínica está suspensa, e a
-- resposta decide se o dentista registra a evolução do paciente que está na cadeira.
CREATE UNIQUE INDEX assinatura_uma_por_clinica_uk ON assinatura (clinica_id);
--> statement-breakpoint

-- FK composto, como as outras filhas de tenant (0023): impossível a assinatura de
-- uma clínica apontar para linha de outra.
CREATE UNIQUE INDEX IF NOT EXISTS assinatura_id_clinica_uk ON assinatura (id, clinica_id);
--> statement-breakpoint

-- ── 2. Os planos de partida ────────────────────────────────────────────────
-- Valores de PARTIDA, no mesmo espírito do catálogo de procedimentos: revisar com
-- quem vende. Os limites são o que distingue os planos; o preço é palpite.
INSERT INTO plano_assinatura (codigo, nome, preco_mensal, limite_profissionais, limite_cadeiras)
VALUES
  ('essencial',    'Essencial',    '249.00', 2,    2),
  ('profissional', 'Profissional', '449.00', 6,    4),
  ('clinica',      'Clínica',      '899.00', NULL, NULL)
ON CONFLICT (codigo) DO NOTHING;
--> statement-breakpoint

-- ── 2b. As clínicas que já existem ganham contrato ─────────────────────────
--
-- Sem isto, toda clínica anterior a esta migration ficaria **sem assinatura** — e
-- funcionando, porque `assinatura_permite_escrita()` destrava nesse caso. Parece
-- inofensivo e é ruim por dois motivos: o destravamento por omissão deixaria de ser
-- o caminho excepcional e passaria a ser o normal (é assim que uma exceção
-- documentada vira comportamento em que ninguém mais pensa), e a verificação
-- `docker/verificar-assinatura.sql` — que existe justamente para achar clínica sem
-- contrato — nasceria vermelha, o que ensina a ignorá-la.
--
-- O plano atribuído é PALPITE meu e está marcado como tal: quem migra de
-- single-tenant é o cliente que já existe, e em que plano ele está é conversa
-- comercial. `situacao = 'ativa'` porque ele está usando o sistema hoje;
-- congelá-lo para esperar a definição do plano seria a migration derrubando um
-- cliente em produção.
INSERT INTO assinatura (clinica_id, plano_id, situacao)
SELECT c.id,
       (SELECT id FROM plano_assinatura WHERE codigo = 'profissional'),
       'ativa'
  FROM clinica c
 WHERE NOT EXISTS (SELECT 1 FROM assinatura a WHERE a.clinica_id = c.id);
--> statement-breakpoint

-- ── 3. A pergunta, em uma função ───────────────────────────────────────────
--
-- ── Por que NÃO é `SECURITY DEFINER` ───────────────────────────────────────
-- Seria o reflexo: função chamada de dentro de política, logo precisa de
-- privilégio. Não precisa, e o privilégio custaria. Como `facilident_app`, a
-- política `tenant_isolamento` de `assinatura` já limita o que esta consulta vê à
-- própria clínica — e o `WHERE clinica_id = p_clinica` a limita de novo. Uma função
-- `SECURITY DEFINER` de dono superusuário é superfície de escalonamento; não abrir
-- uma que não é necessária é a escolha barata.
--
-- ── Por que o `WHERE` explícito, mesmo com RLS ─────────────────────────────
-- Porque os scripts de operação (seed, onboarding, demonstrações, backup) rodam
-- como DONO, que é superusuário e **ignora política**. Sem o `WHERE`, esta função
-- rodada por eles leria a assinatura de alguma outra clínica — a sonda que parece
-- filtrar e não filtra, que já custou uma depuração inteira nesta fase.
--
-- ── Por que sem assinatura devolve `true` (destravado) ─────────────────────
-- Esta é a decisão desconfortável, e ela é deliberadamente ASSIMÉTRICA em relação
-- ao resto do projeto, que falha fechado.
--
-- Falhar fechado aqui significaria: clínica sem linha de assinatura fica congelada.
-- Quem paga o erro de contabilidade nossa é o dentista, no meio do atendimento, com
-- o paciente na cadeira. Falhar aberto significa: podemos deixar de faturar alguém.
-- Entre "não conseguimos cobrar" e "o profissional não consegue registrar o que fez
-- no paciente", a escolha não é difícil.
--
-- Não é frouxidão porque **criar clínica exige credencial de dono** (não existe
-- auto-cadastro), então ninguém consegue se dar uma clínica sem assinatura. E o
-- controle compensatório é uma verificação, não um congelamento:
-- `docker/verificar-assinatura.sql` reprova se existir clínica sem assinatura. O
-- descuido aparece no relatório verde ficando vermelho, não numa recepção parada.
CREATE OR REPLACE FUNCTION assinatura_permite_escrita(p_clinica uuid) RETURNS boolean AS $$
  SELECT coalesce(
    (SELECT situacao = 'ativa' FROM assinatura WHERE clinica_id = p_clinica),
    true
  );
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

COMMENT ON FUNCTION assinatura_permite_escrita(uuid) IS
  'A clínica pode ESCREVER? Suspensa/cancelada não escreve; sem assinatura escreve '
  '(ver drizzle/0027). Nunca é consultada para leitura nem para exportação.';
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION assinatura_permite_escrita(uuid) TO facilident_app;
--> statement-breakpoint

-- ── 4. A trava ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
  v_n_insert int := 0;
  v_n_update int := 0;
  -- Sem trava nenhuma. Cada uma justificada no cabeçalho deste arquivo.
  v_livres text[] := ARRAY['audit_log', 'paciente_sessao', 'assinatura'];
  -- UPDATE livre, INSERT travado: login, troca de senha e contador de tentativas.
  v_update_livre text[] := ARRAY['usuario', 'paciente_conta'];
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND n.nspname = 'public'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                    AND a.attname = 'clinica_id' AND NOT a.attisdropped)
     ORDER BY 1
  LOOP
    IF r.relname = ANY (v_livres) THEN CONTINUE; END IF;

    EXECUTE format('DROP POLICY IF EXISTS assinatura_trava_insert ON %I', r.relname);
    EXECUTE format(
      'CREATE POLICY assinatura_trava_insert ON %I AS RESTRICTIVE FOR INSERT '
      'WITH CHECK (assinatura_permite_escrita(clinica_id))', r.relname);
    v_n_insert := v_n_insert + 1;

    IF NOT (r.relname = ANY (v_update_livre)) THEN
      EXECUTE format('DROP POLICY IF EXISTS assinatura_trava_update ON %I', r.relname);
      -- `USING (true)`: quem reprova é o `WITH CHECK`, que ESTOURA. Um `USING`
      -- reprovando faria o UPDATE casar zero linhas e voltar com sucesso.
      EXECUTE format(
        'CREATE POLICY assinatura_trava_update ON %I AS RESTRICTIVE FOR UPDATE '
        'USING (true) WITH CHECK (assinatura_permite_escrita(clinica_id))', r.relname);
      v_n_update := v_n_update + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'trava de suspensão: % tabelas no INSERT, % no UPDATE', v_n_insert, v_n_update;
END $$;
--> statement-breakpoint

-- `assinatura` e `plano_assinatura` são NOSSAS, não da clínica: ela lê para saber em
-- que plano está, e não escreve. Sem este REVOKE, o `ALTER DEFAULT PRIVILEGES` da
-- 0023 daria escrita à role do app na tabela que decide a própria cobrança — uma
-- falha de lógica de negócio em que a clínica se reativa sozinha.
REVOKE INSERT, UPDATE, DELETE ON assinatura FROM facilident_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON plano_assinatura FROM facilident_app;
--> statement-breakpoint

-- `plano_assinatura` é catálogo global: RLS ficaria com `USING (true)`, que é
-- teatro — política que não decide nada e que alguém no futuro leria como
-- isolamento. O que protege é o grant (só SELECT). Mesmo tratamento de `dente`.
ALTER TABLE assinatura ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE assinatura FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolamento ON assinatura FOR ALL
  USING (clinica_id = app_clinica_id()) WITH CHECK (clinica_id = app_clinica_id());
--> statement-breakpoint

-- ── 5. A asserção de catálogo aprende o `plano_assinatura` ─────────────────
--
-- `exigir_isolamento_estrutural()` (0023) derruba o deploy se aparecer tabela sem
-- `clinica_id`, sem RLS, sem FORCE ou sem política. `plano_assinatura` é
-- deliberadamente global, então ela precisa entrar na lista de isentas — que é o
-- caminho documentado desde a 0022: *"se ela for referência global de verdade,
-- acrescente à lista de isentas AQUI, com a justificativa"*.
--
-- O corpo abaixo NÃO foi redigitado: veio de `pg_get_functiondef()` do banco, com
-- a linha nova inserida por script. Retranscrever função de invariante à mão é como
-- se perde uma checagem sem ninguém ver — aconteceu nesta fase, com uma trigger
-- que voltou de memória com uma condição inventada e outra mensagem.
CREATE OR REPLACE FUNCTION public.exigir_isolamento_estrutural()
 RETURNS void
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_erros text[] := ARRAY[]::text[];
  v_isentas text[] := ARRAY[
    'clinica',                -- é o tenant; tem política própria, por `id`
    'dente',                  -- 52 dentes FDI: referência global, sem tenant
    '__drizzle_migrations',   -- controle do migrador
    'plano_assinatura'        -- catálogo COMERCIAL nosso, não de tenant: ver drizzle/0027
  ];
  v_t record;
BEGIN
  FOR v_t IN
    SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                    AND a.attname = 'clinica_id' AND NOT a.attisdropped) AS tem_coluna,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS politicas
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND n.nspname = 'public'
       AND NOT (c.relname = ANY (v_isentas))
     ORDER BY c.relname
  LOOP
    IF NOT v_t.tem_coluna THEN
      v_erros := v_erros || (v_t.relname || ': sem clinica_id');
      CONTINUE;  -- sem a coluna, cobrar política seria cobrar o impossível
    END IF;
    IF NOT v_t.relrowsecurity THEN
      v_erros := v_erros || (v_t.relname || ': RLS desligada');
    END IF;
    IF NOT v_t.relforcerowsecurity THEN
      v_erros := v_erros || (v_t.relname || ': sem FORCE');
    END IF;
    IF v_t.politicas = 0 THEN
      -- RLS ligada e nenhuma política é o pior estado: nega tudo em silêncio.
      v_erros := v_erros || (v_t.relname || ': RLS ligada e NENHUMA política');
    END IF;
  END LOOP;

  /* ── FK composto: a camada que o Drizzle não sabe que existe ──────────────
     Os arquivos de `lib/db/schema/` declaram estes FKs como `.references(…)`, de
     uma coluna. O banco os tem de duas. Quem rodar `db:generate` vai receber uma
     migration que "corrige" o banco de volta para o que o TypeScript diz — e
     desfaz os 80 FKs compostos sem nenhum aviso, porque para o drizzle-kit isso é
     apenas o banco divergindo do schema.

     Enquanto o schema não declarar `foreignKey({ columns: [x, clinicaId], … })`,
     esta checagem é o que transforma essa reversão silenciosa em deploy vermelho.
     É a mesma ideia da asserção de catálogo da 0022: a trava mora no banco. */
  FOR v_t IN
    SELECT ch.relname AS filha,
           (SELECT a.attname FROM pg_attribute a
             WHERE a.attrelid = co.conrelid AND a.attnum = co.conkey[1]) AS col,
           pa.relname AS pai
      FROM pg_constraint co
      JOIN pg_class ch ON ch.oid = co.conrelid
      JOIN pg_class pa ON pa.oid = co.confrelid
      JOIN pg_namespace n ON n.oid = ch.relnamespace
     WHERE co.contype = 'f' AND n.nspname = 'public'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = ch.oid
                    AND a.attname = 'clinica_id' AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = pa.oid
                    AND a.attname = 'clinica_id' AND NOT a.attisdropped)
       AND NOT EXISTS (
         SELECT 1 FROM pg_constraint co2
          WHERE co2.contype = 'f' AND co2.conrelid = co.conrelid
            AND co.conkey[1] = ANY (co2.conkey)
            AND (SELECT a.attnum FROM pg_attribute a
                  WHERE a.attrelid = co.conrelid AND a.attname = 'clinica_id') = ANY (co2.conkey))
  LOOP
    v_erros := v_erros || (v_t.filha || '.' || v_t.col || ' -> ' || v_t.pai ||
      ': FK sem clinica_id na chave (composto revertido?)');
  END LOOP;

  -- A política tem de checar a ESCRITA também. `polwithcheck IS NULL` numa
  -- política `FOR ALL` significa que o Postgres reusa o `USING` — o que aqui dá o
  -- resultado certo. O que não pode passar é política permissiva de escrita.
  FOR v_t IN
    SELECT c.relname, p.polname
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND p.polcmd = '*'
       AND pg_get_expr(p.polqual, p.polrelid) NOT LIKE '%app_clinica_id()%'
  LOOP
    v_erros := v_erros || (v_t.relname || '.' || v_t.polname ||
      ': política que não usa app_clinica_id()');
  END LOOP;

  IF array_length(v_erros, 1) > 0 THEN
    RAISE EXCEPTION E'Isolamento estrutural incompleto:\n  - %',
      array_to_string(v_erros, E'\n  - ');
  END IF;
END $function$;
--> statement-breakpoint

-- A asserção rodando agora: se `assinatura` ficou sem política ou sem FORCE, a
-- migration morre aqui em vez de deixar uma tabela de cobrança sem isolamento.
SELECT exigir_isolamento_estrutural();
