# dent

Sistema de gestão para consultório odontológico.

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

| Serviço | Endereço |
|---|---|
| App | http://localhost:3000 |
| Odontograma | http://localhost:3000/design/odontograma |
| Postgres | `127.0.0.1:5433` (usuário `dent`, senha `dent_dev`) |

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
npm run db:verificar     # prova as invariantes do banco (35 casos)
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
npm test               # 347 testes (Vitest, sem banco)
npm run typecheck
npm run db:verificar   # 35 invariantes no banco (precisa do compose de pé)
```

Os testes de domínio não tocam o banco de propósito: são as regras puras
(anatomia das faces, dinheiro em centavos, datas civis, máquinas de estado).
As invariantes que vivem no Postgres — prontuário append-only, conflito de
agenda, soma das parcelas — têm verificação própria em
`docker/verificar-invariantes.sql`.

## Onde está o quê

```
app/
  (staff)/         realm da equipe: sessão e consultas próprias
  entrar/          login com e-mail + senha + código TOTP
  configurar-mfa/  obrigatório no primeiro acesso
  design/          playground do design system (fonte dos previews)
  api/auth/        rotas do Auth.js
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
  odontograma/     tradução item_plano/execucao ↔ estado das faces
  pacientes/       schema Zod, consultas e server actions
  db/schema/       27 tabelas Drizzle, uma área do domínio por arquivo
  db/seed/         dados de referência + primeiro admin
  domain/          regras puras, com .test.ts ao lado
drizzle/
  0000_inicial.sql      schema gerado
  0001_constraints.sql  triggers e EXCLUDE — as garantias legais e financeiras
docker/
  migrate.sh                 migrate + seed
  verificar-invariantes.sql  prova das invariantes
```

## Design system

O catálogo vive no **Claude Design** (projeto "dent Design System"): 23 cards, 20
componentes e um UI kit clicável da equipe. `design-system/tokens-publicados.json`
é o snapshot do que está publicado, e `lib/ui/tokens.test.ts` falha se
`app/globals.css` divergir — republique com `/design-sync` e atualize o snapshot
no mesmo commit.

Ícones: **Lucide**, via mapa fechado em `components/ui/Icone.tsx`. A regra é
ícone **acompanha** texto, nunca substitui — as únicas exceções são as setas de
período da agenda, ambas com `aria-label`.

## Segurança

| Garantia | Onde vive |
|---|---|
| MFA obrigatório para staff | `middleware.ts` prende em `/configurar-mfa` |
| Senha com scrypt (N=2^15) | `lib/auth/senha.ts`, sem dependência externa |
| TOTP RFC 6238 | `lib/auth/totp.ts`, testado com os vetores oficiais |
| Permissões numa fonte única | `lib/authz/politicas.ts` |
| Autorização em toda action e página | `exigirPermissao` / `exigirPermissaoPagina` |
| Leitura de prontuário auditada | `lib/auditoria/registrar.ts` |
| Prontuário imutável, agenda sem conflito | triggers e EXCLUDE no banco |
| Tokens do código = tokens do catálogo | `lib/ui/tokens.test.ts` |

As três separações de acesso pedidas pela clínica, todas cobertas por teste:
recepção **não** lê evolução clínica, financeiro **não** lê dado clínico,
dentista **não** altera cobrança. O admin **não** é superusuário clínico.

## Estado atual

| Fase | Situação |
|---|---|
| 1 — Domínio e banco | pronta, verificada em Postgres real (35 invariantes) |
| 2 — Design system | tokens, componentes base, odontograma pronto |
| 3 — Esqueleto, MFA, RBAC, CRUD de paciente | pronta |
| 4 — Agenda | pronta |
| 5 — Anamnese e odontograma ligado ao banco | pronta |
| 6 — Plano de tratamento e orçamento | a fazer |
| 6+ | ver `ROADMAP.md` |
