-- ============================================================================
-- Prova que as invariantes de drizzle/0001_constraints.sql realmente funcionam.
--
-- Não é teste de aplicação: é teste do BANCO. As garantias legais (prontuário
-- imutável) e financeiras (soma das parcelas) só valem se o Postgres as impuser
-- mesmo quando a aplicação está com bug.
--
--   docker compose exec -T db psql -U dent -d dent -f - < docker/verificar-invariantes.sql
--
-- Roda numa transação e faz ROLLBACK ao final: não deixa lixo no banco.
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

-- ── Fixtures ────────────────────────────────────────────────────────────────
INSERT INTO clinica (id, razao_social) VALUES (1, 'Clínica de Teste')
  ON CONFLICT (id) DO NOTHING;

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
    FROM procedimento WHERE codigo='CONS-001'
$$]);

SELECT espera_erro('item de plano: faces sem dente', ARRAY[$$
  INSERT INTO item_plano (plano_id, procedimento_id, valor, faces)
  SELECT '99999999-9999-9999-9999-999999999991', id, '100.00', ARRAY['oclusal']::face_dente[]
    FROM procedimento WHERE codigo='DENT-001'
$$]);

SELECT espera_ok('item de plano: dente e faces coerentes', ARRAY[$$
  INSERT INTO item_plano (plano_id, procedimento_id, valor, dente_fdi, faces)
  SELECT '99999999-9999-9999-9999-999999999991', id, '230.00', 16,
         ARRAY['oclusal','mesial']::face_dente[]
    FROM procedimento WHERE codigo='DENT-001'
$$]);

SELECT espera_erro('item de plano: dente FDI inexistente', ARRAY[$$
  INSERT INTO item_plano (plano_id, procedimento_id, valor, dente_fdi)
  SELECT '99999999-9999-9999-9999-999999999991', id, '350.00', 19
    FROM procedimento WHERE codigo='CIR-001'
$$]);

-- ── 6. Outras invariantes ───────────────────────────────────────────────────
SELECT espera_erro('clínica: segunda linha (deve ser singleton)', ARRAY[$$
  INSERT INTO clinica (id, razao_social) VALUES (2, 'Outra clínica')
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
   (SELECT id FROM procedimento LIMIT 1), 'convenio',
   'cccc0000-0000-4000-8000-000000000001', '100.00', 'executado'),
  ('eeee0000-0000-4000-8000-000000000002', 'dddd0000-0000-4000-8000-000000000001',
   (SELECT id FROM procedimento LIMIT 1), 'convenio',
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
          (SELECT id FROM procedimento LIMIT 1),
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
          (SELECT id FROM procedimento LIMIT 1), '100.00', '120', '2026-01-01')
$$]);

SELECT espera_erro('convênio: vigência com fim antes do início', ARRAY[$$
  INSERT INTO preco_convenio (convenio_id, procedimento_id, valor, vigencia_inicio, vigencia_fim)
  VALUES ('cccc0000-0000-4000-8000-000000000001',
          (SELECT id FROM procedimento LIMIT 1), '100.00', '2026-06-01', '2026-01-01')
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
  VALUES ((SELECT id FROM procedimento LIMIT 1), 'aaaa1400-0000-4000-8000-000000000001', '0')
$$]);

SELECT espera_erro('estoque: mesmo material duas vezes na ficha do procedimento', ARRAY[$$
  INSERT INTO insumo_procedimento (procedimento_id, material_id, quantidade)
  VALUES ((SELECT id FROM procedimento LIMIT 1), 'aaaa1400-0000-4000-8000-000000000001', '1')
$$, $$
  INSERT INTO insumo_procedimento (procedimento_id, material_id, quantidade)
  VALUES ((SELECT id FROM procedimento LIMIT 1), 'aaaa1400-0000-4000-8000-000000000001', '2')
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
        (SELECT id FROM procedimento WHERE codigo = 'DENT-001'),
        '100.00', '2025-01-01');

SELECT espera_erro('convênio: duas vigências ABERTAS para o mesmo procedimento', ARRAY[$$
  INSERT INTO preco_convenio (convenio_id, procedimento_id, valor, vigencia_inicio)
  VALUES ('cccc0000-0000-4000-8000-000000000001',
          (SELECT id FROM procedimento WHERE codigo = 'DENT-001'),
          '120.00', '2026-01-01')
$$]);

SELECT espera_erro('convênio: vigência nova sobrepondo período fechado', ARRAY[$$
  UPDATE preco_convenio SET vigencia_fim = '2025-12-31'
   WHERE id = 'b0000000-0000-4000-8000-000000000001'
$$, $$
  INSERT INTO preco_convenio (convenio_id, procedimento_id, valor, vigencia_inicio, vigencia_fim)
  VALUES ('cccc0000-0000-4000-8000-000000000001',
          (SELECT id FROM procedimento WHERE codigo = 'DENT-001'),
          '120.00', '2025-06-01', '2025-08-31')
$$]);

SELECT espera_ok('convênio: fechar a vigência e abrir a seguinte no dia seguinte', ARRAY[$$
  UPDATE preco_convenio SET vigencia_fim = '2025-12-31'
   WHERE id = 'b0000000-0000-4000-8000-000000000001'
$$, $$
  INSERT INTO preco_convenio (id, convenio_id, procedimento_id, valor, vigencia_inicio)
  VALUES ('b0000000-0000-4000-8000-000000000002',
          'cccc0000-0000-4000-8000-000000000001',
          (SELECT id FROM procedimento WHERE codigo = 'DENT-001'),
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
          (SELECT id FROM procedimento WHERE codigo = 'DENT-002'),
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
        (SELECT id FROM procedimento WHERE codigo = 'DENT-001'),
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
