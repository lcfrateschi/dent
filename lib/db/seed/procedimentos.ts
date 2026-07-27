import type { Executor } from '@/lib/tenant/executar'
import { procedimento } from '@/lib/db/schema'
import { sql } from 'drizzle-orm'

/**
 * Catálogo inicial de procedimentos.
 *
 * ── Código TUSS ─────────────────────────────────────────────────────────────
 * Os códigos vêm da **Tabela 22 da ANS** (Terminologia Unificada em Saúde
 * Suplementar), baixada da API oficial em 2026-07-26 — ver `dados/README.md` para
 * a procedência e `dados/tuss22-odontologia.csv` para os 370 códigos vigentes.
 *
 * **Nenhum código aqui foi inventado.** 36 dos 49 procedimentos têm
 * correspondência inequívoca na tabela oficial. Os outros 13 ficam com
 * `codigoTuss` ausente de propósito: a Tabela 22 não tem código para eles
 * (frenectomia, orientação de higiene) ou tem VÁRIOS e a escolha é da clínica
 * (coroa provisória com ou sem pino? aparelho fixo metálico ou estético?).
 * Escolher no lugar dela geraria glosa em nome dela. A lista e o motivo de cada
 * um estão em `dados/README.md`.
 *
 * Os valores são de partida e devem ser revisados com a clínica — variam por
 * região, especialidade e tabela própria.
 *
 * `requerDente` / `requerFace` NÃO são detalhe de cadastro: são o que faz o
 * odontograma e a validação de faces funcionarem. Ver lib/domain/itemPlano.ts.
 */
interface SeedProcedimento {
  codigo: string
  nome: string
  /** Código oficial da Tabela 22 da ANS. Ausente = ver `dados/README.md`. */
  codigoTuss?: string
  especialidade: string
  valorParticular: string
  requerDente?: boolean
  requerFace?: boolean
  duracaoMinutos?: number
  descricao?: string
}

