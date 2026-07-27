import type { Client, PoolClient } from 'pg'

/**
 * Desligar as triggers de APLICAÇÃO durante a limpeza de dados de demonstração —
 * e só elas.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * ── O que isto substituiu, e o estrago que aquilo fez ───────────────────────
 * Todos os scripts de demonstração usavam:
 *
 *     set local session_replication_role = 'replica'
 *
 * Ele desliga as triggers de usuário — que é o que se queria, porque `evolucao`,
 * `audit_log` e `movimento_estoque` recusam DELETE por decisão (guarda de 20 anos,
 * CFO) e a limpeza precisa apagar. Só que ele desliga **também as triggers
 * internas de chave estrangeira**, e ninguém pediu isso.
 *
 * A consequência não foi hipotética: a limpeza do estoque apagou uma `execucao` e
 * deixou **5 linhas órfãs em `movimento_estoque`** apontando para ela. O banco de
 * desenvolvimento ficou num estado que nenhuma migration futura conseguia aplicar
 * — a `drizzle/0023` falhou ao criar FK composto, porque não se valida FK sobre
 * dado já inconsistente. Uma ferramenta de teste corrompeu o banco de forma que só
 * apareceu semanas depois, num lugar sem relação nenhuma com estoque.
 *
 * `ALTER TABLE … DISABLE TRIGGER USER` desliga exatamente as de aplicação e
 * **preserva as de FK** — é o oposto do que causou o problema. `USER` é o que
 * significa "não as internas".
 *
 * ── O risco NOVO que isto introduz, e por que `religar` não é opcional ──────
 * `session_replication_role` era configuração de sessão: acabava com a transação,
 * e no pior caso com a conexão. `ALTER TABLE … DISABLE TRIGGER` é **DDL**. Se a
 * transação COMITAR com a trigger desligada, ela fica desligada **para sempre** —
 * e o prontuário passa a aceitar UPDATE em silêncio, que é o pior resultado
 * possível neste projeto.
 *
 * Daí o contrato:
 *   • as duas chamadas ficam DENTRO da mesma transação. Se algo estourar no meio,
 *     o `rollback` desfaz o DISABLE junto com os deletes — não existe estado
 *     intermediário publicado;
 *   • `religarTriggersDeAplicacao` vai ANTES do `commit`, sempre;
 *   • e ela própria confere o resultado. Não basta mandar religar: tem de estar
 *     religado. `exigirNenhumTriggerDesligado` é a contraprova, e ela estoura em
 *     vez de avisar.
 *
 * ⚠️ Isto é ferramenta de DESENVOLVIMENTO. Nada em `app/` ou nos caminhos de
 * produção chama estas funções, e não deve passar a chamar: a resposta certa para
 * "preciso apagar uma evolução" é que não se apaga — retifica-se.
 * ══════════════════════════════════════════════════════════════════════════════
 */

type Conexao = Client | PoolClient

/**
 * As tabelas com trigger de aplicação, lidas do catálogo em vez de listadas.
 *
 * Lista à mão ficaria velha na primeira migration que acrescentasse trigger, e o
 * sintoma seria uma limpeza que falha com "append-only" numa tabela nova — no
 * script de demonstração de outra área, longe de quem fez a mudança.
 */
async function tabelasComTriggerDeAplicacao(c: Conexao): Promise<string[]> {
  const r = await c.query<{ tabela: string }>(`
    select distinct cl.relname as tabela
      from pg_trigger t
      join pg_class cl on cl.oid = t.tgrelid
      join pg_namespace n on n.oid = cl.relnamespace
     where not t.tgisinternal
       and n.nspname = 'public'
       and cl.relkind = 'r'
     order by 1`)
  return r.rows.map((l) => l.tabela)
}

/**
 * Desliga as triggers de aplicação. **Precisa estar dentro de uma transação.**
 *
 * Devolve a lista desligada, para `religar` receber exatamente a mesma — computar
 * de novo na volta funcionaria hoje e é frágil: uma tabela criada no meio da
 * limpeza sairia da conta.
 */
export async function desligarTriggersDeAplicacao(c: Conexao): Promise<string[]> {
  const tabelas = await tabelasComTriggerDeAplicacao(c)
  for (const t of tabelas) {
    await c.query(`alter table "${t}" disable trigger user`)
  }
  return tabelas
}

/** Religa e CONFERE. Chamar antes do `commit`. */
export async function religarTriggersDeAplicacao(c: Conexao, tabelas: string[]): Promise<void> {
  for (const t of tabelas) {
    await c.query(`alter table "${t}" enable trigger user`)
  }
  await exigirNenhumTriggerDesligado(c)
}

/**
 * Estoura se sobrou trigger desligada. A pergunta certa não é "eu religuei?", é
 * "está religado?" — a primeira se responde lendo o código, a segunda lendo o
 * banco, e é a segunda que importa.
 */
export async function exigirNenhumTriggerDesligado(c: Conexao): Promise<void> {
  const r = await c.query<{ alvo: string }>(`
    select cl.relname || '.' || t.tgname as alvo
      from pg_trigger t
      join pg_class cl on cl.oid = t.tgrelid
      join pg_namespace n on n.oid = cl.relnamespace
     where not t.tgisinternal and n.nspname = 'public' and t.tgenabled = 'D'
     order by 1`)
  if (r.rows.length > 0) {
    throw new Error(
      `Triggers ainda desligadas: ${r.rows.map((l) => l.alvo).join(', ')}. ` +
        'O append-only do prontuário depende delas — esta transação NÃO pode comitar.',
    )
  }
}
