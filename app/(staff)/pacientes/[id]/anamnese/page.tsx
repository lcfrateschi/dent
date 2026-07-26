import { FaixaAlertas } from '@/components/paciente/FaixaAlertas'
import { historicoAnamnese, ultimaAnamnese } from '@/lib/anamnese/acoes'
import { formularioAtual, formularioDaVersao } from '@/lib/anamnese/formulario'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { acharPacienteResumo, alertasDoPaciente } from '@/lib/pacientes/consultas'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { FormularioAnamnese } from './FormularioAnamnese'

export const metadata: Metadata = { title: 'Anamnese' }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  /*
   * Permissão sutil: a recepção pode CRIAR anamnese (aplica o questionário no
   * balcão) mas não LER a que já existe. Então a autorização de entrada é por
   * 'criar', e a exibição das respostas anteriores é condicionada a 'ler'.
   */
  const ator = await exigirPermissaoPagina('anamnese', 'criar')
  const { id } = await params

  const paciente = await acharPacienteResumo(id)
  if (!paciente) notFound()

  const podeLer = pode(ator.perfil, 'anamnese', 'ler')

  const [anterior, historico, alertas] = await Promise.all([
    podeLer ? ultimaAnamnese(ator, id) : Promise.resolve(null),
    podeLer ? historicoAnamnese(id) : Promise.resolve([]),
    pode(ator.perfil, 'alerta_clinico', 'ler') ? alertasDoPaciente(id) : Promise.resolve([]),
  ])

  // Reaproveita a versão do formulário que gerou as respostas antigas, para o
  // preenchimento anterior aparecer nos campos certos.
  const formulario = anterior
    ? (formularioDaVersao(anterior.versaoFormulario) ?? formularioAtual())
    : formularioAtual()

  return (
    <div className="space-y-4">
      <FaixaAlertas alertas={alertas} />

      <nav className="flex gap-3 text-sm">
        <Link href={`/pacientes/${id}`} className="text-fg-2 hover:text-fg">
          Ficha
        </Link>
        <span className="font-medium text-fg">Anamnese</span>
        <Link href={`/pacientes/${id}/odontograma`} className="text-fg-2 hover:text-fg">
          Odontograma
        </Link>
      </nav>

      <div>
        <h1 className="text-xl font-semibold text-fg">Anamnese</h1>
        <p className="text-sm text-fg-3">
          {paciente.nome}
          {historico.length > 0
            ? ` · ${historico.length} versão(ões) no prontuário`
            : ' · primeira anamnese'}
        </p>
      </div>

      {!podeLer && historico.length > 0 ? (
        <Card>
          <CardHeader
            titulo="Histórico não visível para o seu perfil"
            descricao="Você pode aplicar o questionário, mas as respostas anteriores são dado clínico."
          />
        </Card>
      ) : null}

      <FormularioAnamnese
        pacienteId={id}
        pacienteNome={paciente.nome}
        formulario={formulario}
        respostasIniciais={anterior?.respostas ?? {}}
        versaoAnterior={anterior?.versao ?? null}
      />

      {podeLer && historico.length > 1 ? (
        <Card>
          <CardHeader
            titulo="Versões anteriores"
            descricao="A anamnese é versionada — nada é sobrescrito."
          />
          <CardBody>
            <ul className="space-y-1 text-sm text-fg-2">
              {historico.map((h) => (
                <li key={h.id}>
                  Versão {h.versao} — {h.preenchidaEm.toLocaleDateString('pt-BR')}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <p className="text-xs text-fg-3">Este acesso foi registrado na trilha de auditoria.</p>
    </div>
  )
}
