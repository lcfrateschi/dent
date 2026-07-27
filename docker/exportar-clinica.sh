#!/usr/bin/env bash
# ============================================================================
# Exportação de UMA clínica: banco (só as linhas dela) + os anexos dela.
#
#   ./docker/exportar-clinica.sh <uuid-da-clinica|CNPJ> [destino]
#   ./docker/exportar-clinica.sh 7c9e6679-… ./exportacoes
#
# ── Por que isto existe, e por que `backup.sh` não serve ───────────────────
# `docker/backup.sh` é o backup de DESASTRE: o banco inteiro, para o dia em que o
# servidor morre. Ele continua sendo o backup. Só que ele contém **todos os
# clientes**, e há duas coisas que ele não sabe fazer:
#
#   1. **Portabilidade (LGPD, art. 18).** A clínica que encerra o contrato tem
#      direito aos dados dela. Entregar o dump completo entregaria o prontuário
#      dos outros clientes junto — o que transformaria o cumprimento de um direito
#      em vazamento de dado de saúde de terceiros.
#   2. **Restauração de uma clínica só.** Hoje a única opção é restaurar o banco
#      todo, o que joga as outras clínicas de volta no tempo.
#
# ── O formato: CSV com cabeçalho, um arquivo por tabela ────────────────────
# CSV serve aos DOIS usos, e é por isso que foi escolhido em vez de `pg_dump`:
#
#   • `pg_dump` **não sabe filtrar linha** (não existe `--where`), então ele está
#     fora por construção, não por gosto;
#   • CSV é lido por qualquer sistema para onde a clínica esteja migrando, o que é
#     o que "formato interoperável" quer dizer na LGPD;
#   • e ainda assim volta exato por `COPY … FROM`, porque no formato CSV do
#     Postgres campo vazio sem aspas é NULL e `""` é string vazia — a distinção
#     que normalmente se perde em CSV, aqui não se perde.
#
# ── O que este arquivo NÃO leva, e por quê ─────────────────────────────────
# Ele nasceu para SAIR da máquina. Isso muda o cálculo do que pode ir dentro:
#
#   • `usuario.senha_hash` e `paciente_conta.senha_hash` saem substituídos por um
#     valor que **nenhuma senha valida** — `lib/auth/senha.ts` exige o formato
#     `scrypt$N$r$p$salt$hash` (6 campos) e devolve `false`, sem lançar, para
#     qualquer coisa fora dele. Mandar hash de senha num `.tar.gz` que vai por
#     e-mail é entregar as contas do staff junto com os dados.
#   • `usuario.mfa_secret` sai NULL. Quem lê aquela coluna gera códigos TOTP
#     válidos em nome da pessoa.
#   • `paciente_conta.token_convite_hash` sai NULL: é credencial de uso único,
#     ainda válida.
#   • `paciente_sessao` **não é exportada**: são sessões VIVAS. Restaurá-las
#     ressuscitaria sessão que alguém revogou — o oposto do que revogar significa.
#
# A consequência é declarada no manifesto e é um recurso, não uma falta: a clínica
# restaurada exige que cada pessoa defina senha de novo. Para uma restauração num
# ambiente novo, é exatamente o que se quer.
#
# ⚠️ ── ESTE ARQUIVO NÃO É CIFRADO ────────────────────────────────────────────
# `backup.sh` já não cifra, e ali o arquivo ao menos fica no servidor. Aqui é
# pior: este arquivo existe para ser ENTREGUE. Prontuário de 20 anos atravessando
# e-mail, pendrive ou WeTransfer em claro é incidente de dado sensível esperando
# acontecer.
#
#   age -r <chave-publica-da-clinica> -o export.tar.gz.age export.tar.gz
#   gpg --encrypt --recipient clinica@exemplo.br export.tar.gz
#
# Cifrar aqui dentro exigiria decidir de quem é a chave, onde ela mora e como se
# entrega a senha — decisões da clínica, não do script. O que o script faz é
# recusar-se a fingir que o problema não existe: ele avisa no fim, toda vez.
# ============================================================================
set -euo pipefail

SERVICO_DB="${SERVICO_DB:-db}"
USUARIO="${POSTGRES_USER:-facilident}"
BANCO="${POSTGRES_DB:-facilident}"

