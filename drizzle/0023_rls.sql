-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Fase 17 — Fundação multi-tenant, parte 2: o isolamento estrutural        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- A 0022 pôs `clinica_id` em 40 tabelas e criou o contexto (`app_clinica_id()`).
-- Isso ainda é disciplina: uma consulta que esqueça o `where` vaza. Esta migration
-- troca disciplina por estrutura, em três camadas independentes:
--
--   1. **FK composto** — impossível uma parcela apontar para cobrança de outra
--      clínica. Cumpre a promessa escrita em `lib/db/schema/tenant.ts`.
--   2. **Row Level Security** com política de `USING` **e** `WITH CHECK`.
--   3. **Uma role de aplicação que não é dona das tabelas** — sem ela as duas
--      camadas acima são enfeite. É o item mais importante do arquivo e o menos
--      óbvio; está explicado na seção 1.
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ ⚠️ LEIA ISTO ANTES DE ACREDITAR QUE O SISTEMA ESTÁ ISOLADO               ║
-- ║                                                                          ║
-- ║ Ao fim desta migration as políticas existem e estão provadas — mas ficam  ║
-- ║ INERTES para o app, porque ele ainda conecta como `facilident`, que é     ║
-- ║ dono das tabelas E superusuário. **Superusuário ignora RLS sempre**,      ║
-- ║ inclusive com `FORCE`. O isolamento só passa a valer quando o             ║
-- ║ `DATABASE_URL` do app apontar para `facilident_app` — e isso depende de   ║
-- ║ duas mudanças em `lib/` que esta migration não faz (ver seção 8).         ║
-- ║                                                                          ║
-- ║ Enquanto isso não acontecer, o que esta migration entrega de verdade é:   ║
-- ║   • o FK composto, que vale para TODA role, inclusive superusuário;       ║
-- ║   • as políticas prontas e provadas via `SET ROLE`;                       ║
-- ║   • a asserção que impede tabela nova nascer sem isolamento.              ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── 1. A role de aplicação ──────────────────────────────────────────────────
--
-- ── Por que uma role nova, e por que este é o ponto que decide a fase ───────
-- **Dono de tabela ignora política de RLS.** Não é pegadinha do Postgres: é o
-- desenho — quem pode `DROP` a política não ganharia nada sendo barrado por ela.
-- E superusuário ignora RLS em qualquer tabela, dono ou não.
--
-- Hoje o app conecta como `facilident`, que na imagem oficial do Postgres é
-- superusuário e é dono de tudo. Se eu apenas criasse as políticas, elas ficariam
-- **decorativas**: o app continuaria vendo todas as clínicas, e um teste
-- adversarial escrito de boa-fé ("a clínica A consegue ler o paciente da B?")
-- passaria com o vazamento de pé, porque o teste também rodaria como
-- superusuário. Relatório verde provando nada — o pior resultado possível, e o
-- erro que este projeto já cometeu três vezes de outras formas.
--
-- ── Uma role, não três ─────────────────────────────────────────────────────
-- Considerei `facilident_owner` / `_app` / `_ops`. Transferir a posse das 40
-- tabelas para uma role nova é uma migration de risco próprio (posse de tabela,
-- de sequence, de função, de tipo, e o `ALTER DEFAULT PRIVILEGES` de quem gera as
-- próximas), e o ganho sobre o que está aqui é pequeno: **o que protege o app
-- não é a posse mudar de mão, é o app não ser o dono**. Uma role de aplicação
-- basta para isso.
--
-- `facilident` continua dono e continua sendo o caminho de manutenção: migration,
-- `db:verificar`, backup e restauração. Isso é uma escolha consciente com um
-- custo escrito: **quem tem a senha do `facilident` não é isolado por nada
-- disto**. Em produção essa credencial é de operação, não de aplicação, e não
-- deve estar no `.env` do serviço web.
--
-- ── NOLOGIN aqui, senha em outro lugar ─────────────────────────────────────
-- A role nasce sem `LOGIN` e sem senha. Senha fixa dentro de arquivo SQL
-- versionado é senha pública: ela vai para o Git, para o backup do Git e para a
-- máquina de quem clonou o repositório. Quem dá `LOGIN` é
-- `docker/credencial-app.sh`, a partir de variável de ambiente, e ele **se recusa
-- a rodar em produção com a senha de desenvolvimento** — mesmo espírito de
-- `exigirSegredoDeProducao()`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'facilident_app') THEN
    -- Cada NO aqui é uma forma de escapar da RLS que fica fechada.
    -- `NOBYPASSRLS` é o explícito que importa: é literalmente a chave-mestra.
    CREATE ROLE facilident_app
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      NOINHERIT NOLOGIN;
  ELSE
    -- Idempotência com dentes: se a role já existe, ela pode ter sido alterada
    -- à mão. Reafirmar os atributos é mais seguro que presumir.
    ALTER ROLE facilident_app
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END $$;
--> statement-breakpoint

