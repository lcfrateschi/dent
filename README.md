# Facilident

**Software de gestão odontológica.** Facilident simplifica a gestão odontológica
para clínicas e consultórios crescerem com mais eficiência, organização e cuidado
ao paciente — gestão odontológica *simples, inteligente e humana*.

- **`ROTEIRO-DE-TESTE.md`** — passo a passo para testar tudo, com credenciais
- **`ROADMAP.md`** — as fases e a ordem
- **`GLOSSARIO.md`** — a linguagem do domínio
- **`CLAUDE.md`** — decisões arquiteturais e armadilhas

## Um comando

```bash
docker compose up
```

Isso é tudo. O compose, em ordem:

1. sobe o **Postgres 17** e espera ele ficar saudável;
2. roda o serviço `migrate`, que aplica as migrations e semeia os dados de
   referência (52 dentes FDI, 49 procedimentos, cadeiras);
3. só então sobe o **app**, com hot reload.

Nenhum `.env` é necessário para desenvolvimento — os defaults estão no
`docker-compose.yml`.

Para um ambiente com dados realistas e credenciais prontas (clínica configurada,
quatro perfis, três pacientes, agenda, plano, cobrança vencida, estoque com lote
vencendo):

```bash
docker compose exec app npm run demo:preparar   # imprime as credenciais
docker compose exec app npm run demo:codigo     # código MFA, sem celular à mão
docker compose exec app npm run demo:limpar     # remove só o que ele criou
```

O passo a passo de teste está em **`ROTEIRO-DE-TESTE.md`**.

> **Vindo de uma cópia anterior a "Facilident"?** O projeto do compose mudou de
> nome (`dent` → `facilident`), e com ele os volumes: os antigos ficam órfãos, com
> o banco de desenvolvimento dentro. Limpe com `docker compose -p dent down -v`
> antes de subir. Se aquele banco tinha algo que importa, faça `./docker/backup.sh`
> **antes** de renomear e restaure depois com `--para-valer`.

| Serviço | Endereço |
|---|---|
| App | http://localhost:3000 |
| Odontograma | http://localhost:3000/design/odontograma |
| Postgres | `127.0.0.1:5433` (usuário `facilident`, senha `facilident_dev`) |

O Postgres é publicado **só no loopback** — banco de prontuário não escuta na rede.

### Primeiro acesso

O seed cria um administrador **só fora de produção**, e imprime as credenciais
no log do `migrate`:

```
e-mail: admin@local
senha:  trocar-esta-senha-agora
```

Deixe o campo de código **em branco** no primeiro login. Em seguida o sistema
obriga a configurar a verificação em duas etapas — o middleware não deixa sair
dessa tela antes disso. Escaneie o QR com Google Authenticator, Authy,
1Password ou Microsoft Authenticator.

Em **produção** nenhum usuário é semeado, e o app se recusa a subir com o
`AUTH_SECRET` de desenvolvimento. Gere um próprio:

```bash
openssl rand -base64 48
```

### Comandos

```bash
npm run docker:up        # sobe tudo
npm run docker:logs      # segue o log do app
npm run docker:down      # para
npm run docker:reset     # apaga o volume e recria o banco do zero
npm run db:verificar     # prova as invariantes do banco (200 casos)
```

Variante de produção (imagem enxuta, `output: standalone`, roda sem root):

```bash
docker compose --profile prod up app-prod
```

## Sem Docker

Precisa de **Node 20+** (ver `.nvmrc`) e um Postgres com a extensão
`btree_gist` — usada nas EXCLUDE constraints da agenda.

```bash
npm install
cp .env.example .env     # preencha DATABASE_URL
npm run db:migrate
npm run db:seed
npm run dev
```

## Testes

```bash
npm test               # 821 testes (Vitest, sem banco)
npm run typecheck
npm run db:verificar   # 147 invariantes no banco (precisa do compose de pé)
```

Os testes de domínio não tocam o banco de propósito: são as regras puras
(anatomia das faces, dinheiro em centavos, datas civis, máquinas de estado).
As invariantes que vivem no Postgres — prontuário append-only, conflito de
agenda, soma das parcelas — têm verificação própria em
`docker/verificar-invariantes.sql`.

