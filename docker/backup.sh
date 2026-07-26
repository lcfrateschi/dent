#!/usr/bin/env bash
# ============================================================================
# Backup do Facilident: banco + anexos, num único arquivo datado.
#
#   ./docker/backup.sh [destino]        # padrão: ./backups
#
# ── Por que os dois juntos, sempre ─────────────────────────────────────────
# O banco guarda o CAMINHO da radiografia, não a imagem. Um dump sem o volume
# `anexos` restaura um prontuário que aponta para arquivos que não existem — e
# isso só aparece quando alguém tenta abrir a radiografia, meses depois. Fazer
# os dois no mesmo arquivo torna impossível levar só metade.
#
# ── Formato ────────────────────────────────────────────────────────────────
# `pg_dump -Fc` (custom): comprimido, restaurável em paralelo e seletivo por
# tabela. `-Fp` (SQL puro) seria legível, mas 20 anos de prontuário em texto é
# um arquivo que ninguém abre e que ocupa várias vezes mais.
#
# ── O que este script NÃO faz ──────────────────────────────────────────────
# Não cifra e não envia para fora da máquina. Backup de prontuário é dado de
# saúde: em produção, o arquivo tem de sair do servidor **cifrado** (age, gpg
# ou a cifra do próprio destino) e ir para outro lugar físico. Um backup que
# mora no mesmo disco do banco protege contra `DROP TABLE`, não contra o disco
# morrer nem contra ransomware.
# ============================================================================
set -euo pipefail

DESTINO="${1:-./backups}"
SERVICO_DB="${SERVICO_DB:-db}"
USUARIO="${POSTGRES_USER:-facilident}"
BANCO="${POSTGRES_DB:-facilident}"
RETENCAO_DIAS="${RETENCAO_DIAS:-30}"

carimbo="$(date +%Y%m%d-%H%M%S)"
trabalho="$(mktemp -d)"
trap 'rm -rf "$trabalho"' EXIT

mkdir -p "$DESTINO"

echo "── Backup do Facilident ──────────────────────────────────────────"
echo "  banco:   $BANCO"
echo "  destino: $DESTINO"
echo

# ── 1. Banco ────────────────────────────────────────────────────────────────
echo "1/4  dump do banco…"
docker compose exec -T "$SERVICO_DB" \
  pg_dump -U "$USUARIO" -d "$BANCO" -Fc --no-owner --no-privileges \
  > "$trabalho/banco.dump"

tamanho_banco="$(wc -c < "$trabalho/banco.dump")"
if [ "$tamanho_banco" -lt 10000 ]; then
  echo "  ✗ dump com $tamanho_banco bytes — pequeno demais para ser um banco real."
  echo "    Backup ABORTADO: um arquivo vazio que se chama backup é pior que backup nenhum."
  exit 1
fi
echo "     $(numfmt --to=iec "$tamanho_banco" 2>/dev/null || echo "$tamanho_banco bytes")"

# ── 2. Anexos ───────────────────────────────────────────────────────────────
# Lido de dentro de um container que monta o volume: o volume não tem caminho
# no host de forma portátil, e depender de /var/lib/docker/volumes amarra o
# backup ao driver de armazenamento.
echo "2/4  anexos (radiografias, fotos, PDFs)…"
docker compose run --rm --no-deps --entrypoint sh -T app \
  -c 'cd /anexos 2>/dev/null && tar -cf - . || tar -cf - -T /dev/null' \
  > "$trabalho/anexos.tar"

tamanho_anexos="$(wc -c < "$trabalho/anexos.tar")"
echo "     $(numfmt --to=iec "$tamanho_anexos" 2>/dev/null || echo "$tamanho_anexos bytes")"

# ── 3. Manifesto ────────────────────────────────────────────────────────────
# Guarda o que é preciso saber para restaurar sem adivinhar: versão do
# Postgres, quantas migrations estavam aplicadas e as somas de verificação.
echo "3/4  manifesto…"
versao_pg="$(docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$BANCO" -tAc 'show server_version' | tr -d '\r')"
migrations="$(docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$BANCO" -tAc 'select count(*) from drizzle.__drizzle_migrations' | tr -d '\r')"
pacientes="$(docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$BANCO" -tAc 'select count(*) from paciente' | tr -d '\r')"
evolucoes="$(docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$BANCO" -tAc 'select count(*) from evolucao' | tr -d '\r')"

cat > "$trabalho/manifesto.txt" <<FIM
facilident backup
gerado_em=$(date -Iseconds)
postgres=$versao_pg
migrations_aplicadas=$migrations
pacientes=$pacientes
evolucoes=$evolucoes
banco_bytes=$tamanho_banco
anexos_bytes=$tamanho_anexos
banco_sha256=$(sha256sum "$trabalho/banco.dump" | cut -d' ' -f1)
anexos_sha256=$(sha256sum "$trabalho/anexos.tar" | cut -d' ' -f1)
FIM

# ── 4. Empacota ─────────────────────────────────────────────────────────────
arquivo="$DESTINO/facilident-$carimbo.tar.gz"
echo "4/4  empacotando em $arquivo…"
tar -czf "$arquivo" -C "$trabalho" banco.dump anexos.tar manifesto.txt

echo
echo "✓ $arquivo ($(numfmt --to=iec "$(wc -c < "$arquivo")" 2>/dev/null || wc -c < "$arquivo"))"
echo "  $migrations migrations · $pacientes paciente(s) · $evolucoes evolução(ões)"

# ── Retenção ────────────────────────────────────────────────────────────────
if [ "$RETENCAO_DIAS" -gt 0 ]; then
  antigos="$(find "$DESTINO" -name 'facilident-*.tar.gz' -mtime "+$RETENCAO_DIAS" 2>/dev/null | wc -l)"
  if [ "$antigos" -gt 0 ]; then
    find "$DESTINO" -name 'facilident-*.tar.gz' -mtime "+$RETENCAO_DIAS" -delete
    echo "  $antigos backup(s) com mais de $RETENCAO_DIAS dias removido(s)"
  fi
fi

echo
echo "AGORA A PARTE QUE IMPORTA: prove que restaura."
echo "  ./docker/restaurar.sh --testar $arquivo"
echo
echo "Backup nunca testado não é backup — é esperança com nome de arquivo."
