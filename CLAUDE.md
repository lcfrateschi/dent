# Facilident — software de gestão odontológica

Ver `ROADMAP.md` para as fases e `GLOSSARIO.md` para a linguagem do domínio.
**Use os termos do glossário no código.** `evolucao` nunca é `nota`; `itemPlano` nunca é `procedimento`.

## Decisões arquiteturais fixas

1. **Multi-tenant, um banco, `clinica_id` em toda tabela de dados.** *(Era single-tenant até a
   Fase 17 — se você ler "uma clínica, sem `clinica_id`" em algum comentário antigo, o
   comentário está velho, não o código.)*

   `clinica` é o tenant: PK `uuid`, e o `CHECK clinica_singleton` deixou de existir. As 39
   tabelas de dados (mais `contador`) têm `clinica_id uuid NOT NULL` com **`DEFAULT
   app_clinica_id()`** — é esse default que dispensou tocar em ~114 pontos de escrita.

   `app_clinica_id()` lê `app.clinica_id` da transação e **estoura se não houver contexto**.
   Devolver `NULL` seria pior que estourar: a política de RLS filtraria tudo em silêncio, e
   agenda vazia não parece bug, parece um dia fraco. Quem define o contexto é
   `comClinica()` (`lib/tenant/executar.ts`), via `set_config(…, is_local => true)` — vale até
   o commit, então a conexão volta ao pool limpa. **Script de linha de comando e despachante
   definem o contexto a cada iteração**, não uma vez em volta do laço.

   Fora da lista, com justificativa: `clinica` (é o tenant) e `dente` (52 dentes FDI, padrão
   internacional). `procedimento` **está dentro** — valor, `requer_dente` e ficha técnica são
   decisão de cada clínica. A asserção de catálogo no fim de `drizzle/0022` **derruba o deploy**
   se aparecer tabela nova sem `clinica_id`; é ela que substituiu o `clinica_singleton` como
   invariante de arquitetura.

   Unicidade: o que era global e virou por clínica está listado na seção 5 da `0022`, **e o que
   NÃO virou também está lá, com o motivo** — `usuario.email` e `paciente_conta.email` seguem
   únicos no mundo porque o login é e-mail + senha e o tenant é derivado da credencial.

   **A Row Level Security está de pé (`drizzle/0023`) e o app conecta como `facilident_app`.**
   O ponto que decidiu tudo: **dono de tabela ignora política de RLS**, e superusuário também.
   Enquanto o app conectava como `facilident` (dono e superusuário no Docker), toda política era
   decorativa e o teste adversarial passava com o vazamento de pé. A role de aplicação não é
   dona, não tem `BYPASSRLS`, e as 41 tabelas têm `FORCE ROW LEVEL SECURITY` com política
   `USING` **e** `WITH CHECK` — só `USING` deixaria o `INSERT` gravar na clínica alheia.

   **Ovo e galinha do login, resolvido:** `authorize()` acha o usuário por e-mail *antes* de
   saber a clínica, e a sessão do portal acha pelo hash do token — sob RLS as duas devolveriam
   zero linhas e ninguém entraria. Por isso existem `clinica_do_login_de_staff(email)` e
   `clinica_da_sessao_do_portal(hash)`, `SECURITY DEFINER`, que devolvem **só um uuid** (nunca
   `senha_hash`, nunca `mfa_secret`) com `search_path` fixo. O despachante usa
   `clinicas_para_processamento()` pelo mesmo motivo: como `facilident_app` ele veria **uma**
   clínica e as outras ficariam sem lembrete, sem erro e sem log.

   **Redundância travada, não confiada:** 81 FKs são compostos `(pai_id, clinica_id)` →
   `(id, clinica_id)`, então é impossível uma `parcela` apontar para `cobranca` de outra clínica.
   50 estão declarados no schema TS; os outros 29 usam `ON DELETE SET NULL (coluna)` — forma com
   lista do Postgres 15+, que preserva `clinica_id` — e **o Drizzle não sabe expressá-la**:
   declarar geraria `SET NULL` puro, que anula `clinica_id` (`NOT NULL`) e faz o `DELETE` do pai
   falhar. Medido. Ver o aviso no topo de `lib/db/schema/tenant.ts`.

   **Como provar:** `npm run rls:verificar` (25 casos) e `npm run tenant:seguranca`, que cria duas
   clínicas, tenta alcançar paciente/documento/orçamento/guia da outra por id na URL e exige
   404 — **nunca 200 e nunca 500**, porque num teste adversarial 500 se confunde com isolamento.
   O passo que dá valor ao resto **desliga a política, repete o pedido e exige 200**; religa e
   confere. Política ligada → 404, desligada → 200: é a RLS.

   ⚠️ **Script de operação roda com a credencial do DONO**, fornecida no momento do uso — o
   container do `app` não a tem, senão um processo web comprometido a leria. Vale para `migrate`,
   seeds, `db:verificar`, backup, exportação, `demo:*` e os `*:demo`. **Consulta escrita para
   rodar como dono precisa filtrar `clinica_id` explicitamente**, porque ali não há política; nas
   duas vezes em que isso foi esquecido, quem avisou foi o FK composto.
2. **Dois realms de autenticação.** Staff (`usuario`) e paciente (`paciente_conta`) são
   tabelas e sessões separadas. **Nunca compartilhe uma query entre staff e portal** — é
   exatamente ali que nasce o IDOR que expõe o prontuário do vizinho.

   Implementado na Fase 12, e a separação é concreta: cookies diferentes
   (`authjs.session-token` × `dent_portal`), mecanismos diferentes (JWT × token opaco no
   banco), tipos incompatíveis (`Ator` × `SessaoPortal`) e **nenhuma FK** entre os realms —
   `drizzle/0013` falha o deploy se alguém criar uma. Toda função de `lib/portal/consultas.ts`
   filtra por `sessao.pacienteId` e **nenhuma aceita `pacienteId` como parâmetro**: a defesa
   contra IDOR é estrutural, não disciplinar. Rodar `npm run portal:seguranca` depois de
   qualquer mexida no portal.
3. **`evolucao` é append-only.** Sem `UPDATE`, sem `DELETE` — garantido por trigger no banco,
   não por disciplina no código. Corrigir = inserir nova evolução com `retifica_id` apontando
   para a anterior. Exigência do CFO; guarda mínima de 20 anos.
4. **Convênio já tem gancho no schema desde a Fase 1** (`preco_convenio`,
   `item_plano.cobertura`, `item_plano.convenio_id`, `item_plano.guia_tiss_id`). O módulo TISS
   é a Fase 13, mas o modelo financeiro não precisará ser refatorado para recebê-lo.
5. **Regras de domínio ficam em `lib/domain/`**, puras e testadas. Server action não decide
   regra de negócio — ela valida entrada, chama o domínio e persiste.
6. **`audit_log` em todo acesso a prontuário.** Dado de saúde é dado sensível na LGPD:
   leitura também é evento auditável, não só escrita.

