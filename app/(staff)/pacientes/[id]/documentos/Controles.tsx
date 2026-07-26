'use client'

import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Alerta } from '@/components/ui/Input'
import { Icone } from '@/components/ui/Icone'
import { anexarDoFormulario, removerDocumento } from '@/lib/documentos/acoes'
import { LIMITE_BYTES, emMegabytes } from '@/lib/domain/arquivo'
import { catalogoDentes } from '@/lib/domain/dentes'
import { useRouter } from 'next/navigation'
import { useRef, useState, useTransition } from 'react'

/**
 * Controles de documentos.
 *
 * A validação real é no servidor — ela lê os bytes do arquivo, e o cliente não
 * tem como provar nada. O que existe aqui é conveniência: barrar 60 MB antes de
 * subir a rede economiza minutos do dentista. Nada aqui é barreira de segurança.
 */

const TIPOS = [
  { valor: 'radiografia', rotulo: 'Radiografia' },
  { valor: 'foto_clinica', rotulo: 'Foto clínica' },
  { valor: 'exame', rotulo: 'Exame' },
  { valor: 'termo_consentimento', rotulo: 'Termo de consentimento' },
  { valor: 'documento_pessoal', rotulo: 'Documento pessoal' },
  { valor: 'outro', rotulo: 'Outro' },
] as const

type Tipo = (typeof TIPOS)[number]['valor']

const DENTES = catalogoDentes()

