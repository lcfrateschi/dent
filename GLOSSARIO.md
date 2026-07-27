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
| **Encaixe** ⚠️ | Agendamento inserido fora da grade padrão, geralmente urgência. É uma `origem`, não um status. **A Fase 19 NÃO fixou esta semântica**: a tabela `lista_espera` é o mecanismo de "quem quer ser chamado se vagar", e de propósito nada nela grava `origem = 'encaixe'`. Quando a recepção oferecer um horário da lista, a origem do agendamento resultante é decisão dela. Falta confirmar com o dentista: encaixe é só urgência, ou também o aproveitamento de uma desmarcação? |

## WhatsApp

| Termo | Definição |
|---|---|
| **Lembrete** | Mensagem enviada antes da consulta pedindo confirmação. Padrão: 24 h antes, sempre dentro de 08:00–20:00 locais. Não menciona procedimento — dado clínico não vai para o WhatsApp. |
| **Chave de idempotência** | Identificador do lembrete (`lembrete:<agendamento>:<início ISO>`). É UNIQUE no banco, então reprocessar não gera segunda mensagem; remarcar muda o início, logo gera lembrete próprio do horário novo. |
| **Fila** | `mensagem_whatsapp`. A ação só insere a linha; quem envia é um processo separado. Chamar a Meta dentro da transação faria rollback de coisa que já aconteceu no mundo. |
| **Travada** | Mensagem reivindicada para envio (`enviando`) que nunca concluiu. **Não é reenviada automaticamente**: pode ter sido entregue. Aparece na tela para decisão humana. |
| **Interpretação** | O que o sistema entendeu da resposta livre do paciente: *confirmou*, *cancelou* ou *não entendido*. Dúvida ("não sei se consigo") é *não entendido* e não altera a agenda. |
| **Reentrega** | A Meta reenvia o webhook quando não recebe 200 rápido. O `wamid` é UNIQUE em `resposta_whatsapp`, então a segunda entrega não reprocessa. |
| **`wamid`** | Identificador da mensagem na Meta. Liga o webhook de status (entregue, lida, falhou) à linha da fila. |
| **Template** | Mensagem pré-aprovada pela Meta, com variáveis posicionais. Obrigatório fora da janela de 24 h desde a última mensagem do paciente. |
| **E.164** | Formato internacional do telefone, sem sinais: `5511987654321`. Celular brasileiro de 8 dígitos ganha o nono; fixo não. |

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
| **Coparticipação** | Parte do valor que o paciente paga quando o plano cobre menos de 100%. Somada à parte da operadora, dá exatamente o total — a sobra do arredondamento é do paciente. |
| **Carência** | Prazo, contado da **adesão do paciente** ao plano, antes do qual o procedimento não é coberto. Sem data de adesão cadastrada, o sistema NÃO assume que passou. |
| **Vigência** | Período em que uma tabela negociada vale. O preço de um procedimento é o vigente na **data da execução**, não o de hoje. |
| **Lote** | Conjunto de guias enviado de uma vez. É como a operadora identifica o protocolo. |
| **Glosa parcial** | A operadora pagou menos que o apresentado. Estado próprio, distinto de "paga": há valor a recorrer. |
| **Recurso de glosa** | Contestação da glosa, com argumento e documento. Vale para erro de preenchimento e falta de documento; não vale para prazo perdido. |
| **Folha de conferência** | Impresso com os campos da guia, para digitar no portal da operadora. É o caminho que fatura hoje — o XML TISS ainda não foi validado. |
| **TUSS** | Terminologia Unificada em Saúde Suplementar. O código vem da Tabela 22 da ANS e **não pode ser inventado**: código errado gera glosa. |

## Documentos e imagens