## Stack

| Camada | Escolha | Fase |
|---|---|---|
| Banco | Postgres + Drizzle ORM | 1 |
| Regras | TypeScript puro em `lib/domain/` | 1 |
| Testes | Vitest | 1 |
| Front + Back | Next.js 15 App Router | 3 |
| UI | Tailwind + shadcn/ui | 2 |
| Auth | Auth.js + MFA para staff; sessão opaca no banco para o portal | 3 / 12 |
| Anexos | Disco (padrão) ou S3/R2, bucket privado; servidos pela aplicação | 10 |
| WhatsApp | Meta Cloud API oficial | 9 |

Next.js e Tailwind **ainda não estão instalados** — entram na Fase 3, conforme a disciplina de
fatia vertical. A Fase 1 é só domínio e banco.

### Node — Docker é o caminho suportado

Alvo: **Node 22** (`.nvmrc`, `engines: >=20.11`). Use `docker compose up`.

O ambiente onde as Fases 1–2 foram escritas tinha Node 18.19, EOL desde abril/2025, e ele
quebra duas coisas que **funcionam normalmente no container**:

| Sintoma no host com Node 18 | Causa | No Docker |
|---|---|---|
| `next build` falha com `Cannot find module '@tailwindcss/postcss'` | o `require-hook` do Next não resolve o pacote (que só tem `exports`, sem `main`) no worker | funciona |
| Vitest `^4` falha: `node:util` não exporta `styleText` | API só existe no Node 20.12+ | por isso o Vitest está travado em `^3` |

O que **funciona no host** mesmo com Node 18: `npm test`, `npm run typecheck`,
`npm run db:generate`. O que exige Node 20+ ou Docker: `next build` e `next dev`.

**Ao subir o host para Node 20+**, atualize o Vitest para `^4` e remova esta seção.

### Não rode `npm run build` DENTRO do container que serve o `next dev`

Os dois compartilham `/app/.next`. O build de produção sobrescreve os chunks do dev, e o servidor
passa a responder **500** com `Cannot find module './vendor-chunks/*.js'` nas páginas que ainda não
foram recompiladas. Pior: o erro parece regressão do código. Aconteceu, e o `portal:seguranca`
acusou "VAZOU" em dois casos porque um 500 não é 403 — o vazamento não existia.

Para conferir o build sem derrubar o dev:

```bash
docker compose run --rm --no-deps app npm run build   # container novo, .next próprio
```

`docker compose run` cria um volume anônimo novo para `/app/.next`; `docker compose exec` usa o do
container em pé. Se acontecer, `docker compose restart app` recompila e resolve.

### `next build` exige `NODE_ENV=production`

Com `NODE_ENV=development` o build monta um bundle misto e a exportação do `/404` falha com
`<Html> should not be imported outside of pages/_document` — mensagem que não diz nada sobre a
causa. **Reproduz num app Next de quatro linhas**, então não é nada deste projeto. O container
`dev` tem `NODE_ENV=development`, por isso `npm run build` já força o valor certo, e o estágio
`build` do Dockerfile o declara explicitamente.

Duas coisas relacionadas, que só apareceram quando o build passou a rodar:

- **Nada de segredo ou banco na importação de módulo.** A coleta de rotas importa cada página e
  cada rota de API. `exigirSegredoDeProducao()` sai fora durante `phase-production-build` e o
  cliente do banco é preguiçoso (`lib/db/index.ts`) — senão construir a imagem exigiria o App
  Secret da Meta e um Postgres de pé. Compilar não é servir.
- **Componente cliente não importa módulo com `node:crypto`.** Foi o que quebrou o build da
  Fase 12 sem que `npm test` ou `tsc` reclamassem: `AcessoAoPortal.tsx` importava
  `lib/auth/convite.ts`. A parte pura mora em `lib/auth/conviteTexto.ts`.

### A marca é imagem de fundo, e o middleware precisa deixá-la passar

`components/ui/Marca.tsx` usa `background-image: var(--marca-*)` para que a troca de tema troque o
ARQUIVO. Dois `<img>` com `dark:hidden` baixariam os dois arquivos sempre; SVG embutido custaria
~5 KB de traçado em toda resposta HTML.

**O app está travado no tema CLARO por enquanto.** O alternador saiu das três cascas e o script de
pré-pintura de `app/layout.tsx` está em comentário, com o caminho de volta escrito ali e em
`components/ui/AlternarTema.tsx`. Os tokens `.dark` continuam vivos em `app/globals.css` e cobertos
pelo teste de tokens — apagá-los faria o catálogo do design system divergir do código, e religar o
tema viraria arqueologia. O motivo do desligamento está no parágrafo seguinte.

**A arte é a original nos dois temas** — sem versão branca, sem recolorir texto. O custo é pago com
a **chapa**: o navio `#0D3B66` da palavra sobre `#071626` dá 1,3:1, então no escuro a assinatura vai
sobre `--marca-chapa` (`#F2F5F9`, o cinza do manual), como crachá. É um retângulo claro num cabeçalho
escuro — a alternativa era a linha `reverse`, que lê bem e perde as cores; a clínica escolheu manter
as cores. O símbolo **sozinho** (portal) não leva chapa: tem contraste de sobra. `reverse` fica
guardada para marca monocromática, sobre foto por exemplo.

**A tela de login mostra o logotipo, e quem a vê não tem sessão.** `marca/`, `icon.svg` e
`apple-icon.png` estão fora do `matcher` do middleware — sem isso ele responde 307 aos SVG e o
login aparece sem logo. O ícone da Apple é **PNG** porque o Safari não aceita SVG em
`apple-touch-icon`; o `app-icon.svg` do kit é rasterizado a 180 px.

O **favicon não é o app icon do kit**: ali o dente ocupa metade do quadro e, a 16 px, o traço fino
sobre fundo quase branco vira mancha. Ele é o dente oficial **colorido**, recortado justo, sobre a
tinta clara `#E6F6F6` — não branco, senão o badge sumiria em aba de navegador clara. Conferido
renderizando a 16 e 32 px.

### TypeScript

Travado em **`^5.9`**. O TypeScript 7 (compilador nativo) quebra o carregador de
`next.config.ts` do Next 15 — erro `Cannot read properties of undefined (reading 'fileExists')`.
Reavaliar quando o Next declarar suporte.

### O nome do projeto no compose é `facilident`

Renomear `name:` no `docker-compose.yml` cria um projeto **novo** para o Docker: containers e
volumes do nome antigo ficam órfãos, invisíveis para `docker compose ps`, com o banco de
desenvolvimento dentro. `docker compose -p dent down -v` limpa os do nome anterior. Em produção
isso seria perda de dados — o caminho é `docker/backup.sh` antes e `restaurar.sh --para-valer`
depois.

### A ordem das migrations é o campo `when`, não o número do arquivo