COMMENT ON ROLE facilident_app IS
  'Role de aplicação. NÃO é dona das tabelas e não tem BYPASSRLS — é isso que faz '
  'a política de RLS valer. Senha definida por docker/credencial-app.sh.';
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO facilident_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO facilident_app;
--> statement-breakpoint

-- `audit_log.id` é serial: sem USAGE na sequence, nenhuma leitura de prontuário
-- consegue ser auditada — e a auditoria é obrigação de LGPD, não recurso.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO facilident_app;
--> statement-breakpoint

-- Referência global: o app LÊ os 52 dentes FDI e nunca os escreve. Semear
-- referência é operação de manutenção, feita pelo dono.
REVOKE INSERT, UPDATE, DELETE ON dente FROM facilident_app;
--> statement-breakpoint

-- `clinica`: o app edita a configuração da própria clínica (tela de ajustes), mas
-- **criar e apagar clínica é onboarding e encerramento de contrato** — decisão
-- comercial, com cobrança e exportação LGPD do lado. Não é operação que uma
-- requisição HTTP deva conseguir fazer nem por bug.
REVOKE INSERT, DELETE ON clinica FROM facilident_app;
--> statement-breakpoint

-- Tabela nova nasce com os grants certos. Isto vale para objetos criados por
-- `facilident`, que é quem roda as migrations.
--
-- ⚠️ E é justamente por isso que a asserção da seção 7 existe: sem ela, uma
-- tabela criada na Fase 18 ganharia os privilégios automaticamente e **não**
-- ganharia a política de RLS automaticamente. O default privilege é conveniência;
-- a asserção é a trava.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO facilident_app;
--> statement-breakpoint

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO facilident_app;
--> statement-breakpoint

