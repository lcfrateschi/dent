import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { FINALIDADES_DO_PORTAL } from '@/lib/domain/autoatendimento'
import {
  meusDados,
  quemEuAssinoPor,
  regraDoAutoatendimento,
  registrarAcessoDoPortal,
} from '@/lib/portal/consultas'
import { sessaoAtual } from '@/lib/portal/sessao'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AssinarTermo } from './AssinarTermo'

export const metadata: Metadata = { title: 'Termos' }

/**
 * Assinatura eletrônica de termo pelo portal (Fase 19).
 *
 * ── ⚖️ O que esta tela pode dizer, e o que ela NÃO pode ────────────────────
 * O que se grava é `nivel_assinatura = 'eletronica_simples'`: hash do texto exibido,
 * IP, `user_agent` e instante. Na MP 2.200-2/2001 (art. 10, §2º) isso vale **entre as
 * partes que a admitem como válida** — e é o que um termo entre clínica e paciente
 * precisa.
 *
 * **Não** é ICP-Brasil, não é avançada, não é qualificada, e não prova a identidade de
 * quem assinou além do controle desta conta — que é e-mail e senha, **sem segundo
 * fator, por decisão**. Então a tela não escreve "assinatura digital", não escreve
 * "com validade jurídica" e não põe selo de certificado. Ela descreve o que o sistema
 * registra e deixa o paciente concluir — porque prometer validade que não existe é
 * pior para a clínica do que não prometer nada: é o que se lê em voz alta num litígio.
 *
 * ── Por que só o termo da clínica aparece ──────────────────────────────────
 * `FINALIDADES_DO_PORTAL` tem três valores, e apenas `termo_de_atendimento` tem texto
 * de verdade (`regra_autoatendimento.termo_de_atendimento`, que a clínica escreve).
 * Oferecer assinatura de "política de privacidade" sem ter a política redigida seria
 * colher aceite de um texto vazio — e `assinarTermoNoPortal` recusa texto vazio,
 * corretamente. Quando a clínica tiver a política, ela entra aqui pelo mesmo caminho.
 */
export default async function Page() {
  const sessao = await sessaoAtual()
  if (!sessao) redirect('/meu/entrar')

  const [regra, quem, dados] = await Promise.all([
    regraDoAutoatendimento(),
    quemEuAssinoPor(sessao),
    meusDados(sessao),
  ])

  await registrarAcessoDoPortal(sessao, 'termos', {
    dependentes: quem.dependentes.length,
    souMenor: quem.souMenor,
  })

  const termo = regra.termoDeAtendimento?.trim() ?? ''

  const jaAssinados = dados.consentimentos.filter(
    (c) => c.finalidade === FINALIDADES_DO_PORTAL.termoDeAtendimento && !c.revogadoEm,
  )

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg">Termos</h1>
        <p className="text-sm text-fg-3">
          O que você já aceitou, e o que a clínica pede que você leia.
        </p>
      </div>

      {jaAssinados.length > 0 && (
        <Card>
          <CardHeader titulo="Já aceito por você" />
          <CardBody>
            <ul className="space-y-1 text-sm text-fg-2">
              {jaAssinados.map((c) => (
                <li key={c.id}>
                  Termo de atendimento ({c.versaoTermo}) — aceito em{' '}
                  {c.aceitoEm.toLocaleDateString('pt-BR')}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {termo.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">
              Esta clínica não tem termo para aceitar por aqui neste momento.
            </p>
          </CardBody>
        </Card>
      ) : quem.souMenor ? (
        /**
         * ⚠️ O caso do menor com conta própria.
         *
         * `quemAssina` levanta `MENOR_NAO_ASSINA` — a trava é do domínio, e a tela
         * **obedece e explica**. Simplesmente esconder o botão faria a pessoa achar que
         * a tela está quebrada e ligar para a clínica; dizer o motivo resolve sem
         * ligação, e é a informação verdadeira.
         */
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">
              Você é menor de 18 anos, então quem assina os seus termos é o seu responsável legal —
              pela conta dele no portal, ou na clínica. Isto não é uma limitação do sistema: é quem
              a lei reconhece como capaz de consentir por você.
            </p>
          </CardBody>
        </Card>
      ) : (
        <AssinarTermo
          texto={termo}
          versaoTermo={regra.versaoTermo}
          meuNome={quem.meuNome}
          dependentes={quem.dependentes}
        />
      )}
    </div>
  )
}
