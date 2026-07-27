-- ============================================================================
-- Prova que a trava de suspensão da `drizzle/0027` faz o que promete:
-- **bloqueia escrita, e NUNCA leitura nem exportação de prontuário.**
--
--   docker compose exec -T db psql -U facilident -d facilident -q -f - \
--     < docker/verificar-assinatura.sql
--
-- Roda numa transação e faz ROLLBACK: não deixa clínica de teste no banco.
--
-- ── A regra que este arquivo segue ─────────────────────────────────────────
-- **Caso que passa pelo motivo errado é pior que caso nenhum** — já aconteceu seis
-- vezes neste projeto, a última em `admin:verificar`, onde "sobreposição de preço
-- recusada" dava verde porque *nenhum* preço conseguia ser cadastrado.
--
-- Duas consequências no desenho daqui:
--
-- 1. Todo caso de "bloqueou" tem contraprova de "passa quando reativada". Sem ela,
--    um erro de fixture (coluna errada, FK faltando) produz o mesmo verde.
-- 2. **`42501` não basta.** Ele significa "insufficient_privilege", e desde a 0023
--    isso pode ser política de RLS **ou** `GRANT` faltando. Um caso que quisesse
--    provar a trava de assinatura e passasse por falta de grant estaria provando
--    outra coisa. Por isso os casos de trava cobram o TEXTO da mensagem.
-- ============================================================================

\set ON_ERROR_STOP on
\timing off

BEGIN;

CREATE TEMP TABLE resultado (
  ordem    serial,
  caso     text,
  esperado text,
  obtido   text,
  passou   boolean
);

GRANT ALL ON resultado TO facilident_app;
GRANT USAGE, SELECT ON SEQUENCE resultado_ordem_seq TO facilident_app;

CREATE FUNCTION espera_ok(caso text, cmd text) RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE cmd;
    INSERT INTO resultado (caso, esperado, obtido, passou) VALUES (caso, 'aceitar', 'aceitou', true);
  EXCEPTION WHEN others THEN
    INSERT INTO resultado (caso, esperado, obtido, passou)
      VALUES (caso, 'aceitar', sqlstate || ': ' || left(sqlerrm, 58), false);
  END;
END $$ LANGUAGE plpgsql;

/* Cobra o TEXTO, não só o código. Ver o cabeçalho: 42501 virou ambíguo. */
CREATE FUNCTION espera_erro_texto(caso text, cmd text, trecho text) RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE cmd;
    INSERT INTO resultado (caso, esperado, obtido, passou)
      VALUES (caso, 'rejeitar (' || trecho || ')', 'ACEITOU — TRAVA FUROU', false);
  EXCEPTION WHEN others THEN
    INSERT INTO resultado (caso, esperado, obtido, passou)
      VALUES (caso, 'rejeitar (' || trecho || ')',
              sqlstate || ': ' || left(sqlerrm, 46),
              position(trecho in sqlerrm) > 0);
  END;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION espera_contagem(caso text, cmd text, esperado bigint) RETURNS void AS $$
DECLARE v bigint;
BEGIN
  BEGIN
    EXECUTE cmd INTO v;
    INSERT INTO resultado (caso, esperado, obtido, passou)
      VALUES (caso, esperado::text, coalesce(v::text, 'null'), v = esperado);
  EXCEPTION WHEN others THEN
    INSERT INTO resultado (caso, esperado, obtido, passou)
      VALUES (caso, esperado::text, sqlstate || ': ' || left(sqlerrm, 50), false);
  END;
END $$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION espera_ok(text, text)                TO facilident_app;
GRANT EXECUTE ON FUNCTION espera_erro_texto(text, text, text)  TO facilident_app;
GRANT EXECUTE ON FUNCTION espera_contagem(text, text, bigint)  TO facilident_app;

-- ── Cenário ────────────────────────────────────────────────────────────────
-- Clínica de teste com assinatura ATIVA, montada como `facilident` (superusuário,
-- que ignora RLS — é o único jeito de montar o cenário em uma transação).
INSERT INTO clinica (id, razao_social, cnpj)
VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Clínica do teste de assinatura', NULL);