-- ── 2. O problema do ovo e da galinha: autenticar ANTES de ter contexto ─────
--
-- Este é o detalhe que faz uma implementação de RLS parecer pronta e não subir.
--
-- Toda consulta do app passa a exigir `app.clinica_id` no contexto. Mas as DUAS
-- consultas de autenticação acontecem **antes de se saber qual é a clínica**:
--
--   • login de staff: `select … from usuario where lower(email) = ?` — o tenant é
--     derivado da credencial, então ele só é conhecido DEPOIS desta leitura;
--   • sessão do portal: `select … from paciente_sessao where token_hash = ?`.
--
-- Com RLS ligada e sem contexto, as duas viram erro, e o sistema não tem login.
--
-- ── A solução, e por que ela é estreita ────────────────────────────────────
-- Duas funções `SECURITY DEFINER` que resolvem **só o tenant** — devolvem um
-- `uuid` e nada mais. O app então abre o envelope (`comClinica`) e roda a consulta
-- de login que já existe, sem alteração, agora filtrada pela política.
--
-- O que eu deliberadamente NÃO fiz: reescrever o login inteiro como função no
-- banco. Seria duplicar em PL/pgSQL a verificação de senha, o TOTP e o cuidado
-- com tempo de resposta que `lib/auth/config.ts` já tem — e a superfície exposta
-- passaria a incluir `senha_hash` e `mfa_secret`. Aqui a superfície é um uuid.
--
-- `SET search_path` não é enfeite: função `SECURITY DEFINER` sem search_path fixo
-- é sequestrável por quem consiga criar um schema — o caminho clássico de
-- escalação de privilégio no Postgres.
CREATE OR REPLACE FUNCTION clinica_do_login_de_staff(p_email text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT clinica_id FROM usuario WHERE lower(email) = lower(btrim(p_email));
$$;
--> statement-breakpoint

-- Sem `LIMIT`: `usuario_email_uk` é único GLOBAL (o login é e-mail + senha, ver
-- `lib/db/schema/acesso.ts`). Se um dia essa unicidade for afrouxada, esta
-- subconsulta estoura com "more than one row" em vez de escolher uma clínica
-- arbitrária e mandar a pessoa para o prontuário errado. Falhar alto é o ponto.

COMMENT ON FUNCTION clinica_do_login_de_staff(text) IS
  'Resolve o tenant a partir do e-mail, ANTES de haver contexto. Não autoriza nada: '
  'quem valida senha e MFA é a aplicação, dentro do envelope da clínica devolvida.';
--> statement-breakpoint

-- `SECURITY DEFINER` + `EXECUTE` para PUBLIC (o padrão do Postgres) seria dar a
-- qualquer role a capacidade de mapear e-mail → clínica. Fecha e abre só para quem
-- precisa.
REVOKE ALL ON FUNCTION clinica_do_login_de_staff(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION clinica_do_login_de_staff(text) TO facilident_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION clinica_da_sessao_do_portal(p_token_hash text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT clinica_id FROM paciente_sessao
   WHERE token_hash = p_token_hash AND revogada_em IS NULL;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION clinica_da_sessao_do_portal(text) IS
  'Resolve o tenant a partir do hash do token de sessão do portal. NÃO valida '
  'expiração nem conta ativa — isso continua em lib/portal/sessao.ts, dentro do '
  'envelope. Aqui é só descobrir de quem é a sessão.';
--> statement-breakpoint

REVOKE ALL ON FUNCTION clinica_da_sessao_do_portal(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION clinica_da_sessao_do_portal(text) TO facilident_app;
--> statement-breakpoint

-- ── 3. `UNIQUE (id, clinica_id)` nos pais ───────────────────────────────────
--
-- Logicamente redundante: `id` já é chave primária, então `(id, clinica_id)` é
-- único de graça. O Postgres exige de qualquer forma — um FK só pode referenciar
-- um conjunto de colunas que tenha índice único **exatamente** com aquelas
-- colunas. É o custo conhecido desta técnica, pago em índice.
--
-- Só nas tabelas efetivamente referenciadas como pai. Pôr em todas as 40 seria
-- índice sem leitor: custo de escrita em toda linha inserida, para nada.
DO $$
DECLARE r record; v_n int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT pa.relname AS pai
      FROM pg_constraint co
      JOIN pg_class ch ON ch.oid = co.conrelid
      JOIN pg_class pa ON pa.oid = co.confrelid
      JOIN pg_namespace n ON n.oid = pa.relnamespace
     WHERE co.contype = 'f'
       AND n.nspname = 'public'
       AND array_length(co.conkey, 1) = 1
       AND (SELECT a.attname FROM pg_attribute a
             WHERE a.attrelid = co.confrelid AND a.attnum = co.confkey[1]) = 'id'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = ch.oid
                    AND a.attname = 'clinica_id' AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = pa.oid
                    AND a.attname = 'clinica_id' AND NOT a.attisdropped)
     ORDER BY 1
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = r.pai || '_id_clinica_uk') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (id, clinica_id)',
                     r.pai, r.pai || '_id_clinica_uk');
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'UNIQUE (id, clinica_id) em % tabelas-pai', v_n;
END $$;
--> statement-breakpoint

-- ── 3b. Antes de converter: o dado atual aguenta o FK composto? ────────────
--
-- Esta seção nasceu de uma falha real. A primeira aplicação desta migration morreu
-- assim:
--
--     insert or update on table "movimento_estoque" violates foreign key
--     constraint "movimento_estoque_execucao_id_execucao_id_fk"
--     Key (execucao_id, clinica_id)=(1d674dac…, 41495462…) is not present in execucao
--
-- Cinco linhas do livro de estoque apontavam para uma `execucao` que **não existe
-- mais** — com o FK antigo marcado como `convalidated`. Causa: o `limpar()` de
-- `lib/estoque/demonstrar.ts` usa `set local session_replication_role = 'replica'`
-- para furar as triggers de append-only, e esse ajuste desliga **também as
-- triggers internas de chave estrangeira**. A limpeza apagou o pai e deixou o
-- filho.
--
-- ── Por que ABORTAR e não limpar ───────────────────────────────────────────
-- Seria fácil pôr aqui um `DELETE` dos órfãos e a migration passaria sempre. Seria
-- também a coisa mais perigosa deste arquivo: em produção, órfão no livro de
-- estoque é **sinal de que algo já deu errado**, e uma migration que apaga a
-- evidência para conseguir criar uma constraint destrói justamente o rastro de que
-- alguém precisaria. Mesmo espírito do append-only: correção é operação humana,
-- registrada.
--
-- Então a migration para, lista TUDO de uma vez (não a primeira violação, como o
-- FK faria — 80 conversões descobertas uma por vez seriam 80 tentativas), e diz
-- onde olhar.
DO $$
DECLARE
  r        record;
  v_n      bigint;
  v_relato text[] := ARRAY[]::text[];
BEGIN
  FOR r IN
    SELECT co.conname, ch.relname AS filha, pa.relname AS pai,
           (SELECT a.attname FROM pg_attribute a
             WHERE a.attrelid = co.conrelid AND a.attnum = co.conkey[1]) AS col
      FROM pg_constraint co
      JOIN pg_class ch ON ch.oid = co.conrelid
      JOIN pg_class pa ON pa.oid = co.confrelid
      JOIN pg_namespace n ON n.oid = ch.relnamespace
     WHERE co.contype = 'f' AND n.nspname = 'public'
       AND array_length(co.conkey, 1) = 1
       AND (SELECT a.attname FROM pg_attribute a
             WHERE a.attrelid = co.confrelid AND a.attnum = co.confkey[1]) = 'id'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = ch.oid
                    AND a.attname = 'clinica_id' AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = pa.oid
                    AND a.attname = 'clinica_id' AND NOT a.attisdropped)
     ORDER BY 1
  LOOP
    -- `IS NOT NULL`: FK com coluna nula não é violação (MATCH SIMPLE), e é o caso
    -- normal de `criado_por_id` de linha antiga.
    EXECUTE format(
      'SELECT count(*) FROM %I f WHERE f.%I IS NOT NULL AND NOT EXISTS ('
      '  SELECT 1 FROM %I p WHERE p.id = f.%I AND p.clinica_id = f.clinica_id)',
      r.filha, r.col, r.pai, r.col) INTO v_n;

    IF v_n > 0 THEN
      v_relato := v_relato || format('%s.%s -> %s: %s linha(s)', r.filha, r.col, r.pai, v_n);
    END IF;
  END LOOP;

  IF array_length(v_relato, 1) > 0 THEN
    RAISE EXCEPTION E'Dado inconsistente impede o FK composto:\n  - %\n\n'
      'Cada linha acima aponta para um pai que não existe ou que é de OUTRA '
      'clínica. Resolva no dado (apagar o órfão, ou anular a coluna quando ela for '
      'anulável) e rode a migration de novo. Não use session_replication_role para '
      'contornar: foi ele que produziu este estado.',
      array_to_string(v_relato, E'\n  - ');
  END IF;
