import { db } from '@/lib/db'
import { consentimento } from '@/lib/db/schema'
import { and, eq, isNull } from 'drizzle-orm'

/**
 * Consentimento LGPD para contato por WhatsApp.
 *
 * **Por que é consentimento e não tutela da saúde.** Prontuário a clínica trata
 * por obrigação legal e tutela da saúde, sem pedir licença. Mandar mensagem por
 * WhatsApp é diferente: o dado sai da clínica e vai para infraestrutura de
 * terceiro (Meta), para uma finalidade de comodidade — lembrar do horário. Isso
 * exige consentimento específico, revogável, e prova de qual texto foi aceito.
 *
 * A mesma exigência está no banco, como trigger de INSERT em `mensagem_whatsapp`
 * (drizzle/0009_mensageria_travas.sql). Aqui a checagem existe para dar mensagem
 * boa na tela; lá existe para que nenhum caminho de código consiga furar.
 */

/**
 * Finalidade registrada em `consentimento.finalidade`.
 *
 * ⚠️ Esta string está duplicada na trigger `mensagem_whatsapp_exige_consentimento`
 * (drizzle/0009_mensageria_travas.sql). Mudar aqui sem mudar lá faz o banco
 * recusar todo envio. O caso 59 de docker/verificar-invariantes.sql prova que as
 * duas concordam.
 */
export const FINALIDADE_WHATSAPP = 'contato_whatsapp'

/** Versão do termo aceito. Sobe quando a redação muda. */
export const VERSAO_TERMO_WHATSAPP = '1.0'

export const TEXTO_TERMO_WHATSAPP = `Autorizo a clínica a me enviar mensagens por WhatsApp sobre \
meus agendamentos, incluindo lembretes e pedidos de confirmação. Entendo que a mensagem trafega \
por serviço de terceiro (WhatsApp/Meta), que serão enviados apenas os dados necessários para \
identificar o atendimento (meu nome, data e hora), e que posso revogar esta autorização a \
qualquer momento na recepção, sem prejuízo ao meu atendimento.`

/** `true` quando existe consentimento ativo — o mesmo teste que a trigger faz. */
export async function temConsentimentoWhatsapp(pacienteId: string): Promise<boolean> {
  const [linha] = await db
    .select({ id: consentimento.id })
    .from(consentimento)
    .where(
      and(
        eq(consentimento.pacienteId, pacienteId),
        eq(consentimento.finalidade, FINALIDADE_WHATSAPP),
        isNull(consentimento.revogadoEm),
      ),
    )
    .limit(1)

  return linha !== undefined
}