INSERT INTO assinatura (id, clinica_id, plano_id, situacao)
VALUES ('cccccccc-0000-0000-0000-00000000000a',
        'cccccccc-cccc-cccc-cccc-cccccccccccc',
        (SELECT id FROM plano_assinatura WHERE codigo = 'profissional'),
        'ativa');

INSERT INTO paciente (id, clinica_id, nome, data_nascimento)
VALUES ('cccccccc-0000-0000-0000-0000000000c1', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        'Paciente da clínica de teste', '1990-01-01');

INSERT INTO usuario (id, clinica_id, nome, email, senha_hash, perfil, mfa_ativo)
VALUES ('cccccccc-0000-0000-0000-0000000000c2', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        'Admin do teste', 'admin-teste-assinatura@local', 'x', 'admin', true);

-- A conta do PORTAL é outro realm: `paciente_sessao` pende de `paciente_conta`, não
-- de `paciente` (CLAUDE.md, decisão 2 — nenhuma FK entre os realms).
-- `senha_definida_em` junto com o hash: o CHECK `paciente_conta_senha_tem_carimbo`
-- exige que os dois sejam nulos ou os dois preenchidos — conta com senha e sem
-- carimbo seria conta que ninguém sabe desde quando tem senha.
INSERT INTO paciente_conta (id, clinica_id, paciente_id, email, senha_hash, senha_definida_em)
VALUES ('cccccccc-0000-0000-0000-0000000000c3', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        'cccccccc-0000-0000-0000-0000000000c1', 'paciente-teste-assinatura@local', 'x', now());

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 1 — assinatura ATIVA: a clínica escreve normalmente
-- ════════════════════════════════════════════════════════════════════════════
SET ROLE facilident_app;
SELECT set_config('app.clinica_id', 'cccccccc-cccc-cccc-cccc-cccccccccccc', true);

SELECT espera_ok('ativa: cadastra paciente',
  $$INSERT INTO paciente (nome, data_nascimento) VALUES ('Novo, assinatura ativa', '1985-05-05')$$);

SELECT espera_ok('ativa: altera paciente',
  $$UPDATE paciente SET nome = 'Alterado com assinatura ativa'
     WHERE id = 'cccccccc-0000-0000-0000-0000000000c1'$$);

RESET ROLE;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — SUSPENSA: escrita trava, leitura não
-- ════════════════════════════════════════════════════════════════════════════
UPDATE assinatura SET situacao = 'suspensa', motivo_situacao = 'teste automatizado'
 WHERE clinica_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

SET ROLE facilident_app;

SELECT espera_erro_texto('suspensa: NÃO cadastra paciente',
  $$INSERT INTO paciente (nome, data_nascimento) VALUES ('Não devia entrar', '1985-05-05')$$,
  'row-level security');

SELECT espera_erro_texto('suspensa: NÃO altera paciente',
  $$UPDATE paciente SET nome = 'não devia mudar'
     WHERE id = 'cccccccc-0000-0000-0000-0000000000c1'$$,
  'row-level security');

SELECT espera_erro_texto('suspensa: NÃO cadastra usuário novo',
  $$INSERT INTO usuario (nome, email, senha_hash, perfil)
     VALUES ('Staff novo', 'staff-novo-teste@local', 'x', 'recepcao')$$,
  'row-level security');

-- ── E agora o que a suspensão NÃO pode impedir ─────────────────────────────
-- Cada um destes, se travasse, quebraria a leitura — que é a promessa do arquivo.

SELECT espera_contagem('suspensa: continua LENDO o prontuário',
  $$SELECT count(*) FROM paciente$$, 2);

-- `audit_log` é a dependência escondida da leitura: o app GRAVA nele ao LER
-- prontuário (LGPD). Se a trava o alcançasse, "leitura livre" seria mentira.
SELECT espera_ok('suspensa: audit_log ainda aceita registro de LEITURA',
  $$INSERT INTO audit_log (ator_tipo, acao, entidade, entidade_id)
     VALUES ('staff', 'leitura', 'paciente', 'cccccccc-0000-0000-0000-0000000000c1')$$);

-- Login do staff: `ultimo_login_em`. Sem este UPDATE ninguém entra, nem para ler.
SELECT espera_ok('suspensa: staff ainda consegue entrar (ultimo_login_em)',
  $$UPDATE usuario SET ultimo_login_em = now()
     WHERE id = 'cccccccc-0000-0000-0000-0000000000c2'$$);

