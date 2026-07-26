import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { FaixaAlertas } from '@/components/paciente/FaixaAlertas'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { formatarCep, formatarCpf, formatarTelefone } from '@/lib/domain/cpf'
import { idadeEm } from '@/lib/domain/datas'
import { acharPaciente, acharPacienteResumo, alertasDoPaciente } from '@/lib/pacientes/consultas'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

export const metadata: Metadata = { title: 'Ficha do paciente' }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ator = await exigirPermissaoPagina('paciente', 'ler')
  const { id } = await params

  // `acharPaciente` registra a leitura na trilha de auditoria.
  const p = await acharPaciente(ator, id)
  if (!p) notFound()

  const [alertas, responsavel] = await Promise.all([
    // Recepção também vê alertas: é segurança do paciente na cadeira.
    pode(ator.perfil, 'alerta_clinico', 'ler') ? alertasDoPaciente(id) : Promise.resolve([]),
    p.responsavelLegalId ? acharPacienteResumo(p.responsavelLegalId) : Promise.resolve(null),
  ])

  const hoje = new Date().toISOString().slice(0, 10)
  const idade = idadeEm(p.dataNascimento, hoje)
  const menor = idade < 18

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      {/* Alertas no TOPO, antes de qualquer outra informação. */}
      <FaixaAlertas alertas={alertas} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-fg">{p.nome}</h1>
            {p.status !== 'ativo' ? (
              <span className="rounded-full border border-atencao/30 bg-atencao/12 px-2 py-0.5 text-xs font-medium text-atencao capitalize">
                {p.status}
              </span>
            ) : null}
            {menor ? (
              <span className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs font-medium text-fg-2">
                menor de idade
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-sm text-fg-3">
            {idade} anos
            {p.nomeSocial ? ` · nome social: ${p.nomeSocial}` : ''}
            {p.cpf ? ` · CPF ${formatarCpf(p.cpf)}` : ''}
          </p>
        </div>

        <div className="flex gap-2">
          <Link href="/pacientes">
            <Button variante="fantasma">Voltar</Button>
          </Link>
          {pode(ator.perfil, 'paciente', 'editar') ? (
            <Link href={`/pacientes/${p.id}/editar`}>
              <Button variante="primario">Editar</Button>
            </Link>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader titulo="Identificação" />
          <CardBody>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <Linha rotulo="Nascimento">{formatarDataBr(p.dataNascimento)}</Linha>
              <Linha rotulo="Sexo">{ROTULO_SEXO[p.sexo]}</Linha>
              <Linha rotulo="CPF">{p.cpf ? formatarCpf(p.cpf) : '—'}</Linha>
              <Linha rotulo="RG">{p.rg ?? '—'}</Linha>
              <Linha rotulo="Responsável">
                {responsavel ? (
                  <Link
                    href={`/pacientes/${responsavel.id}`}
                    className="text-primary hover:underline"
                  >
                    {responsavel.nome}
                  </Link>
                ) : menor ? (
                  <span className="text-critico">
                    não informado — obrigatório para menor de idade
                  </span>
                ) : (
                  '—'
                )}
              </Linha>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader titulo="Contato" />
          <CardBody>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <Linha rotulo="Telefone">
                {p.telefone ? formatarTelefone(p.telefone) : '—'}
              </Linha>
              <Linha rotulo="WhatsApp">
                {p.telefoneWhatsapp ? formatarTelefone(p.telefoneWhatsapp) : '—'}
              </Linha>
              <Linha rotulo="E-mail">{p.email ?? '—'}</Linha>
              <Linha rotulo="Indicação">{p.indicadoPor ?? '—'}</Linha>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader titulo="Endereço" />
          <CardBody>
            {p.logradouro || p.cidade ? (
              <address className="text-sm not-italic text-fg-2">
                {p.logradouro}
                {p.numero ? `, ${p.numero}` : ''}
                {p.complemento ? ` — ${p.complemento}` : ''}
                <br />
                {p.bairro ? `${p.bairro} · ` : ''}
                {p.cidade}
                {p.uf ? ` / ${p.uf}` : ''}
                {p.cep ? <br /> : null}
                {p.cep ? `CEP ${formatarCep(p.cep)}` : null}
              </address>
            ) : (
              <p className="text-sm text-fg-3">Endereço não informado.</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            titulo="Observações administrativas"
            descricao="Não é prontuário — anotação clínica vai na evolução."
          />
          <CardBody>
            <p className="text-sm whitespace-pre-wrap text-fg-2">
              {p.observacoes || <span className="text-fg-3">Nenhuma observação.</span>}
            </p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader titulo="Prontuário" />
        <CardBody>
          <p className="text-sm text-fg-3">
            Anamnese, odontograma, plano de tratamento e evoluções entram nas Fases 5 a 7.
            Ver <code className="text-fg-2">ROADMAP.md</code>.
          </p>
        </CardBody>
      </Card>

      <p className="text-xs text-fg-3">
        Este acesso foi registrado na trilha de auditoria.
      </p>
    </div>
  )
}

function Linha({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-3">{rotulo}</dt>
      <dd className="text-fg">{children}</dd>
    </>
  )
}

const ROTULO_SEXO = {
  feminino: 'Feminino',
  masculino: 'Masculino',
  outro: 'Outro',
  nao_informado: 'Não informado',
} as const

function formatarDataBr(iso: string): string {
  const [ano, mes, dia] = iso.split('-')
  return `${dia}/${mes}/${ano}`
}