END $$;
--> statement-breakpoint

-- ── 4. FK composto: a redundância travada, não confiada ─────────────────────
--
-- `parcela` já sabe a clínica pelo caminho `cobranca`, e ainda assim carrega
-- `clinica_id`. Redundância sem trava vira divergência: bastaria um bug de
-- escrita para existir parcela da clínica A pendurada em cobrança da clínica B —
-- e aí RLS filtraria a cobrança, não filtraria a parcela, e o relatório de
-- inadimplência da A mostraria dinheiro da B. Com FK composto isso deixa de ser
-- possível de gravar.
--
-- É a mesma ideia de `movimento_lote_do_mesmo_material` (`drizzle/0019`), que já
-- amarra `(lote_id, material_id)` para o material do movimento não divergir do
-- material do lote.
--
-- ── O detalhe que quase estragou tudo: `ON DELETE SET NULL` ────────────────
-- Metade destes FKs é `SET NULL` (`criado_por_id`, `agendamento_id`, …). Num FK
-- composto, `SET NULL` puro nula **todas** as colunas da chave — inclusive
-- `clinica_id`, que é `NOT NULL`. O `DELETE` do pai passaria a falhar com
-- violação de not-null: uma exclusão legítima quebrando por causa de uma trava de
-- tenant, e a mensagem não diria nada sobre tenant.
--
-- O Postgres 15 acrescentou `ON DELETE SET NULL (coluna)`, que nula só a coluna
-- indicada. Estamos no 17. Sem isso, a alternativa seria trocar `SET NULL` por
-- `NO ACTION` e mudar o comportamento do sistema — o tipo de "ajuste" silencioso
-- que se descobre meses depois.
--
-- O `ON DELETE`/`ON UPDATE` de cada FK é LIDO do catálogo e reaplicado. Redigitar
-- 80 constraints à mão é onde um `restrict` viraria `cascade` por distração, e
-- `cascade` errado num prontuário apaga histórico com guarda de 20 anos.
CREATE TEMP TABLE _fk_para_converter AS
SELECT co.conname,
       ch.relname AS filha,
       pa.relname AS pai,
       (SELECT a.attname FROM pg_attribute a
         WHERE a.attrelid = co.conrelid AND a.attnum = co.conkey[1]) AS col_filha,
       co.confdeltype,
       co.confupdtype,
       co.condeferrable,
       co.condeferred
  FROM pg_constraint co
  JOIN pg_class ch ON ch.oid = co.conrelid
  JOIN pg_class pa ON pa.oid = co.confrelid
  JOIN pg_namespace n ON n.oid = ch.relnamespace
 WHERE co.contype = 'f'
   AND n.nspname = 'public'
   -- Uma coluna só, referenciando `id`. Os compostos que já existem ficam como
   -- estão: `movimento_lote_do_mesmo_material` amarra material, não tenant, e o
   -- tenant daquela tabela é coberto pelo FK de `lote_id` convertido abaixo. A
   -- asserção da seção 5 confere que essa afirmação é verdadeira.
   AND array_length(co.conkey, 1) = 1
   AND (SELECT a.attname FROM pg_attribute a
         WHERE a.attrelid = co.confrelid AND a.attnum = co.confkey[1]) = 'id'
   AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = ch.oid
                AND a.attname = 'clinica_id' AND NOT a.attisdropped)
   AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = pa.oid
                AND a.attname = 'clinica_id' AND NOT a.attisdropped);