export function FormularioAnexo({ pacienteId }: { pacienteId: string }) {
  const router = useRouter()
  const formulario = useRef<HTMLFormElement>(null)
  const [pendente, iniciar] = useTransition()
  const [tipo, setTipo] = useState<Tipo>('radiografia')
  const [tamanho, setTamanho] = useState<number | null>(null)
  const [resultado, setResultado] = useState<{ ok: boolean; mensagem: string; aviso?: string } | null>(
    null,
  )

  const limite = LIMITE_BYTES[tipo]
  const grandeDemais = tamanho !== null && tamanho > limite

  function enviar(dados: FormData): void {
    setResultado(null)
    iniciar(async () => {
      const r = await anexarDoFormulario(dados)
      setResultado(r.ok ? { ok: true, mensagem: r.mensagem, aviso: r.aviso } : { ok: false, mensagem: r.mensagem })
      if (r.ok) {
        formulario.current?.reset()
        setTamanho(null)
        router.refresh()
      }
    })
  }

  return (
    <Card>
      <CardHeader
        titulo="Anexar arquivo"
        descricao="Radiografia, foto clínica, exame ou documento. O tipo é conferido pelo conteúdo, não pela extensão."
      />
      <CardBody>
        <form ref={formulario} action={enviar} className="space-y-3">
          <input type="hidden" name="pacienteId" value={pacienteId} />

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="tipo" className="mb-1 block text-sm font-medium text-fg-2">
                Tipo
              </label>
              <select
                id="tipo"
                name="tipo"
                value={tipo}
                onChange={(e) => setTipo(e.currentTarget.value as Tipo)}
                className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-fg"
              >
                {TIPOS.map((t) => (
                  <option key={t.valor} value={t.valor}>
                    {t.rotulo}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-fg-3">Limite: {emMegabytes(limite)}</p>
            </div>

            <div>
              <label htmlFor="dataExame" className="mb-1 block text-sm font-medium text-fg-2">
                Data do exame
              </label>
              <input
                id="dataExame"
                name="dataExame"
                type="date"
                className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
              />
              {/* A data do exame é clínica e pode ser bem anterior ao envio. */}
              <p className="mt-1 text-xs text-fg-3">Em branco = hoje</p>
            </div>

            <div>
              <label htmlFor="etapa" className="mb-1 block text-sm font-medium text-fg-2">
                Etapa
              </label>
              <select
                id="etapa"
                name="etapa"
                className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-fg"
              >
                <option value="">—</option>
                <option value="inicial">Inicial (antes)</option>
                <option value="durante">Durante</option>
                <option value="final">Final (depois)</option>
              </select>
              <p className="mt-1 text-xs text-fg-3">Inicial + final formam o antes/depois</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <label htmlFor="nome" className="mb-1 block text-sm font-medium text-fg-2">
                Nome
              </label>
              <input
                id="nome"
                name="nome"
                placeholder="Ex.: Panorâmica inicial"
                className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg placeholder:text-fg-3"
              />
            </div>

            <div>
              <label htmlFor="denteFdi" className="mb-1 block text-sm font-medium text-fg-2">
                Dente (FDI)
              </label>
              <select
                id="denteFdi"
                name="denteFdi"
                className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-fg"
              >
                <option value="">—</option>
                {DENTES.map((d) => (
                  <option key={d.fdi} value={d.fdi}>
                    {d.fdi} · {d.nome}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="descricao" className="mb-1 block text-sm font-medium text-fg-2">
              Observação
            </label>
            <input
              id="descricao"
              name="descricao"
              className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
            />
          </div>

          <div>
            <label htmlFor="arquivo" className="mb-1 block text-sm font-medium text-fg-2">
              Arquivo
            </label>
            <input
              id="arquivo"
              name="arquivo"
              type="file"
              required
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/tiff,application/pdf,.dcm"
              onChange={(e) => setTamanho(e.currentTarget.files?.[0]?.size ?? null)}
              className="w-full rounded-(--radius-controle) border border-border bg-surface px-3 py-2 text-sm text-fg"
            />
            {tamanho !== null ? (
              <p
                className={
                  grandeDemais ? 'mt-1 text-xs font-medium text-critico' : 'mt-1 text-xs text-fg-3'
                }
              >
                {emMegabytes(tamanho)}
                {grandeDemais ? ` — acima do limite de ${emMegabytes(limite)} para este tipo` : ''}
              </p>
            ) : null}
          </div>

          {resultado && !resultado.ok ? <Alerta>{resultado.mensagem}</Alerta> : null}
          {resultado?.ok ? (
            <Alerta tipo={resultado.aviso ? 'atencao' : 'sucesso'}>
              {resultado.mensagem}
              {resultado.aviso ? ` ${resultado.aviso}` : ''}
            </Alerta>
          ) : null}

          <Button type="submit" variante="primario" disabled={pendente || grandeDemais}>
            <Icone nome="novo" tamanho={14} />
            {pendente ? 'Enviando…' : 'Anexar ao prontuário'}
          </Button>
        </form>
      </CardBody>
    </Card>
  )
}

export interface DocumentoDaLinha {
  readonly id: string
  readonly nome: string
  readonly descricao: string | null
  readonly tipoRotulo: string
  readonly denteFdi: number | null
  readonly etapaRotulo: string | null
  readonly tamanho: string
  readonly dataExameIso: string | null
  readonly criadoEmIso: string
  readonly criadoPorNome: string | null
  readonly exibivelNoNavegador: boolean
}

export function LinhaDocumento({
  documento: d,
  podeRemover,
}: {
  documento: DocumentoDaLinha
  podeRemover: boolean
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [confirmando, setConfirmando] = useState(false)
  const [motivo, setMotivo] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  const quando = d.dataExameIso ?? d.criadoEmIso

  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <a
          href={`/api/documentos/${d.id}`}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-fg hover:text-primary hover:underline"
        >
          {d.nome}
        </a>
        <span className="text-xs text-fg-3">{d.tipoRotulo}</span>
        {d.denteFdi !== null ? (
          <span className="rounded-(--radius-controle) bg-surface-2 px-1.5 text-xs text-fg-2">
            dente {d.denteFdi}
          </span>
        ) : null}
        {d.etapaRotulo ? (
          <span className="rounded-(--radius-controle) bg-primary/10 px-1.5 text-xs text-primary">
            {d.etapaRotulo}
          </span>
        ) : null}
        <span className="ml-auto text-xs text-fg-3">
          {new Date(quando).toLocaleDateString('pt-BR')} · {d.tamanho}
        </span>
      </div>

      {d.descricao ? <p className="text-xs text-fg-2">{d.descricao}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <a href={`/api/documentos/${d.id}`} download>
          <Button tamanho="sm" variante="fantasma">
            <Icone nome="baixar" tamanho={14} />
            Baixar
          </Button>
        </a>
        {!d.exibivelNoNavegador ? (
          <span className="text-xs text-atencao">
            <span aria-hidden>⚠</span> este formato não abre no navegador — baixe para ver
          </span>
        ) : null}
        {d.criadoPorNome ? (
          <span className="text-xs text-fg-3">enviado por {d.criadoPorNome}</span>
        ) : null}

        {podeRemover ? (
          confirmando ? null : (
            <Button
              tamanho="sm"
              variante="fantasma"
              className="ml-auto"
              onClick={() => setConfirmando(true)}
            >
              Remover
            </Button>
          )
        ) : null}
      </div>

      {confirmando ? (
        <div className="space-y-2 rounded-(--radius-controle) border border-atencao/40 bg-atencao/5 p-3">
          {/* Remoção não se desfaz — o aviso é literal, não decorativo. */}
          <p className="text-xs text-fg-2">
            A remoção <strong>não se desfaz</strong>. O arquivo continua guardado pela exigência
            legal de 20 anos, mas deixa de ser acessível. Diga por quê:
          </p>
          <input
            value={motivo}
            onChange={(e) => setMotivo(e.currentTarget.value)}
            placeholder="Ex.: enviado no paciente errado"
            className="h-9 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-sm text-fg placeholder:text-fg-3"
          />
          {erro ? <p className="text-xs text-critico">{erro}</p> : null}
          <div className="flex gap-2">
            <Button
              tamanho="sm"
              disabled={pendente}
              onClick={() =>
                iniciar(async () => {
                  const r = await removerDocumento(d.id, motivo)
                  if (r.ok) {
                    setConfirmando(false)
                    router.refresh()
                  } else {
                    setErro(r.mensagem)
                  }
                })
              }
            >
              {pendente ? 'Removendo…' : 'Confirmar remoção'}
            </Button>
            <Button
              tamanho="sm"
              variante="fantasma"
              onClick={() => {
                setConfirmando(false)
                setErro(null)
              }}
            >
              Cancelar
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}