| Termo | Definição |
|---|---|
| **Documento** | Qualquer arquivo anexado ao prontuário: radiografia, foto clínica, exame, atestado, receita, termo, PDF de orçamento. Guarda de 20 anos como o resto do prontuário. |
| **Etapa** | Momento clínico da imagem: *inicial*, *durante* ou *final*. Inicial + final do mesmo dente formam o antes/depois. Não é a mesma coisa que a data — duas fotos do mesmo dia podem ser as duas pontas de uma restauração. |
| **Data do exame** | Quando a imagem foi feita, que pode ser bem anterior ao envio. É por ela que a lista é ordenada, não pela data do upload. |
| **Chave de armazenamento** | Onde o arquivo mora (`pacientes/<id>/<ano>/<documentoId>.<ext>`). Nunca deriva do nome enviado, e é imutável depois de gravada. |
| **Remoção lógica** | `removido_em` + motivo + autor. O arquivo continua guardado e deixa de ser acessível. **Não se desfaz**: corrigir é remover e enviar de novo. |
| **DICOM** | Formato das imagens de tomógrafo. Identificado pela marca `DICM` no deslocamento 128 do arquivo — é o único formato aceito que não se identifica nos primeiros bytes. |
| **HEIC** | Formato das fotos de iPhone. Aceito, mas não abre direto no navegador: a tela avisa que é preciso baixar. |

## Impressos

| Termo | Definição |
|---|---|
| **Atestado de comparecimento** | Declara que o paciente esteve em atendimento. Sem dias de afastamento. |
| **Afastamento** | Recomendação de repouso, em dias. Escrito em dígito e em palavra ("3 (três) dias") porque dígito sozinho se altera com uma canetada. |
| **CID-10** | Código do diagnóstico. Faixa odontológica: K00 a K14. **Só vai impresso com autorização expressa do paciente** — o atestado costuma ir para o RH da empresa. |
| **Posologia** | Dose, via, intervalo e duração. Sem ela a farmácia não dispensa e o paciente inventa; a receita é recusada na emissão. |
| **Controle especial** | Medicamento da Portaria 344/98 (diazepam, tramadol, codeína…). Exige receituário próprio, numerado e em duas vias — o sistema avisa, mas não bloqueia: quem sabe o que prescreve é o CD. |

## Indicadores

| Termo | Definição |
|---|---|
| **Caixa** | O que ENTROU no período (pagamentos). Não se soma com produção. |
| **Produção** | O que foi EXECUTADO no período, no valor acordado com o paciente. Não é dinheiro em conta. |
| **Conciliado** | Pagamento conferido no extrato. É a base da comissão — ver *Comissão*. |
| **Ocupação reservada** | Minutos de agenda reservados ÷ minutos disponíveis. Conta a falta, que reservou e não liberou. |
| **Ocupação realizada** | Minutos que viraram atendimento ÷ minutos disponíveis. A diferença entre as duas é o custo da falta. |
| **Minutos disponíveis** | Horário de funcionamento × dias do período × profissionais ativos. Não é 24 h. |
| **Taxa de falta** | Faltas ÷ (concluídos + faltas). Cancelado **não** entra na base. |
| **Taxa de cancelamento** | Cancelados ÷ tudo que foi marcado no período. Indicador próprio, não somado à falta. |
| **Efeito da confirmação** | Diferença, em pontos percentuais, entre a falta de quem confirmou e de quem não confirmou. Só é calculada com pelo menos 10 casos de cada lado. |
| **Ticket médio** | Recebido ÷ pacientes DISTINTOS que pagaram. Não por atendimento: seis sessões de um canal não são seis pacientes. |
| **"—" numa taxa** | Não há base para calcular. **Diferente de 0%.** |
| **"do zero"** | Variação a partir de base zero. Não é "+100%" nem "+∞%". |

## Portal do paciente

