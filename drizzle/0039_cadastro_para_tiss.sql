-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Os campos que o XSD da ANS exige e o banco não tinha — são TRÊS, não 4    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── Correção de contagem, e o que a produziu ───────────────────────────────
-- O relatório da validação contra o XSD listou **quatro** campos ausentes. São três:
-- `paciente_convenio.plano` **já existia** desde a Fase 13, criado junto da
-- carteirinha, e ninguém tinha notado porque o gerador de XML nunca foi ligado a uma
-- consulta do banco — ele recebe `CadastroParaTiss` montado à mão nos testes.
--
-- Quem descobriu foi o Postgres: a primeira versão desta migration morreu com
-- `column "plano" of relation "paciente_convenio" already exists`, e o
-- `--single-transaction` desfez tudo. É o argumento inteiro a favor de aplicar
-- migration por `psql -v ON_ERROR_STOP=1 --single-transaction` em vez de confiar no
-- runner: falhou, nada ficou pela metade, e a mensagem diz o que é.
--
-- O contexto: a validação contra os XSDs oficiais da ANS 3.05.00 (ver
-- `dados/tiss-xsd-3.05.00/`) mostrou nove erros no gerador — todos corrigidos — e
-- campos **obrigatórios que não existiam em lugar nenhum do sistema**.
-- `xmlGuiaOdontologica` estoura nomeando o que falta, e `conferirAntesDeEnviar` os
-- lista um por um: é o comportamento certo, porque XML incompleto passa no parser e
-- volta como glosa semanas depois.
--
-- Esta migration cria onde guardá-los. **Ela não os preenche**, e isso é deliberado —
-- é o mesmo motivo dos 13 códigos TUSS em branco (`dados/README.md`): valor plausível
-- e errado passa no schema e vira glosa. Quem sabe o CNES da clínica é a clínica.
--
-- ── Todos ANULÁVEIS, e por quê ─────────────────────────────────────────────
-- `NOT NULL` exigiria backfill com valor inventado, que é exatamente o que se quer
-- evitar. E travaria o cadastro de quem não fatura convênio nenhum: uma clínica só
-- particular não tem código de prestador em operadora, e nunca vai ter. O que cobra o
-- preenchimento é a emissão do XML, no momento em que ele importa.

-- ── 1. CNES da clínica ─────────────────────────────────────────────────────
--
-- Cadastro Nacional de Estabelecimentos de Saúde. Sete dígitos, e o CHECK vale porque
-- o formato é padrão nacional, não convenção nossa: um CNES com 6 dígitos é erro de
-- digitação, e o único lugar onde ele aparece é dentro da guia que a operadora recusa.
ALTER TABLE clinica ADD COLUMN cnes varchar(7);
--> statement-breakpoint

ALTER TABLE clinica ADD CONSTRAINT clinica_cnes_formato
  CHECK (cnes IS NULL OR cnes ~ '^[0-9]{7}$');
--> statement-breakpoint

COMMENT ON COLUMN clinica.cnes IS
  'CNES do estabelecimento, 7 dígitos. Obrigatório no XML TISS; anulável porque clínica só particular não tem.';
--> statement-breakpoint

-- ── 2. Código do prestador NA OPERADORA ────────────────────────────────────
--
-- Fica em `convenio` e não em `clinica` porque **é um código por operadora**: a mesma
-- clínica é o prestador 4711 na Amil e 90233-2 na SulAmérica. Como `convenio` já é por
-- clínica (Fase 17), a coluna aqui já significa "o código DESTA clínica NAQUELA
-- operadora" sem precisar de tabela de ligação.
--
-- Sem CHECK de formato: cada operadora usa o seu, com letras, hífen e tamanhos
-- diferentes. Um CHECK aqui seria convenção nossa recusando dado legítimo do cliente —
-- o oposto do CNES, que tem formato nacional.
ALTER TABLE convenio ADD COLUMN codigo_prestador varchar(20);
--> statement-breakpoint

COMMENT ON COLUMN convenio.codigo_prestador IS
  'Código desta clínica NESTA operadora, como ela o atribuiu. Formato livre: varia por operadora.';
--> statement-breakpoint

