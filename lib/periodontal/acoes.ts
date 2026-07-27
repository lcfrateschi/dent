'use server'

import { registrar } from '@/lib/auditoria/registrar'
import { exigirPermissao } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { cicloEsterilizacao, ordemLaboratorio, periogramaDente, periogramaSitio, planoTratamento } from '@/lib/db/schema'
import { mensagemDoBanco } from '@/lib/db/mensagemDoBanco'
import { ehMultirradicular, exigirSitioValido, type SitioPeriograma } from '@/lib/domain/periograma'
import { ErroDominio } from '@/lib/domain/erros'
import { and, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import {
  abrirPeriogramaComAtor,
  concluirPeriogramaComAtor,
} from './periograma'

/**
 * Ações das telas da Fase 21. **Camada fina: autoriza, valida a borda, delega.**
 *
 * Regra do projeto: server action não decide regra de negócio. O que é regra está em
 * `lib/domain/periograma.ts` (sítio válido por arcada, furca só em multirradicular,
 * NIC derivado) e nas travas do banco. Aqui só entra o que é da borda: converter
 * string de formulário em número, e transformar erro em mensagem.
 */

export type Resultado =
  | { readonly ok: true; readonly mensagem: string }
  | { readonly ok: false; readonly mensagem: string }

/**
 * Traduz exceção em mensagem **para a tela** — e o "para a tela" é o ponto.
 *
 * ── Por que a cadeia crua NÃO vai para a interface ──────────────────────────
 * `mensagemDoBanco` junta a cadeia de `cause` inteira, e a primeira parte é o
 * `"Failed query: insert into … params: …"` que o Drizzle monta — **com os
 * parâmetros**. Num periograma os parâmetros são medidas clínicas; numa ordem de
 * laboratório, o nome do paciente. Repassar isso à tela seria despejar SQL e dado de
 * paciente numa mensagem de erro que qualquer pessoa na recepção lê, e que vai para
 * o log do navegador.
 *
 * Então o padrão é o de `lib/estoque/movimentar.ts`: **reconhecer o que as nossas
 * travas escrevem** (essas mensagens são em português e citam o dente ou o número da
 * carga, e repassá-las é melhor que reescrevê-las) e cair num genérico para todo o
 * resto. `ErroDominio` passa direto: o texto dele já foi escrito para humano.
 *
 * A cadeia completa continua indo para o log do servidor, que é onde ela serve.
 */
function paraMensagem(e: unknown, padrao: string): string {
  if (e instanceof ErroDominio) return e.message

  const bruto = mensagemDoBanco(e)
  console.error('[periodontal]', bruto)

  // Mensagens escritas pelas travas da 0037 e vizinhas. Cada marcador é uma frase
  // que já diz qual dente, qual carga ou qual ordem — informação que a pessoa
  // precisa ver, e que um genérico apagaria.
  const marcadores = [
    'não tem furca',
    'raiz única',
    'não tem sítio',
    'é decíduo',
    'já está assinada',
    'append-only',
    'grupo de propostas',
  ]
  const achado = marcadores.find((m) => bruto.includes(m))
  if (achado) {
    // Só o trecho a partir da frase reconhecida: o prefixo do Drizzle fica fora.
    const i = bruto.indexOf(achado)
    const inicio = Math.max(0, bruto.lastIndexOf('  ', i) + 1)
    return bruto.slice(inicio).split(' | ')[0]!.trim()
  }

  if (bruto.includes('ciclo_esterilizacao_carga_uk')) {
    return 'Já existe carga com este número hoje nesta autoclave. Confira a etiqueta.'
  }
  if (bruto.includes('nivel_insercao_mm') || bruto.includes('certificado')) {
    return 'Este valor é calculado pelo sistema e não pode ser digitado.'
  }
  if (bruto.includes('plano_um_ativo_por_paciente')) {
    return 'O paciente já tem um plano ativo. Promover outra proposta cancela a atual.'
  }
  if (bruto.includes('situacao_com_evidencia')) {
    return 'Situação exige a data correspondente — enviada precisa de envio, recebida de recebimento.'
  }
  if (bruto.includes('refacao_justificada')) {
    return 'Refação exige motivo.'
  }
  return padrao
}

// ── Periograma ───────────────────────────────────────────────────────────────

export async function abrirPeriograma(
  pacienteId: string,
): Promise<Resultado & { readonly id?: string }> {
  const ator = await exigirPermissao('odontograma', 'criar')
  try {
    const { id } = await abrirPeriogramaComAtor(ator, { pacienteId })
    revalidatePath(`/periograma/${pacienteId}`)
    return { ok: true, mensagem: 'Exame aberto.', id }
  } catch (e) {
    return { ok: false, mensagem: paraMensagem(e, 'Não foi possível abrir o exame.') }
  }
}

export interface MedidaDoDente {
  readonly sitio: SitioPeriograma
  readonly profundidadeMm: number
  readonly recessaoMm: number
  readonly sangramento: boolean
  readonly supuracao: boolean
}

/**
 * Grava **um dente inteiro** — seis sítios, mobilidade e furca.
 *
 * ── Por que o dente é a unidade de gravação ────────────────────────────────
 * Um exame são ~192 medidas. Gravar por sítio seriam 192 idas ao servidor e uma
 * chance de perder o trabalho a cada uma. Gravar só no fim significa que uma queda
 * na medida 150 joga fora vinte minutos de exame ditado em voz alta — e ninguém
 * repete um periograma por causa disso: ele deixa de ser feito.
 *
 * O dente é o meio certo porque é a unidade do **ditado**: o dentista termina "16,
 * três, dois, quatro, três, dois, três" e passa ao 17. Gravar quando ele passa é
 * gravar num momento em que a auxiliar já não está digitando aquele dente.
 *
 * ── Regravar o mesmo dente substitui ───────────────────────────────────────
 * O operador não olha a tela enquanto digita, então erro é a norma e correção
 * precisa ser barata. `ON CONFLICT` substitui os seis sítios e o achado do dente —
 * regravar o 16 não duplica nem exige apagar antes.
 */
export async function gravarDente(entrada: {
  readonly periogramaId: string
  readonly denteFdi: number
  readonly mobilidade: number | null
  readonly furca: number | null
  readonly medidas: readonly MedidaDoDente[]
}): Promise<Resultado> {
  const ator = await exigirPermissao('odontograma', 'editar')

  try {
    // Validação de domínio ANTES do banco: a mensagem é melhor ("o dente 21 tem raiz
    // única e não tem furca") do que "violates check constraint". A trava do banco
    // continua sendo a garantia; isto é a cortesia.
    if (entrada.furca !== null && !ehMultirradicular(entrada.denteFdi)) {
      return {
        ok: false,
        mensagem: `O dente ${entrada.denteFdi} tem raiz única e não tem furca.`,
      }
    }
    for (const m of entrada.medidas) exigirSitioValido(entrada.denteFdi, m.sitio)

    await db.transaction(async (tx) => {
      await tx
        .insert(periogramaDente)
        .values({
          periogramaId: entrada.periogramaId,
          denteFdi: entrada.denteFdi,
          mobilidade: entrada.mobilidade,
          furca: entrada.furca,
        })
        /**
         * `clinicaId` entra no alvo porque o índice é `(clinica_id, periograma_id,
         * dente_fdi)`. `ON CONFLICT` exige alvo que case **exatamente** com um índice
         * único; sem a primeira coluna o Postgres recusa com 42P10 ("no unique or
         * exclusion constraint matching the ON CONFLICT specification"), erro que não
         * menciona qual coluna falta.
         *
         * Vale notar que `periograma_sitio_uk` é `(periograma_id, dente_fdi, sitio)`,
         * SEM `clinica_id` — os dois índices irmãos não seguem a mesma forma. Nenhum
         * está errado (o `periograma_id` já é único no mundo e carrega o tenant pelo FK
         * composto), mas a assimetria é uma armadilha para a próxima pessoa que
         * escrever um `ON CONFLICT` aqui. Reportado.
         */
        .onConflictDoUpdate({
          target: [periogramaDente.clinicaId, periogramaDente.periogramaId, periogramaDente.denteFdi],
          set: { mobilidade: entrada.mobilidade, furca: entrada.furca },
        })

      if (entrada.medidas.length > 0) {
        await tx
          .insert(periogramaSitio)
          .values(
            entrada.medidas.map((m) => ({
              periogramaId: entrada.periogramaId,
              denteFdi: entrada.denteFdi,
              sitio: m.sitio,
              profundidadeSondagemMm: m.profundidadeMm,
              recessaoMm: m.recessaoMm,
              sangramento: m.sangramento,
              supuracao: m.supuracao,
            })),
          )
          .onConflictDoUpdate({
            target: [periogramaSitio.periogramaId, periogramaSitio.denteFdi, periogramaSitio.sitio],
            set: {
              profundidadeSondagemMm: sql`excluded.profundidade_sondagem_mm`,
              recessaoMm: sql`excluded.recessao_mm`,
              sangramento: sql`excluded.sangramento`,
              supuracao: sql`excluded.supuracao`,
              // `nivel_insercao_mm` NÃO entra: é coluna GENERATED e o Postgres recusa
              // a escrita. O valor certo sai do novo PS e da nova recessão sozinho.
            },
          })
      }
    })

    return { ok: true, mensagem: `Dente ${entrada.denteFdi} gravado.` }
  } catch (e) {
    return { ok: false, mensagem: paraMensagem(e, 'Não foi possível gravar o dente.') }
  }
}

export async function concluirPeriograma(periogramaId: string): Promise<Resultado> {
  const ator = await exigirPermissao('odontograma', 'editar')
  try {
    await concluirPeriogramaComAtor(ator, periogramaId)
    return { ok: true, mensagem: 'Exame concluído.' }
  } catch (e) {
    return { ok: false, mensagem: paraMensagem(e, 'Não foi possível concluir o exame.') }
  }
}

// ── Ordem de laboratório ─────────────────────────────────────────────────────

export async function criarOrdem(entrada: {
  readonly laboratorioId: string
  readonly itemPlanoId: string
  readonly especificacao: string
  readonly cor?: string
  readonly prazoEm?: string
  readonly custo?: string
  readonly refazId?: string
  readonly motivoRefacao?: string
}): Promise<Resultado> {
  const ator = await exigirPermissao('plano_tratamento', 'criar')

  const especificacao = entrada.especificacao.trim()
  if (especificacao.length < 3) {
    return { ok: false, mensagem: 'Descreva o que o laboratório deve fazer.' }
  }
  if (entrada.refazId && !entrada.motivoRefacao?.trim()) {
    return { ok: false, mensagem: 'Refação exige motivo — é o que responde quem paga.' }
  }

  try {
    const [linha] = await db
      .insert(ordemLaboratorio)
      .values({
        laboratorioId: entrada.laboratorioId,
        itemPlanoId: entrada.itemPlanoId,
        especificacao,
        cor: entrada.cor?.trim() || null,
        prazoEm: entrada.prazoEm || null,
        custo: entrada.custo?.trim() || '0',
        refazId: entrada.refazId || null,
        motivoRefacao: entrada.motivoRefacao?.trim() || null,
      })
      .returning({ id: ordemLaboratorio.id, numero: ordemLaboratorio.numero })

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'ordem_laboratorio',
      entidadeId: linha!.id,
    })
    revalidatePath('/laboratorio')
    return { ok: true, mensagem: `Ordem ${linha!.numero} criada.` }
  } catch (e) {
    return { ok: false, mensagem: paraMensagem(e, 'Não foi possível criar a ordem.') }
  }
}

