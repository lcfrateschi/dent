-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  Bloco 1 — cadastros administrativos: as travas                          ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- Agora que existe tela para cadastrar usuário, convênio, cadeira e tabela
-- negociada, existe também a chance de alguém se trancar fora do sistema ou
-- reescrever um preço já faturado. Seis garantias, todas no banco:
--
--   1. nunca zero administradores ativos
--   2. usuário de perfil `dentista` ativo tem cadastro de profissional
--   3. dois preços NUNCA valem no mesmo dia para o mesmo par convênio+procedimento
--   4. preço de convênio não se corrige por cima: só a data de fim muda
--   5. cadeira com agendamento futuro não é desativada

-- A coluna `usuario.senha_temporaria` e o índice de carteirinha única vêm da
-- migration gerada 0020; aqui ficam as travas que o ORM não expressa.
-- ── 1. Nunca zero administradores ativos ────────────────────────────────────
-- Trancar a clínica fora do próprio sistema tem uma saída só: `UPDATE` no banco
-- por quem tem acesso ao servidor. É o mesmo raciocínio do bloqueio de login do
-- paciente nunca ser permanente — trava sem porta da frente vira negação de
-- serviço.
CREATE OR REPLACE FUNCTION usuario_exige_admin_ativo() RETURNS trigger AS $$
DECLARE
  v_restantes int;
BEGIN
  -- Só interessa quando um admin ativo deixa de ser admin ativo.
  IF TG_OP = 'UPDATE'
     AND NOT (OLD.perfil = 'admin' AND OLD.ativo
              AND (NEW.ativo IS DISTINCT FROM true OR NEW.perfil IS DISTINCT FROM 'admin')) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' AND NOT (OLD.perfil = 'admin' AND OLD.ativo) THEN
    RETURN OLD;
  END IF;

  SELECT count(*) INTO v_restantes
    FROM usuario
   WHERE perfil = 'admin' AND ativo AND id <> OLD.id;

  IF v_restantes = 0 THEN
    RAISE EXCEPTION
      'Não é possível deixar a clínica sem nenhum administrador ativo. Crie ou reative outro administrador antes.';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER usuario_admin_sempre_existe
  BEFORE UPDATE OR DELETE ON usuario
  FOR EACH ROW EXECUTE FUNCTION usuario_exige_admin_ativo();
--> statement-breakpoint

-- ── 2. Dentista ativo tem cadastro de profissional ──────────────────────────
-- Evolução, execução e comissão exigem `profissional_id`. Um usuário de perfil
-- `dentista` sem a linha de profissional entra no sistema, abre o prontuário e
-- **não consegue assinar nada** — falha que aparece na frente do paciente.
--
-- DEFERRABLE porque o cadastro cria as duas linhas na mesma transação, nesta
-- ordem: usuário primeiro (o profissional referencia o id dele).
CREATE OR REPLACE FUNCTION dentista_exige_profissional() RETURNS trigger AS $$
DECLARE
  v_id      uuid;
  v_usuario usuario;
BEGIN
  -- Um `CASE` com `NEW.usuario_id` aqui NÃO funciona: a expressão SQL tem os
  -- campos resolvidos de uma vez, e o gatilho sobre `usuario` estoura com
  -- "record new has no field usuario_id" mesmo no ramo que não seria tomado.
  -- Em ramos separados, o PL/pgSQL só planeja o comando que executa.
  IF TG_TABLE_NAME = 'usuario' THEN
    v_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_id := OLD.usuario_id;
  ELSE
    v_id := NEW.usuario_id;
  END IF;

  SELECT * INTO v_usuario FROM usuario WHERE id = v_id;

  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_usuario.perfil <> 'dentista' OR NOT v_usuario.ativo THEN RETURN NULL; END IF;

  IF NOT EXISTS (SELECT 1 FROM profissional WHERE usuario_id = v_usuario.id) THEN
    RAISE EXCEPTION
      'Usuário % tem perfil dentista e nenhum cadastro de profissional: sem CRO não assina evolução nem apura comissão.',
      v_usuario.email;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER usuario_dentista_com_profissional
  AFTER INSERT OR UPDATE OF perfil, ativo ON usuario
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION dentista_exige_profissional();
--> statement-breakpoint

-- A outra ponta: apagar a linha de profissional de um dentista ativo deixaria o
-- mesmo estado impossível, por outro caminho.
CREATE CONSTRAINT TRIGGER profissional_do_dentista_permanece
  AFTER DELETE ON profissional
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION dentista_exige_profissional();
--> statement-breakpoint

