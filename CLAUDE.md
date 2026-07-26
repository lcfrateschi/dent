# dent — Sistema para consultório odontológico

Ver `ROADMAP.md` para as fases e `GLOSSARIO.md` para a linguagem do domínio.
**Use os termos do glossário no código.** `evolucao` nunca é `nota`; `itemPlano` nunca é `procedimento`.

## Decisões arquiteturais fixas

1. **Single-tenant.** Uma clínica. Não existe `clinica_id` nas tabelas — `clinica` é uma
   linha de configuração singleton (`id = 1`).
2. **Dois realms de autenticação.** Staff (`usuario`) e paciente (`paciente_conta`) são
   tabelas e sessões separadas. **Nunca compartilhe uma query entre staff e portal** — é
   exatamente ali que nasce o IDOR que expõe o prontuário do vizinho.
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
| Auth | Auth.js, MFA obrigatório para staff | 3 |
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

### TypeScript

Travado em **`^5.9`**. O TypeScript 7 (compilador nativo) quebra o carregador de
`next.config.ts` do Next 15 — erro `Cannot read properties of undefined (reading 'fileExists')`.
Reavaliar quando o Next declarar suporte.

### Nunca use `drizzle-kit push`

Ele desconhece as EXCLUDE constraints e os triggers de `drizzle/0001_constraints.sql` e pode
derrubá-los silenciosamente — junto com o append-only do prontuário. O script foi removido do
`package.json` de propósito. Use `db:generate` + `db:migrate`.

Depois de mexer em constraint ou trigger, rode `npm run db:verificar`: são 102 casos que provam
as invariantes contra um Postgres real. O script **falha na hora** se uma tabela esperada não
existir — um `espera_erro` com a tabela ausente "passa" pelo motivo errado, e isso já produziu
um relatório verde provando invariante nenhuma.

### Pendências conhecidas

- **Os anexos gravam em DISCO, não em bucket.** `ARMAZENAMENTO=disco` é o padrão e
  é uma escolha válida para clínica em um servidor só — mas o volume `anexos`
  **precisa entrar no backup**, e o banco sem os arquivos não reconstitui
  prontuário. `lib/armazenamento/s3.ts` está pronto e **nunca executou contra um
  bucket real**; a assinatura SigV4, que é a parte difícil de diagnosticar, está
  provada contra os vetores oficiais da AWS.
- **O PDF gerado nunca foi aberto num visualizador por mim.** Foi validado
  estruturalmente (a tabela xref é relida no teste) e extraído com `pdftotext` e
  Ghostscript, que leem o conteúdo correto. Layout fino — margem, alinhamento —
  merece uma olhada humana antes de o primeiro atestado sair para valer.
- **WhatsApp roda no provedor SIMULADO.** Nenhuma mensagem sai de verdade até a clínica ter
  conta WhatsApp Business com o template `lembrete_consulta_pt_br` aprovado. `lib/mensageria/
  provedor/meta.ts` foi escrito pela documentação da Cloud API v21 e **nunca executou contra a
  API real** — é o único arquivo da fase que precisa de conferência quando as credenciais
  existirem. Todo o resto (fila, idempotência, webhook, efeito na agenda) está verificado.
- **O despacho precisa de um cron.** `npm run whatsapp:despachar` é seguro de rodar em
  paralelo e quantas vezes quiser (chave de idempotência + `SKIP LOCKED`). A cada 10 minutos
  basta: o horário de envio já está gravado em `agendado_para`.
- **`usuario.mfa_secret` está em texto claro.** Não é bypass de autenticação — ainda exige a
  senha — mas agrava um vazamento de banco. Cifrar exige chave fora do banco e rotação.
- **`codigo_tuss` está nulo no seed, de propósito.** Código TUSS inventado gera glosa. A fonte
  é a Terminologia Unificada em Saúde Suplementar da ANS (Tabela 22, procedimentos
  odontológicos). Importar a versão vigente antes da Fase 13.
- **Valores do catálogo são de partida** — revisar com a clínica.
- **Termos ⚠️ do GLOSSARIO.md** ainda esperam validação com o dentista. Os que restam são de
  vocabulário (titular de convênio, encaixe, faturado), não de regra de cálculo.

### Decisões fechadas — não reabrir

- **Comissão sobre valor RECEBIDO** (`clinica.base_comissao = 'valor_recebido'`), decidido pela
  clínica. A comissão entra na base quando o pagamento é conciliado, não quando o procedimento é
  executado. Comissão paga sobre execução vira adiantamento quando o paciente atrasa.
- **Cor de marca**: verde-petróleo `#0f766e`. A clínica não tem identidade visual a aplicar.
- **Mensagem travada em `enviando` NÃO é reenviada automaticamente.** Se o processo morreu
  depois de chamar a Meta, ninguém sabe se ela entregou. A linha fica visível na tela de
  WhatsApp e a decisão é humana. Perder um lembrete custa uma ligação; mandar dois custa a
  confiança do paciente. A trigger de transição em `drizzle/0009` impede `enviando → pendente`.
- **A mensagem de WhatsApp não carrega dado clínico.** Só nome, profissional, data e hora — a
  tela do celular do paciente é lida por outras pessoas. Ver `lib/domain/textoMensagem.ts`.
- **Anexo do prontuário NÃO é servido por URL assinada.** Os bytes passam pela
  rota `/api/documentos/[id]`, que autoriza e audita cada acesso. URL assinada é
  encaminhável: quem recebe o link vê a radiografia sem sessão e sem deixar
  rastro. A troca é banda por exigência legal, e a escolha é a exigência legal.
- **Remoção de documento é de mão única.** Corrigir envio errado é remover com
  motivo e enviar de novo. Esconder e reexibir um documento clínico sem rastro é
  o que a guarda de 20 anos existe para impedir. Trigger em `drizzle/0011`.
- **CID no atestado só com autorização expressa do paciente.** O atestado costuma
  ir para o RH da empresa; o diagnóstico é dado de saúde. O padrão é não imprimir,
  e a tela avisa que não imprimiu. Ver `lib/domain/impressos.ts`.

## Estrutura

```
lib/
  db/
    schema/        tabelas Drizzle, um arquivo por área do domínio
    seed/          dados de referência (52 dentes FDI, catálogo TUSS, perfis)
    index.ts       cliente de conexão
  domain/          regras puras + .test.ts ao lado
drizzle/           migrations geradas + SQL manual de constraints
app/               (Fase 3) (staff)/ e (portal)/ separados
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
```

## Armadilhas do domínio (já custaram retrabalho em outros sistemas)

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