| Termo | Definição |
|---|---|
| **Realm** | Domínio de autenticação. São dois e não se cruzam: staff (`usuario`) e paciente (`paciente_conta`), com cookies, mecanismos e tipos diferentes. |
| **Convite** | Código de uso único para o primeiro acesso, entregue pela recepção. Vale 7 dias, morre ao ser usado, e aparece **uma vez só** na tela — o banco guarda apenas o hash. |
| **Sessão do portal** | Token aleatório no cookie cujo SHA-256 fica no banco. Dura 12 h, é revogável e não estica o próprio prazo. |
| **Revogar acesso** | Desativa a conta **e encerra as sessões abertas na hora**. Só desativar deixaria quem está logado continuar até o fim do prazo. |
| **IDOR** | Ler dado de outro trocando um id na URL. No portal é impossível por construção: nenhuma consulta aceita `pacienteId` — ele vem sempre da sessão. |
| **Bloqueio por tentativas** | Atraso crescente (1, 5, 15, 60 min) depois de 3 erros. Nunca permanente: bloqueio eterno seria negação de serviço contra o paciente. |

## Estoque (Fase 14)

| Termo | Definição |
|---|---|
| **Material** | Insumo do consultório: anestésico, resina, luva, implante. A `unidade` é a de **consumo** (tubete, par, ml), não a de compra. |
| **Embalagem** | Como o fornecedor vende. `unidades_por_embalagem` converte no recebimento: 2 caixas de 100 luvas entram como 200, não como 2. |
| **Lote de material** | Um recebimento: material + lote do fabricante + validade + custo. Chama-se `lote_material` porque no TISS "lote" é o protocolo que agrupa guias — dois "lotes" no mesmo sistema seria ambiguidade garantida. |
| **Saldo** | Soma dos movimentos do lote. Nunca um número digitado: é mantido por trigger e tem CHECK de não-negativo. |
| **Movimento** | Linha do livro de estoque: entrada, consumo, descarte, devolução, ajuste. Quantidade **assinada** (entrada positiva, saídas negativas). **Append-only**, como a evolução. |
| **FEFO** | *First Expired, First Out* — sai primeiro o que **vence** primeiro, não o que chegou primeiro. Não é sinônimo de FIFO: a compra de reposição costuma vir com validade mais curta que a caixa que está na prateleira. |
| **Ajuste de inventário** | Movimento que acerta o saldo pelo que foi **contado**. Exige motivo: sem ele, perda de material e erro de lançamento ficam indistinguíveis. |
| **Ponto de reposição** | `quantidade_minima`. Abaixo dele o material entra na lista de compras. A sugestão repõe ao **dobro** do mínimo — repor ao mínimo faria o alerta disparar no dia seguinte à entrega. |
| **Cobertura** | Dias que o saldo cobre no ritmo de consumo dos últimos 90 dias. Sem consumo no período não há projeção (nem "infinito"). |
| **Ficha técnica** | `insumo_procedimento`: o que cada procedimento consome. Serve para **propor** a baixa, nunca para executá-la sozinha — rastreabilidade que afirma um lote não usado é pior que nenhuma. |
| **Rastreabilidade de lote** | Responder "em quais pacientes este lote foi usado" quando o fabricante recolhe um lote. É o motivo de `movimento_estoque.execucao_id` existir. |
| **Material controlado** | Sujeito à Portaria 344/98 da Anvisa. Toda saída exige profissional responsável e motivo — cobrado por trigger, não por disciplina de tela. |

## Administração (Bloco 1)

