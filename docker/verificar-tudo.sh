#!/usr/bin/env bash
#
# Roda a bateria inteira de verificação do Facilident e imprime um resumo.
#
#   ./docker/verificar-tudo.sh            # tudo (uns 10 min)
#   ./docker/verificar-tudo.sh --rapido   # só o que não toca o banco de dados vivo
#   ./docker/verificar-tudo.sh --listar   # mostra o que rodaria, sem rodar
#
# ── Por que isto existe ─────────────────────────────────────────────────────
# As provas deste projeto estão espalhadas por doze comandos, e três deles precisam
# de `-e DATABASE_URL=<credencial do dono>` porque o container do `app` não a tem de
# propósito. Quem não sabe disso conclui que o sistema está quebrado ao ver
# "Sem contexto de clínica" — que é a mensagem de um script rodando com a role errada,
# não de um bug.
#
# O risco de uma lista na cabeça é sempre o mesmo: a verificação que ninguém lembra é
# a que não roda, e ela some sem nunca ter falhado.
#
# ── Duas coisas que este script faz de propósito ────────────────────────────
# 1. **Não para no primeiro erro.** Uma bateria que aborta esconde as outras falhas, e
#    saber que 3 de 14 quebraram é informação diferente de saber que 1 quebrou.
# 2. **Distingue "não rodou" de "passou".** Um resumo que só tem ✓ e ✗ trata etapa
#    pulada como sucesso — que é a forma mais fácil de um relatório verde não provar
#    nada. Aqui pulado é `⊘`, com o motivo.
#
# ── O que ele NÃO faz ───────────────────────────────────────────────────────
# Não prepara o ambiente. Se o banco estiver vazio, os scripts que dependem de dado de
# demonstração vão falhar — e é isso que se quer: falha com mensagem melhor que verde
# em cima de banco vazio. A ordem de preparo está no `ROTEIRO-DE-TESTE.md`.
set -uo pipefail

cd "$(dirname "$0")/.."

RAPIDO=0
LISTAR=0
for arg in "$@"; do
  case "$arg" in
    --rapido) RAPIDO=1 ;;
    --listar) LISTAR=1 ;;
    *) echo "argumento desconhecido: $arg" >&2; exit 2 ;;
  esac
done

USUARIO="${POSTGRES_USER:-facilident}"
SENHA="${POSTGRES_PASSWORD:-facilident_dev}"
BANCO="${POSTGRES_DB:-facilident}"
DONO="postgres://${USUARIO}:${SENHA}@db:5432/${BANCO}"

VERDE=$'\e[32m'; VERMELHO=$'\e[31m'; AMARELO=$'\e[33m'; CINZA=$'\e[90m'; FIM=$'\e[0m'

resultados=()
n_ok=0; n_falha=0; n_pulado=0

# Onde a saída completa de cada etapa que falhar é preservada. Fora do repositório,
# porque pode conter dado de demonstração.
FALHAS="${TMPDIR:-/tmp}/facilident-falhas"
rm -rf "$FALHAS"; mkdir -p "$FALHAS"

# `etapa <rótulo> <escopo> <comando…>`
#
# `escopo` é `puro` (não precisa de nada de pé), `banco` (precisa do Postgres) ou
# `http` (precisa do servidor respondendo). É o que decide o que `--rapido` corta e o
# que vira ⊘ quando a dependência não está lá.
etapa() {
  local rotulo="$1" escopo="$2"; shift 2

  if [ "$LISTAR" -eq 1 ]; then
    printf '  %-26s %-6s %s\n' "$rotulo" "$escopo" "$*"
    return
  fi

  if [ "$RAPIDO" -eq 1 ] && [ "$escopo" != 'puro' ]; then
    resultados+=("⊘|$rotulo|--rapido corta o que toca banco ou servidor")
    n_pulado=$((n_pulado + 1))
    return
  fi

  printf '%s▸ %s%s\n' "$CINZA" "$rotulo" "$FIM"
  local saida rc
  saida="$("$@" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '  %s✓%s\n' "$VERDE" "$FIM"
    resultados+=("✓|$rotulo|")
    n_ok=$((n_ok + 1))
  else
    # ── A saída INTEIRA vai para arquivo, e o resumo mostra a linha que importa ──
    #
    # A primeira versão guardava só as três últimas linhas. Parecia razoável ("o erro
    # útil está no fim") e falhou na primeira vez que precisou: uma etapa quebrou com
    # `syscall: 'read'` e as três últimas linhas eram **cauda de stack trace**. O erro
    # de verdade estava no meio, e eu tive de rodar a etapa de novo para vê-lo — o que
    # só funciona quando a falha é reprodutível. Se não for, a informação foi perdida
    # para sempre pelo relatório que existe para preservá-la.
    #
    # Agora: tudo em arquivo, e o resumo prefere a linha marcada com ✗ ou com "Error"
    # à cauda cega.
    local arquivo trecho
    arquivo="$FALHAS/${rotulo// /-}.log"
    printf '%s\n' "$saida" > "$arquivo"
    trecho="$(printf '%s' "$saida" \
      | grep -viE '^\s+at ' \
      | grep -iE '✗|error|erro|falha|violat|recusad' \
      | head -2 | tr '\n' ' ' | cut -c1-180)"
    [ -z "$trecho" ] && trecho="$(printf '%s' "$saida" | grep -vE '^\s*$' | tail -2 | tr '\n' ' ' | cut -c1-180)"
    printf '  %s✗ %s%s\n     %ssaída completa: %s%s\n' \
      "$VERMELHO" "$trecho" "$FIM" "$CINZA" "$arquivo" "$FIM"
    resultados+=("✗|$rotulo|$trecho → $arquivo")
    n_falha=$((n_falha + 1))
  fi
}

