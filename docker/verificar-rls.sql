-- ============================================================================
-- Prova que o isolamento entre clínicas da `drizzle/0023` funciona de verdade.
--
--   docker compose exec -T db psql -U facilident -d facilident -q -f - \
--     < docker/verificar-rls.sql
--
-- Roda numa transação e faz ROLLBACK: não deixa clínica de teste no banco. Isso
-- não é só higiene — com duas clínicas visíveis, o andaime de conexão de
-- `lib/db/index.ts` derruba o app de propósito.
--
-- ── Por que este arquivo existe separado da migration ───────────────────────
-- Invariante conferida uma vez, no dia em que foi escrita, não é invariante. A
-- migration prova no deploy; este arquivo prova quando alguém quiser, e é onde a
-- Fase 18 vai acrescentar caso quando criar tabela nova.
--
-- ── A regra que este arquivo segue ─────────────────────────────────────────
-- **Caso que passa pelo motivo errado é pior que caso nenhum** — já aconteceu três
-- vezes neste projeto. Todo caso de "não vê" tem contraprova de "vê quando
-- deveria": sem ela, uma tabela vazia produz um relatório todo verde.
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

/* ── Por que estas funções NÃO são SECURITY DEFINER ─────────────────────────
   Elas gravam em `resultado`, que pertence a `facilident`, e vão ser chamadas
   depois de `SET ROLE facilident_app`. A saída fácil seria marcá-las
   `SECURITY DEFINER` para o INSERT funcionar.

   Isso destruiria o arquivo inteiro: o `EXECUTE` do comando testado passaria a
   rodar como `facilident` — superusuário, que **ignora RLS** — e todo caso de
   isolamento passaria sem isolamento nenhum. Verde absoluto, prova zero.

   O caminho certo é o chato: `GRANT` na tabela temporária, e o corpo da função
   continua rodando como quem chamou. */
GRANT ALL ON resultado TO facilident_app;
GRANT USAGE, SELECT ON SEQUENCE resultado_ordem_seq TO facilident_app;

/* ── `sqlstate_esperado` não é preciosismo, é o que impede o pior bug de teste ──
   A primeira versão deste arquivo tinha o caso "o app não pode escrever na
   referência global" com `UPDATE dente SET nome = 'x' WHERE numero = 11`. Ele
   passou — com `42703: column "numero" does not exist`. A coluna se chama `fdi`.
   Ou seja: o caso deu verde provando apenas que eu errei o nome da coluna, e o
   privilégio nunca foi exercido.

   Errar o nome de uma coluna num teste de permissão é normal. Um teste que dá
   verde por causa disso é o problema — e este projeto já produziu relatório verde
   provando invariante nenhuma três vezes por esta mesma razão. Cobrar o SQLSTATE
   fecha a porta: "rejeitou" deixa de ser suficiente, tem de rejeitar PELO MOTIVO. */
CREATE FUNCTION espera_erro(caso text, cmd text, sqlstate_esperado text DEFAULT NULL)
RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE cmd;
    INSERT INTO resultado (caso, esperado, obtido, passou)
      VALUES (caso, coalesce('rejeitar ' || sqlstate_esperado, 'rejeitar'),
              'ACEITOU — VAZOU', false);
  EXCEPTION WHEN others THEN
    INSERT INTO resultado (caso, esperado, obtido, passou)
      VALUES (caso,
              coalesce('rejeitar ' || sqlstate_esperado, 'rejeitar'),
              sqlstate || ': ' || left(sqlerrm, 52),
              sqlstate_esperado IS NULL OR sqlstate = sqlstate_esperado);
  END;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION espera_ok(caso text, cmd text) RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE cmd;
    INSERT INTO resultado (caso, esperado, obtido, passou)
      VALUES (caso, 'aceitar', 'aceitou', true);
  EXCEPTION WHEN others THEN
    INSERT INTO resultado (caso, esperado, obtido, passou)
      VALUES (caso, 'aceitar', sqlstate || ': ' || left(sqlerrm, 58), false);
  END;
