'use server'

import { SemPermissao, SemSessao, exigirPermissao } from '@/lib/authz/sessao'
import { registrarExportacao } from '@/lib/prontuario/consultas'

/**
 * Registra o pedido de exportação na trilha, antes de o documento abrir.
 *
 * Server action separada de propósito: é a única coisa que este passo faz, e
 * ela precisa acontecer com certeza. Se a impressão abrisse primeiro, fechar a
 * aba deixaria uma exportação de prontuário sem rastro nenhum.
 */
export async function registrarPedidoDeExportacao(
  pacienteId: string,
  motivo: string,
): Promise<{ ok: boolean; mensagem?: string }> {
  try {
    const ator = await exigirPermissao('prontuario', 'exportar')

    if (motivo.trim().length < 3) {
      return { ok: false, mensagem: 'Informe o motivo da exportação.' }
    }

    await registrarExportacao(ator, pacienteId, motivo)
    return { ok: true }
  } catch (e) {
    if (e instanceof SemSessao) {
      return { ok: false, mensagem: 'Sua sessão expirou. Entre novamente.' }
    }
    if (e instanceof SemPermissao) {
      return { ok: false, mensagem: 'Seu perfil não pode exportar prontuário.' }
    }
    throw e
  }
}