# Roda um script npm com a credencial do DONO dentro do container do app.
#
# É o que o `ROTEIRO-DE-TESTE.md` explica: script de operação faz coisas que a
# aplicação não faz (`DISABLE TRIGGER`, `COPY`, criar clínica), e a credencial do dono
# não está no ambiente do serviço web — senão um processo comprometido a leria.
comoDono() {
  docker compose exec -T -e DATABASE_URL="$DONO" app npm run --silent "$1"
}

if [ "$LISTAR" -eq 1 ]; then
  echo 'Etapas (rótulo, escopo, comando):'
fi

# ── Domínio puro e compilação ──────────────────────────────────────────────
etapa 'testes de domínio'      puro npm test --silent
etapa 'typecheck'              puro npx tsc --noEmit
etapa 'XML TISS contra o XSD'  puro npm run --silent tiss:validar

# `docker compose run` e não `exec`: o build de produção sobrescreve os chunks de
# `/app/.next`, que o `next dev` está servindo, e o servidor passa a responder 500 com
# `Cannot find module './vendor-chunks/*.js'`. Já aconteceu, e o `portal:seguranca`
# acusou "VAZOU" em dois casos porque 500 não é 403 — o vazamento não existia.
etapa 'build isolado'          banco docker compose run --rm --no-deps app npm run build

# ── Invariantes no banco ───────────────────────────────────────────────────
etapa 'invariantes do banco'   banco npm run db:verificar
etapa 'RLS e FK composto'      banco npm run rls:verificar
etapa 'trava de assinatura'    banco bash -c "docker compose exec -T db psql -U '$USUARIO' -d '$BANCO' -q -f - < docker/verificar-assinatura.sql"

# ── Ponta a ponta, com sessão de verdade ───────────────────────────────────
etapa 'isolamento entre clínicas' http comoDono tenant:seguranca
etapa 'IDOR no portal'            http comoDono portal:seguranca
etapa 'cadastros e MFA'           http comoDono admin:verificar
etapa 'telas de estoque'          http comoDono estoque:telas
etapa 'onboarding de clínica'     http comoDono clinica:verificar
etapa 'telas de relacionamento'   http comoDono relacionamento:telas
etapa 'telas do caixa'            http comoDono caixa:telas
etapa 'telas clínicas'            http comoDono clinico:telas
etapa 'lista de espera'           http comoDono espera:telas
etapa 'telas clínicas'            http comoDono clinico:telas
# ── A cifra do MFA só é verificável com o segundo fator LIGADO ─────────────
#
# `mfa:verificar` entra pelo HTTP com um código TOTP derivado do segredo cifrado. Com
# `MFA_DESABILITADO=true` — o padrão do compose de desenvolvimento — o campo do código é
# **ignorado**, então o login passaria com qualquer coisa e a verificação não mediria
# nada. O script sabe disso e aborta.
#
# Contar isso como FALHA era o defeito espelhado do que este arquivo evita: verde falso
# engana uma vez, **vermelho falso ensina a ignorar o vermelho**. Uma bateria que fica
# permanentemente vermelha por causa de uma escolha de ambiente é uma bateria que
# ninguém lê.
#
# A sonda é a mesma que `admin:verificar` usa: a tela de login **avisa** quando o
# segundo fator está desligado, então quem decide é o servidor, não a variável de
# ambiente deste shell (que pode ser outra).
if [ "$LISTAR" -eq 0 ] && [ "$RAPIDO" -eq 0 ]; then
  if curl -s --max-time 8 http://localhost:3000/entrar 2>/dev/null \
       | grep -qi 'duas etapas DESLIGADA'; then
    resultados+=("⊘|cifra do MFA|servidor com MFA_DESABILITADO=true; rode: MFA_DESABILITADO=false docker compose up -d --no-deps app")
    n_pulado=$((n_pulado + 1))
  else
    etapa 'cifra do MFA'            http comoDono mfa:verificar
  fi
else
  etapa 'cifra do MFA'              http comoDono mfa:verificar
fi