## WhatsApp (Fase 9)

O sistema manda lembrete de consulta e entende a resposta do paciente. **Funciona
sem conta na Meta**: o provedor padrão é um simulador que reproduz as recusas
reais da API (número sem WhatsApp, template sem parâmetro, limite de envio), e a
tela avisa em destaque que nada está saindo de verdade.

```bash
# fluxo inteiro contra o Postgres: enfileira → despacha → paciente responde →
# webhook assinado → agenda confirmada e depois cancelada
docker compose exec app npm run whatsapp:demo

# uma passada do processo (o que o cron chama a cada 10 min)
docker compose exec app npm run whatsapp:despachar
```

Para enviar de verdade, além de `WHATSAPP_PROVEDOR=meta` e das credenciais
(ver `.env.example`), a conta precisa de um **template aprovado** — fora da
janela de 24 horas desde a última mensagem do paciente, a Meta recusa texto
livre. O template usado é `lembrete_consulta_pt_br`, com quatro variáveis nesta
ordem: primeiro nome, clínica, data e hora em português, profissional.

O webhook fica em `POST /api/whatsapp/webhook` e é a única rota pública que
altera a agenda. Ela exige o HMAC `X-Hub-Signature-256`; sem `WHATSAPP_APP_SECRET`
configurado, responde 403 a tudo — nunca "aceita porque não há segredo".

Três decisões que valem saber antes de operar:

- **Nunca envia duas vezes.** A chave de idempotência inclui o horário do
  atendimento: reprocessar não gera nada, remarcar gera um lembrete novo.
- **Mensagem travada não é reenviada sozinha.** Se o processo morreu depois de
  chamar a Meta, ninguém sabe se ela entregou. A linha fica visível na tela e a
  decisão é humana — perder um lembrete é barato, mandar dois não.
- **Dúvida não vira ação.** "Não sei se consigo" não cancela nada; vai para a
  fila da recepção. O interpretador é conservador de propósito.

## Imagens e documentos (Fase 10)

Radiografia, foto clínica, exame, atestado, receita e o PDF do orçamento. O
armazenamento padrão é **disco** (volume `anexos` no compose) e há provedor de
S3/R2 pronto para bucket privado — sem queda automática de um para o outro.

```bash
# fluxo inteiro contra o Postgres e o disco: anexa, baixa pela rota, confere
# integridade, prova que falha no banco não deixa arquivo órfão
docker compose exec app npm run documentos:demo
```

Quatro coisas que valem saber:

- **Não existe URL de bucket em lugar nenhum.** Todo download passa por
  `/api/documentos/<id>`, que exige sessão, confere o perfil e registra a
  exportação na auditoria. URL assinada seria encaminhável — quem recebesse o
  link veria a radiografia sem sessão e sem aparecer na trilha.
- **O tipo do arquivo vem dos bytes.** `.jpg` com conteúdo de executável é
  recusado; HEIC de iPhone é aceito com aviso de que não abre no navegador; DICOM
  de tomógrafo é reconhecido pela marca no deslocamento 128.
- **Integridade conferida em cada leitura.** O SHA-256 do que veio do storage é
  comparado com o do banco, que é imutável por trigger. Divergir bloqueia o
  download em vez de entregar arquivo suspeito.
- **Atestado e receita são PDF gerado no servidor**, arquivado no prontuário com
  hash. O papel que o paciente leva e o que a clínica guarda são o mesmo arquivo.
  A geração é ato privativo do CD (`prontuario: assinar`), e o CID **não** é
  impresso sem autorização expressa do paciente.

## Painel e relatórios (Fase 11)

```bash
# confere cada indicador contra valores calculados à mão
docker compose exec app npm run relatorios:demo
```

O painel mostra **caixa e produção em blocos separados, nunca somados**. Essa é a
decisão que organiza a fase: o que foi executado e o que entrou no caixa andam em
ritmos diferentes — um tratamento feito em julho pode ser recebido em outubro, e a
comissão da clínica é sobre o recebido. Um "faturamento" que junta os dois
responde a pergunta de ninguém.

