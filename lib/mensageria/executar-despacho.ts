import { addDias } from '@/lib/domain/datas'
import { REGRA_PADRAO } from '@/lib/domain/lembrete'
import { diaLocalIso, inicioDoDia } from '@/lib/domain/fuso'
import { despacharPendentes } from './despachar'
import { enfileirarLembretesDoPeriodo } from './fila'
import { mensagensTravadas } from './fila'
import { pool } from '@/lib/db'

/**
 * Uma passada do processo de mensageria: enfileira o que precisa, despacha o que
 * está vencido, denuncia o que travou.
 *
 * `npm run whatsapp:despachar` — feito para rodar em cron (a cada 10 minutos é
 * suficiente; a decisão de horário já está gravada em `agendado_para`, então
 * rodar mais vezes não adianta e rodar menos só atrasa).
 *
 * **Roda quantas vezes quiser.** Enfileirar é idempotente pela chave, despachar
 * reivindica com `SKIP LOCKED`. Duas execuções simultâneas não duplicam nada —
 * essa é a única propriedade que torna um cron seguro aqui.
 */

const DIAS_A_FRENTE = 3

async function main(): Promise<void> {
  const agora = new Date()
  const fuso = REGRA_PADRAO.fuso
  const hoje = diaLocalIso(agora, fuso)

  const de = inicioDoDia(hoje, fuso)
  const ate = inicioDoDia(addDias(hoje, DIAS_A_FRENTE), fuso)

  console.log(`[whatsapp] passada em ${agora.toISOString()}`)

  const fila = await enfileirarLembretesDoPeriodo(de, ate, agora)
  console.log(`[whatsapp] enfileiradas: ${fila.enfileiradas}`)
  if (fila.recusadas.length > 0) {
    // Recusa não é erro, mas tem de ser visível: "paciente sem celular" é
    // trabalho para a recepção, não silêncio.
    const contagem = new Map<string, number>()
    for (const r of fila.recusadas) contagem.set(r, (contagem.get(r) ?? 0) + 1)
    for (const [motivo, n] of contagem) console.log(`[whatsapp]   ${n}× ${motivo}`)
  }

  const resumo = await despacharPendentes(agora)
  console.log(
    `[whatsapp] provedor=${resumo.provedor} reivindicadas=${resumo.reivindicadas} enviadas=${resumo.enviadas} falhadas=${resumo.falhadas}`,
  )

  const travadas = await mensagensTravadas(agora)
  if (travadas.length > 0) {
    console.warn(
      `[whatsapp] ATENÇÃO: ${travadas.length} mensagem(ns) travada(s) em "enviando" — não são reenviadas automaticamente de propósito. Ver /whatsapp.`,
    )
  }
}

main()
  .then(async () => {
    await pool.end()
    process.exit(0)
  })
  .catch(async (e) => {
    console.error('[whatsapp] falha na passada:', e)
    await pool.end()
    process.exit(1)
  })