# ── Demonstrações que conferem número ──────────────────────────────────────
etapa 'estoque (FEFO, validade)'  banco comoDono estoque:demo
etapa 'convênio e TISS'           banco comoDono convenio:demo
etapa 'documentos e anexos'       banco comoDono documentos:demo
etapa 'relatórios'                banco comoDono relatorios:demo
etapa 'WhatsApp'                  banco comoDono whatsapp:demo
etapa 'filas de relacionamento'   banco comoDono relacionamento:demo
etapa 'periograma e prótese'      banco comoDono periograma:demo
etapa 'fechamento financeiro'     banco comoDono caixa:demo
etapa 'impressos (PDF no disco)'  banco comoDono impressos:demo
# Última de propósito: ela afirma que TODA tela tem dado, e só faz sentido depois de
# tudo o que popula ter rodado. A contraprova dela (`--contraprova`, contra um banco só
# com `db:seed`) pegou 12 de 18 asserções vazias na primeira rodada.
etapa 'toda tela tem dado'        http comoDono demo:verificar
etapa 'autoatendimento'           banco comoDono autoatendimento:demo

if [ "$LISTAR" -eq 1 ]; then
  echo
  echo 'Nada foi executado. Sem --listar, tudo isto roda.'
  exit 0
fi

# ── Resumo ─────────────────────────────────────────────────────────────────
echo
echo '════════════════════════════════════════════════════════════════════════'
for linha in "${resultados[@]}"; do
  IFS='|' read -r marca rotulo detalhe <<< "$linha"
  case "$marca" in
    # Sem `%-26s`: `printf` conta BYTES, e em UTF-8 "convênio" ocupa 9 bytes para 8
    # colunas. Rótulo acentuado desalinhava a coluna inteira, e um relatório
    # desalinhado é um relatório que ninguém lê até o fim.
    '✓') printf '  %s✓%s %s\n' "$VERDE" "$FIM" "$rotulo" ;;
    '⊘') printf '  %s⊘%s %s %s— %s%s\n' "$AMARELO" "$FIM" "$rotulo" "$CINZA" "$detalhe" "$FIM" ;;
    *)   printf '  %s✗ %s%s — %s\n' "$VERMELHO" "$rotulo" "$FIM" "$detalhe" ;;
  esac
done
echo '════════════════════════════════════════════════════════════════════════'
printf '  %d passaram · %d falharam · %d pulados\n' "$n_ok" "$n_falha" "$n_pulado"

if [ "$n_falha" -gt 0 ]; then
  echo
  echo "  Antes de investigar: as três causas mais comuns de falha aqui não são bug."
  echo "    1. banco sem dado de demonstração → ROTEIRO-DE-TESTE.md, seção 0"
  echo "    2. 'Sem contexto de clínica' num script → rodou sem a credencial do dono"
  echo "    3. várias clínicas no banco → o script pede --clinica=<uuid>, de propósito"
  echo "    4. etapa de tela falhando na PRIMEIRA rodada após mudar código: o \`next dev\`"
  echo "       compila a rota na primeira requisição, e um fetch com timeout curto perde"
  echo "       essa corrida. Sintoma: erro de rede (\`syscall: 'read'\`), não status HTTP."
  echo "       Rode a etapa sozinha antes de investigar — se passar, era isso."
  echo
  echo "  A saída COMPLETA de cada falha está em $FALHAS — o resumo acima é um trecho."
  echo "  Já perdi um diagnóstico por guardar só as últimas linhas: eram stack trace.
  exit 1
fi

echo
if [ "$n_pulado" -gt 0 ]; then
  # Este ramo existe porque a primeira versão imprimia "Tudo verde" com 14 etapas
  # puladas — exatamente o defeito que este script foi escrito para evitar, dentro do
  # próprio script. Nada falhou não é o mesmo que tudo foi verificado, e quem lê o
  # resumo decide com base nessa frase.
  printf '  %sNada falhou — mas %d de %d etapas rodaram.%s\n' \
    "$AMARELO" "$n_ok" "$((n_ok + n_pulado))" "$FIM"
  # O motivo vem de cada ⊘, não de um palpite. A primeira versão dizia sempre "rode sem
  # --rapido", e isso ficou errado no dia em que apareceu a primeira etapa pulada por
  # OUTRA razão: a bateria completa mandava tirar uma opção que não estava em uso.
  # Instrução errada num relatório é pior que instrução nenhuma — quem a segue perde
  # tempo e depois desconfia do resto.
  echo '  As puladas acima NÃO foram verificadas. O que falta para cada uma:'
  for linha in "${resultados[@]}"; do
    IFS='|' read -r marca rotulo detalhe <<< "$linha"
    [ "$marca" = '⊘' ] && printf '    • %s: %s\n' "$rotulo" "$detalhe"
  done
else
  printf '  %sTudo verde.%s\n' "$VERDE" "$FIM"
fi
echo
echo '  O que esta bateria NÃO cobre, e não é omissão dela — está em CLAUDE.md,'
echo '  "Pendências conhecidas". Os três que mais importam:'
echo '    • S3/R2 nunca rodou contra um bucket real;'
echo '    • a Cloud API da Meta nunca foi chamada de verdade (provedor simulado);'
echo '    • o XML TISS é válido contra o XSD e nunca foi aceito por operadora.'
