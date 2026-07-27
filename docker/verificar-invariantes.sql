-- ============================================================================
-- Prova que as invariantes do banco realmente funcionam — de `drizzle/0001` até a
-- `0022` (multi-tenant).
--
-- Não é teste de aplicação: é teste do BANCO. As garantias legais (prontuário
-- imutável) e financeiras (soma das parcelas) só valem se o Postgres as impuser
-- mesmo quando a aplicação está com bug.
--
--   npm run db:verificar
--
-- Roda numa transação e faz ROLLBACK ao final: não deixa lixo no banco.
--
-- ── Duas armadilhas, e a guarda que as pega ─────────────────────────────────
-- `espera_erro` captura `WHEN others`: **qualquer** erro conta como sucesso. Um
-- caso que morre por tabela ausente, tipo errado ou enum inválido marca PASSOU
-- sem nunca chegar à regra. Isso já produziu relatório verde provando nada três
-- vezes neste projeto. Ver a guarda ao pé do arquivo — ela reprova caso que passou
-- por sqlstate de "objeto errado" em vez de sqlstate de integridade.
--
-- E toda fixture que só faz sentido dentro de um caso deve nascer FORA dele: se a
-- criação da fixture falhar dentro do `espera_erro`, o caso "passa" por isso.
-- ============================================================================

\set ON_ERROR_STOP on
\timing off

BEGIN;

CREATE TEMP TABLE resultado (
  ordem     serial,
  caso      text,
  esperado  text,
  obtido    text,
  passou    boolean
);

/* Executa os comandos esperando FALHA. `forcar` dispara os constraint triggers
   deferidos, que de outro modo só rodariam no COMMIT da transação inteira. */
CREATE FUNCTION espera_erro(caso text, cmds text[], forcar boolean DEFAULT false)
RETURNS void AS $$
DECLARE c text;
BEGIN
  BEGIN
    -- `SET CONSTRAINTS ALL IMMEDIATE` muda o modo para o RESTO da transação, não
    -- só para o comando. Sem restaurar, um caso com `forcar` faria os seguintes
    -- checarem na hora e reprovarem edições legítimas em duas etapas.
    SET CONSTRAINTS ALL DEFERRED;
    FOREACH c IN ARRAY cmds LOOP EXECUTE c; END LOOP;
    IF forcar THEN SET CONSTRAINTS ALL IMMEDIATE; END IF;
    INSERT INTO resultado (caso, esperado, obtido, passou)
      VALUES (caso, 'rejeitar', 'ACEITOU — invariante furada', false);
  EXCEPTION WHEN others THEN
    INSERT INTO resultado (caso, esperado, obtido, passou)
      VALUES (caso, 'rejeitar', sqlstate || ': ' || left(sqlerrm, 64), true);
  END;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION espera_ok(caso text, cmds text[], forcar boolean DEFAULT false)
RETURNS void AS $$
DECLARE c text;
BEGIN
  BEGIN
    SET CONSTRAINTS ALL DEFERRED;  -- ver comentário em espera_erro
    FOREACH c IN ARRAY cmds LOOP EXECUTE c; END LOOP;
    IF forcar THEN SET CONSTRAINTS ALL IMMEDIATE; END IF;
    INSERT INTO resultado (caso, esperado, obtido, passou)
      VALUES (caso, 'aceitar', 'aceitou', true);
  EXCEPTION WHEN others THEN
    INSERT INTO resultado (caso, esperado, obtido, passou)
      VALUES (caso, 'aceitar', sqlstate || ': ' || left(sqlerrm, 64), false);
  END;
END $$ LANGUAGE plpgsql;

/* Como `espera_erro`, mas exige que a MENSAGEM contenha um trecho. Existe porque
   sqlstate é prova fraca quando a garantia é o texto: `app_clinica_id()` estourar
   com "Sem contexto de clínica" é diferente de o INSERT morrer com um
   "null value violates not-null constraint" genérico. Os dois rejeitam; só um
   diz à pessoa o que fazer, e é isso que se quer provar. */
CREATE FUNCTION espera_erro_dizendo(caso text, cmds text[], trecho text)
RETURNS void AS $$
DECLARE c text;
BEGIN
  BEGIN
    FOREACH c IN ARRAY cmds LOOP EXECUTE c; END LOOP;
    INSERT INTO resultado (caso, esperado, obtido, passou)
      VALUES (caso, 'rejeitar', 'ACEITOU — invariante furada', false);
  EXCEPTION WHEN others THEN
    IF position(trecho in sqlerrm) > 0 THEN
      INSERT INTO resultado (caso, esperado, obtido, passou)
        VALUES (caso, 'rejeitar (texto)', sqlstate || ': …' || trecho || '…', true);
    ELSE
      INSERT INTO resultado (caso, esperado, obtido, passou)
        VALUES (caso, 'rejeitar (texto)', format('MOTIVO ERRADO (esperava "%s"): %s: %s',
                                         trecho, sqlstate, left(sqlerrm, 80)), false);
    END IF;
  END;
END $$ LANGUAGE plpgsql;

/* Para invariante que é um VALOR, não uma rejeição: numeração, fuso, contagem.
   `esperado = 'confirmar'` mantém estes casos fora da guarda de falso verde do
   fim do arquivo, que só sabe julgar caso de rejeição. */
CREATE FUNCTION confere(caso text, ok boolean, detalhe text DEFAULT '')
RETURNS void AS $$
BEGIN
  INSERT INTO resultado (caso, esperado, obtido, passou)
    VALUES (caso, 'confirmar',
            CASE WHEN ok THEN coalesce(nullif(detalhe, ''), 'confere')
                 ELSE 'NÃO CONFERE — ' || detalhe END,
            ok);
END $$ LANGUAGE plpgsql;

-- ── Fixtures ────────────────────────────────────────────────────────────────
--
-- ── Duas clínicas, e o contexto de tenant ───────────────────────────────────
-- Desde a `drizzle/0022` a clínica é o TENANT, com PK uuid, e o
-- `CHECK clinica_singleton` não existe mais. Duas consequências para este
-- arquivo:
--
--   1. `id = 1` não compila mais ("column id is of type uuid"). Os uuid abaixo
--      são fixos e legíveis de propósito — `c1…` é a clínica A, `c2…` a B — para
--      um caso que falha dizer QUAL clínica ele estava usando. uuid aleatório
--      tornaria a mensagem de erro inútil.
--   2. **Sem `app.clinica_id` no contexto, nada abaixo insere.** Toda coluna
--      `clinica_id` tem `DEFAULT app_clinica_id()`, e essa função estoura sem
--      contexto. `set_config(…, true)` é o equivalente SQL do que
--      `comClinica()` faz no TypeScript: vale até o fim da transação, e como
--      este arquivo termina em `ROLLBACK`, não sobra contexto nem lixo.
--
-- A clínica B existe para os casos de isolamento entre tenants. Ela é criada
-- aqui, junto da A, porque criar clínica no meio de um `espera_erro` esconderia
-- a criação dentro do bloco que engole exceção — e um caso que falhasse ao criar
-- a fixture "passaria" pelo motivo errado. É a mesma lição do agendamento da
-- seção da cadeira, no fim deste arquivo.
--
-- ── Por que estes CNPJ e não os "de exemplo" do projeto ────────────────────
-- `11222333000181` é o CNPJ da clínica do `demo:preparar` (Sorriso Vivo). Usá-lo
-- aqui fazia `npm run db:verificar` estourar com
-- `duplicate key value violates unique constraint "clinica_cnpj_uk"` em qualquer
-- banco onde a demonstração já tinha rodado — o que é a maioria dos bancos de
-- desenvolvimento. Estes são sintéticos e exclusivos deste arquivo.
--
-- A saída NÃO é afrouxar o índice: ele é a trava que substituiu o
-- `CHECK clinica_singleton` e existe para o mesmo cliente não entrar duas vezes.
-- Quando uma fixture colide com uma trava, é a fixture que está errada.
INSERT INTO clinica (id, razao_social, cnpj, fuso_horario) VALUES
  ('c1111111-1111-1111-1111-111111111111', 'Clínica de Teste A', '90000000000101', 'America/Sao_Paulo'),
  ('c2222222-2222-2222-2222-222222222222', 'Clínica de Teste B', '90000000000202', 'America/Manaus');

-- Daqui para baixo, tudo é da clínica A, por DEFAULT. Os poucos casos que falam
-- da B trocam o contexto explicitamente e devolvem para A no fim.
-- `DO`/`PERFORM` e não `SELECT set_config(...)`: um SELECT solto imprime uma
-- linha de resultado no meio do relatório, e o relatório é a saída que alguém lê.
DO $$ BEGIN PERFORM set_config('app.clinica_id', 'c1111111-1111-1111-1111-111111111111', true); END $$;

-- ── O catálogo DA clínica de teste ─────────────────────────────────────────
-- Na 0022 `procedimento` virou por clínica. Antes disto, as fixtures buscavam
-- `codigo = 'DENT-001'` sem filtro e pegavam o do `db:seed` — que pertence a OUTRA
-- clínica. Dois problemas de uma vez:
--
--   • a busca passou a devolver duas linhas assim que o `demo:preparar` semeou o
--     próprio catálogo ("more than one row returned by a subquery"), e o arquivo
--     inteiro parava;
--   • e enquanto funcionava, montava `item_plano` da clínica A apontando para
--     procedimento de outra — referência cruzando tenant, que os FKs compostos da
--     `drizzle/0023` recusam. As invariantes estariam provando as travas em cima de
--     dado que as travas não aceitam.
--
-- Valores espelhados do `lib/db/seed/procedimentos.ts` para os casos que dependem
-- de `requer_dente`/`requer_face` continuarem exercitando a mesma regra.
INSERT INTO procedimento (codigo, nome, valor_particular, requer_dente, requer_face, especialidade) VALUES
  ('CONS-001', 'Consulta odontológica inicial',            '180.00', false, false, 'Clínica geral'),
  ('DENT-001', 'Restauração em resina composta — 1 face',  '230.00', true,  true,  'Dentística'),
  ('DENT-002', 'Restauração em resina composta — 2 faces', '300.00', true,  true,  'Dentística'),
  ('CIR-001',  'Exodontia simples',                        '350.00', true,  false, 'Cirurgia');

INSERT INTO usuario (id, nome, email, senha_hash, perfil) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Dra. Ana',  'ana@teste.local',  'x', 'dentista'),
  ('11111111-1111-1111-1111-111111111112', 'Dr. Bruno', 'bruno@teste.local','x', 'dentista');

INSERT INTO profissional (id, usuario_id, cro, uf_cro) VALUES
  ('22222222-2222-2222-2222-222222222221', '11111111-1111-1111-1111-111111111111', 'T1001', 'SP'),
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111112', 'T1002', 'SP');

INSERT INTO paciente (id, nome, data_nascimento) VALUES
  ('33333333-3333-3333-3333-333333333333', 'Paciente Teste', '1990-05-10');

INSERT INTO cadeira (id, nome) VALUES
  ('44444444-4444-4444-4444-444444444441', 'Cadeira Teste A'),
  ('44444444-4444-4444-4444-444444444442', 'Cadeira Teste B');

-- Agendamento base: Dra. Ana, cadeira A, 09:00–10:00.
INSERT INTO agendamento (id, paciente_id, profissional_id, cadeira_id, inicio, fim) VALUES
  ('55555555-5555-5555-5555-555555555550',
   '33333333-3333-3333-3333-333333333333',
   '22222222-2222-2222-2222-222222222221',
   '44444444-4444-4444-4444-444444444441',
   '2026-09-01 09:00:00-03', '2026-09-01 10:00:00-03');

-- ── 1. Agenda: EXCLUDE constraints ──────────────────────────────────────────
SELECT espera_erro('agenda: mesmo profissional em horário sobreposto', ARRAY[$$
  INSERT INTO agendamento (paciente_id, profissional_id, cadeira_id, inicio, fim)
  VALUES ('33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222221',
          '44444444-4444-4444-4444-444444444442',
          '2026-09-01 09:30:00-03', '2026-09-01 10:30:00-03')
$$]);

SELECT espera_erro('agenda: mesma cadeira, outro profissional, horário sobreposto', ARRAY[$$
  INSERT INTO agendamento (paciente_id, profissional_id, cadeira_id, inicio, fim)
  VALUES ('33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222222',
          '44444444-4444-4444-4444-444444444441',
          '2026-09-01 09:30:00-03', '2026-09-01 10:30:00-03')
$$]);

SELECT espera_ok('agenda: horários adjacentes não conflitam (intervalo meio-aberto)', ARRAY[$$
  INSERT INTO agendamento (paciente_id, profissional_id, cadeira_id, inicio, fim)
  VALUES ('33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222221',
          '44444444-4444-4444-4444-444444444441',
          '2026-09-01 10:00:00-03', '2026-09-01 11:00:00-03')
$$]);

SELECT espera_ok('agenda: cancelado libera o horário', ARRAY[$$
  UPDATE agendamento SET status='cancelado', motivo_cancelamento='teste'
   WHERE id='55555555-5555-5555-5555-555555555550'
$$, $$
  INSERT INTO agendamento (paciente_id, profissional_id, cadeira_id, inicio, fim)
  VALUES ('33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222221',
          '44444444-4444-4444-4444-444444444441',
          '2026-09-01 09:00:00-03', '2026-09-01 09:45:00-03')
$$]);

SELECT espera_erro('agenda: cancelar sem motivo', ARRAY[$$
  INSERT INTO agendamento (paciente_id, profissional_id, inicio, fim, status)
  VALUES ('33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222222',
          '2026-09-02 09:00:00-03', '2026-09-02 10:00:00-03', 'cancelado')
$$]);

SELECT espera_erro('agenda: fim antes do início', ARRAY[$$
  INSERT INTO agendamento (paciente_id, profissional_id, inicio, fim)
  VALUES ('33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222222',
          '2026-09-03 10:00:00-03', '2026-09-03 09:00:00-03')
$$]);

-- ── 2. Evolução: append-only ────────────────────────────────────────────────
INSERT INTO evolucao (id, paciente_id, profissional_id, texto) VALUES
  ('66666666-6666-6666-6666-666666666661',
   '33333333-3333-3333-3333-333333333333',
   '22222222-2222-2222-2222-222222222221',
   'Rascunho: restauração no 16.');

SELECT espera_ok('evolução: editar rascunho (não assinado)', ARRAY[$$
  UPDATE evolucao SET texto='Rascunho corrigido: restauração no 17.'
   WHERE id='66666666-6666-6666-6666-666666666661'
$$]);

SELECT espera_erro('evolução: trocar o autor do rascunho', ARRAY[$$
  UPDATE evolucao SET profissional_id='22222222-2222-2222-2222-222222222222'
   WHERE id='66666666-6666-6666-6666-666666666661'
$$]);

/*
 * O vínculo com o paciente é imutável **mesmo em rascunho** — e este caso existe
 * por um motivo que vai além da regra em si.
 *
 * `docker/restaurar.sh --testar` prova que a trigger de append-only sobreviveu ao
 * dump tentando alterar uma evolução restaurada. Ele testava o TEXTO, o que estava
 * errado de duas formas: rascunho é editável de propósito (o caso acima passa), e
 * num banco cuja evolução restaurada fosse rascunho o probe recebia `UPDATE 1` e
 * **reprovava um backup bom**. Pior: no caminho em que a trigger permite, o UPDATE
 * era COMITADO — o script de conferência de backup adulterando prontuário, e
 * `--para-valer` roda contra produção.
 *
 * O probe passou a testar ESTA regra, que vale para qualquer evolução, assinada ou
 * não, e a rodar dentro de `begin; … rollback;`. Se alguém um dia afrouxar a
 * imutabilidade de `paciente_id` em rascunho, o probe volta a não provar nada — e
 * este caso é o que avisa antes.
 */
SELECT espera_erro('evolução: trocar o paciente do rascunho (o probe do backup depende disto)', ARRAY[$$
  UPDATE evolucao SET paciente_id='33333333-3333-3333-3333-333333333334'
   WHERE id='66666666-6666-6666-6666-666666666661'
$$]);

SELECT espera_ok('evolução: assinar o rascunho', ARRAY[$$
  UPDATE evolucao SET assinado_em=now(), assinatura_hash=repeat('a',64)
   WHERE id='66666666-6666-6666-6666-666666666661'
$$]);

SELECT espera_erro('evolução: editar depois de assinada', ARRAY[$$
  UPDATE evolucao SET texto='Adulterado'
   WHERE id='66666666-6666-6666-6666-666666666661'
$$]);

SELECT espera_erro('evolução: excluir (guarda legal de 20 anos)', ARRAY[$$
  DELETE FROM evolucao WHERE id='66666666-6666-6666-6666-666666666661'
$$]);

SELECT espera_erro('evolução: retificar sem informar motivo', ARRAY[$$
  INSERT INTO evolucao (paciente_id, profissional_id, texto, retifica_id)
  VALUES ('33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222221',
          'Correção', '66666666-6666-6666-6666-666666666661')
$$]);

SELECT espera_ok('evolução: retificar com motivo', ARRAY[$$
  INSERT INTO evolucao (id, paciente_id, profissional_id, texto, retifica_id, motivo_retificacao,
                        assinado_em, assinatura_hash)
  VALUES ('66666666-6666-6666-6666-666666666662',
          '33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222221',
          'Correção: era o 17.', '66666666-6666-6666-6666-666666666661',
          'Dente registrado incorretamente.', now(), repeat('b',64))
$$]);

SELECT espera_erro('evolução: retificar duas vezes a mesma (cadeia, não árvore)', ARRAY[$$
  INSERT INTO evolucao (paciente_id, profissional_id, texto, retifica_id, motivo_retificacao)
  VALUES ('33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222221',
          'Outra correção', '66666666-6666-6666-6666-666666666661', 'segunda tentativa')
$$]);

SELECT espera_erro('evolução: texto vazio', ARRAY[$$
  INSERT INTO evolucao (paciente_id, profissional_id, texto)
  VALUES ('33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222221', '    ')
$$]);

SELECT espera_erro('evolução: assinada sem hash de assinatura', ARRAY[$$
  INSERT INTO evolucao (paciente_id, profissional_id, texto, assinado_em)
  VALUES ('33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222221', 'Texto', now())
$$]);

-- ── 3. audit_log: append-only absoluto ──────────────────────────────────────
INSERT INTO audit_log (ator_tipo, acao, entidade, entidade_id, paciente_id) VALUES
  ('staff', 'leitura', 'evolucao', '66666666-6666-6666-6666-666666666661',
   '33333333-3333-3333-3333-333333333333');

SELECT espera_erro('audit_log: alterar registro', ARRAY[$$
  UPDATE audit_log SET acao='criacao' WHERE entidade='evolucao'
$$]);

SELECT espera_erro('audit_log: excluir registro', ARRAY[$$
  DELETE FROM audit_log WHERE entidade='evolucao'
$$]);

SELECT espera_erro('audit_log: tipo de ator inválido', ARRAY[$$
  INSERT INTO audit_log (ator_tipo, acao, entidade) VALUES ('invasor','leitura','paciente')
$$]);

-- ── 4. Financeiro: soma das parcelas e limite de pagamento ──────────────────
SELECT espera_erro('cobrança: parcelas não somam o total', ARRAY[$$
  INSERT INTO cobranca (id, paciente_id, valor_total, forma, qtd_parcelas)
  VALUES ('77777777-7777-7777-7777-777777777771',
          '33333333-3333-3333-3333-333333333333', '100.00', 'pix', 3)
$$, $$
  INSERT INTO parcela (cobranca_id, numero, vencimento, valor) VALUES
    ('77777777-7777-7777-7777-777777777771', 1, '2026-10-01', '33.33'),
    ('77777777-7777-7777-7777-777777777771', 2, '2026-11-01', '33.33'),
    ('77777777-7777-7777-7777-777777777771', 3, '2026-12-01', '33.33')
$$], true);

SELECT espera_ok('cobrança: parcelas somam exatamente o total (sobra na primeira)', ARRAY[$$
  INSERT INTO cobranca (id, paciente_id, valor_total, forma, qtd_parcelas)
  VALUES ('77777777-7777-7777-7777-777777777772',
          '33333333-3333-3333-3333-333333333333', '100.00', 'pix', 3)
$$, $$
  INSERT INTO parcela (id, cobranca_id, numero, vencimento, valor) VALUES
    ('88888888-8888-8888-8888-888888888881','77777777-7777-7777-7777-777777777772', 1, '2026-10-01', '33.34'),
    ('88888888-8888-8888-8888-888888888882','77777777-7777-7777-7777-777777777772', 2, '2026-11-01', '33.33'),
    ('88888888-8888-8888-8888-888888888883','77777777-7777-7777-7777-777777777772', 3, '2026-12-01', '33.33')
$$], true);

SELECT espera_erro('cobrança: sem nenhuma parcela', ARRAY[$$
  INSERT INTO cobranca (id, paciente_id, valor_total, forma)
  VALUES ('77777777-7777-7777-7777-777777777773',
          '33333333-3333-3333-3333-333333333333', '50.00', 'dinheiro')
$$], true);

SELECT espera_ok('pagamento: parcial dentro do valor da parcela', ARRAY[$$
  INSERT INTO pagamento (parcela_id, valor, pago_em, meio)
  VALUES ('88888888-8888-8888-8888-888888888881', '20.00', '2026-10-01', 'pix')
$$], true);

SELECT espera_erro('pagamento: soma excede o valor da parcela', ARRAY[$$
  INSERT INTO pagamento (parcela_id, valor, pago_em, meio)
  VALUES ('88888888-8888-8888-8888-888888888881', '20.00', '2026-10-02', 'pix')
$$], true);

SELECT espera_ok('pagamento: completa exatamente a parcela', ARRAY[$$
  INSERT INTO pagamento (parcela_id, valor, pago_em, meio)
  VALUES ('88888888-8888-8888-8888-888888888881', '13.34', '2026-10-02', 'pix')
$$], true);

SELECT espera_erro('pagamento: estorno sem motivo', ARRAY[$$
  INSERT INTO pagamento (parcela_id, valor, pago_em, meio, estornado_em)
  VALUES ('88888888-8888-8888-8888-888888888882', '10.00', '2026-11-01', 'pix', now())
$$]);

-- ── 5. Coerência de item de plano e convênio ────────────────────────────────
INSERT INTO plano_tratamento (id, paciente_id, profissional_id, titulo, status) VALUES
  ('99999999-9999-9999-9999-999999999991',
   '33333333-3333-3333-3333-333333333333',
   '22222222-2222-2222-2222-222222222221', 'Plano de teste', 'ativo');

SELECT espera_erro('item de plano: cobertura convênio sem convenio_id', ARRAY[$$
  INSERT INTO item_plano (plano_id, procedimento_id, valor, cobertura)
  SELECT '99999999-9999-9999-9999-999999999991', id, '100.00', 'convenio'
    FROM procedimento WHERE codigo='CONS-001' AND clinica_id = 'c1111111-1111-1111-1111-111111111111'
$$]);

SELECT espera_erro('item de plano: faces sem dente', ARRAY[$$
  INSERT INTO item_plano (plano_id, procedimento_id, valor, faces)
  SELECT '99999999-9999-9999-9999-999999999991', id, '100.00', ARRAY['oclusal']::face_dente[]
    FROM procedimento WHERE codigo='DENT-001' AND clinica_id = 'c1111111-1111-1111-1111-111111111111'
$$]);

SELECT espera_ok('item de plano: dente e faces coerentes', ARRAY[$$
  INSERT INTO item_plano (plano_id, procedimento_id, valor, dente_fdi, faces)
  SELECT '99999999-9999-9999-9999-999999999991', id, '230.00', 16,
         ARRAY['oclusal','mesial']::face_dente[]
    FROM procedimento WHERE codigo='DENT-001' AND clinica_id = 'c1111111-1111-1111-1111-111111111111'
$$]);

SELECT espera_erro('item de plano: dente FDI inexistente', ARRAY[$$
  INSERT INTO item_plano (plano_id, procedimento_id, valor, dente_fdi)
  SELECT '99999999-9999-9999-9999-999999999991', id, '350.00', 19
    FROM procedimento WHERE codigo='CIR-001' AND clinica_id = 'c1111111-1111-1111-1111-111111111111'
$$]);

