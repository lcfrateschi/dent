import { db } from '@/lib/db'
import {
  agendamento,
  execucao,
  itemPlano,
  orcamento,
  paciente,
  parcela,
  regraRetorno,
  tarefaRelacionamento,
} from '@/lib/db/schema'
import {
  PRAZOS_EM_DIAS,
  type TipoTarefa,
  chaveDaTarefa,
} from '@/lib/domain/relacionamento'
import { sql } from 'drizzle-orm'

/**
 * Os cinco geradores da fila. **Núcleo, sem `'use server'`.**
 *
 * Rodam no laço do despachante, a cada dez minutos, para sempre — e é isso que
 * define o desenho inteiro.
 *
 * ── Idempotência por CHAVE, não por consulta ────────────────────────────────
 * Cada gerador é um `INSERT … SELECT … ON CONFLICT (chave_idempotencia) DO NOTHING`.
 * Uma instrução só, sem ler-antes-de-escrever: duas passadas simultâneas do
 * despachante não duplicam nada, porque a segunda colide no índice. O padrão
 * "verifica se existe, depois insere" tem corrida entre o SELECT e o INSERT — é a
 * mesma razão pela qual `lib/mensageria/fila.ts` não faz isso.
 *
 * ── E a razão de a chave ignorar a SITUAÇÃO ─────────────────────────────────
 * O `ON CONFLICT` colide com a tarefa **dispensada** também. Isso é o requisito,
 * não um efeito colateral: a recepção dispensou porque o paciente pediu para não
 * ser incomodado, e um gerador que filtrasse por `situacao = 'aberta'` recriaria a
 * tarefa na passada seguinte. O `NOT EXISTS` de cada consulta abaixo olha a
 * **chave**, nunca a situação.
 *
 * ── Por que o SQL é uma instrução e não um laço em TypeScript ───────────────
 * Um `for` sobre os resultados, inserindo um por um, seria mais legível e teria
 * duas propriedades ruins: N+1 idas ao banco por clínica por passada, e uma janela
 * entre ler e inserir em que a situação muda. Aqui o banco decide tudo de uma vez.
 *
 * ── Por que TODA consulta filtra `clinica_id` explicitamente ───────────────
 * A primeira versão não filtrava, com o argumento de que a RLS filtra e o `DEFAULT
 * app_clinica_id()` preenche o tenant. **O argumento é verdadeiro para o app e falso
 * para quem roda isto de verdade.**
 *
 * O despachante e os scripts de demonstração rodam com a credencial do **dono das
 * tabelas**, que ignora política de RLS. Sem o filtro, o `join paciente` varre todas
 * as clínicas: o gerador da clínica A monta uma tarefa apontando para paciente da
 * clínica B, e o `clinica_id` sai do contexto (A). Resultado medido, num banco com
 * cinco clínicas:
 *
 *   insert or update on table "tarefa_relacionamento" violates foreign key
 *   constraint "tarefa_relacionamento_paciente_id_paciente_id_fk"
 *
 * Quem avisou foi o **FK composto** da `drizzle/0023` — terceira vez neste projeto
 * que ele pega uma consulta sem filtro escrita por quem estava pensando na RLS. O
 * filtro é redundante como `facilident_app` e obrigatório como dono; e a versão que
 * funciona nos dois casos é a que fica.
 *
 * `app_clinica_id()` e não parâmetro: não há o que o chamador erre, e sem contexto
 * estoura em vez de gerar para a clínica errada.
 */

export interface ResultadoGeracao {
  readonly tipo: TipoTarefa
  readonly criadas: number
}

/**
 * Hoje, como DATE, para comparar dentro do SQL.
 *
 * `HOJE_NA_CLINICA` (de `lib/tenant/sql.ts`) é `to_char(hoje_na_clinica(), …)` e
 * devolve **texto** — de propósito, porque ele existe para ser LIDO em TypeScript
 * como ISO, sem depender do `DateStyle` do servidor. Usá-lo numa comparação com
 * coluna `date` compara texto com data e faz o Postgres inventar um cast; aqui a
 * comparação é entre datas e a função é chamada direta.
 *
 * As duas leem a mesma função do banco, então tela e gerador concordam sobre que
 * dia é hoje — que é o ponto do `lib/tenant/sql.ts`.
 */
const HOJE = sql`hoje_na_clinica()`

