import { z } from 'zod'

/** Validação de entrada da agenda. Ver o padrão em lib/pacientes/schema.ts. */

const vazioParaNulo = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? null : v

const DIA = /^\d{4}-\d{2}-\d{2}$/
const HORA = /^\d{2}:\d{2}$/

export const agendamentoSchema = z.object({
  pacienteId: z.string().uuid('Selecione o paciente.'),
  profissionalId: z.string().uuid('Selecione o profissional.'),
  cadeiraId: z.preprocess(vazioParaNulo, z.string().uuid().nullable().optional()),
  dia: z.string().regex(DIA, 'Data inválida.'),
  hora: z.string().regex(HORA, 'Hora inválida.'),
  // 5 minutos é o menor atendimento plausível; 8 horas, o maior.
  duracaoMinutos: z.coerce
    .number()
    .int('Duração deve ser em minutos inteiros.')
    .min(5, 'Duração mínima de 5 minutos.')
    .max(480, 'Duração máxima de 8 horas.'),
  origem: z
    .enum(['recepcao', 'telefone', 'whatsapp', 'portal', 'encaixe'])
    .default('recepcao'),
  observacao: z.preprocess(vazioParaNulo, z.string().trim().max(1000).nullable().optional()),

  // ── Recorrência (opcional) ─────────────────────────────────────────────────
  // Existe para a manutenção ortodôntica mensal, que é o caso mais comum de
  // repetição num consultório.
  repetir: z.preprocess(
    vazioParaNulo,
    z.enum(['semanal', 'quinzenal', 'mensal']).nullable().optional(),
  ),
  repeticoes: z.preprocess(
    (v) => (v === '' || v == null ? 1 : v),
    z.coerce.number().int().min(1).max(24).default(1),
  ),
})

export type EntradaAgendamento = z.input<typeof agendamentoSchema>
export type AgendamentoValidado = z.output<typeof agendamentoSchema>

export const bloqueioSchema = z
  .object({
    profissionalId: z.preprocess(vazioParaNulo, z.string().uuid().nullable().optional()),
    cadeiraId: z.preprocess(vazioParaNulo, z.string().uuid().nullable().optional()),
    diaInicio: z.string().regex(DIA, 'Data inicial inválida.'),
    horaInicio: z.string().regex(HORA, 'Hora inicial inválida.'),
    diaFim: z.string().regex(DIA, 'Data final inválida.'),
    horaFim: z.string().regex(HORA, 'Hora final inválida.'),
    motivo: z.string().trim().min(3, 'Informe o motivo do bloqueio.').max(200),
  })
  .refine(
    (d) => `${d.diaInicio}T${d.horaInicio}` < `${d.diaFim}T${d.horaFim}`,
    { path: ['horaFim'], message: 'O fim precisa ser depois do início.' },
  )

export type BloqueioValidado = z.output<typeof bloqueioSchema>

export const cancelamentoSchema = z.object({
  // Espelha o CHECK agendamento_cancelado_tem_motivo do banco.
  motivo: z.string().trim().min(3, 'Informe o motivo do cancelamento.').max(300),
})

export { achatarErros, dosCampos } from '@/lib/pacientes/schema'