-- ── 6. Outras invariantes ───────────────────────────────────────────────────
-- ── A trava da clínica mudou de sentido na 0022 ─────────────────────────────
-- Aqui havia o caso `clínica: segunda linha (deve ser singleton)`, e ele foi
-- REMOVIDO porque a invariante deixou de existir: multi-tenant é o objetivo
-- agora, não o erro.
--
-- Vale registrar como ele se comportava, porque é a armadilha nº 1 deste arquivo:
-- o caso continuava marcando **PASSOU** depois da 0022, com
-- `42804: column "id" is of type uuid but expression is of type integer`. O
-- `INSERT … VALUES (2, …)` nem chegava a testar regra nenhuma — batia no tipo da
-- coluna, e `espera_erro` captura `WHEN others`, então qualquer erro conta como
-- sucesso. Um relatório 200/200 afirmando uma invariante que o banco já não tem.
-- É a terceira vez que essa forma de falso verde aparece no projeto (as outras:
-- tabela ausente e valor de enum inválido).
--
-- No lugar entram as duas metades da regra nova.
SELECT espera_ok('clínica: segunda clínica é PERMITIDA (multi-tenant, 0022)', ARRAY[$$
  INSERT INTO clinica (id, razao_social) VALUES
    ('c3333333-3333-3333-3333-333333333333', 'Terceira clínica')
$$]);

SELECT espera_erro('clínica: CNPJ repetido (é o que substituiu o singleton)', ARRAY[$$
  INSERT INTO clinica (razao_social, cnpj) VALUES ('Clone da A', '90000000000101')
$$]);

SELECT espera_ok('clínica: CNPJ nulo repetido é aceito (índice é parcial)', ARRAY[$$
  INSERT INTO clinica (razao_social, cnpj) VALUES ('Autônomo 1', NULL)
$$, $$
  INSERT INTO clinica (razao_social, cnpj) VALUES ('Autônomo 2', NULL)
$$]);

SELECT espera_erro('paciente: responsável legal de si mesmo', ARRAY[$$
  UPDATE paciente SET responsavel_legal_id=id WHERE id='33333333-3333-3333-3333-333333333333'
$$]);

SELECT espera_erro('procedimento: exige face sem exigir dente', ARRAY[$$
  INSERT INTO procedimento (codigo, nome, valor_particular, requer_dente, requer_face)
  VALUES ('TESTE-X','Procedimento torto','10.00',false,true)
$$]);

SELECT espera_erro('profissional: comissão acima de 100%', ARRAY[$$
  UPDATE profissional SET comissao_pct='150'
   WHERE id='22222222-2222-2222-2222-222222222221'
$$]);

SELECT espera_erro('usuário: e-mail duplicado ignorando maiúsculas', ARRAY[$$
  INSERT INTO usuario (nome, email, senha_hash, perfil)
  VALUES ('Clone','ANA@teste.local','x','recepcao')
$$]);


-- ── 7. Orçamento congelado (drizzle/0004) ───────────────────────────────────
-- Documento comercial que muda depois de entregue ao paciente é problema
-- jurídico, não bug de tela.
SELECT espera_ok('orçamento: rascunho com soma das linhas correta', ARRAY[$$
  INSERT INTO orcamento (id, numero, paciente_id, status, validade_ate, valor_bruto, desconto, valor_total)
  VALUES ('aaaa1111-1111-4111-8111-111111111111', 990001,
          '33333333-3333-3333-3333-333333333333', 'rascunho', '2026-12-31', '200.00', '20.00', '180.00')
$$, $$
  INSERT INTO orcamento_item (orcamento_id, descricao, quantidade, valor_unitario) VALUES
    ('aaaa1111-1111-4111-8111-111111111111', 'Restauração 16', 1, '100.00'),
    ('aaaa1111-1111-4111-8111-111111111111', 'Restauração 26', 1, '100.00')
$$], true);

SELECT espera_erro('orçamento: soma das linhas difere do valor bruto', ARRAY[$$
  INSERT INTO orcamento (id, numero, paciente_id, status, validade_ate, valor_bruto, desconto, valor_total)
  VALUES ('aaaa1111-1111-4111-8111-111111111112', 990002,
          '33333333-3333-3333-3333-333333333333', 'rascunho', '2026-12-31', '500.00', '0', '500.00')
$$, $$
  INSERT INTO orcamento_item (orcamento_id, descricao, quantidade, valor_unitario)
  VALUES ('aaaa1111-1111-4111-8111-111111111112', 'Coroa', 1, '100.00')
$$], true);

SELECT espera_erro('orçamento: nenhuma linha', ARRAY[$$
  INSERT INTO orcamento (id, numero, paciente_id, status, validade_ate, valor_bruto, desconto, valor_total)
  VALUES ('aaaa1111-1111-4111-8111-111111111113', 990003,
          '33333333-3333-3333-3333-333333333333', 'rascunho', '2026-12-31', '50.00', '0', '50.00')
$$], true);

SELECT espera_erro('orçamento: desconto maior que o bruto', ARRAY[$$
  INSERT INTO orcamento (numero, paciente_id, status, validade_ate, valor_bruto, desconto, valor_total)
  VALUES (990004, '33333333-3333-3333-3333-333333333333', 'rascunho', '2026-12-31', '100.00', '150.00', '-50.00')
$$]);

-- Editar RASCUNHO em duas etapas é legítimo: linha e total mudam na mesma transação.
SELECT espera_ok('orçamento: editar linha e total do rascunho', ARRAY[$$
  UPDATE orcamento_item SET valor_unitario = '120.00'
   WHERE orcamento_id = 'aaaa1111-1111-4111-8111-111111111111' AND descricao = 'Restauração 16'
$$, $$
  UPDATE orcamento SET valor_bruto = '220.00', valor_total = '200.00'
   WHERE id = 'aaaa1111-1111-4111-8111-111111111111'
$$], true);

SELECT espera_ok('orçamento: enviar', ARRAY[$$
  UPDATE orcamento SET status = 'enviado', enviado_em = now()
   WHERE id = 'aaaa1111-1111-4111-8111-111111111111'
$$], true);

SELECT espera_erro('orçamento ENVIADO: alterar valor', ARRAY[$$
  UPDATE orcamento SET valor_bruto = '999.00', valor_total = '979.00'
   WHERE id = 'aaaa1111-1111-4111-8111-111111111111'
$$]);

SELECT espera_erro('orçamento ENVIADO: esticar a validade', ARRAY[$$
  UPDATE orcamento SET validade_ate = '2027-12-31'
   WHERE id = 'aaaa1111-1111-4111-8111-111111111111'
$$]);

SELECT espera_erro('orçamento ENVIADO: editar descrição da linha', ARRAY[$$
  UPDATE orcamento_item SET descricao = 'Outra coisa'
   WHERE orcamento_id = 'aaaa1111-1111-4111-8111-111111111111'
$$]);

SELECT espera_erro('orçamento ENVIADO: acrescentar linha', ARRAY[$$
  INSERT INTO orcamento_item (orcamento_id, descricao, quantidade, valor_unitario)
  VALUES ('aaaa1111-1111-4111-8111-111111111111', 'Extra', 1, '10.00')
$$]);

SELECT espera_erro('orçamento ENVIADO: apagar linha', ARRAY[$$
  DELETE FROM orcamento_item WHERE orcamento_id = 'aaaa1111-1111-4111-8111-111111111111'
$$]);

SELECT espera_erro('orçamento ENVIADO: excluir o documento', ARRAY[$$
  DELETE FROM orcamento WHERE id = 'aaaa1111-1111-4111-8111-111111111111'
$$]);

SELECT espera_ok('orçamento ENVIADO: registrar a decisão do paciente', ARRAY[$$
  UPDATE orcamento SET status = 'aprovado', decidido_em = now()
   WHERE id = 'aaaa1111-1111-4111-8111-111111111111'
$$], true);

SELECT espera_erro('plano: dois ativos para o mesmo paciente', ARRAY[$$
  INSERT INTO plano_tratamento (paciente_id, profissional_id, titulo, status)
  VALUES ('33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222221', 'Segundo plano', 'ativo')
$$]);


-- ── 8. Financeiro (drizzle/0007) ────────────────────────────────────────────
-- Estas fixtures rodam no NÍVEL DE TOPO, fora dos helpers — então precisam
-- restaurar o modo deferido por conta própria. `SET CONSTRAINTS ALL IMMEDIATE`
-- de um caso anterior vale para o resto da transação.
SET CONSTRAINTS ALL DEFERRED;

-- Fixtures: orçamento aprovado, para a cobrança poder existir.
INSERT INTO orcamento (id, numero, paciente_id, status, validade_ate, valor_bruto, desconto, valor_total)
VALUES ('bbbb2222-2222-4222-8222-222222222221', 991001,
        '33333333-3333-3333-3333-333333333333', 'rascunho', '2026-12-31', '300.00', '0', '300.00');
INSERT INTO orcamento_item (orcamento_id, descricao, quantidade, valor_unitario)
VALUES ('bbbb2222-2222-4222-8222-222222222221', 'Tratamento', 1, '300.00');
SET CONSTRAINTS ALL IMMEDIATE;
UPDATE orcamento SET status='enviado', enviado_em=now() WHERE id='bbbb2222-2222-4222-8222-222222222221';
UPDATE orcamento SET status='aprovado', decidido_em=now() WHERE id='bbbb2222-2222-4222-8222-222222222221';
SET CONSTRAINTS ALL DEFERRED;

-- Orçamento ainda em rascunho, para o caso negativo.
INSERT INTO orcamento (id, numero, paciente_id, status, validade_ate, valor_bruto, desconto, valor_total)
VALUES ('bbbb2222-2222-4222-8222-222222222222', 991002,
        '33333333-3333-3333-3333-333333333333', 'rascunho', '2026-12-31', '100.00', '0', '100.00');
INSERT INTO orcamento_item (orcamento_id, descricao, quantidade, valor_unitario)
VALUES ('bbbb2222-2222-4222-8222-222222222222', 'Outro', 1, '100.00');

SELECT espera_erro('cobrança: sobre orçamento NÃO aprovado', ARRAY[$$
  INSERT INTO cobranca (paciente_id, orcamento_id, valor_total, forma)
  VALUES ('33333333-3333-3333-3333-333333333333','bbbb2222-2222-4222-8222-222222222222','100.00','pix')
$$]);

SELECT espera_ok('cobrança: 3 parcelas somando o total, sobra na primeira', ARRAY[$$
  INSERT INTO cobranca (id, paciente_id, orcamento_id, valor_total, forma, qtd_parcelas)
  VALUES ('cccc3333-3333-4333-8333-333333333331','33333333-3333-3333-3333-333333333333',
          'bbbb2222-2222-4222-8222-222222222221','100.00','credito',3)
$$, $$
  INSERT INTO parcela (id, cobranca_id, numero, vencimento, valor) VALUES
   ('dddd4444-4444-4444-8444-444444444441','cccc3333-3333-4333-8333-333333333331',1,'2026-11-01','33.34'),
   ('dddd4444-4444-4444-8444-444444444442','cccc3333-3333-4333-8333-333333333331',2,'2026-12-01','33.33'),
   ('dddd4444-4444-4444-8444-444444444443','cccc3333-3333-4333-8333-333333333331',3,'2027-01-01','33.33')
$$], true);

SELECT espera_erro('cobrança: DUAS para o mesmo orçamento', ARRAY[$$
  INSERT INTO cobranca (paciente_id, orcamento_id, valor_total, forma)
  VALUES ('33333333-3333-3333-3333-333333333333','bbbb2222-2222-4222-8222-222222222221','100.00','pix')
$$]);

-- O trigger mantém parcela.status: pagamento parcial → 'parcial'
SELECT espera_ok('parcela: pagamento parcial deixa status "parcial"', ARRAY[$$
  INSERT INTO pagamento (id, parcela_id, valor, pago_em, meio)
  VALUES ('eeee5555-5555-4555-8555-555555555551','dddd4444-4444-4444-8444-444444444441','10.00','2026-11-01','pix')
$$, $$
  DO $x$ DECLARE s text; BEGIN
    SELECT status::text INTO s FROM parcela WHERE id='dddd4444-4444-4444-8444-444444444441';
    IF s <> 'parcial' THEN RAISE EXCEPTION 'status ficou "%" em vez de parcial', s; END IF;
  END $x$
$$], true);

SELECT espera_ok('parcela: quitar deixa status "paga"', ARRAY[$$
  INSERT INTO pagamento (parcela_id, valor, pago_em, meio)
  VALUES ('dddd4444-4444-4444-8444-444444444441','23.34','2026-11-02','pix')
$$, $$
  DO $x$ DECLARE s text; BEGIN
    SELECT status::text INTO s FROM parcela WHERE id='dddd4444-4444-4444-8444-444444444441';
    IF s <> 'paga' THEN RAISE EXCEPTION 'status ficou "%" em vez de paga', s; END IF;
  END $x$
$$], true);

SELECT espera_ok('parcela: estornar volta o status para "parcial"', ARRAY[$$
  UPDATE pagamento SET estornado_em=now(), motivo_estorno='cheque devolvido'
   WHERE id='eeee5555-5555-4555-8555-555555555551'
$$, $$
  DO $x$ DECLARE s text; BEGIN
    SELECT status::text INTO s FROM parcela WHERE id='dddd4444-4444-4444-8444-444444444441';
    IF s <> 'parcial' THEN RAISE EXCEPTION 'status ficou "%" em vez de parcial', s; END IF;
  END $x$
$$], true);

SELECT espera_erro('pagamento: excluir em vez de estornar', ARRAY[$$
  DELETE FROM pagamento WHERE parcela_id='dddd4444-4444-4444-8444-444444444441'
$$]);

SELECT espera_erro('cobrança: excluir com pagamento registrado', ARRAY[$$
  DELETE FROM cobranca WHERE id='cccc3333-3333-4333-8333-333333333331'
$$]);

SELECT espera_erro('pagamento: em parcela cancelada', ARRAY[$$
  UPDATE parcela SET status='cancelada' WHERE id='dddd4444-4444-4444-8444-444444444443'
$$, $$
  INSERT INTO pagamento (parcela_id, valor, pago_em, meio)
  VALUES ('dddd4444-4444-4444-8444-444444444443','10.00','2026-11-01','pix')
$$]);

-- ── 9. Mensageria (WhatsApp) ────────────────────────────────────────────────
--
-- A promessa "nunca manda duas vezes" é o coração da fase. Aqui ela é provada
-- contra o banco, não contra a intenção do código.
-- ────────────────────────────────────────────────────────────────────────────

-- Antes de qualquer caso: as tabelas TÊM de existir.
--
-- Isto não é zelo — é uma armadilha real que aconteceu. Com a migration 0008 não
-- aplicada, todo `espera_erro` "passou" com 42P01 (relation does not exist): o
-- comando falhou, que é o que o caso esperava. Um relatório verde provando
-- invariante nenhuma. Faltar tabela agora derruba o script na hora.
DO $$
BEGIN
  IF to_regclass('mensagem_whatsapp') IS NULL OR to_regclass('resposta_whatsapp') IS NULL THEN
    RAISE EXCEPTION
      'tabelas da mensageria não existem — rode as migrations 0008/0009 antes (docker compose build migrate && docker compose run --rm migrate)';
  END IF;
END $$;

-- Fixture: um agendamento futuro e o consentimento LGPD do paciente.
SET CONSTRAINTS ALL DEFERRED;

INSERT INTO agendamento (id, paciente_id, profissional_id, inicio, fim) VALUES
  ('55555555-5555-5555-5555-555555555599',
   '33333333-3333-3333-3333-333333333333',
   '22222222-2222-2222-2222-222222222222',
   '2026-12-01 14:00:00-03', '2026-12-01 15:00:00-03');

SELECT espera_erro('whatsapp: enfileirar SEM consentimento LGPD', ARRAY[$$
  INSERT INTO mensagem_whatsapp
    (paciente_id, agendamento_id, tipo, chave_idempotencia, destino, corpo, agendado_para)
  VALUES ('33333333-3333-3333-3333-333333333333',
          '55555555-5555-5555-5555-555555555599',
          'lembrete_consulta', 'lembrete:sem-consentimento', '5511987654321',
          'Olá!', '2026-11-30 14:00:00-03')
$$]);

INSERT INTO consentimento
  (id, paciente_id, base_legal, finalidade, versao_termo, texto_hash)
VALUES ('66666666-6666-4666-8666-666666666661',
        '33333333-3333-3333-3333-333333333333',
        'consentimento', 'contato_whatsapp', '1.0', repeat('a', 64));

SELECT espera_ok('whatsapp: enfileirar COM consentimento ativo', ARRAY[$$
  INSERT INTO mensagem_whatsapp
    (id, paciente_id, agendamento_id, tipo, chave_idempotencia, destino, corpo, agendado_para)
  VALUES ('77777777-7777-4777-8777-777777777771',
          '33333333-3333-3333-3333-333333333333',
          '55555555-5555-5555-5555-555555555599',
          'lembrete_consulta',
          'lembrete:55555555-5555-5555-5555-555555555599:2026-12-01T17:00:00.000Z',
          '5511987654321', 'Olá, lembrete da consulta.', '2026-11-30 14:00:00-03')
$$]);

SELECT espera_erro('whatsapp: MESMA chave de idempotência (job rodou duas vezes)', ARRAY[$$
  INSERT INTO mensagem_whatsapp
    (paciente_id, agendamento_id, tipo, chave_idempotencia, destino, corpo, agendado_para)
  VALUES ('33333333-3333-3333-3333-333333333333',
          '55555555-5555-5555-5555-555555555599',
          'lembrete_consulta',
          'lembrete:55555555-5555-5555-5555-555555555599:2026-12-01T17:00:00.000Z',
          '5511987654321', 'Olá, lembrete da consulta.', '2026-11-30 14:00:00-03')
$$]);

SELECT espera_erro('whatsapp: destino fora de E.164', ARRAY[$$
  INSERT INTO mensagem_whatsapp
    (paciente_id, tipo, chave_idempotencia, destino, corpo, agendado_para)
  VALUES ('33333333-3333-3333-3333-333333333333', 'aviso_geral', 'chave-e164-ruim',
          '(11) 98765-4321', 'Olá!', '2026-11-30 14:00:00-03')
$$]);

SELECT espera_erro('whatsapp: pendente com enviado_em preenchido', ARRAY[$$
  INSERT INTO mensagem_whatsapp
    (paciente_id, tipo, chave_idempotencia, destino, corpo, agendado_para, enviado_em)
  VALUES ('33333333-3333-3333-3333-333333333333', 'aviso_geral', 'chave-pendente-enviada',
          '5511987654321', 'Olá!', '2026-11-30 14:00:00-03', now())
$$]);

SELECT espera_erro('whatsapp: enviada sem enviado_em', ARRAY[$$
  INSERT INTO mensagem_whatsapp
    (paciente_id, tipo, chave_idempotencia, destino, corpo, agendado_para, situacao)
  VALUES ('33333333-3333-3333-3333-333333333333', 'aviso_geral', 'chave-enviada-sem-carimbo',
          '5511987654321', 'Olá!', '2026-11-30 14:00:00-03', 'enviada')
$$]);

SELECT espera_erro('whatsapp: pular de pendente direto para enviada', ARRAY[$$
  UPDATE mensagem_whatsapp SET situacao='enviada', enviado_em=now()
   WHERE id='77777777-7777-4777-8777-777777777771'
$$]);

SELECT espera_ok('whatsapp: reivindicar (pendente -> enviando)', ARRAY[$$
  UPDATE mensagem_whatsapp SET situacao='enviando', reivindicado_em=now(), tentativas=1
   WHERE id='77777777-7777-4777-8777-777777777771'
$$]);

SELECT espera_erro('whatsapp: devolver enviando para pendente (risco de duplicar)', ARRAY[$$
  UPDATE mensagem_whatsapp SET situacao='pendente'
   WHERE id='77777777-7777-4777-8777-777777777771'
$$]);

SELECT espera_ok('whatsapp: concluir envio (enviando -> enviada)', ARRAY[$$
  UPDATE mensagem_whatsapp
     SET situacao='enviada', enviado_em='2026-11-30 14:00:05-03',
         provedor='simulado', id_externo='wamid.TESTE1'
   WHERE id='77777777-7777-4777-8777-777777777771'
$$]);

SELECT espera_erro('whatsapp: SOBRESCREVER enviado_em de mensagem já enviada', ARRAY[$$
  UPDATE mensagem_whatsapp SET enviado_em=now()
   WHERE id='77777777-7777-4777-8777-777777777771'
$$]);

SELECT espera_erro('whatsapp: alterar o corpo depois de enviado', ARRAY[$$
  UPDATE mensagem_whatsapp SET corpo='outro texto'
   WHERE id='77777777-7777-4777-8777-777777777771'
$$]);

SELECT espera_erro('whatsapp: alterar o destino depois de enviado', ARRAY[$$
  UPDATE mensagem_whatsapp SET destino='5511999999999'
   WHERE id='77777777-7777-4777-8777-777777777771'
$$]);

SELECT espera_erro('whatsapp: trocar a chave de idempotência', ARRAY[$$
  UPDATE mensagem_whatsapp SET chave_idempotencia='outra-chave'
   WHERE id='77777777-7777-4777-8777-777777777771'
$$]);

SELECT espera_ok('whatsapp: webhook marca entregue e depois lida', ARRAY[$$
  UPDATE mensagem_whatsapp SET situacao='entregue', entregue_em=now()
   WHERE id='77777777-7777-4777-8777-777777777771'
$$, $$
  UPDATE mensagem_whatsapp SET situacao='lida', lida_em=now()
   WHERE id='77777777-7777-4777-8777-777777777771'
$$]);

SELECT espera_erro('whatsapp: retroceder de lida para entregue', ARRAY[$$
  UPDATE mensagem_whatsapp SET situacao='entregue'
   WHERE id='77777777-7777-4777-8777-777777777771'
$$]);

SELECT espera_erro('whatsapp: excluir mensagem enviada', ARRAY[$$
  DELETE FROM mensagem_whatsapp WHERE id='77777777-7777-4777-8777-777777777771'
$$]);

-- Falha reportada pela Meta DEPOIS de a chamada ter dado 200: a linha guarda
-- enviado_em e falhou_em ao mesmo tempo, porque as duas coisas aconteceram.
SELECT espera_ok('whatsapp: Meta reporta falha depois de aceitar o envio', ARRAY[$$
  INSERT INTO mensagem_whatsapp
    (id, paciente_id, tipo, chave_idempotencia, destino, corpo, agendado_para,
     situacao, enviado_em, provedor, id_externo)
  VALUES ('77777777-7777-4777-8777-777777777772',
          '33333333-3333-3333-3333-333333333333', 'aviso_geral', 'chave-falha-tardia',
          '5511987654321', 'Olá!', '2026-11-30 14:00:00-03',
          'enviada', now(), 'simulado', 'wamid.TESTE2')
$$, $$
  UPDATE mensagem_whatsapp
     SET situacao='falhou', falhou_em=now(), erro_codigo='131026',
         erro_mensagem='Número não tem WhatsApp'
   WHERE id='77777777-7777-4777-8777-777777777772'
$$]);

SELECT espera_erro('whatsapp: falhou sem motivo registrado', ARRAY[$$
  INSERT INTO mensagem_whatsapp
    (paciente_id, tipo, chave_idempotencia, destino, corpo, agendado_para, situacao, falhou_em)
  VALUES ('33333333-3333-3333-3333-333333333333', 'aviso_geral', 'chave-falha-sem-motivo',
          '5511987654321', 'Olá!', '2026-11-30 14:00:00-03', 'falhou', now())
$$]);

SELECT espera_erro('whatsapp: dois wamid iguais em mensagens diferentes', ARRAY[$$
  INSERT INTO mensagem_whatsapp
    (paciente_id, tipo, chave_idempotencia, destino, corpo, agendado_para,
     situacao, enviado_em, id_externo)
  VALUES ('33333333-3333-3333-3333-333333333333', 'aviso_geral', 'chave-wamid-repetido',
          '5511987654321', 'Olá!', '2026-11-30 14:00:00-03',
          'enviada', now(), 'wamid.TESTE1')
$$]);

-- Resposta recebida: a trava contra reentrega de webhook.
SELECT espera_ok('whatsapp: registrar resposta do paciente', ARRAY[$$
  INSERT INTO resposta_whatsapp
    (id, id_externo, remetente, paciente_id, mensagem_id, agendamento_id, texto, interpretacao)
  VALUES ('88888888-8888-4888-8888-888888888881', 'wamid.RESP1', '5511987654321',
          '33333333-3333-3333-3333-333333333333',
          '77777777-7777-4777-8777-777777777771',
          '55555555-5555-5555-5555-555555555599',
          'Sim', 'confirmou')
$$]);

SELECT espera_erro('whatsapp: REENTREGA do mesmo webhook (mesmo wamid)', ARRAY[$$
  INSERT INTO resposta_whatsapp (id_externo, remetente, texto, interpretacao)
  VALUES ('wamid.RESP1', '5511987654321', 'Sim', 'confirmou')
$$]);

SELECT espera_erro('whatsapp: alterar o texto recebido do paciente', ARRAY[$$
  UPDATE resposta_whatsapp SET texto='Não'
   WHERE id='88888888-8888-4888-8888-888888888881'
$$]);

