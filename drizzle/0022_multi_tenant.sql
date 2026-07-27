-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Fase 17 — Fundação multi-tenant, parte 1: a coluna e o contexto          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Escrita à mão de propósito. `drizzle-kit generate` produziria duas coisas
-- impossíveis:
--
--   1. `ALTER TABLE clinica ALTER COLUMN id TYPE uuid` — não existe cast de
--      smallint para uuid, e a migration morreria no meio;
--   2. `ADD COLUMN clinica_id uuid NOT NULL` direto — que falha em qualquer
--      tabela com linha dentro, ou (pior) passa num banco vazio e explode no
--      primeiro cliente que já tem dados.
--
-- A sequência segura é: coluna anulável → backfill → NOT NULL → DEFAULT → FK.
--
-- Row Level Security, roles e FK composto ficam na 0023: são um assunto só, e
-- misturá-los aqui daria uma migration que ninguém consegue revisar.
--
-- ── O pressuposto, escrito porque ele importa ───────────────────────────────
-- Esta migration presume **no máximo uma clínica** no banco (é o estado de todo
-- banco Facilident até aqui — o `CHECK clinica_singleton` garantia isso). Não é
-- suposição de conforto: com duas clínicas já dentro, não existe backfill
-- correto, porque nada nas linhas diria de quem elas são. A asserção do passo 1
-- cobra isso e aborta antes de tocar em qualquer tabela.

--
-- ── Sobre o arquivo gerado que este substituiu ──────────────────────────────
-- `drizzle-kit generate` foi rodado (é dele que vem `meta/0022_snapshot.json`,
-- que as gerações futuras usam como base), e o SQL que ele produziu foi
-- **descartado em favor deste**. O que ele gerou: os 39 `ADD COLUMN … NOT NULL`
-- diretos, a tabela `contador` e um índice. O que ele NÃO gerou, e é a maior
-- parte do trabalho: a troca da PK de `clinica`, os DROPs das constraints únicas
-- globais, os FKs para `clinica`, o backfill e a asserção de catálogo. Ou seja: o
-- arquivo gerado, aplicado como veio, deixaria um banco quebrado — e a lição vale
-- para a próxima migration deste tipo.

-- ── 1. Este banco pode ser migrado? ────────────────────────────────────────────
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM clinica;
  IF v_n > 1 THEN
    RAISE EXCEPTION
      'Este banco tem % clínicas. A 0022 só sabe migrar um banco single-tenant: '
      'com mais de uma, não há como saber de quem é cada linha das outras tabelas.', v_n;
  END IF;
END $$;
--> statement-breakpoint

-- ── 2. `app_clinica_id()`: o contexto, e o estouro na ausência dele ──────────
--
-- Esta função é o coração do isolamento. Ela é lida em três lugares: no DEFAULT
-- de toda coluna `clinica_id`, nas políticas de RLS (0023) e por
-- `hoje_na_clinica()`.
--
-- **Ela estoura quando não há contexto, e isso é o desenho, não um descuido.**
-- A alternativa óbvia seria devolver NULL:
--
--   • no DEFAULT, um NULL bateria no NOT NULL — erro, tudo bem;
--   • mas na POLÍTICA de RLS, `clinica_id = NULL` é NULL, que a política trata
--     como falso: a consulta devolveria **zero linhas, sem erro**. Uma agenda
--     vazia não parece bug, parece um dia fraco. Um relatório de R$ 0,00 não
--     parece bug, parece um mês ruim. É o pior modo de falha possível: silencioso
--     e plausível.
--
-- Estourar transforma "esqueci o envelope de transação" de vazamento silencioso
-- em erro na primeira query, com o nome da variável na mensagem.
--
-- `current_setting(…, true)` (o `true` é *missing_ok*) devolve NULL em vez de
-- estourar quando a variável nunca foi definida — sem ele, a mensagem seria a do
-- Postgres ("unrecognized configuration parameter"), que não diz o que fazer.
CREATE OR REPLACE FUNCTION app_clinica_id() RETURNS uuid AS $$
DECLARE v_txt text;
BEGIN
  v_txt := current_setting('app.clinica_id', true);
  IF v_txt IS NULL OR v_txt = '' THEN
    RAISE EXCEPTION
      'Sem contexto de clínica: app.clinica_id não está definido nesta transação. '
      'Use comClinica() (lib/tenant/executar.ts) — todo acesso a dado de clínica '
      'passa por ele. Script de linha de comando precisa definir o contexto a cada '
      'iteração.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_txt::uuid;
