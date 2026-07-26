/**
 * Parte PURA do convite do portal: normalização e formatação do token.
 *
 * Existe separada de `convite.ts` porque este módulo é importado por componente
 * cliente (`components/paciente/AcessoAoPortal.tsx`), e `convite.ts` importa
 * `node:crypto`. Um `import` de módulo com `node:crypto` num arquivo
 * `'use client'` faz o `next build` falhar inteiro — sem afetar `npm test` nem
 * `tsc`, que é como o problema passou desapercebido.
 *
 * Nada aqui envolve segredo: é texto.
 */

/**
 * Normaliza o que o paciente digitou.
 *
 * Ele vai receber `A3F7-K92M-...` num papel e digitar com espaço, com hífen, em
 * minúscula. Recusar por causa disso transformaria um erro de digitação em
 * chamada telefônica. O que **não** é tolerado é caractere fora do alfabeto —
 * `O` em vez de `0` não existe aqui porque o alfabeto não tem nenhum dos dois.
 */
export function normalizar(token: string): string {
  return token.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** `A3F7-K92M-XY4B-...` — em blocos de 4, para ler e digitar sem errar. */
export function formatarConvite(token: string): string {
  return (normalizar(token).match(/.{1,4}/g) ?? []).join('-')
}