SELECT espera_erro('whatsapp: alterar a interpretação registrada', ARRAY[$$
  UPDATE resposta_whatsapp SET interpretacao='cancelou'
   WHERE id='88888888-8888-4888-8888-888888888881'
$$]);

SELECT espera_ok('whatsapp: recepção marca a resposta como tratada', ARRAY[$$
  UPDATE resposta_whatsapp SET tratado_em=now(), acao_tomada='Ligou para o paciente'
   WHERE id='88888888-8888-4888-8888-888888888881'
$$]);

SELECT espera_erro('whatsapp: excluir resposta do paciente', ARRAY[$$
  DELETE FROM resposta_whatsapp WHERE id='88888888-8888-4888-8888-888888888881'
$$]);

-- A finalidade do consentimento é a mesma string em dois lugares: na trigger
-- (drizzle/0009) e em lib/mensageria/consentimento.ts. Se divergirem, todo envio
-- passa a ser recusado — este caso é o que denuncia.
SELECT espera_erro('whatsapp: consentimento revogado bloqueia novo envio', ARRAY[$$
  UPDATE consentimento SET revogado_em=now()
   WHERE id='66666666-6666-4666-8666-666666666661'
$$, $$
  INSERT INTO mensagem_whatsapp
    (paciente_id, tipo, chave_idempotencia, destino, corpo, agendado_para)
  VALUES ('33333333-3333-3333-3333-333333333333', 'aviso_geral', 'chave-pos-revogacao',
          '5511987654321', 'Olá!', '2026-11-30 14:00:00-03')
$$]);

-- ── 10. Documentos anexados ao prontuário ───────────────────────────────────
--
-- Radiografia é prontuário: mesma guarda de 20 anos da evolução. E o vínculo com
-- o arquivo no storage tem de ser imutável, senão a conferência de integridade
-- na leitura não prova nada.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('documento') IS NULL THEN
    RAISE EXCEPTION 'tabela documento não existe — rode as migrations antes';
  END IF;
  -- Ver o caso 59: tabela ausente faria todo `espera_erro` "passar".
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'documento' AND column_name = 'removido_por_id'
  ) THEN
    RAISE EXCEPTION 'coluna documento.removido_por_id não existe — falta a migration 0010';
  END IF;
END $$;

SET CONSTRAINTS ALL DEFERRED;

SELECT espera_ok('documento: anexar radiografia ao paciente', ARRAY[$$
  INSERT INTO documento
    (id, paciente_id, tipo, nome, storage_key, mime_type, tamanho_bytes, sha256, dente_fdi, etapa, data_exame)
  VALUES ('99999999-9999-4999-8999-999999999991',
          '33333333-3333-3333-3333-333333333333',
          'radiografia', 'Periapical 11', 'pacientes/33333333-3333-3333-3333-333333333333/2026/doc1.jpg',
          'image/jpeg', 248000, repeat('a', 64), 11, 'inicial', '2026-09-01 10:00:00-03')
$$]);

SELECT espera_erro('documento: sha256 que não é hex de 64', ARRAY[$$
  INSERT INTO documento
    (paciente_id, tipo, nome, storage_key, mime_type, tamanho_bytes, sha256)
  VALUES ('33333333-3333-3333-3333-333333333333', 'exame', 'x', 'k/1.pdf',
          'application/pdf', 100, 'nao-e-hash')
$$]);

SELECT espera_erro('documento: tamanho zero', ARRAY[$$
  INSERT INTO documento
    (paciente_id, tipo, nome, storage_key, mime_type, tamanho_bytes, sha256)
  VALUES ('33333333-3333-3333-3333-333333333333', 'exame', 'x', 'k/2.pdf',
          'application/pdf', 0, repeat('b', 64))
$$]);

SELECT espera_erro('documento: nome vazio', ARRAY[$$
  INSERT INTO documento
    (paciente_id, tipo, nome, storage_key, mime_type, tamanho_bytes, sha256)
  VALUES ('33333333-3333-3333-3333-333333333333', 'exame', '   ', 'k/3.pdf',
          'application/pdf', 100, repeat('b', 64))
$$]);

SELECT espera_erro('documento: DOIS registros na mesma chave de storage', ARRAY[$$
  INSERT INTO documento
    (paciente_id, tipo, nome, storage_key, mime_type, tamanho_bytes, sha256)
  VALUES ('33333333-3333-3333-3333-333333333333', 'exame', 'outro',
          'pacientes/33333333-3333-3333-3333-333333333333/2026/doc1.jpg',
          'image/jpeg', 100, repeat('c', 64))
$$]);

SELECT espera_ok('documento: corrigir metadado (nome, dente, etapa, data)', ARRAY[$$
  UPDATE documento
     SET nome='Periapical dente 11', dente_fdi=21, etapa='final',
         data_exame='2026-09-02 10:00:00-03', descricao='conferido com o dentista'
   WHERE id='99999999-9999-4999-8999-999999999991'
$$]);

SELECT espera_erro('documento: trocar a storage_key', ARRAY[$$
  UPDATE documento SET storage_key='outra/chave.jpg'
   WHERE id='99999999-9999-4999-8999-999999999991'
$$]);

SELECT espera_erro('documento: reescrever o sha256 (esconderia troca de arquivo)', ARRAY[$$
  UPDATE documento SET sha256=repeat('d', 64)
   WHERE id='99999999-9999-4999-8999-999999999991'
$$]);

SELECT espera_erro('documento: reescrever o tamanho', ARRAY[$$
  UPDATE documento SET tamanho_bytes=1
   WHERE id='99999999-9999-4999-8999-999999999991'
$$]);

SELECT espera_erro('documento: mover para outro paciente', ARRAY[$$
  INSERT INTO paciente (id, nome, data_nascimento)
  VALUES ('33333333-3333-3333-3333-333333333334', 'Outro Paciente', '1985-01-01')
$$, $$
  UPDATE documento SET paciente_id='33333333-3333-3333-3333-333333333334'
   WHERE id='99999999-9999-4999-8999-999999999991'
$$]);

SELECT espera_erro('documento: remover sem motivo', ARRAY[$$
  UPDATE documento SET removido_em=now(),
         removido_por_id='11111111-1111-1111-1111-111111111111'
   WHERE id='99999999-9999-4999-8999-999999999991'
$$]);

SELECT espera_erro('documento: remover sem autor', ARRAY[$$
  UPDATE documento SET removido_em=now(), motivo_remocao='enviado por engano'
   WHERE id='99999999-9999-4999-8999-999999999991'
$$]);

SELECT espera_ok('documento: remover com motivo e autor', ARRAY[$$
  UPDATE documento
     SET removido_em=now(), motivo_remocao='enviado no paciente errado',
         removido_por_id='11111111-1111-1111-1111-111111111111'
   WHERE id='99999999-9999-4999-8999-999999999991'
$$]);

SELECT espera_erro('documento: DESFAZER a remoção', ARRAY[$$
  UPDATE documento SET removido_em=NULL
   WHERE id='99999999-9999-4999-8999-999999999991'
$$]);

SELECT espera_erro('documento: reescrever a data de remoção', ARRAY[$$
  UPDATE documento SET removido_em='2020-01-01 00:00:00-03'
   WHERE id='99999999-9999-4999-8999-999999999991'
$$]);

SELECT espera_erro('documento: excluir fisicamente', ARRAY[$$
  DELETE FROM documento WHERE id='99999999-9999-4999-8999-999999999991'
$$]);

SELECT espera_erro('documento: excluir paciente que tem documento', ARRAY[$$
  DELETE FROM paciente WHERE id='33333333-3333-3333-3333-333333333333'
$$]);

-- ── 12. Portal do paciente ──────────────────────────────────────────────────
--
-- O realm exposto: o paciente entra pela internet, sem MFA, de um celular que a
-- clínica não controla. As travas aqui são o que impede um convite eterno e uma
-- sessão que não morre.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('paciente_sessao') IS NULL THEN
    RAISE EXCEPTION 'tabela paciente_sessao não existe — rode as migrations 0012/0013';
  END IF;
END $$;

SET CONSTRAINTS ALL DEFERRED;

-- Segundo paciente criado FORA de qualquer `espera_erro`.
--
-- Isto não é detalhe: `espera_erro` roda num sub-bloco com EXCEPTION, e a exceção
-- desfaz tudo que o bloco fez — inclusive um INSERT auxiliar. Criar o paciente lá
-- dentro fazia o caso "sessão trocar de conta" falhar no INSERT em vez de no
-- UPDATE, e ele "passava" sem testar a trigger. Mesma armadilha do caso 59.
INSERT INTO paciente (id, nome, data_nascimento) VALUES
  ('33333333-3333-3333-3333-333333333335', 'Paciente Portal 2', '1992-02-02');

SELECT espera_ok('portal: criar conta sem senha (aguardando primeiro acesso)', ARRAY[$$
  INSERT INTO paciente_conta (id, paciente_id, email, token_convite_hash, token_convite_expira_em)
  VALUES ('aaaa1111-1111-4111-8111-111111111111',
          '33333333-3333-3333-3333-333333333333',
          'portal-teste@local', repeat('f', 64), now() + interval '7 days')
$$]);

SELECT espera_erro('portal: convite sem prazo de validade', ARRAY[$$
  UPDATE paciente_conta SET token_convite_expira_em = NULL
   WHERE id='aaaa1111-1111-4111-8111-111111111111'
$$]);

SELECT espera_erro('portal: senha sem carimbo de quando foi definida', ARRAY[$$
  UPDATE paciente_conta SET senha_hash='x'
   WHERE id='aaaa1111-1111-4111-8111-111111111111'
$$]);

SELECT espera_erro('portal: definir senha DEIXANDO o convite válido', ARRAY[$$
  UPDATE paciente_conta SET senha_hash='x', senha_definida_em=now()
   WHERE id='aaaa1111-1111-4111-8111-111111111111'
$$]);

SELECT espera_ok('portal: definir senha CONSUMINDO o convite', ARRAY[$$
  UPDATE paciente_conta
     SET senha_hash='x', senha_definida_em=now(),
         token_convite_hash=NULL, token_convite_expira_em=NULL
   WHERE id='aaaa1111-1111-4111-8111-111111111111'
$$]);

SELECT espera_ok('portal: abrir sessão', ARRAY[$$
  INSERT INTO paciente_sessao (id, conta_id, token_hash, expira_em)
  VALUES ('bbbb2222-2222-4222-8222-222222222222',
          'aaaa1111-1111-4111-8111-111111111111',
          repeat('a', 64), now() + interval '12 hours')
$$]);

SELECT espera_erro('portal: sessão que expira antes de nascer', ARRAY[$$
  INSERT INTO paciente_sessao (conta_id, token_hash, expira_em)
  VALUES ('aaaa1111-1111-4111-8111-111111111111', repeat('b', 64), now() - interval '1 hour')
$$]);

SELECT espera_erro('portal: DUAS sessões com o mesmo token', ARRAY[$$
  INSERT INTO paciente_sessao (conta_id, token_hash, expira_em)
  VALUES ('aaaa1111-1111-4111-8111-111111111111', repeat('a', 64), now() + interval '1 hour')
$$]);

SELECT espera_ok('portal: registrar uso da sessão', ARRAY[$$
  UPDATE paciente_sessao SET ultimo_uso_em=now()
   WHERE id='bbbb2222-2222-4222-8222-222222222222'
$$]);

SELECT espera_erro('portal: ESTICAR o prazo da sessão', ARRAY[$$
  UPDATE paciente_sessao SET expira_em=now() + interval '30 days'
   WHERE id='bbbb2222-2222-4222-8222-222222222222'
$$]);

-- A segunda conta existe de verdade antes do caso: senão a falha viria do INSERT
-- e a trigger de troca de conta não seria exercitada.
INSERT INTO paciente_conta (id, paciente_id, email)
VALUES ('aaaa1111-1111-4111-8111-111111111112',
        '33333333-3333-3333-3333-333333333335', 'outro-portal@local');

SELECT espera_erro('portal: sessão trocar de conta (entregaria a sessão a outro paciente)', ARRAY[$$
  UPDATE paciente_sessao SET conta_id='aaaa1111-1111-4111-8111-111111111112'
   WHERE id='bbbb2222-2222-4222-8222-222222222222'
$$]);

SELECT espera_erro('portal: trocar o token de uma sessão existente', ARRAY[$$
  UPDATE paciente_sessao SET token_hash=repeat('c', 64)
   WHERE id='bbbb2222-2222-4222-8222-222222222222'
$$]);

SELECT espera_ok('portal: revogar sessão', ARRAY[$$
  UPDATE paciente_sessao SET revogada_em=now()
   WHERE id='bbbb2222-2222-4222-8222-222222222222'
$$]);

SELECT espera_erro('portal: RESSUSCITAR sessão revogada', ARRAY[$$
  UPDATE paciente_sessao SET revogada_em=NULL
   WHERE id='bbbb2222-2222-4222-8222-222222222222'
$$]);

SELECT espera_erro('portal: dois pacientes com o mesmo e-mail de login', ARRAY[$$
  INSERT INTO paciente_conta (paciente_id, email)
  VALUES ('33333333-3333-3333-3333-333333333335', 'PORTAL-TESTE@local')
$$]);

SELECT espera_erro('portal: duas contas para o mesmo paciente', ARRAY[$$
  INSERT INTO paciente_conta (paciente_id, email)
  VALUES ('33333333-3333-3333-3333-333333333333', 'terceira-conta@local')
$$]);

-- A prova estrutural: os realms não se cruzam. É a decisão 2 do CLAUDE.md
-- verificada por consulta ao catálogo, não por leitura de código.
SELECT espera_ok('portal: NENHUMA FK entre o realm do paciente e "usuario"', ARRAY[$$
  DO $x$
  DECLARE n int;
  BEGIN
    SELECT count(*) INTO n
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_name IN ('paciente_sessao', 'paciente_conta')
       AND ccu.table_name = 'usuario';
    IF n > 0 THEN
      RAISE EXCEPTION 'existe FK entre o realm do paciente e usuario (%)', n;
    END IF;
  END $x$
$$]);

-- ── 13. Convênio: guia, glosa e repasse ─────────────────────────────────────
--
-- Dinheiro que vem de terceiro, com prazo e com direito de recusar. Guia enviada é
-- documento apresentado a outra empresa: o que ela diz não muda depois.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('guia_tiss') IS NULL OR to_regclass('repasse_item') IS NULL THEN
    RAISE EXCEPTION 'tabelas do TISS não existem — rode as migrations 0014/0015/0016';
  END IF;
END $$;

SET CONSTRAINTS ALL DEFERRED;

INSERT INTO convenio (id, nome, registro_ans, prazo_pagamento_dias) VALUES
  ('cccc0000-0000-4000-8000-000000000001', 'Convênio Teste', '123456', 30);

-- Usa o SEGUNDO paciente: o primeiro já tem plano ativo, e a trava da Fase 6
-- (um plano ativo por paciente) recusaria outro — corretamente.
INSERT INTO paciente_convenio (id, paciente_id, convenio_id, numero_carteirinha, adesao_em) VALUES
  ('cccc0000-0000-4000-8000-000000000002',
   '33333333-3333-3333-3333-333333333335',
   'cccc0000-0000-4000-8000-000000000001', 'CART-001', '2025-01-01');

-- Plano com dois itens de CONVÊNIO, para virarem guia.
INSERT INTO plano_tratamento (id, paciente_id, profissional_id, status, titulo) VALUES
  ('dddd0000-0000-4000-8000-000000000001',
   '33333333-3333-3333-3333-333333333335',
   '22222222-2222-2222-2222-222222222221', 'ativo', 'Plano convênio');

INSERT INTO item_plano (id, plano_id, procedimento_id, cobertura, convenio_id, valor, status) VALUES
  ('eeee0000-0000-4000-8000-000000000001', 'dddd0000-0000-4000-8000-000000000001',
   (SELECT id FROM procedimento WHERE codigo = 'DENT-001' AND clinica_id = 'c1111111-1111-1111-1111-111111111111'), 'convenio',
   'cccc0000-0000-4000-8000-000000000001', '100.00', 'executado'),
  ('eeee0000-0000-4000-8000-000000000002', 'dddd0000-0000-4000-8000-000000000001',
   (SELECT id FROM procedimento WHERE codigo = 'DENT-001' AND clinica_id = 'c1111111-1111-1111-1111-111111111111'), 'convenio',
   'cccc0000-0000-4000-8000-000000000001', '100.00', 'executado');

SELECT espera_erro('convênio: item PARTICULAR apontando para guia', ARRAY[$$
  INSERT INTO guia_tiss (id, convenio_id, paciente_id, numero_carteirinha, profissional_id, valor_apresentado)
  VALUES ('ffff0000-0000-4000-8000-000000000001',
          'cccc0000-0000-4000-8000-000000000001',
          '33333333-3333-3333-3333-333333333335', 'CART-001',
          '22222222-2222-2222-2222-222222222221', '100.00')
$$, $$
  INSERT INTO item_plano (id, plano_id, procedimento_id, cobertura, valor, status, guia_tiss_id)
  VALUES ('eeee0000-0000-4000-8000-000000000009',
          'dddd0000-0000-4000-8000-000000000001',
          (SELECT id FROM procedimento WHERE codigo = 'DENT-001' AND clinica_id = 'c1111111-1111-1111-1111-111111111111'),
          'particular', '50.00', 'executado', 'ffff0000-0000-4000-8000-000000000001')
$$]);

SELECT espera_ok('convênio: montar guia rascunho com dois itens', ARRAY[$$
  INSERT INTO guia_tiss (id, convenio_id, paciente_id, numero_carteirinha, profissional_id, valor_apresentado)
  VALUES ('ffff0000-0000-4000-8000-000000000002',
          'cccc0000-0000-4000-8000-000000000001',
          '33333333-3333-3333-3333-333333333335', 'CART-001',
          '22222222-2222-2222-2222-222222222221', '200.00')
$$, $$
  INSERT INTO item_guia (id, guia_id, item_plano_id, descricao, valor_apresentado, data_execucao)
  VALUES ('99990000-0000-4000-8000-000000000001',
          'ffff0000-0000-4000-8000-000000000002',
          'eeee0000-0000-4000-8000-000000000001', 'Procedimento A', '100.00', '2026-06-01'),
         ('99990000-0000-4000-8000-000000000002',
          'ffff0000-0000-4000-8000-000000000002',
          'eeee0000-0000-4000-8000-000000000002', 'Procedimento B', '100.00', '2026-06-02')
$$], true);

SELECT espera_erro('convênio: enviar guia com soma dos itens diferente do total', ARRAY[$$
  UPDATE guia_tiss SET valor_apresentado='999.00', situacao='enviada', enviada_em=now()
   WHERE id='ffff0000-0000-4000-8000-000000000002'
$$], true);

SELECT espera_ok('convênio: enviar a guia', ARRAY[$$
  UPDATE guia_tiss SET situacao='enviada', enviada_em=now(), numero_lote='LOTE-1'
   WHERE id='ffff0000-0000-4000-8000-000000000002'
$$], true);

SELECT espera_erro('convênio: mudar o valor de guia JÁ ENVIADA', ARRAY[$$
  UPDATE guia_tiss SET valor_apresentado='300.00'
   WHERE id='ffff0000-0000-4000-8000-000000000002'
$$]);

SELECT espera_erro('convênio: mudar o paciente de guia enviada', ARRAY[$$
  UPDATE guia_tiss SET paciente_id='33333333-3333-3333-3333-333333333333'
   WHERE id='ffff0000-0000-4000-8000-000000000002'
$$]);

SELECT espera_erro('convênio: reescrever a data de envio', ARRAY[$$
  UPDATE guia_tiss SET enviada_em=now() - interval '10 days'
   WHERE id='ffff0000-0000-4000-8000-000000000002'
$$]);

SELECT espera_ok('convênio: registrar o retorno da operadora', ARRAY[$$
  UPDATE guia_tiss SET situacao='glosada_parcial', retorno_em=now(),
         protocolo_operadora='PROT-9'
   WHERE id='ffff0000-0000-4000-8000-000000000002'
$$]);

SELECT espera_erro('convênio: ACRESCENTAR item a guia já enviada', ARRAY[$$
  INSERT INTO item_guia (guia_id, item_plano_id, descricao, valor_apresentado, data_execucao)
  VALUES ('ffff0000-0000-4000-8000-000000000002',
          'eeee0000-0000-4000-8000-000000000001', 'Extra', '10.00', '2026-06-03')
$$]);

SELECT espera_erro('convênio: alterar valor de item de guia enviada', ARRAY[$$
  UPDATE item_guia SET valor_apresentado='150.00'
   WHERE id='99990000-0000-4000-8000-000000000001'
$$]);

SELECT espera_erro('convênio: excluir item de guia enviada', ARRAY[$$
  DELETE FROM item_guia WHERE id='99990000-0000-4000-8000-000000000001'
$$]);

SELECT espera_ok('convênio: registrar glosa parcial num item', ARRAY[$$
  INSERT INTO glosa (id, item_guia_id, classe, motivo, valor)
  VALUES ('88880000-0000-4000-8000-000000000001',
          '99990000-0000-4000-8000-000000000001',
          'erro_de_envio', 'Dente divergente do informado', '40.00')
$$]);

SELECT espera_erro('convênio: glosa MAIOR que o valor apresentado', ARRAY[$$
  INSERT INTO glosa (item_guia_id, classe, motivo, valor)
  VALUES ('99990000-0000-4000-8000-000000000001', 'valor', 'Excede', '61.00')
$$]);

SELECT espera_erro('convênio: editar glosa registrada', ARRAY[$$
  UPDATE glosa SET valor='10.00' WHERE id='88880000-0000-4000-8000-000000000001'
$$]);

SELECT espera_erro('convênio: excluir glosa', ARRAY[$$
  DELETE FROM glosa WHERE id='88880000-0000-4000-8000-000000000001'
$$]);

SELECT espera_ok('convênio: recorrer da glosa', ARRAY[$$
  INSERT INTO recurso_glosa (glosa_id, argumento)
  VALUES ('88880000-0000-4000-8000-000000000001', 'Dente 36 confere com a radiografia anexa.')
$$]);

SELECT espera_erro('convênio: recurso com resposta pela metade', ARRAY[$$
  INSERT INTO recurso_glosa (glosa_id, argumento, deferido)
  VALUES ('88880000-0000-4000-8000-000000000001', 'Outro argumento', true)
$$]);

-- Repasse e conciliação item a item.
SELECT espera_ok('convênio: registrar repasse e conciliar itens', ARRAY[$$
  INSERT INTO repasse (id, convenio_id, valor_total, recebido_em)
  VALUES ('77770000-0000-4000-8000-000000000001',
          'cccc0000-0000-4000-8000-000000000001', '160.00', '2026-07-15')
$$, $$
  INSERT INTO repasse_item (repasse_id, item_guia_id, valor)
  VALUES ('77770000-0000-4000-8000-000000000001',
          '99990000-0000-4000-8000-000000000001', '60.00'),
         ('77770000-0000-4000-8000-000000000001',
          '99990000-0000-4000-8000-000000000002', '100.00')
$$], true);

SELECT espera_ok('convênio: o banco recalculou o valor pago da guia', ARRAY[$$
  DO $x$ DECLARE v numeric; BEGIN
    SELECT valor_pago INTO v FROM guia_tiss WHERE id='ffff0000-0000-4000-8000-000000000002';
    IF v <> 160.00 THEN RAISE EXCEPTION 'valor_pago ficou % em vez de 160.00', v; END IF;
  END $x$
$$]);

SELECT espera_erro('convênio: conciliar MAIS do que o repasse recebeu', ARRAY[$$
  INSERT INTO repasse (id, convenio_id, valor_total, recebido_em)
  VALUES ('77770000-0000-4000-8000-000000000002',
          'cccc0000-0000-4000-8000-000000000001', '50.00', '2026-07-16')
$$, $$
  INSERT INTO repasse_item (repasse_id, item_guia_id, valor)
  VALUES ('77770000-0000-4000-8000-000000000002',
          '99990000-0000-4000-8000-000000000001', '80.00')
$$], true);

SELECT espera_erro('convênio: o mesmo item recebendo duas vezes do mesmo repasse', ARRAY[$$
  INSERT INTO repasse_item (repasse_id, item_guia_id, valor)
  VALUES ('77770000-0000-4000-8000-000000000001',
          '99990000-0000-4000-8000-000000000001', '10.00')
$$]);

SELECT espera_ok('convênio: fechar o repasse', ARRAY[$$
  UPDATE repasse SET fechado_em=now() WHERE id='77770000-0000-4000-8000-000000000001'
$$]);

SELECT espera_erro('convênio: mexer na conciliação de repasse FECHADO', ARRAY[$$
  DELETE FROM repasse_item
   WHERE repasse_id='77770000-0000-4000-8000-000000000001'
     AND item_guia_id='99990000-0000-4000-8000-000000000002'
$$]);