O `drizzle-kit migrate` decide o que aplicar comparando o `when` de
`drizzle/meta/_journal.json`. Se uma migration gerada receber um `when` **menor** que o da
anterior — acontece quando as entradas manuais foram escritas com timestamp "redondo" —
`drizzle-kit migrate` **pula em silêncio**, imprime `applying migrations…` e sai com código 0.
Ao adicionar SQL manual ao journal, mantenha `when` crescente.

### A imagem do `migrate` não monta o código-fonte — ela o COPIA no build

O serviço `app` monta o diretório do projeto como volume, então editar um arquivo já
vale na próxima execução. O `migrate` **não**: o estágio dele no `Dockerfile` faz
`COPY lib ./lib`, e a imagem congela o código do momento do build.

O sintoma é cruel porque parece bug no seu código: `docker compose up` falha no seed
com `on conflict ("codigo")` — um alvo de conflito que **o código-fonte atual não tem
mais** (o índice virou `(clinica_id, codigo)` na `0022`). Você lê o arquivo, está
certo; roda `npm run db:seed` pelo `app`, funciona; e o `migrate` continua falhando.
Isso bloqueia `docker compose up -d app`, porque `app` depende dele.

```bash
docker compose build migrate    # depois de QUALQUER mudança em lib/ ou drizzle/
```

Já custou tempo duas vezes: uma na Fase 17 (a `0022` "não aplicava") e outra aqui. O
jeito de confirmar em 5 segundos, em vez de deduzir:

```bash
docker compose run --rm --entrypoint sh migrate -c 'grep -n onConflictDoUpdate -A2 /app/lib/db/seed/procedimentos.ts'
```

### `drizzle-kit migrate` engole a mensagem de erro

Sai com **código 1 imprimindo só `applying migrations…`** — nenhuma linha sobre o que falhou.
Foi assim que a `0022` pareceu "não ter feito nada" por três tentativas. O jeito de ver o erro
de verdade:

```bash
docker compose exec -T db psql -U facilident -d facilident \
  -v ON_ERROR_STOP=1 --single-transaction -f - < drizzle/00XX_nome.sql
```

`--single-transaction` é o que torna isso seguro de repetir: falhou, nada ficou aplicado. Foi
assim que apareceu `audit_log e append-only: UPDATE nao e permitido` — o backfill de
`clinica_id` batendo na trigger que existe justamente para recusar `UPDATE`.

E o corolário para migration de mão: `drizzle-kit generate` **não sabe** expressar troca de tipo
de PK, `DROP CONSTRAINT` de unicidade que virou composta, nem backfill. O que ele gerou para a
Fase 17, aplicado como veio, deixaria o banco quebrado. O caminho é: rodar `generate` (é dele
que vem o snapshot que as gerações futuras usam como base), **descartar o SQL gerado**, escrever
o SQL à mão, e renomear a entrada do journal. Está documentado no topo da `0022`.

### Nunca use `drizzle-kit push`

Ele desconhece as EXCLUDE constraints e os triggers de `drizzle/0001_constraints.sql` e pode
derrubá-los silenciosamente — junto com o append-only do prontuário. O script foi removido do
`package.json` de propósito. Use `db:generate` + `db:migrate`.

Depois de mexer em constraint ou trigger, rode `npm run db:verificar`: são 200 casos que provam
as invariantes contra um Postgres real. O script **falha na hora** se uma tabela esperada não
existir — um `espera_erro` com a tabela ausente "passa" pelo motivo errado, e isso já produziu
um relatório verde provando invariante nenhuma.

### Pendências conhecidas

- **Os anexos gravam em DISCO, não em bucket.** `ARMAZENAMENTO=disco` é o padrão e
  é uma escolha válida para clínica em um servidor só. O volume `anexos` **entra no backup**
  junto com o dump (`docker/backup.sh` empacota os dois; separar permitiria levar só metade, e
  banco sem os arquivos não reconstitui prontuário). `lib/armazenamento/s3.ts` está pronto e **nunca executou contra um
  bucket real**; a assinatura SigV4, que é a parte difícil de diagnosticar, está
  provada contra os vetores oficiais da AWS.
- **O PDF já foi olhado — atestado e receita, rasterizados a 110 dpi.** `npm run
  impressos:demo` emite os dois pelo caminho real (`emitirAtestado`/`emitirReceita`,
  que antes só eram chamados pelas server actions) e **deixa os arquivos no disco**,
  porque não se olha o que não existe. O que a olhada encontrou e nenhum teste
  pegaria: o cabeçalho saía `Telefone: 1133334444` e `CNPJ: 11222333000181`, enquanto
  o CPF do paciente saía `127.933.468-10` três linhas abaixo — os formatadores já
  existiam e não estavam sendo usados. `pdftotext` extrai o texto certo dos dois
  jeitos, e é por isso que só olhar pega.

  **O orçamento também foi olhado** (rasterizado igual), e o conserto do cabeçalho
  valeu para ele. Duas observações, nenhuma corrigida por mim porque as duas são
  decisão da clínica e não defeito:

  1. **O orçamento não identifica o profissional responsável.** Ele tem valor,
     validade e uma linha de assinatura do PACIENTE ("Ciente e de acordo") — e nenhum
     nome de dentista, nenhum CRO. O atestado e a receita têm. Num desacordo sobre o
     que foi proposto, o documento não diz quem propôs. Não é estética: é quem
     responde pelo plano de tratamento.
  2. Sem desconto, o impresso mostra `Subtotal: R$ 800,00` e `TOTAL: R$ 800,00` — o
     mesmo número duas vezes. Defensável (mostra que não houve desconto) e também
     confuso para quem recebe.

  O que **continua** sem conferência: impressão em papel de verdade (margem de
  impressora não é margem de PDF) e a régua de pontos da receita
  (`.......... 21 cápsulas`), que tem número fixo de pontos, então a quantidade não
  alinha em coluna — legível, mas quem lê é a farmácia. Não mexi: é redesenho.
- **O PSP de Pix NUNCA executou contra a API real.** `lib/caixa/pix/psp.ts` foi escrito
  pela documentação da API Pix v2 do Banco Central e é o único arquivo da Fase 20 que
  precisa de conferência linha a linha quando as credenciais existirem — mesma situação de
  `meta.ts`. Nenhuma cobrança foi emitida, nenhuma notificação verdadeira recebida. O que
  **está** verificado é tudo depois dele: assinatura conferida, evento gravado,
  idempotência, conciliação por `txid` e o efeito no caixa. E o que muda de PSP para PSP é
  justamente o que não dá para testar sem conta: a autenticação (mTLS × OAuth2 × token) e o
  nome/algoritmo do cabeçalho de assinatura do webhook.
- **NFS-e não existe, e ficou fora por decisão.** É imposto municipal: a API é por
  prefeitura, exige certificado A1 da clínica, inscrição municipal e código de serviço
  municipal — nada disso existe aqui, e um adaptador escrito às cegas contra ~5.500
  especificações repetiria a situação do `meta.ts` multiplicada. O caminho é provedor
  agregador, e o que falta antes de começar está no relatório da Fase 20.
