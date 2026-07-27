# Roteiro de teste do Facilident

Passo a passo para exercitar o sistema inteiro, na ordem em que uma clínica de
verdade usaria. Cada seção diz **o que fazer**, **o que esperar** e, quando é o
caso, **o que tentar furar** — porque metade do valor deste sistema está nas
coisas que ele recusa.

Tempo total: cerca de 90 minutos para passar por tudo com calma.

---

## 0. Subir e preparar

```bash
docker compose up -d                          # Postgres + migrations + seed + app
docker compose exec app npm run demo:preparar # clínica, equipe, pacientes, dados
```

O `demo:preparar` imprime **as credenciais** no fim. Ele cria pessoas fictícias
(marcadas com `[DEMO]` e e-mail `@demo.local`) e recusa rodar em produção.

Para voltar ao estado limpo em qualquer momento:

```bash
docker compose exec app npm run demo:limpar   # remove só os dados de demonstração
docker compose down -v && docker compose up -d # zera o banco inteiro
```

| Onde | Endereço |
|---|---|
| Sistema (equipe) | http://localhost:3000/entrar |
| Portal do paciente | http://localhost:3000/meu/entrar |
| Design system | http://localhost:3000/design/odontograma |
| Postgres | `127.0.0.1:5433` — usuário `facilident`, senha `facilident_dev` |

### Credenciais

Senhas fixas; **o segredo do MFA muda a cada `demo:preparar`** (é sorteado), então
use o que o script imprimiu.

| Perfil | E-mail | Senha |
|---|---|---|
| Administrador | `admin@demo.local` | `Facilident-Admin-2026` |
| Dentista | `dentista@demo.local` | `Facilident-Dentista-2026` |
| Recepção | `recepcao@demo.local` | `Facilident-Recepcao-2026` |
| Financeiro | `financeiro@demo.local` | `Facilident-Financeiro-2026` |
| Paciente (portal) | `ana@demo.local` | `Paciente-Portal-2026` |

### O código de 6 dígitos — desligado neste ambiente

**Para testar, você não precisa de código.** O `docker-compose.yml` sobe o serviço
de desenvolvimento com `MFA_DESABILITADO=true`: o campo do código já vem com
`000000` preenchido e é **ignorado** no servidor. Entre com e-mail e senha, e
clique em Entrar. A tela de login avisa que o segundo fator está desligado.

A senha **continua sendo exigida** — só o segundo fator saiu.

> **Isto não pode ir para a clínica, e o sistema garante isso:** com
> `MFA_DESABILITADO=true` e `NODE_ENV=production`, o app **se recusa a subir**.
> Não é "ignora em produção" — é erro no boot, junto com a checagem do
> `AUTH_SECRET`. Um `.env` copiado do desenvolvimento derruba o deploy na cara de
> quem o fez, em vez de deixar a clínica rodando sem segundo fator. Também não
> existe código mágico `000000` na verificação TOTP: com o MFA ligado, `000000` é
> um código errado como qualquer outro.

Para ver o fluxo real (e é o que a clínica vai usar):

```bash
MFA_DESABILITADO=false docker compose up -d app
```

Aí valem os três caminhos abaixo.

1. **Sem celular — o mais rápido:**
   ```bash
   docker compose exec app npm run demo:codigo
   ```
   Imprime o código atual de cada perfil e quantos segundos ele ainda vale. Se
   faltarem menos de 5 segundos, ele avisa para rodar de novo: o login devolve a
   **mesma** mensagem para senha errada e código expirado (de propósito, para não
   dizer a quem ataca o que existe), e sem o aviso você concluiria que a senha está
   errada.

2. **Com celular — QR no terminal:**
   ```bash
   docker compose exec app npm run demo:codigo -- --qr
   ```
   Mostra o segredo e um QR desenhado no próprio terminal, para apontar a câmera do
   Google Authenticator, Authy, 1Password ou Microsoft Authenticator. Uma vez
   cadastrado, o app gera os códigos sozinho.

3. **O caminho real, para ver como será na clínica:** crie um usuário em
   `/usuarios`. No primeiro login ele é levado a `/configurar-mfa`, que mostra o QR
   **na tela** — é assim que um funcionário de verdade cadastra o autenticador, e
   ninguém (nem o admin) vê o segredo dele.

Os dois primeiros só funcionam para `@demo.local` e recusam rodar em produção — o
filtro está na consulta, não num `if` depois.

