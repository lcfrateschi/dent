# Glossário do domínio

A linguagem aqui é a linguagem do código. Se a clínica chama de "evolução", a tabela se chama
`evolucao` — não `nota`, não `registro`.

> **Pendente de validação com o dentista.** Os termos marcados com ⚠️ são os que mais variam
> entre clínicas. Confirme cada um antes da Fase 4 — mudar depois custa migration.

## Pessoas

| Termo | Definição |
|---|---|
| **Paciente** | Pessoa atendida. Tem prontuário. Pode não ter conta no portal. |
| **Responsável legal** | Paciente maior que responde por um menor. Assina consentimento e orçamento no lugar dele. Um paciente pode ser responsável por vários. |
| **Profissional** | Dentista com CRO. Executa procedimento e assina evolução. Tem percentual de comissão. |
| **Staff** | Qualquer usuário interno: dentista, recepção, financeiro, admin. Autenticação separada do paciente. |
| **Titular** ⚠️ | No convênio, quem contratou o plano. O paciente pode ser dependente de um titular que não é paciente da clínica. |

## Clínico

| Termo | Definição |
|---|---|
| **Prontuário** | O conjunto completo e permanente do histórico clínico do paciente. Não é uma tabela — é a visão agregada de anamnese, evoluções, execuções, documentos e imagens. |
| **Anamnese** | Questionário de saúde geral. **Versionada**: refazer não sobrescreve, cria versão nova. Comparar versões é clinicamente relevante. |
| **Alerta clínico** | Condição que precisa aparecer em *toda* tela do paciente: alergia, uso de anticoagulante, diabetes, gravidez. Derivado da anamnese, mas editável à mão. |
| **Evolução** | Registro do que aconteceu num atendimento, assinado pelo profissional. **Append-only por lei.** |
| **Retificação** ⚠️ | Correção de uma evolução. Nova evolução com `retifica_id` apontando para a anterior. A original permanece visível e legível. Nunca é edição. |
| **Odontograma** | Representação visual dos 52 dentes com estado atual e planejado. É uma *visualização* de `item_plano` + `execucao`, não uma tabela. |
| **Dente** | Identificado por **FDI**: 11–18, 21–28, 31–38, 41–48 (permanentes) e 51–55, 61–65, 71–75, 81–85 (decíduos). 52 no total. |
| **Face** | Superfície do dente: mesial, distal, vestibular, oclusal (posteriores), incisal (anteriores), lingual (inferiores), palatina (superiores), cervical. **As faces válidas dependem do tipo e da arcada do dente.** |
| **Dentição mista** | Fase em que decíduos e permanentes coexistem (~6 a 12 anos). O odontograma precisa mostrar as duas. |

## Tratamento

| Termo | Definição |
|---|---|
| **Procedimento** | Item do *catálogo*: "restauração de resina composta". Tem código TUSS e valor particular. É um tipo, não um evento. |
| **Plano de tratamento** | O que se pretende fazer para um paciente. Conjunto de itens. Vivo — muda conforme o tratamento avança. |
| **Item de plano** | Uma linha do plano: procedimento + dente + faces + valor + cobertura. **É a unidade que tem status e que vira dinheiro.** |
| **Execução** | Registro de que um item de plano foi de fato realizado: por qual profissional, quando. |
| **Orçamento** ⚠️ | Documento **congelado** derivado do plano, com validade e valor. Se o plano muda depois de enviado, o orçamento não muda — gera-se outro. |
| **Aprovado** ⚠️ | Item de plano que o paciente autorizou. Ainda não foi executado nem cobrado. |
| **Executado** | Procedimento realizado. Gera evolução. Ainda não necessariamente faturado. |

## Agenda

| Termo | Definição |
|---|---|
| **Agendamento** | Reserva de profissional + cadeira + intervalo de tempo para um paciente. |
| **Cadeira** | Recurso físico do consultório. Restringe atendimentos simultâneos junto com o profissional. |
| **Bloqueio** | Intervalo indisponível sem paciente: almoço, férias, manutenção. Pode ser do profissional, da cadeira, ou de toda a clínica. |
| **Confirmado** | Paciente respondeu que vem. Registra por qual canal (WhatsApp, telefone, portal). |
| **Compareceu** ⚠️ | Distinto de *confirmado*. Confirmou = disse que vem. Compareceu = chegou. Modelado como `em_atendimento`/`concluido`. |
| **Faltou (no-show)** | Não compareceu e não avisou. Métrica que o WhatsApp da Fase 9 existe para reduzir. |
| **Encaixe** ⚠️ | Agendamento inserido fora da grade padrão, geralmente urgência. É uma `origem`, não um status. |

## Financeiro

| Termo | Definição |
|---|---|
| **Cobrança** | Compromisso financeiro total do paciente sobre um orçamento aprovado. |
| **Parcela** | Fração da cobrança com vencimento próprio. A soma das parcelas é sempre igual ao total da cobrança. |
| **Pagamento** | Entrada de dinheiro contra uma parcela. Uma parcela pode receber pagamentos parciais. |
| **Faturado** ⚠️ | Item executado que já foi lançado para cobrança — no particular, para a cobrança do paciente; no convênio, para uma guia. |
| **Recebido** | O dinheiro entrou e foi conciliado. |
| **Inadimplência** | Parcela vencida e não paga. |
| **Comissão** | Percentual do profissional, calculado sobre o valor **recebido** — decidido pela clínica em 2026-07-26. Só entra na base depois de o dinheiro entrar e ser conciliado, não na execução. Protege o fluxo de caixa: comissão paga sobre execução vira adiantamento quando o paciente atrasa. |

## Convênio (Fase 13, mas o vocabulário entra agora)

| Termo | Definição |
|---|---|
| **Convênio** | Operadora de plano odontológico. Tem registro ANS e prazo de pagamento. |
| **Carteirinha** | Identificação do paciente no convênio. Tem validade. |
| **Cobertura** | Se um item é *particular* ou de *convênio*. Determina de onde vem o valor: `procedimento.valor_particular` ou `preco_convenio.valor`. |
| **TISS** | Padrão da ANS para troca de informação em saúde suplementar. Define o formato das guias. |
| **Guia** | Documento enviado ao convênio pedindo pagamento dos procedimentos executados. |
| **Glosa** | Recusa, total ou parcial, de um item da guia pelo convênio. Precisa de motivo e permite recurso. |
| **Repasse** | Pagamento do convênio para a clínica, geralmente agregando muitas guias. Exige conciliação item a item. |

## LGPD

| Termo | Definição |
|---|---|
| **Dado sensível** | Dado de saúde é sensível por definição legal. Todo acesso é auditável — inclusive leitura. |
| **Base legal** | Fundamento do tratamento do dado: consentimento, tutela da saúde, ou obrigação legal. Registrado por paciente. |
| **Consentimento** | Aceite versionado de um termo específico, com data, IP e hash do texto aceito. Revogável. |
| **Titular** | Na LGPD, o paciente (dono do dado). Não confundir com titular de convênio. |
| **Retenção** | Prontuário odontológico: guarda mínima de 20 anos (CFO). Anonimização só depois disso. |