| Termo | Definição |
|---|---|
| **Senha temporária** | Senha gerada pelo sistema e entregue pelo admin. Aparece **uma vez** (o banco guarda o hash) e tem de ser trocada no primeiro acesso: senha que passou por terceiro é senha comprometida. |
| **Reset de MFA** | Apagar o segredo do autenticador para a pessoa reconfigurar — o caminho de quem trocou de celular. O admin **nunca vê** o segredo. |
| **Último administrador** | Não se desativa nem se rebaixa. Sem admin ativo, a clínica fica trancada fora do próprio sistema e a saída é mexer no banco. |
| **Vigência de preço** | Período em que um valor negociado vale. Reajuste é vigência **nova**, e a anterior fecha no dia anterior — dois preços válidos no mesmo dia tornariam indefinido o valor a faturar. |
| **Carteirinha** | Vínculo do paciente com uma operadora (`paciente_convenio`). Uma ativa por operadora. A **data de adesão** é a base da contagem de carência. |
| **Pendência de configuração** | O que falta para um documento sair correto: sem CNPJ o orçamento sai sem cabeçalho fiscal, sem CRO o atestado não tem valor legal. A tela de ajustes abre por essa lista. |

## Periodontia e profundidade clínica (Fase 21)

> ⚠️ **Esta seção inteira precisa de validação.** Quem a modelou não é dentista. Os
> termos marcados **[PADRÃO]** são protocolo internacional verificável em fonte; os
> marcados **⚠️ [ESCOLHA]** são decisão de modelagem, e cada um diz o que foi escolhido
> e por quê. Campo errado num exame clínico não é bug de software: é diagnóstico que
> não se sustenta.

| Termo | Definição |
|---|---|
| **Periograma** [PADRÃO] | Exame periodontal completo: 6 sítios por dente, com profundidade de sondagem, margem gengival, sangramento e supuração; mais mobilidade e furca por dente. São ~192 medidas numa boca completa. |
| **Sítio** [PADRÃO] | Um dos seis pontos de sondagem de um dente: mésio-vestibular, vestibular, disto-vestibular e os três correspondentes do lado oral. **O lado oral é palatina no superior e lingual no inferior** — mesma regra das faces do odontograma. O enum tem nove valores e um CHECK por arcada: "palatina no 36" é impossível de gravar. |
| **PS — profundidade de sondagem** [PADRÃO] | Da margem gengival ao fundo da bolsa, em mm. |
| **Recessão / margem gengival** [PADRÃO] | Da junção cemento-esmalte à margem gengival. **Positivo = recessão** (raiz exposta); **negativo = aumento gengival** (a margem cobre a coroa). O sinal negativo é o que impede superestimar o NIC de quem tem hiperplasia. |
| **NIC — nível de inserção clínica** [PADRÃO] | `PS + recessão`. **É DERIVADO — coluna `GENERATED ALWAYS` no banco, que recusa escrita.** É o número que diz se a doença progrediu: a bolsa pode encolher só porque a gengiva retraiu (PS 6→3 com recessão 0→3 é NIC constante em 6). Mesmo princípio de "glosa é calculada, nunca digitada". |
| **Mobilidade (Miller)** [PADRÃO] | 0 a III por dente. `0` = sem mobilidade detectável. |
| **Furca (Glickman)** [PADRÃO] | I a IV, com `0` = examinada sem envolvimento. **Só existe em dente multirradicular.** |
| **Comparação emparelhada** ⚠️ [ESCOLHA] | Comparar dois exames **só nos sítios presentes nos dois**. Dente extraído no intervalo desaparece com seus sítios — que são os piores, porque foi por isso que ele saiu — e a comparação ingênua mostra melhora espetacular no paciente que perdeu o dente. A perda dentária é reportada à parte, como o desfecho grave que é. |
| **Ordem de laboratório** | A peça sai, o laboratório trabalha, a peça volta. Pende de `item_plano` (a prótese é linha do plano, não cadastro solto) e **não gera despesa automática**: o laboratório fatura por mês, e uma despesa por peça não casaria com a nota. `custo` é o valor combinado; a despesa é a nota. |
| **Refação** | Ordem **nova** apontando para a anterior (`refaz_id`), com motivo obrigatório — não é uma situação. "Quem paga a refação" é pergunta que precisa das duas linhas. |
| **Ciclo / carga** | Uma leva de instrumental na autoclave, com número que **reinicia a cada dia** e vai na etiqueta do pacote. Por isso o dia civil é coluna gravada, não derivada de `iniciado_em`: uma carga das 21h em São Paulo é "amanhã" em UTC. |
| **Indicador químico** [PADRÃO] | Fita que muda de cor e sai junto com a carga. |
| **Indicador biológico** [PADRÃO] | Esporos que precisam de incubação — **o resultado sai dias depois**. Por isso o ciclo nasce `pendente` e é atualizado, e `certificado` é coluna gerada: pendente não certifica, positivo não certifica. |
| **Proposta alternativa** | Vários planos no mesmo `grupo_proposta`, mutuamente exclusivos (implante × prótese fixa). Vivem em `rascunho`; no máximo um chega a `ativo`. **Qual o paciente escolheu já está no orçamento**, que é o documento congelado — não é duplicado aqui. |

