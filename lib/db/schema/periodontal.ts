import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { profissional } from './acesso'
import { sitioPeriogramaEnum } from './enums'
import { paciente } from './pacientes'
import { dente } from './referencia'
import { clinicaId } from './tenant'

/**
 * Exame periodontal completo — o periograma.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *  ⚠️ QUEM MODELOU ISTO NÃO É DENTISTA. As regras marcadas [PADRÃO] são protocolo
 *  internacional verificável; as marcadas ⚠️ são escolha de modelagem e **precisam
 *  de validação**. A lista consolidada está no `GLOSSARIO.md`, e o raciocínio de
 *  cada uma em `lib/domain/periograma.ts`.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Três tabelas, e a divisão não é arbitrária:
 *
 *   `periograma`        o exame: quem, quando, por quem.
 *   `periograma_dente`  o que é por DENTE: mobilidade (Miller) e furca (Glickman).
 *   `periograma_sitio`  o que é por SÍTIO: 6 por dente, com sondagem e recessão.
 *
 * Juntar as três numa só multiplicaria mobilidade por seis e criaria a
 * possibilidade de o mesmo dente ter dois graus de mobilidade no mesmo exame.
 *
 * ── O custo de digitação, que é o que mata este módulo ─────────────────────
 * Um periograma completo são **192 sítios** (32 dentes × 6), cada um com
 * profundidade, recessão, sangramento e supuração. Se a entrada for campo por
 * campo pela rede, ninguém preenche e a tabela fica vazia.
 *
 * O que o modelo faz a respeito: o exame existe **antes** dos sítios, e sítios são
 * gravados em lote (`registrarSitios`, um `INSERT` múltiplo por sextante). Exame
 * interrompido não se perde, e não há uma ida ao servidor por medida.
 *
 * O que o modelo **não** resolve, e é honesto dizer: a ergonomia da entrada. Na
 * prática o dentista dita e a auxiliar digita, e isso pede grade navegável por
 * teclado — ou pedal, ou voz. Não existe tela nesta fase.
 */
export const periograma = pgTable(
  'periograma',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id').notNull(),
    /** Quem examinou. Exame periodontal é ato clínico, tem autor. */
    profissionalId: uuid('profissional_id').notNull(),
    examinadoEm: timestamp('examinado_em', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Nulo = exame em andamento (a boca é examinada por sextante, e o dentista
     * para no meio). Comparação entre exames aceita exame aberto, mas a função de
     * comparação devolve a contagem de sítios de cada um — 192 contra 30 não é
     * evolução, é exame incompleto, e quem lê precisa ver isso.
     */
    concluidoEm: timestamp('concluido_em', { withTimezone: true }),
    observacao: text('observacao'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'periograma_paciente_id_paciente_id_fk',
      columns: [t.pacienteId, t.clinicaId],
      foreignColumns: [paciente.id, paciente.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'periograma_profissional_id_profissional_id_fk',
      columns: [t.profissionalId, t.clinicaId],
      foreignColumns: [profissional.id, profissional.clinicaId],
    }).onDelete('restrict'),
    index('periograma_paciente_idx').on(t.pacienteId, t.examinadoEm),
  ],
)

/**
 * Achados por dente: mobilidade e furca.
 *
 * A linha existe para todo dente examinado, mesmo que mobilidade e furca sejam
 * nulas — é ela que diz "este dente estava na boca neste exame". É disso que a
 * comparação deriva perda dentária, e é por isso que `periograma_sitio` referencia
 * esta tabela: sítio de dente que não está no exame é impossível de gravar.
 */