END $$ LANGUAGE plpgsql;

/* Para RLS, "não vê" e "não altera" não são erro: são ZERO LINHAS, em silêncio.
   Por isso a maior parte das provas aqui é de contagem, não de exceção. */
CREATE FUNCTION espera_contagem(caso text, cmd text, esperado bigint) RETURNS void AS $$
DECLARE v bigint;
BEGIN
  BEGIN
    EXECUTE cmd INTO v;
    INSERT INTO resultado (caso, esperado, obtido, passou)
      VALUES (caso, esperado::text || ' linha(s)', coalesce(v::text, 'null') || ' linha(s)', v = esperado);
  EXCEPTION WHEN others THEN
    INSERT INTO resultado (caso, esperado, obtido, passou)
      VALUES (caso, esperado::text || ' linha(s)', sqlstate || ': ' || left(sqlerrm, 50), false);
  END;
END $$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION espera_erro(text, text, text)      TO facilident_app;
GRANT EXECUTE ON FUNCTION espera_ok(text, text)              TO facilident_app;
GRANT EXECUTE ON FUNCTION espera_contagem(text, text, bigint) TO facilident_app;

-- ── Cenário: duas clínicas, um paciente em cada ─────────────────────────────
-- Montado como `facilident` (superusuário), que ignora RLS — é o único jeito de
-- criar o dado das duas clínicas na mesma transação.
--
-- ── Por que A é CRIADA aqui, e não emprestada do banco ─────────────────────
-- Aqui estava `SELECT id FROM clinica ORDER BY id LIMIT 1` — o mesmo `limit 1` sem
-- critério que a Fase 17 existiu para eliminar, dentro do arquivo que verifica a Fase
-- 17. Ele funcionou até o dia em que o banco acumulou clínicas de teste: o
-- `clinica:verificar` deixa uma com assinatura **cancelada** a cada rodada (de
-- propósito — clínica não se apaga, `ON DELETE RESTRICT`), e uma delas passou a
-- ordenar primeiro.
--
-- O sintoma foi **5 casos reprovando com a política de SUSPENSÃO**, não com a de
-- isolamento: a clínica emprestada estava cancelada, então até a escrita na própria
-- clínica era recusada. O arquivo passou a acusar "o isolamento entre clínicas está
-- furado" por causa de faturamento.
--
-- Falhar pelo motivo errado é tão ruim quanto passar pelo motivo errado, e talvez
-- pior: verde falso engana uma vez, vermelho falso ensina a ignorar o vermelho.
--
-- Com as duas clínicas criadas aqui, com uuid fixo e sem assinatura, esta verificação
-- mede isolamento e nada mais. (Sem assinatura a escrita é liberada por decisão da
-- `drizzle/0027` — ver `docker/verificar-assinatura.sql`, que é quem mede aquilo.)
INSERT INTO clinica (id, razao_social)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Clínica A (teste de isolamento)');

SELECT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AS clinica_a \gset

INSERT INTO clinica (id, razao_social)
VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Clínica B (teste de isolamento)');