/**
 * Muda a situação da ordem, gravando **a evidência junto**.
 *
 * O CHECK `ordem_laboratorio_situacao_com_evidencia` recusa "enviada" sem
 * `enviada_em` e "recebida" sem as duas datas. Então a ação não oferece "marcar como
 * recebida" sem registrar quando: estado sem fato é o que o banco impede, e a tela
 * não deve tentar contornar.
 */
export async function mudarSituacaoDaOrdem(
  id: string,
  situacao: 'enviada' | 'recebida' | 'cancelada',
): Promise<Resultado> {
  const ator = await exigirPermissao('plano_tratamento', 'editar')

  try {
    const agora = new Date()
    const campos =
      situacao === 'enviada'
        ? { situacao, enviadaEm: agora, atualizadoEm: agora }
        : situacao === 'recebida'
          ? { situacao, recebidaEm: agora, atualizadoEm: agora }
          : { situacao, atualizadoEm: agora }

    // `enviada_em` no recebimento: se a ordem foi recebida sem ter sido marcada como
    // enviada (acontece — a peça volta antes de alguém clicar), o CHECK exige as duas
    // datas. `coalesce` preenche a que falta com a que existe, e não com `now()` duas
    // vezes, porque recebida antes de enviada é recusado.
    const extra =
      situacao === 'recebida'
        ? { enviadaEm: sql`coalesce(${ordemLaboratorio.enviadaEm}, ${agora})` }
        : {}

    await db
      .update(ordemLaboratorio)
      .set({ ...campos, ...extra })
      .where(eq(ordemLaboratorio.id, id))

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'ordem_laboratorio',
      entidadeId: id,
      detalhes: { situacao },
    })
    revalidatePath('/laboratorio')
    return { ok: true, mensagem: `Ordem marcada como ${situacao}.` }
  } catch (e) {
    return { ok: false, mensagem: paraMensagem(e, 'Não foi possível mudar a situação.') }
  }
}

