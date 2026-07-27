#!/usr/bin/env python3
"""
Conta, num CSV exportado, as linhas cujo `clinica_id` não é o esperado.

Escreve na saída um número, ou `SEM_COLUNA`, ou `VAZIO`. Chamado por
`docker/exportar-clinica.sh` com `CSV` e `ID` no ambiente — pelo ambiente e não por
argumento porque caminho e uuid não têm de passar por interpretação de shell.

Existe como arquivo separado, e não embutido no shell, porque a versão embutida
precisava de heredoc dentro de heredoc — que é como se escreve um script que quebra
na primeira edição.

Por que Python e não `awk -F,`: ver o comentário no ponto de chamada. Resumo: `awk`
não conhece campo entre aspas, e um `evolucao.texto` com vírgula desloca as colunas.
O deslocamento erra nos dois sentidos — acusa linha sadia e pode deixar passar linha
alheia.
"""

import csv
import os
import sys

caminho = os.environ["CSV"]
esperado = os.environ["ID"]

with open(caminho, newline="", encoding="utf-8") as arquivo:
    leitor = csv.reader(arquivo)
    try:
        cabecalho = next(leitor)
    except StopIteration:
        print("VAZIO")
        sys.exit(0)

    if "clinica_id" not in cabecalho:
        print("SEM_COLUNA")
        sys.exit(0)

    coluna = cabecalho.index("clinica_id")
    # Linha curta conta como estranha: CSV truncado não é dado confiável, e tratá-la
    # como "sem clinica_id, tudo bem" seria a checagem se calando no pior caso.
    fora = sum(
        1
        for linha in leitor
        if len(linha) <= coluna or linha[coluna] != esperado
    )
    print(fora)