- **WhatsApp roda no provedor SIMULADO.** Nenhuma mensagem sai de verdade até a clínica ter
  conta WhatsApp Business com o template `lembrete_consulta_pt_br` aprovado. `lib/mensageria/
  provedor/meta.ts` foi escrito pela documentação da Cloud API v21 e **nunca executou contra a
  API real** — é o único arquivo da fase que precisa de conferência quando as credenciais
  existirem. Todo o resto (fila, idempotência, webhook, efeito na agenda) está verificado.
- **O despacho tem serviço próprio.** `docker compose --profile prod up despachante` roda
  `whatsapp:despachar` em laço, a cada 10 min (`DESPACHO_INTERVALO_SEGUNDOS`). Cron do host
  dependeria de alguém lembrar de instalar a linha, e essa pessoa não é a mesma que sobe o
  compose.
- **O MFA está DESLIGADO no desenvolvimento** (`MFA_DESABILITADO=true` no serviço `app` do
  compose). O login ignora o campo do código; a senha continua exigida. Três travas contêm o
  atalho: produção **se recusa a subir** com a chave ligada (erro no boot, em
  `exigirSegredoDeProducao`), `mfaDesabilitado()` devolve `false` em produção mesmo se aquela
  checagem for removida, e a tela de login avisa. **Não existe código mágico `000000`** na
  verificação TOTP — um valor mágico sobreviveria à condição de ambiente falhar; o que existe é o
  campo ser ignorado. Para provar a trava do MFA de novo: `MFA_DESABILITADO=false docker compose
  up -d app` e `npm run admin:verificar` (com a chave ligada, aquele caso sai como `⊘ pulado`).
- **`usuario.mfa_secret` é CIFRADO em repouso**, e o que falta agora é rotação de chave.
  AES-256-GCM, subchave derivada de `MFA_CHAVE` por HKDF, formato `v1$nonce$cifrado`, com o
  `usuario.id` como dado autenticado adicional — sem isso, quem consegue um `UPDATE` copiaria o
  próprio valor cifrado (de que já tem o autenticador) para a linha do administrador e passaria a
  gerar o segundo fator dele. Segredo anterior é reconhecido pela ausência do prefixo (base32 não
  tem `$`) e recifrado no login seguinte. `npm run mfa:verificar` prova por HTTP, e o passo 1 dele
  **exige que `000000` seja recusado** — com `MFA_DESABILITADO=true` o campo é ignorado e a
  verificação seria vazia.

  ⚠️ **Trocar `MFA_CHAVE` hoje tranca todos fora do segundo fator.** O formato suporta `v2`, mas
  falta `MFA_CHAVE_ANTERIOR` e um mapa versão→subchave (~20 linhas). Avisado no `.env.example`.
- **`codigo_tuss`: 36 dos 49 procedimentos já têm código OFICIAL.** A faixa odontológica da
  Tabela 22 (370 códigos, prefixos 81–87) está em `dados/tuss22-odontologia.csv`, baixada da API
  da ANS — não editada. O mapeamento catálogo→TUSS é interpretação e vale conferir com quem
  fatura antes do primeiro envio. Os **13 restantes ficaram em branco de propósito**: ou o
  procedimento não existe na Tabela 22, ou existem vários candidatos e a escolha muda o valor
  recebido. `dados/README.md` lista cada caso com os candidatos. **Não preencha por dedução** —
  código plausível e errado é glosa que aparece semanas depois.
- **O XML TISS agora é VALIDADO contra o XSD oficial da ANS — e o gerador estava errado em nove
  pontos.** `npm run tiss:validar` (10 casos: 1 validação + 7 contraprovas + 2 de que o gerador
  estoura em vez de emitir XML incompleto), contra os 7 XSDs da versão 3.05.00 baixados de
  `ans.gov.br/padroes/tiss/schemas/`, **sem edição**, versionados em `dados/tiss-xsd-3.05.00/`
  com `SHA256SUMS` e procedência.

  O que estava errado e **nenhum parser veria**: `versaoPadrao` em vez de `Padrao`; invólucro
  `cabecalhoGuia` que não existe; `procedimentosExecutados` usado como invólucro quando é o
  elemento **repetido**; `nomeContratado` e `profissionalExecutante`, que a guia odontológica não
  tem (identifica por CNPJ, CNES e código na operadora); `<UF>SP</UF>` onde `dm_UF` enumera
  **códigos IBGE** (SP = 35); `denteFace` com 16 caracteres onde o tipo aceita 5; e nove campos
  obrigatórios ausentes.

  ⚠️ **A diferença entre validado e aceito é grande, e continua de pé.** O XSD não sabe se o
  código corresponde ao que foi feito, se o valor está na tabela negociada, nem as regras próprias
  de cada operadora — que existem, fora do schema. **Não emitimos `assinaturaDigitalGuia`**, que
  algumas exigem, e **nada foi enviado a operadora real**. O caminho que fatura hoje continua
  sendo a folha de conferência. O XML só deixou de ser "estrutura plausível" e passou a ser
  "estrutura conferida".

  **Quatro campos obrigatórios não existem no banco** (código do prestador na operadora, CNES da
  clínica, CBOS do profissional, plano do beneficiário) e **não foram inventados** — pelo mesmo
  motivo dos 13 TUSS em branco: valor plausível passa no schema e volta como glosa. O gerador
  **estoura nomeando o que falta**. Ver o aviso no topo de `lib/tiss/exportar.ts`.
- **Valores do catálogo são de partida** — revisar com a clínica.
- **Os mínimos de estoque e as fichas técnicas do seed são de partida.** Foram postos na ordem
  de grandeza de um consultório de duas cadeiras. O número certo sai do consumo real: depois de
  um mês de movimento, a tela mostra média diária e cobertura em dias. O seed **não** cria
  saldo — estoque inicial é contagem física.
- **Termos ⚠️ do GLOSSARIO.md** ainda esperam validação com o dentista. Os que restam são de
  vocabulário (titular de convênio, encaixe, faturado), não de regra de cálculo.

### Decisões fechadas — não reabrir

- **Comissão sobre valor RECEBIDO** (`clinica.base_comissao = 'valor_recebido'`), decidido pela
  clínica. A comissão entra na base quando o pagamento é conciliado, não quando o procedimento é
  executado. Comissão paga sobre execução vira adiantamento quando o paciente atrasa.
- **Identidade Facilident**, do manual da marca: paleta `#0D3B66` / `#1278E3` / `#00B3A6` /
  `#E6F6F6` / `#F2F5F9` / `#6B7280`, tipografia **Poppins**, símbolo do dente com sorriso e
  pixels. **O kit oficial do designer está em `design-system/kit-da-marca/`** (color, mono,
  reverse, extra) e os arquivos servidos em `public/marca/`. Nada de redesenhar a marca: houve uma
  fase em que o símbolo era um vetor que eu tirei do PNG do manual, e ele foi descartado quando o
  kit chegou. Substitui a decisão anterior (verde-petróleo `#0f766e`), que era explicitamente
  condicional a "a clínica não tem identidade visual a aplicar" — o fato mudou, a decisão muda
  com ele. O que **não** mudou: `primary` é o marinho e não o azul, porque azul significa
  "executado" no odontograma e porque `#1278E3` com branco dá 4,37:1 (abaixo de AA). Ver o
  comentário no topo de `app/globals.css`.