Outras três que valem saber:

- **Falta e cancelamento têm taxas separadas.** Quem avisou liberou o horário;
  quem não apareceu queimou a cadeira. Cancelado não entra na base da taxa de
  falta — junto, um mês de cancelamentos avisados pareceria um mês de faltas.
- **Ocupação tem duas medidas.** Reservada e realizada: 90% reservada com 20% de
  falta é problema de confirmação, 65% reservada sem falta é problema de captação,
  e a ação para cada um é oposta. O divisor são os minutos que a clínica tinha
  disponíveis (horário de funcionamento × dias × profissionais ativos).
- **Taxa sem base é “—”, não 0%.** Mês sem atendimento não tem falta de 0%: não
  tem taxa. E variação sobre base zero é “do zero”, nunca “+100%” nem “+∞%”.

A tela de **Auditoria** (só admin) é onde a trilha da Fase 1 finalmente pode ser
lida: quem acessou o prontuário de quem, quando, de qual IP. A própria consulta
entra na trilha — sem isso, o único acesso não registrado seria o acesso à
auditoria.

Exportação em CSV registra um evento `exportacao` próprio: quem exporta leva o
dado embora, e a LGPD separa isso de leitura com razão.

## Portal do paciente (Fase 12)

```bash
# revisão de segurança adversarial — 29 tentativas de ataque, todas bloqueadas
docker compose exec app npm run portal:seguranca
```

O paciente entra em `/meu` e vê **só o que é dele**: consultas (com botão de
confirmar), orçamentos (com aprovar/recusar), parcelas, documentos e os
consentimentos que deu — podendo revogar sozinho, como a LGPD exige.

A defesa contra IDOR é **estrutural, não disciplinar**: toda função de
`lib/portal/consultas.ts` recebe `SessaoPortal` e filtra por `sessao.pacienteId`, e
**nenhuma aceita `pacienteId` como parâmetro**. Não existe assinatura de função em
que um id vindo da URL possa entrar. A única tela que recebe id (um orçamento
específico) confere o dono na mesma consulta.

Os dois realms não se cruzam:

| | Staff | Portal |
|---|---|---|
| Tabela | `usuario` | `paciente_conta` |
| Cookie | `authjs.session-token` | `dent_portal` |
| Mecanismo | Auth.js + JWT | token opaco no banco |
| Tipo no código | `Ator` | `SessaoPortal` (incompatível) |
| Segundo fator | obrigatório | não — compensado por bloqueio e sessão curta |

Não há segredo compartilhado entre eles, e `drizzle/0013` **falha o deploy** se
alguém criar uma FK entre o realm do paciente e `usuario`.

Decisões que valem saber:

- **Sessão de 12 horas, token no banco, revogável.** JWT vale até expirar e não
  volta atrás; aqui a clínica corta o acesso e ele cai na requisição seguinte.
- **Primeiro acesso por convite de uso único**, não senha temporária: senha
  temporária circula por WhatsApp e continua válida. O convite morre ao ser usado
  (trigger) e expira em 7 dias. O código aparece **uma vez** na ficha — depois só o
  hash fica no banco.
- **Sem MFA para o paciente**, por decisão: exigir autenticador de quem entra três
  vezes por ano produz abandono, não segurança. O que compensa é o bloqueio
  crescente (1, 5, 15, 60 min), a sessão curta e a revogação.
- **Bloqueio não é permanente.** Trancar a conta para sempre depois de N erros
  transformaria o ataque em negação de serviço contra o paciente.
- **O portal não mostra evolução clínica nem radiografia.** A evolução é escrita
  em linguagem técnica para outro profissional; imagem sem laudo gera interpretação
  errada. Histórico de atendimentos sim; a íntegra do prontuário é pedida na
  clínica, com exportação auditada.
- **"Não vou poder ir" não cancela**: registra o aviso para a recepção remarcar. Um
  toque errado no celular não pode custar o horário do paciente.

