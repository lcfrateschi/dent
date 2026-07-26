import { erro } from './erros'

/**
 * Conversão entre instante (UTC) e hora local da clínica.
 *
 * **Por que isso existe:** o banco guarda `timestamptz`, que é um instante
 * absoluto. Mas a agenda pergunta coisas locais — "em qual coluna do dia este
 * atendimento cai?", "quantos minutos depois das 08:00 ele começa?". Responder
 * isso com `Date#getHours()` usa o fuso do SERVIDOR: o mesmo agendamento
 * apareceria em horas diferentes no container e na máquina do dentista.
 *
 * Então o fuso é **explícito e vem da configuração da clínica**, e toda
 * conversão passa por aqui, via `Intl` — sem dependência externa.
 */

export const FUSO_PADRAO = 'America/Sao_Paulo'

export interface PartesLocais {
  readonly ano: number
  readonly mes: number
  readonly dia: number
  readonly hora: number
  readonly minuto: number
  /** 0 = domingo, 6 = sábado. */
  readonly diaSemana: number
}

const formatadores = new Map<string, Intl.DateTimeFormat>()

function formatador(fuso: string): Intl.DateTimeFormat {
  let f = formatadores.get(fuso)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: fuso,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    } catch {
      erro('FUSO_INVALIDO', `Fuso horário desconhecido: "${fuso}".`, { fuso })
    }
    formatadores.set(fuso, f)
  }
  return f
}

/** Quebra um instante nas partes de calendário do fuso da clínica. */
export function partesLocais(instante: Date, fuso: string = FUSO_PADRAO): PartesLocais {
  if (Number.isNaN(instante.getTime())) {
    erro('DATA_INVALIDA', 'Instante inválido.')
  }
  const p: Record<string, string> = {}
  for (const parte of formatador(fuso).formatToParts(instante)) {
    if (parte.type !== 'literal') p[parte.type] = parte.value
  }
  const ano = Number(p.year)
  const mes = Number(p.month)
  const dia = Number(p.day)
  // `hour12: false` devolve 24 para a meia-noite em alguns runtimes.
  const hora = Number(p.hour) % 24
  const minuto = Number(p.minute)

  return {
    ano,
    mes,
    dia,
    hora,
    minuto,
    // Dia da semana calculado do próprio calendário local, não do Date original.
    diaSemana: new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay(),
  }
}

/** Deslocamento do fuso, em minutos, no instante dado. -180 para BRT. */
export function offsetMinutos(instante: Date, fuso: string = FUSO_PADRAO): number {
  const l = partesLocais(instante, fuso)
  const comoUtc = Date.UTC(l.ano, l.mes - 1, l.dia, l.hora, l.minuto)
  // Zera segundos dos dois lados para a diferença sair em minutos inteiros.
  const original = Math.floor(instante.getTime() / 60000) * 60000
  return Math.round((comoUtc - original) / 60000)
}

export interface DataHoraLocal {
  readonly ano: number
  readonly mes: number
  readonly dia: number
  readonly hora: number
  readonly minuto: number
}

/**
 * Instante UTC correspondente a uma data e hora locais da clínica.
 *
 * Faz duas passadas de propósito: a primeira estimativa usa o offset do palpite,
 * que pode estar do lado errado de uma virada de horário de verão. O Brasil
 * aboliu o horário de verão em 2019, mas o código não deve quebrar se voltar,
 * nem para clínica em outro país.
 */
export function paraInstante(local: DataHoraLocal, fuso: string = FUSO_PADRAO): Date {
  const alvo = Date.UTC(local.ano, local.mes - 1, local.dia, local.hora, local.minuto)

  const offset1 = offsetMinutos(new Date(alvo), fuso)
  let instante = new Date(alvo - offset1 * 60000)

  const offset2 = offsetMinutos(instante, fuso)
  if (offset2 !== offset1) {
    instante = new Date(alvo - offset2 * 60000)
  }
  return instante
}

/** 'YYYY-MM-DD' do dia local — a chave de coluna da agenda. */
export function diaLocalIso(instante: Date, fuso: string = FUSO_PADRAO): string {
  const l = partesLocais(instante, fuso)
  return `${String(l.ano).padStart(4, '0')}-${String(l.mes).padStart(2, '0')}-${String(l.dia).padStart(2, '0')}`
}

/** 'HH:MM' local. */
export function horaLocal(instante: Date, fuso: string = FUSO_PADRAO): string {
  const l = partesLocais(instante, fuso)
  return `${String(l.hora).padStart(2, '0')}:${String(l.minuto).padStart(2, '0')}`
}

/** Minutos desde a meia-noite local. É a coordenada Y da grade. */
export function minutosDoDia(instante: Date, fuso: string = FUSO_PADRAO): number {
  const l = partesLocais(instante, fuso)
  return l.hora * 60 + l.minuto
}

/** Início do dia local ('YYYY-MM-DD' às 00:00) como instante. */
export function inicioDoDia(diaIso: string, fuso: string = FUSO_PADRAO): Date {
  const { ano, mes, dia } = decompor(diaIso)
  return paraInstante({ ano, mes, dia, hora: 0, minuto: 0 }, fuso)
}

/** Instante de uma data e hora locais dadas como texto. */
export function instanteDe(
  diaIso: string,
  horaHhmm: string,
  fuso: string = FUSO_PADRAO,
): Date {
  const { ano, mes, dia } = decompor(diaIso)
  const { hora, minuto } = decomporHora(horaHhmm)
  return paraInstante({ ano, mes, dia, hora, minuto }, fuso)
}

function decompor(diaIso: string): { ano: number; mes: number; dia: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(diaIso.trim())
  if (!m) erro('DATA_INVALIDA', `Data inválida: "${diaIso}". Esperado "YYYY-MM-DD".`, { diaIso })
  return { ano: Number(m[1]), mes: Number(m[2]), dia: Number(m[3]) }
}

function decomporHora(hhmm: string): { hora: number; minuto: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) erro('HORA_INVALIDA', `Hora inválida: "${hhmm}". Esperado "HH:MM".`, { hhmm })
  const hora = Number(m[1])
  const minuto = Number(m[2])
  if (hora > 23 || minuto > 59) {
    erro('HORA_INVALIDA', `Hora fora da faixa: "${hhmm}".`, { hhmm })
  }
  return { hora, minuto }
}

/** 'HH:MM' → minutos desde a meia-noite. */
export function hhmmParaMinutos(hhmm: string): number {
  const { hora, minuto } = decomporHora(hhmm)
  return hora * 60 + minuto
}

/** 480 → '08:00'. */
export function minutosParaHhmm(minutos: number): string {
  if (!Number.isFinite(minutos) || minutos < 0) {
    erro('MINUTOS_INVALIDOS', `Minutos inválidos: ${minutos}.`, { minutos })
  }
  const total = Math.round(minutos)
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
