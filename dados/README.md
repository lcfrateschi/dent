# Dados de referência oficiais

## `tuss22-odontologia.csv` — Tabela 22 da ANS, faixa odontológica

**Procedência.** Baixado da **API oficial da ANS** em **26/07/2026**:

```
https://consulta-ocl.apps.sa-1a.mendixcloud.com/rest/oclservice/ANS/concepts/tuss-22?page=N
```

Essa API é o canal que a própria ANS indica na página
[Códigos da TUSS](https://www.gov.br/ans/pt-br/assuntos/prestadores/padrao-para-troca-de-informacao-de-saude-suplementar-2013-tiss/codigos-da-tuss),
que desde 2025 publica a TUSS pelo Open Concept Lab em vez de planilha.

**O que tem.** A Tabela 22 completa traz **5.966 conceitos** (medicina, odontologia,
materiais). Este arquivo é o recorte odontológico — a faixa **81 a 87** —, com
**370 códigos**, todos vigentes na data do download (`fim_vigencia` vazio):

| Prefixo | Códigos | Área |
|---|---|---|
| 81 | 39 | consulta, radiologia, documentação |
| 82 | 105 | cirurgia buco-maxilo-facial |
| 83 | 9 | odontopediatria |
| 84 | 14 | prevenção |
| 85 | 137 | dentística, endodontia, periodontia, prótese, implante |
| 86 | 56 | ortodontia e ortopedia funcional |
| 87 | 10 | pacientes com necessidades especiais |

**Essa distribuição corrigiu um bug do projeto.** A validação de faixa aceitava
apenas `81xxxxxx`, o que recusaria **331 dos 370 códigos válidos** — a maioria da
odontologia está em 82 e 85. Ver `ehFaixaOdontologica` em `lib/domain/tuss.ts`.

**Quando atualizar.** A ANS revisa a tabela periodicamente e códigos ganham
`fim_vigencia`. Rebaixe o arquivo e reimporte quando a operadora avisar de código
descontinuado, ou pelo menos uma vez por ano.

## `tiss-xsd-3.05.00/` — o schema oficial do padrão TISS

Sete arquivos XSD baixados de `http://www.ans.gov.br/padroes/tiss/schemas/` em
2026-07-27, **sem edição**, com hashes em `SHA256SUMS` e a procedência detalhada em
`tiss-xsd-3.05.00/PROCEDENCIA.md`.

Servem para uma coisa só: `npm run tiss:validar` prova que o XML que o sistema gera
é **estruturalmente válido** contra o schema da ANS. Até existirem, o `CLAUDE.md`
dizia *"o XML TISS nunca foi validado contra o XSD"* — e quando o schema entrou,
apareceram seis erros estruturais que nenhum parser pega.

⚠️ **Não edite estes arquivos.** XSD ajustado por nós valida qualquer coisa; se o
nosso XML não passar, o conserto é em `lib/tiss/exportar.ts`.

## `mapeamento-catalogo-tuss.csv` — o que já está ligado

36 dos 49 procedimentos do catálogo têm correspondência **inequívoca** na tabela
oficial e já vêm com código no seed. Importar de novo é seguro:

```bash
docker compose exec app npm run tuss:importar -- dados/mapeamento-catalogo-tuss.csv
```

## Os 13 que faltam — e por que não fui eu que decidi

Nenhum destes foi mapeado, e a razão em cada caso é uma destas duas:
**a Tabela 22 não tem o procedimento**, ou **tem vários e a escolha muda o valor
recebido**. Escolher no lugar da clínica geraria glosa em nome dela.

### Não existem na Tabela 22 (não são faturáveis a convênio)

| Catálogo | Situação |
|---|---|
| `CIR-004` Frenectomia lingual ou labial | Não há código com "frenectomia" nem "freio" na faixa 81–87. Verificar com a operadora se aceita outro código de cirurgia; senão, é particular. |
| `CONS-002` Consulta de retorno | A Tabela 22 tem `81000030` (consulta), `81000049` (urgência) e `81000065` (inicial). Retorno não tem código próprio — normalmente não é faturável. |
| `PREV-004` Orientação de higiene bucal | Sem código próprio. Costuma estar embutida na consulta ou na profilaxia. |
| `ORTO-003` Remoção de aparelho fixo | Sem código de remoção. Verificar se a operadora inclui na manutenção. |
| `RAD-003` Documentação ortodôntica completa | Não é um código: é um conjunto. Os componentes existem separados — `81000308` (modelos ortodônticos), `81000480` (telerradiografia com traçado), `81000537` (traçado cefalométrico). **A clínica decide se desmembra o item.** |

### Existem vários — a clínica escolhe

| Catálogo | Candidatos oficiais |
|---|---|
| `ENDO-004` Retratamento endodôntico | `85200115` unirradicular · `85200093` birradicular · `85200107` multirradicular. O catálogo já separa o *tratamento* em três; o retratamento deveria seguir igual. |
| `PROT-001` Coroa provisória | `85400084` sem pino · `85400076` com pino |
| `PROT-006` Prótese parcial removível | `85400386` com grampos bilateral · `85400378` com encaixes de precisão · `85400394` provisória em acrílico |
| `ORTO-001` Instalação de aparelho fixo | `86000098` metálico · `86000063` estético · `86000110` metálico parcial · `86000080` estético parcial |
| `ORTO-004` Contenção ortodôntica | `86000209` contenção fixa por arcada · `86000608` placa de contenção |
| `IMP-002` Prótese sobre implante | Mais de 15 códigos na faixa `855000xx` (coroa provisória, metalocerâmica, metaloplástica, overdenture, protocolo Branemark…). |
| `IMP-003` Enxerto ósseo | `82000581` osso autógeno da linha oblíqua · `82000603` do mento · `82000620` osso liofilizado · `82000646` conjuntivo subepitelial · `82000662` gengival livre · `82000689` pediculado |
| `PED-001` Restauração em dente decíduo | A Tabela 22 só tem `83000135` **atraumática** em decíduo. Restauração comum em decíduo usa os códigos de resina/ionômero (`851001xx`), sem distinção de dentição. |

**Como resolver:** acrescente a linha no `mapeamento-catalogo-tuss.csv` com o código
escolhido e rode o importador de novo. Ou desmembre o item do catálogo (caso de
`ENDO-004` e `RAD-003`), que é o caminho mais correto quando a operadora paga
valores diferentes por variação.

## Sobre confiar nestes dados

Os 370 códigos vieram da API da ANS e não foram editados — o arquivo é o recorte
bruto, com vigência. O **mapeamento**, sim, é interpretação minha: liguei cada
procedimento do catálogo ao código cuja descrição oficial corresponde sem margem
de dúvida. Onde havia dúvida, deixei em branco e listei os candidatos acima.

Vale conferir o mapeamento com quem fatura na clínica antes do primeiro envio real.
Um código plausível e errado é glosa que aparece semanas depois.
