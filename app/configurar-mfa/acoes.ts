'use server'

import { registrar } from '@/lib/auditoria/registrar'
import { gerarSegredoTotp, uriOtpauth, verificarCodigoTotp } from '@/lib/auth/totp'
import { exigirAtor } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { clinica, usuario } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import QRCode from 'qrcode'

/**
 * Configuração do segundo fator.
 *
 * O segredo é gravado **antes** da confirmação, mas `mfa_ativo` só vira `true`
 * depois de o usuário provar que o app está gerando o código certo. Sem isso,
 * alguém escaneia o QR, erra a configuração e fica trancado fora do sistema.
 */

export interface DadosConfiguracaoMfa {
  readonly segredo: string
  readonly uri: string
  readonly qrSvg: string
}

export async function prepararMfa(): Promise<DadosConfiguracaoMfa> {
  const ator = await exigirAtor()

  const [linha] = await db
    .select({ mfaSecret: usuario.mfaSecret, mfaAtivo: usuario.mfaAtivo })
    .from(usuario)
    .where(eq(usuario.id, ator.usuarioId))
    .limit(1)

  if (linha?.mfaAtivo) {
    throw new Error('A verificação em duas etapas já está ativa.')
  }

  // Reaproveita o segredo pendente: recarregar a página não pode invalidar o
  // QR que a pessoa acabou de escanear.
  const segredo = linha?.mfaSecret ?? gerarSegredoTotp()
  if (!linha?.mfaSecret) {
    await db.update(usuario).set({ mfaSecret: segredo }).where(eq(usuario.id, ator.usuarioId))
  }

  const [cfg] = await db.select({ nome: clinica.nomeFantasia, razao: clinica.razaoSocial }).from(clinica).limit(1)

  const uri = uriOtpauth({
    segredoBase32: segredo,
    email: ator.email,
    emissor: cfg?.nome ?? cfg?.razao ?? 'Facilident',
  })

  // QR gerado no servidor: o segredo não passa por biblioteca de terceiros no
  // navegador nem fica em histórico de rede como imagem externa.
  const qrSvg = await QRCode.toString(uri, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  })

  return { segredo, uri, qrSvg }
}

export type ResultadoAtivacao = { ok: true } | { ok: false; erro: string }

export async function ativarMfa(codigo: string): Promise<ResultadoAtivacao> {
  const ator = await exigirAtor()

  const [linha] = await db
    .select({ mfaSecret: usuario.mfaSecret, mfaAtivo: usuario.mfaAtivo })
    .from(usuario)
    .where(eq(usuario.id, ator.usuarioId))
    .limit(1)

  if (!linha?.mfaSecret) {
    return { ok: false, erro: 'Gere o código novamente: a configuração expirou.' }
  }
  if (linha.mfaAtivo) return { ok: true }

  if (!verificarCodigoTotp(linha.mfaSecret, codigo)) {
    await registrar({
      ator,
      acao: 'login_falho',
      entidade: 'usuario',
      entidadeId: ator.usuarioId,
      detalhes: { motivo: 'codigo_mfa_invalido_na_ativacao' },
    })
    return { ok: false, erro: 'Código incorreto. Confira o app e tente de novo.' }
  }

  await db.update(usuario).set({ mfaAtivo: true }).where(eq(usuario.id, ator.usuarioId))

  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'usuario',
    entidadeId: ator.usuarioId,
    detalhes: { campo: 'mfa_ativo', valor: true },
  })

  return { ok: true }
}
