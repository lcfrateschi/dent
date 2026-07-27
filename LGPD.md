# LGPD — o que muda quando o Facilident deixa de ser sistema e passa a ser produto

> **Isto não é parecer jurídico e não substitui advogado.** É o levantamento de
> engenharia: o que o software já faz, o que ele **não** faz, e quais decisões
> precisam de quem responde juridicamente pela empresa. Onde está escrito
> **⚖️ EXIGE ADVOGADO**, é porque a resposta muda conforme contrato, jurisprudência e
> apetite de risco — coisas que não se deduzem do código.

## A mudança de papel, que é a raiz de tudo

Enquanto o Facilident rodava para **uma** clínica, num servidor dela, a clínica era a
**controladora** dos dados e ponto. Como produto multicliente, aparecem dois papéis
distintos (art. 5º, VI e VII da LGPD):

| Papel | Quem | O que decide |
|---|---|---|
| **Controlador** | cada clínica | por que e como o dado do paciente é tratado |
| **Operador** | nós | trata o dado **em nome** da clínica, seguindo as instruções dela |

Isso não é formalidade. Muda a quem o paciente reclama, quem responde a incidente,
quem assina o quê — e cria obrigações que o software sozinho não cumpre (art. 39: o
operador deve tratar conforme as instruções do controlador).

Dado de saúde é **dado pessoal sensível** (art. 5º, II). Prontuário odontológico tem
guarda mínima de 20 anos por resolução do CFO. As duas coisas juntas são o motivo de
quase todas as decisões técnicas deste documento.

---

## O que o software JÁ faz

Não é pouco, e vale listar porque um contrato de tratamento vai perguntar por cada
item:

- **Isolamento entre clientes é estrutural, não disciplinar.** `clinica_id` em 40
  tabelas, Row Level Security com `FORCE`, política de `USING` **e** `WITH CHECK`, e
  a aplicação conectando por uma role que **não é dona das tabelas** e não tem
  `BYPASSRLS` — sem isso a política seria decorativa. Provado por
  `npm run tenant:seguranca` (atravessamento por HTTP, com contraprova que desliga a
  política e exige que o vazamento apareça) e `docker/verificar-rls.sql`.
- **Leitura de prontuário é evento auditável**, não só escrita. `audit_log` grava
  quem olhou o quê e quando, e **nunca** o conteúdo clínico — copiar o texto da
  evolução para o log criaria uma segunda cópia do prontuário fora das regras de
  retenção.
- **Prontuário é append-only por trigger** (`evolucao`), correção é nova linha com
  `retifica_id`. Remoção de documento é de mão única, com motivo.
- **Anexo não é servido por URL assinada.** Os bytes passam pela aplicação, que
  autoriza e audita cada acesso — URL assinada é encaminhável, e quem recebe o link
  vê a radiografia sem sessão e sem deixar rastro.
- **Dois realms de autenticação** (staff e paciente), sem FK entre eles, com uma
  migration que falha o deploy se alguém criar uma.
- **Exportação por clínica**, que atende portabilidade (art. 18, V) e devolução de
  dados no fim do contrato.
- **Segundo fator obrigatório para staff**; senha criada por admin é temporária.
- **A mensagem de WhatsApp não carrega dado clínico** — só nome, profissional, data
  e hora. A tela do celular do paciente é lida por outras pessoas.
- **Consentimento com versão do termo, hash do texto, IP e user-agent**, e assinatura
  do responsável legal quando o paciente é menor.
- **CID no atestado só com autorização expressa**, e a tela diz quando não imprimiu.

## O que o software NÃO faz — e isso é bloqueante para vender

Cada item aqui é uma frase que **não se pode escrever** num contrato de tratamento
hoje:

1. **Backup não sai cifrado nem sai da máquina.** `docker/backup.sh` empacota banco +
   anexos no mesmo disco do banco. Isso protege contra `DROP TABLE`, **não** contra o
   disco morrer nem contra ransomware. Backup de prontuário é dado sensível: em
   produção tem de sair cifrado e ir para outro lugar físico.
2. **`usuario.mfa_secret` está em texto claro.** Não é bypass de autenticação (a senha
   continua exigida), mas agrava um vazamento de banco. Cifrar exige chave fora do
   banco e rotação.
