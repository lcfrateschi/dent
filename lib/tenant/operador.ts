import { Client } from 'pg'

/**
 * Acesso de OPERADOR — o que atravessa clínicas, de propósito.
 *
 * ── Por que isto precisa existir, e por que precisa ser estreito ────────────
 * Quase tudo no sistema fala por UMA clínica. Três coisas não:
 *
 *   • o **despachante** de WhatsApp, que roda em laço e tem de percorrer todas;
 *   • o **onboarding**, que cria uma clínica antes de ela existir;
 *   • o **backup**, que dumpa o banco inteiro.
 *
 * Nenhuma delas atende requisição de usuário. Todas rodam como script, na máquina
 * do servidor, sem sessão. É a diferença entre "o sistema, agindo em nome de um
 * cliente" e "a operação, cuidando da infraestrutura" — e misturar as duas é como
 * nasce a tela de suporte que lista o dado de todo mundo.
 *
 * Por isso este módulo tem **uma função só** e ela devolve **uma coluna só**. Não
 * é um `db` sem restrição: é o mínimo que responde "quais clínicas existem?".
 *
 * ── Por que uma conexão CRUA e não o pool ──────────────────────────────────
 * `lib/db/index.ts` define contexto de clínica em toda acquisição do pool, e com
 * duas clínicas o caminho sem sessão **recusa a conexão** — é a trava que impede o
 * app de servir dado misturado. Enumerar clínicas é justamente a pergunta que não
 * pode ter contexto de clínica, então ela não pode passar pelo pool. Uma conexão
 * própria, aberta e fechada, deixa isso explícito em vez de abrir uma exceção
 * dentro do caminho que todo mundo usa.
 *
 * ── Sob RLS: função no banco, não role privilegiada no processo ────────────
 * Antes isto era `select id from clinica`, que funcionava só porque o app conectava
 * como dono das tabelas (e superusuário ignora política). Como `facilident_app`, a
 * mesma consulta devolve **no máximo a própria clínica** — e o despachante
 * processaria uma só, sem erro e sem log. As outras simplesmente não receberiam
 * lembrete, e ninguém saberia até um paciente reclamar de uma falta que ninguém
 * confirmou.
 *
 * A resposta é `clinicas_para_processamento()`, `SECURITY DEFINER` em
 * `drizzle/0024`. A alternativa era uma role `facilident_ops` com mais poder — mais
 * bonita no diagrama e pior na prática: o despachante roda no mesmo container do
 * app, então a credencial mais privilegiada ficaria disponível para todo o processo,
 * **inclusive para o código que atende requisição**. A função é a superfície mínima:
 * devolve uma coluna de uuids e não dá acesso a linha nenhuma.
 */
export async function clinicasParaProcessamento(): Promise<readonly string[]> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL não definida.')

  const cru = new Client({ connectionString: url })
  await cru.connect()
  try {
    // A ordem estável vive dentro da função (`ORDER BY id`), junto do resto — laço
    // cuja ordem muda entre execuções é laço cujo log não se compara.
    const r = await cru.query<{ id: string }>(
      'select clinicas_para_processamento()::text as id',
    )
    return r.rows.map((l) => l.id)
  } finally {
    await cru.end()
  }
}