const CATALOGO: readonly SeedProcedimento[] = [
  // ── Diagnóstico e prevenção ────────────────────────────────────────────────
  { codigo: 'CONS-001', codigoTuss: '81000065', nome: 'Consulta odontológica inicial', especialidade: 'Clínica geral', valorParticular: '180.00', duracaoMinutos: 45 },
  { codigo: 'CONS-002', nome: 'Consulta de retorno', especialidade: 'Clínica geral', valorParticular: '120.00', duracaoMinutos: 30 },
  { codigo: 'CONS-003', codigoTuss: '81000049', nome: 'Consulta de urgência', especialidade: 'Clínica geral', valorParticular: '250.00', duracaoMinutos: 40 },
  { codigo: 'PREV-001', codigoTuss: '84000198', nome: 'Profilaxia e polimento dentário', especialidade: 'Prevenção', valorParticular: '160.00', duracaoMinutos: 40 },
  { codigo: 'PREV-002', codigoTuss: '84000090', nome: 'Aplicação tópica de flúor', especialidade: 'Prevenção', valorParticular: '90.00', duracaoMinutos: 20 },
  { codigo: 'PREV-003', codigoTuss: '84000074', nome: 'Selante de fóssulas e fissuras', especialidade: 'Prevenção', valorParticular: '110.00', requerDente: true, duracaoMinutos: 25 },
  { codigo: 'PREV-004', nome: 'Orientação de higiene bucal', especialidade: 'Prevenção', valorParticular: '70.00', duracaoMinutos: 20 },

  // ── Radiologia ─────────────────────────────────────────────────────────────
  { codigo: 'RAD-001', codigoTuss: '81000421', nome: 'Radiografia periapical', especialidade: 'Radiologia', valorParticular: '55.00', requerDente: true, duracaoMinutos: 15 },
  { codigo: 'RAD-002', codigoTuss: '81000405', nome: 'Radiografia panorâmica', especialidade: 'Radiologia', valorParticular: '150.00', duracaoMinutos: 20 },
  { codigo: 'RAD-003', nome: 'Documentação ortodôntica completa', especialidade: 'Radiologia', valorParticular: '450.00', duracaoMinutos: 60 },

  // ── Dentística ─────────────────────────────────────────────────────────────
  { codigo: 'DENT-001', codigoTuss: '85100196', nome: 'Restauração em resina composta — 1 face', especialidade: 'Dentística', valorParticular: '230.00', requerDente: true, requerFace: true, duracaoMinutos: 50 },
  { codigo: 'DENT-002', codigoTuss: '85100200', nome: 'Restauração em resina composta — 2 faces', especialidade: 'Dentística', valorParticular: '300.00', requerDente: true, requerFace: true, duracaoMinutos: 60 },
  { codigo: 'DENT-003', codigoTuss: '85100218', nome: 'Restauração em resina composta — 3 faces', especialidade: 'Dentística', valorParticular: '380.00', requerDente: true, requerFace: true, duracaoMinutos: 70 },
  { codigo: 'DENT-004', codigoTuss: '85100226', nome: 'Restauração em resina composta — 4 ou mais faces', especialidade: 'Dentística', valorParticular: '460.00', requerDente: true, requerFace: true, duracaoMinutos: 80 },
  { codigo: 'DENT-005', codigoTuss: '85200085', nome: 'Restauração provisória', especialidade: 'Dentística', valorParticular: '120.00', requerDente: true, duracaoMinutos: 30 },
  { codigo: 'DENT-006', codigoTuss: '85100064', nome: 'Faceta em resina composta', especialidade: 'Dentística', valorParticular: '750.00', requerDente: true, duracaoMinutos: 90 },
  { codigo: 'DENT-007', codigoTuss: '85100030', nome: 'Clareamento dentário de consultório', especialidade: 'Dentística', valorParticular: '900.00', duracaoMinutos: 90 },
  { codigo: 'DENT-008', codigoTuss: '85100021', nome: 'Clareamento dentário caseiro supervisionado', especialidade: 'Dentística', valorParticular: '650.00', duracaoMinutos: 40 },

  // ── Endodontia ─────────────────────────────────────────────────────────────
  { codigo: 'ENDO-001', codigoTuss: '85200166', nome: 'Tratamento endodôntico — unirradicular', especialidade: 'Endodontia', valorParticular: '850.00', requerDente: true, duracaoMinutos: 90 },
  { codigo: 'ENDO-002', codigoTuss: '85200140', nome: 'Tratamento endodôntico — birradicular', especialidade: 'Endodontia', valorParticular: '1050.00', requerDente: true, duracaoMinutos: 100 },
  { codigo: 'ENDO-003', codigoTuss: '85200158', nome: 'Tratamento endodôntico — multirradicular', especialidade: 'Endodontia', valorParticular: '1300.00', requerDente: true, duracaoMinutos: 120 },
  { codigo: 'ENDO-004', nome: 'Retratamento endodôntico', especialidade: 'Endodontia', valorParticular: '1500.00', requerDente: true, duracaoMinutos: 120 },
  { codigo: 'ENDO-005', codigoTuss: '85200042', nome: 'Pulpotomia', especialidade: 'Endodontia', valorParticular: '400.00', requerDente: true, duracaoMinutos: 60 },

  // ── Periodontia ────────────────────────────────────────────────────────────
  { codigo: 'PERIO-001', codigoTuss: '85300047', nome: 'Raspagem supragengival', especialidade: 'Periodontia', valorParticular: '200.00', duracaoMinutos: 45, descricao: 'Por sextante' },
  { codigo: 'PERIO-002', codigoTuss: '85300039', nome: 'Raspagem subgengival e alisamento radicular', especialidade: 'Periodontia', valorParticular: '320.00', duracaoMinutos: 60, descricao: 'Por sextante' },
  { codigo: 'PERIO-003', codigoTuss: '82000948', nome: 'Gengivoplastia', especialidade: 'Periodontia', valorParticular: '600.00', duracaoMinutos: 70 },
  { codigo: 'PERIO-004', codigoTuss: '85300063', nome: 'Tratamento de abscesso periodontal', especialidade: 'Periodontia', valorParticular: '280.00', requerDente: true, duracaoMinutos: 40 },

  // ── Cirurgia ───────────────────────────────────────────────────────────────
  { codigo: 'CIR-001', codigoTuss: '82000875', nome: 'Exodontia simples', especialidade: 'Cirurgia', valorParticular: '350.00', requerDente: true, duracaoMinutos: 45 },
  { codigo: 'CIR-002', codigoTuss: '82000859', nome: 'Exodontia de raiz residual', especialidade: 'Cirurgia', valorParticular: '420.00', requerDente: true, duracaoMinutos: 50 },
  { codigo: 'CIR-003', codigoTuss: '82001286', nome: 'Exodontia de terceiro molar incluso', especialidade: 'Cirurgia', valorParticular: '900.00', requerDente: true, duracaoMinutos: 80 },
  { codigo: 'CIR-004', nome: 'Frenectomia lingual ou labial', especialidade: 'Cirurgia', valorParticular: '700.00', duracaoMinutos: 60 },
  { codigo: 'CIR-005', codigoTuss: '82001499', nome: 'Sutura e remoção de pontos', especialidade: 'Cirurgia', valorParticular: '110.00', duracaoMinutos: 20 },

  // ── Odontopediatria ───────────────────────────────────────────────────────
  { codigo: 'PED-001', nome: 'Restauração em dente decíduo', especialidade: 'Odontopediatria', valorParticular: '190.00', requerDente: true, requerFace: true, duracaoMinutos: 45 },
  { codigo: 'PED-002', codigoTuss: '83000127', nome: 'Pulpotomia em dente decíduo', especialidade: 'Odontopediatria', valorParticular: '350.00', requerDente: true, duracaoMinutos: 60 },
  { codigo: 'PED-003', codigoTuss: '83000046', nome: 'Coroa de aço em dente decíduo', especialidade: 'Odontopediatria', valorParticular: '400.00', requerDente: true, duracaoMinutos: 60 },
  { codigo: 'PED-004', codigoTuss: '83000089', nome: 'Exodontia de dente decíduo', especialidade: 'Odontopediatria', valorParticular: '220.00', requerDente: true, duracaoMinutos: 30 },

  // ── Prótese ────────────────────────────────────────────────────────────────
  { codigo: 'PROT-001', nome: 'Coroa provisória', especialidade: 'Prótese', valorParticular: '350.00', requerDente: true, duracaoMinutos: 60 },
  { codigo: 'PROT-002', codigoTuss: '85400157', nome: 'Coroa metalocerâmica', especialidade: 'Prótese', valorParticular: '1600.00', requerDente: true, duracaoMinutos: 90 },
  { codigo: 'PROT-003', codigoTuss: '85400106', nome: 'Coroa em cerâmica pura', especialidade: 'Prótese', valorParticular: '2200.00', requerDente: true, duracaoMinutos: 90 },
  { codigo: 'PROT-004', codigoTuss: '85400220', nome: 'Núcleo metálico fundido', especialidade: 'Prótese', valorParticular: '600.00', requerDente: true, duracaoMinutos: 70 },
  { codigo: 'PROT-005', codigoTuss: '85400408', nome: 'Prótese total (dentadura)', especialidade: 'Prótese', valorParticular: '2400.00', duracaoMinutos: 90 },
  { codigo: 'PROT-006', nome: 'Prótese parcial removível', especialidade: 'Prótese', valorParticular: '2800.00', duracaoMinutos: 90 },

  // ── Implantodontia ────────────────────────────────────────────────────────
  { codigo: 'IMP-001', codigoTuss: '82000980', nome: 'Instalação de implante osseointegrado', especialidade: 'Implantodontia', valorParticular: '3200.00', requerDente: true, duracaoMinutos: 120 },
  { codigo: 'IMP-002', nome: 'Prótese sobre implante', especialidade: 'Implantodontia', valorParticular: '2600.00', requerDente: true, duracaoMinutos: 90 },
  { codigo: 'IMP-003', nome: 'Enxerto ósseo', especialidade: 'Implantodontia', valorParticular: '2000.00', duracaoMinutos: 120 },

  // ── Ortodontia ────────────────────────────────────────────────────────────
  { codigo: 'ORTO-001', nome: 'Instalação de aparelho fixo', especialidade: 'Ortodontia', valorParticular: '2200.00', duracaoMinutos: 90 },
  { codigo: 'ORTO-002', codigoTuss: '86000357', nome: 'Manutenção ortodôntica mensal', especialidade: 'Ortodontia', valorParticular: '280.00', duracaoMinutos: 30 },
  { codigo: 'ORTO-003', nome: 'Remoção de aparelho fixo', especialidade: 'Ortodontia', valorParticular: '450.00', duracaoMinutos: 60 },
  { codigo: 'ORTO-004', nome: 'Contenção ortodôntica', especialidade: 'Ortodontia', valorParticular: '500.00', duracaoMinutos: 45 },
]