- **Mensagem travada em `enviando` NÃO é reenviada automaticamente.** Se o processo morreu
  depois de chamar a Meta, ninguém sabe se ela entregou. A linha fica visível na tela de
  WhatsApp e a decisão é humana. Perder um lembrete custa uma ligação; mandar dois custa a
  confiança do paciente. A trigger de transição em `drizzle/0009` impede `enviando → pendente`.
- **O preço do convênio é o da DATA DA EXECUÇÃO**, nunca o vigente hoje. `precoVigenteEm` existe
  para isso. Faturar com o preço de hoje um procedimento de três meses atrás é glosa garantida.
- **A sobra do arredondamento da coparticipação vai para o PACIENTE.** Pedir um centavo a mais à
  operadora é motivo de glosa do item inteiro; um centavo a mais do paciente ninguém discute.
- **Glosa é CALCULADA (`apresentado − pago`), nunca digitada.** Campo de glosa digitado divergindo
  do repasse é conciliação que não fecha nunca.
- **`glosada_parcial` não é "paga".** Guia paga em parte tem valor a recorrer e continua na fila.
- **Dentro de um template `sql` do Drizzle, `${tabela.coluna}` renderiza SEM qualificar a tabela.**
  Em subconsulta com join, isso vira `column reference "id" is ambiguous`. Escreva
  `"tabela"."coluna"` literal — ver `painelDeConvenios`.
- **A fila de relacionamento é idempotente por CHAVE, não por consulta.**
  `tarefa_relacionamento.chave_idempotencia` existe **uma por FATO** gerador
  (`orcamento_sem_resposta:<id>`), e os geradores fazem `ON CONFLICT DO NOTHING`. A chave
  **ignora a situação** de propósito: um gerador escrito como "existe tarefa ABERTA? se não,
  cria" passa em qualquer teste de idempotência e **recria a tarefa dispensada** na passada
  seguinte — a recepção liga de novo para quem pediu para não ser incomodado. Por isso toda FK
  de referência em `tarefa_relacionamento` é `restrict`: apagar a tarefa dispensada faria a
  chave deixar de colidir. Medido em `docker/verificar-invariantes.sql` com contraprova — o
  gerador ingênuo acha 1 para recriar, o por-chave acha 0.
- **O convite de retorno não diz o procedimento.** `tipo_retorno` (profilaxia, periodontal,
  ortodontia) existe na tabela para a clínica organizar a fila e para o relatório separar as
  coisas; **não entra na mensagem**. "Está na hora da sua reavaliação periodontal" seria mais
  útil e é justamente o que não pode sair. Ver `textoRecall` em `lib/domain/textoMensagem.ts`,
  com teste que varre a lista de termos clínicos proibidos.
- **Regime de CAIXA e regime de COMPETÊNCIA são duas perguntas, e há duas tabelas.**
  `despesa` é a obrigação (o aluguel de julho pertence a julho, pago ou não);
  `pagamento_despesa` é o movimento (saiu do banco em 5 de agosto). `despesasPorCompetencia`
  responde "quanto custou julho?"; `fluxoDeCaixaDoPeriodo` responde "quanto saiu em agosto?".
  As duas estão certas ao mesmo tempo, e uma invariante reprova se algum dia derem o mesmo
  número no mesmo mês. Um `pago boolean` na despesa responderia a primeira e destruiria a
  segunda — sem data de saída, sem pagamento parcial, sem saber que a conta foi paga em duas
  vezes. Confundir os dois não dá erro na tela: dá um relatório que a contadora recusa.
- **Comissão paga é despesa LANÇADA À MÃO, nunca derivada da apuração.** `comissaoDoPeriodo`
  diz quanto cada profissional tem a receber — é a fonte do número. Quando a clínica paga,
  alguém lança a despesa. Derivar automaticamente seria contagem dupla esperando acontecer:
  o lançamento manual vai existir de todo jeito, porque o dinheiro saiu do banco. Não existe
  função que crie despesa a partir de comissão, e não deve passar a existir.
- **A taxa do meio de pagamento é a VIGENTE NA DATA DO PAGAMENTO**, nunca a de hoje —
  mesma regra do preço de convênio, e mesma EXCLUDE constraint impedindo duas vigências no
  mesmo dia. Com duas, o valor líquido dependeria da ordem da consulta, e isso chega na
  folha, porque a base da comissão pode ser o líquido.
- **Conciliação por `txid`/`end_to_end_id`, NUNCA por "valor e data parecidos".**
  Aproximação é o que fecha o mês com o dinheiro do paciente errado, e o erro aparece
  semanas depois como uma parcela quitada que ninguém pagou. E a idempotência do webhook é
  o índice único `(clinica_id, end_to_end_id)`, não uma verificação: "vê se já processei, se
  não processo" tem janela entre ler e escrever, e duas entregas simultâneas conciliam duas
  vezes — dinheiro em dobro no caixa com o extrato mostrando uma entrada só. Há contraprova
  em `caixa:demo` que remove o índice numa transação e mede a duplicação.
- **Pix nasce no provedor SIMULADO**, como o WhatsApp, e `PIX_PROVEDOR=psp` sem credenciais
  **estoura** em vez de cair para o simulado. Se o padrão fosse "real quando não
  configurado", um ambiente com variáveis pela metade emitiria cobrança contra a conta da
  clínica; e cair para o simulado quando alguém pede `psp` produziria um ambiente que se
  acha configurado e não cobra ninguém.
- **Caixa e produção NUNCA são somados.** São grandezas diferentes — executado em
  julho pode entrar em outubro, e a comissão é sobre o recebido. Não existe função
  que devolva a soma dos dois, e não deve passar a existir. Ver
  `lib/relatorios/consultas.ts`.
- **Taxa sem base é `null`, não zero.** Mês sem atendimento não tem taxa de falta
  de 0%: não tem taxa. A tela escreve "—". Variação sobre base zero é "do zero",
  nunca "+100%". Ver `lib/domain/indicadores.ts`.
- **Falta e cancelamento têm taxas separadas.** Cancelado avisado liberou o
  horário e fica FORA da base da taxa de falta.
- **A mensagem de WhatsApp não carrega dado clínico.** Só nome, profissional, data e hora — a
  tela do celular do paciente é lida por outras pessoas. Ver `lib/domain/textoMensagem.ts`.
- **O portal do paciente não tem MFA, por decisão.** Exigir autenticador de quem entra três
  vezes por ano produz abandono, não segurança. O que compensa: bloqueio crescente por
  tentativas (`lib/domain/bloqueio.ts`), sessão de 12 h e revogação imediata. Se um dia a
  clínica quiser MFA opcional para o paciente, o lugar é `lib/portal/sessao.ts`.
