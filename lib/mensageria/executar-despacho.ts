import { addDias } from '@/lib/domain/datas'
import { REGRA_PADRAO } from '@/lib/domain/lembrete'
import { diaLocalIso, inicioDoDia } from '@/lib/domain/fuso'
import { gerarTodasAsTarefas } from '@/lib/relacionamento/geradores'
import { despacharPendentes } from './despachar'
import { enfileirarLembretesDoPeriodo } from './fila'
import { mensagensTravadas } from './fila'
import { pool } from '@/lib/db'
import { comContextoDeClinica } from '@/lib/tenant/contexto'
import { clinicasParaProcessamento } from '@/lib/tenant/operador'

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

/**
 * Uma passada para UMA clínica.
 *
 * ── Por que o contexto é definido a cada iteração ──────────────────────────
 * A tentação é envolver o laço inteiro num `comContextoDeClinica` e pronto. Isso
 * daria a TODAS as clínicas o contexto da primeira: a mensagem da clínica B sairia
 * com o nome da clínica A (`nomeDaClinica` em `fila.ts` lê a clínica do contexto), e
 * o paciente receberia um lembrete assinado por um consultório onde nunca foi.
 * O contexto é por unidade de trabalho, e a unidade aqui é a clínica.
 */
async function passadaDaClinica(agora: Date): Promise<void> {
  const fuso = REGRA_PADRAO.fuso
  const hoje = diaLocalIso(agora, fuso)

  const de = inicioDoDia(hoje, fuso)
  const ate = inicioDoDia(addDias(hoje, DIAS_A_FRENTE), fuso)

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

  /**
   * As filas de relacionamento (Fase 18), na mesma passada.
   *
   * ── Por que aqui e não num cron próprio ────────────────────────────────────
   * Porque a propriedade que torna um cron seguro é a mesma nas duas coisas:
   * idempotência. Os geradores são `INSERT … ON CONFLICT DO NOTHING`, como o
   * enfileiramento de lembrete — rodar duas vezes não duplica. Um segundo serviço
   * precisaria da mesma trava de contexto por clínica, do mesmo tratamento de erro
   * por clínica, e de alguém lembrar de instalá-lo. O despachante já é o processo
   * que "passa em todas as clínicas a cada dez minutos"; a fila é exatamente isso.
   *
   * Uma falha aqui **não** impede o despacho de mensagens acima: a geração de fila
   * é trabalho de relacionamento, e não vale deixar um paciente sem lembrete de
   * consulta porque um `SELECT` de orçamento falhou.
   */
  try {
    const geradas = await gerarTodasAsTarefas()
    const total = geradas.reduce((s, g) => s + g.criadas, 0)
    if (total > 0) {
      console.log(`[relacionamento] ${total} tarefa(s) nova(s)`)
      for (const g of geradas) {
        if (g.criadas > 0) console.log(`[relacionamento]   ${g.criadas}× ${g.tipo}`)
      }
    } else {
      console.log('[relacionamento] nenhuma tarefa nova')
    }
  } catch (e) {
    console.error(
      '[relacionamento] geração de filas falhou:',
      e instanceof Error ? e.message : e,
    )
  }

  const travadas = await mensagensTravadas(agora)
  if (travadas.length > 0) {
    console.warn(
      `[whatsapp] ATENÇÃO: ${travadas.length} mensagem(ns) travada(s) em "enviando" — não são reenviadas automaticamente de propósito. Ver /whatsapp.`,
    )
  }
}

async function main(): Promise<void> {
  const agora = new Date()
  console.log(`[whatsapp] passada em ${agora.toISOString()}`)

  const clinicas = await clinicasParaProcessamento()
  if (clinicas.length === 0) {
    console.log('[whatsapp] nenhuma clínica cadastrada — nada a fazer')
    return
  }
  console.log(`[whatsapp] ${clinicas.length} clínica(s)`)

  let comFalha = 0
  for (const clinicaId of clinicas) {
    console.log(`[whatsapp] ── clínica ${clinicaId}`)
    try {
      await comContextoDeClinica(clinicaId, () => passadaDaClinica(agora))
    } catch (e) {
      /**
       * Uma clínica que falha NÃO interrompe as outras.
       *
       * O laço é a mesma passada repetida, não uma transação: um token de WhatsApp
       * vencido na clínica A não é motivo para os pacientes da clínica B não
       * receberem lembrete. O erro é contado e o processo termina com código 1, para
       * o serviço não parecer saudável.
       */
      comFalha++
      console.error(`[whatsapp] clínica ${clinicaId} falhou:`, e instanceof Error ? e.message : e)
    }
  }

  if (comFalha > 0) {
    throw new Error(`${comFalha} de ${clinicas.length} clínica(s) falharam nesta passada.`)
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