/** Idempotente: atualiza nome, valor e flags se o código já existir. */
export async function seedProcedimentos(db: Executor): Promise<number> {
  await db
    .insert(procedimento)
    .values(
      CATALOGO.map((p) => ({
        codigo: p.codigo,
        nome: p.nome,
        codigoTuss: p.codigoTuss ?? null,
        descricao: p.descricao ?? null,
        especialidade: p.especialidade,
        valorParticular: p.valorParticular,
        requerDente: p.requerDente ?? false,
        requerFace: p.requerFace ?? false,
        duracaoMinutos: p.duracaoMinutos ?? 30,
      })),
    )
    .onConflictDoUpdate({
      // O alvo acompanhou o índice: `procedimento_codigo_unique` (global) virou
      // `procedimento_codigo_por_clinica_uk` na 0022. Só `codigo` faz o Postgres
      // recusar com "no unique or exclusion constraint matching the ON CONFLICT
      // specification" — e o catálogo semente é o mesmo molde em toda clínica,
      // então é o caminho normal do onboarding que quebraria, não um caso de borda.
      target: [procedimento.clinicaId, procedimento.codigo],
      set: {
        nome: sql`excluded.nome`,
        codigoTuss: sql`excluded.codigo_tuss`,
        descricao: sql`excluded.descricao`,
        especialidade: sql`excluded.especialidade`,
        valorParticular: sql`excluded.valor_particular`,
        requerDente: sql`excluded.requer_dente`,
        requerFace: sql`excluded.requer_face`,
        duracaoMinutos: sql`excluded.duracao_minutos`,
      },
    })

  return CATALOGO.length
}

export { CATALOGO as catalogoProcedimentos }
