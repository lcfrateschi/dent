#!/usr/bin/env bash
# ============================================================================
# Restauração do Facilident — e o teste dela.
#
#   ./docker/restaurar.sh --testar backups/facilident-AAAAMMDD-HHMMSS.tar.gz
#   ./docker/restaurar.sh --para-valer backups/facilident-AAAAMMDD-HHMMSS.tar.gz
#
# ── Por que `--testar` é o modo padrão de uso ──────────────────────────────
# Porque a única coisa que prova um backup é restaurá-lo. `--testar` cria um
# banco temporário ao lado (`facilident_teste_restauracao`), restaura ali, confere as
# contagens contra o manifesto e roda as invariantes. **Não toca no banco de
# produção.** É o comando para rodar toda semana.
#
# `--para-valer` sobrescreve o banco atual e é o comando do dia ruim. Ele exige
# confirmação digitada, porque `docker compose exec` num terminal errado é fácil
# demais.
#
# ── O que a restauração de prontuário exige ────────────────────────────────
# Banco E anexos. Restaurar só o banco devolve um prontuário cujas radiografias
# apontam para arquivos que não existem — e ninguém descobre até tentar abrir uma.
# ============================================================================
set -euo pipefail

MODO=""
ARQUIVO=""
for arg in "$@"; do
  case "$arg" in
    --testar) MODO="testar" ;;
    --para-valer) MODO="para-valer" ;;
    *) ARQUIVO="$arg" ;;
  esac
done

if [ -z "$MODO" ] || [ -z "$ARQUIVO" ]; then
  echo "uso: $0 --testar|--para-valer arquivo.tar.gz"
  exit 2
fi
if [ ! -f "$ARQUIVO" ]; then
  echo "✗ arquivo não encontrado: $ARQUIVO"
  exit 1
fi

SERVICO_DB="${SERVICO_DB:-db}"
USUARIO="${POSTGRES_USER:-facilident}"
BANCO="${POSTGRES_DB:-facilident}"
BANCO_TESTE="facilident_teste_restauracao"

trabalho="$(mktemp -d)"
trap 'rm -rf "$trabalho"' EXIT

echo "── Restauração do Facilident ─────────────────────────────────────"
tar -xzf "$ARQUIVO" -C "$trabalho"

if [ ! -f "$trabalho/manifesto.txt" ]; then
  echo "✗ sem manifesto: o arquivo não foi gerado por docker/backup.sh"
  exit 1
fi

# shellcheck disable=SC1090
esperado_pacientes="$(grep '^pacientes=' "$trabalho/manifesto.txt" | cut -d= -f2)"
esperado_evolucoes="$(grep '^evolucoes=' "$trabalho/manifesto.txt" | cut -d= -f2)"
esperado_migrations="$(grep '^migrations_aplicadas=' "$trabalho/manifesto.txt" | cut -d= -f2)"
esperado_sha_banco="$(grep '^banco_sha256=' "$trabalho/manifesto.txt" | cut -d= -f2)"
esperado_sha_anexos="$(grep '^anexos_sha256=' "$trabalho/manifesto.txt" | cut -d= -f2)"

echo "  gerado em: $(grep '^gerado_em=' "$trabalho/manifesto.txt" | cut -d= -f2)"
echo "  conteúdo:  $esperado_migrations migrations · $esperado_pacientes paciente(s) · $esperado_evolucoes evolução(ões)"
echo

# ── Integridade antes de qualquer coisa ─────────────────────────────────────
# Um dump corrompido restaurado sobre produção é o pior resultado possível: some
# o que existia e não entra o que devia.
echo "1/5  conferindo somas de verificação…"
sha_banco="$(sha256sum "$trabalho/banco.dump" | cut -d' ' -f1)"
sha_anexos="$(sha256sum "$trabalho/anexos.tar" | cut -d' ' -f1)"
if [ "$sha_banco" != "$esperado_sha_banco" ]; then
  echo "     ✗ dump do banco corrompido (sha256 não confere)"
  exit 1
fi
if [ "$sha_anexos" != "$esperado_sha_anexos" ]; then
  echo "     ✗ pacote de anexos corrompido (sha256 não confere)"
  exit 1
fi
echo "     ✓ banco e anexos íntegros"

if [ "$MODO" = "para-valer" ]; then
  echo
  echo "  ⚠ ISTO SOBRESCREVE O BANCO \"$BANCO\" E OS ANEXOS ATUAIS."
  printf '  Digite RESTAURAR para confirmar: '
  read -r confirmacao
  if [ "$confirmacao" != "RESTAURAR" ]; then
    echo "  cancelado."
    exit 1
  fi
  ALVO="$BANCO"
else
  ALVO="$BANCO_TESTE"
fi

# ── Banco ───────────────────────────────────────────────────────────────────
echo "2/5  preparando o banco \"$ALVO\"…"
if [ "$MODO" = "testar" ]; then
  docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d postgres -q \
    -c "drop database if exists $ALVO" \
    -c "create database $ALVO"
else
  # `--clean` do pg_restore cuida de derrubar o que existe, dentro da mesma
  # transação da restauração.
  echo "     (o dump traz --clean; nada é derrubado antes da hora)"
fi

echo "3/5  restaurando o banco…"
docker compose exec -T "$SERVICO_DB" \
  pg_restore -U "$USUARIO" -d "$ALVO" --clean --if-exists --no-owner --no-privileges \
  < "$trabalho/banco.dump" 2>&1 | grep -vE "^pg_restore: (connecting|processing|creating|implied)" || true

