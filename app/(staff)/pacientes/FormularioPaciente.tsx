'use client'

import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Alerta, Input, Select, Textarea } from '@/components/ui/Input'
import { UFS } from '@/lib/domain/cpf'
import { ehMenorDeIdade } from '@/lib/domain/datas'
import type { ResultadoForm } from '@/lib/pacientes/acoes'
import type { PacienteCompleto } from '@/lib/pacientes/consultas'
import { useRouter } from 'next/navigation'
import { useActionState, useEffect, useState } from 'react'

export interface Responsavel {
  readonly id: string
  readonly nome: string
}

export function FormularioPaciente({
  paciente,
  responsaveis,
  acao,
  cancelarHref,
}: {
  paciente?: PacienteCompleto
  /** Candidatos a responsável legal, já filtrados para maiores de idade. */
  responsaveis: readonly Responsavel[]
  acao: (anterior: ResultadoForm | null, dados: FormData) => Promise<ResultadoForm>
  cancelarHref: string
}) {
  const router = useRouter()
  const [estado, enviar, pendente] = useActionState(acao, null)
  const [nascimento, setNascimento] = useState(paciente?.dataNascimento ?? '')

  useEffect(() => {
    if (estado?.ok) router.push(`/pacientes/${estado.id}`)
  }, [estado, router])

  const erros = estado && !estado.ok ? estado.erros : {}
  const hoje = new Date().toISOString().slice(0, 10)

  // Mostra o campo de responsável assim que a data indica menor de idade —
  // antes de o servidor recusar. Menos ida e volta na recepção.
  let exigeResponsavel = false
  try {
    exigeResponsavel = nascimento.length === 10 && ehMenorDeIdade(nascimento, hoje)
  } catch {
    exigeResponsavel = false
  }

  return (
    <form action={enviar} className="space-y-4">
      {estado && !estado.ok && estado.mensagem ? <Alerta>{estado.mensagem}</Alerta> : null}

      <Card>
        <CardHeader titulo="Identificação" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Input
            id="nome"
            name="nome"
            rotulo="Nome completo"
            defaultValue={paciente?.nome}
            erro={erros.nome}
            autoComplete="off"
            obrigatorio
            className="sm:col-span-2"
          />
          <Input
            id="nomeSocial"
            name="nomeSocial"
            rotulo="Nome social"
            defaultValue={paciente?.nomeSocial ?? ''}
            erro={erros.nomeSocial}
            ajuda="Como a pessoa quer ser chamada, se diferente do registro."
          />
          <Select
            id="sexo"
            name="sexo"
            rotulo="Sexo"
            defaultValue={paciente?.sexo ?? 'nao_informado'}
            erro={erros.sexo}
          >
            <option value="nao_informado">Não informado</option>
            <option value="feminino">Feminino</option>
            <option value="masculino">Masculino</option>
            <option value="outro">Outro</option>
          </Select>
          <Input
            id="dataNascimento"
            name="dataNascimento"
            type="date"
            rotulo="Data de nascimento"
            defaultValue={paciente?.dataNascimento}
            onChange={(e) => setNascimento(e.currentTarget.value)}
            max={hoje}
            erro={erros.dataNascimento}
            obrigatorio
          />
          <Input
            id="cpf"
            name="cpf"
            rotulo="CPF"
            defaultValue={paciente?.cpf ?? ''}
            erro={erros.cpf}
            inputMode="numeric"
            ajuda="Opcional — criança costuma não ter."
          />
          <Input
            id="rg"
            name="rg"
            rotulo="RG"
            defaultValue={paciente?.rg ?? ''}
            erro={erros.rg}
          />
          <Select
            id="responsavelLegalId"
            name="responsavelLegalId"
            rotulo="Responsável legal"
            defaultValue={paciente?.responsavelLegalId ?? ''}
            erro={erros.responsavelLegalId}
            obrigatorio={exigeResponsavel}
            ajuda={
              exigeResponsavel
                ? 'Obrigatório: o paciente é menor de idade. É quem assina consentimento e orçamento.'
                : 'Só para menores de idade ou incapazes.'
            }
          >
            <option value="">— nenhum —</option>
            {responsaveis.map((r) => (
              <option key={r.id} value={r.id}>
                {r.nome}
              </option>
            ))}
          </Select>
        </CardBody>
      </Card>

      <Card>
        <CardHeader titulo="Contato" descricao="O WhatsApp é usado na confirmação de consulta." />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          <Input
            id="telefone"
            name="telefone"
            rotulo="Telefone"
            defaultValue={paciente?.telefone ?? ''}
            erro={erros.telefone}
            inputMode="tel"
          />
          <Input
            id="telefoneWhatsapp"
            name="telefoneWhatsapp"
            rotulo="WhatsApp"
            defaultValue={paciente?.telefoneWhatsapp ?? ''}
            erro={erros.telefoneWhatsapp}
            inputMode="tel"
          />
          <Input
            id="email"
            name="email"
            type="email"
            rotulo="E-mail"
            defaultValue={paciente?.email ?? ''}
            erro={erros.email}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader titulo="Endereço" />
        <CardBody className="grid gap-4 sm:grid-cols-6">
          <Input
            id="cep"
            name="cep"
            rotulo="CEP"
            defaultValue={paciente?.cep ?? ''}
            erro={erros.cep}
            inputMode="numeric"
            className="sm:col-span-2"
          />
          <Input
            id="logradouro"
            name="logradouro"
            rotulo="Logradouro"
            defaultValue={paciente?.logradouro ?? ''}
            erro={erros.logradouro}
            className="sm:col-span-4"
          />
          <Input
            id="numero"
            name="numero"
            rotulo="Número"
            defaultValue={paciente?.numero ?? ''}
            erro={erros.numero}
            className="sm:col-span-1"
          />
          <Input
            id="complemento"
            name="complemento"
            rotulo="Complemento"
            defaultValue={paciente?.complemento ?? ''}
            erro={erros.complemento}
            className="sm:col-span-2"
          />
          <Input
            id="bairro"
            name="bairro"
            rotulo="Bairro"
            defaultValue={paciente?.bairro ?? ''}
            erro={erros.bairro}
            className="sm:col-span-3"
          />
          <Input
            id="cidade"
            name="cidade"
            rotulo="Cidade"
            defaultValue={paciente?.cidade ?? ''}
            erro={erros.cidade}
            className="sm:col-span-4"
          />
          <Select
            id="uf"
            name="uf"
            rotulo="UF"
            defaultValue={paciente?.uf ?? ''}
            erro={erros.uf}
            className="sm:col-span-2"
          >
            <option value="">—</option>
            {UFS.map((uf) => (
              <option key={uf} value={uf}>
                {uf}
              </option>
            ))}
          </Select>
        </CardBody>
      </Card>

      <Card>
        <CardHeader titulo="Outros" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Input
            id="indicadoPor"
            name="indicadoPor"
            rotulo="Como conheceu a clínica"
            defaultValue={paciente?.indicadoPor ?? ''}
            erro={erros.indicadoPor}
          />
          <Select
            id="status"
            name="status"
            rotulo="Status"
            defaultValue={paciente?.status ?? 'ativo'}
            erro={erros.status}
          >
            <option value="ativo">Ativo</option>
            <option value="inativo">Inativo</option>
            <option value="arquivado">Arquivado</option>
          </Select>
          <Textarea
            id="observacoes"
            name="observacoes"
            rotulo="Observações administrativas"
            defaultValue={paciente?.observacoes ?? ''}
            erro={erros.observacoes}
            ajuda="Não é prontuário. Anotação clínica vai na evolução, que é assinada e imutável."
            className="sm:col-span-2"
          />
        </CardBody>
      </Card>

      <div className="flex gap-2">
        <Button type="submit" variante="primario" tamanho="lg" disabled={pendente}>
          {pendente ? 'Salvando…' : paciente ? 'Salvar alterações' : 'Cadastrar paciente'}
        </Button>
        <Button
          type="button"
          tamanho="lg"
          variante="fantasma"
          onClick={() => router.push(cancelarHref)}
        >
          Cancelar
        </Button>
      </div>
    </form>
  )
}