-- ── 3. CBO-S do profissional ───────────────────────────────────────────────
--
-- Classificação Brasileira de Ocupações, seis dígitos. O CHECK exige a família
-- **2232**, e isso não é dedução minha: o domínio `dm_CBOS` do XSD da ANS documenta a
-- faixa 2232xx como cirurgião-dentista, e foi lida do arquivo oficial (a procedência
-- está em `dados/tiss-xsd-3.05.00/PROCEDENCIA.md`).
--
-- A trava é segura nesta tabela porque `profissional` é 1:1 com usuário de perfil
-- `dentista` e exige CRO — auxiliar de saúde bucal (família 3224) não entra aqui. Se um
-- dia entrar, a trava é que vai avisar, e é melhor que avisar seja o comportamento.
ALTER TABLE profissional ADD COLUMN cbos varchar(6);
--> statement-breakpoint

ALTER TABLE profissional ADD CONSTRAINT profissional_cbos_formato
  CHECK (cbos IS NULL OR cbos ~ '^2232[0-9]{2}$');
--> statement-breakpoint

COMMENT ON COLUMN profissional.cbos IS
  'CBO-S, 6 dígitos, família 2232 (cirurgião-dentista) conforme dm_CBOS do XSD da ANS.';
--> statement-breakpoint

-- ── 4. O plano do beneficiário JÁ EXISTE ──────────────────────────────────
--
-- `paciente_convenio.plano` (`text`) foi criado com a carteirinha, na Fase 13. Nada a
-- fazer aqui, e o registro fica para a próxima pessoa não repetir a tentativa: o campo
-- está no lugar certo (atributo do vínculo, porque o mesmo paciente pode ter plano
-- diferente em cada operadora, e o plano muda sem a carteirinha mudar).

-- ── 5. Asserção: as três colunas existem, e as travas RECUSAM valor errado ─
--
-- No estilo do resto do projeto, com a parte que costuma faltar: a trava é conferida
-- contra valor **errado**. Um CHECK que aceita tudo também "passa" quando testado só
-- com dado bom — e é assim que nasce constraint decorativa.
--
-- `BEGIN … EXCEPTION` e não `ROLLBACK TO SAVEPOINT`: o savepoint desfaria também o
-- registro do resultado, e dois agentes deste projeto já tiveram relatório pulando um
-- caso por causa disso.
DO $$
DECLARE
  v_faltando text[] := ARRAY[]::text[];
  v_passou   boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='clinica' AND column_name='cnes') THEN
    v_faltando := v_faltando || 'clinica.cnes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='convenio' AND column_name='codigo_prestador') THEN
    v_faltando := v_faltando || 'convenio.codigo_prestador';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='profissional' AND column_name='cbos') THEN
    v_faltando := v_faltando || 'profissional.cbos';
  END IF;
  IF array_length(v_faltando, 1) > 0 THEN
    RAISE EXCEPTION 'Colunas do cadastro TISS ausentes: %', array_to_string(v_faltando, ', ');
  END IF;

  -- CNES com 6 dígitos tem de ser recusado.
  v_passou := false;
  BEGIN
    UPDATE clinica SET cnes = '123456';
    v_passou := true;
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  IF v_passou THEN
    RAISE EXCEPTION 'clinica_cnes_formato aceitou 6 dígitos — a trava é decorativa.';
  END IF;

  -- CBO-S da família 3224 (auxiliar de saúde bucal) tem de ser recusado: esta tabela é
  -- de cirurgião-dentista, e a família certa é 2232 conforme `dm_CBOS` do XSD.
  v_passou := false;
  BEGIN
    UPDATE profissional SET cbos = '322405';
    v_passou := true;
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  IF v_passou THEN
    RAISE EXCEPTION 'profissional_cbos_formato aceitou a família 3224 — a trava é decorativa.';
  END IF;

  -- E o valor CERTO tem de passar, senão a trava recusaria o cadastro legítimo. Sem
  -- este par, "recusa o errado" poderia ser "recusa tudo".
  BEGIN
    UPDATE clinica SET cnes = '1234567';
    UPDATE profissional SET cbos = '223208';
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'A trava recusou valor VÁLIDO (CNES 1234567 / CBO-S 223208): %', SQLERRM;
  END;
  -- Desfaz o valor de teste: esta migration não preenche cadastro de ninguém.
  UPDATE clinica SET cnes = NULL;
  UPDATE profissional SET cbos = NULL;

  RAISE NOTICE 'Cadastro TISS: 3 colunas criadas; travas recusam valor errado e aceitam o certo.';
END $$;