E a trava do MFA continua **provável** a qualquer momento: com
`MFA_DESABILITADO=false`, o `npm run admin:verificar` confirma que o usuário novo
fica preso em `/configurar-mfa`. Com o MFA desligado, esse caso aparece como
`⊘ pulado`, com o motivo — um verde silencioso ali afirmaria que a trava existe
num ambiente onde ela está desligada.

> O paciente **não** tem MFA, por decisão: exigir autenticador de quem entra três
> vezes por ano produz abandono, não segurança. O que protege ali é bloqueio
> crescente por tentativa, sessão de 12 h e revogação imediata.

---

## 1. Primeiro acesso e as duas portas

**Entre como `admin@demo.local`.** Vai direto ao sistema — os usuários de
demonstração nascem com MFA configurado e senha definitiva.

Para ver o fluxo real de um funcionário novo, faça em `/usuarios` → **Novo
usuário** (nome, e-mail, perfil Recepção) e guarde a senha que aparece.

> Ela aparece **uma vez só**: o banco guarda o hash. Se perder, gere outra.

Saia e entre com o usuário novo. O sistema vai prendê-lo em **duas portas, nesta
ordem**:

1. `/configurar-mfa` — QR para escanear. Sem concluir, nenhuma outra tela abre.
2. `/trocar-senha` — a senha foi ditada por outra pessoa; não serve como
   definitiva. Pede a senha atual (uma sessão esquecida no balcão não pode tomar a
   conta).

Depois disso ele circula normalmente. **Tente:** voltar em `/usuarios` com esse
usuário de recepção — vai para `/sem-permissao`.

---

## 2. Recepção: agenda e cadastro

Entre como **recepção**.

### Agenda — `/agenda`
- Três atendimentos hoje: Ana (confirmado), Bruno e Pedro (agendados).
- Clique num horário livre para agendar; escolha profissional e cadeira.
- **Tente furar:** marque dois atendimentos no mesmo horário, mesma cadeira. O
  banco recusa — é uma EXCLUDE constraint, não uma validação de tela. Tente
  também com o mesmo profissional em cadeiras diferentes: também recusa.
- Cancele um atendimento: exige motivo.

### Paciente novo — `/pacientes` → Novo
- CPF é conferido pelos dígitos verificadores (tente `111.111.111-11`).
- Cadastre alguém com menos de 18 anos e informe o responsável legal — a ficha
  passa a mostrar que consentimento e assinatura são do responsável.

### Convênio do paciente — ficha da Ana
Em `/pacientes`, abra **Ana Souza Lima**. Na seção **Convênios** ela já tem
carteirinha da Odonto Prev Demo.
- **Tente furar:** cadastre uma segunda carteirinha ativa na mesma operadora.
  Recusado: duas ativas tornariam indefinido qual número vai na guia.
- Cadastre um dependente sem informar o titular: recusado.

---

## 3. Dentista: o atendimento

Entre como **dentista**.

### Anamnese — ficha do paciente → Anamnese
Responda o questionário. Marque alergia a algum medicamento e salve: a anamnese
**cria o alerta clínico automaticamente** (`origem_anamnese_id`), e ele passa a
aparecer no topo de toda tela daquele paciente, em vermelho. É segurança na
cadeira, não decoração — e a recepção também vê, mesmo sem poder ler evolução.

### Odontograma — ficha → Odontograma
- **Pedro (8 anos)** mostra as duas arcadas: decíduos e permanentes ao mesmo
  tempo. Dentição mista existe e o diagrama tem de mostrar as duas.
- Clique num molar: as faces oferecidas incluem **oclusal**. Clique num incisivo:
  oferece **incisal**, nunca oclusal. Superior tem palatina; inferior, lingual.
- Vermelho = planejado, azul = executado (convenção clínica brasileira). Note que
  cada estado também tem **padrão** — hachurado vs. sólido —, porque cor sozinha
  não é acessível.
- Planeje um procedimento num dente: ele entra no plano de tratamento.

### Executar e dar baixa no material — o fluxo de um clique
No odontograma, marque um item planejado como **executado**. Aparece o painel
**"Lançar o material usado"**, com os insumos da ficha técnica e **o lote que
vence primeiro já escolhido**.

- Ajuste uma quantidade, marque um item como "não usei", confirme.
- **Tente furar:** clique em confirmar duas vezes. O segundo é recusado — o
  consumo não sai dobrado.
- Se fechar sem lançar, o atendimento aparece em **`/estoque` → "Consumo a
  lançar"**. Nada se perde.

### Prontuário — ficha → Prontuário
- Escreva uma evolução e **assine**.
- **Tente furar:** edite ou apague uma evolução assinada. O banco recusa — é
  trigger, não disciplina de código. A correção é **retificar**: nova evolução
  apontando para a anterior, com motivo. A cadeia fica visível.