- **Bloqueio de login do paciente NUNCA é permanente.** Trancar a conta para sempre depois
  de N erros transforma o ataque em negação de serviço: quem sabe o e-mail do paciente o
  tranca fora do portal. A escada para em 60 minutos de propósito.
- **O portal não mostra evolução clínica nem radiografia.** Histórico de atendimentos sim.
  A íntegra do prontuário é direito do paciente (CFO) e é pedida na clínica, com exportação
  auditada — evolução é escrita para outro profissional, e imagem sem laudo gera
  interpretação errada.
- **"Não vou poder ir" no portal NÃO cancela o agendamento.** Registra o aviso e a recepção
  resolve. Um toque errado no celular não pode custar o horário do paciente, e a clínica
  precisa saber para remarcar.
- **A chave de armazenamento leva prefixo de clínica na ESCRITA, e a leitura aceita as antigas.**
  `clinicas/<clinicaId>/pacientes/<pacienteId>/<ano>/<documentoId>.<ext>`, com o `clinicaId` vindo
  do `Ator` — se viesse do formulário, um POST forjado gravaria o exame dentro do prefixo de outra
  clínica. O prefixo não existe para impedir vazamento na leitura (a chave vem de linha já
  filtrada por RLS): existe porque **sem ele não há como exportar nem restaurar UMA clínica**, e
  dump de banco sem os arquivos não reconstitui prontuário. A assimetria é decisão: tentei migrar
  as chaves antigas e a trigger de `drizzle/0011` recusou — `storage_key` é congelada para que
  nenhum registro passe a apontar para o objeto de outro paciente. Migrar exigiria um script cujo
  único trabalho é desligar uma trava de prontuário, e não há instalação em produção com chave
  antiga. Consequência registrada em `lib/armazenamento/tipos.ts`: a exportação por clínica
  **enumera a partir das linhas de `documento`**, nunca varrendo um prefixo.
- **Anexo do prontuário NÃO é servido por URL assinada.** Os bytes passam pela
  rota `/api/documentos/[id]`, que autoriza e audita cada acesso. URL assinada é
  encaminhável: quem recebe o link vê a radiografia sem sessão e sem deixar
  rastro. A troca é banda por exigência legal, e a escolha é a exigência legal.
- **Remoção de documento é de mão única.** Corrigir envio errado é remover com
  motivo e enviar de novo. Esconder e reexibir um documento clínico sem rastro é
  o que a guarda de 20 anos existe para impedir. Trigger em `drizzle/0011`.
- **A clínica não pode ficar sem administrador.** Desativar ou rebaixar o último admin ativo
  trancaria todos fora do sistema, e a saída passaria a ser `UPDATE` no banco. Trigger em
  `drizzle/0021`. Ninguém desativa a si mesmo, pelo mesmo motivo.
- **Senha criada pelo admin é TEMPORÁRIA.** Senha que passou por telefone é senha comprometida:
  `usuario.senha_temporaria` prende a pessoa em `/trocar-senha`. A ordem é **MFA primeiro, senha
  depois** — trocar já protegido por segundo fator é melhor que trocar com a credencial que
  circulou.
- **Reset de MFA apaga o segredo, nunca o mostra.** Admin que vê `mfa_secret` gera códigos
  válidos em nome do outro. Nenhuma consulta de `lib/admin/` seleciona essa coluna.
- **Preço de convênio NÃO se corrige por cima.** Só `vigencia_fim` muda; reajuste é linha nova e a
  anterior fecha no dia anterior, automaticamente. EXCLUDE constraint impede dois preços válidos no
  mesmo dia — com dois, o valor faturado dependeria da ordem da consulta. Preço já usado em guia
  não se apaga: é o histórico do que foi apresentado.
- **Uma carteirinha ATIVA por paciente e operadora.** Duas tornariam indefinido qual número vai na
  guia.
- **Clínica SEM assinatura tem a escrita LIBERADA** — e isto é assimétrico em relação ao resto
  do projeto, de propósito. Falhar fechado congelaria uma clínica por erro de contabilidade
  **nosso**, com o paciente na cadeira. O compensatório é verificação, não congelamento: o caso
  19 de `docker/verificar-assinatura.sql` reprova se existir clínica sem contrato, e a
  restauração por clínica avisa em voz alta. Vermelho "por enquanto" ali é o mesmo que desligado.
  E **suspensão nunca bloqueia a exportação do prontuário** — guarda de 20 anos do CFO; reter
  prontuário como alavanca de cobrança é indefensável. A garantia é estrutural: nenhuma política
  restritiva alcança `SELECT`.
- **Criar clínica NÃO é operação da aplicação.** `facilident_app` não cria tenant — uma rota HTTP
  faria o processo que serve prontuário poder criar clínicas e mexer no faturamento, e qualquer
  falha de lógica ou SSRF vira isso. Cliente novo nasce de `npm run clinica:criar`, com a
  credencial do dono. O custo assumido: **não existe tela de onboarding**. Para centenas de
  clínicas o caminho é um serviço separado, não afrouxar este.
- **`assinatura` não vai na exportação por clínica.** O `plano_id` aponta para
  `plano_assinatura`, catálogo do fornecedor com uuid gerado **por instalação** — a linha não é
  portável, e a restauração falha com violação de FK. As alternativas (traduzir para o código do
  plano, ou tornar os ids determinísticos) estão escritas no topo de
  `docker/exportar-clinica.sh`. O contrato é o registro do fornecedor, a clínica já o tem nas
  faturas, e nada de LGPD obriga a devolvê-lo.
- **O autoatendimento nasce DESLIGADO, e o padrão está em dois lugares de propósito.**
  `regra_autoatendimento.ativo` é `false` por default: uma clínica que atualiza o sistema não pode
  descobrir que a agenda dela abriu para a internet. Os limites (24 h de antecedência mínima, 60
  dias de máxima, 2 futuros por paciente) vivem em `REGRA_PADRAO` (`lib/domain/autoatendimento.ts`)
  **e** nos DEFAULTs da tabela — repetição consciente, porque o banco precisa do default para a
  linha nascer válida e o domínio precisa do valor para ser testável sem banco. Um caso em
  `docker/verificar-invariantes.sql` compara os dois e falha se divergirem.
- **O paciente PODE desmarcar o que ele mesmo marcou — e isso não contradiz a decisão de "não vou
  poder ir".** Aquela decisão protege horário que a **clínica** organizou: um toque errado não pode
  custá-lo, e a clínica precisa saber para remarcar. Para um horário que o paciente criou sozinho
  minutos antes, nenhum dos dois motivos vale, e não deixar desmarcar produz o oposto do objetivo
  (ele liga para a recepção, e o horário fica preso por um atendimento que não vai acontecer). A
  permissão é estreita e cada condição responde a um motivo da decisão original: só `origem =
  'portal'`, só enquanto `status = 'agendado'`, e só fora da antecedência mínima. Ver
  `podeDesmarcarSozinho`.