// ── Esterilização ────────────────────────────────────────────────────────────

export async function registrarCiclo(entrada: {
  readonly autoclaveId: string
  readonly numero: number
  readonly conteudo: string
  readonly indicadorQuimico: 'aprovado' | 'reprovado'
  readonly programa?: string
  readonly temperaturaC?: number
  readonly duracaoMin?: number
}): Promise<Resultado> {
  const ator = await exigirPermissao('estoque', 'criar')

  if (entrada.conteudo.trim().length === 0) {
    return { ok: false, mensagem: 'Descreva o que foi esterilizado.' }
  }
  if (!Number.isInteger(entrada.numero) || entrada.numero < 1) {
    return { ok: false, mensagem: 'O número da carga é o que está na etiqueta, e começa em 1.' }
  }

  try {
    const [linha] = await db
      .insert(cicloEsterilizacao)
      .values({
        autoclaveId: entrada.autoclaveId,
        responsavelId: ator.usuarioId,
        numero: entrada.numero,
        iniciadoEm: new Date(),
        conteudo: entrada.conteudo.trim(),
        indicadorQuimico: entrada.indicadorQuimico,
        programa: entrada.programa?.trim() || null,
        temperaturaC: entrada.temperaturaC ?? null,
        duracaoMin: entrada.duracaoMin ?? null,
      })
      .returning({ id: cicloEsterilizacao.id })

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'ciclo_esterilizacao',
      entidadeId: linha!.id,
    })
    revalidatePath('/esterilizacao')
    return {
      ok: true,
      mensagem: 'Carga registrada. O biológico fica pendente até a leitura.',
    }
  } catch (e) {
    return { ok: false, mensagem: paraMensagem(e, 'Não foi possível registrar a carga.') }
  }
}