---

## 4. Orçamento e impressos

### Orçamento
Na ficha da Ana → **Plano**, gere o orçamento dos itens aprovados.
- Ele é um **documento congelado**, não uma view do plano: mude o plano depois e o
  orçamento enviado não muda. Para outro valor, gera-se outro orçamento.
- Abra a versão para impressão: cabeçalho com CNPJ, CRO e endereço da clínica —
  daí a importância do `/configuracoes`.

### Atestado e receita — ficha → Impressos
- Gere um **atestado**. Note a caixa do CID: o padrão é **não imprimir**, e a tela
  avisa que não imprimiu. O atestado costuma ir para o RH da empresa, e
  diagnóstico é dado de saúde — só sai com autorização expressa.
- Gere uma **receita** com posologia de duas linhas: confira que a indentação
  sobreviveu no PDF (já foi bug).
- Os dois entram no prontuário como documento, e o download passa pela rota
  `/api/documentos/[id]`, que **autoriza e audita cada acesso**. Não há URL
  assinada: link assinado é encaminhável, e quem recebesse veria a radiografia sem
  sessão e sem deixar rastro.

### Documentos e radiografias — ficha → Documentos
- Anexe um PNG ou PDF qualquer. O tipo é detectado por **magic bytes**, não pela
  extensão: renomeie um `.txt` para `.png` e tente.
- Remova um documento: exige motivo, e é **de mão única**. Esconder e reexibir um
  documento clínico sem rastro é o que a guarda de 20 anos existe para impedir.

---

## 5. Financeiro

Entre como **financeiro**.

- `/financeiro` mostra a cobrança do Bruno: R$ 900 em 3×, com **a parcela 2
  vencida há 5 dias**.
- Registre um pagamento parcial na parcela vencida: a parcela aceita pagamento
  parcial e o saldo continua aberto.
- **Tente furar:** registre um pagamento maior que a parcela. Recusado — a soma
  dos pagamentos não passa do valor da parcela.
- Crie uma cobrança a partir do orçamento da Ana, em 4×. As parcelas somam
  exatamente o total; a sobra do arredondamento vai na primeira.
- `/financeiro/comissoes`: a comissão da dentista sai sobre o **valor recebido**,
  não sobre o executado. Comissão paga sobre execução vira adiantamento quando o
  paciente atrasa — decisão fechada da clínica.
- **Tente:** abrir `/pacientes/<id>/prontuario` como financeiro. Negado. O
  financeiro não lê dado clínico.

---

## 6. Convênios e TISS

Entre como **admin** ou **financeiro**.

### Cadastro — `/convenios/cadastro`
- A Odonto Prev Demo tem 4 preços. Abra a operadora: a tabela mostra **vigentes
  hoje** e **histórico** juntos, porque o valor faturado é o da **data da
  execução**, não o de hoje.
- Repare que a consulta (`CONS-001`) tem duas vigências: R$ 45 até ontem e R$ 52 a
  partir de hoje. Um atendimento de semana passada vale 45.
- Cadastre um preço novo para um procedimento que já tem preço: a tela avisa que a
  vigência atual será **fechada no dia anterior**, automaticamente.
- **Tente furar:** cadastre um preço com vigência que se sobrepõe a outra.
  Recusado por EXCLUDE constraint — dois preços válidos no mesmo dia tornariam o
  valor a faturar indefinido. Note também que **não existe botão de editar preço**:
  reajuste é linha nova.

### Faturamento — `/convenios`
- A tela lista o que já foi executado e não foi cobrado da operadora. Monte uma
  guia com os itens da Ana.
- Envie a guia (número do lote). Depois disso o valor apresentado é imutável.
- Registre o retorno da operadora com **valor pago menor** que o apresentado: a
  glosa é **calculada** (apresentado − pago), nunca digitada. Escolha a classe e
  recorra.
- Baixe a **folha de conferência** (`/api/convenios/guias/<id>/conferencia`): é o
  artefato que a recepção digita no portal da operadora — e é o caminho que
  fatura de verdade hoje.
- Registre um repasse e concilie item a item.

> **O XML TISS existe** (`.../xml`) e é bem formado, mas **nunca foi validado
> contra o XSD da ANS nem enviado a uma operadora real**. Não conte com ele.

---

## 7. Estoque

Entre como **recepção** (lança entrada e faz contagem) ou **dentista** (dá baixa).

`/estoque` abre pelo que precisa de ação:

- **Consumo a lançar** — atendimentos com material pendente.
- **Precisa de atenção** — o implante está **abaixo do mínimo** (saldo 1, mínimo
  2), com sugestão de compra que repõe ao **dobro** do mínimo. Repor ao mínimo
  faria o alerta disparar no dia seguinte à entrega.
- **Validade** — um lote de resina **vence em 20 dias**, com o valor em risco em
  reais. Há também um lote **já vencido** com saldo.

### FEFO — o teste que vale a pena
Abra a **Resina composta A2** (`RES-001`). Ela tem dois lotes:

| Lote | Recebido | Validade |
|---|---|---|
| `RES-CURTO-VENCE-EM-20` | há 5 dias | 20 dias |
| `RES-LONGO` | há 90 dias | 400 dias |

A lista está **na ordem em que vão sair**, e o primeiro é o que chegou **depois**.
Isso é FEFO: vence primeiro, sai primeiro. Dê baixa de uma quantidade maior que o
saldo do lote curto e veja a baixa **atravessar os dois lotes**, gerando um
movimento por lote — é o que preserva a rastreabilidade.

### Outras coisas para tentar
- Consumir o **lote vencido**: recusado. Só descarte, e com motivo.
- **Contar** um lote com número diferente do sistema: pede o que foi contado (não
  a diferença) e exige motivo — sem ele, perda e erro de lançamento ficam
  indistinguíveis.
- Receber material em **embalagens**: 2 caixas de 50 pares entram como 100, não
  como 2. É o erro clássico da nota fiscal.
- Cadastrar lote de **implante sem número do fabricante**: recusado. Sem ele, o
  recolhimento de lote não tem como dizer em quem foi usado.
- Na página do implante, veja **Rastreabilidade** — se ele foi consumido numa
  execução, aparece o paciente.
- `/estoque/fichas`: fichas técnicas e cadastro de material.

---

## 8. WhatsApp

Entre como **recepção** → `/whatsapp`.

- A Ana tem consentimento de contato; o Bruno **não**. Sem consentimento, a
  trigger recusa a mensagem antes de ela entrar na fila — LGPD não é validação de
  tela.
- A tela lista os atendimentos que podem receber lembrete. Enfileire o da Ana
  daqui a 3 dias: o horário de envio é **calculado** (janela 08:00–20:00; nunca 3
  da manhã) e fica gravado em `agendado_para`.
- **Despachar agora** manda a fila para o provedor sem esperar o ciclo. O mesmo
  pela linha de comando:
  ```bash
  docker compose exec app npm run whatsapp:despachar
  ```
  Em produção, o serviço `despachante` faz isso a cada 10 minutos
  (`docker compose --profile prod up despachante`).
- Simule a resposta do paciente pelo webhook — o script de demonstração faz o
  ciclo completo, incluindo "confirmo", "não vou poder" e as respostas ambíguas:
  ```bash
  docker compose exec app npm run whatsapp:demo
  ```

> **O provedor é SIMULADO.** Nenhuma mensagem sai até a clínica ter conta WhatsApp
> Business com o template aprovado. Toda a mecânica — fila, idempotência, webhook
> assinado, efeito na agenda — está verificada; o arquivo que fala com a Meta
> nunca executou contra a API real.

---

## 9. Portal do paciente

Abra **http://localhost:3000/meu/entrar** (de preferência numa janela anônima, para
não misturar com a sessão da equipe) e entre como `ana@demo.local` /
`Paciente-Portal-2026`.

A Ana vê: próximas consultas, histórico de atendimentos, orçamentos, financeiro e
documentos — **só os dela**.

- **"Não vou poder ir"** num agendamento: registra o aviso e **não cancela**. Um
  toque errado no celular não pode custar o horário, e a clínica precisa saber para
  remarcar.
- **Tente furar:** troque o id na URL de um orçamento por outro qualquer. Não há
  IDOR possível — nenhuma consulta do portal aceita `pacienteId`, ele vem sempre da
  sessão.
- O portal **não mostra evolução clínica nem radiografia**. Histórico de
  atendimentos sim. A íntegra do prontuário é direito do paciente (CFO) e é pedida
  na clínica, com exportação auditada: evolução é escrita para outro profissional, e
  imagem sem laudo gera interpretação errada.
- Na ficha da Ana (lado da equipe), **revogue o acesso**: as sessões abertas caem
  na hora, não no fim do prazo.

---

## 10. Painel, relatórios e auditoria

Como **dentista** ou **admin** → `/painel`.

