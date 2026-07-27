#!/usr/bin/env bash
# ============================================================================
# Restauração de UMA clínica, a partir de docker/exportar-clinica.sh.
#
#   ./docker/restaurar-clinica.sh arquivo.tar.gz --para-banco <nome>
#   ./docker/restaurar-clinica.sh arquivo.tar.gz --conferir     # banco temporário
#
# ── O que este script FAZ e o que ele SE RECUSA a fazer ────────────────────
# Ele restaura a clínica num banco onde ela **não tem nenhuma linha**. Esse é o
# caso legítimo: instância nova, ambiente de conferência, ou a clínica voltando
# depois de ter sido perdida.
#
# Ele **NÃO** faz a coisa que se pede primeiro: voltar uma clínica que já está no
# banco para um estado anterior, no lugar. E o motivo não é falta de tempo — é que
# a operação exige apagar o que existe hoje, e boa parte disso é `evolucao`,
# `audit_log` e `movimento_estoque`, que **recusam DELETE por decisão** (guarda de
# 20 anos, exigência do CFO; triggers em `drizzle/0001`, `0011` e `0019`).
#
# Automatizar isso significaria escrever, e deixar no repositório para sempre, uma
# ferramenta cujo primeiro passo é desligar a trava que protege o prontuário. Ela
# seria usada num dia ruim, com pressa, por alguém que não leu este comentário. O
# custo de errar é apagar prontuário de verdade; o ganho é conveniência num caso
# raro. Não vale.
#
# O caminho para "a clínica X precisa voltar a ontem", então, é:
#   1. restaurar a exportação de ontem num banco ao lado (é o que este script faz);
#   2. olhar o que difere;
#   3. corrigir no banco de produção pelos caminhos que o sistema oferece —
#      retificação de evolução (`retifica_id`), ajuste de estoque em sentido
#      contrário, estorno. São mais trabalhosos porque **deixam rastro**, e é
#      justamente o rastro que a restauração no lugar apagaria.
#
# ── Por que as triggers de aplicação são desligadas durante o COPY ─────────
# Não é para furar o append-only: `INSERT` nunca foi bloqueado. É por causa das
# triggers que **derivam** estado.
#
# `estoque_aplicar_movimento` (`drizzle/0019`) é BEFORE INSERT em
# `movimento_estoque` e soma a quantidade em `lote_material.saldo`. Como o saldo
# final já vem restaurado no CSV de `lote_material`, deixar a trigger correr
# aplicaria cada movimento **duas vezes**: o estoque restaurado ficaria com o dobro
# do histórico somado. O mesmo raciocínio vale para qualquer trigger que calcule
# algo — o arquivo já contém o RESULTADO de elas terem rodado uma vez.
#
# O que continua valendo durante a restauração, porque não é trigger de aplicação:
# FK (inclusive os 80 compostos `(pai_id, clinica_id)`), CHECK, e as EXCLUDE
# constraints da agenda. Integridade estrutural é conferida; lógica derivada, não.
#
# ⚠️ `DISABLE TRIGGER` é DDL: comitar com a trigger desligada a deixa desligada
# **para sempre**, e o prontuário passa a aceitar UPDATE em silêncio — o pior
# resultado possível neste projeto. Daí o contrato, o mesmo de
# `lib/demo/triggers.ts`: desliga e religa **dentro da mesma transação**, o religar
# vem antes do COMMIT, e um bloco de verificação **estoura** se sobrou trigger
# desligada. Se qualquer coisa falhar no meio, o rollback desfaz o DISABLE junto.
#
# E `session_replication_role = 'replica'` está fora de questão: ele desligaria as
# triggers de FK também, e neste projeto isso já produziu 5 linhas órfãs em
# `movimento_estoque` que derrubaram a `drizzle/0023` semanas depois.
# ============================================================================
set -euo pipefail

SERVICO_DB="${SERVICO_DB:-db}"
USUARIO="${POSTGRES_USER:-facilident}"

ARQUIVO=""
DESTINO_BANCO=""
CONFERIR=0

