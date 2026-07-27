'use server'

import { registrar } from '@/lib/auditoria/registrar'
import { cifrarSegredo, decifrarSegredo } from '@/lib/auth/mfaSegredo'
import { gerarSegredoTotp, uriOtpauth, verificarCodigoTotp } from '@/lib/auth/totp'
import { exigirAtor } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { clinica, usuario } from '@/lib/db/schema'
import { DA_CLINICA_ATUAL } from '@/lib/tenant/sql'
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

  /**
   * Reaproveita o segredo pendente: recarregar a página não pode invalidar o QR que
   * a pessoa acabou de escanear.
   *
   * O segredo é **gravado cifrado** desde aqui. Antes ele nascia em texto claro e só
   * era cifrado no login seguinte — e essa janela não era um caminho quebrado (o login
   * só recifra quando `mfa_ativo` é true, e `prepararMfa` estoura se já for), mas era
   * um segredo TOTP em claro no banco durante o tempo em que a pessoa aponta a câmera
   * para a tela. Não há motivo para essa janela existir.
   *
   * `decifrarSegredo` no reaproveitamento aceita os dois formatos, então um pendente
   * gravado em claro antes desta mudança continua funcionando.
   */
  const segredo = linha?.mfaSecret
    ? decifrarSegredo(linha.mfaSecret, ator.usuarioId).segredo
    : gerarSegredoTotp()
  if (!linha?.mfaSecret) {
    await db
      .update(usuario)
      .set({ mfaSecret: cifrarSegredo(segredo, ator.usuarioId) })
      .where(eq(usuario.id, ator.usuarioId))
  }

  const [cfg] = await db
    .select({ nome: clinica.nomeFantasia, razao: clinica.razaoSocial })
    .from(clinica)
    .where(DA_CLINICA_ATUAL)

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

  // Decifra antes de conferir. Passar o valor cifrado direto para
  // `verificarCodigoTotp` faria TODO código ser recusado — e o sintoma seria "o
  // autenticador não funciona", que manda a pessoa procurar no lugar errado.
  const claro = decifrarSegredo(linha.mfaSecret, ator.usuarioId).segredo
  if (!verificarCodigoTotp(claro, codigo)) {
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