SELECT espera_erro('convênio: dois itens iguais na mesma guia e tentativa', ARRAY[$$
  INSERT INTO guia_tiss (id, convenio_id, paciente_id, numero_carteirinha, profissional_id, valor_apresentado)
  VALUES ('ffff0000-0000-4000-8000-000000000003',
          'cccc0000-0000-4000-8000-000000000001',
          '33333333-3333-3333-3333-333333333335', 'CART-001',
          '22222222-2222-2222-2222-222222222221', '200.00')
$$, $$
  INSERT INTO item_guia (guia_id, item_plano_id, descricao, valor_apresentado, data_execucao)
  VALUES ('ffff0000-0000-4000-8000-000000000003',
          'eeee0000-0000-4000-8000-000000000001', 'A', '100.00', '2026-06-01'),
         ('ffff0000-0000-4000-8000-000000000003',
          'eeee0000-0000-4000-8000-000000000001', 'A de novo', '100.00', '2026-06-01')
$$]);

SELECT espera_erro('convênio: dois convênios com o mesmo nome', ARRAY[$$
  INSERT INTO convenio (nome) VALUES ('Convênio Teste')
$$]);

SELECT espera_erro('convênio: mesma carteirinha duas vezes na operadora', ARRAY[$$
  INSERT INTO paciente_convenio (paciente_id, convenio_id, numero_carteirinha)
  VALUES ('33333333-3333-3333-3333-333333333333',
          'cccc0000-0000-4000-8000-000000000001', 'CART-001')
$$]);

SELECT espera_erro('convênio: cobertura fora da faixa de 0 a 100', ARRAY[$$
  INSERT INTO preco_convenio (convenio_id, procedimento_id, valor, cobertura_pct, vigencia_inicio)
  VALUES ('cccc0000-0000-4000-8000-000000000001',
          (SELECT id FROM procedimento WHERE codigo = 'DENT-001' AND clinica_id = 'c1111111-1111-1111-1111-111111111111'), '100.00', '120', '2026-01-01')
$$]);

SELECT espera_erro('convênio: vigência com fim antes do início', ARRAY[$$
  INSERT INTO preco_convenio (convenio_id, procedimento_id, valor, vigencia_inicio, vigencia_fim)
  VALUES ('cccc0000-0000-4000-8000-000000000001',
          (SELECT id FROM procedimento WHERE codigo = 'DENT-001' AND clinica_id = 'c1111111-1111-1111-1111-111111111111'), '100.00', '2026-06-01', '2026-01-01')
$$]);

-- ── 14. Estoque: saldo derivado, FEFO e append-only ─────────────────────────
--
-- Saldo de estoque é como saldo de caixa: se puder ser digitado, ele mente. As
-- travas abaixo garantem que ele só muda por movimento, que o movimento nunca
-- some, e que material vencido não vai para a boca de ninguém.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('material') IS NULL OR to_regclass('lote_material') IS NULL
     OR to_regclass('movimento_estoque') IS NULL THEN
    RAISE EXCEPTION 'tabelas do estoque não existem — rode as migrations 0018/0019';
  END IF;
  IF to_regprocedure('hoje_na_clinica()') IS NULL THEN
    RAISE EXCEPTION 'função hoje_na_clinica() não existe — falta a migration 0019';
  END IF;
END $$;

SET CONSTRAINTS ALL DEFERRED;

-- Materiais de teste: um comum, um com rastreabilidade obrigatória, um controlado.
INSERT INTO material (id, codigo, nome, categoria, unidade, quantidade_minima) VALUES
  ('aaaa1400-0000-4000-8000-000000000001', 'TST-COMUM', 'Material comum de teste',
   'descartavel', 'unidade', '10');

INSERT INTO material (id, codigo, nome, categoria, unidade, exige_lote_do_fabricante) VALUES
  ('aaaa1400-0000-4000-8000-000000000002', 'TST-RASTREIO', 'Implante de teste',
   'cirurgia', 'unidade', true);

INSERT INTO material (id, codigo, nome, categoria, unidade, controlado, exige_lote_do_fabricante) VALUES
  ('aaaa1400-0000-4000-8000-000000000003', 'TST-CONTROLADO', 'Sedativo de teste',
   'medicamento', 'unidade', true, true);

-- Lote com validade LONGE e 10 unidades.
INSERT INTO lote_material (id, material_id, codigo_fabricante, validade, custo_unitario, recebido_em)
VALUES ('bbbb1400-0000-4000-8000-000000000001', 'aaaa1400-0000-4000-8000-000000000001',
        'L-OK', '2030-01-01', '2.50', '2026-01-10');

INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade, custo_unitario)
VALUES ('bbbb1400-0000-4000-8000-000000000001', 'aaaa1400-0000-4000-8000-000000000001',
        'entrada', '10.000', '2.50');

-- Lote JÁ VENCIDO, com saldo — o caso que a clínica de verdade tem na gaveta.
INSERT INTO lote_material (id, material_id, codigo_fabricante, validade, custo_unitario, recebido_em)
VALUES ('bbbb1400-0000-4000-8000-000000000002', 'aaaa1400-0000-4000-8000-000000000001',
        'L-VENCIDO', '2020-01-01', '2.50', '2019-06-01');

INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade, custo_unitario)
VALUES ('bbbb1400-0000-4000-8000-000000000002', 'aaaa1400-0000-4000-8000-000000000001',
        'entrada', '5.000', '2.50');

-- A entrada realmente virou saldo? Se não, os casos abaixo passariam por falta
-- de saldo e não pela invariante que se quer provar.
SELECT espera_ok('estoque: entrada de 10 deixou saldo 10 (saldo é derivado)', ARRAY[$$
  DO $x$
  BEGIN
    IF (SELECT saldo FROM lote_material WHERE id = 'bbbb1400-0000-4000-8000-000000000001')
       <> 10.000 THEN
      RAISE EXCEPTION 'saldo não acompanhou a entrada';
    END IF;
  END $x$
$$]);

SELECT espera_erro('estoque: consumir mais do que o lote tem', ARRAY[$$
  INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade)
  VALUES ('bbbb1400-0000-4000-8000-000000000001', 'aaaa1400-0000-4000-8000-000000000001',
          'consumo', '-11.000')
$$]);

SELECT espera_ok('estoque: consumir exatamente o saldo é permitido', ARRAY[$$
  INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade)
  VALUES ('bbbb1400-0000-4000-8000-000000000001', 'aaaa1400-0000-4000-8000-000000000001',
          'consumo', '-10.000')
$$, $$
  INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade)
  VALUES ('bbbb1400-0000-4000-8000-000000000001', 'aaaa1400-0000-4000-8000-000000000001',
          'entrada', '10.000')
$$]);

SELECT espera_erro('estoque: consumir de lote VENCIDO', ARRAY[$$
  INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade)
  VALUES ('bbbb1400-0000-4000-8000-000000000002', 'aaaa1400-0000-4000-8000-000000000001',
          'consumo', '-1.000')
$$]);

SELECT espera_ok('estoque: DESCARTAR lote vencido é o caminho certo', ARRAY[$$
  INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade, motivo)
  VALUES ('bbbb1400-0000-4000-8000-000000000002', 'aaaa1400-0000-4000-8000-000000000001',
          'descarte', '-5.000', 'vencido em 2020 — descarte de inventário')
$$]);

SELECT espera_erro('estoque: entrada com quantidade negativa', ARRAY[$$
  INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade)
  VALUES ('bbbb1400-0000-4000-8000-000000000001', 'aaaa1400-0000-4000-8000-000000000001',
          'entrada', '-1.000')
$$]);

SELECT espera_erro('estoque: consumo com quantidade positiva', ARRAY[$$
  INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade)
  VALUES ('bbbb1400-0000-4000-8000-000000000001', 'aaaa1400-0000-4000-8000-000000000001',
          'consumo', '1.000')
$$]);

SELECT espera_erro('estoque: movimento de quantidade zero', ARRAY[$$
  INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade)
  VALUES ('bbbb1400-0000-4000-8000-000000000001', 'aaaa1400-0000-4000-8000-000000000001',
          'ajuste', '0.000')
$$]);

SELECT espera_erro('estoque: ajuste sem motivo', ARRAY[$$
  INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade)
  VALUES ('bbbb1400-0000-4000-8000-000000000001', 'aaaa1400-0000-4000-8000-000000000001',
          'ajuste', '1.000')
$$]);

SELECT espera_erro('estoque: descarte sem motivo', ARRAY[$$
  INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade)
  VALUES ('bbbb1400-0000-4000-8000-000000000001', 'aaaa1400-0000-4000-8000-000000000001',
          'descarte', '-1.000')
$$]);

SELECT espera_erro('estoque: movimento apontando para lote de OUTRO material', ARRAY[$$
  INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade)
  VALUES ('bbbb1400-0000-4000-8000-000000000001', 'aaaa1400-0000-4000-8000-000000000002',
          'entrada', '1.000')
$$]);

-- ── O livro é append-only ──────────────────────────────────────────────────
SELECT espera_erro('estoque: alterar movimento já lançado', ARRAY[$$
  UPDATE movimento_estoque SET quantidade = '-999.000'
   WHERE lote_id = 'bbbb1400-0000-4000-8000-000000000001'
$$]);

SELECT espera_erro('estoque: excluir movimento', ARRAY[$$
  DELETE FROM movimento_estoque
   WHERE lote_id = 'bbbb1400-0000-4000-8000-000000000001'
$$]);

-- ── Saldo não se digita ────────────────────────────────────────────────────
SELECT espera_erro('estoque: digitar saldo direto no lote', ARRAY[$$
  UPDATE lote_material SET saldo = '999.000'
   WHERE id = 'bbbb1400-0000-4000-8000-000000000001'
$$], true);

SELECT espera_erro('estoque: zerar saldo por UPDATE (some com o histórico)', ARRAY[$$
  UPDATE lote_material SET saldo = '0.000'
   WHERE id = 'bbbb1400-0000-4000-8000-000000000001'
$$], true);

-- ── Rastreabilidade ────────────────────────────────────────────────────────
SELECT espera_erro('estoque: lote de implante sem número do fabricante', ARRAY[$$
  INSERT INTO lote_material (material_id, validade, custo_unitario, recebido_em)
  VALUES ('aaaa1400-0000-4000-8000-000000000002', '2030-01-01', '900.00', '2026-01-10')
$$]);

SELECT espera_erro('estoque: lote de implante com número em branco', ARRAY[$$
  INSERT INTO lote_material (material_id, codigo_fabricante, validade, custo_unitario, recebido_em)
  VALUES ('aaaa1400-0000-4000-8000-000000000002', '   ', '2030-01-01', '900.00', '2026-01-10')
$$]);

SELECT espera_ok('estoque: material comum aceita lote sem número do fabricante', ARRAY[$$
  INSERT INTO lote_material (material_id, custo_unitario, recebido_em)
  VALUES ('aaaa1400-0000-4000-8000-000000000001', '2.50', '2026-01-10')
$$]);

SELECT espera_erro('estoque: lote trocar de material', ARRAY[$$
  UPDATE lote_material SET material_id = 'aaaa1400-0000-4000-8000-000000000002'
   WHERE id = 'bbbb1400-0000-4000-8000-000000000001'
$$]);

-- ── Material controlado (Portaria 344/98) ──────────────────────────────────
INSERT INTO lote_material (id, material_id, codigo_fabricante, validade, custo_unitario, recebido_em)
VALUES ('bbbb1400-0000-4000-8000-000000000003', 'aaaa1400-0000-4000-8000-000000000003',
        'L-CTRL', '2029-01-01', '15.00', '2026-01-10');

INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade, custo_unitario)
VALUES ('bbbb1400-0000-4000-8000-000000000003', 'aaaa1400-0000-4000-8000-000000000003',
        'entrada', '10.000', '15.00');

SELECT espera_erro('estoque: saída de controlado sem responsável', ARRAY[$$
  INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade, motivo)
  VALUES ('bbbb1400-0000-4000-8000-000000000003', 'aaaa1400-0000-4000-8000-000000000003',
          'consumo', '-1.000', 'sedação consciente')
$$]);

SELECT espera_erro('estoque: saída de controlado sem motivo', ARRAY[$$
  INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade, profissional_id)
  VALUES ('bbbb1400-0000-4000-8000-000000000003', 'aaaa1400-0000-4000-8000-000000000003',
          'consumo', '-1.000', '22222222-2222-2222-2222-222222222221')
$$]);

SELECT espera_ok('estoque: saída de controlado COM responsável e motivo', ARRAY[$$
  INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade, profissional_id, motivo)
  VALUES ('bbbb1400-0000-4000-8000-000000000003', 'aaaa1400-0000-4000-8000-000000000003',
          'consumo', '-1.000', '22222222-2222-2222-2222-222222222221',
          'sedação consciente — paciente Teste')
$$]);

SELECT espera_ok('estoque: ENTRADA de controlado não exige responsável (a nota é a prova)', ARRAY[$$
  INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade, custo_unitario)
  VALUES ('bbbb1400-0000-4000-8000-000000000003', 'aaaa1400-0000-4000-8000-000000000003',
          'entrada', '5.000', '15.00')
$$]);

-- ── Rastreabilidade do consumo até a execução ──────────────────────────────
-- A execução é criada AQUI, fora de qualquer espera_erro. Um `SELECT id FROM
-- execucao LIMIT 1` dependeria de dado pré-existente: em base limpa daria NULL,
-- o CHECK `execucao_id is null or tipo = 'consumo'` passaria e o caso reprovaria
-- (ou, pior, um dia passaria pelo motivo errado). Fixture explícito, sempre.
INSERT INTO execucao (id, item_plano_id, profissional_id, executado_em) VALUES
  ('ee141400-0000-4000-8000-000000000001',
   'eeee0000-0000-4000-8000-000000000001',
   '22222222-2222-2222-2222-222222222221', '2026-07-20 10:00:00-03');

SELECT espera_erro('estoque: descarte apontando para execução (descarte não tem paciente)', ARRAY[$$
  INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade, motivo, execucao_id)
  VALUES ('bbbb1400-0000-4000-8000-000000000001', 'aaaa1400-0000-4000-8000-000000000001',
          'descarte', '-1.000', 'caiu no chão', 'ee141400-0000-4000-8000-000000000001')
$$]);

-- Contraprova: sem ela, o caso acima poderia estar passando porque nenhum
-- movimento aceita execucao_id — e a rastreabilidade do consumo, que é o motivo
-- de a coluna existir, estaria quebrada sem ninguém notar.
SELECT espera_ok('estoque: consumo APONTANDO para a execução é o caminho da rastreabilidade', ARRAY[$$
  INSERT INTO movimento_estoque (lote_id, material_id, tipo, quantidade, execucao_id, profissional_id)
  VALUES ('bbbb1400-0000-4000-8000-000000000001', 'aaaa1400-0000-4000-8000-000000000001',
          'consumo', '-2.000', 'ee141400-0000-4000-8000-000000000001',
          '22222222-2222-2222-2222-222222222221')
$$]);

-- E o elo funciona no sentido em que a clínica precisa dele: recolhimento de
-- lote → em quem foi usado.
SELECT espera_ok('estoque: lote recolhido responde em qual paciente foi usado', ARRAY[$$
  DO $x$
  DECLARE n int;
  BEGIN
    SELECT count(DISTINCT pt.paciente_id) INTO n
      FROM movimento_estoque m
      JOIN execucao e   ON e.id = m.execucao_id
      JOIN item_plano i ON i.id = e.item_plano_id
      JOIN plano_tratamento pt ON pt.id = i.plano_id
     WHERE m.lote_id = 'bbbb1400-0000-4000-8000-000000000001'
       AND m.tipo = 'consumo';
    IF n < 1 THEN
      RAISE EXCEPTION 'o consumo do lote não chega a nenhum paciente — rastreabilidade furada';
    END IF;
  END $x$
$$]);

SELECT espera_erro('estoque: ficha técnica com quantidade zero', ARRAY[$$
  INSERT INTO insumo_procedimento (procedimento_id, material_id, quantidade)
  VALUES ((SELECT id FROM procedimento WHERE codigo = 'DENT-001' AND clinica_id = 'c1111111-1111-1111-1111-111111111111'), 'aaaa1400-0000-4000-8000-000000000001', '0')
$$]);

SELECT espera_erro('estoque: mesmo material duas vezes na ficha do procedimento', ARRAY[$$
  INSERT INTO insumo_procedimento (procedimento_id, material_id, quantidade)
  VALUES ((SELECT id FROM procedimento WHERE codigo = 'DENT-001' AND clinica_id = 'c1111111-1111-1111-1111-111111111111'), 'aaaa1400-0000-4000-8000-000000000001', '1')
$$, $$
  INSERT INTO insumo_procedimento (procedimento_id, material_id, quantidade)
  VALUES ((SELECT id FROM procedimento WHERE codigo = 'DENT-001' AND clinica_id = 'c1111111-1111-1111-1111-111111111111'), 'aaaa1400-0000-4000-8000-000000000001', '2')
$$]);

SELECT espera_erro('estoque: mínimo negativo no material', ARRAY[$$
  INSERT INTO material (codigo, nome, categoria, unidade, quantidade_minima)
  VALUES ('TST-NEG', 'Mínimo negativo', 'descartavel', 'unidade', '-1')
$$]);

SELECT espera_erro('estoque: embalagem com zero unidades', ARRAY[$$
  INSERT INTO material (codigo, nome, categoria, unidade, unidades_por_embalagem)
  VALUES ('TST-EMB', 'Embalagem zero', 'descartavel', 'unidade', 0)
$$]);

SELECT espera_erro('estoque: custo de lote negativo', ARRAY[$$
  INSERT INTO lote_material (material_id, custo_unitario, recebido_em)
  VALUES ('aaaa1400-0000-4000-8000-000000000001', '-1.00', '2026-01-10')
$$]);

-- ── 15. Administração: cadastros com tela ───────────────────────────────────
--
-- Cadastro que ganhou tela ganhou também a chance de trancar a clínica fora do
-- sistema e de reescrever preço já faturado. As travas de drizzle/0021.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('usuario_exige_admin_ativo()') IS NULL
     OR to_regprocedure('preco_convenio_so_fecha()') IS NULL THEN
    RAISE EXCEPTION 'travas da administração não existem — rode a migration 0021';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'usuario' AND column_name = 'senha_temporaria') THEN
    RAISE EXCEPTION 'coluna usuario.senha_temporaria não existe — falta a migration 0020';
  END IF;
END $$;

SET CONSTRAINTS ALL DEFERRED;

-- Dois admins, para poder provar os dois lados da regra.
INSERT INTO usuario (id, nome, email, senha_hash, perfil) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'Admin Um',  'admin1@teste.local', 'x', 'admin'),
  ('a0000000-0000-4000-8000-000000000002', 'Admin Dois','admin2@teste.local', 'x', 'admin');

-- O seed cria `admin@local`. Sem desativá-lo, "último admin ativo" nunca é
-- alcançado e os três casos abaixo passariam por não exercitar a regra —
-- exatamente o tipo de verde que não prova nada. Fica FORA de espera_erro para
-- não ser desfeito pelo rollback do caso.
UPDATE usuario SET ativo = false
 WHERE perfil = 'admin'
   AND id NOT IN ('a0000000-0000-4000-8000-000000000001',
                  'a0000000-0000-4000-8000-000000000002');

SELECT espera_ok('admin: desativar um admin havendo outro ativo', ARRAY[$$
  UPDATE usuario SET ativo = false WHERE id = 'a0000000-0000-4000-8000-000000000002'
$$]);

SELECT espera_erro('admin: desativar o ÚLTIMO admin ativo', ARRAY[$$
  UPDATE usuario SET ativo = false WHERE id = 'a0000000-0000-4000-8000-000000000001'
$$]);

SELECT espera_erro('admin: rebaixar o ÚLTIMO admin ativo', ARRAY[$$
  UPDATE usuario SET perfil = 'recepcao' WHERE id = 'a0000000-0000-4000-8000-000000000001'
$$]);

SELECT espera_erro('admin: apagar o ÚLTIMO admin ativo', ARRAY[$$
  DELETE FROM usuario WHERE id = 'a0000000-0000-4000-8000-000000000001'
$$]);

-- Admin inativo não é reserva: reativar o segundo é o que libera desativar o primeiro.
SELECT espera_ok('admin: reativar o segundo libera desativar o primeiro', ARRAY[$$
  UPDATE usuario SET ativo = true WHERE id = 'a0000000-0000-4000-8000-000000000002'
$$, $$
  UPDATE usuario SET ativo = false WHERE id = 'a0000000-0000-4000-8000-000000000001'
$$, $$
  UPDATE usuario SET ativo = true WHERE id = 'a0000000-0000-4000-8000-000000000001'
$$]);

-- ── Dentista exige profissional ────────────────────────────────────────────
SELECT espera_erro('usuário: perfil dentista ATIVO sem cadastro de profissional', ARRAY[$$
  INSERT INTO usuario (id, nome, email, senha_hash, perfil)
  VALUES ('a0000000-0000-4000-8000-000000000003', 'Dr. Sem CRO',
          'semcro@teste.local', 'x', 'dentista')
$$], true);

SELECT espera_ok('usuário: dentista COM profissional na mesma transação', ARRAY[$$
  INSERT INTO usuario (id, nome, email, senha_hash, perfil)
  VALUES ('a0000000-0000-4000-8000-000000000004', 'Dra. Com CRO',
          'comcro@teste.local', 'x', 'dentista')
$$, $$
  INSERT INTO profissional (usuario_id, cro, uf_cro)
  VALUES ('a0000000-0000-4000-8000-000000000004', 'T9001', 'SP')
$$], true);

SELECT espera_ok('usuário: dentista INATIVO não precisa de profissional (desligamento)', ARRAY[$$
  INSERT INTO usuario (id, nome, email, senha_hash, perfil, ativo)
  VALUES ('a0000000-0000-4000-8000-000000000005', 'Dr. Desligado',
          'desligado@teste.local', 'x', 'dentista', false)
$$], true);

-- ── Tabela negociada ───────────────────────────────────────────────────────
INSERT INTO preco_convenio (id, convenio_id, procedimento_id, valor, vigencia_inicio)
VALUES ('b0000000-0000-4000-8000-000000000001',
        'cccc0000-0000-4000-8000-000000000001',
        (SELECT id FROM procedimento WHERE codigo = 'DENT-001' AND clinica_id = 'c1111111-1111-1111-1111-111111111111'),
        '100.00', '2025-01-01');

SELECT espera_erro('convênio: duas vigências ABERTAS para o mesmo procedimento', ARRAY[$$
  INSERT INTO preco_convenio (convenio_id, procedimento_id, valor, vigencia_inicio)
  VALUES ('cccc0000-0000-4000-8000-000000000001',
          (SELECT id FROM procedimento WHERE codigo = 'DENT-001' AND clinica_id = 'c1111111-1111-1111-1111-111111111111'),
          '120.00', '2026-01-01')
$$]);

SELECT espera_erro('convênio: vigência nova sobrepondo período fechado', ARRAY[$$
  UPDATE preco_convenio SET vigencia_fim = '2025-12-31'
   WHERE id = 'b0000000-0000-4000-8000-000000000001'
$$, $$
  INSERT INTO preco_convenio (convenio_id, procedimento_id, valor, vigencia_inicio, vigencia_fim)
  VALUES ('cccc0000-0000-4000-8000-000000000001',
          (SELECT id FROM procedimento WHERE codigo = 'DENT-001' AND clinica_id = 'c1111111-1111-1111-1111-111111111111'),
          '120.00', '2025-06-01', '2025-08-31')
$$]);

SELECT espera_ok('convênio: fechar a vigência e abrir a seguinte no dia seguinte', ARRAY[$$
  UPDATE preco_convenio SET vigencia_fim = '2025-12-31'
   WHERE id = 'b0000000-0000-4000-8000-000000000001'
$$, $$
  INSERT INTO preco_convenio (id, convenio_id, procedimento_id, valor, vigencia_inicio)
  VALUES ('b0000000-0000-4000-8000-000000000002',
          'cccc0000-0000-4000-8000-000000000001',
          (SELECT id FROM procedimento WHERE codigo = 'DENT-001' AND clinica_id = 'c1111111-1111-1111-1111-111111111111'),
          '120.00', '2026-01-01')
$$]);

SELECT espera_erro('convênio: alterar o VALOR de um preço', ARRAY[$$
  UPDATE preco_convenio SET valor = '999.00'
   WHERE id = 'b0000000-0000-4000-8000-000000000002'
$$]);

SELECT espera_erro('convênio: alterar a cobertura de um preço', ARRAY[$$
  UPDATE preco_convenio SET cobertura_pct = '50'
   WHERE id = 'b0000000-0000-4000-8000-000000000002'
$$]);