while [ $# -gt 0 ]; do
  case "$1" in
    --para-banco) DESTINO_BANCO="${2:-}"; shift 2 ;;
    --conferir) CONFERIR=1; shift ;;
    -*) echo "opção desconhecida: $1" >&2; exit 2 ;;
    *) ARQUIVO="$1"; shift ;;
  esac
done

if [ -z "$ARQUIVO" ] || { [ -z "$DESTINO_BANCO" ] && [ "$CONFERIR" -eq 0 ]; }; then
  echo "uso: $0 arquivo.tar.gz --para-banco <nome> | --conferir" >&2
  exit 2
fi
[ -f "$ARQUIVO" ] || { echo "✗ arquivo não encontrado: $ARQUIVO" >&2; exit 1; }

trabalho="$(mktemp -d)"
trap 'rm -rf "$trabalho"' EXIT
tar -xzf "$ARQUIVO" -C "$trabalho"

[ -f "$trabalho/manifesto.txt" ] || {
  echo "✗ sem manifesto: este arquivo não foi gerado por docker/exportar-clinica.sh" >&2
  exit 1
}

campo() { grep "^$1=" "$trabalho/manifesto.txt" | head -1 | cut -d= -f2-; }

CLINICA_ID="$(campo clinica_id)"
RAZAO="$(campo clinica_razao_social)"
ESPERADO_TABELAS="$(campo tabelas)"
ESPERADO_LINHAS="$(campo linhas_total)"
ESPERADO_MIGRATIONS="$(campo migrations_aplicadas)"

if [ "$CONFERIR" -eq 1 ]; then
  DESTINO_BANCO="facilident_conferencia_clinica"
fi

echo "── Restauração por clínica ───────────────────────────────────────"
echo "  clínica:  $RAZAO"
echo "  id:       $CLINICA_ID"
echo "  gerado:   $(campo gerado_em)"
echo "  conteúdo: $ESPERADO_TABELAS tabela(s) · $ESPERADO_LINHAS linha(s) · $(campo anexos_arquivos) anexo(s)"
echo "  destino:  banco \"$DESTINO_BANCO\""
echo