INSERT INTO paciente (id, clinica_id, nome, data_nascimento)
VALUES ('aaaaaaaa-0000-0000-0000-00000000000a', :'clinica_a', 'Paciente da A', '1990-01-01'),
       ('bbbbbbbb-0000-0000-0000-00000000000b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        'Paciente da B', '1990-01-01');

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 1 — a role de aplicação, com contexto da clínica A
-- ════════════════════════════════════════════════════════════════════════════
SET ROLE facilident_app;
SELECT set_config('app.clinica_id', :'clinica_a', true);

SELECT espera_contagem(
  'A não vê o paciente da B',
  $$SELECT count(*) FROM paciente WHERE id = 'bbbbbbbb-0000-0000-0000-00000000000b'$$, 0);

SELECT espera_contagem(
  'A vê o próprio paciente (contraprova: a tabela não está vazia)',
  $$SELECT count(*) FROM paciente WHERE id = 'aaaaaaaa-0000-0000-0000-00000000000a'$$, 1);

SELECT espera_contagem(
  'A não vê NENHUMA linha de outra clínica em paciente',
  $$SELECT count(*) FROM paciente WHERE clinica_id <> current_setting('app.clinica_id')::uuid$$, 0);

/* UPDATE e DELETE não dão erro sob RLS: eles simplesmente não encontram a linha.
   A prova é o número de linhas afetadas, capturado por `RETURNING`. */
SELECT espera_contagem(
  'A não consegue ALTERAR o paciente da B',
  $$WITH t AS (UPDATE paciente SET nome = 'invadido'
                WHERE id = 'bbbbbbbb-0000-0000-0000-00000000000b' RETURNING 1)
    SELECT count(*) FROM t$$, 0);

SELECT espera_contagem(
  'A não consegue APAGAR o paciente da B',
  $$WITH t AS (DELETE FROM paciente
                WHERE id = 'bbbbbbbb-0000-0000-0000-00000000000b' RETURNING 1)
    SELECT count(*) FROM t$$, 0);

SELECT espera_contagem(
  'mas A ALTERA o próprio (contraprova: o UPDATE acima não falhou por outro motivo)',
  $$WITH t AS (UPDATE paciente SET nome = 'Paciente da A (editado)'
                WHERE id = 'aaaaaaaa-0000-0000-0000-00000000000a' RETURNING 1)
    SELECT count(*) FROM t$$, 1);

-- ── WITH CHECK: o que a política deixa GRAVAR ──────────────────────────────
-- Sem `WITH CHECK`, este INSERT é ACEITO: a linha entra na clínica B e fica
-- invisível para quem a inseriu. Dado no cliente errado, sem erro. É por isso que
-- `USING` sozinho não serve.
SELECT espera_erro(
  'A não consegue INSERIR na clínica B (WITH CHECK)',
  $$INSERT INTO paciente (clinica_id, nome, data_nascimento)
    VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'plantado', '1990-01-01')$$,
  -- 42501 = insufficient_privilege, que é como o Postgres reporta violação de RLS.
  '42501');

SELECT espera_ok(
  'A insere na própria clínica sem mencionar clinica_id (DEFAULT app_clinica_id())',
  $$INSERT INTO paciente (nome, data_nascimento) VALUES ('nasceu em A', '1990-01-01')$$);

SELECT espera_contagem(
  'e a linha nasceu na clínica A, não em outra',
  $$SELECT count(*) FROM paciente WHERE nome = 'nasceu em A'
     AND clinica_id = current_setting('app.clinica_id')::uuid$$, 1);

-- ── FK composto: vale mesmo com o contexto "certo" ─────────────────────────
-- O ataque que a RLS sozinha não pega: a clínica A grava na PRÓPRIA clínica
-- (`clinica_id` = A, então `WITH CHECK` aprova) mas aponta para um paciente da B.
-- Sem o FK composto isso entra, e o alerta clínico de um paciente passa a existir
-- no prontuário de outra clínica.
SELECT espera_erro(
  'A não pendura alerta clínico no paciente da B (FK composto)',
  $$INSERT INTO alerta_clinico (paciente_id, tipo, descricao)
    VALUES ('bbbbbbbb-0000-0000-0000-00000000000b', 'alergia', 'plantado')$$,
  -- 23503 = foreign_key_violation. Se este caso passar com 42501, quem barrou foi
  -- a RLS e o FK composto continua sem prova.
  '23503');

SELECT espera_ok(
  'mas pendura no próprio paciente (contraprova)',
  $$INSERT INTO alerta_clinico (paciente_id, tipo, descricao)
    VALUES ('aaaaaaaa-0000-0000-0000-00000000000a', 'alergia', 'legítimo')$$);

-- ── Sem contexto, nada funciona — e o erro é ALTO ──────────────────────────
SELECT set_config('app.clinica_id', '', true);

SELECT espera_erro(
  'sem contexto, SELECT em paciente estoura (não devolve vazio)',
  $$SELECT count(*) FROM paciente$$, '42501');

