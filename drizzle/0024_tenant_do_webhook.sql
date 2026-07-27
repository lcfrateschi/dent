-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Fase 17 — os dois caminhos que a RLS deixou sem tenant                   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- A `0023` resolveu o ovo e a galinha da autenticação com duas funções
-- `SECURITY DEFINER`: staff pelo e-mail, portal pelo hash do token. Sobraram dois
-- caminhos que também rodam sem sessão e que a role de aplicação não consegue
-- atender:
--
--   1. **o webhook do WhatsApp**, que chega da Meta sem cookie nenhum;
--   2. **o despachante**, que roda em laço e precisa saber quais clínicas existem.
--
-- Sem estes dois, apontar o app para `facilident_app` deixaria o webhook mudo
-- (mensagem de paciente entrando e não sendo registrada) e o despachante sem
-- clínica para percorrer — os dois **em silêncio**, porque nenhum deles tem
-- alguém olhando a tela quando roda.

-- ── 1. De quem é este número de WhatsApp? ───────────────────────────────────
--
-- O webhook não tem sessão, mas tem uma pista: `phone_number_id`, o
-- identificador do número que RECEBEU a mensagem, que a Meta manda em
-- `entry[].changes[].value.metadata` de todo evento — tanto mensagem recebida
-- quanto atualização de status. É o tenant que o payload já carrega.
--
-- Antes disso o app resolvia o tenant pelo `id_externo` da mensagem enviada (a
-- linha de `mensagem_whatsapp` sabe de quem é). Funciona para status de mensagem
-- que a clínica mandou, e **não funciona para o paciente iniciando conversa** —
-- que é o caso em que a clínica mais precisa saber, porque é alguém pedindo
-- alguma coisa.
ALTER TABLE clinica ADD COLUMN whatsapp_phone_number_id text;
--> statement-breakpoint

COMMENT ON COLUMN clinica.whatsapp_phone_number_id IS
  'phone_number_id da Meta. É a única pista de tenant que o webhook tem.';
--> statement-breakpoint

-- Único GLOBAL, e parcial porque a maioria das clínicas não tem WhatsApp ligado.
--
-- Global e não por clínica: um número da Meta pertence a **uma** conta. Duas
-- clínicas declarando o mesmo `phone_number_id` tornaria indefinido de quem é a
-- mensagem que chega — e "indefinido" aqui significa mensagem de paciente
-- aparecendo na tela da clínica errada, com o nome e o telefone dele.
CREATE UNIQUE INDEX clinica_whatsapp_numero_uk
  ON clinica (whatsapp_phone_number_id) WHERE whatsapp_phone_number_id IS NOT NULL;
--> statement-breakpoint

-- `SECURITY DEFINER` pelo mesmo motivo das duas funções da 0023: a role de
-- aplicação só vê a PRÓPRIA clínica (é o que se quer), e aqui a pergunta é
-- justamente "qual é a minha?".
--
-- Devolve **um uuid e nada mais** — não o token da Meta, não o nome da clínica.
-- `search_path` fixo porque função `SECURITY DEFINER` sem ele é sequestrável por
-- quem consiga criar schema.
CREATE OR REPLACE FUNCTION clinica_do_numero_de_whatsapp(p_phone_number_id text)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM clinica
   WHERE whatsapp_phone_number_id = btrim(p_phone_number_id)
     AND btrim(p_phone_number_id) <> '';
$$;
--> statement-breakpoint

COMMENT ON FUNCTION clinica_do_numero_de_whatsapp(text) IS
  'Resolve o tenant a partir do phone_number_id do webhook, ANTES de haver contexto. '
  'Não autoriza nada — quem valida a assinatura HMAC é a aplicação.';
--> statement-breakpoint

REVOKE ALL ON FUNCTION clinica_do_numero_de_whatsapp(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION clinica_do_numero_de_whatsapp(text) TO facilident_app;
--> statement-breakpoint

-- ── 2. Quais clínicas existem? ──────────────────────────────────────────────
--
-- O despachante de WhatsApp percorre todas as clínicas e troca de contexto **a
-- cada iteração** (`lib/mensageria/executar-despacho.ts`). A pergunta "quais
-- existem?" é, por definição, a única que não pode ter contexto de clínica.
--
-- Enquanto o app conectava como dono, `select id from clinica` funcionava porque
-- superusuário ignora RLS. Como `facilident_app` isso passa a devolver no máximo
-- a própria — e o despachante processaria uma clínica só, sem erro e sem log. As
-- outras simplesmente não receberiam lembrete, e ninguém saberia até um paciente
-- reclamar de falta que ninguém confirmou.
--
-- ── Por que função e não uma role `facilident_ops` ─────────────────────────
-- Uma role de operação seria mais bonita no diagrama e pior na prática: o
-- despachante roda no mesmo container do app, com a mesma `DATABASE_URL`. Ter
-- duas credenciais no mesmo processo é ter a mais privilegiada disponível para
-- todo o resto do processo — inclusive para o código que atende requisição. A
-- função é a superfície mínima: devolve uma coluna de uuids e não dá acesso a
-- linha nenhuma.
CREATE OR REPLACE FUNCTION clinicas_para_processamento()
  RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  -- `ORDER BY id`: laço com ordem estável é laço cujo log se compara entre
  -- execuções. Sem ordenação o Postgres devolve o que for mais barato, e a ordem
  -- muda sozinha entre duas rodadas iguais.
  SELECT id FROM clinica ORDER BY id;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION clinicas_para_processamento() IS
  'Enumera as clínicas para o despachante. Devolve só uuid — não é um "db sem RLS".';
--> statement-breakpoint

REVOKE ALL ON FUNCTION clinicas_para_processamento() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION clinicas_para_processamento() TO facilident_app;
--> statement-breakpoint

-- ── 3. A asserção da 0023 vale para esta migration também ───────────────────
--
-- `exigir_isolamento_estrutural()` confere que nenhuma tabela de dados ficou sem
-- `clinica_id`, sem política, sem `FORCE`, e que nenhum FK entre tabelas de tenant
-- ficou sem `clinica_id` nas duas pontas.
--
-- Chamá-la aqui não é zelo: esta migration mexeu em `clinica`, e a próxima pode
-- criar tabela. `ALTER DEFAULT PRIVILEGES` dá **grant** automático a tabela nova e
-- não dá **política** — então uma tabela criada sem política ficaria legível para
-- toda clínica, com privilégio concedido automaticamente e nenhum aviso. Toda
-- migration daqui para frente termina com esta linha.
SELECT exigir_isolamento_estrutural();