psqlq() { docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$DESTINO_BANCO" -tAqc "$1" | tr -d '\r'; }

# ── 1. Integridade do arquivo ──────────────────────────────────────────────
# Antes de qualquer coisa: o arquivo é o que diz ser? Um CSV editado à mão ou
# truncado no transporte restauraria prontuário incompleto sem avisar.
echo "1/6  conferindo somas de verificação…"
if ! (cd "$trabalho" && sha256sum --quiet -c <(grep -E '^[0-9a-f]{64}  ' manifesto.txt)); then
  echo "     ✗ o conteúdo não corresponde ao manifesto — arquivo corrompido ou alterado." >&2
  exit 1
fi
echo "     ✓ $(grep -cE '^[0-9a-f]{64}  ' "$trabalho/manifesto.txt") arquivo(s) íntegro(s)"

# ── 2. O banco de destino está apto? ───────────────────────────────────────
if [ "$CONFERIR" -eq 1 ]; then
  echo "2/6  criando banco temporário \"$DESTINO_BANCO\" e aplicando migrations…"
  docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d postgres -q \
    -c "drop database if exists $DESTINO_BANCO" -c "create database $DESTINO_BANCO"
  DATABASE_URL="postgres://$USUARIO:${POSTGRES_PASSWORD:-facilident_dev}@localhost:${POSTGRES_PORT:-5433}/$DESTINO_BANCO" \
    npx drizzle-kit migrate >/dev/null 2>&1
  # `dente` são os 52 dentes FDI, referência GLOBAL semeada por `db:seed`, não
  # pelas migrations. Sem eles, `dente_paciente` e `documento` (que apontam para
  # dente) não entram — e o erro sairia como violação de FK no meio da
  # restauração, longe da causa.
  DATABASE_URL="postgres://$USUARIO:${POSTGRES_PASSWORD:-facilident_dev}@localhost:${POSTGRES_PORT:-5433}/$DESTINO_BANCO" \
    npx tsx -e "
      import { db, pool } from './lib/db'
      import { seedDentes } from './lib/db/seed/dentes'
      seedDentes(db).then(() => pool.end())
    " >/dev/null 2>&1 || true
else
  echo "2/6  conferindo o banco de destino…"
  existe="$(docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d postgres -tAqc \
    "select 1 from pg_database where datname = '$DESTINO_BANCO'" | tr -d '\r')"
  if [ -z "$existe" ]; then
    echo "     ✗ o banco \"$DESTINO_BANCO\" não existe." >&2
    echo "       Crie-o e aplique as migrations antes (createdb + npm run db:migrate)," >&2
    echo "       ou use --conferir para um banco temporário." >&2
    exit 1
  fi
fi

# ── Schema do destino: mais novo AVISA, mais velho RECUSA ──────────────────
#
# A primeira versão recusava qualquer diferença, e isso se mostrou errado no
# primeiro teste — a `drizzle/0025` foi registrada entre a exportação e a
# restauração, e um arquivo de ontem passou a ser irrestaurável. Isso tornaria a
# ferramenta inútil justamente no caso normal: restaurar num sistema recém
# implantado, que está sempre mais novo que o arquivo.
#
# O que de fato protege contra schema incompatível não é esta contagem — é o
# `COPY`, que nomeia as colunas vindas do cabeçalho do CSV e **falha alto** se
# alguma não existir mais no destino. A contagem serve para dar mensagem clara
# ANTES desse erro confuso, não para ser a trava.
#
# Destino mais VELHO é outra coisa: o arquivo traz colunas que ainda não existem, e
# aí não há restauração possível. Esse caso continua sendo recusa.
migrations_destino="$(psqlq 'select count(*) from drizzle.__drizzle_migrations' 2>/dev/null || echo 0)"
if [ "$migrations_destino" -lt "$ESPERADO_MIGRATIONS" ]; then
  echo "     ✗ o destino tem $migrations_destino migrations e o arquivo veio de um banco com $ESPERADO_MIGRATIONS." >&2
  echo "       O schema do destino é MAIS ANTIGO que o do arquivo: ele não tem as colunas" >&2
  echo "       que estão no CSV. Aplique as migrations no destino primeiro." >&2
  exit 1
fi
if [ "$migrations_destino" -gt "$ESPERADO_MIGRATIONS" ]; then
  echo "     ⚠ o destino tem $migrations_destino migrations, o arquivo veio de $ESPERADO_MIGRATIONS."
  echo "       Isso é o esperado ao restaurar num sistema mais novo. Se alguma migration"
  echo "       posterior removeu ou renomeou coluna, o COPY vai falhar e desfazer tudo."
fi

dentes="$(psqlq 'select count(*) from dente')"
if [ "$dentes" -lt 52 ]; then
  echo "     ✗ o destino tem $dentes dentes (esperado 52). Rode \`npm run db:seed\` primeiro:" >&2
  echo "       a notação FDI é referência global e não vem na exportação da clínica." >&2
  exit 1
fi

# **A precondição que substitui a restauração no lugar.**
# Se a clínica já tem linha no destino, parar aqui é o comportamento correto:
# sobrescrever exigiria apagar dado append-only. Ver o cabeçalho.
ja_tem="$(psqlq "
  select coalesce(sum(n), 0) from (
    select (select count(*) from paciente  where clinica_id = '$CLINICA_ID') as n
    union all select (select count(*) from evolucao  where clinica_id = '$CLINICA_ID')
    union all select (select count(*) from usuario   where clinica_id = '$CLINICA_ID')
    union all select (select count(*) from audit_log where clinica_id = '$CLINICA_ID')
  ) t")"
if [ "${ja_tem:-0}" -gt 0 ]; then
  echo "     ✗ a clínica $CLINICA_ID JÁ TEM $ja_tem linha(s) no banco \"$DESTINO_BANCO\"." >&2
  echo "" >&2
  echo "  Este script não sobrescreve clínica existente, e isso é decisão, não limitação:" >&2
  echo "  sobrescrever exigiria DELETE em evolucao, audit_log e movimento_estoque, que" >&2
  echo "  recusam DELETE por exigência do CFO (guarda de 20 anos). Uma ferramenta que" >&2
  echo "  desligasse essa trava ficaria no repositório para ser usada num dia ruim." >&2
  echo "" >&2
  echo "  Restaure num banco vazio, compare, e corrija a produção pelos caminhos que" >&2
  echo "  deixam rastro: retificação de evolução, ajuste de estoque, estorno." >&2
  exit 1
fi
echo "     ✓ destino apto: $migrations_destino migrations, $dentes dentes, nenhuma linha desta clínica"

# ── 3. Monta a restauração como UM script, numa transação só ───────────────
#
# Um `psql` por tabela seria mais simples de ler e teria uma transação por tabela:
# uma falha na décima deixaria nove tabelas dentro, e a clínica meio restaurada é
# pior que a clínica não restaurada — ninguém sabe onde parou.
#
# A lista de colunas do `COPY` vem do **cabeçalho do CSV**, não do catálogo: o
# arquivo é a fonte da verdade. Se a exportação omitiu uma coluna (é o caso das
# credenciais substituídas... que na verdade vêm preenchidas), é a forma do arquivo
# que manda, e o destino usa o DEFAULT para o que não vier.
echo "3/6  montando a restauração…"
sql="$trabalho/restaurar.sql"
: > "$sql"

{
  # Contexto de tenant definido mesmo com as colunas explícitas: se um dia uma
  # coluna `clinica_id` deixar de vir no arquivo, o DEFAULT `app_clinica_id()`
  # acerta em vez de estourar. Custa uma linha.
  echo "select set_config('app.clinica_id', '$CLINICA_ID', true);"
  echo

  echo "-- Desliga as triggers de APLICAÇÃO (FK e CHECK continuam valendo)."
  docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$DESTINO_BANCO" -tAqc "
    select distinct 'alter table ' || quote_ident(c.relname) || ' disable trigger user;'
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where not t.tgisinternal and n.nspname = 'public' and c.relkind = 'r'
     order by 1" | tr -d '\r'
  echo
} >> "$sql"

clinica_existe="$(psqlq "select 1 from clinica where id = '$CLINICA_ID'")"

for csv in $(ls "$trabalho"/dados/*.csv | sort); do
  base="$(basename "$csv")"
  tabela="$(printf '%s' "$base" | sed 's/^[0-9]*-//; s/\.csv$//')"
  cabecalho="$(head -1 "$csv")"
  linhas="$(( $(wc -l < "$csv") - 1 ))"
  [ "$linhas" -le 0 ] && continue

  if [ "$tabela" = "clinica" ] && [ -n "$clinica_existe" ]; then
    echo "     · clinica: a linha já existe no destino, mantida"
    continue
  fi

  colunas="$(printf '%s' "$cabecalho" | tr ',' '\n' | sed 's/.*/"&"/' | paste -sd, -)"
  {
    echo "copy \"$tabela\" ($colunas) from stdin with (format csv);"
    tail -n +2 "$csv"
    echo '\.'
    echo
  } >> "$sql"
done

{
  echo "-- Religa ANTES do commit, e confere. Não basta mandar religar."
  docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$DESTINO_BANCO" -tAqc "
    select distinct 'alter table ' || quote_ident(c.relname) || ' enable trigger user;'
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where not t.tgisinternal and n.nspname = 'public' and c.relkind = 'r'
     order by 1" | tr -d '\r'
  echo
  cat <<'FIM'
-- A contraprova de que o religar funcionou. Ela ESTOURA, e por estar dentro da
-- mesma transação o rollback desfaz a restauração inteira: melhor não restaurar
-- que restaurar deixando o prontuário editável.
do $$
declare v_desligados text[];
begin
  select coalesce(array_agg(c.relname || '.' || t.tgname order by c.relname), array[]::text[])
    into v_desligados
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where not t.tgisinternal and n.nspname = 'public' and t.tgenabled = 'D';

  if array_length(v_desligados, 1) > 0 then
    raise exception
      'Triggers ainda desligadas ao fim da restauração: %. Abortando — um banco '
      'restaurado com o append-only desligado aceita UPDATE em prontuário.',
      array_to_string(v_desligados, ', ');
  end if;
end $$;
FIM
} >> "$sql"

# ── 4. Aplica ──────────────────────────────────────────────────────────────
echo "4/6  restaurando (uma transação, $(grep -c '^copy ' "$sql") tabela(s))…"
if ! docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$DESTINO_BANCO" \
      -v ON_ERROR_STOP=1 --single-transaction -q -f - < "$sql"; then
  echo "     ✗ a restauração falhou e foi desfeita inteira (--single-transaction)." >&2
  echo "       O banco de destino está como estava. Nada ficou pela metade." >&2
  exit 1
fi
echo "     ✓ aplicado"

# ── 5. Anexos ──────────────────────────────────────────────────────────────
n_anexos="$(tar -tf "$trabalho/anexos.tar" 2>/dev/null | grep -vc '/$' || true)"
if [ "$CONFERIR" -eq 1 ]; then
  echo "5/6  anexos: $n_anexos arquivo(s) no pacote (não extraídos: modo conferência)"
else
  echo "5/6  extraindo $n_anexos anexo(s) em /anexos…"
  docker compose run --rm --no-deps --entrypoint sh -T app \
    -c 'mkdir -p /anexos && cd /anexos && tar -xf -' < "$trabalho/anexos.tar"
  echo "     ✓ arquivos no volume"
fi

# ── 6. A conferência que dá sentido ao script ──────────────────────────────
echo "6/6  conferindo o que voltou…"
falhou=0

# Contagem por tabela contra o manifesto. Contagem TOTAL só não bastaria: linha a
# mais numa tabela e a menos em outra se cancelariam.
while IFS='=' read -r chave esperado; do
  tabela="${chave#linhas.}"
  [ "$tabela" = "clinica" ] && continue
  obtido="$(psqlq "select count(*) from \"$tabela\" where clinica_id = '$CLINICA_ID'")"
  if [ "$obtido" != "$esperado" ]; then
    echo "     ✗ $tabela: esperado $esperado, obtido $obtido"
    falhou=1
  fi
done < <(grep '^linhas\.' "$trabalho/manifesto.txt")
[ "$falhou" -eq 0 ] && echo "     ✓ contagem por tabela confere com o manifesto ($ESPERADO_LINHAS linhas)"

# Nenhuma linha de OUTRA clínica entrou. Num banco de conferência isto é trivial;
# num banco que já tem outros clientes, é a pergunta que importa.
outras="$(psqlq "select count(*) from paciente where clinica_id <> '$CLINICA_ID'")"
echo "     · o destino tem $outras paciente(s) de outras clínicas (intocados)"

# ── A prova de fogo do append-only, e por que ela é escrita assim ───────────
#
# A versão anterior fazia `update evolucao set texto = texto || ' X'` e tinha DOIS
# defeitos, os dois descobertos ao restaurar um banco cujas evoluções eram todas
# rascunho:
#
#  1. **Ela testava a regra errada.** `evolucao_append_only()` só bloqueia UPDATE
#     quando `assinado_em IS NOT NULL` — evolução em RASCUNHO pode ser editada, de
#     propósito. Então num banco sem evolução assinada o probe recebia "UPDATE 1",
#     concluía que a trigger não tinha voltado, e **reprovava um backup bom**. Ele
#     só passa hoje porque o banco de desenvolvimento tem 1 de 1 evolução assinada:
#     é verde por sorte do dado, não por invariante.
#  2. **Ela não desfazia o UPDATE.** O bloco `begin/exception` só desfaz quando dá
#     exceção. No caminho em que a trigger *permite* (rascunho), o UPDATE
#     **comitava** — e em `--para-valer`, que roda contra produção, isso acrescenta
#     " X" ao texto de toda evolução não assinada. Um script de conferência de
#     backup corrompendo prontuário é o pior tipo de bug possível aqui.
#
# A versão abaixo corrige as duas coisas:
#   • testa a imutabilidade de `paciente_id`, que a trigger recusa em QUALQUER
#     evolução, assinada ou não — a invariante vale para todo dado;
#   • confere a MENSAGEM do erro, não só "deu erro": um FK violado ou uma coluna
#     inexistente também "recusariam", e passar por esse motivo é o padrão de falso
#     verde que já apareceu quatro vezes neste projeto;
#   • roda dentro de `begin; … rollback;`, então não existe caminho em que o probe
#     escreva. As NOTICEs chegam ao cliente antes do rollback.
saida_probe="$(docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$DESTINO_BANCO" -tAq -c "
     begin;
     do \$\$
     declare v_id uuid; v_msg text;
     begin
       select id into v_id from evolucao where clinica_id = '$CLINICA_ID' limit 1;
       if v_id is null then raise notice 'SEM-EVOLUCAO'; return; end if;
       begin
         update evolucao set paciente_id = gen_random_uuid() where id = v_id;
         raise notice 'ACEITOU';
       exception when others then
         v_msg := SQLERRM;
         if v_msg like '%imutav%' or v_msg like '%imutáv%' then
           raise notice 'RECUSOU-CERTO';
         else
           raise notice 'RECUSOU-OUTRO-MOTIVO: %', v_msg;
         end if;
       end;
     end \$\$;
     rollback;" 2>&1)"

case "$saida_probe" in
  *SEM-EVOLUCAO*)  echo "     · sem evoluções nesta exportação para testar o append-only" ;;
  *RECUSOU-CERTO*) echo "     ✓ o append-only da evolução vale no banco restaurado" ;;
  *ACEITOU*)
    echo "     ✗ a evolução restaurada aceita alterar paciente_id — as triggers não voltaram"
    falhou=1 ;;
  *)
    echo "     ✗ o probe do append-only falhou por outro motivo: $saida_probe"
    falhou=1 ;;