export const periogramaDente = pgTable(
  'periograma_dente',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    periogramaId: uuid('periograma_id').notNull(),
    denteFdi: smallint('dente_fdi')
      .notNull()
      .references(() => dente.fdi, { onDelete: 'restrict' }),
    /**
     * Mobilidade de Miller, 0 a III. [PADRÃO] `0` = sem mobilidade detectável;
     * nulo = não avaliada.
     */
    mobilidade: smallint('mobilidade'),
    /**
     * Furca de Glickman, I a IV, com `0` = examinada sem envolvimento. [PADRÃO]
     * Nulo = não avaliada.
     *
     * **Só existe em dente multirradicular**, e a trava está na `drizzle/0037` via
     * `dente_multirradicular()` — mesma família de erro que marcar face oclusal num
     * canino. ⚠️ Molares estão dentro; o primeiro pré-molar superior está **fora**,
     * e essa é a escolha que precisa do dentista (ver `lib/domain/periograma.ts`).
     */
    furca: smallint('furca'),
    /** Retração/recessão visível sem sondagem, se o dentista quiser anotar à parte. */
    observacao: text('observacao'),
  },
  (t) => [
    foreignKey({
      name: 'periograma_dente_periograma_id_periograma_id_fk',
      columns: [t.periogramaId, t.clinicaId],
      foreignColumns: [periograma.id, periograma.clinicaId],
    }).onDelete('cascade'),
    /**
     * Um dente aparece uma vez por exame. A `clinica_id` entra no índice porque é
     * ele que o FK composto de `periograma_sitio` referencia — sem os três, o
     * Postgres recusa a constraint.
     */
    uniqueIndex('periograma_dente_uk').on(t.clinicaId, t.periogramaId, t.denteFdi),
    check('periograma_dente_mobilidade_miller', sql`${t.mobilidade} is null or ${t.mobilidade} between 0 and 3`),
    check('periograma_dente_furca_glickman', sql`${t.furca} is null or ${t.furca} between 0 and 4`),
  ],
)

/**
 * Medidas por sítio. Seis por dente. [PADRÃO]
 *
 * ── O NIC é coluna GERADA, e isso é a garantia central desta tabela ────────
 * `nivel_insercao_mm` é `GENERATED ALWAYS AS (profundidade + recessao) STORED`:
 * escrever nele é recusado pelo Postgres, não por trigger e não por disciplina.
 *
 * É o mesmo princípio de "glosa é CALCULADA, nunca digitada" — e aqui pesa mais
 * que dinheiro. **O NIC é o número que diz se a doença progrediu**, porque a bolsa
 * pode encolher só porque a gengiva retraiu: PS de 6 para 3 com recessão de 0 para
 * 3 é NIC constante em 6. Um campo digitável divergindo do cálculo transformaria
 * essa distinção em ruído.
 */
export const periogramaSitio = pgTable(
  'periograma_sitio',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    periogramaId: uuid('periograma_id').notNull(),
    denteFdi: smallint('dente_fdi').notNull(),
    sitio: sitioPeriogramaEnum('sitio').notNull(),
    /** Profundidade de sondagem, em mm. ⚠️ Faixa 0–15: 15 é o limite LEGÍVEL da sonda. */
    profundidadeSondagemMm: smallint('profundidade_sondagem_mm').notNull(),
    /**
     * Margem gengival em relação à junção cemento-esmalte, em mm.
     *
     * **Positivo = recessão** (raiz exposta). **Negativo = aumento gengival** (a
     * margem cobre parte da coroa). O sinal negativo não é detalhe: sem ele, o NIC
     * de quem tem hiperplasia sai superestimado, e é justamente nesse paciente que
     * bolsa profunda não significa perda de inserção.
     */
    recessaoMm: smallint('recessao_mm').notNull().default(0),
    /** DERIVADO — `GENERATED ALWAYS`. Ver o comentário da tabela. */
    nivelInsercaoMm: smallint('nivel_insercao_mm').generatedAlwaysAs(
      sql`profundidade_sondagem_mm + recessao_mm`,
    ),
    /** Sangramento à sondagem. [PADRÃO] */
    sangramento: boolean('sangramento').notNull().default(false),
    supuracao: boolean('supuracao').notNull().default(false),
  },
  (t) => [
    /**
     * FK para o DENTE do exame, não para o exame. É isto que torna impossível
     * medir sítio de um dente que não está no periograma — e é da presença do
     * dente que a comparação deriva perda dentária.
     */
    foreignKey({
      name: 'periograma_sitio_dente_fk',
      columns: [t.clinicaId, t.periogramaId, t.denteFdi],
      foreignColumns: [periogramaDente.clinicaId, periogramaDente.periogramaId, periogramaDente.denteFdi],
    }).onDelete('cascade'),
    uniqueIndex('periograma_sitio_uk').on(t.periogramaId, t.denteFdi, t.sitio),
    index('periograma_sitio_exame_idx').on(t.periogramaId),
  ],
)
