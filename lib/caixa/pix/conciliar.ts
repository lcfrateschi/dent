import { db } from '@/lib/db'
import { eventoPix, intencaoPix, pagamento, parcela } from '@/lib/db/schema'
import { compara } from '@/lib/domain/dinheiro'
import { mensagemDoBanco } from '@/lib/db/mensagemDoBanco'
import { and, eq, sql } from 'drizzle-orm'
import type { LiquidacaoPix } from './tipos'

/**
 * Transformar liquidação Pix em pagamento conciliado.
 *
 * ── A garantia central: reentrega NÃO move dinheiro duas vezes ──────────────
 * PSP reentrega, e está certo em fazê-lo: se não recebeu 200, tenta de novo — depois de
 * um timeout nosso, de um deploy no meio, de um 500. A segunda notificação carrega o
 * **mesmo `endToEndId`**, porque é a mesma liquidação.
 *
 * O `INSERT` em `evento_pix` vem **primeiro**, e `(clinica_id, end_to_end_id)` é único.
 * A reentrega colide no índice e o processamento nem começa.
 *
 * A alternativa — "verifica se já processei; se não, processo" — tem janela entre ler e
 * escrever: duas entregas simultâneas passam as duas pela verificação e conciliam duas
 * vezes. O resultado é dinheiro em dobro no caixa com o extrato mostrando uma entrada
 * só, e ninguém encontra isso olhando o código: os dois `if` parecem certos.
 *
 * ── Conciliação NUNCA adivinha ──────────────────────────────────────────────
 * O casamento é por `txid`, que nós geramos e gravamos na emissão. Nunca por "valor e
 * data parecidos" — aproximação é o que fecha o mês com o dinheiro do paciente errado, e
 * o erro aparece semanas depois como uma parcela quitada que ninguém pagou.
 *
 * Liquidação sem cobrança correspondente **não é descartada**: fica com
 * `processado_em` nulo e motivo escrito. Pix que caiu na conta e não casa com nada é
 * dinheiro sem dono, e apagar o registro é a única coisa pior que não conciliar.
 */

export type ResultadoConciliacao =
  | { readonly situacao: 'conciliado'; readonly pagamentoId: string; readonly txid: string }
  | { readonly situacao: 'repetido'; readonly txid: string }
  | { readonly situacao: 'sem_cobranca'; readonly txid: string; readonly motivo: string }
  | { readonly situacao: 'divergente'; readonly txid: string; readonly motivo: string }

/**
 * Processa uma liquidação. Idempotente por construção.
 *
 * Roda com o contexto de clínica já definido por quem chama — o webhook resolve o
 * tenant antes, e o despachante troca de contexto a cada iteração.
 */