esac

desligadas="$(psqlq "select count(*) from pg_trigger where not tgisinternal and tgenabled = 'D'")"
if [ "$desligadas" != "0" ]; then
  echo "     ✗ $desligadas trigger(s) ficaram DESLIGADAS no destino"
  falhou=1
else
  echo "     ✓ nenhuma trigger desligada"
fi

# O saldo do estoque não foi somado duas vezes? É o efeito exato que a trigger
# `estoque_aplicar_movimento` teria causado se não fosse desligada, e a única forma
# de vê-lo é comparar o saldo restaurado com a soma dos movimentos.
divergentes="$(psqlq "
  select count(*) from lote_material l
   where l.clinica_id = '$CLINICA_ID'
     and l.saldo <> coalesce((select sum(m.quantidade) from movimento_estoque m
                               where m.lote_id = l.id), 0)")"
if [ "${divergentes:-0}" -gt 0 ]; then
  echo "     ✗ $divergentes lote(s) com saldo diferente da soma dos movimentos"
  echo "       (é o sintoma de trigger de estoque tendo corrido durante a restauração)"
  falhou=1
else
  echo "     ✓ saldo de estoque bate com a soma dos movimentos (nada aplicado em dobro)"
fi

if [ "$CONFERIR" -eq 1 ]; then
  docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d postgres -q \
    -c "drop database if exists $DESTINO_BANCO"
  echo "     (banco de conferência removido)"