-- ── 3. Um preço por dia, por par convênio+procedimento ──────────────────────
-- `precoVigenteEm` procura a vigência que contém a data da execução. Com duas
-- linhas válidas no mesmo dia, o valor faturado passa a depender da ordem da
-- consulta — glosa por divergência de valor, achada semanas depois.
--
-- `[inicio, fim+1)` porque a vigência inclui o dia do fim; fim nulo é aberta.
ALTER TABLE "preco_convenio"
  ADD CONSTRAINT "preco_convenio_sem_sobreposicao"
  EXCLUDE USING gist (
    "convenio_id" WITH =,
    "procedimento_id" WITH =,
    daterange(
      "vigencia_inicio",
      CASE WHEN "vigencia_fim" IS NULL THEN NULL ELSE "vigencia_fim" + 1 END,
      '[)'
    ) WITH &&
  );
--> statement-breakpoint

-- ── 4. Preço não se corrige por cima ────────────────────────────────────────
-- O valor faturado é o da DATA DA EXECUÇÃO (decisão fechada). Editar uma
-- vigência passada reescreve o que já foi apresentado à operadora, e a
-- conciliação do repasse deixa de fechar sem que nada indique por quê.
-- Reajuste é linha nova; a única edição permitida é FECHAR a vigência.
CREATE OR REPLACE FUNCTION preco_convenio_so_fecha() RETURNS trigger AS $$
BEGIN
  IF NEW.convenio_id     IS DISTINCT FROM OLD.convenio_id
     OR NEW.procedimento_id IS DISTINCT FROM OLD.procedimento_id
     OR NEW.valor           IS DISTINCT FROM OLD.valor
     OR NEW.cobertura_pct   IS DISTINCT FROM OLD.cobertura_pct
     OR NEW.carencia_dias   IS DISTINCT FROM OLD.carencia_dias
     OR NEW.vigencia_inicio IS DISTINCT FROM OLD.vigencia_inicio THEN
    RAISE EXCEPTION
      'Preço de convênio não se altera: o valor faturado é o da data da execução. Cadastre uma nova vigência — a atual é fechada automaticamente no dia anterior.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER preco_convenio_imutavel
  BEFORE UPDATE ON preco_convenio
  FOR EACH ROW EXECUTE FUNCTION preco_convenio_so_fecha();
--> statement-breakpoint

-- Apagar é permitido só enquanto nada foi faturado sob aquele preço — o caso do
-- erro de digitação percebido no mesmo dia. Depois de existir item de guia no
-- período, a linha é histórico do que foi apresentado.
CREATE OR REPLACE FUNCTION preco_convenio_sem_faturamento() RETURNS trigger AS $$
DECLARE
  v_usos int;
BEGIN
  SELECT count(*) INTO v_usos
    FROM item_guia ig
    JOIN guia_tiss g ON g.id = ig.guia_id
    JOIN item_plano ip ON ip.id = ig.item_plano_id
   WHERE g.convenio_id = OLD.convenio_id
     AND ip.procedimento_id = OLD.procedimento_id
     AND ig.data_execucao >= OLD.vigencia_inicio
     AND (OLD.vigencia_fim IS NULL OR ig.data_execucao <= OLD.vigencia_fim);

  IF v_usos > 0 THEN
    RAISE EXCEPTION
      'Este preço já foi usado em % item(ns) de guia. Ele é o histórico do que foi apresentado à operadora — feche a vigência em vez de apagar.',
      v_usos;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER preco_convenio_nao_apaga_faturado
  BEFORE DELETE ON preco_convenio
  FOR EACH ROW EXECUTE FUNCTION preco_convenio_sem_faturamento();
--> statement-breakpoint

-- ── 5. Cadeira com agendamento futuro não desativa ──────────────────────────
-- O horário existe, o paciente foi avisado, e a cadeira sair da grade deixaria o
-- atendimento órfão sem que ninguém veja. Remarcar primeiro é decisão da
-- recepção, não do sistema.
CREATE OR REPLACE FUNCTION cadeira_sem_agendamento_futuro() RETURNS trigger AS $$
DECLARE
  v_futuros int;
BEGIN
  IF OLD.ativo AND NOT NEW.ativo THEN
    SELECT count(*) INTO v_futuros
      FROM agendamento
     WHERE cadeira_id = OLD.id
       AND inicio >= now()
       AND status NOT IN ('cancelado', 'faltou');

    IF v_futuros > 0 THEN
      RAISE EXCEPTION
        'A cadeira "%" tem % agendamento(s) futuro(s). Remarque-os antes de desativá-la.',
        OLD.nome, v_futuros;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER cadeira_desativa_so_livre
  BEFORE UPDATE OF ativo ON cadeira
  FOR EACH ROW EXECUTE FUNCTION cadeira_sem_agendamento_futuro();