END $$ LANGUAGE plpgsql STABLE;
--> statement-breakpoint

COMMENT ON FUNCTION app_clinica_id() IS
  'A clínica da transação corrente (app.clinica_id). Estoura se não houver contexto — '
  'devolver NULL faria a RLS filtrar tudo em silêncio.';
--> statement-breakpoint

-- ── 3. `clinica` deixa de ser singleton ─────────────────────────────────────
--
-- A PK vira uuid. Isto é barato AGORA e caro depois: hoje nenhuma tabela
-- referencia `clinica` (ela é configuração), então não há FK para reescrever.
--
-- Por que uuid e não `serial`: o id da clínica vai aparecer em prefixo de
-- armazenamento de anexo, em exportação LGPD e em URL de suporte. Id sequencial
-- entrega a contagem de clientes a qualquer pessoa que veja um, e torna
-- adivinhável o id do vizinho — o que só é inofensivo enquanto todo o resto
-- estiver certo.
ALTER TABLE clinica DROP CONSTRAINT IF EXISTS clinica_singleton;
--> statement-breakpoint

ALTER TABLE clinica ADD COLUMN id_uuid uuid NOT NULL DEFAULT gen_random_uuid();
--> statement-breakpoint

ALTER TABLE clinica DROP CONSTRAINT clinica_pkey;
--> statement-breakpoint

ALTER TABLE clinica DROP COLUMN id;
--> statement-breakpoint

ALTER TABLE clinica RENAME COLUMN id_uuid TO id;
--> statement-breakpoint

ALTER TABLE clinica ADD CONSTRAINT clinica_pkey PRIMARY KEY (id);
--> statement-breakpoint

-- Unicidade de CNPJ substitui o `CHECK clinica_singleton`: não impede a segunda
-- clínica (agora é o objetivo), impede o mesmo cliente entrar duas vezes por um
-- onboarding repetido. Parcial porque CNPJ é anulável — clínica de dentista
-- autônomo fatura no CPF.
CREATE UNIQUE INDEX IF NOT EXISTS clinica_cnpj_uk ON clinica (cnpj) WHERE cnpj IS NOT NULL;
--> statement-breakpoint

-- ── 4. `clinica_id` em toda tabela de dados ─────────────────────────────────
--
-- 39 tabelas. A lista é explícita — um laço sobre `information_schema` pegaria
-- tabela nova sem ninguém decidir que ela é de clínica, e `dente` (padrão FDI
-- internacional) tem de ficar fora. Quem entra nesta lista é decisão, não
-- varredura.
--
-- O passo 6 confere o contrário: nenhuma tabela ficou fora POR ESQUECIMENTO.
DO $$
DECLARE
  v_clinica uuid;
  v_tabela  text;
  v_tabelas text[] := ARRAY[
    -- acesso e auditoria
    'usuario', 'profissional', 'audit_log',
    -- agenda
    'cadeira', 'agendamento', 'bloqueio_agenda',
    -- pacientes e prontuário
    'paciente', 'paciente_conta', 'paciente_sessao', 'consentimento',
    'anamnese', 'alerta_clinico', 'dente_paciente', 'evolucao',
    -- catálogo e tratamento
    'procedimento', 'plano_tratamento', 'item_plano', 'execucao',
    -- orçamento e financeiro
    'orcamento', 'orcamento_item', 'cobranca', 'parcela', 'pagamento',
    -- convênio e TISS
    'convenio', 'preco_convenio', 'paciente_convenio',
    'guia_tiss', 'item_guia', 'glosa', 'recurso_glosa', 'repasse', 'repasse_item',
    -- documentos
    'documento',
    -- mensageria
    'mensagem_whatsapp', 'resposta_whatsapp',
    -- estoque
    'material', 'lote_material', 'movimento_estoque', 'insumo_procedimento'
  ];
