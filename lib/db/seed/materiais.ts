import type { Db } from '@/lib/db'
import { insumoProcedimento, material, procedimento } from '@/lib/db/schema'
import { sql } from 'drizzle-orm'

/**
 * Catálogo inicial de materiais e a ficha técnica dos procedimentos.
 *
 * ── O que este seed NÃO faz ─────────────────────────────────────────────────
 * Não cria lote e não cria saldo. Estoque inicial é contagem física: só a
 * clínica sabe o que tem na prateleira e com que validade. Semear saldo
 * fictício seria pior que semear nada — o primeiro alerta de mínimo viria de um
 * número inventado, e ninguém confia em alerta que já mentiu uma vez.
 *
 * ── `unidadesPorEmbalagem` é a conversão da nota fiscal ─────────────────────
 * A unidade do material é a de CONSUMO (um tubete, uma luva). A compra vem em
 * caixa. Quem lança "2" ao receber 2 caixas de 100 luvas cria um erro que só
 * aparece semanas depois, como alerta de mínimo que nunca dispara.
 *
 * ── Os mínimos são de partida ───────────────────────────────────────────────
 * Foram postos na ordem de grandeza do consumo de um consultório de duas
 * cadeiras. O número certo sai do consumo real: depois de um mês de movimento,
 * a tela de estoque mostra a média diária e a cobertura em dias.
 */
interface SeedMaterial {
  codigo: string
  nome: string
  categoria:
    | 'anestesico'
    | 'restaurador'
    | 'endodontia'
    | 'cirurgia'
    | 'protese'
    | 'ortodontia'
    | 'radiologia'
    | 'descartavel'
    | 'instrumental'
    | 'esterilizacao'
    | 'medicamento'
    | 'escritorio'
  unidade: 'unidade' | 'tubete' | 'caixa' | 'frasco' | 'ml' | 'g' | 'par' | 'rolo' | 'folha'
  unidadesPorEmbalagem?: number
  embalagem?: string
  quantidadeMinima: string
  controlado?: boolean
  exigeLoteDoFabricante?: boolean
  descricao?: string
}