/**
 * O paciente pode ser contatado hoje?
 *
 * Fragmento reusado pelos cinco geradores. `nao_contatar_ate` é inclusivo: o dia
 * pedido ainda não pode, então a condição é `>` e não `>=`.
 *
 * ── Por que filtrar na GERAÇÃO e não na exibição ───────────────────────────
 * As duas funcionariam, e filtrar na geração é melhor por um motivo assimétrico:
 * a tarefa que não existe não pode ser vista por engano, enquanto a tarefa criada
 * e escondida depende de toda tela futura lembrar do filtro. E não se perde nada —
 * as consultas abaixo não têm janela de tempo, então quando o opt-out expira o
 * fato continua elegível e a tarefa aparece.
 *
 * `status <> 'arquivado'`: paciente arquivado saiu da clínica. Ligar para ele é
 * pior que não ligar.
 *
 * ── Por que os nomes de coluna são LITERAIS e qualificados ─────────────────
 * `${paciente.status}` dentro de um template `sql` do Drizzle renderiza `"status"`
 * **sem a tabela**. Este fragmento entra numa consulta que também junta `parcela`,
 * que tem `status` — e o Postgres responde `column reference "status" is ambiguous`.
 * Escrevi assim na primeira versão e o banco recusou na hora; está no `CLAUDE.md`
 * como armadilha conhecida, e é a segunda vez que ela morde alguém neste projeto.
 */
/** O tenant do contexto, para filtrar explicitamente. Ver o cabeçalho. */
const DESTA_CLINICA = sql`app_clinica_id()`

const PODE_CONTATAR = sql`(
  "paciente"."nao_contatar_ate" is null
  or ${HOJE} > "paciente"."nao_contatar_ate"
) and "paciente"."status" <> 'arquivado'`


/**
 * O prazo, contado do dia de hoje.
 *
 * O `::int` no parâmetro não é decoração: sem ele o Postgres recebe `date +
 * $1` com `$1` de tipo desconhecido e responde `operator is not unique: date +
 * unknown` — há `date + integer` e `date + interval`, e ele se recusa a escolher.
 * Foi o primeiro erro que este arquivo deu contra o banco.
 */
function prazo(tipo: TipoTarefa) {
  return sql`(${HOJE} + ${PRAZOS_EM_DIAS[tipo]}::int)`
}

/**
 * Orçamento enviado que ninguém respondeu.
 *
 * ── Por que o gatilho é o PRAZO e não a validade ───────────────────────────
 * A tentação é gerar quando o orçamento expira. É tarde: expirado significa que a
 * chance passou, e a fila existiria para registrar a perda. O gatilho é
 * `enviado_em + 7 dias` **enquanto ainda está válido** — é onde uma ligação ainda
 * muda o resultado.
 *
 * `status = 'enviado'` cobre rascunho (não foi oferecido a ninguém), aprovado e
 * recusado (já respondeu). Expirado fica de fora de propósito: quem passou da
 * validade precisa de orçamento novo, não de ligação sobre o antigo — e é decisão
 * fechada do projeto que orçamento é documento congelado.
 */
export async function gerarOrcamentoSemResposta(): Promise<ResultadoGeracao> {
  const tipo: TipoTarefa = 'orcamento_sem_resposta'
  const r = await db.execute(sql`
    insert into tarefa_relacionamento (tipo, paciente_id, chave_idempotencia, orcamento_id, prazo)
    select 'orcamento_sem_resposta',
           "orcamento"."paciente_id",
           'orcamento_sem_resposta:' || "orcamento"."id",
           "orcamento"."id",
           ${prazo(tipo)}
      from ${orcamento}
      join ${paciente} on "paciente"."id" = "orcamento"."paciente_id"
     where "orcamento"."clinica_id" = ${DESTA_CLINICA}
       and "paciente"."clinica_id" = ${DESTA_CLINICA}
       and "orcamento"."status" = 'enviado'
       and "orcamento"."enviado_em" is not null
       and "orcamento"."enviado_em" <= now() - interval '7 days'
       and "orcamento"."validade_ate" >= ${HOJE}
       and ${PODE_CONTATAR}
       and not exists (
         select 1 from tarefa_relacionamento t
          where t.chave_idempotencia = 'orcamento_sem_resposta:' || "orcamento"."id"
       )
    on conflict (chave_idempotencia) do nothing
  `)
  return { tipo, criadas: r.rowCount ?? 0 }
}

/**
 * Parcela vencida e não paga.
 *
 * `parcial` entra junto com `aberta` e `vencida`: parcela paga pela metade continua
 * devendo, e é decisão fechada do projeto que `glosada_parcial` não é "paga". A
 * mesma lógica vale aqui.
 *
 * O gatilho é o **vencimento**, não o status: o status só vira `vencida` quando
 * alguém roda a rotina que o atualiza, e depender disso encadearia duas coisas que
 * podem estar dessincronizadas. A data é a verdade.
 */
