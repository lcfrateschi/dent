import type { Db } from '@/lib/db'
import { procedimento } from '@/lib/db/schema'
import { sql } from 'drizzle-orm'

/**
 * Catálogo inicial de procedimentos.
 *
 * ⚠️ `codigo_tuss` fica NULO de propósito. Código TUSS errado gera glosa —
 * não se inventa. A tabela oficial é a **Terminologia Unificada em Saúde
 * Suplementar (Tabela 22, procedimentos odontológicos)**, publicada pela ANS e
 * revisada periodicamente. Baixe a versão vigente e importe antes da Fase 13
 * (convênios); até lá tudo aqui é particular e o TUSS não é usado.
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
  especialidade: string
  valorParticular: string
  requerDente?: boolean
  requerFace?: boolean
  duracaoMinutos?: number
  descricao?: string
}

const CATALOGO: readonly SeedProcedimento[] = [
  // ── Diagnóstico e prevenção ────────────────────────────────────────────────
  { codigo: 'CONS-001', nome: 'Consulta odontológica inicial', especialidade: 'Clínica geral', valorParticular: '180.00', duracaoMinutos: 45 },
  { codigo: 'CONS-002', nome: 'Consulta de retorno', especialidade: 'Clínica geral', valorParticular: '120.00', duracaoMinutos: 30 },
  { codigo: 'CONS-003', nome: 'Consulta de urgência', especialidade: 'Clínica geral', valorParticular: '250.00', duracaoMinutos: 40 },
  { codigo: 'PREV-001', nome: 'Profilaxia e polimento dentário', especialidade: 'Prevenção', valorParticular: '160.00', duracaoMinutos: 40 },
  { codigo: 'PREV-002', nome: 'Aplicação tópica de flúor', especialidade: 'Prevenção', valorParticular: '90.00', duracaoMinutos: 20 },
  { codigo: 'PREV-003', nome: 'Selante de fóssulas e fissuras', especialidade: 'Prevenção', valorParticular: '110.00', requerDente: true, duracaoMinutos: 25 },
  { codigo: 'PREV-004', nome: 'Orientação de higiene bucal', especialidade: 'Prevenção', valorParticular: '70.00', duracaoMinutos: 20 },

  // ── Radiologia ─────────────────────────────────────────────────────────────
  { codigo: 'RAD-001', nome: 'Radiografia periapical', especialidade: 'Radiologia', valorParticular: '55.00', requerDente: true, duracaoMinutos: 15 },
  { codigo: 'RAD-002', nome: 'Radiografia panorâmica', especialidade: 'Radiologia', valorParticular: '150.00', duracaoMinutos: 20 },
  { codigo: 'RAD-003', nome: 'Documentação ortodôntica completa', especialidade: 'Radiologia', valorParticular: '450.00', duracaoMinutos: 60 },

  // ── Dentística ─────────────────────────────────────────────────────────────
  { codigo: 'DENT-001', nome: 'Restauração em resina composta — 1 face', especialidade: 'Dentística', valorParticular: '230.00', requerDente: true, requerFace: true, duracaoMinutos: 50 },
  { codigo: 'DENT-002', nome: 'Restauração em resina composta — 2 faces', especialidade: 'Dentística', valorParticular: '300.00', requerDente: true, requerFace: true, duracaoMinutos: 60 },
  { codigo: 'DENT-003', nome: 'Restauração em resina composta — 3 faces', especialidade: 'Dentística', valorParticular: '380.00', requerDente: true, requerFace: true, duracaoMinutos: 70 },
  { codigo: 'DENT-004', nome: 'Restauração em resina composta — 4 ou mais faces', especialidade: 'Dentística', valorParticular: '460.00', requerDente: true, requerFace: true, duracaoMinutos: 80 },
  { codigo: 'DENT-005', nome: 'Restauração provisória', especialidade: 'Dentística', valorParticular: '120.00', requerDente: true, duracaoMinutos: 30 },
  { codigo: 'DENT-006', nome: 'Faceta em resina composta', especialidade: 'Dentística', valorParticular: '750.00', requerDente: true, duracaoMinutos: 90 },
  { codigo: 'DENT-007', nome: 'Clareamento dentário de consultório', especialidade: 'Dentística', valorParticular: '900.00', duracaoMinutos: 90 },
  { codigo: 'DENT-008', nome: 'Clareamento dentário caseiro supervisionado', especialidade: 'Dentística', valorParticular: '650.00', duracaoMinutos: 40 },

  // ── Endodontia ─────────────────────────────────────────────────────────────
  { codigo: 'ENDO-001', nome: 'Tratamento endodôntico — unirradicular', especialidade: 'Endodontia', valorParticular: '850.00', requerDente: true, duracaoMinutos: 90 },
  { codigo: 'ENDO-002', nome: 'Tratamento endodôntico — birradicular', especialidade: 'Endodontia', valorParticular: '1050.00', requerDente: true, duracaoMinutos: 100 },
  { codigo: 'ENDO-003', nome: 'Tratamento endodôntico — multirradicular', especialidade: 'Endodontia', valorParticular: '1300.00', requerDente: true, duracaoMinutos: 120 },
  { codigo: 'ENDO-004', nome: 'Retratamento endodôntico', especialidade: 'Endodontia', valorParticular: '1500.00', requerDente: true, duracaoMinutos: 120 },
  { codigo: 'ENDO-005', nome: 'Pulpotomia', especialidade: 'Endodontia', valorParticular: '400.00', requerDente: true, duracaoMinutos: 60 },

  // ── Periodontia ────────────────────────────────────────────────────────────
  { codigo: 'PERIO-001', nome: 'Raspagem supragengival', especialidade: 'Periodontia', valorParticular: '200.00', duracaoMinutos: 45, descricao: 'Por sextante' },
  { codigo: 'PERIO-002', nome: 'Raspagem subgengival e alisamento radicular', especialidade: 'Periodontia', valorParticular: '320.00', duracaoMinutos: 60, descricao: 'Por sextante' },
  { codigo: 'PERIO-003', nome: 'Gengivoplastia', especialidade: 'Periodontia', valorParticular: '600.00', duracaoMinutos: 70 },
  { codigo: 'PERIO-004', nome: 'Tratamento de abscesso periodontal', especialidade: 'Periodontia', valorParticular: '280.00', requerDente: true, duracaoMinutos: 40 },

  // ── Cirurgia ───────────────────────────────────────────────────────────────
  { codigo: 'CIR-001', nome: 'Exodontia simples', especialidade: 'Cirurgia', valorParticular: '350.00', requerDente: true, duracaoMinutos: 45 },
  { codigo: 'CIR-002', nome: 'Exodontia de raiz residual', especialidade: 'Cirurgia', valorParticular: '420.00', requerDente: true, duracaoMinutos: 50 },
  { codigo: 'CIR-003', nome: 'Exodontia de terceiro molar incluso', especialidade: 'Cirurgia', valorParticular: '900.00', requerDente: true, duracaoMinutos: 80 },
  { codigo: 'CIR-004', nome: 'Frenectomia lingual ou labial', especialidade: 'Cirurgia', valorParticular: '700.00', duracaoMinutos: 60 },
  { codigo: 'CIR-005', nome: 'Sutura e remoção de pontos', especialidade: 'Cirurgia', valorParticular: '110.00', duracaoMinutos: 20 },

  // ── Odontopediatria ───────────────────────────────────────────────────────
  { codigo: 'PED-001', nome: 'Restauração em dente decíduo', especialidade: 'Odontopediatria', valorParticular: '190.00', requerDente: true, requerFace: true, duracaoMinutos: 45 },
  { codigo: 'PED-002', nome: 'Pulpotomia em dente decíduo', especialidade: 'Odontopediatria', valorParticular: '350.00', requerDente: true, duracaoMinutos: 60 },
  { codigo: 'PED-003', nome: 'Coroa de aço em dente decíduo', especialidade: 'Odontopediatria', valorParticular: '400.00', requerDente: true, duracaoMinutos: 60 },
  { codigo: 'PED-004', nome: 'Exodontia de dente decíduo', especialidade: 'Odontopediatria', valorParticular: '220.00', requerDente: true, duracaoMinutos: 30 },

  // ── Prótese ────────────────────────────────────────────────────────────────
  { codigo: 'PROT-001', nome: 'Coroa provisória', especialidade: 'Prótese', valorParticular: '350.00', requerDente: true, duracaoMinutos: 60 },
  { codigo: 'PROT-002', nome: 'Coroa metalocerâmica', especialidade: 'Prótese', valorParticular: '1600.00', requerDente: true, duracaoMinutos: 90 },
  { codigo: 'PROT-003', nome: 'Coroa em cerâmica pura', especialidade: 'Prótese', valorParticular: '2200.00', requerDente: true, duracaoMinutos: 90 },
  { codigo: 'PROT-004', nome: 'Núcleo metálico fundido', especialidade: 'Prótese', valorParticular: '600.00', requerDente: true, duracaoMinutos: 70 },
  { codigo: 'PROT-005', nome: 'Prótese total (dentadura)', especialidade: 'Prótese', valorParticular: '2400.00', duracaoMinutos: 90 },
  { codigo: 'PROT-006', nome: 'Prótese parcial removível', especialidade: 'Prótese', valorParticular: '2800.00', duracaoMinutos: 90 },

  // ── Implantodontia ────────────────────────────────────────────────────────
  { codigo: 'IMP-001', nome: 'Instalação de implante osseointegrado', especialidade: 'Implantodontia', valorParticular: '3200.00', requerDente: true, duracaoMinutos: 120 },
  { codigo: 'IMP-002', nome: 'Prótese sobre implante', especialidade: 'Implantodontia', valorParticular: '2600.00', requerDente: true, duracaoMinutos: 90 },
  { codigo: 'IMP-003', nome: 'Enxerto ósseo', especialidade: 'Implantodontia', valorParticular: '2000.00', duracaoMinutos: 120 },

  // ── Ortodontia ────────────────────────────────────────────────────────────
  { codigo: 'ORTO-001', nome: 'Instalação de aparelho fixo', especialidade: 'Ortodontia', valorParticular: '2200.00', duracaoMinutos: 90 },
  { codigo: 'ORTO-002', nome: 'Manutenção ortodôntica mensal', especialidade: 'Ortodontia', valorParticular: '280.00', duracaoMinutos: 30 },
  { codigo: 'ORTO-003', nome: 'Remoção de aparelho fixo', especialidade: 'Ortodontia', valorParticular: '450.00', duracaoMinutos: 60 },
  { codigo: 'ORTO-004', nome: 'Contenção ortodôntica', especialidade: 'Ortodontia', valorParticular: '500.00', duracaoMinutos: 45 },
]

/** Idempotente: atualiza nome, valor e flags se o código já existir. */
export async function seedProcedimentos(db: Db): Promise<number> {
  await db
    .insert(procedimento)
    .values(
      CATALOGO.map((p) => ({
        codigo: p.codigo,
        nome: p.nome,
        descricao: p.descricao ?? null,
        especialidade: p.especialidade,
        valorParticular: p.valorParticular,
        requerDente: p.requerDente ?? false,
        requerFace: p.requerFace ?? false,
        duracaoMinutos: p.duracaoMinutos ?? 30,
      })),
    )
    .onConflictDoUpdate({
      target: procedimento.codigo,
      set: {
        nome: sql`excluded.nome`,
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