BEGIN
  SELECT id INTO v_clinica FROM clinica LIMIT 1;

  FOREACH v_tabela IN ARRAY v_tabelas LOOP
    -- Falha alto se a tabela não existir. Um `IF EXISTS` complacente aqui daria
    -- uma migration verde que deixou tabela sem tenant — e é exatamente o erro
    -- que `db:verificar` já cometeu neste projeto (caso que "passa" porque a
    -- tabela não existe).
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_tabela AND relkind = 'r') THEN
      RAISE EXCEPTION 'Tabela % não existe — a lista da 0022 está errada.', v_tabela;
    END IF;

    EXECUTE format('ALTER TABLE %I ADD COLUMN clinica_id uuid', v_tabela);

    -- Backfill. Só faz sentido porque o passo 1 provou que há no máximo uma
    -- clínica. Num banco recém-criado (`v_clinica IS NULL`) não há linha para
    -- preencher, e o UPDATE não faz nada.
    --
    -- ── Por que os triggers são desligados aqui ─────────────────────────────
    -- A primeira versão desta migration morreu em `audit_log` com
    -- "audit_log e append-only: UPDATE nao e permitido" — o trigger fazendo
    -- exatamente o trabalho dele. `audit_log`, `evolucao` e `movimento_estoque`
    -- recusam UPDATE por decisão (CFO, guarda de 20 anos), e o backfill é um
    -- UPDATE.
    --
    -- O que justifica desligar: este UPDATE **não toca em conteúdo**. Ele preenche
    -- uma coluna que acabou de nascer, com o único valor possível, na única
    -- clínica que existe. Nenhuma evolução muda de texto, nenhum movimento muda de
    -- quantidade. É a diferença entre reescrever a história e dizer de quem ela é.
    --
    -- `DISABLE TRIGGER USER` (e não `session_replication_role = replica`, que seria
    -- o atalho) desliga só os triggers de aplicação DESTA tabela, e deixa em pé os
    -- triggers internos de FK — é o que `USER` significa. O alcance é uma tabela e
    -- duas instruções.
    --
    -- Se algo falhar entre o DISABLE e o ENABLE, a transação inteira volta atrás e
    -- os triggers voltam com ela: não existe estado intermediário publicado. E o
    -- passo 4b confere, depois do laço, que nenhum trigger ficou desligado — um
    -- ENABLE que não acontecesse deixaria o prontuário mutável para sempre, em
    -- silêncio, e é o pior resultado possível desta migration.
    IF v_clinica IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I DISABLE TRIGGER USER', v_tabela);
      EXECUTE format('UPDATE %I SET clinica_id = $1', v_tabela) USING v_clinica;
      EXECUTE format('ALTER TABLE %I ENABLE TRIGGER USER', v_tabela);
    END IF;

    EXECUTE format('ALTER TABLE %I ALTER COLUMN clinica_id SET NOT NULL', v_tabela);

    -- O DEFAULT é o que dispensou tocar em ~114 pontos de escrita do código.
    -- Sem ele, cada INSERT do sistema teria de passar a mencionar o tenant, e
    -- **o que fosse esquecido gravaria na clínica errada em silêncio**. Com o
    -- DEFAULT vindo do contexto, o esquecimento estoura (`app_clinica_id()`).
    EXECUTE format('ALTER TABLE %I ALTER COLUMN clinica_id SET DEFAULT app_clinica_id()', v_tabela);

    -- `restrict`: apagar clínica com dado dentro não é operação de sistema.
    -- Prontuário tem guarda de 20 anos (CFO). O que existe é encerrar contrato e
    -- exportar — um `cascade` aqui seria um DROP DATABASE disfarçado de UPDATE.
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (clinica_id) '
      'REFERENCES clinica(id) ON DELETE RESTRICT',
      v_tabela, v_tabela || '_clinica_fk');

    -- Índice em `clinica_id`. Toda consulta do sistema passa a filtrar por ele
    -- (via RLS, que o adiciona ao plano), então sem índice o Postgres varre a
    -- tabela inteira de TODAS as clínicas para devolver as de uma.
    EXECUTE format('CREATE INDEX %I ON %I (clinica_id)', v_tabela || '_clinica_idx', v_tabela);
  END LOOP;

  RAISE NOTICE 'clinica_id acrescentado em % tabelas (clínica existente: %)',
    array_length(v_tabelas, 1), coalesce(v_clinica::text, 'nenhuma — banco novo');