-- Sessão do portal: entrar e, sobretudo, SAIR. Travar o logout seria regressão de
-- segurança — sessão que não revoga é sessão viva com o cookie apagado.
SELECT espera_ok('suspensa: portal ainda abre e revoga sessão',
  $$INSERT INTO paciente_sessao (conta_id, token_hash, expira_em)
     VALUES ('cccccccc-0000-0000-0000-0000000000c3', 'hash-de-teste-assinatura', now() + interval '1 hour')$$);

-- ── A prova ESTRUTURAL de "suspensão nunca bloqueia leitura" ───────────────
-- Os casos acima provam uma tabela cada. Este prova TODAS de uma vez, e continua
-- valendo para as tabelas que ainda não existem: nenhuma política RESTRITIVA pode
-- alcançar SELECT.
--
-- `polcmd`: 'r' = SELECT, 'a' = INSERT, 'w' = UPDATE, 'd' = DELETE, '*' = ALL.
-- Uma restritiva com 'r' ou '*' passaria a filtrar leitura — e uma `FOR ALL`
-- restritiva é o jeito mais fácil de fazer isso sem perceber, porque o autor estaria
-- pensando em escrita.
SELECT espera_contagem(
  'ESTRUTURAL: nenhuma política restritiva alcança SELECT',
  $$SELECT count(*) FROM pg_policy WHERE NOT polpermissive AND polcmd IN ('r', '*')$$, 0);

-- E a exportação por clínica lê estas tabelas. Se a leitura passa, ela passa.
-- Contagem literal aqui foi um erro meu: eu escrevi "5" e o certo era 4, e um
-- número mágico que depende de quantos casos rodaram antes quebra a cada caso novo
-- — e quem o consertar vai ajustar o número, não investigar. A asserção é sobre o
-- que importa: as três tabelas são legíveis e têm conteúdo.
SELECT espera_contagem('suspensa: prontuário continua exportável (as tabelas do dado são legíveis)',
  $$SELECT count(*) FROM (SELECT 1 WHERE (SELECT count(*) FROM paciente)   > 0
                                    AND (SELECT count(*) FROM usuario)     > 0
                                    AND (SELECT count(*) FROM audit_log)   > 0) t$$, 1);

-- ── A clínica não se reativa sozinha ───────────────────────────────────────
SELECT espera_erro_texto('suspensa: NÃO consegue mexer na própria assinatura',
  $$UPDATE assinatura SET situacao = 'ativa' WHERE clinica_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'$$,
  'permission denied');

-- Mas LÊ, para a tela poder dizer "sua assinatura está suspensa".
SELECT espera_contagem('suspensa: LÊ a própria assinatura (a tela precisa avisar)',
  $$SELECT count(*) FROM assinatura$$, 1);

RESET ROLE;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 3 — CONTRAPROVA: reativada, a MESMA escrita passa
--
-- Sem esta parte, os três casos de trava acima poderiam estar verdes por qualquer
-- outro motivo (FK, NOT NULL, coluna errada) e eu teria assinado "a trava
-- funciona" sem ter medido a trava.
-- ════════════════════════════════════════════════════════════════════════════
UPDATE assinatura SET situacao = 'ativa', motivo_situacao = NULL
 WHERE clinica_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

SET ROLE facilident_app;

SELECT espera_ok('CONTRAPROVA reativada: a mesma inserção passa',
  $$INSERT INTO paciente (nome, data_nascimento) VALUES ('Não devia entrar', '1985-05-05')$$);

SELECT espera_ok('CONTRAPROVA reativada: a mesma alteração passa',
  $$UPDATE paciente SET nome = 'não devia mudar'
     WHERE id = 'cccccccc-0000-0000-0000-0000000000c1'$$);

SELECT espera_ok('CONTRAPROVA reativada: o mesmo usuário novo passa',
  $$INSERT INTO usuario (nome, email, senha_hash, perfil)
     VALUES ('Staff novo', 'staff-novo-teste@local', 'x', 'recepcao')$$);