SELECT espera_erro('convênio: mover o início da vigência', ARRAY[$$
  UPDATE preco_convenio SET vigencia_inicio = '2025-06-01'
   WHERE id = 'b0000000-0000-4000-8000-000000000002'
$$]);

SELECT espera_ok('convênio: FECHAR a vigência é a única edição permitida', ARRAY[$$
  UPDATE preco_convenio SET vigencia_fim = '2026-12-31'
   WHERE id = 'b0000000-0000-4000-8000-000000000002'
$$]);

SELECT espera_ok('convênio: apagar preço que nunca foi faturado', ARRAY[$$
  INSERT INTO preco_convenio (id, convenio_id, procedimento_id, valor, vigencia_inicio)
  VALUES ('b0000000-0000-4000-8000-000000000003',
          'cccc0000-0000-4000-8000-000000000001',
          (SELECT id FROM procedimento WHERE codigo = 'DENT-002' AND clinica_id = 'c1111111-1111-1111-1111-111111111111'),
          '80.00', '2030-01-01')
$$, $$
  DELETE FROM preco_convenio WHERE id = 'b0000000-0000-4000-8000-000000000003'
$$]);

-- Guia com um item executado DENTRO da vigência de 2025, para provar que
-- preço já faturado não se apaga. Criada fora de espera_erro: dentro, o
-- rollback levaria a guia e o caso passaria pelo motivo errado.
INSERT INTO guia_tiss (id, convenio_id, paciente_id, numero_carteirinha,
                       profissional_id, valor_apresentado, situacao)
VALUES ('c0000000-0000-4000-8000-000000000001',
        'cccc0000-0000-4000-8000-000000000001',
        '33333333-3333-3333-3333-333333333335', 'CART-001',
        '22222222-2222-2222-2222-222222222221', '100.00', 'rascunho');

-- O item de plano tem de ser do MESMO procedimento do preço (DENT-001): os itens
-- da seção do TISS usam `procedimento LIMIT 1`, que é arbitrário, e com outro
-- procedimento o gatilho não encontraria faturamento — o caso passaria por não
-- exercitar a regra.
INSERT INTO item_plano (id, plano_id, procedimento_id, cobertura, convenio_id, valor, status)
VALUES ('e1000000-0000-4000-8000-000000000001',
        'dddd0000-0000-4000-8000-000000000001',
        (SELECT id FROM procedimento WHERE codigo = 'DENT-001' AND clinica_id = 'c1111111-1111-1111-1111-111111111111'),
        'convenio', 'cccc0000-0000-4000-8000-000000000001', '100.00', 'executado');

INSERT INTO item_guia (guia_id, item_plano_id, descricao, data_execucao, valor_apresentado)
VALUES ('c0000000-0000-4000-8000-000000000001',
        'e1000000-0000-4000-8000-000000000001',
        'Restauração', '2025-07-15', '100.00');

SELECT espera_erro('convênio: apagar preço JÁ FATURADO (é o histórico do apresentado)', ARRAY[$$
  DELETE FROM preco_convenio WHERE id = 'b0000000-0000-4000-8000-000000000001'
$$]);

-- ── Carteirinha ────────────────────────────────────────────────────────────
SELECT espera_erro('carteirinha: duas ATIVAS do mesmo paciente na mesma operadora', ARRAY[$$
  INSERT INTO paciente_convenio (paciente_id, convenio_id, numero_carteirinha)
  VALUES ('33333333-3333-3333-3333-333333333335',
          'cccc0000-0000-4000-8000-000000000001', 'CART-999')
$$]);

SELECT espera_ok('carteirinha: nova ativa depois de inativar a anterior', ARRAY[$$
  UPDATE paciente_convenio SET ativo = false
   WHERE id = 'cccc0000-0000-4000-8000-000000000002'
$$, $$
  INSERT INTO paciente_convenio (paciente_id, convenio_id, numero_carteirinha)
  VALUES ('33333333-3333-3333-3333-333333333335',
          'cccc0000-0000-4000-8000-000000000001', 'CART-998')
$$]);

-- ── Cadeira ────────────────────────────────────────────────────────────────
-- O agendamento entra FORA do caso. Criá-lo dentro escondeu um bug real: a
-- trigger comparava com o status 'falta', que não existe no enum ('faltou'), e o
-- 22P02 fazia o espera_erro "passar" sem nunca chegar à regra da cadeira.
INSERT INTO agendamento (id, paciente_id, profissional_id, cadeira_id, inicio, fim)
VALUES ('a5000000-0000-4000-8000-000000000001',
        '33333333-3333-3333-3333-333333333333',
        '22222222-2222-2222-2222-222222222222',
        '44444444-4444-4444-4444-444444444442',
        now() + interval '3 days', now() + interval '3 days 1 hour');

SELECT espera_erro('cadeira: desativar com agendamento futuro', ARRAY[$$
  UPDATE cadeira SET ativo = false WHERE id = '44444444-4444-4444-4444-444444444442'
$$]);

SELECT espera_ok('cadeira: agendamento CANCELADO não impede desativar', ARRAY[$$
  UPDATE agendamento SET status = 'cancelado', motivo_cancelamento = 'teste'
   WHERE id = 'a5000000-0000-4000-8000-000000000001'
$$, $$
  UPDATE cadeira SET ativo = false WHERE id = '44444444-4444-4444-4444-444444444442'
$$]);

SELECT espera_ok('cadeira: desativar cadeira livre', ARRAY[$$
  INSERT INTO cadeira (id, nome) VALUES
    ('44444444-4444-4444-4444-444444444443', 'Cadeira Livre Teste')
$$, $$
  UPDATE cadeira SET ativo = false WHERE id = '44444444-4444-4444-4444-444444444443'
$$]);

-- ════════════════════════════════════════════════════════════════════════════
-- Multi-tenant (drizzle/0022)
--
-- É a seção que dá valor à Fase 17. Sem ela, "isolamento entre clínicas" é uma
-- afirmação sobre código, e este arquivo existe justamente porque afirmação sobre
-- código não vale nada quando a aplicação está com bug.
--
-- O que NÃO está aqui, e por quê: as políticas de Row Level Security e o FK
-- composto `(pai_id, clinica_id)` são da `drizzle/0023`, que não existia quando
-- estes casos foram escritos. Ver o fim da seção — há um caso que documenta,
-- com prova, o que continua NÃO travado até ela entrar.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regprocedure('app_clinica_id()') IS NULL THEN
    RAISE EXCEPTION 'função app_clinica_id() não existe — falta a migration 0022';
  END IF;
  IF to_regprocedure('proximo_numero(text)') IS NULL THEN
    RAISE EXCEPTION 'função proximo_numero(text) não existe — falta a migration 0022';
  END IF;
  -- A forma de UM argumento é a que as triggers usam. Se só a de zero existir, o
  -- fuso da validade de lote voltou a sair de uma clínica arbitrária.
  IF to_regprocedure('hoje_na_clinica(uuid)') IS NULL THEN
    RAISE EXCEPTION 'hoje_na_clinica(uuid) não existe — a 0022 não foi aplicada por inteiro';
  END IF;
  IF to_regclass('contador') IS NULL THEN
    RAISE EXCEPTION 'tabela contador não existe — falta a migration 0022';
  END IF;
END $$;

-- ── O contexto é obrigatório, e a mensagem tem de ensinar ───────────────────
SELECT espera_erro_dizendo('tenant: escrever SEM contexto de clínica estoura', ARRAY[$$
  DO $x$ BEGIN
    PERFORM set_config('app.clinica_id', '', true);
    INSERT INTO paciente (nome, data_nascimento) VALUES ('Sem Tenant', '1990-01-01');
  END $x$
$$], 'Sem contexto de clínica');

-- O sub-bloco acima abortou, então o `set_config` dele foi desfeito junto. Mas
-- não se confia nisso de graça: o caso seguinte prova que o contexto voltou.
SELECT confere('tenant: contexto sobrevive ao caso anterior (o rollback o restaurou)',
  app_clinica_id() = 'c1111111-1111-1111-1111-111111111111',
  'app_clinica_id() = ' || app_clinica_id()::text);

-- ── O DEFAULT pega o contexto, sem ninguém passar o tenant ─────────────────
-- É a garantia que dispensou tocar em ~114 pontos de escrita. Se ela cair, os
-- INSERTs do sistema continuam funcionando e passam a gravar na clínica errada.
DO $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO paciente (nome, data_nascimento) VALUES ('Herda Tenant', '1990-01-01')
    RETURNING id INTO v_id;
  PERFORM confere('tenant: clinica_id vem do DEFAULT, sem o INSERT mencioná-lo',
    (SELECT clinica_id FROM paciente WHERE id = v_id) = 'c1111111-1111-1111-1111-111111111111',
    'gravou ' || (SELECT clinica_id FROM paciente WHERE id = v_id)::text);
END $$;

SELECT espera_erro('tenant: clinica_id NOT NULL não aceita nulo explícito', ARRAY[$$
  INSERT INTO paciente (clinica_id, nome, data_nascimento)
  VALUES (NULL, 'Nulo Explícito', '1990-01-01')
$$]);

SELECT espera_erro('tenant: clinica_id de clínica inexistente é recusado pela FK', ARRAY[$$
  INSERT INTO paciente (clinica_id, nome, data_nascimento)
  VALUES ('c9999999-9999-9999-9999-999999999999', 'Clínica Fantasma', '1990-01-01')
$$]);

SELECT espera_erro('tenant: apagar clínica com dado dentro (guarda de 20 anos, CFO)', ARRAY[$$
  DELETE FROM clinica WHERE id = 'c1111111-1111-1111-1111-111111111111'
$$]);

-- ── Numeração por clínica ──────────────────────────────────────────────────
-- Duas coisas ao mesmo tempo: cada clínica numera do 1, e transação abortada
-- DEVOLVE o número. A segunda é o ganho sobre a sequence global, que queimava o
-- número — e a `drizzle/0014` documentava esse buraco como perda aceitável.
DO $$
DECLARE a1 bigint; b1 bigint; a2 bigint; a3 bigint;
BEGIN
  a1 := proximo_numero('orcamento');

  PERFORM set_config('app.clinica_id', 'c2222222-2222-2222-2222-222222222222', true);
  b1 := proximo_numero('orcamento');
  PERFORM set_config('app.clinica_id', 'c1111111-1111-1111-1111-111111111111', true);

  PERFORM confere('numeração: cada clínica começa no 1 (o buraco delataria a outra)',
    a1 = 1 AND b1 = 1, format('A=%s B=%s', a1, b1));

  -- Sub-bloco que aborta: emula a transação que pega o número e desiste.
  BEGIN
    a2 := proximo_numero('orcamento');
    RAISE EXCEPTION 'abortar de propósito';
  EXCEPTION WHEN others THEN
    NULL;  -- o efeito no contador é desfeito; a variável guarda o que ele deu
  END;

  a3 := proximo_numero('orcamento');
  PERFORM confere('numeração: transação abortada DEVOLVE o número (sem buraco)',
    a2 = 2 AND a3 = 2, format('abortado pegou %s, seguinte pegou %s', a2, a3));

  -- Contado entre as DUAS clínicas de teste, não no banco todo. A primeira versão
  -- media `count(*)` global e esperava 2: passou no banco de teste (onde só existiam
  -- A e B) e reprovou no banco de desenvolvimento, que já tinha contador semeado
  -- pela 0022 para a clínica anterior. Invariante que depende de quantas linhas o
  -- banco tinha antes não é invariante.
  PERFORM confere('numeração: contador é por (clínica, escopo)',
    (SELECT count(*) FROM contador
      WHERE escopo = 'orcamento'
        AND clinica_id IN ('c1111111-1111-1111-1111-111111111111',
                           'c2222222-2222-2222-2222-222222222222')) = 2,
    (SELECT count(*)::text FROM contador
      WHERE escopo = 'orcamento'
        AND clinica_id IN ('c1111111-1111-1111-1111-111111111111',
                           'c2222222-2222-2222-2222-222222222222'))
    || ' linha(s) para as duas clínicas de teste');
END $$;

-- ── Fuso: a validade de lote não pode sair de uma clínica arbitrária ───────
-- O bug que a 0022 consertou: `hoje_na_clinica()` lia `WHERE id = 1`, então o
-- fuso da clínica nº 1 decidia o vencimento de material de TODAS. Lote que vence
-- 31/07 serve até o fim do dia 31/07 no fuso DA clínica.
--
-- As duas clínicas abaixo estão a 25 horas de distância (UTC+14 e UTC−11), então
-- a data local delas é SEMPRE diferente, em qualquer instante. Isso torna o caso
-- determinístico sem precisar falsear o relógio — com fusos próximos ele passaria
-- 23 horas por dia e falharia numa.
DO $$
DECLARE v_k date; v_n date; v_igual date;
BEGIN
  INSERT INTO clinica (id, razao_social, fuso_horario) VALUES
    ('cffff111-1111-1111-1111-111111111111', 'Ilha Leste',  'Pacific/Kiritimati'),
    ('cffff222-2222-2222-2222-222222222222', 'Ilha Oeste',  'Pacific/Niue'),
    ('cffff333-3333-3333-3333-333333333333', 'Ilha Leste 2','Pacific/Kiritimati');

  v_k     := hoje_na_clinica('cffff111-1111-1111-1111-111111111111');
  v_n     := hoje_na_clinica('cffff222-2222-2222-2222-222222222222');
  v_igual := hoje_na_clinica('cffff333-3333-3333-3333-333333333333');

  PERFORM confere('fuso: hoje_na_clinica(uuid) usa o fuso DA clínica passada',
    v_k <> v_n, format('UTC+14 → %s, UTC−11 → %s', v_k, v_n));

  -- Contraprova: sem ela, "as datas diferem" poderia ser a função devolvendo
  -- qualquer coisa diferente a cada chamada.
  PERFORM confere('fuso: mesmo fuso, mesma data (contraprova do caso acima)',
    v_k = v_igual, format('%s = %s', v_k, v_igual));

  PERFORM confere('fuso: bate com o cálculo independente do mesmo instante',
    v_k = (now() AT TIME ZONE 'Pacific/Kiritimati')::date,
    format('função %s, cálculo direto %s', v_k, (now() AT TIME ZONE 'Pacific/Kiritimati')::date));

  PERFORM confere('fuso: a forma sem argumento segue o contexto da transação',
    hoje_na_clinica() = hoje_na_clinica('c1111111-1111-1111-1111-111111111111'),
    'hoje_na_clinica() = ' || hoje_na_clinica()::text);
END $$;

-- ── A asserção de catálogo da 0022, cobrada em tempo de verificação ────────
-- A 0022 derruba o DEPLOY se aparecer tabela de dados sem `clinica_id`. Repetir a
-- pergunta aqui pega o outro caminho: tabela criada à mão em produção, ou
-- migration futura que esqueceu a coluna e ninguém rodou de novo desde então.
DO $$
DECLARE v_faltando text[];
BEGIN
  SELECT coalesce(array_agg(c.relname ORDER BY c.relname), ARRAY[]::text[])
    INTO v_faltando
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'r' AND n.nspname = 'public'
     /*
      * A lista de isentas, e cada nome precisa de justificativa escrita — se
      * "acrescentar à lista" ficar mais fácil que "pôr a coluna", esta trava
      * aprende a ficar quieta.
      *
      *   clinica              — é o tenant.
      *   dente                — 52 dentes FDI, padrão internacional e imutável.
      *   plano_assinatura     — catálogo comercial DO FORNECEDOR, não de tenant: os
      *                          planos são os mesmos para todas as clínicas. Preço
      *                          negociado por cliente é atributo do **contrato**
      *                          (`assinatura`, que tem tenant), nunca do catálogo.
      *   __drizzle_migrations — controle do migrador.
      */
     AND c.relname NOT IN ('clinica', 'dente', 'plano_assinatura', '__drizzle_migrations')
     AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attname = 'clinica_id'
                        AND NOT a.attisdropped);

  -- O texto tem de ser verdadeiro nos DOIS ramos: `confere` imprime o detalhe
  -- mesmo quando passa, e um detalhe escrito só para o caso de falha faz o
  -- relatório verde afirmar o contrário do que aconteceu.
  PERFORM confere('catálogo: toda tabela de dados tem clinica_id',
    array_length(v_faltando, 1) IS NULL,
    CASE WHEN array_length(v_faltando, 1) IS NULL
      THEN (SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind = 'r' AND n.nspname = 'public') || ' tabelas varridas'
      ELSE 'sem tenant: ' || array_to_string(v_faltando, ', ')
    END);
END $$;

-- Contraprova da asserção: uma tabela de dados sem `clinica_id` TEM de ser
-- flagrada. Sem este caso, o de cima passaria para sempre num banco onde a
-- consulta estivesse errada — provaria a consulta, não a invariante.
-- DDL é transacional no Postgres, então a tabela morre no ROLLBACK do arquivo.
DO $$
DECLARE v_pegou boolean;
BEGIN
  CREATE TABLE tabela_sem_tenant_de_teste (id uuid PRIMARY KEY);

  SELECT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND n.nspname = 'public'
       AND c.relname NOT IN ('clinica', 'dente', '__drizzle_migrations')
       AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = c.oid AND a.attname = 'clinica_id'
                          AND NOT a.attisdropped)
  ) INTO v_pegou;

  PERFORM confere('catálogo: a asserção REPROVA tabela sem clinica_id (contraprova)',
    v_pegou,
    CASE WHEN v_pegou THEN 'a varredura flagrou a tabela plantada'
         ELSE 'a varredura NÃO viu a tabela plantada — a asserção é decorativa' END);

  DROP TABLE tabela_sem_tenant_de_teste;
END $$;

-- ── FK composto: a referência não atravessa clínica (drizzle/0023) ─────────
--
-- Estes dois casos nasceram como `espera_ok`, documentando que o isolamento ainda
-- era disciplinar enquanto a 0023 não existia. Ela entrou, com 80 FKs virados
-- compostos, e eles viraram `espera_erro`. Ficou registrado porque a transição é a
-- parte instrutiva: um caso que FALHA quando a garantia MELHORA é o que impede de
-- esquecer de apertar a prova depois.
--
-- Vale notar o que estes casos NÃO provam: as políticas de RLS. Este arquivo roda
-- como `facilident`, que é dono das tabelas e superusuário — e **dono ignora
-- política**. FK composto vale para todo mundo, inclusive o dono, e é por isso que
-- ele é testável aqui. Para as políticas existe `docker/verificar-rls.sql`, que
-- conecta com a role de aplicação.
SELECT espera_erro('FK composto: paciente com clinica_id de OUTRA clínica no agendamento', ARRAY[$$
  INSERT INTO paciente (clinica_id, nome, data_nascimento)
  VALUES ('c2222222-2222-2222-2222-222222222222', 'Paciente da B', '1990-01-01')
$$, $$
  INSERT INTO agendamento (paciente_id, profissional_id, cadeira_id, inicio, fim)
  SELECT p.id,
         (SELECT id FROM profissional WHERE clinica_id = 'c1111111-1111-1111-1111-111111111111' LIMIT 1),
         (SELECT id FROM cadeira      WHERE clinica_id = 'c1111111-1111-1111-1111-111111111111' LIMIT 1),
         now() + interval '400 days', now() + interval '400 days 1 hour'
    FROM paciente p
   WHERE p.clinica_id = 'c2222222-2222-2222-2222-222222222222'
     AND p.nome = 'Paciente da B'
$$]);

-- Parcela da clínica A pendurada em cobrança da B. Era aceito enquanto a FK olhava
-- só `cobranca_id`; com `(cobranca_id, clinica_id)` o pai simplesmente não existe
-- para a filha.
SELECT espera_erro('FK composto: parcela da clínica A em cobrança da clínica B', ARRAY[$$
  DO $x$
  DECLARE v_cob uuid; v_pac uuid;
  BEGIN
    PERFORM set_config('app.clinica_id', 'c2222222-2222-2222-2222-222222222222', true);
    INSERT INTO paciente (nome, data_nascimento) VALUES ('Pac B cobranca', '1990-01-01')
      RETURNING id INTO v_pac;
    INSERT INTO cobranca (paciente_id, valor_total, forma) VALUES (v_pac, '100.00', 'pix')
      RETURNING id INTO v_cob;
    PERFORM set_config('app.clinica_id', 'c1111111-1111-1111-1111-111111111111', true);
    INSERT INTO parcela (cobranca_id, numero, valor, vencimento)
      VALUES (v_cob, 1, '100.00', current_date);
  END $x$
$$]);

-- O contexto voltou para A? O caso acima troca de clínica no meio e aborta — e uma
-- exceção dentro de `espera_erro` desfaz o `set_config` junto. Confiar nisso sem
-- conferir deixaria todos os casos seguintes rodando como clínica B.
SELECT confere('tenant: contexto continua na clínica A depois dos casos que trocam',
  app_clinica_id() = 'c1111111-1111-1111-1111-111111111111',
  'app_clinica_id() = ' || app_clinica_id()::text);

-- ── Referência que cruza clínica: a contraparte em DADO do FK composto ─────
--
-- A `drizzle/0023` põe `clinica_id` nas duas pontas dos FKs entre tabelas de
-- tenant, então o banco passa a RECUSAR referência cruzada. Esta varredura faz a
-- outra pergunta: **existe linha cruzada agora?** As duas são necessárias — o FK
-- protege o futuro, a varredura examina o passado, e um FK composto não pode nem
-- ser criado sobre dado que já cruza.
--
-- Não é hipótese. O `demo:preparar` fazia isso: lia `procedimento` por código
-- presumindo o catálogo do `db:seed`, que pertence à clínica DELE, e montava 4
-- `item_plano` apontando para procedimento de outra clínica. Mais 7 agendamentos na
-- cadeira da outra clínica, por um `.limit(2)` sem `WHERE` nem `ORDER BY`. Nada
-- reclamava, e a 0023 não teria conseguido criar os FKs compostos.
CREATE FUNCTION referencias_cruzando_clinica() RETURNS text[] AS $fn$
DECLARE
  r        record;
  v_n      bigint;
  v_ruins  text[] := ARRAY[]::text[];
  v_join   text;
  v_cond   text;
BEGIN
  FOR r IN
    SELECT c.conname,
           c.conrelid                  AS filha_oid,
           c.confrelid                 AS pai_oid,
           c.conrelid::regclass::text  AS filha,
           c.confrelid::regclass::text AS pai,
           c.conkey, c.confkey
      FROM pg_constraint c
     WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
       -- as duas pontas têm tenant…
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid
                    AND a.attname = 'clinica_id' AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.confrelid
                    AND a.attname = 'clinica_id' AND NOT a.attisdropped)
       -- …e o FK para `clinica` em si não interessa: ele não cruza nada.
       AND c.confrelid <> 'clinica'::regclass
  LOOP
    /*
     * O join usa as colunas do FK **menos `clinica_id`**, e a comparação de tenant
     * fica no WHERE.
     *
     * A primeira versão juntava por TODAS as colunas do FK. Para os FKs compostos da
     * 0023 — `(paciente_id, clinica_id) → (id, clinica_id)` — isso torna o
     * `WHERE f.clinica_id <> p.clinica_id` uma contradição: o join já obrigou os dois
     * a serem iguais. A varredura devolvia "nenhuma referência cruzada" para
     * exatamente os 80 FKs que mais importam, sem nunca olhar nada.
     *
     * Quem pegou foi a contraprova logo abaixo, que plantou uma linha cruzada e viu
     * a varredura não achar. É o motivo de contraprova existir: verificação vacuosa
     * é indistinguível de verificação bem-sucedida, olhando só o relatório.
     */
    SELECT string_agg(format('f.%I = p.%I', af.attname, ap.attname), ' AND ' ORDER BY k.ord),
           string_agg(format('f.%I IS NOT NULL', af.attname), ' AND ' ORDER BY k.ord)
      INTO v_join, v_cond
      FROM unnest(r.conkey, r.confkey) WITH ORDINALITY AS k(fa, pa, ord)
      JOIN pg_attribute af ON af.attrelid = r.filha_oid AND af.attnum = k.fa
      JOIN pg_attribute ap ON ap.attrelid = r.pai_oid   AND ap.attnum = k.pa
     WHERE af.attname <> 'clinica_id';

    -- FK cujo único par é `clinica_id` não tem o que comparar.
    CONTINUE WHEN v_join IS NULL;

    EXECUTE format(
      'SELECT count(*) FROM %s f JOIN %s p ON %s WHERE %s AND f.clinica_id <> p.clinica_id',
      r.filha, r.pai, v_join, v_cond)
      INTO v_n;

    IF v_n > 0 THEN
      v_ruins := v_ruins || format('%s→%s: %s linha(s) [%s]', r.filha, r.pai, v_n, r.conname);
    END IF;
  END LOOP;

  RETURN v_ruins;