## Operação: backup, restauração e despacho

```bash
./docker/backup.sh                          # banco + anexos, num .tar.gz datado
./docker/restaurar.sh --testar backups/…    # prova que o backup serve (banco temporário)
docker compose --profile prod up despachante  # lembretes de WhatsApp a cada 10 min
```

**Os dois no mesmo arquivo, sempre.** O banco guarda o caminho da radiografia, não a
imagem: um dump sem o volume `anexos` restaura um prontuário que aponta para
arquivos inexistentes, e isso só aparece quando alguém tenta abrir a
radiografia — meses depois.

**`--testar` é o comando semanal.** Restaura num banco ao lado, confere as
contagens contra o manifesto, conta triggers e EXCLUDE constraints e tenta um
`UPDATE` numa evolução restaurada. Um dump que perdesse a trigger de append-only
devolveria um prontuário editável, e só este teste diria isso. Backup nunca
testado não é backup — é esperança com nome de arquivo.

**O que falta, e é da clínica:** cifrar o arquivo e mandá-lo para fora da
máquina. Backup no mesmo disco do banco protege contra `DROP TABLE`, não contra o
disco morrer.

## Cadastros administrativos

A clínica cadastra o que precisa **pela tela**, sem SQL e sem depender de quem
escreveu o código:

| Tela | O que resolve |
|---|---|
| `/usuarios` | Quem entra, com que perfil, CRO e comissão. Senha temporária, reset de MFA, desativação |
| `/configuracoes` | Identificação (sai nos impressos e no XML), horário de funcionamento, cadeiras |
| `/convenios/cadastro` | Operadoras, prazo de repasse e **tabela negociada com vigência** |
| Ficha do paciente | Carteirinha de convênio, com data de adesão (é a base da carência) |
| `/estoque/fichas` | Cadastro de material e ficha técnica de cada procedimento |

```bash
# núcleo + telas por HTTP, com sessão real (44 conferências)
docker compose exec app npm run admin:verificar
```

### O primeiro acesso de um funcionário

O admin cadastra e o sistema **gera** a senha — não deixa o admin escolher, senão
"Clinica@2026" acaba servindo para todo mundo. A senha aparece uma vez só (o banco
guarda o hash) e nasce marcada como temporária.

Aí a pessoa passa por duas portas, nesta ordem: **configura o autenticador** e
**troca a senha**. A ordem é deliberada — trocar a senha já protegido por segundo
fator é melhor do que trocá-la tendo apenas a credencial que circulou por
telefone. A troca exige a senha atual: sem isso, uma sessão esquecida no balcão
toma a conta.

### As travas que impedem a clínica de se trancar fora

- **Nunca zero administradores ativos.** Desativar ou rebaixar o último admin
  deixaria a saída só pelo banco. Ninguém desativa a si mesmo, pelo mesmo motivo:
  quem se desativa perde a sessão no clique seguinte.
- **Dentista sem CRO é recusado.** Ele entraria, veria o prontuário e não
  conseguiria assinar nada — falha que aparece na frente do paciente.
- **Cadeira com agendamento futuro não desativa.** O horário existe e o paciente
  foi avisado; remarcar é decisão da recepção.
- **Ninguém é apagado.** Usuário assina evolução e aparece na trilha de auditoria,
  com guarda de 20 anos. Desativar impede o login e preserva o histórico.

### Tabela negociada: reajuste não é edição

O valor faturado é o da **data da execução**. Editar uma linha existente
reescreveria o que já foi apresentado à operadora, e a conciliação do repasse
deixaria de fechar sem que nada indicasse por quê.

Então reajuste é vigência nova, e a anterior **fecha no dia anterior** —
automaticamente, porque pedir as duas datas à pessoa produz um dia sem preço ou,
pior, dois preços válidos no mesmo dia (aí o valor a faturar depende da ordem da
consulta). Uma EXCLUDE constraint garante isso no banco, não na tela. Preço já
usado em guia não se apaga: é o histórico do que foi apresentado.

### O que a tela de ajustes mostra primeiro