END $$;
--> statement-breakpoint

-- ── 4b. Nenhum trigger ficou desligado ─────────────────────────────────────
--
-- Contraprova do passo 4. O `ALTER TABLE … ENABLE TRIGGER USER` está dentro de um
-- laço, e laço com efeito colateral é onde mora o erro que ninguém vê: bastava um
-- `CONTINUE` no lugar errado para uma tabela ficar sem o append-only, para sempre,
-- sem nenhuma mensagem. A pergunta certa não é "eu religuei?", é "está religado?".
--
-- `tgenabled`: 'O' é o normal (origin), 'D' é desligado.
DO $$
DECLARE v_desligados text[];
BEGIN
  SELECT coalesce(array_agg(c.relname || '.' || t.tgname ORDER BY c.relname), ARRAY[]::text[])
    INTO v_desligados
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname = 'public' AND t.tgenabled = 'D';

  IF array_length(v_desligados, 1) > 0 THEN
    RAISE EXCEPTION
      'Triggers desligados ao fim do backfill: %. O append-only do prontuário '
      'depende deles — a migration não pode terminar assim.',
      array_to_string(v_desligados, ', ');
  END IF;
END $$;
--> statement-breakpoint

-- ── 5. Unicidade que era global e passa a ser por clínica ───────────────────
--
-- Cada índice abaixo, se ficasse global, seria a **segunda clínica não
-- conseguindo cadastrar o próprio dado** — e o erro apareceria para ela como
-- "código já existe" para um código que ela nunca usou. É o bug de multi-tenant
-- que mais confunde quem atende o suporte.
--
-- Quatro deles são CONSTRAINT `UNIQUE` (o `.unique()` do Drizzle), não índice
-- solto: `DROP INDEX` falharia com "cannot drop index … because constraint
-- requires it". Daí o `DROP CONSTRAINT`.
--
-- ── O que NÃO muda, e por quê ──────────────────────────────────────────────
--   • `usuario_email_uk` (staff) e `paciente_conta_email_uk` (portal) seguem
--     GLOBAIS: o login é e-mail + senha, e e-mail repetido entre clínicas
--     deixaria "quem está entrando?" sem resposta. Ver `lib/db/schema/acesso.ts`.
--   • `mensagem_whatsapp_chave_idempotencia_unique` segue GLOBAL. A chave é
--     `lembrete:<uuid do agendamento>:<início>` — já não colide entre clínicas, e
--     global é a versão MAIS forte: nenhuma duplicata escapa nem por engano de
--     contexto. Afrouxar para (clinica_id, chave) só criaria a possibilidade de
--     mandar o mesmo lembrete duas vezes, que é justamente o que ela existe para
--     impedir.
--   • `documento_storage_key_unique` segue global: a chave passa a levar prefixo
--     de clínica, então unicidade global é o que se quer.
--   • `paciente_sessao_token_hash_unique` segue global — token tem de ser único
--     no mundo, não na clínica.
--   • `dente`: padrão internacional, sem tenant.
ALTER TABLE cadeira DROP CONSTRAINT cadeira_nome_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX cadeira_nome_por_clinica_uk ON cadeira (clinica_id, nome);
--> statement-breakpoint

ALTER TABLE convenio DROP CONSTRAINT convenio_nome_unique;
--> statement-breakpoint
-- Duas clínicas atendem a MESMA operadora, cada uma com a sua tabela negociada.
CREATE UNIQUE INDEX convenio_nome_por_clinica_uk ON convenio (clinica_id, nome);
--> statement-breakpoint