- **Anamnese respondida pelo paciente NÃO é anamnese colhida pelo dentista.** `anamnese.origem`
  distingue, e `conferida_em`/`conferida_por_id` registram quando um profissional validou. Não é
  metadado: uma alergia autodeclarada que ninguém confirmou não pode virar decisão de anestésico.
  Três CHECKs na `drizzle/0031` garantem que a do portal nasça sem `profissional_id` (o paciente
  não é profissional), que conferência tenha quem **e** quando, e que a da clínica não receba
  conferência — quem a colheu é quem conferiria.
- **⚖️ A assinatura do portal é eletrônica SIMPLES, e o nível fica gravado na linha.**
  `consentimento.nivel_assinatura` é `eletronica_simples` (hash do texto + IP + `user_agent` +
  instante) ou `presencial` (papel). É o que a MP 2.200-2/2001 art. 10 §2º admite entre as partes;
  **não** é ICP-Brasil, não é avançada, não é qualificada, e não prova identidade além do controle
  da conta do portal — que é e-mail e senha, sem segundo fator, por decisão. O nível está na linha
  porque a pergunta aparece anos depois, num litígio, sobre uma linha específica. O enum **não tem**
  `qualificada`, e há invariante que falha se alguém acrescentar. **Menor não assina o próprio
  termo**: `quemAssina` exige a sessão do responsável legal, e a linha guarda os dois lados.
- **O NIC do periograma é DERIVADO, nunca digitado.** `nivel_insercao_mm` é coluna
  `GENERATED ALWAYS AS (profundidade + recessao) STORED` — o Postgres recusa a escrita, não é
  trigger nem disciplina. Mesmo princípio de "glosa é calculada, nunca digitada", e aqui pesa
  mais: **o NIC é o número que diz se a doença progrediu**, porque a bolsa pode encolher só
  porque a gengiva retraiu (PS 6→3 com recessão 0→3 é NIC constante em 6). `certificado` do
  ciclo de esterilização é gerada pelo mesmo motivo: biológico pendente não certifica.
- **Comparação entre periogramas é EMPARELHADA.** Só entram os sítios presentes nos dois
  exames. Dente extraído no intervalo leva os sítios dele — que são os piores, porque foi por
  isso que ele saiu — e a comparação ingênua mostra melhora espetacular exatamente no paciente
  que perdeu o dente. Medido: 5,0 → 3,0 mm na leitura ingênua contra 3,7 → 3,0 mm na
  emparelhada, com a perda dentária nomeada à parte. A ingênua fica exposta em `completo` de
  propósito, para a tela dizer o tamanho de cada exame — nunca para comparar.
- **Furca só em dente multirradicular**, e a regra mora em `dente_multirradicular()`, usada pelo
  CHECK. ⚠️ O primeiro pré-molar superior (14, 24) tem duas raízes na maioria das pessoas e está
  **fora**, por escolha conservadora: deixar de fora perde informação e o dentista percebe;
  deixar dentro criaria informação falsa e ninguém perceberia. **Entre perder e inventar, este
  projeto perde.** Precisa de validação — ver `GLOSSARIO.md`.
- **Ordem de laboratório NÃO gera despesa automática.** O laboratório fatura por mês, uma nota
  cobrindo várias peças; uma despesa por ordem produziria N lançamentos que não casam com a nota
  e a conciliação não fecharia — mesmo raciocínio que fez a conciliação Pix casar por
  `end_to_end_id`. `custo` é o valor combinado; a despesa é a nota, ligada por `despesa_id`
  quando a clínica quiser.
- **Propostas alternativas NÃO afrouxaram `plano_um_ativo_por_paciente`.** Elas vivem em
  `rascunho`, quantas forem, agrupadas por `grupo_proposta`; no máximo uma vira `ativo`. E
  **qual o paciente escolheu não é duplicado** — já está no orçamento, que é o documento
  congelado com `status` em enviado/aprovado/recusado.
- **O registro de esterilização NÃO é "conformidade com a RDC 15".** Cobre equipamento,
  responsável, data, parâmetros e os dois indicadores. Não cobre qualificação térmica,
  periodicidade do teste biológico, POP escrito, limpeza prévia, nem **rastreabilidade do pacote
  até o paciente** — `conteudo` é texto livre, e texto livre não é rastreabilidade: se um
  biológico voltar positivo, o sistema diz o ciclo e o dia, não a lista de pacientes. Afirmar
  conformidade seria o mesmo erro de dizer que o XML TISS está aceito porque é válido no XSD.
- **CID no atestado só com autorização expressa do paciente.** O atestado costuma
  ir para o RH da empresa; o diagnóstico é dado de saúde. O padrão é não imprimir,
  e a tela avisa que não imprimiu. Ver `lib/domain/impressos.ts`.

## Estrutura

```
lib/
  db/
    schema/        tabelas Drizzle, um arquivo por área do domínio
    seed/          dados de referência (52 dentes, catálogo TUSS, materiais, perfis)
    index.ts       cliente de conexão (preguiçoso — ver seção do build)
  domain/          regras puras + .test.ts ao lado
  <área>/          consultas + núcleo com Ator + acoes.ts fino + demonstrar.ts
                   (mensageria, documentos, relatorios, portal, tiss, estoque)
dados/             tabelas oficiais baixadas (Tabela 22 da ANS) + procedência
drizzle/           migrations geradas + SQL manual de constraints e triggers
app/               (staff)/ e (portal)/ separados
```

## Convenções

- **Nomes de tabela e coluna em `snake_case` português**; identificadores TS em `camelCase`.
  O domínio é falado em português pela clínica — traduzir gera ambiguidade.
- **Dinheiro**: `numeric(10,2)` no banco, `string` no TS. Nunca `float` para dinheiro.
  Somas e rateios passam por `lib/domain/dinheiro.ts` (aritmética em centavos inteiros).
- **Datas**: `timestamptz` sempre. `date` só para o que é genuinamente um dia civil
  (nascimento, vencimento de parcela, validade de orçamento).
- **Dentes**: notação FDI (11–48 permanentes, 51–85 decíduos). A `smallint` é a chave.
  Nunca renumerar para 1–32.
- Toda tabela com dado de paciente tem `criado_em`; as mutáveis também têm `atualizado_em`.
- Zod valida na borda; o tipo do Drizzle é a fonte da verdade do formato.

## Comandos

```bash
npm run db:generate   # gera migration a partir do schema
npm run db:migrate    # aplica (precisa de DATABASE_URL)
npm run db:seed       # popula dados de referência
npm test              # vitest
npm run typecheck     # tsc --noEmit
npm run build         # next build (força NODE_ENV=production — ver abaixo)
```