O que **falta**, não o que está preenchido — sem CNPJ o orçamento sai sem
cabeçalho fiscal, sem CRO o atestado não tem valor legal, sem dentista ninguém
assina evolução. Dois campos aparecem só para leitura: a base da comissão e o
fuso horário. Mudar qualquer um reinterpreta dado já gravado (a apuração de meses
fechados; todo o histórico de agenda e validade de lote), e isso é conversa com a
clínica e migration — não um clique.

## Estoque (Fase 14)

```bash
# o ciclo inteiro contra o Postgres, com os números conferidos (11 passos)
docker compose exec app npm run estoque:demo

# as telas por HTTP, com sessão de verdade (14 conferências)
docker compose exec app npm run estoque:telas
```

O seed traz **40 materiais e a ficha técnica de 17 procedimentos**, e **nenhum
saldo**: estoque inicial é contagem física, e saldo semeado faria o primeiro
alerta de mínimo vir de um número inventado.

### As três coisas que a intuição erra

**FEFO não é FIFO.** Sai primeiro o que **vence** primeiro, não o que chegou
primeiro. Parecem a mesma coisa até a compra de reposição chegar com validade
mais curta que a caixa da prateleira — o fornecedor escoando estoque —, e aí
consumir por ordem de chegada deixa o lote curto vencer com saldo. Perda que
ninguém vê acontecer.

**Validade é dia civil, no fuso da clínica.** Um lote que vence 31/07 ainda serve
às 22h de 31/07 em São Paulo, que já é 01/08 em UTC. Comparar instantes
descartaria material bom.

**Quantidade não é sempre inteira.** Hipoclorito sai em mililitros, resina em
gramas. `0.1 + 0.2` em float dá `0.30000000000000004` — a mesma classe de bug do
centavo. Aritmética em milésimos inteiros (`lib/domain/quantidade.ts`).

### O que o banco garante, não o código

`drizzle/0019_estoque_travas.sql`, provado por 31 casos do `db:verificar`:

- **saldo é derivado dos movimentos** — `UPDATE lote_material SET saldo = 999` é recusado
- **saldo nunca negativo** — não se consome o que não existe, com lock por lote
  para duas baixas simultâneas não furarem a verificação
- **o livro é append-only** — sem UPDATE, sem DELETE. Corrigir é lançar ajuste em
  sentido contrário, com motivo, que é o que um inventário de verdade faz
- **lote vencido não é consumido** — só descartado ou devolvido
- **material controlado não sai sem responsável e motivo** (Portaria 344/98)
- **implante e enxerto não entram sem o lote do fabricante** — sem ele, o
  recolhimento não tem como responder em quem o material foi usado

### A baixa não é automática, de propósito

A ficha técnica **propõe** o consumo quando a execução é registrada, com o lote
FEFO já escolhido, e uma pessoa confirma. Se o sistema baixasse sozinho, a
rastreabilidade afirmaria um lote que talvez não tenha sido o usado — e
rastreabilidade que mente é pior que nenhuma.

## Convênios e TISS (Fase 13)

```bash
# o ciclo inteiro com os valores conferidos à mão (36 verificações)
docker compose exec app npm run convenio:demo

# quando a clínica baixar a Tabela 22 da ANS
docker compose exec app npm run tuss:importar -- arquivo.csv
```

### ⚠️ O que está pronto e o que não está

**Pronto e verificado** — o controle interno do faturamento: tabela negociada com
vigência, elegibilidade (carência e carteirinha), coparticipação, montagem de guia,
envio, retorno com glosa, recurso e **conciliação de repasse item a item**.

**Não verificado** — a exportação em **XML TISS**. Ela existe e é XML bem formado
(validado por parser), mas **nunca foi conferida contra o XSD oficial da ANS nem
enviada a uma operadora real**. Não conte com ela para faturar.

**Código TUSS — 36 dos 49 procedimentos já saem do seed com código oficial.** A
faixa odontológica da Tabela 22 da ANS (370 códigos, prefixos 81 a 87) está em
`dados/tuss22-odontologia.csv`, baixada da API oficial e não editada.