3. **Não há cifragem em repouso do banco** além do que o disco/instância ofereça.
4. **Não há registro de operações de suporte.** Quando alguém nosso precisar olhar o
   banco de um cliente para resolver um problema, isso é **acesso a dado sensível de
   paciente por um terceiro** — e hoje não existe trilha disso, porque o acesso é por
   `psql` com a credencial do dono. Um contrato sério exige registro e justificativa.
5. **Não há encarregado (DPO) designado** nem canal publicado para o titular.
6. **Não há plano de resposta a incidente** escrito: quem avisa a ANPD e os
   controladores, em quanto tempo, com que conteúdo.
7. **Não há contrato de tratamento** com as clínicas.
8. **Suboperadores não estão mapeados.** A Meta (WhatsApp Cloud API) trata número de
   telefone e nome de paciente. Se o armazenamento for S3/R2, o provedor guarda
   radiografia. Provedor de e-mail idem. Cada um é suboperador e precisa estar
   declarado no contrato — o controlador tem direito de saber quem toca o dado dele.

---

## As decisões que precisam de quem responde juridicamente

### ⚖️ EXIGE ADVOGADO — retenção depois do cancelamento

`assinatura.retencao_ate` existe e está **`NULL` de propósito**. O mecanismo está
pronto; o prazo não é decisão de engenharia, e eu não vou inventá-lo, porque um
`default '90 dias'` no schema pareceria decisão tomada e seria só um palpite apagando
prontuário alheio.

O nó é este: o prontuário tem guarda de **20 anos** e o controlador é a **clínica**,
não nós. Quando o contrato acaba:

- se apagarmos, podemos estar destruindo registro que a clínica é obrigada a manter —
  e o paciente perde o histórico;
- se guardarmos indefinidamente, somos operador retendo dado sensível sem instrução
  do controlador nem base legal própria.

A saída praticada no mercado é entregar a base ao controlador (exportação) e então
apagar, com prazo curto e comprovante de entrega. **Qual prazo, com que forma de
comprovação e o que fazer se a clínica não retirar** é cláusula contratual.

### ⚖️ EXIGE ADVOGADO — o que a clínica suspensa continua podendo

Decisão técnica **já tomada e travada no banco**, porque ela é a que mais facilmente
viraria abuso: **suspensão bloqueia escrita e NUNCA leitura nem exportação de
prontuário.** Retê-lo como alavanca de cobrança é indefensável, e a exceção está na
forma da trava (política restritiva que alcança só `INSERT` e `UPDATE`), não num `if`
que a próxima refatoração remove. Provado em `docker/verificar-assinatura.sql`.

O que precisa de advogado é o **contorno comercial**: por quanto tempo a leitura
continua depois da suspensão, se há aviso prévio, e como isso aparece no contrato.

### ⚖️ EXIGE ADVOGADO — base legal do tratamento

Dado sensível de saúde tem hipóteses próprias (art. 11). Para atendimento
odontológico a tutela da saúde por profissional (art. 11, II, "f") é o caminho usual,
e **consentimento não é a base para o essencial** — pedir consentimento para o que se
faz por obrigação legal cria a ilusão de que o paciente pode revogar e o tratamento
para. O sistema já registra consentimento com versão e finalidade; **quais
finalidades exigem consentimento e quais não** é análise jurídica.

### ⚖️ EXIGE ADVOGADO — transferência internacional

Se o armazenamento de anexos for S3/R2 em região fora do Brasil, há transferência
internacional de dado sensível (arts. 33 a 36). Hoje o padrão é disco local, o que
evita a questão — mas o código de S3 existe e a decisão aparece no dia em que ele for
ligado.

---

## O que dá para fazer sem advogado, e em que ordem

Por relação entre risco reduzido e esforço:

1. **Cifrar o backup e mandá-lo para fora da máquina.** É o maior risco aberto e é
   trabalho de infraestrutura, não de contrato.
2. **Cifrar `mfa_secret`.** Precisa de chave fora do banco e rotação.
3. **Registrar acesso de suporte.** Se a operação precisa olhar dado de cliente, isso
   passa a exigir uma trilha — hoje é o único acesso a prontuário que não deixa
   rastro no `audit_log`, e é justamente o de quem tem mais poder.
4. **Declarar os suboperadores** numa página que o contrato possa referenciar.

## O que este documento não é

Não é política de privacidade, não é contrato de tratamento, não é relatório de
impacto (RIPD). Os três são exigíveis e nenhum deles se escreve a partir do código —
mas todos vão pedir os fatos que estão aqui.