- **Caixa** (recebido, conciliado, ticket médio) e **Produção** (valor executado,
  pacientes atendidos, pacientes novos) são cartões **separados** e nunca somados:
  são grandezas diferentes — executado em julho pode entrar em outubro, e a
  comissão é sobre o recebido.
- Em **Agenda**: *ocupação reservada* e *ocupação realizada* lado a lado — a
  diferença entre elas é o buraco que a falta abriu.
- **Taxa de falta** e **taxa de cancelamento** são indicadores distintos:
  cancelado avisado liberou o horário e fica fora da base da taxa de falta.
- Mês sem atendimento mostra **"—"**, não 0%: sem base não há taxa.
- Exporte CSV: `/api/relatorios/caixa`, `/producao`, `/procedimentos`, `/agenda`.
  Abra num editor de texto e note que campos que começam com `=` ou `+` saem com
  apóstrofo na frente — é injeção de fórmula no Excel, não paranoia.

Como **admin** → `/auditoria`: cada acesso a prontuário está ali, inclusive
**leitura**. Dado de saúde é sensível na LGPD; ler também é evento auditável.
Tente alterar ou apagar uma linha pelo banco: recusado.

---

## 11. Administração

Como **admin**:

- `/configuracoes` abre pelo **que falta** configurar, com o motivo de cada item
  (sem CNPJ o orçamento sai sem cabeçalho fiscal; sem CRO o atestado não tem valor
  legal). Edite horário de funcionamento e cadeiras.
- **Tente furar:** desative a cadeira que tem atendimento futuro. Recusado —
  remarque antes.
- `/usuarios`: reinicie o segundo fator de alguém (o segredo é **apagado**, nunca
  exibido) e gere nova senha.
- **Tente furar:** desative o único administrador ativo, ou desative a si mesmo.
  Recusado nos dois casos: trancar a clínica fora do próprio sistema deixaria a
  saída só por `UPDATE` no banco.

---

## 12. As travas, num só lugar

Se quiser ver todas de uma vez, sem clicar:

```bash
npm run db:verificar
```

200 casos contra o Postgres real, cada um com o nome do que está sendo provado —
prontuário append-only, soma das parcelas, agenda sem sobreposição, saldo de
estoque nunca negativo, preço de convênio imutável, e por aí.

E as verificações de ponta a ponta, com sessão de verdade:

```bash
docker compose exec app npm run estoque:demo        # FEFO, validade, rastreabilidade
docker compose exec app npm run estoque:telas       # as telas de estoque por HTTP
docker compose exec app npm run admin:verificar     # cadastros e segurança do MFA
docker compose exec app npm run portal:seguranca    # 29 verificações adversariais
docker compose exec app npm run convenio:demo       # ciclo do convênio com os números
docker compose exec app npm run documentos:demo     # anexos, atestado, receita
docker compose exec app npm run relatorios:demo     # indicadores conferidos
docker compose exec app npm run whatsapp:demo       # fila, webhook, efeito na agenda
npm test                                            # 950 testes de domínio
```

---

## 13. O que **não** está verificado

Vale saber antes de confiar:

| Item | Situação |
|---|---|
| **WhatsApp** | Provedor simulado. O código que fala com a Meta nunca executou contra a API real. |
| **XML TISS** | Bem formado, mas nunca validado contra o XSD da ANS nem enviado a operadora. O caminho que fatura é a folha de conferência. |
| **S3/R2** | Anexos vão para disco. A assinatura SigV4 está provada contra os vetores da AWS, mas nunca rodou contra um bucket. |
| **PDF** | Validado estruturalmente e extraído com `pdftotext`, mas **nunca aberto num visualizador por mim**. Layout fino merece uma olhada humana. |
| **13 códigos TUSS** | Em branco de propósito: ou não existem na Tabela 22, ou têm vários candidatos e a escolha muda o valor recebido. Ver `dados/README.md`. |
| **`mfa_secret`** | Em texto claro no banco. Não é bypass (ainda exige senha), mas agrava um vazamento. É a próxima dívida a pagar. |
| **MFA desligado** | `MFA_DESABILITADO=true` no compose de desenvolvimento. Produção se recusa a subir assim, e o teste `lib/auth/segredo.test.ts` prova as duas pontas. |
| **Backup** | `docker/backup.sh` funciona e a restauração é testada, mas o arquivo **não sai cifrado da máquina** — isso é decisão de infraestrutura da clínica. |

---

## Depois do teste

```bash
docker compose exec app npm run demo:limpar   # remove pessoas e dados fictícios
```

O seed de referência (52 dentes, 49 procedimentos, 40 materiais, cadeiras)
permanece — ele não inventa gente.
