#!/usr/bin/env bash
#
# Dá LOGIN e senha à role de aplicação `facilident_app`.
#
#   ./docker/credencial-app.sh
#
# ── Por que isto não está dentro da migration ────────────────────────────────
# `drizzle/0023_rls.sql` cria a role sem `LOGIN` e sem senha, de propósito. Senha
# escrita num arquivo SQL versionado é senha pública: ela vai para o Git, para
# todo clone, para todo backup do Git e para o histórico — onde continua depois de
# "removida", porque o commit anterior segue lá.
#
# ── A trava ─────────────────────────────────────────────────────────────────
# Em produção o script se RECUSA a usar a senha de desenvolvimento. Mesmo espírito
# de `exigirSegredoDeProducao()` (`lib/auth/segredo.ts`): falhar alto na hora do
# deploy é melhor que subir com credencial pública e ninguém perceber. A diferença
# entre as duas situações é que a segunda só aparece quando alguém de fora
# descobre.
set -euo pipefail

SENHA_DEV='facilident_app_dev'

APP_DB_PASSWORD="${APP_DB_PASSWORD:-}"
NODE_ENV="${NODE_ENV:-development}"
POSTGRES_USER="${POSTGRES_USER:-facilident}"
POSTGRES_DB="${POSTGRES_DB:-facilident}"

if [[ "$NODE_ENV" == "production" ]]; then
  if [[ -z "$APP_DB_PASSWORD" ]]; then
    echo "ERRO: APP_DB_PASSWORD não definida, e em produção não existe padrão." >&2
    echo "      Gere uma: openssl rand -base64 36" >&2
    exit 1
  fi
  if [[ "$APP_DB_PASSWORD" == "$SENHA_DEV" ]]; then
    echo "ERRO: APP_DB_PASSWORD está com a senha de DESENVOLVIMENTO." >&2
    echo "      Um .env copiado do desenvolvimento para o servidor é a forma mais" >&2
    echo "      comum de isso acontecer. Gere uma própria: openssl rand -base64 36" >&2
    exit 1
  fi
  # 36 bytes em base64 dão 48 caracteres. O piso é baixo de propósito — a trava que
  # importa é a de cima; esta só pega senha digitada à mão com pressa.
  if (( ${#APP_DB_PASSWORD} < 24 )); then
    echo "ERRO: APP_DB_PASSWORD curta demais (${#APP_DB_PASSWORD} caracteres, mínimo 24)." >&2
    exit 1
  fi
else
  APP_DB_PASSWORD="${APP_DB_PASSWORD:-$SENHA_DEV}"
fi

# A senha vai por variável de ambiente do psql (`:'senha'` com quoting do próprio
# psql), não interpolada na linha de comando: argumento de processo é visível em
# `ps` para qualquer usuário da máquina.
docker compose exec -T \
  -e SENHA_APP="$APP_DB_PASSWORD" \
  db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q <<'SQL'
\set senha `echo "$SENHA_APP"`
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'facilident_app') THEN
    RAISE EXCEPTION
      'A role facilident_app não existe. Rode as migrations primeiro (drizzle/0023).';
  END IF;
END $$;
ALTER ROLE facilident_app LOGIN PASSWORD :'senha';
SQL

echo "facilident_app: LOGIN habilitado."
if [[ "$NODE_ENV" != "production" ]]; then
  echo
  echo "  DATABASE_URL da aplicação (já é o padrão de app/app-prod/despachante):"
  echo "    postgres://facilident_app:${APP_DB_PASSWORD}@db:5432/${POSTGRES_DB}"
  echo
  echo "  Migration, seed, db:verificar e backup continuam no DONO — são operação,"
  echo "  não aplicação."
fi