END $fn$ LANGUAGE plpgsql;

DO $$
DECLARE v_ruins text[];
BEGIN
  v_ruins := referencias_cruzando_clinica();
  PERFORM confere('tenant: nenhuma referência aponta para linha de OUTRA clínica',
    array_length(v_ruins, 1) IS NULL,
    CASE WHEN array_length(v_ruins, 1) IS NULL THEN 'nenhuma referência cruzada'
         ELSE array_to_string(v_ruins, ' · ') END);
END $$;

-- Contraprova: uma referência cruzada plantada TEM de aparecer. Usa `paciente` da
-- clínica B pendurado num `agendamento` da A — que é justamente a forma do bug real.
DO $$
DECLARE v_ruins text[]; v_achou boolean; v_pacB uuid; v_prof uuid; v_cad uuid;
BEGIN
  PERFORM set_config('app.clinica_id', 'c2222222-2222-2222-2222-222222222222', true);
  INSERT INTO paciente (nome, data_nascimento) VALUES ('Paciente da B', '1990-01-01')
    RETURNING id INTO v_pacB;
  PERFORM set_config('app.clinica_id', 'c1111111-1111-1111-1111-111111111111', true);

  SELECT id INTO v_prof FROM profissional
   WHERE clinica_id = 'c1111111-1111-1111-1111-111111111111' LIMIT 1;
  SELECT id INTO v_cad FROM cadeira
   WHERE clinica_id = 'c1111111-1111-1111-1111-111111111111' LIMIT 1;

  -- Agendamento da clínica A para paciente da B.
  --
  -- Com o FK composto da 0023, um INSERT normal é RECUSADO — o caso acima prova
  -- isso. Então a contraprova precisa plantar a linha do único jeito que ela
  -- realmente aparece na vida: com a trava desligada. `DISABLE TRIGGER ALL` desliga
  -- as triggers internas de FK, que é o poder que o `session_replication_role` dos
  -- scripts de limpeza dava sem pedir — e foi assim que 5 movimentos de estoque
  -- órfãos entraram no banco de desenvolvimento.
  --
  -- Ou seja: esta contraprova reproduz o incidente. Se a varredura não pegar isto,
  -- ela não pegaria aquilo.
  ALTER TABLE agendamento DISABLE TRIGGER ALL;
  INSERT INTO agendamento (paciente_id, profissional_id, cadeira_id, inicio, fim)
  VALUES (v_pacB, v_prof, v_cad, now() + interval '400 days', now() + interval '400 days 1 hour');
  ALTER TABLE agendamento ENABLE TRIGGER ALL;

  v_ruins := referencias_cruzando_clinica();
  v_achou := EXISTS (SELECT 1 FROM unnest(v_ruins) x WHERE x LIKE 'agendamento→paciente:%');

  PERFORM confere('tenant: a varredura ENCONTRA referência cruzada (contraprova)',
    v_achou,
    CASE WHEN v_achou THEN 'achou o agendamento cruzado de propósito'
         ELSE 'NÃO achou — a varredura de referência cruzada é decorativa' END);
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- Fase 18 — filas de relacionamento
-- ══════════════════════════════════════════════════════════════════════════
--
-- O que estes casos protegem não é o banco: é o paciente que pediu para não ser
-- incomodado. A garantia central é que a tarefa DISPENSADA não volta, e ela depende
-- de uma coisa só — a `chave_idempotencia` existir uma vez por FATO gerador, não uma
-- vez por tarefa aberta.

-- Fixtures FORA de qualquer `espera_erro`: fixture criada dentro do bloco que engole
-- exceção faz o caso "passar" quando é a fixture que falha.
INSERT INTO regra_retorno (id, procedimento_id, meses, tipo)
  SELECT 'e1111111-0000-4000-8000-000000000001',
         (SELECT id FROM procedimento WHERE codigo = 'CONS-001'
           AND clinica_id = 'c1111111-1111-1111-1111-111111111111'),
         6, 'exame';

INSERT INTO tarefa_relacionamento
  (id, tipo, paciente_id, chave_idempotencia, orcamento_id, prazo, situacao)
  SELECT 'e2222222-0000-4000-8000-000000000001',
         'orcamento_sem_resposta',
         '33333333-3333-3333-3333-333333333333',
         'orcamento_sem_resposta:11111111-1111-4111-8111-111111111111',
         o.id,
         hoje_na_clinica() + 7,
         'aberta'
    FROM orcamento o
   WHERE o.clinica_id = 'c1111111-1111-1111-1111-111111111111'
   LIMIT 1;

SELECT espera_erro('relacionamento: uma regra de retorno por procedimento', ARRAY[$$
  INSERT INTO regra_retorno (procedimento_id, meses, tipo)
  SELECT (SELECT id FROM procedimento WHERE codigo = 'CONS-001'
           AND clinica_id = 'c1111111-1111-1111-1111-111111111111'), 12, 'controle'
$$]);

SELECT espera_erro('relacionamento: intervalo de retorno fora da faixa', ARRAY[$$
  INSERT INTO regra_retorno (procedimento_id, meses, tipo)
  SELECT (SELECT id FROM procedimento WHERE codigo = 'DENT-001'
           AND clinica_id = 'c1111111-1111-1111-1111-111111111111'), 0, 'controle'
$$]);

/*
 * A chave é única. É a trava que impede o gerador de duplicar a fila **e** de
 * recriar o que foi dispensado — as duas coisas dependem só dela.
 */
SELECT espera_erro('relacionamento: chave de idempotência repetida', ARRAY[$$
  INSERT INTO tarefa_relacionamento
    (tipo, paciente_id, chave_idempotencia, orcamento_id, prazo)
  SELECT 'orcamento_sem_resposta', '33333333-3333-3333-3333-333333333333',
         'orcamento_sem_resposta:11111111-1111-4111-8111-111111111111',
         o.id, hoje_na_clinica()
    FROM orcamento o WHERE o.clinica_id = 'c1111111-1111-1111-1111-111111111111' LIMIT 1
$$]);

/*
 * `tipo` e referência têm de combinar. Sem isto, um gerador novo que esquecesse a
 * referência produziria na tela uma linha "falar com o paciente" sem nada em que
 * clicar — e a recepção teria de adivinhar o assunto.
 */
SELECT espera_erro('relacionamento: tarefa de inadimplência SEM parcela', ARRAY[$$
  INSERT INTO tarefa_relacionamento (tipo, paciente_id, chave_idempotencia, prazo)
  VALUES ('inadimplencia', '33333333-3333-3333-3333-333333333333',
          'inadimplencia:sem-parcela', hoje_na_clinica())
$$]);

SELECT espera_erro('relacionamento: tarefa de retorno com referência de OUTRO tipo', ARRAY[$$
  INSERT INTO tarefa_relacionamento
    (tipo, paciente_id, chave_idempotencia, orcamento_id, prazo)
  SELECT 'retorno_programado', '33333333-3333-3333-3333-333333333333',
         'retorno_programado:referencia-errada', o.id, hoje_na_clinica()
    FROM orcamento o WHERE o.clinica_id = 'c1111111-1111-1111-1111-111111111111' LIMIT 1
$$]);

-- Dispensar sem motivo é indistinguível de clique errado, e a diferença decide se a
-- fila reabre no ano que vem.
SELECT espera_erro('relacionamento: dispensar sem motivo', ARRAY[$$
  UPDATE tarefa_relacionamento SET situacao = 'dispensada'
   WHERE id = 'e2222222-0000-4000-8000-000000000001'
$$]);

SELECT espera_ok('relacionamento: dispensar COM motivo', ARRAY[$$
  UPDATE tarefa_relacionamento
     SET situacao = 'dispensada', motivo_dispensa = 'Paciente pediu para não ligar.',
         dispensado_em = now()
   WHERE id = 'e2222222-0000-4000-8000-000000000001'
$$]);

SELECT espera_erro('relacionamento: motivo em branco não vale como motivo', ARRAY[$$
  UPDATE tarefa_relacionamento SET motivo_dispensa = '   '
   WHERE id = 'e2222222-0000-4000-8000-000000000001'
$$]);

/*
 * ── A garantia central, medida contra o gerador ERRADO ────────────────────
 *
 * Não basta afirmar que a tarefa dispensada não volta: é preciso mostrar que ela
 * VOLTARIA com a outra condição. Os dois números lado a lado são a prova — 1 para o
 * gerador que filtra por `situacao`, 0 para o que filtra pela chave.
 *
 * Sem o primeiro número, o zero do segundo poderia significar "não havia nada
 * elegível", e o caso estaria verde sem provar nada.
 */
DO $$
DECLARE v_ingenuo int; v_por_chave int;
BEGIN
  SELECT count(*) INTO v_ingenuo
    FROM tarefa_relacionamento t
   WHERE t.id = 'e2222222-0000-4000-8000-000000000001'
     AND NOT EXISTS (
       SELECT 1 FROM tarefa_relacionamento x
        WHERE x.orcamento_id = t.orcamento_id
          AND x.situacao IN ('aberta', 'em_andamento')
     );

  SELECT count(*) INTO v_por_chave
    FROM tarefa_relacionamento t
   WHERE t.id = 'e2222222-0000-4000-8000-000000000001'
     AND NOT EXISTS (
       SELECT 1 FROM tarefa_relacionamento x
        WHERE x.chave_idempotencia = t.chave_idempotencia
     );

  PERFORM confere('relacionamento: dispensada NÃO reabre (a chave ignora a situação)',
    v_por_chave = 0,
    'filtrando por chave, o gerador acha ' || v_por_chave || ' para recriar');

  PERFORM confere(
    'relacionamento: CONTRAPROVA — o gerador que filtra por situação REABRIRIA',
    v_ingenuo = 1,
    'filtrando por situação, ele acharia ' || v_ingenuo ||
    ' (se fosse 0, o caso acima estaria verde sem provar nada)');
END $$;

-- Referência cruzando clínica: o FK composto recusa.
SELECT espera_erro('relacionamento: tarefa da clínica A com orçamento da clínica B', ARRAY[$$
  INSERT INTO tarefa_relacionamento
    (tipo, paciente_id, chave_idempotencia, orcamento_id, prazo)
  SELECT 'orcamento_sem_resposta', '33333333-3333-3333-3333-333333333333',
         'orcamento_sem_resposta:cruzando-clinica',
         '99999999-9999-4999-8999-999999999999', hoje_na_clinica()
$$]);

/*
 * ── A trava de suspensão de assinatura alcança TODA tabela de tenant ──────
 *
 * Este caso existe porque a `drizzle/0027` diz no cabeçalho que "tabela nova nasce
 * travada (o laço varre o catálogo)" — e **não nasce**: o laço rodou uma vez, quando
 * ela foi aplicada. As três tabelas da Fase 18 receberam a trava explicitamente na
 * `0029`, e sem este caso a próxima tabela dependeria de alguém lembrar.
 *
 * Uma clínica suspensa escrevendo livremente numa tabela nova não daria erro nenhum:
 * daria uma clínica que não paga e continua operando. `exigir_isolamento_estrutural()`
 * não vê isso — ela confere `clinica_id`, RLS, FORCE e política de ISOLAMENTO.
 *
 * As isentas são as da 0027, cada uma com motivo escrito lá: `audit_log` (leitura de
 * prontuário é auditável, travar o log travaria a leitura), `paciente_sessao` (login
 * e logout), `usuario`/`paciente_conta` (só UPDATE livre: senha e tentativas),
 * `assinatura` (é a própria cobrança).
 */
DO $$
DECLARE v_sem_trava text[];
BEGIN
  SELECT coalesce(array_agg(c.relname ORDER BY c.relname), ARRAY[]::text[])
    INTO v_sem_trava
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'r' AND n.nspname = 'public'
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                  AND a.attname = 'clinica_id' AND NOT a.attisdropped)
     AND c.relname NOT IN ('audit_log', 'paciente_sessao', 'assinatura',
                           'usuario', 'paciente_conta')
     AND (SELECT count(*) FROM pg_policy p
           WHERE p.polrelid = c.oid AND NOT p.polpermissive
             AND p.polcmd IN ('a', 'w')) < 2;

  -- O texto precisa ser verdadeiro nos DOIS ramos: `confere` imprime o detalhe
  -- também quando passa, e "sem trava: " seguido de nada lê como se houvesse
  -- problema. É o mesmo cuidado que o resto do arquivo documenta.
  PERFORM confere('assinatura: toda tabela de tenant tem a trava de suspensão',
    array_length(v_sem_trava, 1) IS NULL,
    CASE WHEN array_length(v_sem_trava, 1) IS NULL
         THEN 'todas travadas (fora as isentas da 0027)'
         ELSE 'clínica suspensa escreveria em: ' || array_to_string(v_sem_trava, ', ')
    END);
END $$;

-- ── Saldo de lote contra a soma dos movimentos: pergunta ao DADO ────────────
--
-- Não é a mesma coisa que os casos da seção 14. Aqueles provam a REGRA: criam um
-- lote, lançam movimentos e conferem que a trigger derivou o saldo. Este olha as
-- linhas que **já estão** no banco.
--
-- A diferença deixou de ser acadêmica. `lote_material.saldo` é derivado por trigger
-- e não pode ser digitado, então saldo ≠ soma dos movimentos é impossível — a menos
-- que alguém APAGUE movimento, o que o append-only recusa. Aconteceu assim: a
-- limpeza de um script de demonstração usava `session_replication_role = 'replica'`,
-- que desliga também as triggers de FK, e deixou 5 movimentos apontando para uma
-- execução apagada. Para criar o FK composto da 0023 foi preciso remover esses 5 —
-- e o saldo ficou refletindo um consumo cujo registro não existe mais.
--
-- Nenhum dos 223 casos anteriores viu isso, porque todos trabalham em fixture
-- própria. Quem viu foi a conferência da exportação por clínica, muito depois. Uma
-- invariante de DADO é o que avisa na hora.
DO $$
DECLARE
  v_ruins int;
  v_exemplo text;
BEGIN
  /*
   * A agregação vai numa SUBCONSULTA, e isto não é estilo: a primeira versão fazia
   * `SELECT count(*) … GROUP BY l.id HAVING …` direto, e `count(*)` passou a contar
   * **dentro de cada grupo** — sempre 1 — com o `INTO` levando a primeira linha.
   * Ela relatou "1 lote divergente" onde havia 5.
   *
   * Um número errado num relatório de invariante é pior que ruído: ele diz o
   * tamanho do problema, e quem lê decide o que fazer com base nisso.
   */
  SELECT count(*), min(t.id::text) INTO v_ruins, v_exemplo
    FROM (
      SELECT l.id, l.saldo, coalesce(sum(m.quantidade), 0) AS soma
        FROM lote_material l
        LEFT JOIN movimento_estoque m ON m.lote_id = l.id
       GROUP BY l.id, l.saldo
    ) t
   WHERE t.saldo <> t.soma;

  PERFORM confere('estoque: todo saldo confere com a soma dos movimentos (dado real)',
    v_ruins = 0,
    CASE WHEN v_ruins = 0 THEN 'nenhum lote divergente'
         ELSE v_ruins || ' lote(s) divergente(s), ex.: ' || v_exemplo ||
              ' — movimento apagado? (append-only deveria impedir)' END);
END $$;

-- ── 21. Autoatendimento do paciente (Fase 19) ───────────────────────────────
--
-- O que se prova aqui é o que o BANCO garante, não o que a regra em TypeScript
-- decide. `avaliarPedido` (antecedência, teto, procedimento liberado) tem 22 casos de
-- unidade em `lib/domain/autoatendimento.test.ts` — repetir aquilo em SQL seria testar
-- a mesma coisa duas vezes no lugar errado.
--
-- Aqui ficam as travas que sobrevivem a um bug no código de aplicação: as que impedem
-- que uma linha incoerente EXISTA, independentemente de quem a inseriu.

-- ── 21.1 Agendamento do portal não fura a EXCLUDE constraint ────────────────
--
-- É a garantia central da fase. Se o autoatendimento pudesse sobrepor, dois pacientes
-- marcariam o mesmo minuto e a reconciliação seria no dia, na cara da recepção.
SELECT espera_erro('portal: agendamento sobreposto é recusado como qualquer outro', ARRAY[$$
  INSERT INTO agendamento (paciente_id, profissional_id, cadeira_id, inicio, fim, origem)
  VALUES ('33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222221',
          '44444444-4444-4444-4444-444444444441',
          '2026-09-01 09:30:00-03', '2026-09-01 10:30:00-03', 'portal')
$$]);

-- Contraprova: a origem `portal` não é o motivo da recusa acima. Em horário livre, ela
-- entra. Sem este caso, o de cima passaria igual se `origem = 'portal'` fosse
-- rejeitada por qualquer outra razão — e a prova seria vazia.
SELECT espera_ok('portal: em horário livre, a origem portal é aceita (contraprova)', ARRAY[$$
  INSERT INTO agendamento (id, paciente_id, profissional_id, cadeira_id, inicio, fim, origem)
  VALUES ('55555555-5555-5555-5555-55555555559a',
          '33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222221',
          '44444444-4444-4444-4444-444444444441',
          '2026-09-02 09:00:00-03', '2026-09-02 10:00:00-03', 'portal')
$$]);

-- ── 21.2 A configuração não aceita janela impossível ────────────────────────
--
-- Mínima maior que a máxima deixa a janela VAZIA, e a tela mostra "nenhum horário
-- disponível" para sempre — sem nada indicando que a configuração está errada. É o
-- pior modo de falha: plausível.
--
-- ⚠️ Estes casos usam INSERT, e a primeira versão usava UPDATE. O UPDATE **passava
-- como "ACEITOU"** porque a clínica-fixture desta bateria nasce DEPOIS do backfill da
-- `0031`, então ela não tem linha em `regra_autoatendimento` — e um UPDATE que casa
-- zero linhas não estoura. O caso reprovava o banco por uma condição que ele nunca
-- teve chance de avaliar.
--
-- É a oitava vez que esta forma aparece no projeto, e a lição é sempre a mesma:
-- comando que pode casar zero linhas não prova CHECK nenhum. INSERT não tem essa
-- ambiguidade — ou a linha entra, ou o CHECK a recusa.
SELECT espera_ok('autoatendimento: a clínica-fixture ganha configuração (base dos casos)', ARRAY[$$
  INSERT INTO regra_autoatendimento (clinica_id) VALUES ('c1111111-1111-1111-1111-111111111111')
  ON CONFLICT DO NOTHING
$$]);

SELECT espera_erro('autoatendimento: antecedência mínima maior que a máxima', ARRAY[$$
  INSERT INTO regra_autoatendimento
    (clinica_id, antecedencia_minima_horas, antecedencia_maxima_dias)
  VALUES ('c2222222-2222-2222-2222-222222222222', 100, 2)
$$]);

SELECT espera_erro('autoatendimento: teto de futuros zero trancaria todo mundo', ARRAY[$$
  INSERT INTO regra_autoatendimento (clinica_id, maximo_futuros_por_paciente)
  VALUES ('c2222222-2222-2222-2222-222222222222', 0)
$$]);

SELECT espera_erro('autoatendimento: teto acima de 20 não é limite, é ausência de limite', ARRAY[$$
  INSERT INTO regra_autoatendimento (clinica_id, maximo_futuros_por_paciente)
  VALUES ('c2222222-2222-2222-2222-222222222222', 99)
$$]);

-- Contraprova: os três casos acima recusam pelo CHECK, não porque a clínica B não
-- pode receber configuração. Com valores válidos, a mesma linha entra.
SELECT espera_ok('autoatendimento: janela válida na mesma clínica é aceita (contraprova)', ARRAY[$$
  INSERT INTO regra_autoatendimento
    (clinica_id, antecedencia_minima_horas, antecedencia_maxima_dias, maximo_futuros_por_paciente)
  VALUES ('c2222222-2222-2222-2222-222222222222', 24, 60, 2)
$$]);

-- ── 21.3 O padrão do banco bate com o padrão do domínio ────────────────────
--
-- `REGRA_PADRAO` em `lib/domain/autoatendimento.ts` e os DEFAULTs da tabela são a
-- mesma informação em dois lugares. Repetição consciente (o banco precisa do default
-- para a linha nascer válida; o domínio precisa do valor para ser testável sem banco),
-- e este caso é o que impede as duas divergirem — o dia em que alguém afrouxar o
-- default do banco e o teste de unidade continuar verde.
DO $$
DECLARE v_ativo boolean; v_min int; v_max int; v_teto int;
BEGIN
  SELECT column_default = 'false', 0, 0, 0 INTO v_ativo, v_min, v_max, v_teto
    FROM information_schema.columns
   WHERE table_name = 'regra_autoatendimento' AND column_name = 'ativo';

  SELECT (SELECT column_default::int FROM information_schema.columns
           WHERE table_name = 'regra_autoatendimento' AND column_name = 'antecedencia_minima_horas'),
         (SELECT column_default::int FROM information_schema.columns
           WHERE table_name = 'regra_autoatendimento' AND column_name = 'antecedencia_maxima_dias'),
         (SELECT column_default::int FROM information_schema.columns
           WHERE table_name = 'regra_autoatendimento' AND column_name = 'maximo_futuros_por_paciente')
    INTO v_min, v_max, v_teto;

  PERFORM confere('autoatendimento: DEFAULT do banco = REGRA_PADRAO do domínio',
    v_ativo AND v_min = 24 AND v_max = 60 AND v_teto = 2,
    format('ativo=false? %s · min=%s (24) · max=%s (60) · teto=%s (2). '
           'Se você mudou REGRA_PADRAO, mude o DEFAULT junto.',
           v_ativo, v_min, v_max, v_teto));
END $$;

-- ⚠️ E o `ativo` tem de ser FALSE por padrão. Uma clínica que atualiza o sistema não
-- pode descobrir que a agenda dela abriu para a internet.
DO $$
DECLARE v_default text;
BEGIN
  SELECT column_default INTO v_default FROM information_schema.columns
   WHERE table_name = 'regra_autoatendimento' AND column_name = 'ativo';
  PERFORM confere('autoatendimento: nasce DESLIGADO (agenda não abre por atualização)',
    v_default = 'false', format('DEFAULT ativo = %s', v_default));
END $$;

-- ── 21.4 Anamnese: a diferença entre dado clínico e declaração do paciente ──
--
-- Sem estas travas, uma alergia autodeclarada que ninguém confirmou fica
-- indistinguível de uma colhida por profissional — e vira decisão de anestésico.
SELECT espera_erro('anamnese: do portal não pode ter profissional (paciente não é profissional)', ARRAY[$$
  INSERT INTO anamnese (paciente_id, profissional_id, versao, respostas, versao_formulario, origem)
  VALUES ('33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222221',
          91, '{}'::jsonb, 'v1', 'portal')
$$]);

SELECT espera_erro('anamnese: da clínica EXIGE profissional', ARRAY[$$
  INSERT INTO anamnese (paciente_id, versao, respostas, versao_formulario, origem)
  VALUES ('33333333-3333-3333-3333-333333333333', 92, '{}'::jsonb, 'v1', 'clinica')
$$]);

SELECT espera_ok('anamnese: do portal, sem profissional, é aceita (contraprova)', ARRAY[$$
  INSERT INTO anamnese (id, paciente_id, versao, respostas, versao_formulario, origem)
  VALUES ('99999999-0000-0000-0000-0000000000a1',
          '33333333-3333-3333-3333-333333333333', 93, '{}'::jsonb, 'v1', 'portal')
$$]);

-- Conferência é um ATO: tem quem e tem quando, ou não tem nenhum dos dois. Metade do
-- registro é o que não serve para nada numa auditoria.
SELECT espera_erro('anamnese: conferida sem dizer quem conferiu', ARRAY[$$
  UPDATE anamnese SET conferida_em = now()
   WHERE id = '99999999-0000-0000-0000-0000000000a1'
$$]);

SELECT espera_ok('anamnese: conferida com quem e quando (contraprova)', ARRAY[$$
  UPDATE anamnese
     SET conferida_em = now(), conferida_por_id = '22222222-2222-2222-2222-222222222221'
   WHERE id = '99999999-0000-0000-0000-0000000000a1'
$$]);

-- Anamnese da clínica não se confere: quem a colheu é quem conferiria, e marcar
-- conferência ali inventaria um segundo ato que não aconteceu.
SELECT espera_erro('anamnese: a da CLÍNICA não recebe conferência', ARRAY[$$
  INSERT INTO anamnese (id, paciente_id, profissional_id, versao, respostas, versao_formulario,
                        origem, conferida_em, conferida_por_id)
  VALUES ('99999999-0000-0000-0000-0000000000a2',
          '33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222221',
          94, '{}'::jsonb, 'v1', 'clinica', now(), '22222222-2222-2222-2222-222222222221')
$$]);

