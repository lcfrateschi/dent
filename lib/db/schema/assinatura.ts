import { sql } from 'drizzle-orm'
import {
  boolean,
  date,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { clinicaId } from './tenant'

/**
 * O contrato entre a clínica e o Facilident. **Não é dado clínico.**
 *
 * ── Por que `plano_assinatura` e não `plano` ────────────────────────────────
 * Porque neste domínio `plano` já significa outra coisa, e significa há dezesseis
 * fases: `plano_tratamento` é o que se pretende fazer na boca do paciente, com
 * `item_plano`, `status_plano` e meia dúzia de telas em volta. Uma tabela chamada
 * `plano` faria um dentista — ou eu, em três meses — ler "plano" e pensar em
 * tratamento. O `GLOSSARIO.md` existe para impedir exatamente isso, e a regra do
 * `CLAUDE.md` é usar os termos dele no código.
 *
 * ── Por que UMA assinatura por clínica, sem histórico de vigência ───────────
 * `preco_convenio` tem vigência porque o valor faturado é o **da data da
 * execução** — histórico ali é requisito de faturamento. Aqui não é: a mudança de
 * plano vale de agora em diante, e quem precisa do histórico é a cobrança, que
 * ainda não existe (não há fatura, não há nota). Uma linha por clínica, e a
 * trilha de mudanças fica no `audit_log`, que é obrigatório de todo jeito.
 *
 * Quando existir faturamento, isto vira `assinatura` + `periodo_faturado`, e a
 * migração é acrescentar tabela — não desfazer esta.
 */

export const situacaoAssinaturaEnum = pgEnum('situacao_assinatura', [
  'ativa',
  'suspensa',
  'cancelada',
])

/**
 * O catálogo comercial. **Global**, não por clínica.
 *
 * É dado do fornecedor (nós), não de nenhum tenant: nome, preço e limites dos
 * planos que vendemos. Fica global pelo mesmo motivo que `dente` fica — duplicar
 * por cliente seria copiar uma tabela igual centenas de vezes — e com a mesma
 * consequência: entra na lista de isentas de `exigir_isolamento_estrutural()`,
 * com justificativa, porque uma tabela sem `clinica_id` derruba o deploy.
 *
 * Que toda clínica LEIA todos os planos é intencional: preço de tabela é
 * informação de marketing, e a tela "seu plano é o Profissional, o Avançado tem
 * isto" precisa deles.
 *
 * ── E quando um cliente negociar um preço diferente? ───────────────────────
 * A resposta **não** é dar `clinica_id` a esta tabela. Preço negociado é atributo
 * do CONTRATO, não do catálogo: ele vai numa coluna de `assinatura`, que já tem
 * tenant. Dar tenant ao catálogo transformaria três linhas em três linhas por
 * cliente e faria "quais planos existem?" deixar de ter resposta.
 *
 * A coluna não existe ainda porque não existe faturamento — nem fatura, nem nota.
 * Está escrito aqui para que o dia em que alguém precisar dela não comece pela
 * ideia errada.
 */
export const planoAssinatura = pgTable(
  'plano_assinatura',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Chave estável para o código citar (`'profissional'`), independente do nome comercial. */
    codigo: text('codigo').notNull(),
    nome: text('nome').notNull(),
    /** `numeric` e `string` no TS, como todo dinheiro aqui. Nunca `float`. */
    precoMensal: numeric('preco_mensal', { precision: 10, scale: 2 }).notNull(),
    /**
     * `null` é **sem limite**, não zero. Um plano ilimitado com `0` no lugar de
     * `NULL` bloquearia o primeiro cadastro — é o mesmo raciocínio de
     * `lib/domain/indicadores.ts`: taxa sem base é `null`, não 0%.
     */
    limiteProfissionais: smallint('limite_profissionais'),
    limiteCadeiras: smallint('limite_cadeiras'),
    /**
     * Plano descontinuado fica `ativo = false`, **nunca é apagado**: assinatura
     * antiga aponta para ele, e apagá-lo reescreveria o que o cliente contratou.
     * Mesma disciplina de `profissional` rebaixado e de `preco_convenio` já usado
     * em guia.
     */
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('plano_assinatura_codigo_uk').on(t.codigo)],
)

export const assinatura = pgTable(
  'assinatura',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    planoId: uuid('plano_id')
      .notNull()
      .references(() => planoAssinatura.id, { onDelete: 'restrict' }),
    situacao: situacaoAssinaturaEnum('situacao').notNull().default('ativa'),
    iniciadaEm: timestamp('iniciada_em', { withTimezone: true }).notNull().defaultNow(),
    situacaoDesde: timestamp('situacao_desde', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Por que suspendeu ou cancelou. Obrigatório fora de `ativa` — trava no banco
     * (`drizzle/0027`).
     *
     * Não é burocracia: quem atende o telefone da clínica congelada precisa poder
     * dizer o motivo. "Suspensa" sem motivo é a recepção descobrindo com o
     * paciente na cadeira que o sistema não grava, e ninguém sabendo por quê.
     */
    motivoSituacao: text('motivo_situacao'),
    /**
     * Até quando o dado da clínica **cancelada** fica no banco.
     *
     * ⚠️ `null` de propósito, e não um prazo inventado por mim: **é decisão
     * comercial e jurídica**, não de engenharia. O mecanismo está pronto (a coluna,
     * a data, a exportação por clínica); o número tem de sair de contrato, porque
     * ele colide com a guarda de 20 anos do prontuário (CFO) — quem é o
     * controlador do dado depois do cancelamento, e por quanto tempo o operador
     * pode retê-lo, está em `LGPD.md`.
     *
     * Um `default '90 dias'` aqui pareceria decisão tomada e seria só um palpite
     * meu apagando prontuário alheio.
     */
    retencaoAte: date('retencao_ate'),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * Uma assinatura por clínica. Duas tornariam **indefinido** se a clínica está
     * suspensa — e a resposta decidiria se o dentista consegue registrar a
     * evolução do paciente que está na cadeira. É o mesmo motivo de "uma
     * carteirinha ativa por paciente e operadora".
     */
    uniqueIndex('assinatura_uma_por_clinica_uk').on(t.clinicaId),
  ],
)

/**
 * A pergunta que a trava de escrita faz, em SQL, no banco.
 *
 * Exportada como helper para o TypeScript poder fazer a MESMA pergunta antes de
 * tentar escrever — não para substituir a trava, para dar mensagem decente. É o
 * padrão já usado em `lib/admin/usuarios.ts`: *"as checagens abaixo existem para
 * dar mensagem boa na tela; se falharem, o banco recusa de todo jeito."*
 */
export function assinaturaPermiteEscrita(clinicaId: string) {
  return sql<boolean>`assinatura_permite_escrita(${clinicaId}::uuid)`
}
