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
