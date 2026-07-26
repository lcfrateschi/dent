#!/bin/sh
# Aplica migrations e popula dados de referência. Idempotente: pode rodar em todo `up`.
set -eu

echo "→ aplicando migrations"
npx drizzle-kit migrate

echo "→ populando dados de referência"
npm run db:seed

echo "✓ banco pronto"