ALTER TABLE material DROP CONSTRAINT material_codigo_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX material_codigo_por_clinica_uk ON material (clinica_id, codigo);
--> statement-breakpoint

-- O catálogo de procedimentos passa a ser DA CLÍNICA: valor particular,
-- `requer_dente` e ficha técnica são decisão de cada uma. O código interno
-- ('DENT-001') colide entre clínicas por construção — o catálogo semente é o
-- mesmo molde copiado em todo onboarding.
ALTER TABLE procedimento DROP CONSTRAINT procedimento_codigo_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX procedimento_codigo_por_clinica_uk ON procedimento (clinica_id, codigo);
--> statement-breakpoint

-- Mesmo motivo, e este é o mais fácil de esquecer: o TUSS único global deixaria a
-- segunda clínica SEM CATÁLOGO, porque o molde traz os mesmos 36 códigos oficiais.
DROP INDEX procedimento_tuss_uk;
--> statement-breakpoint
CREATE UNIQUE INDEX procedimento_tuss_uk
  ON procedimento (clinica_id, codigo_tuss) WHERE codigo_tuss IS NOT NULL;
--> statement-breakpoint

-- O MESMO CPF em duas clínicas é o caso NORMAL: paciente troca de dentista, ou
-- faz orto numa e clínico geral na outra. Parcial porque CPF é anulável (bebê não
-- tem, e o do responsável fica no cadastro dele).
DROP INDEX paciente_cpf_uk;
--> statement-breakpoint
CREATE UNIQUE INDEX paciente_cpf_uk ON paciente (clinica_id, cpf) WHERE cpf IS NOT NULL;
--> statement-breakpoint

DROP INDEX profissional_cro_uk;
--> statement-breakpoint
CREATE UNIQUE INDEX profissional_cro_uk ON profissional (clinica_id, cro, uf_cro);
--> statement-breakpoint

-- ── 5b. Numeração de documento: por clínica, e sem buraco ───────────────────
--
-- `orcamento.numero` e `guia_tiss.numero` vinham de sequences GLOBAIS
-- (`orcamento_numero_seq`, `guia_numero_seq`). Elas nunca repetiriam número — e
-- ainda assim estariam erradas: cada clínica veria os próprios orçamentos
-- numerados 1, 7, 12, 31, com os buracos sendo os documentos das outras. Para
-- quem recebe o orçamento 7 sem ter visto o 2 ao 6, a leitura é "perderam
-- documentos meus", e a explicação verdadeira é a pior possível.
--
-- A `drizzle/0014` rejeitou `max(numero) + 1` por concorrência, e estava certa:
-- dois faturamentos simultâneos leem o mesmo máximo. O mecanismo abaixo é outro —
-- `INSERT … ON CONFLICT DO UPDATE … RETURNING` sobre UMA linha. Não há janela
-- entre ler e gravar porque é a mesma instrução, e o lock é da linha daquela
-- clínica: clínicas diferentes não se esperam.
--
-- E ele é melhor que a sequence num ponto que a 0014 documentava como perda
-- aceitável: transação abortada **devolve** o número em vez de queimá-lo. A
-- numeração fica contígua de verdade.
CREATE TABLE contador (
  clinica_id uuid NOT NULL DEFAULT app_clinica_id() REFERENCES clinica(id) ON DELETE RESTRICT,
  escopo     text   NOT NULL,
  proximo    bigint NOT NULL DEFAULT 1,
  CONSTRAINT contador_clinica_id_escopo_pk PRIMARY KEY (clinica_id, escopo)
);
--> statement-breakpoint

CREATE INDEX contador_clinica_idx ON contador (clinica_id);
--> statement-breakpoint

-- VOLATILE (o padrão) e não STABLE: ela ESCREVE. Marcá-la STABLE por descuido
-- autorizaria o planejador a chamá-la uma vez e reusar o valor — dois orçamentos
-- com o mesmo número no mesmo INSERT múltiplo.
CREATE OR REPLACE FUNCTION proximo_numero(p_escopo text) RETURNS bigint AS $$
DECLARE v_numero bigint;
BEGIN
  INSERT INTO contador (clinica_id, escopo, proximo)
       VALUES (app_clinica_id(), p_escopo, 2)
  ON CONFLICT (clinica_id, escopo)
    DO UPDATE SET proximo = contador.proximo + 1
    RETURNING proximo - 1 INTO v_numero;
  RETURN v_numero;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Semeia o contador de cada clínica existente a partir do máximo já emitido —