export async function gerarInadimplencia(): Promise<ResultadoGeracao> {
  const tipo: TipoTarefa = 'inadimplencia'
  const r = await db.execute(sql`
    insert into tarefa_relacionamento (tipo, paciente_id, chave_idempotencia, parcela_id, prazo)
    select 'inadimplencia',
           "cobranca"."paciente_id",
           'inadimplencia:' || "parcela"."id",
           "parcela"."id",
           ${prazo(tipo)}
      from ${parcela}
      join cobranca on "cobranca"."id" = "parcela"."cobranca_id"
      join ${paciente} on "paciente"."id" = "cobranca"."paciente_id"
     where "parcela"."clinica_id" = ${DESTA_CLINICA}
       and "cobranca"."clinica_id" = ${DESTA_CLINICA}
       and "paciente"."clinica_id" = ${DESTA_CLINICA}
       and "parcela"."status" in ('aberta', 'parcial', 'vencida')
       and "parcela"."vencimento" < ${HOJE}
       and ${PODE_CONTATAR}
       and not exists (
         select 1 from tarefa_relacionamento t
          where t.chave_idempotencia = 'inadimplencia:' || "parcela"."id"
       )
    on conflict (chave_idempotencia) do nothing
  `)
  return { tipo, criadas: r.rowCount ?? 0 }
}

/**
 * Item de plano aprovado e nunca executado.
 *
 * Trinta dias depois da aprovação, e só o que continua `aprovado` — `executado`,
 * `faturado`, `recebido`, `recusado` e `cancelado` já saíram do assunto.
 *
 * É o dinheiro mais fácil da clínica: o paciente **já disse sim**. Não é venda, é
 * agenda.
 */
export async function gerarAprovadoNaoExecutado(): Promise<ResultadoGeracao> {
  const tipo: TipoTarefa = 'aprovado_nao_executado'
  const r = await db.execute(sql`
    insert into tarefa_relacionamento (tipo, paciente_id, chave_idempotencia, item_plano_id, prazo)
    select 'aprovado_nao_executado',
           "plano_tratamento"."paciente_id",
           'aprovado_nao_executado:' || "item_plano"."id",
           "item_plano"."id",
           ${prazo(tipo)}
      from ${itemPlano}
      join plano_tratamento on "plano_tratamento"."id" = "item_plano"."plano_id"
      join ${paciente} on "paciente"."id" = "plano_tratamento"."paciente_id"
     where "item_plano"."clinica_id" = ${DESTA_CLINICA}
       and "plano_tratamento"."clinica_id" = ${DESTA_CLINICA}
       and "paciente"."clinica_id" = ${DESTA_CLINICA}
       and "item_plano"."status" = 'aprovado'
       and "item_plano"."criado_em" <= now() - interval '30 days'
       and ${PODE_CONTATAR}
       and not exists (
         select 1 from tarefa_relacionamento t
          where t.chave_idempotencia = 'aprovado_nao_executado:' || "item_plano"."id"
       )
    on conflict (chave_idempotencia) do nothing
  `)
  return { tipo, criadas: r.rowCount ?? 0 }
}

/**
 * Faltou e não remarcou.
 *
 * ── A condição que faz este gerador valer algo ──────────────────────────────
 * "Não remarcou" é a parte difícil: não basta olhar o agendamento que faltou, é
 * preciso saber se o paciente **já tem outro** depois dele. Sem essa checagem, a
 * fila cobraria a recepção por um trabalho que ela já fez — e uma fila que aponta
 * coisa resolvida é uma fila que as pessoas param de olhar.
 *
 * `cancelado` fica de fora, e não é detalhe: **cancelado avisado liberou o
 * horário**. É decisão fechada do projeto que falta e cancelamento são grandezas
 * separadas; misturá-las aqui produziria ligação cobrando quem avisou.
 */
export async function gerarFaltaSemRemarcar(): Promise<ResultadoGeracao> {
  const tipo: TipoTarefa = 'falta_sem_remarcar'
  const r = await db.execute(sql`
    insert into tarefa_relacionamento (tipo, paciente_id, chave_idempotencia, agendamento_id, prazo)
    select 'falta_sem_remarcar',
           "agendamento"."paciente_id",
           'falta_sem_remarcar:' || "agendamento"."id",
           "agendamento"."id",
           ${prazo(tipo)}
      from ${agendamento}
      join ${paciente} on "paciente"."id" = "agendamento"."paciente_id"
     where "agendamento"."clinica_id" = ${DESTA_CLINICA}
       and "paciente"."clinica_id" = ${DESTA_CLINICA}
       and "agendamento"."status" = 'faltou'
       and ${PODE_CONTATAR}
       -- Já remarcou? Qualquer atendimento depois do que faltou, não cancelado.
       and not exists (
         select 1 from agendamento futuro
          where futuro.clinica_id = ${DESTA_CLINICA}
            and futuro.paciente_id = "agendamento"."paciente_id"
            and futuro.inicio > "agendamento"."inicio"
            and futuro.status <> 'cancelado'
       )
       and not exists (
         select 1 from tarefa_relacionamento t
          where t.chave_idempotencia = 'falta_sem_remarcar:' || "agendamento"."id"
       )
    on conflict (chave_idempotencia) do nothing
  `)
  return { tipo, criadas: r.rowCount ?? 0 }
}