--> statement-breakpoint

DO $$
DECLARE
  r       record;
  v_del   text;
  v_upd   text;
  v_defer text;
  v_n     int := 0;
BEGIN
  FOR r IN SELECT * FROM _fk_para_converter ORDER BY filha, conname LOOP
    v_del := CASE r.confdeltype
               WHEN 'a' THEN 'NO ACTION'
               WHEN 'r' THEN 'RESTRICT'
               WHEN 'c' THEN 'CASCADE'
               WHEN 'n' THEN 'SET NULL (' || quote_ident(r.col_filha) || ')'
               WHEN 'd' THEN 'SET DEFAULT (' || quote_ident(r.col_filha) || ')'
             END;
    v_upd := CASE r.confupdtype
               WHEN 'a' THEN 'NO ACTION'
               WHEN 'r' THEN 'RESTRICT'
               WHEN 'c' THEN 'CASCADE'
               WHEN 'n' THEN 'SET NULL'
               WHEN 'd' THEN 'SET DEFAULT'
             END;
    IF v_del IS NULL OR v_upd IS NULL THEN
      RAISE EXCEPTION 'Ação referencial desconhecida em % (del=%, upd=%)',
        r.conname, r.confdeltype, r.confupdtype;
    END IF;

    v_defer := CASE WHEN r.condeferrable AND r.condeferred THEN ' DEFERRABLE INITIALLY DEFERRED'
                    WHEN r.condeferrable                   THEN ' DEFERRABLE'
                    ELSE '' END;

    -- O nome é reaproveitado: a constraint continua se chamando o que se chamava,
    -- para nenhuma mensagem de erro conhecida mudar e para o diff ser legível.
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.filha, r.conname);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I, clinica_id) '
      'REFERENCES %I (id, clinica_id) ON UPDATE %s ON DELETE %s%s',
      r.filha, r.conname, r.col_filha, r.pai, v_upd, v_del, v_defer);
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE '% FKs convertidos para composto (col, clinica_id)', v_n;
END $$;
--> statement-breakpoint