-- senão o próximo orçamento da clínica nasceria com número 1, colidindo com o
-- orçamento 1 que ela já mandou para um paciente.
INSERT INTO contador (clinica_id, escopo, proximo)
SELECT c.id, 'orcamento', coalesce(max(o.numero), 0) + 1
  FROM clinica c LEFT JOIN orcamento o ON o.clinica_id = c.id
 GROUP BY c.id
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO contador (clinica_id, escopo, proximo)
SELECT c.id, 'guia_tiss', coalesce(max(g.numero::bigint), 0) + 1
  FROM clinica c LEFT JOIN guia_tiss g ON g.clinica_id = c.id
 GROUP BY c.id
ON CONFLICT DO NOTHING;
--> statement-breakpoint

ALTER TABLE orcamento ALTER COLUMN numero SET DEFAULT proximo_numero('orcamento');
--> statement-breakpoint
ALTER TABLE orcamento DROP CONSTRAINT orcamento_numero_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX orcamento_numero_por_clinica_uk ON orcamento (clinica_id, numero);
--> statement-breakpoint

ALTER TABLE guia_tiss ALTER COLUMN numero SET DEFAULT proximo_numero('guia_tiss');
--> statement-breakpoint
ALTER TABLE guia_tiss DROP CONSTRAINT guia_tiss_numero_unique;
--> statement-breakpoint
-- A operadora exige número único por PRESTADOR, e o prestador é a clínica.
CREATE UNIQUE INDEX guia_numero_por_clinica_uk ON guia_tiss (clinica_id, numero);
--> statement-breakpoint

-- As sequences saem de cena. `DROP` e não `IF EXISTS`: se elas não estiverem
-- aqui, este banco não é o que a migration pensa que é.
DROP SEQUENCE orcamento_numero_seq;
--> statement-breakpoint
DROP SEQUENCE guia_numero_seq;
--> statement-breakpoint

-- ── 6. A trava estrutural: nenhuma tabela de dados sem tenant ──────────────
--
-- Isto substitui o `CHECK clinica_singleton` como invariante de arquitetura.
-- Antes, a decisão "uma clínica só" morava numa constraint. Agora a decisão é
-- "toda tabela de dados tem tenant", e ela mora aqui: a asserção varre o
-- catálogo do Postgres e **derruba o deploy** se aparecer tabela nova sem
-- `clinica_id`.
--
-- É o mesmo espírito da `drizzle/0013`, que falha o deploy se alguém criar FK
-- entre os dois realms de autenticação. Tabela nova sem tenant não é bug de
-- funcionalidade — é vazamento entre clientes esperando a hora, e a hora é o dia
-- em que a tela nova entra no ar.
DO $$
DECLARE
  v_faltando text[];
  -- A lista de isentas é curta e cada linha precisa de justificativa.
  v_isentas text[] := ARRAY[
    'clinica',                -- é o tenant
    'dente',                  -- 52 dentes FDI: padrão internacional, imutável
    '__drizzle_migrations'     -- controle do migrador
  ];
BEGIN
  SELECT coalesce(array_agg(c.relname ORDER BY c.relname), ARRAY[]::text[])
    INTO v_faltando
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'r'
     AND n.nspname = 'public'
     AND NOT (c.relname = ANY (v_isentas))
     AND NOT EXISTS (
       SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'clinica_id' AND NOT a.attisdropped
     );

  IF array_length(v_faltando, 1) > 0 THEN
    RAISE EXCEPTION
      'Tabelas de dados sem clinica_id: %. Toda tabela nova precisa da coluna '
      '(use clinicaId() de lib/db/schema/tenant.ts). Se ela for referência global '
      'de verdade, acrescente à lista de isentas AQUI, com a justificativa.',
      array_to_string(v_faltando, ', ');
  END IF;
