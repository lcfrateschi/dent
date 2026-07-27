# XSD do padrão TISS 3.05.00 — procedência

**Baixado em 2026-07-27** de `http://www.ans.gov.br/padroes/tiss/schemas/`, que é
simultaneamente o *namespace* declarado nos documentos (`xmlns:ans`) e o local de
publicação da ANS. Os arquivos **não foram editados**.

| Arquivo | Bytes | URL |
|---|---|---|
| `tissV3_05_00.xsd` | 5.878 | `.../tissV3_05_00.xsd` |
| `tissSimpleTypesV3_05_00.xsd` | 149.386 | `.../tissSimpleTypesV3_05_00.xsd` |
| `tissComplexTypesV3_05_00.xsd` | 61.517 | `.../tissComplexTypesV3_05_00.xsd` |
| `tissGuiasV3_05_00.xsd` | 64.314 | `.../tissGuiasV3_05_00.xsd` |
| `tissAssinaturaDigital_v1.01.xsd` | 1.088 | `.../tissAssinaturaDigital_v1.01.xsd` |
| `tissSimpleTypesV3_04_01.xsd` | 149.366 | `.../tissSimpleTypesV3_04_01.xsd` |
| `xmldsig-core-schema.xsd` | 10.559 | `.../xmldsig-core-schema.xsd` (cópia do W3C servida pela ANS) |

Os hashes estão em `SHA256SUMS`. Confira com `sha256sum -c SHA256SUMS`.

## Por que sete arquivos, e não um

O schema principal é um invólucro de 5 KB: ele `include`/`import` os outros. Validar
apenas com ele **falha por importação faltando** — e o fechamento é transitivo:
`tissGuias` inclui `tissAssinaturaDigital`, que inclui `xmldsig-core-schema`;
`tissComplexTypes` referencia ainda o `tissSimpleTypes` da versão **3.04.01**
(sim, o schema da 3.05.00 aponta para um arquivo da versão anterior — é assim na
origem, e por isso ele está aqui).

Quem quiser refazer o download: comece pelo principal e siga todo `schemaLocation`
até não aparecer nome novo. Atenção ao `grep`: os arquivos são **ISO-8859-1** e o
`grep` os trata como binários — use `grep -a`.

## Como saber que é o oficial

Três coisas conferem, e nenhuma delas sozinha basta:

1. **A URL é o próprio namespace** que o padrão define para os documentos TISS
   (`http://www.ans.gov.br/padroes/tiss/schemas`), servida pelo domínio da ANS.
2. **O conteúdo se identifica**: `<!--VERSÃO TISS 3.05.00 - Mensagens do Padrão TISS-->`
   no topo, e `dm_versao` enumera exatamente as versões publicadas do padrão
   (3.03.01 … 3.05.00).
3. **Os domínios batem com a realidade documentada**: `dm_UF` são os códigos IBGE,
   `dm_tabela` descreve a Tabela 22 como "TUSS — Procedimentos e eventos em saúde",
   `dm_CBOS` traz a faixa 2232xx de cirurgião-dentista.

⚠️ **Não corrija nem "melhore" estes arquivos.** Um XSD editado por nós valida
qualquer coisa e não prova nada — seria o mesmo que apagar o teste. Se o nosso XML
não passar, o conserto é em `lib/tiss/exportar.ts`.

## Licença

Padrão público editado pela ANS (agência reguladora federal), publicado para uso
obrigatório por prestadores e operadoras. Redistribuído aqui sem modificação, para
que a validação seja reproduzível sem depender de a URL continuar no ar — o que já
mudou de lugar entre versões do padrão.