DROP TABLE _fk_para_converter;
--> statement-breakpoint

-- ── 5. Asserção: nenhum caminho entre tabelas de tenant ficou solto ────────
--
-- A conversão foi feita por laço, e laço com efeito colateral é onde mora o erro
-- que ninguém vê. A pergunta certa não é "eu converti?", é "sobrou algum?".
--
-- A regra: para cada coluna que referencia o `id` de uma tabela de tenant, tem de
-- existir um FK naquela tabela cuja chave inclua **aquela coluna e `clinica_id`**.
-- Formulada assim, ela aceita o caso legítimo do FK extra sem tenant
-- (`movimento_lote_do_mesmo_material`) sem abrir exceção nominal para ele — e
-- continuaria cobrando se o FK de tenant daquela coluna desaparecesse.
DO $$
DECLARE v_soltos text[];
BEGIN
  SELECT coalesce(array_agg(x.descricao ORDER BY x.descricao), ARRAY[]::text[]) INTO v_soltos
  FROM (
    SELECT ch.relname || '.' || (SELECT a.attname FROM pg_attribute a
                                  WHERE a.attrelid = co.conrelid AND a.attnum = co.conkey[1])
             || ' -> ' || pa.relname AS descricao,
           co.conrelid, co.conkey[1] AS col
      FROM pg_constraint co
      JOIN pg_class ch ON ch.oid = co.conrelid
      JOIN pg_class pa ON pa.oid = co.confrelid
      JOIN pg_namespace n ON n.oid = ch.relnamespace
     WHERE co.contype = 'f' AND n.nspname = 'public'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = ch.oid
                    AND a.attname = 'clinica_id' AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = pa.oid
                    AND a.attname = 'clinica_id' AND NOT a.attisdropped)
  ) x
  WHERE NOT EXISTS (
    -- existe algum FK nesta tabela que amarre esta coluna JUNTO com clinica_id?
    SELECT 1
      FROM pg_constraint co2
     WHERE co2.contype = 'f'
       AND co2.conrelid = x.conrelid
       AND x.col = ANY (co2.conkey)
       AND (SELECT a.attnum FROM pg_attribute a
             WHERE a.attrelid = x.conrelid AND a.attname = 'clinica_id') = ANY (co2.conkey)
  );

  IF array_length(v_soltos, 1) > 0 THEN
    RAISE EXCEPTION
      'FKs entre tabelas de clínica sem clinica_id na chave: %. '
      'Sem o composto, uma linha pode apontar para pai de OUTRA clínica.',
      array_to_string(v_soltos, ', ');
  END IF;