export async function conciliarLiquidacao(
  l: LiquidacaoPix,
  payload: unknown,
): Promise<ResultadoConciliacao> {
  try {
    return await db.transaction(async (tx) => {
      /**
       * Passo 1: registrar o evento. É a trava.
       *
       * `onConflictDoNothing` + `returning` vazio = já vimos este `endToEndId`. Note que
       * o teste da idempotência é o **resultado do INSERT**, não uma consulta anterior:
       * não existe janela.
       */
      const registrado = await tx
        .insert(eventoPix)
        .values({
          endToEndId: l.endToEndId,
          txid: l.txid,
          valor: l.valor,
          liquidadoEm: l.liquidadoEm,
          payload: payload as Record<string, unknown>,
          motivoNaoProcessado: 'em processamento',
        })
        .onConflictDoNothing({ target: [eventoPix.clinicaId, eventoPix.endToEndId] })
        .returning({ id: eventoPix.id })

      if (registrado.length === 0) {
        return { situacao: 'repetido' as const, txid: l.txid }
      }
      const eventoId = registrado[0]!.id

      // Passo 2: achar a cobrança pelo txid. Travada, porque duas liquidações do mesmo
      // txid (parcial + complemento, que o padrão permite) chegariam juntas.
      const [cobranca] = await tx
        .select({
          id: intencaoPix.id,
          parcelaId: intencaoPix.parcelaId,
          valor: intencaoPix.valor,
          situacao: intencaoPix.situacao,
        })
        .from(intencaoPix)
        .where(and(eq(intencaoPix.clinicaId, sql`app_clinica_id()`), eq(intencaoPix.txid, l.txid)))
        .for('update')

      if (!cobranca) {
        const motivo = 'Liquidação sem cobrança correspondente nesta clínica — dinheiro sem dono.'
        await tx
          .update(eventoPix)
          .set({ motivoNaoProcessado: motivo })
          .where(eq(eventoPix.id, eventoId))
        return { situacao: 'sem_cobranca' as const, txid: l.txid, motivo }
      }

      if (cobranca.situacao === 'pago') {
        /**
         * Cobrança já paga com `endToEndId` NOVO: são duas liquidações distintas para o
         * mesmo QR. Acontece (paciente paga duas vezes por engano) e **não** pode virar
         * dois pagamentos silenciosos na mesma parcela.
         */
        const motivo = 'Cobrança já liquidada — segunda liquidação do mesmo QR exige decisão humana (devolução?).'
        await tx
          .update(eventoPix)
          .set({ motivoNaoProcessado: motivo })
          .where(eq(eventoPix.id, eventoId))
        return { situacao: 'divergente' as const, txid: l.txid, motivo }
      }

      if (compara(l.valor, cobranca.valor) !== 0) {
        // Pix permite valor diferente do cobrado quando a cobrança é aberta. A nossa
        // não é — então divergência é caso de conferência, não de aceitar calado.
        const motivo = `Valor liquidado (${l.valor}) difere do cobrado (${cobranca.valor}).`
        await tx
          .update(eventoPix)
          .set({ motivoNaoProcessado: motivo })
          .where(eq(eventoPix.id, eventoId))
        return { situacao: 'divergente' as const, txid: l.txid, motivo }
      }

      /**
       * Passo 3: o pagamento nasce **já conciliado**.
       *
       * Do lado manual, `conciliado` vira `true` quando alguém confere o extrato. Aqui a
       * conferência é a própria notificação assinada do PSP, com `endToEndId` — é mais
       * forte que o olho humano, e marcar como pendente obrigaria a recepção a
       * "conferir" o que o banco já confirmou.
       */
      const [novo] = await tx
        .insert(pagamento)
        .values({
          parcelaId: cobranca.parcelaId,
          valor: l.valor,
          pagoEm: l.liquidadoEm.toISOString().slice(0, 10),
          meio: 'pix',
          conciliado: true,
          conciliadoEm: l.liquidadoEm,
          comprovante: l.endToEndId,
          observacao: `Pix conciliado automaticamente (txid ${l.txid}).`,
        })
        .returning({ id: pagamento.id })

      await tx
        .update(intencaoPix)
        .set({
          situacao: 'pago',
          endToEndId: l.endToEndId,
          pagamentoId: novo!.id,
          liquidadoEm: l.liquidadoEm,
        })
        .where(eq(intencaoPix.id, cobranca.id))

      await tx
        .update(eventoPix)
        .set({ processadoEm: sql`now()`, motivoNaoProcessado: null })
        .where(eq(eventoPix.id, eventoId))

      return { situacao: 'conciliado' as const, pagamentoId: novo!.id, txid: l.txid }
    })
  } catch (e) {
    // A mensagem útil do Postgres vive em `e.cause`; `e.message` do Drizzle é só
    // "Failed query: …". Sem isto, a causa de uma trigger recusando fica invisível.
    throw new Error(`Falha ao conciliar Pix ${l.txid}: ${mensagemDoBanco(e)}`)
  }
}

/**
 * Emite a cobrança Pix de uma parcela e grava a intenção.
 *
 * A ordem importa: primeiro o PSP (que pode falhar), depois o banco. Gravar antes
 * deixaria intenção pendente para uma cobrança que não existe do outro lado — e o QR
 * que o paciente receberia não seria pagável.
 */
export async function emitirCobrancaPix(
  parcelaId: string,
  provedor: { criarCobranca: (p: { valor: string; descricao: string; expiraEmSegundos: number }) => Promise<{ txid: string; copiaECola: string; expiraEm: Date }> },
  expiraEmSegundos = 3600,
): Promise<{ readonly ok: true; readonly txid: string; readonly copiaECola: string } | { readonly ok: false; readonly mensagem: string }> {
  const [p] = await db
    .select({ id: parcela.id, valor: parcela.valor, status: parcela.status })
    .from(parcela)
    .where(and(eq(parcela.clinicaId, sql`app_clinica_id()`), eq(parcela.id, parcelaId)))
  if (!p) return { ok: false, mensagem: 'Parcela não encontrada nesta clínica.' }
  if (p.status === 'paga' || p.status === 'cancelada') {
    return { ok: false, mensagem: `Parcela ${p.status} não recebe cobrança nova.` }
  }

  const cobranca = await provedor.criarCobranca({
    valor: p.valor,
    // **Sem dado clínico.** A tela do celular do paciente é lida por outras pessoas —
    // decisão fechada do projeto, e vale aqui como vale no WhatsApp.
    descricao: 'Pagamento de tratamento odontológico',
    expiraEmSegundos,
  })

  await db.insert(intencaoPix).values({
    parcelaId: p.id,
    txid: cobranca.txid,
    valor: p.valor,
    copiaECola: cobranca.copiaECola,
    expiraEm: cobranca.expiraEm,
  })

  return { ok: true, txid: cobranca.txid, copiaECola: cobranca.copiaECola }
}
