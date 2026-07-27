# Facilident — software de gestão odontológica

Ver `ROADMAP.md` para as fases e `GLOSSARIO.md` para a linguagem do domínio.
**Use os termos do glossário no código.** `evolucao` nunca é `nota`; `itemPlano` nunca é `procedimento`.

## Decisões arquiteturais fixas

1. **Single-tenant.** Uma clínica. Não existe `clinica_id` nas tabelas — `clinica` é uma
   linha de configuração singleton (`id = 1`).
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
- **O PDF gerado nunca foi aberto num visualizador por mim.** Foi validado
  estruturalmente (a tabela xref é relida no teste) e extraído com `pdftotext` e
  Ghostscript, que leem o conteúdo correto. Layout fino — margem, alinhamento —
  merece uma olhada humana antes de o primeiro atestado sair para valer.
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
- **`usuario.mfa_secret` está em texto claro.** Não é bypass de autenticação — ainda exige a
  senha — mas agrava um vazamento de banco. Cifrar exige chave fora do banco e rotação.
- **`codigo_tuss`: 36 dos 49 procedimentos já têm código OFICIAL.** A faixa odontológica da
  Tabela 22 (370 códigos, prefixos 81–87) está em `dados/tuss22-odontologia.csv`, baixada da API
  da ANS — não editada. O mapeamento catálogo→TUSS é interpretação e vale conferir com quem
  fatura antes do primeiro envio. Os **13 restantes ficaram em branco de propósito**: ou o
  procedimento não existe na Tabela 22, ou existem vários candidatos e a escolha muda o valor
  recebido. `dados/README.md` lista cada caso com os candidatos. **Não preencha por dedução** —
  código plausível e errado é glosa que aparece semanas depois.
- **O XML TISS NUNCA foi validado contra o XSD da ANS nem enviado a operadora real.** É XML bem
  formado (conferido por parser), com escape correto e hash de epílogo — e isso é tudo o que se
  pode afirmar. O caminho que fatura hoje é a folha de conferência, que a recepção digita no
  portal da operadora. Ver o aviso no topo de `lib/tiss/exportar.ts`.
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
  pixels. Substitui a decisão anterior (verde-petróleo `#0f766e`), que era explicitamente
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

Demonstrações que rodam contra o Postgres e conferem número, não fluxo:
`whatsapp:demo`, `documentos:demo`, `relatorios:demo`, `convenio:demo`,
`estoque:demo`. Verificações por HTTP com sessão real: `portal:seguranca`,
`estoque:telas`, `admin:verificar`.

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