Os **13 que faltam continuam em branco de propósito**, e não por esquecimento: em 5
casos o procedimento simplesmente não tem código na Tabela 22 (consulta de retorno,
frenectomia, orientação de higiene…), e nos outros 8 existem vários candidatos cujo
valor recebido é diferente — "coroa provisória" tem código com pino e sem pino.
`dados/README.md` lista cada um com os candidatos oficiais e o motivo. Preencher por
dedução seria glosa em nome da clínica.

O caminho que funciona hoje é a **folha de conferência** (`/api/convenios/guias/<id>/conferencia`):
a recepção lê dela e digita no portal da operadora — que é como a maioria das
clínicas pequenas fatura de verdade.

### Decisões que valem saber

- **O preço é o da DATA DA EXECUÇÃO**, não o de hoje. Tabela negociada muda por
  reajuste; faturar em março um procedimento de janeiro com o preço de março é
  glosa garantida.
- **Coparticipação e repasse somam exato**, em centavos inteiros, e a sobra do
  arredondamento vai para o **paciente**. Pedir um centavo a mais à operadora é
  motivo de glosa do item inteiro; um centavo a mais do paciente ninguém discute.
- **`glosada_parcial` é estado próprio**, não variação de "paga". Guia paga em
  parte tem dinheiro a recorrer e não pode sair da fila de cobrança.
- **A glosa é calculada**, não digitada: é `apresentado − pago`. Dois números
  digitados podem discordar, e conciliação que não fecha é o que consome tempo.
- **Conciliação item a item, nunca pelo total.** Um repasse que fecha no total pode
  conter dois erros que se cancelam, e só a conferência por item mostra o que
  recorrer.
- **Recorrer de tudo é errado.** `orientacaoDeGlosa` diz onde vale insistir: erro
  de preenchimento volta; prazo perdido não.

## Onde está o quê

```
app/
  (staff)/         realm da equipe: sessão e consultas próprias
  entrar/          login com e-mail + senha + código TOTP
  configurar-mfa/  obrigatório no primeiro acesso
  design/          playground do design system (fonte dos previews)
  api/auth/        rotas do Auth.js
  api/whatsapp/    webhook da Meta — pública, autenticada por HMAC
  api/documentos/  download autorizado e auditado de anexo do prontuário
  api/relatorios/  exportação CSV, com a exportação registrada na trilha
  api/meu/         rotas do PORTAL — autorizam por sessão de paciente
  (portal)/        realm do paciente: /meu/... , nada compartilhado com o staff
middleware.ts      guarda de rotas + trava de MFA
components/
  agenda/          grade semanal e estilos de status
  odontograma/     geometria pura + SVG dos 52 dentes
  paciente/        faixa de alertas clínicos
  ui/              componentes base e mapa fechado de ícones (Lucide)
lib/
  auth/            scrypt, TOTP, config do Auth.js (base Edge + completa Node)
  authz/           RBAC — matriz única de permissões, e guardas de sessão
  auditoria/       trilha LGPD; leitura também é evento
  agenda/          grade, consultas e ações
  anamnese/        formulário versionado e derivação de alertas clínicos
  orcamento/       plano de tratamento e documento congelado
  prontuario/      evolução assinada, retificação e linha do tempo
  financeiro/      cobrança, parcelas, pagamento, conciliação e comissão
  mensageria/      fila do WhatsApp, provedores, webhook e resposta do paciente
  armazenamento/   provedor em disco e S3/R2, com SigV4 escrito à mão
  documentos/      anexo, emissão de atestado/receita e escritor de PDF
  relatorios/      agregações do painel e leitura da trilha de auditoria
  portal/          sessão, consultas e ações do paciente — sempre escopadas
  tiss/            guia, glosa, recurso, repasse e exportação para a operadora
  odontograma/     tradução item_plano/execucao ↔ estado das faces
  pacientes/       schema Zod, consultas e server actions
  db/schema/       29 tabelas Drizzle, uma área do domínio por arquivo
  db/seed/         dados de referência + primeiro admin
  domain/          regras puras, com .test.ts ao lado
drizzle/
  0000_inicial.sql      schema gerado
  0001_constraints.sql  triggers e EXCLUDE — as garantias legais e financeiras
  0004_orcamento_congelado.sql  documento comercial imutável depois de enviado
  0009_mensageria_travas.sql    idempotência do envio e append-only das respostas
  0011_documento_travas.sql     anexo imutável, remoção lógica com autor
  0013_portal_travas.sql        convite de uso único, sessão que não ressuscita
  0016_tiss_travas.sql          guia enviada imutável, glosa append-only
docker/
  migrate.sh                 migrate + seed
  verificar-invariantes.sql  prova das invariantes
```