SELECT espera_erro(
  'sem contexto, INSERT em paciente estoura',
  $$INSERT INTO paciente (nome, data_nascimento) VALUES ('sem contexto', '1990-01-01')$$,
  '42501');

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — contraprova pelo outro lado: com o contexto de B, as linhas de B
-- aparecem. Sem esta parte, tudo acima seria compatível com "a política nega
-- tudo para todos", que não é isolamento, é indisponibilidade.
-- ════════════════════════════════════════════════════════════════════════════
SELECT set_config('app.clinica_id', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true);

SELECT espera_contagem(
  'B vê o próprio paciente',
  $$SELECT count(*) FROM paciente WHERE id = 'bbbbbbbb-0000-0000-0000-00000000000b'$$, 1);

SELECT espera_contagem(
  'B não vê o paciente da A',
  $$SELECT count(*) FROM paciente WHERE id = 'aaaaaaaa-0000-0000-0000-00000000000a'$$, 0);

SELECT espera_contagem(
  'B não vê a configuração da clínica A (política em clinica)',
  format($$SELECT count(*) FROM clinica WHERE id = %L$$, :'clinica_a'), 0);

SELECT espera_contagem(
  'B vê a própria clínica (contraprova)',
  $$SELECT count(*) FROM clinica$$, 1);

SELECT espera_contagem(
  'B não vê o alerta clínico criado por A',
  $$SELECT count(*) FROM alerta_clinico WHERE descricao = 'legítimo'$$, 0);

-- Referência global continua legível pelas duas: sem isso o odontograma não abre.
SELECT espera_contagem(
  'os 52 dentes FDI continuam visíveis (referência global, sem RLS)',
  $$SELECT count(*) FROM dente$$, 52);

SELECT espera_erro(
  'e o app não pode escrever na referência global',
  $$UPDATE dente SET nome = 'x' WHERE fdi = 11$$, '42501');

RESET ROLE;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 3 — o que NÃO está protegido, dito em voz alta
--
-- Superusuário ignora RLS, com ou sem FORCE. `facilident` é superusuário na
-- imagem oficial do Postgres. Este caso existe para o relatório não mentir: ele
-- ESPERA ver a linha da outra clínica, e se um dia ele começar a falhar, é porque
-- a posse das tabelas saiu do superusuário — e aí o FORCE passou a valer.
--
-- ── O que mudou desde que este caso foi escrito ────────────────────────────
-- **O app não usa mais esta credencial.** `app`, `app-prod` e `despachante`
-- conectam como `facilident_app` (não-dona, sem BYPASSRLS), e o isolamento por
-- HTTP está provado em `npm run tenant:seguranca` — inclusive com a contraprova
-- que desliga a política e mostra o prontuário da outra clínica ABRINDO.
--
-- Então este caso deixou de descrever o app e passou a descrever a OPERAÇÃO:
-- migration, seed, `db:verificar` e backup seguem no dono, de propósito, e para
-- eles a política continua sem valer. É por isso que a credencial do dono não
-- deve estar no ambiente do serviço web — a RLS não protege quem a tem.
-- ════════════════════════════════════════════════════════════════════════════
SELECT set_config('app.clinica_id', :'clinica_a', true);

SELECT espera_contagem(
  '[esperado] superusuário ATRAVESSA a política — é por isso que o app precisa de facilident_app',
  $$SELECT count(*) FROM paciente WHERE id = 'bbbbbbbb-0000-0000-0000-00000000000b'$$, 1);

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 4 — a asserção estrutural, e a prova de que ela REPROVA
-- ════════════════════════════════════════════════════════════════════════════
SELECT espera_ok(
  'exigir_isolamento_estrutural() passa no estado atual',
  $$SELECT exigir_isolamento_estrutural()$$);

