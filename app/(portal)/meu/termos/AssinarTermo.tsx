'use client'

import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Alerta } from '@/components/ui/Input'
import { FINALIDADES_DO_PORTAL } from '@/lib/domain/autoatendimento'
import { assinarTermoNoPortal } from '@/lib/portal/acoes'
import { useState, useTransition } from 'react'

/**
 * Aceite do termo, com o que o aceite é e o que não é.
 *
 * ── O texto tem de ser LIDO, não rolado por baixo do botão ─────────────────
 * O termo aparece inteiro, num bloco com rolagem própria, e a caixa de aceite fica
 * **abaixo** dele. Não é enfeite de conformidade: o que se grava é o hash deste texto,
 * e o hash só significa algo se o texto exibido for o texto assinado.
 *
 * ── O aceite é uma caixa, não um clique no botão ───────────────────────────
 * Botão sozinho é clicável por acidente. Caixa + botão exige duas ações
 * deliberadas — e o rótulo da caixa é a frase que a pessoa está afirmando, na
 * primeira pessoa, não "concordo com os termos".
 *
 * ── ⚖️ O que está escrito abaixo, e o que eu recusei escrever ──────────────
 * Escrito: que a clínica registra data, hora, o endereço de internet e o navegador, e
 * que isso identifica **o acesso**, não a pessoa.
 *
 * Recusado: "assinatura digital", "validade jurídica", "certificado", "juridicamente
 * vinculante" e qualquer selo. É assinatura eletrônica **simples** (MP 2.200-2/2001,
 * art. 10 §2º) — vale entre as partes que a admitem, e ponto. Prometer mais é o tipo
 * de frase que se lê em voz alta contra a clínica.
 */
export function AssinarTermo({
  texto,
  versaoTermo,
  meuNome,
  dependentes,
}: {
  texto: string
  versaoTermo: string
  meuNome: string
  dependentes: readonly { readonly id: string; readonly nome: string }[]
}) {
  /** `null` = assino para mim. Um id = assino pelo dependente. */
  const [porQuem, setPorQuem] = useState<string | null>(null)
  const [aceitou, setAceitou] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [pronto, setPronto] = useState<string | null>(null)
  const [pendente, iniciar] = useTransition()

  const alvoNome = porQuem ? (dependentes.find((d) => d.id === porQuem)?.nome ?? '') : meuNome

  function assinar(): void {
    setErro(null)
    iniciar(async () => {
      const r = await assinarTermoNoPortal({
        finalidade: FINALIDADES_DO_PORTAL.termoDeAtendimento,
        texto,
        versaoTermo,
        pacienteAlvoId: porQuem ?? undefined,
      })
      if (!r.ok) {
        setErro(r.mensagem)
        return
      }
      setPronto(r.mensagem)
    })
  }

  if (pronto) {
    return (
      <Card>
        <CardBody>
          <Alerta tipo="sucesso">{pronto}</Alerta>
        </CardBody>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {erro ? <Alerta>{erro}</Alerta> : null}

      <Card>
        <CardHeader titulo="Termo de atendimento" descricao={`Versão ${versaoTermo}`} />
        <CardBody className="space-y-4">
          {/*
            Rolagem própria e `whitespace-pre-wrap`: o texto é da clínica e pode ter
            parágrafos e listas. Reformatá-lo mudaria o que a pessoa lê — e o hash é do
            que ela lê.
          */}
          <div className="max-h-72 overflow-y-auto rounded-(--radius-controle) border border-border bg-surface-2 p-3 text-sm whitespace-pre-wrap text-fg-2">
            {texto}
          </div>

          {dependentes.length > 0 ? (
            <div>
              <p className="text-sm text-fg">Estou aceitando em nome de:</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button tamanho="lg" ativo={porQuem === null} onClick={() => setPorQuem(null)}>
                  {meuNome} (eu)
                </Button>
                {dependentes.map((d) => (
                  <Button
                    key={d.id}
                    tamanho="lg"
                    ativo={porQuem === d.id}
                    onClick={() => setPorQuem(d.id)}
                  >
                    {d.nome}
                  </Button>
                ))}
              </div>
              <p className="mt-1 text-xs text-fg-3">
                Você aparece como responsável legal destes pacientes no cadastro da clínica.
              </p>
            </div>
          ) : null}

          <label className="flex cursor-pointer items-start gap-2.5 rounded-(--radius-controle) border border-border p-3">
            <input
              type="checkbox"
              checked={aceitou}
              onChange={(e) => setAceitou(e.currentTarget.checked)}
              className="mt-0.5 size-5"
            />
            <span className="text-sm text-fg-2">
              Li o texto acima e aceito em nome de <strong>{alvoNome}</strong>.
            </span>
          </label>

          <Button
            variante="primario"
            tamanho="lg"
            className="w-full"
            disabled={pendente || !aceitou}
            onClick={assinar}
          >
            {pendente ? 'Registrando…' : 'Aceitar'}
          </Button>

          {/*
            ⚖️ A explicação honesta, e no tamanho em que se lê. Ela não está em letra
            miúda de rodapé de propósito: é a parte que o paciente precisa entender
            para o aceite valer entre as partes.
          */}
          <div className="rounded-(--radius-controle) bg-surface-2 p-3 text-xs text-fg-2">
            <p>
              Ao aceitar, a clínica guarda a data e a hora, o endereço de internet e o navegador que
              você usou, e uma marca do texto exato que apareceu nesta tela — para que depois seja
              possível saber qual redação você leu.
            </p>
            <p className="mt-1.5">
              Isso registra <strong>este acesso à sua conta</strong>, e não a sua identidade: quem
              tiver o seu e-mail e a sua senha consegue aceitar no seu lugar. Se a clínica precisar
              de um termo com reconhecimento de identidade, ele é assinado presencialmente.
            </p>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