END $$;
--> statement-breakpoint

-- ── 6. Row Level Security ───────────────────────────────────────────────────
--
-- ── `USING` **e** `WITH CHECK`, e por que só `USING` não serve ─────────────
-- `USING` filtra o que a política deixa VER (e portanto o que `UPDATE`/`DELETE`
-- conseguem alcançar). `WITH CHECK` valida o que a política deixa GRAVAR. Só com
-- `USING`, um `INSERT … (clinica_id) VALUES ('<uuid da clínica B>')` é aceito: a
-- linha entra na clínica alheia e, pela ironia da política, quem a inseriu não
-- consegue mais vê-la. Dado gravado no cliente errado, invisível para quem
-- gravou. É pior que erro.
--
-- ── `FORCE`, e o que ele NÃO faz ──────────────────────────────────────────
-- Sem `FORCE`, o DONO da tabela é isento mesmo com RLS ligada. Com `FORCE`, não
-- é. Ligo `FORCE` porque é a declaração correta da intenção — mas registro sem
-- rodeio: **hoje `FORCE` é inerte**, porque `facilident` é superusuário, e
-- superusuário ignora RLS de qualquer jeito. `FORCE` passa a valer no dia em que a
-- posse das tabelas estiver numa role sem superusuário.
--
-- ── Política sem cláusula `TO`, isto é, para PUBLIC ───────────────────────
-- A alternativa era `TO facilident_app`. Parece mais restritivo e falha pior: uma
-- role nova (relatório, BI, suporte) não casaria com nenhuma política e, com RLS
-- ligada, o padrão é **negar tudo em silêncio** — consulta devolvendo zero linhas,
-- que é exatamente o modo de falha que a 0022 rejeitou ao fazer
-- `app_clinica_id()` estourar. Sem `TO`, a role nova cai na mesma política, e sem
-- contexto ela recebe o erro que diz o que fazer. Alto, não silencioso.
DO $$
DECLARE r record; v_n int := 0;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND n.nspname = 'public'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                    AND a.attname = 'clinica_id' AND NOT a.attisdropped)
     ORDER BY 1
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolamento ON %I', r.relname);
    EXECUTE format(
      'CREATE POLICY tenant_isolamento ON %I FOR ALL '
      'USING (clinica_id = app_clinica_id()) '
      'WITH CHECK (clinica_id = app_clinica_id())', r.relname);
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'RLS + FORCE + política em % tabelas', v_n;
END $$;
--> statement-breakpoint

-- `clinica` é o tenant: a política é sobre `id`, não sobre `clinica_id`. Sem isto,
-- `configuracaoDaClinica()` devolveria a configuração de outro cliente — e o
-- cabeçalho do atestado sai com o CNPJ errado, que é falsidade documental por
-- descuido de software.
ALTER TABLE clinica ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE clinica FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolamento ON clinica;
--> statement-breakpoint
CREATE POLICY tenant_isolamento ON clinica FOR ALL
  USING (id = app_clinica_id()) WITH CHECK (id = app_clinica_id());
--> statement-breakpoint

-- `dente` fica SEM RLS, de propósito: 52 dentes da notação FDI, iguais no mundo
-- inteiro, sem coluna de tenant para filtrar. O que protege a tabela é o grant —
-- o app só lê. Ligar RLS com `USING (true)` seria teatro: uma política que não
-- decide nada, que alguém no futuro leria como "aqui tem isolamento".