/* ── Contraprova da asserção, e a armadilha que ela tinha ───────────────────
   Sem contraprova, `exigir_isolamento_estrutural()` poderia ser uma função que
   devolve void e nunca reclama de nada — e o caso acima seria decoração.

   A primeira versão usava `SAVEPOINT` + `ROLLBACK TO SAVEPOINT` em volta do
   `ALTER TABLE … DISABLE ROW LEVEL SECURITY`. Funcionou e **apagou o próprio
   resultado**: o rollback do savepoint desfez também o INSERT em `resultado`, e o
   relatório saiu pulando do caso 22 para o 24 — a contraprova rodou e ninguém
   soube o que ela disse. Relatório com buraco é relatório que mente por omissão.

   Aqui o `BEGIN … EXCEPTION` do PL/pgSQL faz o serviço: ele abre uma subtransação
   implícita, então o `ALTER TABLE` é desfeito quando a exceção sobe — e o INSERT
   do resultado acontece FORA dela, depois, e sobrevive. */
DO $$
DECLARE v_reprovou boolean := false;
BEGIN
  BEGIN
    ALTER TABLE paciente DISABLE ROW LEVEL SECURITY;
    PERFORM exigir_isolamento_estrutural();
  EXCEPTION WHEN others THEN
    v_reprovou := true;   -- e o ALTER TABLE volta atrás junto com a exceção
  END;

  -- Se a função NÃO reclamou, o ALTER continua aplicado: religar aqui é
  -- obrigatório, senão o arquivo deixa a tabela sem RLS até o ROLLBACK final e
  -- todos os casos seguintes passam por motivo errado.
  IF NOT v_reprovou THEN
    ALTER TABLE paciente ENABLE ROW LEVEL SECURITY;
  END IF;

  INSERT INTO resultado (caso, esperado, obtido, passou)
  VALUES ('e REPROVA quando alguém desliga a RLS de uma tabela (contraprova)',
          'reclamar',
          CASE WHEN v_reprovou THEN 'reclamou' ELSE 'FICOU CALADA — a asserção não vale nada' END,
          v_reprovou);
END $$;

/* Mesma técnica para a outra metade da asserção: o FK composto. O risco real aqui
   não é alguém desligar RLS de propósito — é rodar `db:generate` e aceitar a
   migration que o drizzle-kit oferece, que reverte o FK para uma coluna porque é
   isso que o schema TypeScript declara. */
DO $$
DECLARE v_reprovou boolean := false;
BEGIN
  BEGIN
    ALTER TABLE alerta_clinico DROP CONSTRAINT alerta_clinico_paciente_id_paciente_id_fk;
    ALTER TABLE alerta_clinico ADD CONSTRAINT alerta_clinico_paciente_id_paciente_id_fk
      FOREIGN KEY (paciente_id) REFERENCES paciente(id) ON DELETE CASCADE;
    PERFORM exigir_isolamento_estrutural();
  EXCEPTION WHEN others THEN
    v_reprovou := true;
  END;

  INSERT INTO resultado (caso, esperado, obtido, passou)
  VALUES ('e REPROVA se um FK composto voltar a ser de uma coluna (db:generate)',
          'reclamar',
          CASE WHEN v_reprovou THEN 'reclamou' ELSE 'FICOU CALADA — a reversão passaria' END,
          v_reprovou);
END $$;

SELECT espera_ok(
  'estado restaurado: a asserção volta a passar',
  $$SELECT exigir_isolamento_estrutural()$$);

-- ── Relatório ───────────────────────────────────────────────────────────────
\echo ''
\echo '═══ Isolamento entre clínicas (drizzle/0023) ═══'
\echo ''
SELECT ordem,
       CASE WHEN passou THEN '✓' ELSE '✗' END AS ok,
       caso, esperado, obtido
  FROM resultado ORDER BY ordem;

\echo ''
SELECT count(*) FILTER (WHERE passou)       AS passaram,
       count(*) FILTER (WHERE NOT passou)   AS falharam,
       count(*)                             AS total
  FROM resultado;

/* Sai com código de erro se algo reprovou: sem isto, o script "passa" no CI
   imprimindo ✗ na tela que ninguém lê. */
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM resultado WHERE NOT passou;
  IF v > 0 THEN
    RAISE EXCEPTION '% caso(s) reprovaram — o isolamento entre clínicas está furado.', v;
  END IF;
END $$;

ROLLBACK;
