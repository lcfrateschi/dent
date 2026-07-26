import { createHash, randomUUID } from 'node:crypto'
import { armazenamento } from '@/lib/armazenamento'
import { ErroArmazenamento } from '@/lib/armazenamento/tipos'
import { registrar } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { documento } from '@/lib/db/schema'
import {
  BYTES_PARA_DETECTAR,
  type TipoDocumento,
  chaveArmazenamento,
  validarArquivo,
} from '@/lib/domain/arquivo'
import { ehFdiValido } from '@/lib/domain/dentes'
import { ErroDominio } from '@/lib/domain/erros'

/**
 * O anexo em si, separado da server action.
 *
 * A action em `acoes.ts` faz uma coisa só: autorizar. A regra e a ordem das
 * operações ficam aqui — o que segue a disciplina do projeto (server action valida
 * entrada, chama o domínio, persiste) e tem um efeito prático: este caminho é
 * exercitável fora de uma requisição HTTP, então o fluxo de upload pode ser
 * provado contra o Postgres e o disco de verdade.
 *
 * **A ordem das operações é a parte que importa:**
 *
 *   valida → grava no storage → insere no banco → se o banco falhar, apaga o
 *   arquivo recém-gravado
 *
 * Gravar no banco primeiro deixaria registro apontando para arquivo inexistente:
 * a tela mostraria a radiografia e o download quebraria. Na ordem acima, a falha
 * deixa no pior caso um objeto órfão — que custa bytes, não correção. E mesmo ele
 * é removido na compensação.
 *
 * A chave depende de um id gerado ANTES do insert, e é isso que permite essa
 * ordem.
 */

export type ResultadoDocumento =
  | { ok: true; id: string; mensagem: string; aviso?: string }
  | { ok: false; mensagem: string }

export interface EntradaUpload {
  readonly pacienteId: string
  readonly tipo: TipoDocumento
  readonly nome: string
  readonly descricao?: string
  readonly denteFdi?: number
  readonly etapa?: 'inicial' | 'durante' | 'final'
  /** Data clínica do exame. Pode ser bem anterior ao envio. */
  readonly dataExame?: string
  readonly evolucaoId?: string
  readonly profissionalId?: string
}

/** Erro do Postgres sem o embrulho "Failed query: insert into…" do Drizzle. */
export function mensagemDeErro(e: unknown): string {
  if (e instanceof ErroDominio || e instanceof ErroArmazenamento) return e.message
  let atual: unknown = e
  while (atual instanceof Error) {
    const m = atual.message
    if (!m.startsWith('Failed query') && !m.includes('insert into')) return m
    atual = (atual as { cause?: unknown }).cause
  }
  return 'Não foi possível concluir a operação.'
}

export async function anexarComAtor(
  ator: Ator,
  entrada: EntradaUpload,
  conteudo: Uint8Array,
  mimeDeclarado?: string,
): Promise<ResultadoDocumento> {
  const store = armazenamento()
  let chave: string | null = null

  try {
    const validado = validarArquivo(
      {
        nome: entrada.nome,
        tamanhoBytes: conteudo.byteLength,
        mimeDeclarado,
        bytesIniciais: conteudo.slice(0, BYTES_PARA_DETECTAR),
      },
      entrada.tipo,
    )

    if (entrada.denteFdi !== undefined && !ehFdiValido(entrada.denteFdi)) {
      return { ok: false, mensagem: `Dente ${entrada.denteFdi} não existe na notação FDI.` }
    }

    const documentoId = randomUUID()

    const dataExame = entrada.dataExame ? new Date(entrada.dataExame) : null
    if (dataExame && Number.isNaN(dataExame.getTime())) {
      return { ok: false, mensagem: 'Data do exame inválida.' }
    }
    // Um dia de folga cobre fuso; além disso é erro de digitação, não exame
    // agendado — exame do futuro não tem imagem.
    if (dataExame && dataExame.getTime() > Date.now() + 86_400_000) {
      return { ok: false, mensagem: 'A data do exame não pode estar no futuro.' }
    }

    chave = chaveArmazenamento({
      pacienteId: entrada.pacienteId,
      documentoId,
      extensao: validado.formato.extensao,
      // Ano do EXAME quando informado: mantém junto no bucket o que é junto na
      // clínica.
      ano: (dataExame ?? new Date()).getUTCFullYear(),
    })

    const guardado = await store.salvar(chave, conteudo, validado.formato.mime)

    // Confere o gravado contra o pretendido. Se o provedor truncou, o hash não
    // bate e o documento não entra no prontuário.
    const esperado = createHash('sha256').update(conteudo).digest('hex')
    if (guardado.sha256 !== esperado) {
      throw new ErroArmazenamento(
        'FALHA_DE_ESCRITA',
        'O arquivo gravado não corresponde ao enviado — envio descartado.',
      )
    }

    const [criado] = await db
      .insert(documento)
      .values({
        id: documentoId,
        pacienteId: entrada.pacienteId,
        tipo: entrada.tipo,
        nome: entrada.nome.trim().slice(0, 200),
        descricao: entrada.descricao?.trim() || null,
        denteFdi: entrada.denteFdi ?? null,
        etapa: entrada.etapa ?? null,
        evolucaoId: entrada.evolucaoId ?? null,
        storageKey: chave,
        // O mime gravado é o DETECTADO, nunca o declarado pelo cliente: é ele que
        // a rota de download devolve no Content-Type.
        mimeType: validado.formato.mime,
        tamanhoBytes: guardado.tamanhoBytes,
        sha256: guardado.sha256,
        dataExame,
        profissionalId: entrada.profissionalId ?? ator.profissionalId,
        criadoPorId: ator.usuarioId,
      })
      .returning({ id: documento.id })

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'documento',
      entidadeId: criado!.id,
      pacienteId: entrada.pacienteId,
      // Metadado, nunca conteúdo: tipo e tamanho, não o que a imagem mostra.
      detalhes: {
        tipo: entrada.tipo,
        formato: validado.formato.formato,
        tamanhoBytes: guardado.tamanhoBytes,
        denteFdi: entrada.denteFdi ?? null,
        mimeDivergente: validado.mimeDivergente,
      },
    })

    return {
      ok: true,
      id: criado!.id,
      mensagem: 'Documento anexado.',
      aviso: montarAviso(
        validado.mimeDivergente,
        validado.formato.exibivelNoNavegador,
        validado.formato.rotulo,
      ),
    }
  } catch (e) {
    // Compensação: o arquivo já pode estar gravado. Sem isto, cada falha de banco
    // deixa um objeto órfão no bucket para sempre.
    if (chave) {
      try {
        await store.remover(chave)
      } catch (falhaAoLimpar) {
        console.error('[documentos] arquivo órfão em', chave, falhaAoLimpar)
      }
    }
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}

function montarAviso(
  mimeDivergente: boolean,
  exibivel: boolean,
  rotulo: string,
): string | undefined {
  const partes: string[] = []
  if (mimeDivergente) {
    partes.push(
      `O arquivo dizia ser de outro tipo, mas o conteúdo é ${rotulo}. Foi gravado como ${rotulo}.`,
    )
  }
  if (!exibivel) {
    partes.push(`${rotulo} não abre direto no navegador — quem for ver precisa baixar.`)
  }
  return partes.length > 0 ? partes.join(' ') : undefined
}