-- ── 7. A trava que vale para as tabelas que ainda não existem ──────────────
--
-- `ALTER DEFAULT PRIVILEGES` (seção 1) faz tabela nova nascer com os grants do
-- app. Ela **não** faz tabela nova nascer com política de RLS. Sem uma trava, o
-- primeiro `CREATE TABLE` da Fase 18 entra acessível e sem filtro — e ninguém
-- percebe, porque a tela nova funciona perfeitamente para o único cliente que
-- houver no dia do deploy.
--
-- A função existe (em vez de um bloco solto) para ser chamável de novo: pela
-- próxima migration, pelo `db:verificar` e pelo CI. Uma invariante que só é
-- conferida uma vez, no dia em que foi escrita, não é invariante.
CREATE OR REPLACE FUNCTION exigir_isolamento_estrutural() RETURNS void AS $$
DECLARE
  v_erros text[] := ARRAY[]::text[];
  v_isentas text[] := ARRAY[
    'clinica',                -- é o tenant; tem política própria, por `id`
    'dente',                  -- 52 dentes FDI: referência global, sem tenant
    '__drizzle_migrations'    -- controle do migrador
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
END $$ LANGUAGE plpgsql STABLE;
--> statement-breakpoint

COMMENT ON FUNCTION exigir_isolamento_estrutural() IS
  'Estoura se alguma tabela de dados estiver sem clinica_id, sem RLS, sem FORCE ou '
  'sem política com app_clinica_id(). Chame na próxima migration e no db:verificar — '
  'invariante conferida uma vez só não é invariante.';
--> statement-breakpoint

SELECT exigir_isolamento_estrutural();
--> statement-breakpoint

-- ── 8. O que falta para isto sair do papel ─────────────────────────────────
--
-- Esta migration NÃO troca o `DATABASE_URL` do app, e a razão é concreta: com RLS
-- em `clinica`, o app não conseguiria nem conectar.
--
-- `lib/db/index.ts` define o contexto ao pegar conexão do pool
-- (`PoolComContexto`). Quando não há sessão — tela de login, `authorize()` do
-- Auth.js, webhook do WhatsApp — ele cai num andaime:
--
--     select set_config('app.clinica_id', (select id::text from clinica), false)
--
-- Ler `clinica` agora exige contexto, que é exatamente o que essa consulta está
-- tentando descobrir. Como `facilident_app`, isso estoura na primeira conexão.
-- Verificado: `psql -U facilident_app -c 'select count(*) from paciente'` devolve
-- o erro de contexto; com `set_config` explícito, devolve as linhas da clínica.
--
-- A ordem correta dos passos que faltam:
--
--   1. `lib/auth/config.ts` resolve o tenant por `clinica_do_login_de_staff(email)`
--      (seção 2) ANTES de procurar o usuário, e roda a busca dentro do envelope;
--   2. `lib/portal/sessao.ts` faz o mesmo com `clinica_da_sessao_do_portal(hash)`;
--   3. o webhook do WhatsApp resolve a clínica pelo `phone_number_id` do payload —
--      **este é o único caminho que ainda não tem função pronta aqui**, porque
--      depende de a clínica passar a guardar o próprio `phone_number_id`;
--   4. o andaime de `definirContexto()` sai, e ficar sem contexto passa a ser erro;
--   5. `./docker/credencial-app.sh` dá LOGIN à role;
--   6. o `DATABASE_URL` de `app`, `app-prod` e `despachante` aponta para
--      `facilident_app`. O de `migrate`, dos seeds, do `db:verificar` e dos
--      scripts de backup **continua no dono** — restauração e verificação de
--      invariante precisam ver o banco inteiro.
--
-- Até o passo 6, o que protege o app é disciplina. O que já é estrutural desde
-- agora, independente de role: o FK composto, que vale até para superusuário.
--
-- Prova: `docker compose exec -T db psql -U facilident -d facilident -q -f - \
--          < docker/verificar-rls.sql`  (25 casos, com contraprova em cada lado)