const CATALOGO: readonly SeedMaterial[] = [
  // ── Anestésicos ───────────────────────────────────────────────────────────
  {
    codigo: 'ANE-001',
    nome: 'Anestésico lidocaína 2% com epinefrina 1:100.000',
    categoria: 'anestesico',
    unidade: 'tubete',
    unidadesPorEmbalagem: 50,
    embalagem: 'caixa com 50 tubetes',
    quantidadeMinima: '50',
    exigeLoteDoFabricante: true,
  },
  {
    codigo: 'ANE-002',
    nome: 'Anestésico mepivacaína 3% sem vasoconstritor',
    categoria: 'anestesico',
    unidade: 'tubete',
    unidadesPorEmbalagem: 50,
    embalagem: 'caixa com 50 tubetes',
    quantidadeMinima: '20',
    exigeLoteDoFabricante: true,
    descricao: 'Para cardiopata e gestante, quando o vasoconstritor é contraindicado.',
  },
  {
    codigo: 'ANE-003',
    nome: 'Anestésico tópico em gel (benzocaína 20%)',
    categoria: 'anestesico',
    unidade: 'frasco',
    quantidadeMinima: '2',
  },
  {
    codigo: 'ANE-004',
    nome: 'Agulha gengival descartável curta 30G',
    categoria: 'descartavel',
    unidade: 'unidade',
    unidadesPorEmbalagem: 100,
    embalagem: 'caixa com 100',
    quantidadeMinima: '100',
  },

  // ── Restauradores ─────────────────────────────────────────────────────────
  {
    codigo: 'RES-001',
    nome: 'Resina composta nanoparticulada A2 — seringa 4 g',
    categoria: 'restaurador',
    unidade: 'g',
    quantidadeMinima: '8',
    exigeLoteDoFabricante: true,
    descricao: 'Consumo em gramas: uma restauração de classe I usa cerca de 0,2 g.',
  },
  {
    codigo: 'RES-002',
    nome: 'Resina composta nanoparticulada A3 — seringa 4 g',
    categoria: 'restaurador',
    unidade: 'g',
    quantidadeMinima: '8',
    exigeLoteDoFabricante: true,
  },
  {
    codigo: 'RES-003',
    nome: 'Sistema adesivo universal — frasco 5 ml',
    categoria: 'restaurador',
    unidade: 'ml',
    quantidadeMinima: '5',
    exigeLoteDoFabricante: true,
  },
  {
    codigo: 'RES-004',
    nome: 'Ácido fosfórico 37% em gel — seringa 2,5 ml',
    categoria: 'restaurador',
    unidade: 'ml',
    quantidadeMinima: '5',
  },
  {
    codigo: 'RES-005',
    nome: 'Ionômero de vidro restaurador (pó + líquido)',
    categoria: 'restaurador',
    unidade: 'unidade',
    quantidadeMinima: '1',
  },
  {
    codigo: 'RES-006',
    nome: 'Matriz de poliéster em tira',
    categoria: 'restaurador',
    unidade: 'unidade',
    unidadesPorEmbalagem: 50,
    embalagem: 'pacote com 50',
    quantidadeMinima: '50',
  },

  // ── Endodontia ────────────────────────────────────────────────────────────
  {
    codigo: 'END-001',
    nome: 'Lima endodôntica rotatória (kit de sequência)',
    categoria: 'endodontia',
    unidade: 'unidade',
    quantidadeMinima: '3',
    exigeLoteDoFabricante: true,
    descricao: 'Uso limitado por número de canais — descarte é parte do consumo normal.',
  },
  {
    codigo: 'END-002',
    nome: 'Hipoclorito de sódio 2,5% — frasco 1 L',
    categoria: 'endodontia',
    unidade: 'ml',
    unidadesPorEmbalagem: 1000,
    embalagem: 'frasco de 1 litro',
    quantidadeMinima: '500',
  },
  {
    codigo: 'END-003',
    nome: 'Cimento obturador endodôntico',
    categoria: 'endodontia',
    unidade: 'g',
    quantidadeMinima: '5',
    exigeLoteDoFabricante: true,
  },
  {
    codigo: 'END-004',
    nome: 'Cone de guta-percha',
    categoria: 'endodontia',
    unidade: 'unidade',
    unidadesPorEmbalagem: 120,
    embalagem: 'caixa com 120',
    quantidadeMinima: '60',
  },

  // ── Cirurgia e implante ───────────────────────────────────────────────────
  {
    codigo: 'CIR-001',
    nome: 'Fio de sutura seda 4-0 com agulha',
    categoria: 'cirurgia',
    unidade: 'unidade',
    unidadesPorEmbalagem: 24,
    embalagem: 'caixa com 24 envelopes',
    quantidadeMinima: '12',
    exigeLoteDoFabricante: true,
  },
  {
    codigo: 'CIR-002',
    nome: 'Lâmina de bisturi nº 15 descartável',
    categoria: 'cirurgia',
    unidade: 'unidade',
    unidadesPorEmbalagem: 100,
    embalagem: 'caixa com 100',
    quantidadeMinima: '20',
  },
  {
    codigo: 'CIR-003',
    nome: 'Esponja hemostática de colágeno',
    categoria: 'cirurgia',
    unidade: 'unidade',
    quantidadeMinima: '5',
    exigeLoteDoFabricante: true,
  },
  {
    codigo: 'IMP-001',
    nome: 'Implante de titânio (cone morse)',
    categoria: 'cirurgia',
    unidade: 'unidade',
    quantidadeMinima: '2',
    exigeLoteDoFabricante: true,
    descricao:
      'Rastreabilidade obrigatória: recolhimento de lote precisa responder em quais pacientes foi usado.',
  },
  {
    codigo: 'IMP-002',
    nome: 'Enxerto ósseo bovino liofilizado — frasco 0,5 g',
    categoria: 'cirurgia',
    unidade: 'g',
    quantidadeMinima: '1',
    exigeLoteDoFabricante: true,
  },

  // ── Prevenção e profilaxia ────────────────────────────────────────────────
  {
    codigo: 'PRE-001',
    nome: 'Pasta profilática com flúor',
    categoria: 'restaurador',
    unidade: 'g',
    quantidadeMinima: '50',
  },
  {
    codigo: 'PRE-002',
    nome: 'Escova de Robinson para profilaxia',
    categoria: 'descartavel',
    unidade: 'unidade',
    unidadesPorEmbalagem: 24,
    embalagem: 'pacote com 24',
    quantidadeMinima: '24',
  },
  {
    codigo: 'PRE-003',
    nome: 'Flúor gel neutro — frasco 200 ml',
    categoria: 'medicamento',
    unidade: 'ml',
    unidadesPorEmbalagem: 200,
    embalagem: 'frasco de 200 ml',
    quantidadeMinima: '100',
  },
  {
    codigo: 'PRE-004',
    nome: 'Selante resinoso fotopolimerizável',
    categoria: 'restaurador',
    unidade: 'ml',
    quantidadeMinima: '2',
  },

  // ── Radiologia ────────────────────────────────────────────────────────────
  {
    codigo: 'RAD-001',
    nome: 'Filme radiográfico periapical adulto',
    categoria: 'radiologia',
    unidade: 'unidade',
    unidadesPorEmbalagem: 150,
    embalagem: 'caixa com 150',
    quantidadeMinima: '50',
  },
  {
    codigo: 'RAD-002',
    nome: 'Protetor descartável para sensor digital',
    categoria: 'descartavel',
    unidade: 'unidade',
    unidadesPorEmbalagem: 500,
    embalagem: 'caixa com 500',
    quantidadeMinima: '100',
  },

  // ── Barreira e biossegurança ──────────────────────────────────────────────
  {
    codigo: 'BIO-001',
    nome: 'Luva de procedimento tamanho M',
    categoria: 'descartavel',
    unidade: 'par',
    unidadesPorEmbalagem: 50,
    embalagem: 'caixa com 100 unidades (50 pares)',
    quantidadeMinima: '200',
  },
  {
    codigo: 'BIO-002',
    nome: 'Máscara cirúrgica tripla com elástico',
    categoria: 'descartavel',
    unidade: 'unidade',
    unidadesPorEmbalagem: 50,
    embalagem: 'caixa com 50',
    quantidadeMinima: '100',
  },
  {
    codigo: 'BIO-003',
    nome: 'Sugador descartável',
    categoria: 'descartavel',
    unidade: 'unidade',
    unidadesPorEmbalagem: 40,
    embalagem: 'pacote com 40',
    quantidadeMinima: '80',
  },
  {
    codigo: 'BIO-004',
    nome: 'Babador descartável impermeável',
    categoria: 'descartavel',
    unidade: 'unidade',
    unidadesPorEmbalagem: 100,
    embalagem: 'pacote com 100',
    quantidadeMinima: '100',
  },
  {
    codigo: 'BIO-005',
    nome: 'Rolo de algodão',
    categoria: 'descartavel',
    unidade: 'unidade',
    unidadesPorEmbalagem: 100,
    embalagem: 'pacote com 100',
    quantidadeMinima: '200',
  },
  {
    codigo: 'BIO-006',
    nome: 'Gaze estéril 7,5 × 7,5 cm',
    categoria: 'descartavel',
    unidade: 'unidade',
    unidadesPorEmbalagem: 10,
    embalagem: 'pacote com 10',
    quantidadeMinima: '50',
  },

  // ── Esterilização ─────────────────────────────────────────────────────────
  {
    codigo: 'EST-001',
    nome: 'Envelope para autoclave 90 × 260 mm',
    categoria: 'esterilizacao',
    unidade: 'unidade',
    unidadesPorEmbalagem: 100,
    embalagem: 'caixa com 100',
    quantidadeMinima: '100',
  },
  {
    codigo: 'EST-002',
    nome: 'Indicador biológico para autoclave',
    categoria: 'esterilizacao',
    unidade: 'unidade',
    quantidadeMinima: '4',
    exigeLoteDoFabricante: true,
    descricao: 'Registro do controle de esterilização — o lote é parte do laudo.',
  },
  {
    codigo: 'EST-003',
    nome: 'Desinfetante de superfície à base de álcool 70%',
    categoria: 'esterilizacao',
    unidade: 'ml',
    unidadesPorEmbalagem: 1000,
    embalagem: 'frasco de 1 litro',
    quantidadeMinima: '1000',
  },

  // ── Prótese e ortodontia ──────────────────────────────────────────────────
  {
    codigo: 'PRO-001',
    nome: 'Silicone de adição para moldagem',
    categoria: 'protese',
    unidade: 'ml',
    quantidadeMinima: '50',
    exigeLoteDoFabricante: true,
  },
  {
    codigo: 'PRO-002',
    nome: 'Cimento resinoso para cimentação definitiva',
    categoria: 'protese',
    unidade: 'g',
    quantidadeMinima: '5',
    exigeLoteDoFabricante: true,
  },
  {
    codigo: 'ORT-001',
    nome: 'Braquete metálico (unidade)',
    categoria: 'ortodontia',
    unidade: 'unidade',
    quantidadeMinima: '40',
  },
  {
    codigo: 'ORT-002',
    nome: 'Fio ortodôntico NiTi 0,014"',
    categoria: 'ortodontia',
    unidade: 'unidade',
    quantidadeMinima: '10',
  },
  {
    codigo: 'ORT-003',
    nome: 'Elástico ligadura ortodôntica',
    categoria: 'ortodontia',
    unidade: 'unidade',
    unidadesPorEmbalagem: 1000,
    embalagem: 'saco com 1000',
    quantidadeMinima: '500',
  },

  // ── Medicamento de controle especial ──────────────────────────────────────
  {
    codigo: 'MED-001',
    nome: 'Midazolam 15 mg comprimido',
    categoria: 'medicamento',
    unidade: 'unidade',
    quantidadeMinima: '0',
    controlado: true,
    exigeLoteDoFabricante: true,
    descricao:
      'Controle especial (Portaria 344/98): toda saída exige profissional responsável e motivo. Mínimo zero — só se compra quando há indicação.',
  },
]

