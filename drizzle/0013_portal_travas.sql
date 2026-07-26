-- ════════════════════════════════════════════════════════════════════════════
-- Fase 12 — travas do portal do paciente.
--
-- Este é o realm exposto: o paciente entra pela internet, sem MFA, de um celular
-- que a clínica não controla. As regras que seguram isso não podem depender de o
-- código lembrar:
--
--   1. Convite de primeiro acesso é de USO ÚNICO.
--   2. Sessão não ressuscita: revogada é revogada.
--   3. Sessão não estica o próprio prazo.
--   4. `paciente_sessao` nunca aponta para `usuario` — os realms não se cruzam.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1. O convite morre ao ser usado.
--
--    O caso que isto impede: o token de primeiro acesso circula por WhatsApp e
--    fica no histórico da conversa. Se ele continuasse valendo depois de a senha
--    ser definida, qualquer pessoa com acesso àquele celular — ou ao print —
--    poderia redefinir a senha do paciente e ler o prontuário.
--
--    Definir senha OBRIGA a limpar o convite. Não é convenção: é trigger.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "paciente_conta_convite_uso_unico"() RETURNS trigger AS $$
BEGIN
  -- Senha passou de nula para preenchida: é o primeiro acesso se completando.
  IF OLD."senha_hash" IS NULL AND NEW."senha_hash" IS NOT NULL THEN
    IF NEW."token_convite_hash" IS NOT NULL THEN
      RAISE EXCEPTION
        'convite de primeiro acesso tem de ser consumido junto com a definicao da senha (conta %). Limpe token_convite_hash na mesma instrucao.',
        OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Trocar a senha também invalida convite pendente: se havia um convite aberto
  -- e a senha mudou por outro caminho, o convite não pode sobreviver.
  IF OLD."senha_hash" IS NOT NULL
     AND NEW."senha_hash" IS DISTINCT FROM OLD."senha_hash"
     AND NEW."token_convite_hash" IS NOT NULL
     AND NEW."token_convite_hash" IS NOT DISTINCT FROM OLD."token_convite_hash" THEN
    RAISE EXCEPTION
      'troca de senha nao pode conviver com convite pendente (conta %).', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "paciente_conta_valida_convite"
  BEFORE UPDATE ON "paciente_conta"
  FOR EACH ROW EXECUTE FUNCTION "paciente_conta_convite_uso_unico"();
--> statement-breakpoint

CREATE TRIGGER "paciente_conta_toca_atualizado_em"
  BEFORE UPDATE ON "paciente_conta"
  FOR EACH ROW EXECUTE FUNCTION "toca_atualizado_em"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 2, 3 e 4. Sessão: não ressuscita, não estica, não muda de dono.
--
--    O que o código PODE atualizar numa sessão é `ultimo_uso_em` e a revogação.
--    Tudo o mais é imutável — inclusive `expira_em`, porque sessão que renova o
--    próprio prazo é sessão eterna, e o prazo curto é metade da proteção de um
--    portal sem segundo fator.
--
--    "Renovar sessão" se faz criando outra linha e revogando a atual. Fica no
--    histórico, e o histórico é o que responde "de onde essa conta foi acessada".
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "paciente_sessao_campos_congelados"() RETURNS trigger AS $$
BEGIN
  IF NEW."token_hash" IS DISTINCT FROM OLD."token_hash" THEN
    RAISE EXCEPTION 'token da sessao e imutavel (sessao %).', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."conta_id" IS DISTINCT FROM OLD."conta_id" THEN
    RAISE EXCEPTION
      'sessao nao troca de conta (sessao %) — seria entregar a sessao de um paciente a outro.',
      OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."expira_em" IS DISTINCT FROM OLD."expira_em" THEN
    RAISE EXCEPTION
      'expira_em e imutavel (sessao %). Para renovar, crie outra sessao e revogue esta.',
      OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."criado_em" IS DISTINCT FROM OLD."criado_em" THEN
    RAISE EXCEPTION 'criado_em da sessao e imutavel (sessao %).', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."revogada_em" IS NOT NULL AND NEW."revogada_em" IS NULL THEN
    RAISE EXCEPTION
      'sessao revogada nao volta (sessao %).', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "paciente_sessao_congela_campos"
  BEFORE UPDATE ON "paciente_sessao"
  FOR EACH ROW EXECUTE FUNCTION "paciente_sessao_campos_congelados"();
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Os dois realms não se cruzam — provado por consulta ao catálogo.
--
--    Não é um trigger: é uma verificação de ESTRUTURA que roda na migration e
--    falha o deploy se alguém acrescentar uma FK entre as tabelas de sessão do
--    paciente e a tabela de usuários da clínica. É a decisão 2 do CLAUDE.md
--    virando obstáculo real em vez de recomendação.
--
--    `revogada_por_usuario_id` existe e é PROPOSITALMENTE sem FK: registra quem
--    da clínica cortou o acesso, sem criar caminho de join que permita uma
--    consulta do portal alcançar `usuario`.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
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
    RAISE EXCEPTION
      'existe FK entre o realm do paciente e "usuario" (% encontrada(s)). Ver CLAUDE.md, decisao 2: os realms nao se cruzam.', n;
  END IF;
END $$;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Índice para a limpeza de sessões vencidas.
--
--    Sessão vencida pode ser apagada de verdade: não é prontuário, é credencial.
--    O que fica é o `audit_log` do acesso, que é o registro que interessa.
-- ────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "paciente_sessao_expira_idx"
  ON "paciente_sessao" ("expira_em")
  WHERE "revogada_em" IS NULL;