/**
 * Lança o resultado do indicador biológico, que sai dias depois.
 *
 * `certificado` **não é campo** — é coluna gerada (`químico aprovado AND biológico
 * negativo`). A tela não decide se o ciclo está certificado; ela registra o que o
 * indicador disse e o banco conclui. É o mesmo princípio do NIC e da glosa.
 */
export async function lancarBiologico(
  id: string,
  resultado: 'negativo' | 'positivo',
): Promise<Resultado> {
  const ator = await exigirPermissao('estoque', 'editar')

  try {
    const atualizadas = await db
      .update(cicloEsterilizacao)
      .set({ biologicoResultado: resultado, biologicoLidoEm: new Date() })
      // Só o que está pendente: relançar resultado já lido apagaria a leitura
      // anterior sem deixar rastro, e um biológico positivo é justamente o que
      // ninguém pode "corrigir" em silêncio.
      .where(
        and(eq(cicloEsterilizacao.id, id), eq(cicloEsterilizacao.biologicoResultado, 'pendente')),
      )
      .returning({ id: cicloEsterilizacao.id })

    if (atualizadas.length === 0) {
      return {
        ok: false,
        mensagem: 'Este ciclo já tem resultado lançado. Resultado lido não se reescreve.',
      }
    }

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'ciclo_esterilizacao',
      entidadeId: id,
      detalhes: { biologico: resultado },
    })
    revalidatePath('/esterilizacao')
    return {
      ok: true,
      mensagem:
        resultado === 'positivo'
          ? 'Positivo registrado. A carga NÃO está certificada — recolha o material.'
          : 'Negativo registrado. Carga certificada.',
    }
  } catch (e) {
    return { ok: false, mensagem: paraMensagem(e, 'Não foi possível lançar o resultado.') }
  }
}