END $$;
--> statement-breakpoint

-- ── 7. `hoje_na_clinica()` deixa de decidir pela clínica nº 1 ───────────────
--
-- A versão da 0019 era `SELECT fuso_horario FROM clinica WHERE id = 1`. Com
-- várias clínicas isso é um bug com consequência física: a trigger que recusa
-- consumir lote vencido chama esta função, então **o fuso da clínica nº 1
-- decidiria o vencimento de material de todas**. Lote que vence 31/07 serve até
-- o fim do dia 31/07 no fuso DA clínica — e a clínica nº 1 pode estar em outro.
--
-- Passa a haver duas formas:
--   • `hoje_na_clinica(uuid)` — explícita, usada pelas triggers, que têm a linha
--     na mão (`NEW.clinica_id`) e não dependem do contexto de sessão;
--   • `hoje_na_clinica()` — pelo contexto, para consulta comum. Sem contexto,
--     estoura via `app_clinica_id()`.
CREATE OR REPLACE FUNCTION hoje_na_clinica(p_clinica uuid) RETURNS date AS $$
  SELECT (now() AT TIME ZONE coalesce(
    (SELECT fuso_horario FROM clinica WHERE id = p_clinica),
    'America/Sao_Paulo'
  ))::date;
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION hoje_na_clinica() RETURNS date AS $$
  SELECT hoje_na_clinica(app_clinica_id());
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- A trigger de estoque passa a usar a forma explícita. `v_lote` já está
-- carregado no corpo da função, e `NEW.clinica_id` vem da linha sendo inserida —
-- nada depende de a transação ter contexto, o que mantém a trava válida também
-- para manutenção feita por psql.
CREATE OR REPLACE FUNCTION estoque_aplicar_movimento() RETURNS trigger AS $$
DECLARE
  v_lote     lote_material;
  v_material material;
  v_novo     numeric(12,3);
BEGIN
  -- FOR UPDATE serializa duas baixas simultâneas do mesmo lote. Sem o lock, duas
  -- transações leem saldo 1, ambas passam na verificação e o saldo vai a -1 —
  -- e aí só o CHECK salva, com mensagem que ninguém entende.
  SELECT * INTO v_lote FROM lote_material WHERE id = NEW.lote_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lote % não existe.', NEW.lote_id;
  END IF;

  SELECT * INTO v_material FROM material WHERE id = v_lote.material_id;

  -- Lote vencido: descarte sim, consumo não. Devolução ao fornecedor também é
  -- legítima (é justamente o que se faz com lote vencido que ele aceita trocar).
  IF NEW.tipo = 'consumo' AND v_lote.validade IS NOT NULL
     AND v_lote.validade < hoje_na_clinica(NEW.clinica_id) THEN
    RAISE EXCEPTION
      'Lote % (%) venceu em % e não pode ser consumido em paciente — registre descarte.',
      v_lote.id, coalesce(v_lote.codigo_fabricante, 'sem código'), v_lote.validade;
  END IF;

  -- Portaria 344/98: saída de controlado sem responsável e sem motivo é
  -- exatamente o que a fiscalização cobra. Entrada não precisa (a nota é a prova).
  IF v_material.controlado AND NEW.quantidade < 0 THEN
    IF NEW.profissional_id IS NULL THEN
      RAISE EXCEPTION
        'Material controlado (%): saída exige o profissional responsável.', v_material.codigo;
    END IF;
    IF NEW.motivo IS NULL OR btrim(NEW.motivo) = '' THEN
      RAISE EXCEPTION
        'Material controlado (%): saída exige motivo registrado.', v_material.codigo;
    END IF;
  END IF;

  v_novo := v_lote.saldo + NEW.quantidade;

  IF v_novo < 0 THEN
    RAISE EXCEPTION
      'Saldo insuficiente no lote %: há % e a baixa pede %.',
      v_lote.id, v_lote.saldo, abs(NEW.quantidade);
  END IF;

  UPDATE lote_material
     SET saldo = v_novo, atualizado_em = now()
   WHERE id = NEW.lote_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
