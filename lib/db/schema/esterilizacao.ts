import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { usuario } from './acesso'
import { resultadoBiologicoEnum, resultadoIndicadorEnum } from './enums'
import { clinicaId } from './tenant'

/** Autoclave. A RDC 15 exige identificar o EQUIPAMENTO em cada ciclo, não só a data. */
export const autoclave = pgTable(
  'autoclave',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    nome: text('nome').notNull(),
    fabricante: text('fabricante'),
    modelo: text('modelo'),
    numeroSerie: varchar('numero_serie', { length: 60 }),
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('autoclave_nome_por_clinica_uk').on(t.clinicaId, t.nome)],
)

/**
 * Ciclo (carga) de esterilização.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *  ⚠️ **ISTO NÃO É "CONFORMIDADE COM A RDC 15".** É o registro dos ciclos, que é
 *  uma das coisas que a norma pede. Do que a RDC 15 exige, este modelo cobre:
 *  identificação do equipamento e do responsável, data, parâmetros do ciclo,
 *  indicador químico e indicador biológico com resultado.
 *
 *  O que ele **não** cobre, e é preciso dizer com as mesmas palavras que o projeto
 *  usa para o XML TISS ("válido contra o XSD ≠ aceito pela operadora"):
 *  validação/qualificação térmica do equipamento, periodicidade do teste
 *  biológico, procedimento operacional padrão escrito, registro de limpeza prévia
 *  do instrumental, e **rastreabilidade do pacote até o paciente** (ver abaixo).
 *  Nada disso é software: é processo, e alguém tem de responder por ele.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── O indicador biológico chega DEPOIS, e é isso que molda a tabela ────────
 * O químico sai junto com a carga (a fita muda de cor). O biológico precisa de
 * incubação — o resultado sai dias depois. Então **o ciclo nasce sem veredito** e é
 * atualizado, o que tem duas consequências no modelo:
 *
 *   1. `biologico_resultado` nasce `pendente`. Não é ausência de dado: é o estado
 *      real do ciclo naquele momento.
 *   2. `certificado` é **coluna GERADA**, não campo. Um ciclo com biológico
 *      pendente não está certificado, e deixar isso a cargo de quem digita é o
 *      mesmo erro do campo de glosa digitado. `GENERATED ALWAYS` faz o Postgres
 *      recusar a escrita.
 *
 * ── Rastreabilidade até o paciente: NÃO implementada ──────────────────────
 * O padrão-ouro é saber qual ciclo esterilizou o instrumental usado em qual
 * paciente. Isso exige uma entidade que este modelo não tem — o **pacote/kit**, com
 * etiqueta e identificador, ligado ao ciclo na embalagem e à execução na abertura.
 * `conteudo` aqui é texto descritivo, que é o que se faz no papel hoje, e **texto
 * livre não é rastreabilidade**: ninguém consulta "quais pacientes receberam
 * instrumental do ciclo reprovado" a partir dele. Se um biológico voltar positivo,
 * este modelo diz o ciclo e o dia — não a lista de pacientes.
 */
export const cicloEsterilizacao = pgTable(
  'ciclo_esterilizacao',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** Número da carga, por clínica — é o que vai na etiqueta do pacote. */
    numero: smallint('numero').notNull(),
    autoclaveId: uuid('autoclave_id').notNull(),
    /** Quem operou. Pode ser auxiliar, então é `usuario` e não `profissional`. */
    responsavelId: uuid('responsavel_id').notNull(),
    iniciadoEm: timestamp('iniciado_em', { withTimezone: true }).notNull(),
    /**
     * O dia civil da carga, **gravado e não derivado** de `iniciado_em`.
     *
     * Indexar `iniciado_em::date` é recusado pelo Postgres (o cast é STABLE, não
     * IMMUTABLE, porque depende do fuso) — e a recusa aponta um problema real: carga
     * das 21h em São Paulo é "amanhã" em UTC, e o número que está na ETIQUETA
     * reinicia a cada dia DA CLÍNICA. Ver `drizzle/0037`.
     */
    dia: date('dia').notNull().default(sql`hoje_na_clinica()`),
    /** Programa do equipamento, como ele o nomeia ("134 °C embalado"). */
    programa: text('programa'),
    temperaturaC: smallint('temperatura_c'),
    duracaoMin: smallint('duracao_min'),
    /** O que foi esterilizado. ⚠️ Texto livre — ver o cabeçalho: não é rastreabilidade. */
    conteudo: text('conteudo').notNull(),
    /** Sai junto com a carga. */
    indicadorQuimico: resultadoIndicadorEnum('indicador_quimico').notNull(),
    /** Nasce `pendente`: o resultado só existe depois da incubação. */
    biologicoResultado: resultadoBiologicoEnum('biologico_resultado').notNull().default('pendente'),
    biologicoLidoEm: timestamp('biologico_lido_em', { withTimezone: true }),
    /**
     * DERIVADO — `GENERATED ALWAYS`. Escrever aqui é recusado pelo Postgres.
     *
     * Só é `true` com químico aprovado **e** biológico negativo. Pendente não
     * certifica, positivo não certifica.
     */
    certificado: boolean('certificado').generatedAlwaysAs(
      sql`indicador_quimico = 'aprovado' and biologico_resultado = 'negativo'`,
    ),
    observacao: text('observacao'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'ciclo_esterilizacao_autoclave_id_autoclave_id_fk',
      columns: [t.autoclaveId, t.clinicaId],
      foreignColumns: [autoclave.id, autoclave.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ciclo_esterilizacao_responsavel_id_usuario_id_fk',
      columns: [t.responsavelId, t.clinicaId],
      foreignColumns: [usuario.id, usuario.clinicaId],
    }).onDelete('restrict'),
    /* Dois ciclos com o mesmo número no mesmo dia e autoclave tornariam a etiqueta
       ambígua — e a etiqueta é a única ligação física entre o pacote e o registro. */
    uniqueIndex('ciclo_esterilizacao_carga_uk').on(t.clinicaId, t.autoclaveId, t.dia, t.numero),
    index('ciclo_esterilizacao_pendentes_idx')
      .on(t.clinicaId, t.iniciadoEm)
      .where(sql`${t.biologicoResultado} = 'pendente'`),
    check('ciclo_esterilizacao_numero_positivo', sql`${t.numero} > 0`),
    check('ciclo_esterilizacao_conteudo_nao_vazio', sql`length(btrim(${t.conteudo})) > 0`),
    /* Resultado e leitura andam juntos: resultado sem data de leitura é resultado
       sem procedência, e data de leitura com resultado pendente é leitura que não
       leu nada. Mesma família do `assinado_em`/`assinatura_hash` da evolução. */
    check(
      'ciclo_esterilizacao_biologico_coerente',
      sql`(${t.biologicoResultado} = 'pendente') = (${t.biologicoLidoEm} is null)`,
    ),
    check(
      'ciclo_esterilizacao_temperatura_plausivel',
      sql`${t.temperaturaC} is null or ${t.temperaturaC} between 100 and 150`,
    ),
  ],
)
