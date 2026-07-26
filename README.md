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
npm test          # 148 testes de domínio e geometria (Vitest, sem banco)
npm run typecheck
npm run db:verificar   # invariantes no banco (precisa do compose de pé)
```

Os testes de domínio não tocam o banco de propósito: são as regras puras
(anatomia das faces, dinheiro em centavos, datas civis, máquinas de estado).
As invariantes que vivem no Postgres — prontuário append-only, conflito de
agenda, soma das parcelas — têm verificação própria em
`docker/verificar-invariantes.sql`.

## Onde está o quê

```
app/
  design/          playground do design system (fonte dos previews)
components/
  odontograma/     geometria pura + SVG dos 52 dentes
  ui/              componentes base
lib/
  db/schema/       27 tabelas Drizzle, uma área do domínio por arquivo
  db/seed/         dados de referência
  domain/          regras puras, com .test.ts ao lado
drizzle/
  0000_inicial.sql      schema gerado
  0001_constraints.sql  triggers e EXCLUDE — as garantias legais e financeiras
docker/
  migrate.sh                 migrate + seed
  verificar-invariantes.sql  prova das invariantes
```

## Estado atual

| Fase | Situação |
|---|---|
| 1 — Domínio e banco | pronta e verificada em Postgres real |
| 2 — Design system | tokens e primeiros componentes; odontograma pronto |
| 3 — Esqueleto, RBAC, CRUD de paciente | a fazer |
| 4+ | ver `ROADMAP.md` |