fi

# ── A clínica volta SEM contrato, e isso tem de ser dito aqui ──────────────
#
# `assinatura` está fora da exportação de propósito: o `plano_id` aponta para um
# catálogo com uuid gerado por instalação (motivo escrito em `exportar-clinica.sh`).
# E a escolha declarada da `drizzle/0027` é **destravar** quem não tem assinatura —
# falhar fechado congelaria uma clínica por erro de contabilidade nossa, com o
# paciente na cadeira.
#
# A soma das duas coisas é uma clínica restaurada que funciona perfeitamente e não é
# cobrada. Ninguém percebe, porque nada quebra. Daí o aviso ser aqui, alto, e a
# verificação ser o caso 19 de `docker/verificar-assinatura.sql`.
echo
echo "  ⚠ A clínica restaurada está SEM CONTRATO — assinatura não é exportada."
echo "    A escrita FUNCIONA: a 0027 destrava quem não tem assinatura, por decisão."
echo "    Restabeleça antes de considerar a clínica em operação, e confira com"
echo "    docker/verificar-assinatura.sql (o caso 19 vê clínica sem contrato)."

echo
if [ "$falhou" -eq 0 ]; then
  echo "✓ Restauração conferida. Esta exportação serve."
else
  echo "✗ A restauração NÃO confere. Investigue antes de entregar este arquivo."
  exit 1
fi
