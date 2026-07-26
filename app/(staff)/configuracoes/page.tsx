import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Icone } from '@/components/ui/Icone'
import { Alerta } from '@/components/ui/Input'
import { cadeiras, configuracaoDaClinica, pendenciasDeConfiguracao } from '@/lib/admin/consultas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { formatarCep, formatarCnpj } from '@/lib/domain/cnpj'
import { NOME_DIA, descreverDia, type DiaSemana } from '@/lib/domain/horario'
import type { Metadata } from 'next'
import Link from 'next/link'
import { CadeirasEditor, ClinicaEditor, HorarioEditor } from './Editores'

export const metadata: Metadata = { title: 'Ajustes' }

/**
 * Configuração da clínica.
 *
 * A tela abre com **o que falta**, não com o que está preenchido. A diferença é
 * prática: um sistema que se declara pronto e imprime atestado sem CRO custa mais
 * do que um que diz, na primeira linha, qual campo ainda impede aquilo.
 *
 * ── Dois campos deliberadamente só de leitura ───────────────────────────────
 * **Base da comissão** e **fuso horário**. Não é limitação de tela: mudar
 * qualquer um dos dois reinterpreta dados já gravados — a apuração de meses
 * fechados no primeiro caso, todo o histórico de agenda e validade de lote no
 * segundo. É conversa com a clínica e migration, não um clique.
 */
export default async function Page() {
  await exigirPermissaoPagina('configuracao', 'ler')

  const [config, listaCadeiras, pendencias] = await Promise.all([
    configuracaoDaClinica(),
    cadeiras(),
    pendenciasDeConfiguracao(),
  ])

  const dias: DiaSemana[] = [0, 1, 2, 3, 4, 5, 6]

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-fg">
          <Icone nome="ajustes" tamanho={18} />
          Ajustes da clínica
        </h1>
        <p className="text-sm text-fg-3">
          Dados que saem nos impressos, horário de funcionamento e cadeiras
        </p>
      </div>

      {pendencias.length > 0 ? (
        <Card>
          <CardHeader
            titulo={`${pendencias.length} coisa(s) faltando`}
            descricao="Cada linha diz por que aquilo importa. Nada aqui impede o sistema de rodar — impede documento de sair correto."
          />
          <CardBody className="space-y-2">
            {pendencias.map((p) => (
              <div key={p.o_que} className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="font-medium text-atencao">{p.o_que}</span>
                <span className="text-fg-2">{p.porque}</span>
                <Link href={p.onde} className="text-xs text-fg-3 underline">
                  {p.onde}
                </Link>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : (
        <Alerta tipo="sucesso">
          Configuração completa: os impressos saem com cabeçalho, CRO e endereço.
        </Alerta>
      )}

      <Card>
        <CardHeader
          titulo="Identificação"
          descricao="Sai no cabeçalho do orçamento, do atestado, da receita e no XML TISS."
        />
        <CardBody>
          <ClinicaEditor
            inicial={{
              razaoSocial: config?.razaoSocial ?? '',
              nomeFantasia: config?.nomeFantasia ?? '',
              cnpj: config?.cnpj ?? '',
              croResponsavel: config?.croResponsavel ?? '',
              ufCroResponsavel: config?.ufCroResponsavel ?? '',
              telefone: config?.telefone ?? '',
              email: config?.email ?? '',
              cep: config?.cep ?? '',
              logradouro: config?.logradouro ?? '',
              numero: config?.numero ?? '',
              complemento: config?.complemento ?? '',
              bairro: config?.bairro ?? '',
              cidade: config?.cidade ?? '',
              uf: config?.uf ?? '',
            }}
          />
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            titulo="Horário de funcionamento"
            descricao="A agenda só oferece horário dentro destas faixas. Duas faixas por dia é o normal: quase todo consultório fecha para almoço."
          />
          <CardBody className="space-y-3">
            <HorarioEditor
              inicial={config?.horarioFuncionamento ?? {}}
              passoInicial={config?.passoAgendaMinutos ?? 15}
            />
            <div className="rounded-(--radius-controle) bg-surface-2 p-3 text-xs text-fg-2">
              <p className="mb-1 font-medium text-fg">Como está hoje</p>
              {dias.map((d) => (
                <p key={d}>
                  <span className="inline-block w-28 text-fg-3">{NOME_DIA[d]}</span>
                  {config ? descreverDia(config.horarioFuncionamento, d) : '—'}
                </p>
              ))}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            titulo="Cadeiras"
            descricao="Cada cadeira é um lugar de atendimento simultâneo. A agenda impede duas marcações na mesma cadeira no mesmo horário."
          />
          <CardBody>
            <CadeirasEditor
              cadeiras={listaCadeiras.map((c) => ({
                id: c.id,
                nome: c.nome,
                ordem: c.ordem,
                ativo: c.ativo,
                agendamentosFuturos: c.agendamentosFuturos,
              }))}
            />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          titulo="Decisões fechadas"
          descricao="Estão aqui para consulta, e não como campo editável — mudar qualquer uma reinterpreta dado já gravado."
        />
        <CardBody className="space-y-3 text-sm">
          <div>
            <p className="font-medium text-fg">
              Comissão sobre valor <strong>recebido</strong>
            </p>
            <p className="text-fg-2">
              A comissão entra na base quando o pagamento é conciliado, não quando o procedimento é
              executado. Comissão paga sobre execução vira adiantamento quando o paciente atrasa.
              Mudar isto reabriria a apuração de meses já fechados.
            </p>
            <p className="mt-0.5 font-mono text-xs text-fg-3">
              clinica.base_comissao = {config?.baseComissao ?? 'valor_recebido'}
            </p>
          </div>
          <div>
            <p className="font-medium text-fg">Fuso horário: {config?.fusoHorario}</p>
            <p className="text-fg-2">
              A agenda converte instante ↔ hora local por ele, e a validade de lote é dia civil
              neste fuso. Trocá-lo reinterpretaria todo o histórico — inclusive lote que hoje está
              vencido e passaria a valer.
            </p>
          </div>
          {config?.cnpj ? (
            <p className="text-xs text-fg-3">
              CNPJ gravado: {formatarCnpj(config.cnpj)}
              {config.cep ? ` · CEP ${formatarCep(config.cep)}` : null}
            </p>
          ) : null}
        </CardBody>
      </Card>
    </div>
  )
}
