import { apenasDigitos } from './cpf'

/**
 * Formato dos campos de cadastro que o XML TISS exige.
 *
 * ── Por que estas regras estão aqui, e não só no banco ─────────────────────
 * A `drizzle/0039` trava os dois formatos por CHECK, e essa é a garantia — nada
 * entra torto, nem por script nem por `psql`. O que falta ao CHECK é a **mensagem**:
 * quem digita 6 dígitos no CNES recebe `violates check constraint
 * "clinica_cnes_formato"`, que não diz o que fazer.
 *
 * Então a regra vive em dois lugares de propósito, com papéis diferentes: o banco
 * garante, a borda explica. É o mesmo arranjo de `cnpj.ts`, cujo CHECK não existe e
 * cuja validação de dígito verificador é toda daqui.
 *
 * ── O que isto NÃO faz ─────────────────────────────────────────────────────
 * Não diz se o CNES existe no cadastro do Ministério da Saúde, nem se o CBO-S é o
 * da especialidade certa daquele dentista. Formato pega erro de digitação; **valor
 * plausível e errado passa por aqui e volta como glosa semanas depois**, que é o
 * mesmo motivo pelo qual os 13 códigos TUSS de `dados/README.md` ficaram em branco
 * em vez de deduzidos.
 */

/**
 * CNES do estabelecimento: sete dígitos.
 *
 * Cadastro Nacional de Estabelecimentos de Saúde. Sete é o tamanho oficial, então a
 * trava é padrão nacional e não convenção nossa — ao contrário do código de
 * prestador na operadora, que varia e por isso não tem formato travado.
 */
export function cnesEhValido(valor: string): boolean {
  return /^[0-9]{7}$/.test(apenasDigitos(valor))
}

/**
 * CBO-S de cirurgião-dentista: seis dígitos, família **2232**.
 *
 * A faixa não é dedução: o domínio `dm_CBOS` do XSD oficial da ANS documenta
 * 2232xx como cirurgião-dentista, e a procedência do arquivo está em
 * `dados/tiss-xsd-3.05.00/PROCEDENCIA.md`.
 *
 * A trava só vale porque este campo mora em `profissional`, que é 1:1 com usuário de
 * perfil `dentista` e exige CRO. Auxiliar de saúde bucal é família 3224 e não entra
 * nessa tabela — se um dia entrar, esta função é que vai avisar, e avisar é o
 * comportamento certo.
 */
export function cbosEhValido(valor: string): boolean {
  return /^2232[0-9]{2}$/.test(apenasDigitos(valor))
}

/** Só os dígitos, para gravar. Quem digita CNES costuma colar com espaço ou ponto. */
export function normalizarCnes(valor: string): string {
  return apenasDigitos(valor)
}

/** Só os dígitos, para gravar. */
export function normalizarCbos(valor: string): string {
  return apenasDigitos(valor)
}

/**
 * Mensagens em um lugar só, porque as três telas que pedem estes campos precisam
 * dizer a mesma coisa — e porque a mensagem do CBO-S tem de explicar **por que** a
 * família é obrigatória, senão a recusa parece capricho.
 */
export const MSG_CNES_INVALIDO =
  'CNES deve ter 7 dígitos. É o número do estabelecimento no Cadastro Nacional de ' +
  'Estabelecimentos de Saúde — deixe em branco se a clínica não fatura convênio.'

export const MSG_CBOS_INVALIDO =
  'CBO-S deve ter 6 dígitos e começar com 2232, que é a família de cirurgião-dentista ' +
  'na tabela da ANS (dm_CBOS). Outra família seria recusada pela operadora.'
