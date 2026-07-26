# Sistema para Consultório Odontológico — Roadmap

> Decisões da Fase 0 (2026-07-26): **single-tenant** (uma clínica), **particular + convênio**,
> perfis **dentista / recepção / financeiro / portal do paciente**, **WhatsApp obrigatório no MVP**.

## Ordem macro

```
Fase 1  Domínio (schema)        ─┐
Fase 2  Design System            ├─ 2 e 3 em paralelo
Fase 3  Esqueleto + RBAC        ─┘
Fase 4  Agenda
Fase 5  Anamnese + Odontograma
Fase 6  Plano de tratamento + Orçamento
Fase 7  Prontuário / Evolução
Fase 8  Financeiro (particular)
Fase 9  WhatsApp                 ← fim do MVP interno
Fase 10 Imagens e documentos
Fase 11 Dashboard e relatórios
Fase 12 Portal do paciente
Fase 13 Convênios / TISS
Fase 14 Estoque
```

**Regra de ouro:** cada fase é uma *fatia vertical* — banco + backend + UI + teste + deploy.
Nunca "todo o backend primeiro".

---

## Stack

| Camada | Escolha |
|---|---|
| Front + Back | Next.js 15 (App Router) + TypeScript |
| Banco | Postgres (Neon ou Supabase) |
| ORM | Drizzle |
| UI | Tailwind + shadcn/ui, customizado pelo design system |
| Auth | Auth.js — **dois realms separados**: staff e paciente |
| Arquivos | S3/R2, sempre com URL assinada e expiração curta |
| Validação | Zod, compartilhado entre server action e formulário |
| WhatsApp | Meta Cloud API (oficial) |

Estrutura de rotas — a separação entre staff e portal é de segurança, não de organização:

```
app/
  (staff)/         sessão de staff, RBAC por perfil
  (portal)/        sessão de paciente, escopo travado ao próprio prontuário
  api/whatsapp/    webhook da Meta (implementado); pagamento vem depois
lib/
  db/              schema, migrations, seeds
  domain/          regras puras e testáveis (parcelamento, conflito de agenda, faces)
  authz/           políticas de permissão em um lugar só
```

---

## Fase 1 — Domínio (2–3 dias) ⬅️ começa aqui

Entregáveis:

1. **Glossário** — 30 termos com definição acordada com o dentista
2. **Schema + migrations** rodando
3. **Seeds**: 52 dentes (FDI), catálogo de procedimentos com código TUSS, perfis de acesso
4. **Máquinas de estado escritas** (em `lib/domain/`, com teste unitário)

### Entidades núcleo

```
usuario            staff: email, senha, mfa, perfil (dentista|recepcao|financeiro|admin)
profissional       1:1 com usuario dentista — cro, uf_cro, especialidade, comissao_pct
paciente           dados, responsavel_legal_id (se menor), status
consentimento      base legal LGPD, versão do termo, data, IP
anamnese           versionada (refeita periodicamente), respostas em JSONB + alertas
alerta_clinico     alergia, anticoagulante, diabetes — visível no topo de toda tela
dente              seed FDI: 32 permanentes + 20 decíduos
procedimento       catálogo: codigo_tuss, nome, valor_particular, requer_dente, requer_face
convenio           nome, registro_ans, prazo_pagamento_dias
preco_convenio     (procedimento_id, convenio_id) → valor, cobertura_pct
agendamento        paciente, profissional, cadeira, inicio, fim, status, origem
plano_tratamento   paciente, profissional, status, criado_em
item_plano         plano, procedimento, dente_id?, faces[]?, status, valor,
                   convenio_id? (null = particular), guia_tiss_id?  ← gancho da Fase 13
execucao           item_plano, profissional, executado_em, observacao
evolucao           APPEND-ONLY. paciente, profissional, texto, assinado_em,
                   retifica_id? (retificação, nunca UPDATE)
orcamento          paciente, plano, validade, status, pdf_url
cobranca           orcamento?, valor_total, forma
parcela            cobranca, numero, vencimento, valor, status
pagamento          parcela, valor, data, meio, conciliado
documento          paciente, tipo, storage_key, hash
audit_log          quem, o quê, quando, IP — obrigatório em todo acesso a prontuário
```

### Máquinas de estado

```
agendamento:  agendado → confirmado → em_atendimento → concluido
                    ↘ faltou    ↘ cancelado (com motivo)

item_plano:   proposto → aprovado → executado → faturado → recebido
                    ↘ recusado           ↘ glosado (Fase 13)
```

### Regras que precisam de teste desde a Fase 1

- Face é válida para aquele dente? (incisivo não tem oclusal, tem incisal)
- Dentição decídua e permanente coexistem em paciente em transição
- Dois agendamentos não podem ocupar mesmo profissional/cadeira/horário
- Parcelamento: soma das parcelas == total, arredondamento na primeira
- Evolução assinada nunca sofre UPDATE ou DELETE — só retificação encadeada