-- E o versionamento da Fase 5 continua valendo: a do portal NÃO sobrescreve.
SELECT espera_erro('anamnese: duas versões iguais para o mesmo paciente', ARRAY[$$
  INSERT INTO anamnese (paciente_id, versao, respostas, versao_formulario, origem)
  VALUES ('33333333-3333-3333-3333-333333333333', 93, '{}'::jsonb, 'v1', 'portal')
$$]);

-- ── 21.5 ⚖️ Assinatura eletrônica: sem rastro, sem assinatura ───────────────
--
-- O que torna a assinatura eletrônica simples oponível é o CONJUNTO: o que foi
-- assinado (hash), de onde (IP), com quê (user_agent), quando. Faltando o rastro,
-- sobra uma linha dizendo "assinou" sem nada que sustente. Papel não precisa de IP —
-- a prova é a folha —, e é por isso que o CHECK só cobra do eletrônico.
SELECT espera_erro('consentimento: assinatura eletrônica sem IP', ARRAY[$$
  INSERT INTO consentimento (paciente_id, base_legal, finalidade, versao_termo, texto_hash,
                             nivel_assinatura, user_agent)
  VALUES ('33333333-3333-3333-3333-333333333333', 'consentimento', 'termo_de_atendimento',
          'v1', repeat('a', 64), 'eletronica_simples', 'Mozilla/5.0')
$$]);

SELECT espera_erro('consentimento: assinatura eletrônica sem user_agent', ARRAY[$$
  INSERT INTO consentimento (paciente_id, base_legal, finalidade, versao_termo, texto_hash,
                             nivel_assinatura, ip)
  VALUES ('33333333-3333-3333-3333-333333333333', 'consentimento', 'termo_de_atendimento',
          'v1', repeat('a', 64), 'eletronica_simples', '203.0.113.9')
$$]);

SELECT espera_ok('consentimento: eletrônica com rastro completo é aceita (contraprova)', ARRAY[$$
  INSERT INTO consentimento (paciente_id, base_legal, finalidade, versao_termo, texto_hash,
                             nivel_assinatura, ip, user_agent)
  VALUES ('33333333-3333-3333-3333-333333333333', 'consentimento', 'termo_de_atendimento',
          'v1', repeat('a', 64), 'eletronica_simples', '203.0.113.9', 'Mozilla/5.0')
$$]);

-- E o papel continua entrando sem IP, que é o ponto do CHECK ser condicional.
SELECT espera_ok('consentimento: presencial (papel) não exige IP (contraprova)', ARRAY[$$
  INSERT INTO consentimento (paciente_id, base_legal, finalidade, versao_termo, texto_hash)
  VALUES ('33333333-3333-3333-3333-333333333333', 'consentimento', 'termo_presencial',
          'v1', repeat('b', 64))
$$]);

-- ⚖️ O enum não tem "qualificada". Este caso existe para o dia em que alguém quiser
-- acrescentá-la: gravar `qualificada` sem ICP-Brasil por trás é pôr no banco uma
-- afirmação jurídica falsa, e o lugar de parar é aqui.
DO $$
DECLARE v_valores text;
BEGIN
  SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) INTO v_valores
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typname = 'nivel_assinatura';
  PERFORM confere('⚖️ nivel_assinatura não promete assinatura qualificada',
    v_valores = 'presencial,eletronica_simples',
    format('valores = %s', v_valores));
END $$;

-- ── 21.6 Lista de espera: um pedido ativo por par ──────────────────────────
--
-- Dois cliques punham o paciente duas vezes na fila, e a recepção ligava duas vezes.
-- Mesmo problema que a chave de idempotência resolve na Fase 18.
SELECT espera_ok('lista de espera: primeiro pedido entra', ARRAY[$$
  INSERT INTO lista_espera (id, paciente_id, valido_ate)
  VALUES ('99999999-0000-0000-0000-0000000000b1',
          '33333333-3333-3333-3333-333333333333', now() + interval '30 days')
$$]);

--
-- ⚠️ Este caso é sobre `procedimento_id IS NULL`, e é o que a primeira versão do
-- índice NÃO garantia. Em índice único do Postgres, `NULL` não é igual a `NULL`: com
-- `.on(paciente_id, procedimento_id)`, duas linhas sem procedimento não colidiam — e
-- "qualquer vaga mais cedo" é justamente o caso mais comum da lista de espera.
-- Medido: duas linhas ativas para o mesmo paciente, com o índice parecendo correto.
-- O índice passou a usar `coalesce(procedimento_id, uuid zerado)`.
SELECT espera_erro('lista de espera: segundo pedido ativo SEM procedimento é recusado', ARRAY[$$
  INSERT INTO lista_espera (paciente_id, valido_ate)
  VALUES ('33333333-3333-3333-3333-333333333333', now() + interval '30 days')
$$]);

-- E o par (paciente, procedimento) continua sendo o fato: procedimento DIFERENTE é
-- pedido diferente e entra. Sem esta contraprova, o caso acima passaria igual se o
-- índice fosse só em `paciente_id` — e aí quem quer duas coisas diferentes não
-- conseguiria pedir a segunda.
SELECT espera_ok('lista de espera: procedimento diferente é outro pedido (contraprova)', ARRAY[$$
  INSERT INTO lista_espera (paciente_id, procedimento_id, valido_ate)
  SELECT '33333333-3333-3333-3333-333333333333', id, now() + interval '30 days'
    FROM procedimento
   WHERE clinica_id = 'c1111111-1111-1111-1111-111111111111' AND codigo = 'CONS-001'
$$]);

-- O índice é PARCIAL: encerrado o primeiro, o paciente pode entrar de novo. Sem esta
-- contraprova, o caso acima passaria igual se o índice fosse total — e aí quem saiu da
-- fila nunca mais poderia voltar.
SELECT espera_ok('lista de espera: encerrado o anterior, pode entrar de novo (contraprova)', ARRAY[$$
  UPDATE lista_espera SET situacao = 'encerrada', encerrado_em = now(),
         motivo_encerramento = 'atendida por telefone'
   WHERE id = '99999999-0000-0000-0000-0000000000b1'
$$, $$
  INSERT INTO lista_espera (paciente_id, valido_ate)
  VALUES ('33333333-3333-3333-3333-333333333333', now() + interval '30 days')
$$]);

SELECT espera_erro('lista de espera: encerrar sem motivo', ARRAY[$$
  UPDATE lista_espera SET situacao = 'encerrada', encerrado_em = now()
   WHERE paciente_id = '33333333-3333-3333-3333-333333333333' AND situacao = 'aguardando'
$$]);

-- ── 21.7 As tabelas novas não cruzam clínica ───────────────────────────────
--
-- O FK composto da `0023` em ação. A varredura geral de referência cruzada já cobre
-- isto, mas um caso explícito documenta a intenção para quem ler a fase.
SELECT espera_erro('lista de espera: paciente de outra clínica é recusado', ARRAY[$$
  INSERT INTO lista_espera (paciente_id, clinica_id, valido_ate)
  VALUES ('33333333-3333-3333-3333-333333333333',
          'c2222222-2222-2222-2222-222222222222', now() + interval '30 days')
$$]);

-- ════════════════════════════════════════════════════════════════════════════
-- 22. Fase 20 — fechamento financeiro
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── Fixture desta seção ────────────────────────────────────────────────────
--
-- A categoria é **criada aqui**, não emprestada do seed.
--
-- A `drizzle/0034` semeia categorias para as clínicas que existiam quando ela rodou; a
-- clínica de teste (`c1111111…`) nasce DEPOIS, dentro deste arquivo. Um
-- `SELECT … LIMIT 1` do seed devolvia zero linhas e o `\gset` abortava a verificação
-- inteira — e, se a clínica de teste um dia tivesse categorias, o caso passaria a
-- depender de qual delas viesse primeiro.
--
-- É a mesma lição que o `verificar-rls.sql` aprendeu ao emprestar "a primeira clínica":
-- fixture que empresta dado de outro lugar falha pelo motivo errado.
INSERT INTO categoria_despesa (id, clinica_id, nome, natureza)
VALUES ('bbbbbbbb-0000-0000-0000-0000000000f1',
        'c1111111-1111-1111-1111-111111111111', 'Fixa da invariante', 'fixa');

INSERT INTO despesa (id, clinica_id, categoria_id, descricao, valor, competencia, vencimento)
VALUES ('dddddddd-0000-0000-0000-0000000000d1',
        'c1111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-0000000000f1',
        'Aluguel da invariante', '1000.00', '2026-07-01', '2026-07-10');

-- ── 22.1 A soma dos pagamentos não passa do valor ──────────────────────────
--
-- Mesma trava que já existe do lado da receita. Sem ela, o fluxo de caixa mostraria
-- saída maior que a obrigação, e a conciliação com o extrato passaria a "sobrar"
-- dinheiro que nunca existiu.
SELECT espera_ok('despesa: pagamento parcial dentro do valor', ARRAY[$$
  INSERT INTO pagamento_despesa (id, despesa_id, valor, pago_em, meio)
  VALUES ('eeeeeeee-0000-0000-0000-0000000000e1',
          'dddddddd-0000-0000-0000-0000000000d1', '600.00', '2026-08-05', 'transferencia')
$$]);

SELECT espera_erro('despesa: pagamentos somando acima do valor', ARRAY[$$
  INSERT INTO pagamento_despesa (despesa_id, valor, pago_em, meio)
  VALUES ('dddddddd-0000-0000-0000-0000000000d1', '401.00', '2026-08-06', 'pix')
$$]);

SELECT espera_ok('despesa: o que cabe exatamente no saldo entra', ARRAY[$$
  INSERT INTO pagamento_despesa (despesa_id, valor, pago_em, meio)
  VALUES ('dddddddd-0000-0000-0000-0000000000d1', '400.00', '2026-08-06', 'pix')
$$]);

-- ── 22.2 Regime de caixa ≠ regime de competência ──────────────────────────
--
-- **O caso que separa os dois regimes, com os números à mão.** A despesa é de julho
-- (competência) e foi paga em agosto (caixa). Confundir os dois é o erro clássico do
-- módulo, e o sintoma não é erro na tela: é um relatório que a contadora recusa.
--
-- Competência de julho = 1000,00. Caixa de julho = 0,00. Caixa de agosto = 1000,00.
DO $$
DECLARE
  v_competencia numeric(10,2);
  v_caixa_julho numeric(10,2);
  v_caixa_agosto numeric(10,2);
BEGIN
  SELECT coalesce(sum(valor), 0) INTO v_competencia FROM despesa
   WHERE id = 'dddddddd-0000-0000-0000-0000000000d1'
     AND competencia BETWEEN '2026-07-01' AND '2026-07-31';

  SELECT coalesce(sum(valor), 0) INTO v_caixa_julho FROM pagamento_despesa
   WHERE despesa_id = 'dddddddd-0000-0000-0000-0000000000d1'
     AND estornado_em IS NULL AND pago_em BETWEEN '2026-07-01' AND '2026-07-31';

  SELECT coalesce(sum(valor), 0) INTO v_caixa_agosto FROM pagamento_despesa
   WHERE despesa_id = 'dddddddd-0000-0000-0000-0000000000d1'
     AND estornado_em IS NULL AND pago_em BETWEEN '2026-08-01' AND '2026-08-31';

  PERFORM confere('fechamento: julho CUSTOU 1000,00 (competência)',
    v_competencia = 1000.00, 'obtido ' || v_competencia);

  PERFORM confere('fechamento: mas NADA saiu do banco em julho (caixa)',
    v_caixa_julho = 0.00, 'obtido ' || v_caixa_julho);

  PERFORM confere('fechamento: a saída de 1000,00 é de AGOSTO (caixa)',
    v_caixa_agosto = 1000.00, 'obtido ' || v_caixa_agosto);

  -- O caso que reprova se alguém colapsar os dois regimes num só.
  PERFORM confere('fechamento: competência ≠ caixa no mesmo mês',
    v_competencia <> v_caixa_julho,
    'competência ' || v_competencia || ' vs caixa ' || v_caixa_julho);
END $$;

-- ── 22.3 Despesa cancelada não recebe pagamento ───────────────────────────
--
-- Se o dinheiro saiu, a despesa não devia estar cancelada. Aceitar produziria saída de
-- caixa sem obrigação — dinheiro que sumiu do banco e não aparece em custo nenhum.
INSERT INTO despesa (id, clinica_id, categoria_id, descricao, valor, competencia, vencimento,
                     cancelado_em, motivo_cancelamento)
VALUES ('dddddddd-0000-0000-0000-0000000000d2',
        'c1111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-0000000000f1',
        'Cancelada da invariante', '500.00', '2026-07-01', '2026-07-10',
        now(), 'lançada em duplicidade');

SELECT espera_erro('despesa cancelada: não recebe pagamento', ARRAY[$$
  INSERT INTO pagamento_despesa (despesa_id, valor, pago_em, meio)
  VALUES ('dddddddd-0000-0000-0000-0000000000d2', '100.00', '2026-08-05', 'pix')
$$]);

-- ── 22.4 Convênio não paga aluguel ────────────────────────────────────────
--
-- `forma_pagamento` é reusado do lado da receita, e `convenio` é origem de receita, não
-- jeito de pagar despesa. Uma linha assim é erro de cadastro que aparece como saída de
-- caixa por um meio que não existe.
SELECT espera_erro('despesa: meio "convenio" é recusado', ARRAY[$$
  INSERT INTO pagamento_despesa (despesa_id, valor, pago_em, meio)
  VALUES ('dddddddd-0000-0000-0000-0000000000d1', '1.00', '2026-08-07', 'convenio')
$$]);

-- ── 22.5 Recorrente: uma despesa por competência ──────────────────────────
--
-- A idempotência do gerador é o índice, não uma verificação — "vê se já existe, se não
-- existe insere" tem janela entre ler e escrever, e duas execuções sobrepostas criariam
-- o aluguel duas vezes.
INSERT INTO regra_despesa_recorrente
  (id, clinica_id, categoria_id, descricao, valor, dia_vencimento, inicio_em)
VALUES ('cccccccc-0000-0000-0000-0000000000c1',
        'c1111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-0000000000f1',
        'Recorrente da invariante', '199.00', 10, '2026-05-01');

SELECT espera_ok('recorrente: primeira materialização da competência', ARRAY[$$
  INSERT INTO despesa (clinica_id, categoria_id, descricao, valor, competencia, vencimento, recorrente_id)
  VALUES ('c1111111-1111-1111-1111-111111111111', (SELECT categoria_id FROM regra_despesa_recorrente
            WHERE id = 'cccccccc-0000-0000-0000-0000000000c1'),
          'Recorrente da invariante', '199.00', '2026-05-01', '2026-05-10',
          'cccccccc-0000-0000-0000-0000000000c1')
$$]);

SELECT espera_erro('recorrente: a MESMA competência duas vezes é recusada', ARRAY[$$
  INSERT INTO despesa (clinica_id, categoria_id, descricao, valor, competencia, vencimento, recorrente_id)
  VALUES ('c1111111-1111-1111-1111-111111111111', (SELECT categoria_id FROM regra_despesa_recorrente
            WHERE id = 'cccccccc-0000-0000-0000-0000000000c1'),
          'Recorrente da invariante', '199.00', '2026-05-01', '2026-05-10',
          'cccccccc-0000-0000-0000-0000000000c1')
$$]);

--
-- CONTRAPROVA do índice parcial, e ela importa: o índice é
-- `(recorrente_id, competencia) WHERE recorrente_id IS NOT NULL`. Dois lançamentos
-- MANUAIS na mesma competência têm de passar — duas notas de laboratório em julho é o
-- normal. Se este caso reprovar, o índice virou global e a clínica não consegue lançar
-- a segunda conta do mês.
SELECT espera_ok('manual: dois lançamentos na mesma competência PASSAM (contraprova)', ARRAY[$$
  INSERT INTO despesa (clinica_id, categoria_id, descricao, valor, competencia, vencimento)
  VALUES ('c1111111-1111-1111-1111-111111111111',
          'bbbbbbbb-0000-0000-0000-0000000000f1',
          'Manual A', '10.00', '2026-07-01', '2026-07-15'),
         ('c1111111-1111-1111-1111-111111111111',
          'bbbbbbbb-0000-0000-0000-0000000000f1',
          'Manual B', '20.00', '2026-07-01', '2026-07-15')
$$]);

-- ── 22.6 Taxa de meio de pagamento: uma vigente por dia ───────────────────
--
-- Mesma EXCLUDE constraint do preço de convênio, pelo mesmo motivo: com duas linhas
-- válidas no mesmo dia, o valor líquido passa a depender da ordem da consulta. Aqui o
-- efeito chega na FOLHA, porque a base da comissão pode ser o líquido.
SELECT espera_ok('taxa: primeira vigência entra', ARRAY[$$
  INSERT INTO taxa_meio_pagamento (id, clinica_id, meio, percentual, vigencia_inicio)
  VALUES ('aaaaaaaa-0000-0000-0000-0000000000a1',
          'c1111111-1111-1111-1111-111111111111', 'credito', '2.49', '2026-01-01')
$$]);

SELECT espera_erro('taxa: segunda vigência sobreposta para o mesmo meio', ARRAY[$$
  INSERT INTO taxa_meio_pagamento (clinica_id, meio, percentual, vigencia_inicio)
  VALUES ('c1111111-1111-1111-1111-111111111111', 'credito', '1.99', '2026-06-01')
$$]);

SELECT espera_ok('taxa: outro MEIO no mesmo período passa (contraprova)', ARRAY[$$
  INSERT INTO taxa_meio_pagamento (clinica_id, meio, percentual, vigencia_inicio)
  VALUES ('c1111111-1111-1111-1111-111111111111', 'debito', '1.49', '2026-06-01')
$$]);

SELECT espera_erro('taxa: dinheiro em espécie não tem MDR', ARRAY[$$
  INSERT INTO taxa_meio_pagamento (clinica_id, meio, percentual, vigencia_inicio)
  VALUES ('c1111111-1111-1111-1111-111111111111', 'dinheiro', '1.00', '2026-01-01')
$$]);

-- ── 22.7 Pix: a reentrega do PSP não move dinheiro duas vezes ─────────────
--
-- **A garantia central da conciliação.** PSP reentrega quando não recebe 200, e a
-- segunda notificação carrega o mesmo `end_to_end_id` porque é a mesma liquidação. O
-- índice único é o que transforma a reentrega em nada.
SELECT espera_ok('pix: primeiro evento entra', ARRAY[$$
  INSERT INTO evento_pix (clinica_id, end_to_end_id, txid, valor, liquidado_em, payload, motivo_nao_processado)
  VALUES ('c1111111-1111-1111-1111-111111111111',
          'E12345678202607271200invar1', 'txid-invariante', '100.00', now(), '{}'::jsonb, 'teste')
$$]);

SELECT espera_erro('pix: a REENTREGA do mesmo end_to_end_id é recusada', ARRAY[$$
  INSERT INTO evento_pix (clinica_id, end_to_end_id, txid, valor, liquidado_em, payload, motivo_nao_processado)
  VALUES ('c1111111-1111-1111-1111-111111111111',
          'E12345678202607271200invar1', 'txid-invariante', '100.00', now(), '{}'::jsonb, 'teste')
$$]);

--
-- CONTRAPROVA: a mesma liquidação em OUTRA clínica passa. O índice é
-- `(clinica_id, end_to_end_id)`, não global — e tem de ser: duas clínicas com contas
-- diferentes no mesmo PSP não compartilham espaço de identificador, e um índice global
-- faria a liquidação de uma bloquear a da outra.
SELECT espera_ok('pix: mesmo end_to_end_id em OUTRA clínica passa (contraprova)', ARRAY[$$
  INSERT INTO evento_pix (clinica_id, end_to_end_id, txid, valor, liquidado_em, payload, motivo_nao_processado)
  VALUES ('c2222222-2222-2222-2222-222222222222',
          'E12345678202607271200invar1', 'txid-invariante', '100.00', now(), '{}'::jsonb, 'teste')
$$]);

-- ── 22.8 Cobrança Pix: estado e evidência andam juntos ────────────────────
--
-- `pago` sem `end_to_end_id` é liquidação sem prova; `end_to_end_id` sem `pagamento_id`
-- é dinheiro que caiu e não entrou no caixa. Os dois são conciliação que não fecha.
SELECT espera_erro('pix: cobrança "paga" sem evidência de liquidação', ARRAY[$$
  INSERT INTO intencao_pix (clinica_id, parcela_id, txid, valor, situacao, expira_em)
  VALUES ('c1111111-1111-1111-1111-111111111111',
          (SELECT id FROM parcela WHERE clinica_id = 'c1111111-1111-1111-1111-111111111111' LIMIT 1),
          'txid-sem-prova', '100.00', 'pago', now() + interval '1 hour')
$$]);

-- ── 22.9 As tabelas novas não cruzam clínica ──────────────────────────────
SELECT espera_erro('despesa: categoria de outra clínica é recusada', ARRAY[$$
  INSERT INTO despesa (clinica_id, categoria_id, descricao, valor, competencia, vencimento)
  VALUES ('c2222222-2222-2222-2222-222222222222', 'bbbbbbbb-0000-0000-0000-0000000000f1',
          'Cruzando clínica', '10.00', '2026-07-01', '2026-07-10')
$$]);

-- ── 23. Fase 21: profundidade clínica ─────────────────────────────────────
--
-- Periograma, ordem de laboratório, propostas alternativas e ciclo de
-- esterilização. As garantias aqui são de EXAME CLÍNICO, não de cadastro: um campo
-- aceito onde não devia é diagnóstico que não se sustenta.
SET CONSTRAINTS ALL DEFERRED;

INSERT INTO periograma (id, paciente_id, profissional_id) VALUES
  ('e1111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333',
   '22222222-2222-2222-2222-222222222221');

-- Um molar superior, um molar inferior e um incisivo — os três casos que as travas
-- separam (palatina, lingual, e dente sem furca).
INSERT INTO periograma_dente (periograma_id, dente_fdi) VALUES
  ('e1111111-1111-1111-1111-111111111111', 16),
  ('e1111111-1111-1111-1111-111111111111', 36),
  ('e1111111-1111-1111-1111-111111111111', 11);

-- ── 23.1 O NIC é DERIVADO ─────────────────────────────────────────────────
--
-- A garantia central da fase. `nivel_insercao_mm` é `GENERATED ALWAYS`: o Postgres
-- recusa a escrita. Mesmo princípio de "glosa é CALCULADA, nunca digitada" — e aqui
-- pesa mais, porque o NIC é o número que diz se a doença progrediu.
/*
 * `espera_erro_dizendo` e não `espera_erro`, e o motivo é a guarda contra falso
 * verde do fim deste arquivo — que disparou aqui, com razão.
 *
 * Coluna gerada rejeita com `428C9` ("cannot insert a non-DEFAULT value into
 * column"), que não é sqlstate de integridade: pela lista da guarda, um caso que
 * "passasse" com 42xxx pode ter morrido antes de chegar à regra. A saída não é
 * acrescentar 428C9 à lista de permitidos — é o que a própria guarda prescreve:
 * **exigir o texto**. E aqui o texto é prova mais forte que o código, porque nomeia
 * a COLUNA: `428C9` sozinho provaria "alguma coluna gerada recusou"; com o nome,
 * prova que foi o NIC.
 */
SELECT espera_erro_dizendo('periograma: NIC não pode ser digitado (coluna gerada)', ARRAY[$$
  INSERT INTO periograma_sitio
    (periograma_id, dente_fdi, sitio, profundidade_sondagem_mm, recessao_mm, nivel_insercao_mm)
  VALUES ('e1111111-1111-1111-1111-111111111111', 16, 'vestibular', 5, 2, 99)
$$], 'nivel_insercao_mm');

SELECT espera_ok('periograma: sítio gravado sem o NIC (contraprova — o INSERT normal passa)', ARRAY[$$
  INSERT INTO periograma_sitio
    (periograma_id, dente_fdi, sitio, profundidade_sondagem_mm, recessao_mm, sangramento)
  VALUES ('e1111111-1111-1111-1111-111111111111', 16, 'vestibular', 6, 3, true)
$$]);

DO $$
DECLARE v_nic smallint;
BEGIN
  SELECT nivel_insercao_mm INTO v_nic FROM periograma_sitio
   WHERE periograma_id = 'e1111111-1111-1111-1111-111111111111'
     AND dente_fdi = 16 AND sitio = 'vestibular';
  PERFORM confere('periograma: NIC = PS + recessão (6 + 3)', v_nic = 9,
                  'NIC calculado pelo banco: ' || coalesce(v_nic::text, 'nulo'));
END $$;