**A bateria inteira num comando:** `./docker/verificar-tudo.sh` (ou `--rapido`, ou
`--listar`). Ele passa a credencial do dono onde é preciso, não para no primeiro erro, e
**distingue pulado de passou** — com `--rapido` o veredito é "nada falhou, mas 3 de 17
rodaram", nunca "tudo verde".

**Tudo que toca o banco fora do navegador precisa da credencial do DONO**, e o
container do `app` não a tem de propósito:

```bash
DONO="postgres://facilident:facilident_dev@db:5432/facilident"
docker compose exec -T -e DATABASE_URL=$DONO app npm run <script>
```

Antes do primeiro uso de um banco: `./docker/credencial-app.sh` dá `LOGIN` e senha a
`facilident_app` (a `0023` cria a role **sem** as duas — senha em SQL versionado é senha
pública, e fica no histórico do Git depois de qualquer troca). Sem esse passo o app sobe e
não conecta.

Demonstrações que rodam contra o Postgres e conferem número, não fluxo:
`whatsapp:demo`, `documentos:demo`, `relatorios:demo`, `convenio:demo`, `estoque:demo`.

Verificações por HTTP com sessão real: `portal:seguranca` (29 casos de IDOR),
`tenant:seguranca` (isolamento entre clínicas, com a contraprova que desliga a política),
`estoque:telas`, `admin:verificar`, `clinica:verificar` (onboarding).

Invariantes contra o Postgres: `db:verificar` (224 casos), `rls:verificar` (25),
e `docker/verificar-assinatura.sql` (21).

Operação por clínica: `clinica:criar`, `clinica:situacao`, `clinica:exportar`,
`clinica:restaurar`. A exportação **enumera os anexos a partir das linhas de `documento`**,
nunca varrendo prefixo de diretório — chave anterior à Fase 17 não tem prefixo, porque
`drizzle/0011` congela `storage_key`.

**A lista de tabelas da exportação é conferida contra o catálogo**: tabela nova com
`clinica_id` **aborta** a exportação pedindo classificação, em vez de ser omitida em
silêncio. Já disparou de verdade, na `assinatura`.

**Fixture de dentista precisa de transação.** A trava deferida de `drizzle/0021` cobra no commit
que usuário de perfil `dentista` ativo tenha linha em `profissional`. Dois inserts soltos comitam
separado e o primeiro já viola — todo script de demonstração cria os dois dentro de
`db.transaction`, como `criarUsuarioComAtor` faz.

## Backup

```bash
./docker/backup.sh                      # banco + anexos num .tar.gz datado, com manifesto
./docker/restaurar.sh --testar ARQ      # restaura num banco temporário e confere
./docker/restaurar.sh --para-valer ARQ  # sobrescreve produção; exige digitar RESTAURAR
```

O `--testar` é o comando semanal, e existe porque **a única coisa que prova um backup é
restaurá-lo**. Ele confere as contagens contra o manifesto, o número de triggers e EXCLUDE
constraints, e tenta um `UPDATE` numa evolução restaurada — um dump que perdesse a trigger de
append-only devolveria um prontuário editável, e nada além deste teste diria isso.

**O que os scripts NÃO fazem:** cifrar e mandar para fora da máquina. Backup de prontuário é dado
de saúde; em produção ele tem de sair cifrado e ir para outro lugar físico. Backup no mesmo disco
do banco protege contra `DROP TABLE`, não contra o disco morrer nem contra ransomware.
`backups/` está no `.gitignore` — dado de paciente nunca vai para o repositório.

## Armadilhas do domínio (já custaram retrabalho em outros sistemas)

- **Nunca use `session_replication_role = 'replica'` para furar uma trigger.** Ele desliga
  **também as triggers internas de FK**, e o efeito não aparece na hora: a limpeza de um
  `demonstrar.ts` apagou uma `execucao` e deixou 5 linhas órfãs em `movimento_estoque`, que
  meses depois **derrubaram uma migration** (não se cria FK composto sobre dado inconsistente) e
  deixaram 5 lotes com saldo divergente da soma dos movimentos. Use
  `ALTER TABLE <tabela> DISABLE TRIGGER USER`, que preserva as travas de FK, e **religue
  conferindo** — `DISABLE TRIGGER` é DDL, então comitar com a trigger desligada a deixa
  desligada para sempre. `lib/demo/triggers.ts` faz isso certo: a pergunta é "está religado?",
  não "eu religuei?".
- **Ferramenta de conferência não escreve.** O probe de `docker/restaurar.sh` provava o
  append-only tentando alterar uma evolução restaurada — e testava a regra errada (a trigger só
  recusa `UPDATE` em evolução **assinada**; rascunho é editável de propósito), então num banco
  cujo dado restaurado fosse rascunho ele **reprovava um backup bom**. Pior: o `begin/exception`
  só desfaz quando há exceção, e no caminho em que a trigger permite o `UPDATE` **comitava** —
  script de verificação de backup adulterando prontuário, com `--para-valer` rodando contra
  produção. Hoje ele testa a imutabilidade de `paciente_id` (recusada em qualquer evolução),
  **confere a mensagem** do erro e roda em `begin; … rollback;`. Há invariante cobrindo a regra
  de que ele depende.
- **Face válida depende do tipo de dente.** Incisivo e canino têm *incisal*; pré-molar e molar
  têm *oclusal*. Nunca os dois. Superior tem *palatina*, inferior tem *lingual*.
- **Dentição mista existe.** Criança de 8 anos tem decíduos e permanentes ao mesmo tempo.
  Odontograma precisa mostrar as duas arcadas simultaneamente.
- **Quatro entidades distintas**, frequentemente confundidas em uma só:
  `plano_tratamento` (o que se pretende fazer) → `item_plano` (uma linha: procedimento + dente
  + faces) → `execucao` (foi feito, por quem, quando) → `cobranca`/`parcela` (o dinheiro).
  Nunca colapse.
- **Orçamento é um documento congelado**, não uma view do plano. Se o plano mudar, o orçamento
  já enviado não muda — gera-se outro.
- **Menor de idade** tem `responsavel_legal_id`. Consentimento e assinatura são do responsável.
- **Estoque sai por FEFO, não FIFO.** Vence primeiro, sai primeiro — mesmo que tenha chegado
  depois. A compra de reposição costuma vir com validade mais curta que a caixa que já está na
  prateleira, e consumir por ordem de chegada deixa o lote curto vencer com saldo.
- **Validade de lote é dia civil no fuso da clínica.** Lote que vence 31/07 serve até o fim do
  dia 31/07 em São Paulo — que já é 01/08 em UTC. Há `hoje_na_clinica()` no banco para isso.
- **Quantidade de material não é sempre inteira** (ml, g). `lib/domain/quantidade.ts` faz a
  aritmética em milésimos inteiros, pelo mesmo motivo de `dinheiro.ts` usar centavos.
- **A unidade do material é a de CONSUMO, não a de compra.** Lançar "2" ao receber 2 caixas de
  100 luvas é entrada válida para o banco e alerta de mínimo que nunca dispara. A conversão é
  `unidades_por_embalagem`.
