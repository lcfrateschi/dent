/**
 * Chave que desliga a verificação em duas etapas — **só em desenvolvimento**.
 *
 * ── Por que isto existe ─────────────────────────────────────────────────────
 * Testar o sistema com quatro perfis exige quatro códigos de seis dígitos que
 * expiram em 30 segundos. Para passear pelas telas, isso é atrito sem retorno.
 *
 * ── Por que isto é perigoso, e como fica contido ────────────────────────────
 * MFA para staff não é conforto: é prontuário. Uma senha vazada, sozinha, passa a
 * abrir o histórico clínico de todos os pacientes da clínica. Então o desligamento
 * tem **três travas**, e a primeira é a que importa:
 *
 * 1. **Produção se recusa a SUBIR com a chave ligada.** Não é "ignora em
 *    produção" — é erro no boot, junto com a checagem de `AUTH_SECRET`
 *    (`lib/auth/segredo.ts`). Um `.env` copiado do desenvolvimento para o
 *    servidor derruba o serviço na cara de quem fez o deploy, em vez de deixar a
 *    clínica rodando sem segundo fator sem ninguém perceber. Falhar alto é o
 *    ponto.
 * 2. **Vale só quando o valor é exatamente `'true'`.** Nada de "qualquer coisa
 *    não vazia": `MFA_DESABILITADO=0` ou `=false` mantêm o MFA ligado.
 * 3. **A tela avisa.** Quem entra num ambiente com o segundo fator desligado vê
 *    isso escrito no login, não descobre depois.
 *
 * ── O que NÃO foi feito, de propósito ───────────────────────────────────────
 * Não existe código mágico `000000` aceito pela verificação TOTP. Seria um
 * backdoor permanente: bastaria a condição de ambiente falhar uma vez para
 * qualquer pessoa entrar com seis zeros. Aqui, com a chave ligada, o campo do
 * código é **ignorado** — o formulário já vem com `000000` preenchido só para
 * você poder clicar em Entrar sem digitar nada. Com a chave desligada,
 * `000000` é um código errado como qualquer outro.
 */

export const MFA_DESABILITADO_MENSAGEM =
  'Verificação em duas etapas DESLIGADA neste ambiente (MFA_DESABILITADO=true). ' +
  'Só vale em desenvolvimento: em produção o app se recusa a subir com esta chave.'

/**
 * `true` quando o segundo fator está desligado por configuração.
 *
 * Em produção devolve `false` sempre — e além disso `exigirSegredoDeProducao()`
 * já terá derrubado o boot. A dupla guarda é deliberada: se alguém remover a
 * checagem do boot no futuro, esta função continua não desligando nada em
 * produção.
 */
export function mfaDesabilitado(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  return process.env.MFA_DESABILITADO === 'true'
}