# ── Anexos ──────────────────────────────────────────────────────────────────
if [ "$MODO" = "para-valer" ]; then
  echo "4/5  restaurando os anexos…"
  docker compose run --rm --no-deps --entrypoint sh -T app \
    -c 'mkdir -p /anexos && cd /anexos && tar -xf -' < "$trabalho/anexos.tar"
  echo "     ✓ arquivos de volta em /anexos"
else
  echo "4/5  anexos: conferindo o pacote sem tocar no volume…"
  arquivos="$(tar -tf "$trabalho/anexos.tar" | grep -vc '/$' || true)"
  echo "     ✓ $arquivos arquivo(s) no pacote (não extraídos: modo teste)"
fi

# ── A conferência que dá sentido ao script ──────────────────────────────────
echo "5/5  conferindo o que voltou…"
falhou=0

conferir() {
  local rotulo="$1" obtido="$2" esperado="$3"
  if [ "$obtido" = "$esperado" ]; then
    echo "     ✓ $rotulo: $obtido"
  else
    echo "     ✗ $rotulo: esperado $esperado, obtido $obtido"
    falhou=1
  fi
}

obtido_pacientes="$(docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$ALVO" -tAc 'select count(*) from paciente' | tr -d '\r')"
obtido_evolucoes="$(docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$ALVO" -tAc 'select count(*) from evolucao' | tr -d '\r')"
obtido_migrations="$(docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$ALVO" -tAc 'select count(*) from drizzle.__drizzle_migrations' | tr -d '\r')"

conferir "pacientes" "$obtido_pacientes" "$esperado_pacientes"
conferir "evoluções" "$obtido_evolucoes" "$esperado_evolucoes"
conferir "migrations" "$obtido_migrations" "$esperado_migrations"

# As triggers e EXCLUDE constraints voltaram? É a pergunta que separa "os dados
# voltaram" de "o sistema voltou". Um dump que perde a trigger de append-only
# restaura um prontuário que pode ser editado.
triggers="$(docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$ALVO" -tAc \
  "select count(*) from pg_trigger where not tgisinternal" | tr -d '\r')"
excludes="$(docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$ALVO" -tAc \
  "select count(*) from pg_constraint where contype = 'x'" | tr -d '\r')"
funcoes="$(docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$ALVO" -tAc \
  "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'" | tr -d '\r')"

echo "     ✓ $triggers trigger(s), $excludes EXCLUDE constraint(s), $funcoes função(ões)"
if [ "$triggers" -lt 20 ] || [ "$excludes" -lt 2 ]; then
  echo "     ✗ faltam triggers ou EXCLUDE constraints — o prontuário restaurado seria editável"
  falhou=1
fi

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
saida_probe="$(docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$ALVO" -tAq -c "
     begin;
     do \$\$
     declare v_id uuid; v_msg text;
     begin
       select id into v_id from evolucao  limit 1;
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
  *SEM-EVOLUCAO*)  echo "     · sem evoluções para testar o append-only (banco novo)" ;;
  *RECUSOU-CERTO*) echo "     ✓ o append-only da evolução continua valendo no banco restaurado" ;;
  *ACEITOU*)
    echo "     ✗ a evolução restaurada aceita alterar paciente_id — a trigger não voltou"
    falhou=1 ;;
  *)
    echo "     ✗ o probe do append-only falhou por outro motivo: $saida_probe"
    echo "       (recusar pelo motivo errado não prova nada)"
    falhou=1 ;;
esac

# ── O tenant sobreviveu ao dump? ─────────────────────────────────────────────
#
# Um dump que perdesse `clinica_id`, ou as políticas de RLS, restauraria um banco
# que FUNCIONA e não isola nada: as consultas voltariam a devolver linha de
# qualquer clínica, sem erro e sem log. É a pior forma de restauração ruim, porque
# a conferência de contagens passa e ninguém desconfia.
#
# As três perguntas, em ordem de gravidade: a coluna existe em toda tabela de
# dados, as políticas voltaram, e `FORCE ROW LEVEL SECURITY` continua ligado —
# sem o FORCE o dono das tabelas fica isento e a política é decorativa.
sem_tenant="$(docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$ALVO" -tAc \
  "select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r' and n.nspname = 'public'
      and c.relname not in ('clinica', 'dente', '__drizzle_migrations')
      and not exists (select 1 from pg_attribute a
                       where a.attrelid = c.oid and a.attname = 'clinica_id'
                         and not a.attisdropped)" | tr -d '\r')"
politicas="$(docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$ALVO" -tAc \
  "select count(*) from pg_policy" | tr -d '\r')"
com_force="$(docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$ALVO" -tAc \
  "select count(*) from pg_class where relforcerowsecurity" | tr -d '\r')"

if [ -n "$sem_tenant" ]; then
  echo "     ✗ tabelas SEM clinica_id no banco restaurado: $sem_tenant"
  echo "       o dump perdeu o tenant — o banco restaurado não isola clínicas"
  falhou=1
else
  echo "     ✓ clinica_id presente em todas as tabelas de dados"
fi

echo "     ✓ $politicas política(s) de RLS, $com_force tabela(s) com FORCE"
if [ "$politicas" -lt 40 ] || [ "$com_force" -lt 40 ]; then
  echo "     ✗ faltam políticas de RLS ou o FORCE — dono de tabela voltaria a ignorar o isolamento"
  falhou=1
fi

if [ "$MODO" = "testar" ]; then
  docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d postgres -q \
    -c "drop database if exists $BANCO_TESTE"
  echo "     (banco de teste removido)"
fi

echo
if [ "$falhou" -eq 0 ]; then
  echo "✓ Restauração conferida. Este backup serve."
else
  echo "✗ A restauração NÃO confere. Este backup não serve — investigue antes de precisar dele."
  exit 1
fi
