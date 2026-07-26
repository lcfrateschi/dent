/**
 * Barrel do schema. É o que `drizzle.config.ts` lê para gerar migrations —
 * toda tabela nova precisa ser reexportada aqui.
 */
export * from './enums'
export * from './acesso'
export * from './pacientes'
export * from './referencia'
export * from './convenios'
export * from './agenda'
export * from './clinico'
export * from './tratamento'
export * from './financeiro'
export * from './documentos'
export * from './auditoria'