ALVO=""
DESTINO="./exportacoes"
ACEITAR_AUSENTES=0

for arg in "$@"; do
  case "$arg" in
    --aceitar-arquivos-ausentes) ACEITAR_AUSENTES=1 ;;
    -*) echo "opção desconhecida: $arg" >&2; exit 2 ;;
    *) if [ -z "$ALVO" ]; then ALVO="$arg"; else DESTINO="$arg"; fi ;;
  esac
done

if [ -z "$ALVO" ]; then
  echo "uso: $0 <uuid-da-clinica|CNPJ> [destino] [--aceitar-arquivos-ausentes]" >&2
  exit 2
fi

psqlq() { docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$BANCO" -tAqc "$1" | tr -d '\r'; }

trabalho="$(mktemp -d)"
trap 'rm -rf "$trabalho"' EXIT
mkdir -p "$trabalho/dados"

# ── 1. Que clínica é esta? ──────────────────────────────────────────────────
# Aceita uuid ou CNPJ porque quem opera tem o CNPJ no contrato, não o uuid. A
# resolução é estrita: zero resultados e mais de um resultado são erros
# diferentes, e nenhum dos dois pode virar "usei a primeira".
CLINICA_ID="$(psqlq "
  select id::text from clinica
   where id::text = lower(btrim('$ALVO'))
      or cnpj = regexp_replace('$ALVO', '[^0-9]', '', 'g')")"

quantas="$(printf '%s' "$CLINICA_ID" | grep -c . || true)"
if [ "$quantas" -eq 0 ]; then
  echo "✗ nenhuma clínica com id ou CNPJ \"$ALVO\"." >&2
  exit 1
fi
if [ "$quantas" -gt 1 ]; then
  echo "✗ \"$ALVO\" casou com $quantas clínicas. Use o uuid." >&2
  exit 1
fi

RAZAO="$(psqlq "select razao_social from clinica where id = '$CLINICA_ID'")"
CNPJ="$(psqlq "select coalesce(cnpj,'') from clinica where id = '$CLINICA_ID'")"

echo "── Exportação por clínica ────────────────────────────────────────"
echo "  clínica: $RAZAO"
echo "  id:      $CLINICA_ID"
echo "  cnpj:    ${CNPJ:-—}"
echo "  destino: $DESTINO"
echo

# ── 2. A trava que decide se esta exportação vale algo ──────────────────────
#
# Uma exportação que esquece uma tabela produz um arquivo que **parece completo**:
# sai com código 0, tamanho plausível, e o problema aparece na restauração — ou
# nunca, porque quem recebeu não sabe o que faltou.
#
# Daí a lista abaixo. Ela é escrita à mão de propósito, e é conferida contra o
# `pg_catalog` nas DUAS direções:
#
#   • tabela no catálogo e fora da lista  → a exportação FALHA. Tabela nova tem de
#     ser classificada por uma pessoa: ela leva dado da clínica? leva credencial?
#     Exportar por omissão é como um `mfa_secret` novo iria embora sem ninguém ver.
#   • tabela na lista e fora do catálogo  → a exportação FALHA. Uma lista velha
#     pediria `COPY` de tabela que não existe e, num script menos rígido, viraria
#     tabela silenciosamente pulada.
#
# É o mesmo mecanismo da asserção de catálogo no fim de `drizzle/0022`, que derruba
# o deploy quando aparece tabela sem `clinica_id`. A lista envelhece — mas
# envelhece **alto**, e é isso que se quer dela.
TABELAS_CONHECIDAS="
agendamento alerta_clinico anamnese assinatura audit_log bloqueio_agenda cadeira
cobranca consentimento contador convenio dente_paciente documento evolucao execucao glosa
guia_tiss insumo_procedimento item_guia item_plano lote_material material
mensagem_whatsapp movimento_estoque orcamento orcamento_item paciente
paciente_conta paciente_convenio paciente_sessao pagamento parcela
plano_tratamento preco_convenio procedimento profissional recurso_glosa repasse
repasse_item resposta_whatsapp usuario
"

# Tabelas conhecidas que NÃO são exportadas. Cada uma precisa de motivo escrito —
# a lista de exclusão é onde um vazamento se esconde como se fosse decisão.
#
#   paciente_sessao — sessão VIVA. Restaurá-la ressuscitaria sessão já revogada.
#
#   assinatura      — o contrato, e a exclusão aqui é uma decisão REVISADA.
#
# Eu a tinha incluído, com o argumento de que o contrato é sobre a clínica e que sem
# ele a clínica restaurada volta invisível para a cobrança. O argumento continua
# válido; o que o derrubou foi a restauração falhar:
#
#   ERROR: insert or update on table "assinatura" violates foreign key constraint
#   "assinatura_plano_id_fkey"
#   DETAIL: Key (plano_id)=(41654c3b-…) is not present in table "plano_assinatura".
#
# `assinatura.plano_id` aponta para `plano_assinatura`, que é catálogo **do
# fornecedor** e tem uuid gerado **por instalação**. A linha simplesmente não é
# portável: o id do plano "essencial" aqui não é o id do plano "essencial" lá.
#
# Havia três saídas. Traduzir `plano_id` para o CÓDIGO do plano na exportação e
# resolver na volta — máquina nova a serviço do dado menos importante do arquivo.
# Tornar os ids do catálogo determinísticos, o que é o desenho certo para referência
# controlada pelo fornecedor (é o que `dente` faz com a numeração FDI) — mas é mexer
# em schema recém-escrito por um benefício que só a exportação colhe. Ou excluir.
#
# Excluí, porque o contrato é o registro do FORNECEDOR: ele vive no nosso sistema de
# cobrança, a clínica já o tem nas faturas, e nada de LGPD obriga a devolvê-lo. A
# clínica restaurada volta sem contrato **e isso é visível**: o caso 19 de
# `verificar-assinatura.sql` reprova, e a restauração avisa em voz alta.
#
# Se um dia os ids do catálogo virarem determinísticos, esta exclusão pode cair.
TABELAS_EXCLUIDAS="paciente_sessao
assinatura"

catalogo="$(psqlq "
  select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'r' and n.nspname = 'public'
     and exists (select 1 from pg_attribute a
                  where a.attrelid = c.oid and a.attname = 'clinica_id'
                    and not a.attisdropped)
   order by 1")"

conhecidas_ord="$(printf '%s' "$TABELAS_CONHECIDAS" | tr -s ' \n' '\n' | grep . | sort)"
catalogo_ord="$(printf '%s\n' "$catalogo" | grep . | sort)"

novas="$(comm -13 <(printf '%s\n' "$conhecidas_ord") <(printf '%s\n' "$catalogo_ord"))"
sumidas="$(comm -23 <(printf '%s\n' "$conhecidas_ord") <(printf '%s\n' "$catalogo_ord"))"

if [ -n "$novas" ]; then
  echo "✗ tabelas com clinica_id que este script não conhece:" >&2
  printf '    %s\n' $novas >&2
  echo "" >&2
  echo "  Classifique cada uma em TABELAS_CONHECIDAS (e, se for o caso, em" >&2
  echo "  TABELAS_EXCLUIDAS ou em SUBSTITUICOES, se levar credencial)." >&2
  echo "  A exportação para aqui de propósito: tabela nova exportada por omissão é" >&2
  echo "  como uma coluna de credencial nova sairia sem ninguém decidir." >&2
  exit 1
fi
if [ -n "$sumidas" ]; then
  echo "✗ tabelas na lista deste script que não existem mais no banco:" >&2
  printf '    %s\n' $sumidas >&2
  echo "  Atualize TABELAS_CONHECIDAS. Lista velha vira tabela pulada em silêncio." >&2
  exit 1
fi
echo "1/6  catálogo conferido: $(printf '%s\n' "$catalogo_ord" | wc -l) tabela(s) com clinica_id, nenhuma surpresa"

# ── 3. Ordem de dependência, derivada do banco ─────────────────────────────
#
# Escrever a ordem à mão seria uma segunda lista para envelhecer — e o sintoma de
# uma ordem errada é violação de FK no meio da restauração, com metade dos dados
# dentro. A ordem sai do `pg_constraint`, e `tsort` faz a ordenação topológica.
#
# Duas exclusões nas arestas:
#   • **as duas pontas têm de ser tabelas de tenant.** Aresta que sai de referência
#     global viraria dependência de algo que não está sendo exportado — e, pior, o
#     `tsort` devolve os nós das arestas, então a tabela global entraria na ordem e
#     seria exportada.
#
#     Aqui havia `f.relname not in ('clinica', 'dente')`, uma lista por NOME, e ela
#     envelheceu exatamente como este script diz que listas envelhecem: apareceu
#     `plano_assinatura` (catálogo comercial do fornecedor, sem `clinica_id`), a
#     aresta `plano_assinatura → assinatura` entrou, e a ordem veio com 41 tabelas
#     onde deviam ser 40. Quem pegou foi o guarda de contagem logo abaixo — que é a
#     razão de ele existir.
#
#     A condição agora é a **propriedade** que importa (ter `clinica_id`), não o
#     nome. Referência global nova não precisa ser lembrada aqui.
#   • auto-referência (`evolucao.retifica_id → evolucao`, `paciente.responsavel_
#     legal_id → paciente`) é laço no grafo e `tsort` a reportaria como ciclo. A
#     ordem entre linhas da MESMA tabela não é problema de ordem de tabela: é
#     resolvida na restauração, que insere a tabela inteira numa transação.
arestas="$(psqlq "
  select distinct f.relname || ' ' || c.relname
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_class f on f.oid = k.confrelid
    join pg_namespace n on n.oid = c.relnamespace
   where k.contype = 'f' and n.nspname = 'public'
     and c.relname <> f.relname
     and exists (select 1 from pg_attribute a
                  where a.attrelid = c.oid and a.attname = 'clinica_id' and not a.attisdropped)
     and exists (select 1 from pg_attribute a
                  where a.attrelid = f.oid and a.attname = 'clinica_id' and not a.attisdropped)")"

ordenadas="$(printf '%s\n' "$arestas" | grep . | tsort)"
# `tsort` só devolve nós que aparecem em alguma aresta. Tabela que só referencia
# `clinica` (audit_log, contador) não aparece — e some da exportação se ninguém
# reparar. Por isso o complemento é acrescentado explicitamente.
isoladas="$(comm -23 <(printf '%s\n' "$catalogo_ord") <(printf '%s\n' "$ordenadas" | sort))"
ORDEM="$(printf '%s\n%s\n' "$isoladas" "$ordenadas" | grep . | grep -vxF "$(printf '%s\n' "$TABELAS_EXCLUIDAS")" || true)"

n_ordem="$(printf '%s\n' "$ORDEM" | grep -c .)"
n_esperado="$(( $(printf '%s\n' "$catalogo_ord" | wc -l) - $(printf '%s\n' "$TABELAS_EXCLUIDAS" | grep -c .) ))"
if [ "$n_ordem" -ne "$n_esperado" ]; then
  echo "✗ a ordenação devolveu $n_ordem tabelas, esperado $n_esperado." >&2
  echo "  Provável ciclo de FK ou tabela fora do grafo — não exporto pela metade." >&2
  exit 1
fi
echo "2/6  ordem de dependência: $n_ordem tabela(s), sem ciclo"

# ── 4. Colunas, com as credenciais substituídas ────────────────────────────
#
# A substituição é por COLUNA, no `SELECT`, e não por um `UPDATE` depois: o dado
# sensível nunca chega a existir no arquivo. Um `sed` no CSV pronto seria a versão
# frágil disso — bastaria um hash com vírgula para escapar.
declare -A SUBSTITUICOES=(
  # `lib/auth/senha.ts` exige `scrypt$N$r$p$salt$hash`; isto tem um campo só, e
  # `verificarSenha` devolve false sem lançar. Não é "senha difícil": é hash
  # impossível.
  ["usuario.senha_hash"]="'!sem-credencial-na-exportacao'"
  ["usuario.mfa_secret"]="null::text"
  # `case when … is null` e não a constante direta: `paciente_conta` tem o CHECK
  # `(senha_hash is null) = (senha_definida_em is null)`. Conta convidada e nunca
  # ativada tem as duas nulas; trocar só a primeira por um valor produziria um
  # arquivo que **viola CHECK na restauração** — e o erro apareceria como "constraint
  # violation" numa tabela qualquer, longe daqui. Descobri isto porque a fixture de
  # teste bateu na mesma constraint.
  ["paciente_conta.senha_hash"]="case when senha_hash is null then null else '!sem-credencial-na-exportacao' end"
  # `token_convite_expira_em` fica: o CHECK permite prazo sem hash, e saber que
  # havia convite pendente é informação legítima. O que não pode sair é o hash, que
  # ainda é credencial de uso único.
  ["paciente_conta.token_convite_hash"]="null::varchar(64)"
)

colunas_de() {
  docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$BANCO" -tAqc "
    select a.attname
      from pg_attribute a
     where a.attrelid = '$1'::regclass and a.attnum > 0 and not a.attisdropped
     order by a.attnum" | tr -d '\r'
}

echo "3/6  extraindo as linhas da clínica…"
: > "$trabalho/contagens.txt"
substituidas=0
i=0

# A linha da própria `clinica` primeiro: ela não tem `clinica_id` (é o tenant), e
# sem ela a restauração não tem para onde apontar os FKs.
docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$BANCO" -qc \
  "copy (select * from clinica where id = '$CLINICA_ID') to stdout with (format csv, header true)" \
  > "$trabalho/dados/000-clinica.csv"
echo "clinica=1" >> "$trabalho/contagens.txt"

for tabela in $ORDEM; do
  i=$((i + 1))
  lista=""
  while read -r coluna; do
    [ -z "$coluna" ] && continue
    chave="$tabela.$coluna"
    if [ -n "${SUBSTITUICOES[$chave]:-}" ]; then
      lista="$lista, ${SUBSTITUICOES[$chave]} as \"$coluna\""
      substituidas=$((substituidas + 1))
    else
      lista="$lista, \"$coluna\""
    fi
  done <<< "$(colunas_de "$tabela")"
  lista="${lista#, }"

  arquivo="$(printf '%03d-%s.csv' "$i" "$tabela")"
  docker compose exec -T "$SERVICO_DB" psql -U "$USUARIO" -d "$BANCO" -qc \
    "copy (select $lista from \"$tabela\" where clinica_id = '$CLINICA_ID') to stdout with (format csv, header true)" \
    > "$trabalho/dados/$arquivo"

  # -1 pelo cabeçalho. `wc -l` sem linha final contaria a menos; o COPY sempre
  # termina com newline, então isto está correto — e a restauração confere de novo.
  linhas="$(( $(wc -l < "$trabalho/dados/$arquivo") - 1 ))"
  echo "$tabela=$linhas" >> "$trabalho/contagens.txt"
done

total_linhas="$(awk -F= '{s+=$2} END {print s}' "$trabalho/contagens.txt")"
echo "     $total_linhas linha(s) em $((i + 1)) arquivo(s) · $substituidas campo(s) de credencial substituído(s)"

# ── 5. A conferência que não confia no próprio WHERE ───────────────────────
#
# Um `where clinica_id = …` errado (ou ausente, num futuro refactor) produziria
# arquivo com linha de outra clínica, e nada acusaria. Então o conteúdo é lido de
# volta e conferido: **toda** linha de **todo** arquivo tem de declarar esta
# clínica.
#
# Isto é feito no CSV pronto, e não por uma segunda consulta ao banco, de
# propósito: uma consulta repetiria o mesmo `where` e passaria pelo mesmo erro.
# Conferir o artefato é a única forma de a checagem ser independente do que ela
# checa.
#
# ── Por que um leitor de CSV de verdade, e não `awk -F,` ────────────────────
# A primeira versão desta checagem fazia `awk -F, '$c != id'`, e ela **abortava a
# exportação de um banco perfeitamente sadio**: 71 linhas de `audit_log`, 1 de
# `evolucao`, 7 de `material`, 1 de `item_plano`, 1 de `execucao`. Nenhuma era de
# outra clínica.
#
# `awk -F,` não sabe o que é CSV: parte em toda vírgula, inclusive as que estão
# **dentro** de um campo entre aspas. `evolucao.texto` tem vírgula,
# `audit_log.detalhes` é jsonb (`{"a":1,"b":2}`), descrição de material tem vírgula.
# A partir da primeira, as colunas deslocam e `$c` deixa de ser `clinica_id`.
#
# O que torna isso grave não é o falso positivo — é que o erro vale **nos dois
# sentidos**. Com as colunas deslocadas, o campo lido no lugar de `clinica_id` pode
# coincidir com o id desta clínica, e aí uma linha alheia de verdade passaria
# batida. Uma checagem de vazamento que erra para os dois lados é pior que nenhuma:
# ela dá confiança.
#
# O módulo `csv` do Python aplica as mesmas regras de aspas e escape que o
# `COPY … FROM` vai aplicar na restauração — que é o leitor que importa.
echo "4/6  conferindo que não escapou linha de outra clínica…"
estranhas=0
for csv in "$trabalho"/dados/*.csv; do
  base="$(basename "$csv")"
  [ "$base" = "000-clinica.csv" ] && continue
  fora="$(CSV="$csv" ID="$CLINICA_ID" python3 "$(dirname "$0")/conferir-tenant-no-csv.py")"
  case "$fora" in
    SEM_COLUNA)
      echo "     ✗ $base não tem coluna clinica_id no cabeçalho" >&2
      estranhas=$((estranhas + 1))
      continue ;;
    VAZIO) continue ;;
  esac
  if [ "$fora" -gt 0 ]; then
    echo "     ✗ $base: $fora linha(s) de outra clínica" >&2
    estranhas=$((estranhas + fora))
  fi
done
if [ "$estranhas" -gt 0 ]; then
  echo "✗ EXPORTAÇÃO ABORTADA: o arquivo teria dado de outro cliente dentro." >&2
  exit 1
fi
echo "     ✓ nenhuma linha de outra clínica"

# ── 6. Anexos: enumerados pelo BANCO, nunca por prefixo de diretório ──────
#
# Varrer `clinicas/<id>/` seria o caminho óbvio e perderia arquivo: a chave só
# leva prefixo de clínica nas gravações a partir da Fase 17, porque
# `drizzle/0011` congela `documento.storage_key` e arquivo já gravado não muda de
# lugar (ver `lib/armazenamento/tipos.ts`). Chave antiga não tem prefixo nenhum.
#
# A linha de `documento` sabe o `clinica_id` de qualquer chave, nova ou velha —
# então a lista de arquivos sai dela. De lambuja: varrer prefixo também acharia o
# que não está no banco, o que é lixo ou incidente, não prontuário.
echo "5/6  anexos (enumerados a partir de documento)…"
psqlq "select storage_key from documento where clinica_id = '$CLINICA_ID' order by storage_key" \
  | grep . > "$trabalho/chaves.txt" || true
n_chaves="$(wc -l < "$trabalho/chaves.txt")"

if [ "$n_chaves" -eq 0 ]; then
  tar -cf "$trabalho/anexos.tar" -T /dev/null
  ausentes=0
else
  # O tar é feito de dentro de um container que monta /anexos: o volume não tem
  # caminho portátil no host (mesma razão de `backup.sh`).
  #
  # O prefixo `AUSENTE:` não é enfeite. A primeira versão lia o stderr inteiro como
  # a lista de arquivos que faltam — e `docker compose run` escreve o progresso dele
  # ("Container … Creating") justamente no stderr. Resultado: a exportação abortou
  # dizendo que faltavam 2 arquivos, e os "nomes" eram duas linhas de log do Docker.
  # Um canal compartilhado entre dados e ruído precisa de marcador.
  docker compose run --rm --no-deps --entrypoint sh -T app -c '
    cd /anexos 2>/dev/null || exit 0
    cat > /tmp/chaves.txt
    : > /tmp/presentes.txt
    while IFS= read -r k; do
      [ -z "$k" ] && continue
      if [ -f "$k" ]; then echo "$k" >> /tmp/presentes.txt; else echo "AUSENTE:$k" >&2; fi
    done < /tmp/chaves.txt
    tar -cf /tmp/anexos.tar -T /tmp/presentes.txt 2>/dev/null || tar -cf /tmp/anexos.tar -T /dev/null
    cat /tmp/anexos.tar
  ' < "$trabalho/chaves.txt" > "$trabalho/anexos.tar" 2> "$trabalho/ruido.txt"

  grep '^AUSENTE:' "$trabalho/ruido.txt" | sed 's/^AUSENTE://' > "$trabalho/faltando.txt" || true
  ausentes="$(grep -c . "$trabalho/faltando.txt" || true)"

  # O tar tem de conter exatamente os presentes. Sem esta conferência, um erro
  # dentro do container (tar sem permissão, volume não montado) produziria um
  # `anexos.tar` vazio e a exportação seguiria dizendo que empacotou tudo.
  no_tar="$(tar -tf "$trabalho/anexos.tar" 2>/dev/null | grep -vc '/$' || true)"
  if [ "$no_tar" -ne "$((n_chaves - ausentes))" ]; then
    echo "✗ o pacote de anexos tem $no_tar arquivo(s), esperado $((n_chaves - ausentes))." >&2
    echo "  Não entrego exportação cujo próprio pacote não confere." >&2
    exit 1
  fi
fi

echo "     $((n_chaves - ausentes)) de $n_chaves arquivo(s) empacotado(s)"
if [ "$ausentes" -gt 0 ]; then
  echo "     ⚠ $ausentes arquivo(s) referenciado(s) no banco e AUSENTE(S) no disco:"
  sed 's/^/       /' "$trabalho/faltando.txt" | head -20
  if [ "$ACEITAR_AUSENTES" -eq 0 ]; then
    echo "" >&2
    echo "✗ EXPORTAÇÃO ABORTADA." >&2
    echo "  Arquivo ausente é incidente ANTERIOR a esta exportação — e entregar uma" >&2
    echo "  exportação incompleta sem dizer é pior que não entregar: quem recebe não" >&2
    echo "  tem como saber o que falta." >&2
    echo "  Investigue; se a ausência for conhecida e aceita, repita com" >&2
    echo "  --aceitar-arquivos-ausentes (fica registrado no manifesto)." >&2
    exit 1
  fi
  echo "     (aceito por --aceitar-arquivos-ausentes; registrado no manifesto)"
fi

# ── 7. Manifesto e empacotamento ──────────────────────────────────────────
echo "6/6  manifesto e empacotamento…"
versao_pg="$(psqlq 'show server_version')"
migrations="$(psqlq 'select count(*) from drizzle.__drizzle_migrations')"

{
  echo "facilident exportacao-por-clinica"
  echo "versao_formato=1"
  echo "gerado_em=$(date -Iseconds)"
  echo "clinica_id=$CLINICA_ID"
  echo "clinica_razao_social=$RAZAO"
  echo "clinica_cnpj=$CNPJ"
  echo "postgres=$versao_pg"
  echo "migrations_aplicadas=$migrations"
  echo "tabelas=$n_ordem"
  echo "linhas_total=$total_linhas"
  echo "anexos_arquivos=$((n_chaves - ausentes))"
  echo "anexos_referenciados=$n_chaves"
  echo "anexos_ausentes=$ausentes"
  echo "credenciais_removidas=sim"
  echo "campos_credencial_substituidos=$substituidas"
  echo "sessoes_incluidas=nao"
  echo "cifrado=nao"
  echo "# contagem por tabela"
  sort "$trabalho/contagens.txt" | sed 's/^/linhas./'
} > "$trabalho/manifesto.txt"

# sha256 de cada CSV: o manifesto passa a detectar arquivo editado à mão, não só
# truncado. É o que faz a conferência da restauração ter o que reprovar.
(cd "$trabalho" && sha256sum dados/*.csv anexos.tar >> manifesto.txt)

mkdir -p "$DESTINO"
carimbo="$(date +%Y%m%d-%H%M%S)"
apelido="$(printf '%s' "$RAZAO" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//' | cut -c1-40)"
arquivo="$DESTINO/clinica-${apelido:-sem-nome}-$carimbo.tar.gz"
tar -czf "$arquivo" -C "$trabalho" dados anexos.tar manifesto.txt

echo
echo "✓ $arquivo ($(numfmt --to=iec "$(wc -c < "$arquivo")" 2>/dev/null || wc -c < "$arquivo"))"
echo "  $n_ordem tabela(s) · $total_linhas linha(s) · $((n_chaves - ausentes)) anexo(s)"
echo
echo "  Restaure para provar que serve:"
echo "    ./docker/restaurar-clinica.sh $arquivo --para-banco conferencia_$carimbo"
echo
echo "  ⚠ ESTE ARQUIVO NÃO ESTÁ CIFRADO e contém prontuário."
echo "    Antes de sair da máquina:  age -r <chave> -o $(basename "$arquivo").age $(basename "$arquivo")"