RESET ROLE;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 4 — CANCELADA trava como suspensa
-- ════════════════════════════════════════════════════════════════════════════
UPDATE assinatura SET situacao = 'cancelada', motivo_situacao = 'fim de contrato (teste)'
 WHERE clinica_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

SET ROLE facilident_app;
SELECT espera_erro_texto('cancelada: NÃO cadastra paciente',
  $$INSERT INTO paciente (nome, data_nascimento) VALUES ('Nem cancelada', '1985-05-05')$$,
  'row-level security');
SELECT espera_contagem('cancelada: prontuário AINDA é legível — guarda de 20 anos (CFO)',
  $$SELECT count(*) FROM (SELECT 1 WHERE (SELECT count(*) FROM paciente) > 0) t$$, 1);
RESET ROLE;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 5 — o controle compensatório do "sem assinatura destrava"
--
-- `assinatura_permite_escrita()` devolve `true` quando não há assinatura, de
-- propósito: congelar uma clínica por causa de erro de contabilidade nossa custa o
-- atendimento do paciente que está na cadeira. O preço dessa escolha é que
-- "esqueci de criar a assinatura" deixa de ser barrado pelo banco — então tem de
-- ser barrado AQUI.
-- ════════════════════════════════════════════════════════════════════════════
SELECT espera_contagem('toda clínica tem assinatura',
  $$SELECT count(*) FROM clinica c
     WHERE NOT EXISTS (SELECT 1 FROM assinatura a WHERE a.clinica_id = c.id)$$, 0);

/* CONTRAPROVA do caso acima: com uma clínica sem assinatura, a checagem tem de
   ACHAR. Sem isto, o caso passaria num banco onde a consulta estivesse errada.

   ── Por que não é `SAVEPOINT` + `ROLLBACK TO SAVEPOINT` ─────────────────────
   Porque foi o que eu escrevi primeiro, e o rollback desfez **o próprio registro
   do caso**: o relatório saiu pulando do caso 19 para o 21. É a mesma pegadinha
   que já apareceu nesta fase, no `verificar-rls.sql`.

   O jeito que funciona: subtransação `BEGIN … EXCEPTION`, que desfaz o INSERT da
   clínica fictícia, e o registro em `resultado` acontece DEPOIS dela. Variável de
   plpgsql não é transacional — `v` atravessa o rollback com o valor medido. */
CREATE FUNCTION contraprova_sem_assinatura() RETURNS void AS $$
DECLARE v bigint;
BEGIN
  BEGIN
    INSERT INTO clinica (id, razao_social)
    VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Clínica sem assinatura');
    SELECT count(*) INTO v FROM clinica c
     WHERE NOT EXISTS (SELECT 1 FROM assinatura a WHERE a.clinica_id = c.id);
    RAISE EXCEPTION 'desfazer a clínica fictícia';
  EXCEPTION WHEN others THEN
    NULL;
  END;
  INSERT INTO resultado (caso, esperado, obtido, passou)
    VALUES ('CONTRAPROVA: a checagem ACHA a clínica sem assinatura',
            '1', coalesce(v::text, 'null'), v = 1);
END $$ LANGUAGE plpgsql;

SELECT contraprova_sem_assinatura();

-- E a função destrava mesmo sem assinatura — o comportamento declarado, medido.
SELECT espera_contagem('sem assinatura: a função destrava (escolha declarada, não descuido)',
  $$SELECT count(*) FROM (SELECT assinatura_permite_escrita('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') AS r) t
     WHERE r$$, 1);

-- ── Relatório ──────────────────────────────────────────────────────────────
\echo ''
SELECT lpad(ordem::text, 2) || '. ' || CASE WHEN passou THEN '✓ ' ELSE '✗ ' END || caso
       || CASE WHEN passou THEN '' ELSE '   [esperado ' || esperado || ', obtido ' || obtido || ']' END
       AS "trava de assinatura"
  FROM resultado ORDER BY ordem;

DO $$
DECLARE v int; t int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT passou), count(*) INTO v, t FROM resultado;
  IF v > 0 THEN
    RAISE EXCEPTION '% de % caso(s) reprovaram — a trava de suspensão não está como escrito.', v, t;
  END IF;
  RAISE NOTICE 'Trava de assinatura: % casos, todos passaram.', t;
END $$;

ROLLBACK;
