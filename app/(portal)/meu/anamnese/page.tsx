import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { formularioAtual } from '@/lib/anamnese/formulario'
import type { Respostas } from '@/lib/anamnese/formulario'
import {
  minhaAnamnese,
  minhasRespostasDeAnamnese,
  registrarAcessoDoPortal,
} from '@/lib/portal/consultas'
import { sessaoAtual } from '@/lib/portal/sessao'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Responder } from './Responder'

export const metadata: Metadata = { title: 'Ficha de saúde' }

/**
 * Anamnese respondida pelo paciente, antes da consulta (Fase 19).
 *
 * ── "Ficha de saúde", não "anamnese" ───────────────────────────────────────
 * O `GLOSSARIO.md` manda usar os termos do domínio **no código**, e `anamnese` é o
 * termo em todo lugar aqui dentro. Na tela do paciente o rótulo é outro de propósito:
 * quem entra três vezes por ano não sabe o que é anamnese, e um título que não se
 * entende é um formulário que não se preenche. A URL e o modelo continuam `anamnese`.
 *
 * ── O que esta tela NÃO mostra, e é a decisão que importa ──────────────────
 * **Os alertas clínicos derivados.** A tela do staff (`FormularioAnamnese`) calcula
 * `derivarAlertas` a cada tecla e mostra "anticoagulante — crítico" ao lado, porque
 * quem preenche lá é profissional e o alerta explica por que a pergunta existe.
 *
 * Aqui isso seria interpretação clínica devolvida a quem não pode interpretá-la: o
 * paciente que marca "uso anticoagulante" e vê a palavra **crítico** em vermelho não
 * ganha informação, ganha susto — e o susto muda a resposta seguinte. É o mesmo
 * motivo pelo qual o portal não mostra evolução clínica nem radiografia sem laudo.
 *
 * ── E o que ela diz com todas as letras ────────────────────────────────────
 * Que isto é **declaração**, não prontuário: a resposta entra como versão nova
 * marcada `origem = 'portal'` e `conferida_em = null`, e alguém da clínica confere no
 * dia. Sem essa frase o paciente acha que resolveu, a auxiliar pergunta tudo de novo
 * na cadeira, e o recurso parece inútil dos dois lados.
 */
export default async function Page() {
  const sessao = await sessaoAtual()
  if (!sessao) redirect('/meu/entrar')

  const [cabecalho, anteriores] = await Promise.all([
    minhaAnamnese(sessao),
    minhasRespostasDeAnamnese(sessao),
  ])

  await registrarAcessoDoPortal(sessao, 'anamnese', {
    versaoAnterior: cabecalho?.versao ?? null,
  })

  const formulario = formularioAtual()

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg">Ficha de saúde</h1>
        <p className="text-sm text-fg-3">
          Responder antes da consulta poupa tempo na cadeira. A clínica confere com você no dia.
        </p>
      </div>

      {cabecalho ? (
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">
              Você já respondeu {cabecalho.origem === 'portal' ? 'por aqui' : 'na clínica'} em{' '}
              {cabecalho.preenchidaEm.toLocaleDateString('pt-BR')}.{' '}
              {cabecalho.conferidaEm
                ? 'A clínica já conferiu essas respostas.'
                : 'A clínica ainda não conferiu.'}
            </p>
            <p className="mt-1 text-sm text-fg-3">
              Se algo mudou, responda de novo abaixo — as respostas antigas continuam no seu
              histórico, nada é apagado.
            </p>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          titulo="Como isto é usado"
          descricao="Vale a pena ler uma vez."
        />
        <CardBody>
          <p className="text-sm text-fg-2">
            O que você responde aqui é uma <strong>declaração sua</strong>, não um exame. Ela chega
            para a equipe marcada como “ainda não conferida”, e um profissional confirma com você
            antes de qualquer decisão de tratamento — anestésico, receita, prevenção.
          </p>
          <p className="mt-2 text-sm text-fg-2">
            Se você não souber uma resposta, deixe em branco e diga na consulta. Chutar é pior que
            não responder: alergia e medicamento em uso mudam a conduta.
          </p>
        </CardBody>
      </Card>

      <Responder
        formulario={formulario}
        respostasIniciais={(anteriores?.respostas ?? {}) as Respostas}
      />
    </div>
  )
}