### ⚠️ O que precisa do dentista, item por item

1. **Furca no primeiro pré-molar superior (14 e 24).** Ele tem duas raízes na maioria
   das pessoas, e está **fora** de `dente_multirradicular()`. A escolha é conservadora:
   deixar de fora perde informação e o dentista percebe (o campo não aparece); deixar
   dentro permitiria registrar furca em dente de raiz única, e ninguém perceberia.
   Entre perder e inventar, o projeto perde. **Confirmar** — é uma linha na função.
2. **Exclusão da dentição decídua.** O periograma só aceita 11–48. Motivo: mobilidade
   de Miller num decíduo pré-esfoliação mede o oposto de doença. **Confirmar** se a
   clínica registra periodonto em criança.
3. **Faixas numéricas.** PS de 0 a 15 mm (o limite é do instrumento: a sonda UNC-15
   marca até 15). Recessão de −10 a +20. **Confirmar** se recusam algum achado real.
4. **Índice de placa não foi modelado.** É comum no periograma (O'Leary) e ficou fora
   por não ter sido pedido — acrescentar é uma coluna. **Confirmar** se a clínica o
   registra.
5. **Limiares de bolsa** em 4 mm e 6 mm para as contagens. São os usuais; **confirmar**.

### ⚠️ Esterilização: o que a RDC 15 pede além disto

O registro cobre equipamento, responsável, data, parâmetros do ciclo e os dois
indicadores. **Não** cobre: qualificação térmica do equipamento, periodicidade do
teste biológico, POP escrito, registro da limpeza prévia do instrumental, e
**rastreabilidade do pacote até o paciente** — que exigiria uma entidade que não
existe aqui (o pacote, com etiqueta, ligado ao ciclo na embalagem e à execução na
abertura). `conteudo` é texto livre, que é o que se faz no papel, e **texto livre não
é rastreabilidade**: se um biológico voltar positivo, o sistema diz o ciclo e o dia,
não a lista de pacientes.

Dizer "conformidade com a RDC 15" seria o mesmo erro de dizer que o XML TISS está
aceito pela operadora porque é válido contra o XSD.

## LGPD

| Termo | Definição |
|---|---|
| **Dado sensível** | Dado de saúde é sensível por definição legal. Todo acesso é auditável — inclusive leitura. |
| **Base legal** | Fundamento do tratamento do dado: consentimento, tutela da saúde, ou obrigação legal. Registrado por paciente. |
| **Consentimento** | Aceite versionado de um termo específico, com data, IP e hash do texto aceito. Revogável. |
| **Consentimento de WhatsApp** | Consentimento com `finalidade = 'contato_whatsapp'`. Exigido por trigger antes de qualquer mensagem entrar na fila: o dado sai da clínica para infraestrutura de terceiro, por uma finalidade de comodidade. Revogar cancela o que ainda não saiu. |
| **Titular** | Na LGPD, o paciente (dono do dado). Não confundir com titular de convênio. |
| **Retenção** | Prontuário odontológico: guarda mínima de 20 anos (CFO). Anonimização só depois disso. |