/**
 * Ficha técnica: o que cada procedimento consome.
 *
 * Chaveada pelo **código do procedimento** (`procedimento.codigo`), não por id —
 * assim o seed é idempotente e legível. Procedimento ausente do catálogo é
 * ignorado em silêncio? Não: `seedMateriais` conta e devolve quantos vínculos
 * não encontraram procedimento, e o seed imprime o número. Ficha técnica que
 * some sem aviso é baixa que nunca é proposta, e estoque que ninguém usa.
 *
 * As quantidades são **de partida e conservadoras** — uma restauração usa mais
 * gaze e algodão em dente posterior que em anterior. O dentista ajusta na tela
 * de baixa, e é essa correção repetida que revela o número real.
 */
const FICHAS: readonly { procedimento: string; insumos: readonly { material: string; quantidade: string }[] }[] = [
  {
    procedimento: 'CONS-001',
    insumos: [
      { material: 'BIO-001', quantidade: '1' },
      { material: 'BIO-002', quantidade: '1' },
      { material: 'BIO-004', quantidade: '1' },
      { material: 'BIO-003', quantidade: '1' },
    ],
  },
  {
    procedimento: 'PREV-001',
    insumos: [
      { material: 'BIO-001', quantidade: '1' },
      { material: 'BIO-002', quantidade: '1' },
      { material: 'BIO-004', quantidade: '1' },
      { material: 'BIO-003', quantidade: '1' },
      { material: 'PRE-001', quantidade: '2' },
      { material: 'PRE-002', quantidade: '1' },
    ],
  },
  {
    procedimento: 'PREV-002',
    insumos: [
      { material: 'BIO-001', quantidade: '1' },
      { material: 'PRE-003', quantidade: '5' },
      { material: 'BIO-005', quantidade: '4' },
    ],
  },
  {
    procedimento: 'PREV-003',
    insumos: [
      { material: 'BIO-001', quantidade: '1' },
      { material: 'PRE-004', quantidade: '0.1' },
      { material: 'RES-004', quantidade: '0.2' },
      { material: 'BIO-005', quantidade: '2' },
    ],
  },
  {
    procedimento: 'DENT-001',
    insumos: [
      { material: 'BIO-001', quantidade: '1' },
      { material: 'BIO-002', quantidade: '1' },
      { material: 'BIO-004', quantidade: '1' },
      { material: 'BIO-003', quantidade: '1' },
      { material: 'ANE-001', quantidade: '1' },
      { material: 'ANE-004', quantidade: '1' },
      { material: 'ANE-003', quantidade: '0.2' },
      { material: 'RES-001', quantidade: '0.2' },
      { material: 'RES-003', quantidade: '0.1' },
      { material: 'RES-004', quantidade: '0.2' },
      { material: 'BIO-005', quantidade: '4' },
    ],
  },
  {
    procedimento: 'DENT-002',
    insumos: [
      { material: 'BIO-001', quantidade: '1' },
      { material: 'BIO-002', quantidade: '1' },
      { material: 'BIO-004', quantidade: '1' },
      { material: 'BIO-003', quantidade: '1' },
      { material: 'ANE-001', quantidade: '1' },
      { material: 'ANE-004', quantidade: '1' },
      { material: 'RES-001', quantidade: '0.35' },
      { material: 'RES-003', quantidade: '0.1' },
      { material: 'RES-004', quantidade: '0.2' },
      { material: 'RES-006', quantidade: '1' },
      { material: 'BIO-005', quantidade: '4' },
    ],
  },
  {
    procedimento: 'DENT-004',
    insumos: [
      { material: 'BIO-001', quantidade: '1' },
      { material: 'ANE-001', quantidade: '2' },
      { material: 'ANE-004', quantidade: '1' },
      { material: 'RES-001', quantidade: '0.5' },
      { material: 'RES-003', quantidade: '0.15' },
      { material: 'RES-004', quantidade: '0.3' },
      { material: 'RES-006', quantidade: '2' },
      { material: 'BIO-005', quantidade: '6' },
    ],
  },
  {
    procedimento: 'ENDO-001',
    insumos: [
      { material: 'BIO-001', quantidade: '2' },
      { material: 'BIO-002', quantidade: '1' },
      { material: 'ANE-001', quantidade: '2' },
      { material: 'ANE-004', quantidade: '1' },
      { material: 'END-001', quantidade: '1' },
      { material: 'END-002', quantidade: '20' },
      { material: 'END-003', quantidade: '0.3' },
      { material: 'END-004', quantidade: '2' },
      { material: 'BIO-005', quantidade: '8' },
    ],
  },
  {
    procedimento: 'CIR-001',
    insumos: [
      { material: 'BIO-001', quantidade: '2' },
      { material: 'BIO-002', quantidade: '1' },
      { material: 'BIO-006', quantidade: '2' },
      { material: 'ANE-001', quantidade: '2' },
      { material: 'ANE-004', quantidade: '1' },
      { material: 'ANE-003', quantidade: '0.2' },
      { material: 'CIR-001', quantidade: '1' },
      { material: 'CIR-002', quantidade: '1' },
    ],
  },
  {
    procedimento: 'DENT-003',
    insumos: [
      { material: 'BIO-001', quantidade: '1' },
      { material: 'BIO-002', quantidade: '1' },
      { material: 'BIO-004', quantidade: '1' },
      { material: 'BIO-003', quantidade: '1' },
      { material: 'ANE-001', quantidade: '1' },
      { material: 'ANE-004', quantidade: '1' },
      { material: 'RES-001', quantidade: '0.45' },
      { material: 'RES-003', quantidade: '0.12' },
      { material: 'RES-004', quantidade: '0.25' },
      { material: 'RES-006', quantidade: '2' },
      { material: 'BIO-005', quantidade: '5' },
    ],
  },
  {
    procedimento: 'DENT-005',
    insumos: [
      { material: 'BIO-001', quantidade: '1' },
      { material: 'RES-005', quantidade: '0.05' },
      { material: 'BIO-005', quantidade: '2' },
    ],
  },
  {
    procedimento: 'PED-001',
    insumos: [
      { material: 'BIO-001', quantidade: '1' },
      { material: 'BIO-002', quantidade: '1' },
      { material: 'BIO-004', quantidade: '1' },
      { material: 'BIO-003', quantidade: '1' },
      { material: 'ANE-002', quantidade: '1' },
      { material: 'ANE-004', quantidade: '1' },
      { material: 'ANE-003', quantidade: '0.2' },
      { material: 'RES-005', quantidade: '0.1' },
      { material: 'BIO-005', quantidade: '3' },
    ],
  },
  {
    procedimento: 'PERIO-002',
    insumos: [
      { material: 'BIO-001', quantidade: '2' },
      { material: 'BIO-002', quantidade: '1' },
      { material: 'ANE-001', quantidade: '2' },
      { material: 'ANE-004', quantidade: '1' },
      { material: 'BIO-005', quantidade: '6' },
      { material: 'BIO-003', quantidade: '1' },
    ],
  },
  {
    procedimento: 'ENDO-003',
    insumos: [
      { material: 'BIO-001', quantidade: '2' },
      { material: 'BIO-002', quantidade: '1' },
      { material: 'ANE-001', quantidade: '3' },
      { material: 'ANE-004', quantidade: '1' },
      { material: 'END-001', quantidade: '1' },
      { material: 'END-002', quantidade: '40' },
      { material: 'END-003', quantidade: '0.6' },
      { material: 'END-004', quantidade: '4' },
      { material: 'BIO-005', quantidade: '10' },
    ],
  },
  {
    procedimento: 'CIR-003',
    insumos: [
      { material: 'BIO-001', quantidade: '2' },
      { material: 'BIO-002', quantidade: '1' },
      { material: 'BIO-006', quantidade: '4' },
      { material: 'ANE-001', quantidade: '3' },
      { material: 'ANE-004', quantidade: '2' },
      { material: 'ANE-003', quantidade: '0.2' },
      { material: 'CIR-001', quantidade: '1' },
      { material: 'CIR-002', quantidade: '1' },
      { material: 'CIR-003', quantidade: '1' },
      { material: 'EST-001', quantidade: '2' },
    ],
  },
  {
    procedimento: 'RAD-001',
    insumos: [
      { material: 'BIO-001', quantidade: '1' },
      { material: 'RAD-002', quantidade: '1' },
    ],
  },
  {
    procedimento: 'IMP-001',
    insumos: [
      { material: 'BIO-001', quantidade: '2' },
      { material: 'BIO-002', quantidade: '1' },
      { material: 'BIO-006', quantidade: '4' },
      { material: 'ANE-001', quantidade: '3' },
      { material: 'ANE-004', quantidade: '1' },
      { material: 'IMP-001', quantidade: '1' },
      { material: 'CIR-001', quantidade: '1' },
      { material: 'CIR-002', quantidade: '1' },
      { material: 'EST-001', quantidade: '2' },
    ],
  },
]