/*
 * E a razão de o NIC não poder ser digitado, num só caso.
 *
 *   sítio A: PS 6, recessão 0  → NIC 6
 *   sítio B: PS 3, recessão 3  → NIC 6
 *
 * A profundidade de B é metade da de A e a inserção perdida é a MESMA: em B a
 * margem gengival desceu 3 mm, então a sonda entra menos porque começa mais
 * embaixo. Um painel que acompanhe só PS comemora a "melhora"; o NIC não se move.
 * Se este número fosse digitável, essa distinção viraria ruído.
 */
DO $$
DECLARE v_a smallint; v_b smallint;
BEGIN
  INSERT INTO periograma_sitio
    (periograma_id, dente_fdi, sitio, profundidade_sondagem_mm, recessao_mm)
  VALUES ('e1111111-1111-1111-1111-111111111111', 16, 'mesio_vestibular', 6, 0),
         ('e1111111-1111-1111-1111-111111111111', 16, 'disto_vestibular', 3, 3);

  SELECT nivel_insercao_mm INTO v_a FROM periograma_sitio
   WHERE periograma_id = 'e1111111-1111-1111-1111-111111111111'
     AND dente_fdi = 16 AND sitio = 'mesio_vestibular';
  SELECT nivel_insercao_mm INTO v_b FROM periograma_sitio
   WHERE periograma_id = 'e1111111-1111-1111-1111-111111111111'
     AND dente_fdi = 16 AND sitio = 'disto_vestibular';

  PERFORM confere('periograma: bolsa menor com gengiva retraída NÃO é menos perda',
                  v_a = 6 AND v_b = 6,
                  format('PS 6/rec 0 → NIC %s ; PS 3/rec 3 → NIC %s', v_a, v_b));
END $$;

-- ── 23.2 Faixas: o limite é do instrumento ────────────────────────────────
SELECT espera_erro('periograma: sondagem de 16 mm (sonda marca até 15)', ARRAY[$$
  INSERT INTO periograma_sitio (periograma_id, dente_fdi, sitio, profundidade_sondagem_mm)
  VALUES ('e1111111-1111-1111-1111-111111111111', 36, 'vestibular', 16)
$$]);

SELECT espera_ok('periograma: sondagem de 15 mm passa (contraprova — o limite é inclusivo)', ARRAY[$$
  INSERT INTO periograma_sitio (periograma_id, dente_fdi, sitio, profundidade_sondagem_mm)
  VALUES ('e1111111-1111-1111-1111-111111111111', 36, 'vestibular', 15)
$$]);

-- Recessão NEGATIVA é aumento gengival, e tem de passar: é o paciente em que bolsa
-- profunda não significa perda de inserção.
SELECT espera_ok('periograma: recessão negativa (aumento gengival) é aceita', ARRAY[$$
  INSERT INTO periograma_sitio (periograma_id, dente_fdi, sitio, profundidade_sondagem_mm, recessao_mm)
  VALUES ('e1111111-1111-1111-1111-111111111111', 36, 'mesio_vestibular', 6, -2)
$$]);

-- ── 23.3 Superior tem palatina, inferior tem lingual ──────────────────────
--
-- Mesma armadilha das faces do odontograma. Sem esta trava, o exame grava um sítio
-- que não existe naquele dente — e aí o par (dente, sítio) deixa de casar com o do
-- exame seguinte, o que quebra a comparação em silêncio.
SELECT espera_erro('periograma: sítio PALATINO em dente inferior', ARRAY[$$
  INSERT INTO periograma_sitio (periograma_id, dente_fdi, sitio, profundidade_sondagem_mm)
  VALUES ('e1111111-1111-1111-1111-111111111111', 36, 'palatina', 3)
$$]);

SELECT espera_erro('periograma: sítio LINGUAL em dente superior', ARRAY[$$
  INSERT INTO periograma_sitio (periograma_id, dente_fdi, sitio, profundidade_sondagem_mm)
  VALUES ('e1111111-1111-1111-1111-111111111111', 16, 'lingual', 3)
$$]);

SELECT espera_ok('periograma: lingual no inferior e palatina no superior (contraprova)', ARRAY[$$
  INSERT INTO periograma_sitio (periograma_id, dente_fdi, sitio, profundidade_sondagem_mm)
  VALUES ('e1111111-1111-1111-1111-111111111111', 36, 'lingual', 3),
         ('e1111111-1111-1111-1111-111111111111', 16, 'palatina', 3)
$$]);

-- ── 23.4 Sítio de dente que não está no exame ─────────────────────────────
--
-- O FK de `periograma_sitio` aponta para o DENTE do exame, não para o exame. É isso
-- que torna a presença do dente um fato registrado — e é dela que a comparação
-- deriva perda dentária.
SELECT espera_erro('periograma: sítio de dente que não foi examinado', ARRAY[$$
  INSERT INTO periograma_sitio (periograma_id, dente_fdi, sitio, profundidade_sondagem_mm)
  VALUES ('e1111111-1111-1111-1111-111111111111', 21, 'vestibular', 3)
$$]);

-- ── 23.5 Furca só em dente multirradicular ────────────────────────────────
SELECT espera_erro('periograma: furca em INCISIVO (raiz única)', ARRAY[$$
  UPDATE periograma_dente SET furca = 2
   WHERE periograma_id = 'e1111111-1111-1111-1111-111111111111' AND dente_fdi = 11
$$]);

SELECT espera_erro('periograma: furca em PRÉ-MOLAR inferior (raiz única)', ARRAY[$$
  INSERT INTO periograma_dente (periograma_id, dente_fdi, furca)
  VALUES ('e1111111-1111-1111-1111-111111111111', 34, 1)
$$]);

SELECT espera_ok('periograma: furca em MOLAR (contraprova)', ARRAY[$$
  UPDATE periograma_dente SET furca = 2, mobilidade = 1
   WHERE periograma_id = 'e1111111-1111-1111-1111-111111111111' AND dente_fdi = 16
$$]);

SELECT espera_erro('periograma: mobilidade fora de Miller (0–III)', ARRAY[$$
  UPDATE periograma_dente SET mobilidade = 4
   WHERE periograma_id = 'e1111111-1111-1111-1111-111111111111' AND dente_fdi = 16
$$]);

SELECT espera_erro('periograma: furca fora de Glickman (I–IV)', ARRAY[$$
  UPDATE periograma_dente SET furca = 5
   WHERE periograma_id = 'e1111111-1111-1111-1111-111111111111' AND dente_fdi = 16
$$]);

/*
 * A função da furca contra a lista escrita à mão.
 *
 * `dente_multirradicular()` é aritmética (`fdi % 10 IN (6,7,8)`), e aritmética que
 * ninguém confere é aritmética que um dia deixa de valer. `lib/domain/periograma.ts`
 * carrega a MESMA lista do lado TypeScript, com o mesmo propósito: duas
 * implementações da mesma regra sem cruzamento divergem, e no dia em que
 * divergirem o campo de furca aparece no dente errado.
 */
DO $$
DECLARE v_obtidos smallint[];
BEGIN
  SELECT coalesce(array_agg(fdi ORDER BY fdi), ARRAY[]::smallint[]) INTO v_obtidos
    FROM dente WHERE denticao = 'permanente' AND dente_multirradicular(fdi);
  PERFORM confere('periograma: dente_multirradicular() são exatamente os 12 molares',
                  v_obtidos = ARRAY[16,17,18,26,27,28,36,37,38,46,47,48]::smallint[],
                  'obtidos: ' || v_obtidos::text);
END $$;

-- ── 23.6 Decíduo não entra ────────────────────────────────────────────────
--
-- ⚠️ ESCOLHA que precisa do dentista: mobilidade de Miller num decíduo
-- pré-esfoliação mede o oposto de doença — o dente que balança perto da troca está
-- fazendo o que deve.
SELECT espera_erro('periograma: dente DECÍDUO é recusado', ARRAY[$$
  INSERT INTO periograma_dente (periograma_id, dente_fdi)
  VALUES ('e1111111-1111-1111-1111-111111111111', 55)
$$]);

-- ── 23.7 Propostas alternativas ───────────────────────────────────────────
--
-- O caso de USO: várias propostas em rascunho para o mesmo paciente, no mesmo
-- grupo. É isto que a fase entrega, e é o que tem de passar.
SELECT espera_ok('plano: três propostas alternativas no mesmo grupo (rascunho)', ARRAY[$$
  INSERT INTO plano_tratamento (paciente_id, profissional_id, titulo, status, grupo_proposta)
  VALUES ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222221',
          'Proposta A — implante', 'rascunho', 'e5555555-5555-5555-5555-555555555555'),
         ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222221',
          'Proposta B — prótese fixa', 'rascunho', 'e5555555-5555-5555-5555-555555555555'),
         ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222221',
          'Proposta C — o que dá para fazer agora', 'rascunho', 'e5555555-5555-5555-5555-555555555555')
$$]);

/*
 * E a trava: no máximo UMA em execução.
 *
 * Note que a fixture da seção 5 já deixou um plano `ativo` para este paciente, e o
 * caso "plano: dois ativos para o mesmo paciente" (seção 7) já provou que o índice
 * `plano_um_ativo_por_paciente` **não foi afrouxado** por esta fase. O caso abaixo é
 * a trava POR GRUPO, que é redundante com ela de propósito: se alguém um dia ampliar
 * a unicidade por paciente sem perceber que o grupo dependia dela, este caso pega.
 */
SELECT espera_erro('plano: duas propostas do mesmo grupo em EXECUÇÃO', ARRAY[$$
  UPDATE plano_tratamento SET status = 'ativo'
   WHERE grupo_proposta = 'e5555555-5555-5555-5555-555555555555'
$$]);

-- Um grupo é de UM paciente: "proposta A" de um e "proposta B" de outro apareceriam
-- lado a lado, com o preço e o diagnóstico de outra pessoa ao lado deste nome.
-- `espera_erro_dizendo`: a trigger estoura com `integrity_constraint_violation`
-- (23000, o código da CLASSE), que também não está na lista da guarda. E o texto é
-- melhor mesmo: 23000 provaria "alguma trigger de integridade recusou"; o texto prova
-- que foi ESTA, e não a unicidade de plano ativo que está logo acima.
SELECT espera_erro_dizendo('plano: grupo de propostas com DOIS pacientes', ARRAY[$$
  INSERT INTO paciente (id, nome, data_nascimento)
  VALUES ('e6666666-6666-6666-6666-666666666666', 'Outro Paciente', '1985-01-01')
$$, $$
  INSERT INTO plano_tratamento (paciente_id, profissional_id, titulo, status, grupo_proposta)
  VALUES ('e6666666-6666-6666-6666-666666666666', '22222222-2222-2222-2222-222222222221',
          'Proposta de outra pessoa', 'rascunho', 'e5555555-5555-5555-5555-555555555555')
$$], 'ja pertence a outro paciente');

-- ── 23.8 Ordem de laboratório ─────────────────────────────────────────────
INSERT INTO laboratorio (id, nome) VALUES
  ('e3333333-3333-3333-3333-333333333333', 'Laboratório de Teste');

INSERT INTO item_plano (id, plano_id, procedimento_id, valor, dente_fdi)
SELECT 'e2222222-2222-2222-2222-222222222222',
       '99999999-9999-9999-9999-999999999991', id, '1600.00', 26
  FROM procedimento
 WHERE clinica_id = 'c1111111-1111-1111-1111-111111111111' AND codigo = 'CIR-001';

SELECT espera_erro('laboratório: ordem "recebida" sem data de recebimento', ARRAY[$$
  INSERT INTO ordem_laboratorio
    (laboratorio_id, item_plano_id, especificacao, situacao, enviada_em)
  VALUES ('e3333333-3333-3333-3333-333333333333', 'e2222222-2222-2222-2222-222222222222',
          'Coroa metalocerâmica 26', 'recebida', now())
$$]);

SELECT espera_erro('laboratório: ordem "enviada" sem data de envio', ARRAY[$$
  INSERT INTO ordem_laboratorio (laboratorio_id, item_plano_id, especificacao, situacao)
  VALUES ('e3333333-3333-3333-3333-333333333333', 'e2222222-2222-2222-2222-222222222222',
          'Coroa metalocerâmica 26', 'enviada')
$$]);

SELECT espera_erro('laboratório: recebida ANTES de enviada', ARRAY[$$
  INSERT INTO ordem_laboratorio
    (laboratorio_id, item_plano_id, especificacao, situacao, enviada_em, recebida_em)
  VALUES ('e3333333-3333-3333-3333-333333333333', 'e2222222-2222-2222-2222-222222222222',
          'Coroa metalocerâmica 26', 'recebida', now(), now() - interval '2 days')
$$]);

SELECT espera_ok('laboratório: ordem enviada e recebida na ordem certa (contraprova)', ARRAY[$$
  INSERT INTO ordem_laboratorio
    (id, laboratorio_id, item_plano_id, especificacao, cor, situacao, enviada_em, recebida_em, custo)
  VALUES ('e7777777-7777-7777-7777-777777777777',
          'e3333333-3333-3333-3333-333333333333', 'e2222222-2222-2222-2222-222222222222',
          'Coroa metalocerâmica 26', 'A2', 'recebida',
          now() - interval '5 days', now() - interval '1 day', '480.00')
$$]);

-- Refação é ordem NOVA apontando para a anterior — e sem motivo escrito não se sabe
-- quem paga.
SELECT espera_erro('laboratório: refação sem motivo', ARRAY[$$
  INSERT INTO ordem_laboratorio
    (laboratorio_id, item_plano_id, especificacao, refaz_id)
  VALUES ('e3333333-3333-3333-3333-333333333333', 'e2222222-2222-2222-2222-222222222222',
          'Coroa metalocerâmica 26 — refação', 'e7777777-7777-7777-7777-777777777777')
$$]);

SELECT espera_erro('laboratório: custo negativo', ARRAY[$$
  INSERT INTO ordem_laboratorio (laboratorio_id, item_plano_id, especificacao, custo)
  VALUES ('e3333333-3333-3333-3333-333333333333', 'e2222222-2222-2222-2222-222222222222',
          'Coroa', '-10.00')
$$]);

-- ── 23.9 Ciclo de esterilização ───────────────────────────────────────────
INSERT INTO autoclave (id, nome) VALUES
  ('e4444444-4444-4444-4444-444444444444', 'Autoclave de Teste');

/*
 * O indicador BIOLÓGICO chega dias depois, e é ele que certifica o ciclo.
 * `certificado` é coluna GERADA justamente por isso: um ciclo com biológico
 * pendente não está certificado, e deixar isso a cargo de quem digita é o mesmo
 * erro do campo de glosa digitado.
 */
-- Mesma família do NIC: 428C9 não é integridade, então a prova é o TEXTO, que nomeia
-- a coluna. Ver o comentário na seção 23.1.
SELECT espera_erro_dizendo('esterilização: "certificado" não pode ser digitado (coluna gerada)', ARRAY[$$
  INSERT INTO ciclo_esterilizacao
    (numero, autoclave_id, responsavel_id, iniciado_em, conteudo, indicador_quimico, certificado)
  VALUES (1, 'e4444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
          now(), 'Kit periodontia', 'aprovado', true)
$$], 'certificado');

DO $$
DECLARE v_cert boolean;
BEGIN
  INSERT INTO ciclo_esterilizacao
    (id, numero, autoclave_id, responsavel_id, iniciado_em, conteudo, indicador_quimico)
  VALUES ('e8888888-8888-8888-8888-888888888888', 1,
          'e4444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
          now(), 'Kit periodontia', 'aprovado');

  SELECT certificado INTO v_cert FROM ciclo_esterilizacao
   WHERE id = 'e8888888-8888-8888-8888-888888888888';
  PERFORM confere('esterilização: biológico PENDENTE não certifica o ciclo',
                  v_cert = false, 'certificado = ' || v_cert::text);

  UPDATE ciclo_esterilizacao
     SET biologico_resultado = 'negativo', biologico_lido_em = now()
   WHERE id = 'e8888888-8888-8888-8888-888888888888';

  SELECT certificado INTO v_cert FROM ciclo_esterilizacao
   WHERE id = 'e8888888-8888-8888-8888-888888888888';
  PERFORM confere('esterilização: biológico NEGATIVO certifica (contraprova)',
                  v_cert = true, 'certificado = ' || v_cert::text);

  UPDATE ciclo_esterilizacao
     SET biologico_resultado = 'positivo'
   WHERE id = 'e8888888-8888-8888-8888-888888888888';

  SELECT certificado INTO v_cert FROM ciclo_esterilizacao
   WHERE id = 'e8888888-8888-8888-8888-888888888888';
  PERFORM confere('esterilização: biológico POSITIVO descertifica',
                  v_cert = false, 'certificado = ' || v_cert::text);
END $$;

-- Químico reprovado nunca certifica, mesmo com biológico negativo.
DO $$
DECLARE v_cert boolean;
BEGIN
  INSERT INTO ciclo_esterilizacao
    (id, numero, autoclave_id, responsavel_id, iniciado_em, conteudo,
     indicador_quimico, biologico_resultado, biologico_lido_em)
  VALUES ('e9999999-9999-9999-9999-999999999999', 2,
          'e4444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
          now(), 'Kit cirurgia', 'reprovado', 'negativo', now());

  SELECT certificado INTO v_cert FROM ciclo_esterilizacao
   WHERE id = 'e9999999-9999-9999-9999-999999999999';
  PERFORM confere('esterilização: químico REPROVADO não certifica nem com biológico negativo',
                  v_cert = false, 'certificado = ' || v_cert::text);
END $$;

SELECT espera_erro('esterilização: resultado biológico sem data de leitura', ARRAY[$$
  INSERT INTO ciclo_esterilizacao
    (numero, autoclave_id, responsavel_id, iniciado_em, conteudo, indicador_quimico,
     biologico_resultado)
  VALUES (3, 'e4444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
          now(), 'Kit dentística', 'aprovado', 'negativo')
$$]);

SELECT espera_erro('esterilização: data de leitura com resultado pendente', ARRAY[$$
  INSERT INTO ciclo_esterilizacao
    (numero, autoclave_id, responsavel_id, iniciado_em, conteudo, indicador_quimico,
     biologico_resultado, biologico_lido_em)
  VALUES (4, 'e4444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
          now(), 'Kit dentística', 'aprovado', 'pendente', now())
$$]);

-- A etiqueta do pacote é a única ligação física entre ele e o registro: dois ciclos
-- com o mesmo número, no mesmo dia e na mesma autoclave a tornariam ambígua.
SELECT espera_erro('esterilização: mesmo número, mesmo dia, mesma autoclave', ARRAY[$$
  INSERT INTO ciclo_esterilizacao
    (numero, autoclave_id, responsavel_id, iniciado_em, conteudo, indicador_quimico)
  VALUES (1, 'e4444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
          now(), 'Outra carga', 'aprovado')
$$]);

SELECT espera_erro('esterilização: conteúdo vazio (carga sem descrição não é registro)', ARRAY[$$
  INSERT INTO ciclo_esterilizacao
    (numero, autoclave_id, responsavel_id, iniciado_em, conteudo, indicador_quimico)
  VALUES (9, 'e4444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
          now(), '   ', 'aprovado')
$$]);

-- ── 23.10 As tabelas novas não cruzam clínica ─────────────────────────────
SELECT espera_erro('periograma: paciente de outra clínica é recusado', ARRAY[$$
  INSERT INTO periograma (clinica_id, paciente_id, profissional_id)
  VALUES ('c2222222-2222-2222-2222-222222222222',
          '33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222221')
$$]);

SELECT espera_erro('laboratório: item de plano de outra clínica é recusado', ARRAY[$$
  INSERT INTO ordem_laboratorio (clinica_id, laboratorio_id, item_plano_id, especificacao)
  VALUES ('c2222222-2222-2222-2222-222222222222',
          'e3333333-3333-3333-3333-333333333333', 'e2222222-2222-2222-2222-222222222222',
          'Cruzando clínica')
$$]);

/*
 * E a trava de suspensão nas sete tabelas novas.
 *
 * O laço da `drizzle/0027` varreu o catálogo UMA VEZ, e o cabeçalho dela afirmava o
 * contrário — a frase foi corrigida e este caso de catálogo existe para a próxima
 * fase não depender de alguém lembrar. Sem a política, clínica suspensa escreveria
 * livremente na tabela nova, sem erro nenhum.
 */
DO $$
DECLARE v_faltando text[];
BEGIN
  SELECT coalesce(array_agg(t ORDER BY t), ARRAY[]::text[]) INTO v_faltando
    FROM unnest(ARRAY[
      'periograma', 'periograma_dente', 'periograma_sitio',
      'laboratorio', 'ordem_laboratorio', 'autoclave', 'ciclo_esterilizacao'
    ]) AS t
   WHERE (SELECT count(*) FROM pg_policies p
           WHERE p.tablename = t AND p.policyname LIKE 'assinatura_trava_%') <> 2;

  PERFORM confere('Fase 21: as sete tabelas novas têm a trava de suspensão',
                  array_length(v_faltando, 1) IS NULL,
                  'sem trava: ' || array_to_string(v_faltando, ', '));
END $$;

-- ── Relatório ───────────────────────────────────────────────────────────────
\echo ''
\echo '════════════════════════════════════════════════════════════════════════'
\echo ' Invariantes do banco'
\echo '════════════════════════════════════════════════════════════════════════'

SELECT
  CASE WHEN passou THEN 'PASSOU' ELSE ' FALHOU' END AS r,
  caso,
  obtido
FROM resultado ORDER BY ordem;

\echo ''
SELECT
  count(*)                          AS total,
  count(*) FILTER (WHERE passou)    AS passaram,
  count(*) FILTER (WHERE NOT passou) AS falharam
FROM resultado;

-- ── A guarda contra o falso verde ───────────────────────────────────────────
--
-- Esta é a trava mais importante do arquivo, e ela não existia. `espera_erro`
-- captura `WHEN others`: **qualquer** erro conta como sucesso. Então um caso
-- continua marcando PASSOU quando nunca chegou perto da regra que diz testar —
-- basta a coluna ter mudado de tipo, a tabela não existir, o valor de enum estar
-- errado, ou o alvo de `ON CONFLICT` não casar com índice nenhum.
--
-- Isso já aconteceu TRÊS vezes neste projeto:
--   • um `espera_erro` sobre tabela que não existia ("passou" por 42P01);
--   • uma trigger comparando com `'falta'`, que não é valor do enum ('faltou'):
--     o 22P02 virou sucesso e a regra da cadeira nunca foi exercitada;
--   • e agora, na 0022, `clinica: segunda linha (deve ser singleton)` marcando
--     PASSOU com 42804 por `id = 1` num uuid — afirmando uma invariante que a
--     migration havia REMOVIDO.
--
-- A distinção é objetiva, então dá para cobrá-la em SQL. Violação de invariante
-- tem sqlstate de integridade:
--     23514 check · 23505 unique · 23503 fk · 23001 restrict · 23P01 exclusion
--     23502 not null · P0001 raise de trigger
-- Já 42xxx (objeto/tipo errado), 22P02 (enum inválido) e 42601 (sintaxe) dizem
-- que o comando morreu ANTES da regra. Como prova de invariante, valem zero.
--
-- ── Por que `rejeitar (texto)` fica de fora ─────────────────────────────────
-- Os casos de `espera_erro_dizendo` já provaram a MENSAGEM, que é prova mais forte
-- que o sqlstate — e são justamente eles que legitimamente têm código 42xxx:
-- `app_clinica_id()` estoura com 42501 (`insufficient_privilege`), de propósito.
-- Se 42501 entrasse na lista de permitidos, um caso passaria por falta de `GRANT`
-- na role de aplicação em vez de pela política de RLS, e essa confusão é exatamente
-- o falso verde que esta guarda existe para pegar. A saída certa não é afrouxar a
-- lista: é exigir o texto de quem precisa de 42xxx.
DO $$
DECLARE
  v_suspeitos text;
  v_n         int;
BEGIN
  SELECT count(*), string_agg(format(E'\n    • %s\n      → %s', caso, obtido), '')
    INTO v_n, v_suspeitos
    FROM resultado
   WHERE passou
     AND esperado = 'rejeitar'
     AND split_part(obtido, ':', 1) NOT IN
         ('23514','23505','23503','23001','23P01','23502','P0001');

  IF v_n > 0 THEN
    RAISE EXCEPTION
      E'% caso(s) "passaram" pelo motivo ERRADO — o comando falhou antes de chegar '
      'à invariante, então nada foi provado:%\n'
      '  Conserte a fixture (não o sqlstate esperado). Se a invariante deixou de '
      'existir de propósito, REMOVA o caso e escreva no lugar o que a substituiu.',
      v_n, v_suspeitos;
  END IF;
END $$;

-- Falha o script inteiro se qualquer caso falhou, para servir em CI.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM resultado WHERE NOT passou;
  IF n > 0 THEN
    RAISE EXCEPTION '% invariante(s) do banco falharam', n;
  END IF;
  RAISE NOTICE 'Todas as invariantes do banco estão valendo.';
END $$;

ROLLBACK;