// ── Propostas alternativas ───────────────────────────────────────────────────

/**
 * Promove uma proposta a plano ativo.
 *
 * A trava `plano_um_ativo_por_paciente` **não foi tocada** na Fase 21: continua
 * havendo no máximo um plano ativo por paciente. Então promover é uma operação de
 * duas pernas na MESMA transação — as irmãs do grupo saem de `rascunho` para
 * `cancelado`, e a escolhida entra em `ativo`. Fora de transação, o índice recusaria
 * a segunda perna e o paciente ficaria sem plano nenhum.
 *
 * Qual proposta o paciente escolheu **não é duplicado aqui**: isso está no orçamento,
 * que é o documento congelado. Ver a decisão no `CLAUDE.md`.
 */
export async function promoverProposta(planoId: string): Promise<Resultado> {
  const ator = await exigirPermissao('plano_tratamento', 'editar')

  try {
    const [alvo] = await db
      .select({
        id: planoTratamento.id,
        pacienteId: planoTratamento.pacienteId,
        grupoProposta: planoTratamento.grupoProposta,
        status: planoTratamento.status,
      })
      .from(planoTratamento)
      .where(eq(planoTratamento.id, planoId))

    if (!alvo) return { ok: false, mensagem: 'Proposta não encontrada.' }
    if (alvo.status === 'ativo') return { ok: true, mensagem: 'Esta proposta já é o plano ativo.' }
    if (alvo.status !== 'rascunho') {
      return { ok: false, mensagem: `Proposta ${alvo.status} não volta a ser plano ativo.` }
    }

    await db.transaction(async (tx) => {
      if (alvo.grupoProposta) {
        await tx
          .update(planoTratamento)
          .set({ status: 'cancelado' })
          .where(
            and(
              eq(planoTratamento.grupoProposta, alvo.grupoProposta),
              eq(planoTratamento.status, 'rascunho'),
              sql`${planoTratamento.id} <> ${planoId}`,
            ),
          )
      }
      await tx
        .update(planoTratamento)
        .set({ status: 'ativo' })
        .where(eq(planoTratamento.id, planoId))
    })

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'plano_tratamento',
      entidadeId: planoId,
      pacienteId: alvo.pacienteId,
      detalhes: { promovida: true, grupo: alvo.grupoProposta },
    })
    revalidatePath(`/pacientes/${alvo.pacienteId}`)
    return { ok: true, mensagem: 'Proposta promovida a plano ativo.' }
  } catch (e) {
    return { ok: false, mensagem: paraMensagem(e, 'Não foi possível promover a proposta.') }
  }
}
