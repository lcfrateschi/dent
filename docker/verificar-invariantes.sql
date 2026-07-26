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