## Design system

O catálogo vive no **Claude Design**: 23 cards, 20 componentes e um UI kit
clicável da equipe. `design-system/tokens-publicados.json` é o snapshot do que
está publicado, e `lib/ui/tokens.test.ts` falha se `app/globals.css` divergir —
republique com `/design-sync` e atualize o snapshot no mesmo commit. Foi o que
pegou a troca de paleta do rebranding: o teste reprovou antes de o catálogo
começar a mentir.

**Identidade Facilident.** O **kit oficial do designer** está versionado em
`design-system/kit-da-marca/` (color, mono, reverse, extra) e o manual em
`design-system/manual-da-marca.png`. Os arquivos servidos ficam em
`public/marca/`, e a troca de tema troca o **arquivo** — a linha `reverse` é
branca porque `#0D3B66` sobre fundo escuro desaparece.

**A arte é a original nos dois temas.** No tema escuro a assinatura vai sobre uma
**chapa** clara (`#F2F5F9`, o cinza do manual), porque o navio `#0D3B66` da palavra
sobre `#071626` dá 1,3:1 de contraste — desapareceria. É um retângulo claro num
cabeçalho escuro, e é o preço de não usar a versão branca do kit.

Duas peças são **derivadas**, e o motivo está no código: a *palavra compacta* (sem
o grupo do descritor, que a 22 px de cabeçalho vira borrão) e o *favicon* (dente
oficial colorido sobre a tinta `#E6F6F6`, recortado justo — o app icon do kit a
16 px vira mancha, e vai no `apple-touch-icon` a 180 px).

Já republicados no catálogo: `tokens/cores.css`, as três guidelines de cor,
`guidelines/marca-logo.html` e os quatro arquivos de `assets/`. **Ainda com o nome
antigo lá:** o UI kit (`ui_kits/dent-staff/`), `readme.md` e `SKILL.md` — são telas
de exemplo e texto, não afirmam cor errada.

Ícones: **Lucide**, via mapa fechado em `components/ui/Icone.tsx`. A regra é
ícone **acompanha** texto, nunca substitui — as únicas exceções são as setas de
período da agenda, ambas com `aria-label`.

## Segurança

> **No desenvolvimento o segundo fator está desligado** (`MFA_DESABILITADO=true`),
> para não exigir um código de 30 segundos a cada troca de perfil no teste. Em
> **produção o app se recusa a subir** com essa chave — é erro no boot, não um
> aviso. Ver `lib/auth/mfa.ts`.