---

## Fase 2 — Design System (2–3 dias, paralelo à Fase 3)

O Claude Design é o **catálogo do design system**, não protótipo de telas. O código é a fonte
da verdade; `/design-sync` publica o catálogo para revisão.

1. **Tokens** — alto contraste (recepção lê de longe), fonte legível, densidade compacta
2. **~15 componentes base** — Button, Input, Select, DatePicker, Combobox, Table, Dialog,
   Sheet, Tabs, StatusBadge, Card, Toast, EmptyState, Avatar, Skeleton
3. **3 componentes de domínio** — `Odontograma`, `AgendaSemanal`, `TimelineProntuario`
4. Gerar previews → `/design-sync` → revisar com o dentista **antes** de existirem 40 telas

**O odontograma merece um protótipo isolado de 1 dia antes de qualquer tela.** É o componente
mais difícil do projeto: 52 dentes, 5 faces cada, seleção múltipla, estados sobrepostos
(cárie + restauração + coroa), planejado vs. executado, mouse e touch.

## Fase 3 — Esqueleto + RBAC + primeira fatia (5 dias)

Uma fatia fina atravessando todas as camadas:

Login com MFA → RBAC dos 3 perfis internos → layout com navegação → **CRUD de Paciente
completo** → audit log gravando → 1 teste E2E → deploy em staging.

Com 4 perfis, o RBAC vem **aqui**, não depois. Políticas centralizadas em `lib/authz/`:
recepção não lê evolução clínica, financeiro não lê dado clínico, dentista não altera cobrança.
Depois de pronto, cada módulo seguinte é repetição de um padrão já provado.

---

## Fases 4+ — Módulos

| # | Módulo | Sem. | Notas |
|---|---|---|---|
| 4 | Agenda | 2 | Multi-profissional, cadeiras, bloqueios, recorrência, arrastar |
| 5 | Anamnese + Odontograma | 2 | Alertas clínicos no topo de toda tela do paciente |
| 6 | Plano de tratamento + Orçamento | 2 | Preço particular **e** por convênio; PDF |
| 7 | Prontuário / Evolução | 1,5 | Append-only, assinado, retificação encadeada |
| 8 | Financeiro particular | 2,5 | Parcelas, recebimento, inadimplência, comissão |
| 9 | **WhatsApp** | 1 | ✅ pronta. Fila idempotente, webhook assinado, resposta → status. Provedor simulado enquanto não há conta Meta |
| | **↑ MVP interno operável** | **~14** | |
| 10 | Imagens e documentos | 1,5 | ✅ pronta. Radiografias, antes/depois, atestado, receita, PDF do orçamento. Disco por padrão; S3/R2 pendente de bucket |
| 11 | Dashboard e relatórios | 1,5 | ✅ pronta. Caixa e produção separados, ocupação em duas medidas, falta vs cancelamento, efeito da confirmação, tela de auditoria, CSV |
| 12 | Portal do paciente | 2,5 | Realm próprio. Ver agenda, orçamento, histórico. **Security review obrigatória** |
| 13 | Convênios / TISS | 3–4 | Guias, glosa, conciliação de repasse, tabela ANS |
| 14 | Estoque | 1 | Materiais, lote, validade, alerta de mínimo |
| | **Produto completo** | **~24** | |

### Por que convênio na Fase 13, mesmo sendo essencial

TISS é o maior risco isolado do projeto. Colocá-lo cedo trava tudo atrás dele. O caminho
pragmático: **lançar com faturamento particular e convênio ainda manual** por algumas semanas,
com o modelo financeiro já preparado (`preco_convenio`, `item_plano.convenio_id`,
`guia_tiss_id`) desde a Fase 1. Assim a Fase 13 é adição, não refatoração.

Se a clínica **não puder** operar sem TISS automatizado, ele sobe para a Fase 9 e o MVP vai
para ~18 semanas.

### Por que o portal na Fase 12

Ele lê agenda, orçamento e prontuário — precisa que os três existam. É read-mostly e não
bloqueia a operação da clínica.

---

## Trilhas transversais (contínuas, não são fase)

**LGPD desde o dia 1** — dado de saúde é dado sensível:
- Consentimento registrado com versão do termo
- Audit log em **todo** acesso a prontuário (quem viu o quê, quando)
- Criptografia em repouso; anexos nunca em URL pública
- Retenção mínima de 20 anos (CFO); export e anonimização por titular
- MFA obrigatório para staff

**Backup** — testar a *restauração*, não só o dump.

**Testes** — E2E nos fluxos de dinheiro e de prontuário; unitários nas regras de
`lib/domain/` (faces, conflito de agenda, parcelamento).

---

## Próximos passos imediatos

1. `git init` + `CLAUDE.md` com stack e convenções
2. Glossário dos 30 termos, validado com o dentista
3. Schema + migrations + seeds (52 dentes FDI, catálogo TUSS)
4. Só então UI