export interface ResultadoSeedMateriais {
  readonly materiais: number
  readonly vinculos: number
  /** Códigos de procedimento da ficha técnica que não existem no catálogo. */
  readonly procedimentosAusentes: readonly string[]
}

export async function seedMateriais(db: Db): Promise<ResultadoSeedMateriais> {
  await db
    .insert(material)
    .values([...CATALOGO])
    .onConflictDoUpdate({
      target: material.codigo,
      set: {
        nome: sql`excluded.nome`,
        categoria: sql`excluded.categoria`,
        unidade: sql`excluded.unidade`,
        unidadesPorEmbalagem: sql`excluded.unidades_por_embalagem`,
        embalagem: sql`excluded.embalagem`,
        // `quantidade_minima` é ajustada pela clínica com base no consumo real —
        // reimportar o seed não deve desfazer esse ajuste.
        controlado: sql`excluded.controlado`,
        exigeLoteDoFabricante: sql`excluded.exige_lote_do_fabricante`,
        descricao: sql`excluded.descricao`,
        atualizadoEm: sql`now()`,
      },
    })

  const materiaisPorCodigo = new Map(
    (await db.select({ id: material.id, codigo: material.codigo }).from(material)).map((m) => [
      m.codigo,
      m.id,
    ]),
  )
  const procedimentosPorCodigo = new Map(
    (await db.select({ id: procedimento.id, codigo: procedimento.codigo }).from(procedimento)).map(
      (p) => [p.codigo, p.id],
    ),
  )

  const linhas: { procedimentoId: string; materialId: string; quantidade: string }[] = []
  const ausentes: string[] = []

  for (const ficha of FICHAS) {
    const procedimentoId = procedimentosPorCodigo.get(ficha.procedimento)
    if (procedimentoId === undefined) {
      ausentes.push(ficha.procedimento)
      continue
    }
    for (const insumo of ficha.insumos) {
      const materialId = materiaisPorCodigo.get(insumo.material)
      if (materialId === undefined) {
        ausentes.push(`${ficha.procedimento}/${insumo.material}`)
        continue
      }
      linhas.push({ procedimentoId, materialId, quantidade: insumo.quantidade })
    }
  }

  if (linhas.length > 0) {
    await db
      .insert(insumoProcedimento)
      .values(linhas)
      .onConflictDoUpdate({
        target: [insumoProcedimento.procedimentoId, insumoProcedimento.materialId],
        set: { quantidade: sql`excluded.quantidade` },
      })
  }

  return { materiais: CATALOGO.length, vinculos: linhas.length, procedimentosAusentes: ausentes }
}

export const catalogoMateriais = CATALOGO
export const fichasTecnicas = FICHAS
