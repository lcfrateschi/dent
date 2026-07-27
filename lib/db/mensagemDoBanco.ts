/**
 * O texto que o Postgres de fato escreveu.
 *
 * ── Por que não basta `e.message` ───────────────────────────────────────────
 * O Drizzle embrulha o erro: `e.message` vira `"Failed query: insert into …"` — a
 * consulta inteira, com os parâmetros — e a mensagem que a trigger escreveu fica em
 * `e.cause`. Ler só `message` faz toda mensagem boa ("Lote L-VENCIDO venceu em …",
 * "evolucao já está assinada e é imutável") virar genérico, e foi o que fez a `0022`
 * parecer não aplicar por três tentativas.
 *
 * Anda até 5 níveis porque a cadeia real tem 2 ou 3 e um limite fixo evita laço
 * infinito num `cause` circular.
 *
 * ── Nota de dívida ──────────────────────────────────────────────────────────
 * Esta função existia como cópia privada em `lib/estoque/movimentar.ts`,
 * `lib/mensageria/demonstrar.ts` e `lib/tenant/verificar-contexto.ts`. Este arquivo é
 * a versão canônica; **as três cópias devem passar a importar daqui** — não foram
 * alteradas junto para o diff da Fase 19 não se misturar com um refactor de três
 * módulos que nada têm a ver com autoatendimento.
 */
export function mensagemDoBanco(e: unknown): string {
  const partes: string[] = []
  let atual: unknown = e
  for (let i = 0; i < 5 && atual instanceof Error; i++) {
    partes.push(atual.message)
    atual = (atual as { cause?: unknown }).cause
  }
  return partes.length > 0 ? partes.join(' | ') : String(e)
}