| Garantia | Onde vive |
|---|---|
| MFA obrigatório para staff | `middleware.ts` prende em `/configurar-mfa` |
| Senha com scrypt (N=2^15) | `lib/auth/senha.ts`, sem dependência externa |
| TOTP RFC 6238 | `lib/auth/totp.ts`, testado com os vetores oficiais |
| Permissões numa fonte única | `lib/authz/politicas.ts` |
| Autorização em toda action e página | `exigirPermissao` / `exigirPermissaoPagina` |
| Leitura de prontuário auditada | `lib/auditoria/registrar.ts` |
| Prontuário imutável, agenda sem conflito | triggers e EXCLUDE no banco |
| Orçamento enviado é imutável | triggers em `drizzle/0004` |
| Evolução assinada imutável, adulteração visível | trigger + hash SHA-256 conferido na leitura |
| Exportação de prontuário exige motivo | `lib/prontuario/consultas.ts` |
| Pagamento não se exclui, estorna-se | triggers em `drizzle/0007` |
| `parcela.status` mantido pelo banco | trigger a cada pagamento |
| Lembrete nunca sai duas vezes | `chave_idempotencia` UNIQUE + `enviado_em` imutável (`drizzle/0009`) |
| Webhook do WhatsApp exige HMAC | `lib/mensageria/assinatura.ts`; sem segredo, 403 |
| Reentrega de webhook não reprocessa | `resposta_whatsapp.id_externo` UNIQUE |
| Sem consentimento LGPD, nada é enfileirado | trigger em `drizzle/0009` |
| Mensagem e resposta não se excluem | triggers em `drizzle/0009` |
| Anexo servido só com sessão e permissão | `app/api/documentos/[id]/route.ts`, sem URL de bucket |
| Integridade do anexo conferida em cada leitura | SHA-256 comparado; `sha256` imutável por trigger |
| Tipo do arquivo lido dos bytes, não da extensão | `lib/domain/arquivo.ts` |
| Chave de storage nunca vem do nome enviado | `chaveArmazenamento`, e travessia recusada em duas camadas |
| Documento não se exclui nem troca de paciente | triggers em `drizzle/0011` |
| CID só sai no atestado com autorização do paciente | `lib/domain/impressos.ts` |
| Consultar a auditoria também é auditado | `lib/relatorios/auditoria.ts` |
| CSV sem injeção de fórmula em planilha | `lib/domain/csv.ts` |
| Portal: consulta sempre escopada pela sessão | `lib/portal/consultas.ts` — nenhuma aceita `pacienteId` |
| Portal: cookie e mecanismo próprios | `dent_portal`, token opaco no banco, revogável |
| Realms sem FK entre si | verificado no catálogo por `drizzle/0013` e pela invariante 119 |
| Convite de primeiro acesso é de uso único | trigger em `drizzle/0013` |
| Login do portal não revela se a conta existe | `MENSAGEM_CREDENCIAL_INVALIDA` |
| Guia enviada é imutável no que foi apresentado | triggers em `drizzle/0016` |
| Glosa é append-only e não excede o item | triggers em `drizzle/0016` |
| Repasse não distribui mais do que recebeu | constraint deferida em `drizzle/0016` |
| Coparticipação e repasse somam exato | `ratearCobertura`, centavos inteiros |
| Tokens do código = tokens do catálogo | `lib/ui/tokens.test.ts` |

As três separações de acesso pedidas pela clínica, todas cobertas por teste:
recepção **não** lê evolução clínica, financeiro **não** lê dado clínico,
dentista **não** altera cobrança. O admin **não** é superusuário clínico.

## Estado atual

| Fase | Situação |
|---|---|
| 1 — Domínio e banco | pronta, verificada em Postgres real (200 invariantes) |
| 2 — Design system | tokens, componentes base, odontograma pronto |
| 3 — Esqueleto, MFA, RBAC, CRUD de paciente | pronta |
| 4 — Agenda | pronta |
| 5 — Anamnese e odontograma ligado ao banco | pronta |
| 6 — Plano de tratamento e orçamento | pronta |
| 7 — Prontuário e evoluções assinadas | pronta |
| 8 — Financeiro | pronta |
| 9 — Confirmação por WhatsApp | pronta (provedor simulado; Meta pendente de conta) |
| 10 — Imagens e documentos | pronta (armazenamento em disco; S3/R2 pendente de bucket) |
| 11 — Painel, relatórios e auditoria | pronta |
| 12 — Portal do paciente | pronta, com revisão de segurança (29 verificações adversariais) |
| 13 — Convênios / TISS | controle interno pronto; TUSS oficial em 36/49; **XML não validado** (ver abaixo) |
| 14 — Estoque | pronta (FEFO, validade, rastreabilidade de lote) |
| 15 — Cadastros administrativos | pronta (a clínica opera sem depender de quem escreveu o código) |
| 16 — Baixa na execução, backup e despacho | pronta (consumo em um clique, restauração testada, cron do WhatsApp) |