/**
 * Retorno programado — o recall.
 *
 * A execução de um procedimento com `regra_retorno` marca a data devida
 * (`executado_em + meses`). Quando ela chega, a tarefa nasce.
 *
 * ── Por que `add_months` no banco e não em TypeScript ──────────────────────
 * `lib/domain/relacionamento.ts` tem `dataDoRetorno`, testada, e ela é a verdade
 * para a tela. Aqui a soma acontece em SQL porque o gerador é uma instrução só —
 * e as duas concordam porque as duas somam MÊS de calendário, não 30 dias
 * (`interval '1 month'` do Postgres faz o mesmo clamp de fim de mês que `addMeses`:
 * 31/01 + 1 mês = 28/02).
 *
 * ── A condição que evita chamar quem já voltou ─────────────────────────────
 * Se o paciente tem atendimento agendado ou concluído **depois** da data devida,
 * ele já voltou — chamá-lo seria a clínica não sabendo o que aconteceu na própria
 * cadeira.
 */
export async function gerarRetornoProgramado(): Promise<ResultadoGeracao> {
  const tipo: TipoTarefa = 'retorno_programado'
  const r = await db.execute(sql`
    insert into tarefa_relacionamento (tipo, paciente_id, chave_idempotencia, execucao_id, prazo)
    select 'retorno_programado',
           "plano_tratamento"."paciente_id",
           'retorno_programado:' || "execucao"."id",
           "execucao"."id",
           (("execucao"."executado_em" at time zone 'UTC')::date
              + ("regra_retorno"."meses" || ' months')::interval)::date
      from ${execucao}
      join ${itemPlano} on "item_plano"."id" = "execucao"."item_plano_id"
      join plano_tratamento on "plano_tratamento"."id" = "item_plano"."plano_id"
      join ${paciente} on "paciente"."id" = "plano_tratamento"."paciente_id"
      join ${regraRetorno} on "regra_retorno"."procedimento_id" = "item_plano"."procedimento_id"
     where "execucao"."clinica_id" = ${DESTA_CLINICA}
       and "item_plano"."clinica_id" = ${DESTA_CLINICA}
       and "plano_tratamento"."clinica_id" = ${DESTA_CLINICA}
       and "paciente"."clinica_id" = ${DESTA_CLINICA}
       and "regra_retorno"."clinica_id" = ${DESTA_CLINICA}
       and "regra_retorno"."ativo"
       and (("execucao"."executado_em" at time zone 'UTC')::date
              + ("regra_retorno"."meses" || ' months')::interval)::date <= ${HOJE}
       and ${PODE_CONTATAR}
       -- Já voltou depois da data devida?
       and not exists (
         select 1 from agendamento a
          where a.clinica_id = ${DESTA_CLINICA}
            and a.paciente_id = "plano_tratamento"."paciente_id"
            and a.status in ('agendado', 'confirmado', 'em_atendimento', 'concluido')
            and a.inicio >= (("execucao"."executado_em" at time zone 'UTC')::date
                              + ("regra_retorno"."meses" || ' months')::interval)
       )
       and not exists (
         select 1 from tarefa_relacionamento t
          where t.chave_idempotencia = 'retorno_programado:' || "execucao"."id"
       )
    on conflict (chave_idempotencia) do nothing
  `)
  return { tipo, criadas: r.rowCount ?? 0 }
}

/**
 * Uma passada de todos os geradores, para a clínica do contexto.
 *
 * A ordem é a de urgência de dinheiro, igual à do enum. Não importa para a
 * correção — importa para quem lê o log do despachante.
 */
export async function gerarTodasAsTarefas(): Promise<readonly ResultadoGeracao[]> {
  return [
    await gerarOrcamentoSemResposta(),
    await gerarInadimplencia(),
    await gerarAprovadoNaoExecutado(),
    await gerarFaltaSemRemarcar(),
    await gerarRetornoProgramado(),
  ]
}

/**
 * A chave que o gerador monta em SQL tem de ser a mesma que o domínio monta em TS.
 *
 * Isto não é teste — é uma função de conferência que o script de demonstração
 * chama. Se as duas divergirem (alguém muda o separador no domínio e esquece o
 * SQL), a idempotência **para de funcionar em silêncio**: cada passada insere de
 * novo, com chave diferente, e a fila enche de duplicatas.
 */
export function chaveEsperada(tipo: TipoTarefa, referenciaId: string): string {
  return chaveDaTarefa(tipo, referenciaId)
}
