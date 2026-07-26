import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { formatarCpf } from '@/lib/domain/cpf'
import { idadeEm } from '@/lib/domain/datas'
import { cabecalhoDaClinica, hojeDaClinica } from '@/lib/orcamento/consultas'
import { acharPacienteResumo } from '@/lib/pacientes/consultas'
import { montarProntuario } from '@/lib/prontuario/consultas'
import { dataBr, dataHoraBr } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import '@/app/impressao.css'
import './prontuario-impresso.css'

export const metadata: Metadata = {
  title: 'Prontuário para impressão',
  robots: { index: false, follow: false },
}

const ROTULO_EVENTO = {
  anamnese: 'Anamnese',
  evolucao: 'Evolução',
  execucao: 'Procedimento executado',
  falta: 'Falta ao atendimento',
  documento: 'Documento anexado',
} as const

/**
 * Prontuário completo para papel.
 *
 * O registro da exportação acontece **antes**, na tela `/exportar` — esta página
 * só monta o documento. Ainda assim, montar o prontuário registra a leitura,
 * então a trilha fica com o pedido de exportação e o acesso.
 *
 * Rascunhos aparecem marcados: eles não são prontuário e a pessoa que recebe
 * precisa saber disso. Omiti-los esconderia que existe registro em aberto.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ator = await exigirPermissaoPagina('prontuario', 'exportar')
  const { id } = await params

  const paciente = await acharPacienteResumo(id)
  if (!paciente) notFound()

  const [prontuario, clinica, hoje] = await Promise.all([
    montarProntuario(ator, id),
    cabecalhoDaClinica(),
    hojeDaClinica(),
  ])

  return (
    <div className="folha prontuario">
      <div className="acoes-tela">
        <p>
          Use <strong>Ctrl/Cmd + P</strong> para imprimir ou salvar em PDF. Esta exportação já foi
          registrada na trilha de auditoria.
        </p>
      </div>

      <header className="cabecalho">
        <div>
          <h1>{clinica?.nomeFantasia ?? clinica?.razaoSocial ?? 'Consultório odontológico'}</h1>
          {clinica?.cnpj ? <p className="menor">CNPJ {clinica.cnpj}</p> : null}
          {clinica?.croResponsavel ? (
            <p className="menor">
              Responsável técnico: CRO {clinica.croResponsavel}
              {clinica.ufCroResponsavel ? `-${clinica.ufCroResponsavel}` : ''}
            </p>
          ) : null}
        </div>
        <div className="numero">
          <span className="rotulo">Prontuário</span>
          <strong className="titulo-doc">Odontológico</strong>
          <span className="menor">Emitido em {dataBr(hoje)}</span>
        </div>
      </header>

      <section className="paciente">
        <h2>Identificação do paciente</h2>
        <p>
          <strong>{paciente.nome}</strong>
        </p>
        <p className="menor">
          Nascimento {dataBr(paciente.dataNascimento)} · {idadeEm(paciente.dataNascimento, hoje)}{' '}
          anos
        </p>
      </section>

      {prontuario.assinaturasInvalidas > 0 ? (
        <p className="aviso-rascunho">
          ATENÇÃO: {prontuario.assinaturasInvalidas} registro(s) com assinatura inconsistente
        </p>
      ) : null}

      <section className="resumo-prontuario">
        <h2>Resumo</h2>
        <p className="menor">
          {prontuario.eventos.length} evento(s) registrado(s) ·{' '}
          {prontuario.totalAssinadas} evolução(ões) assinada(s)
          {prontuario.totalRascunhos > 0
            ? ` · ${prontuario.totalRascunhos} rascunho(s) não assinado(s)`
            : ''}
        </p>
      </section>

      <section className="historico">
        <h2>Histórico cronológico</h2>

        {prontuario.eventos.length === 0 ? (
          <p className="menor">Nenhum registro.</p>
        ) : (
          <ol className="eventos">
            {prontuario.eventos.map((ev, i) => {
              if (ev.tipo !== 'evolucao') {
                return (
                  <li key={`${ev.tipo}-${ev.id}-${i}`} className="evento">
                    <div className="evento-cabeca">
                      <span className="evento-data">{dataHoraBr(ev.quando)}</span>
                      <span className="evento-tipo">{ROTULO_EVENTO[ev.tipo]}</span>
                    </div>
                    <p className="evento-corpo">
                      {ev.tipo === 'anamnese'
                        ? `Versão ${ev.versao}${ev.profissionalNome ? ` · ${ev.profissionalNome}` : ''}`
                        : ev.tipo === 'execucao'
                          ? `${ev.procedimentoNome} · ${ev.alvo} · ${ev.profissionalNome}`
                          : ev.tipo === 'falta'
                            ? `Paciente não compareceu · ${ev.profissionalNome}`
                            : `${ev.nomeArquivo} (${ev.tipoDocumento})`}
                    </p>
                  </li>
                )
              }

              const e = ev.evolucao
              const rascunho = e.assinadoEm === null

              return (
                <li key={`ev-${e.id}`} className="evento">
                  <div className="evento-cabeca">
                    <span className="evento-data">{dataHoraBr(e.assinadoEm ?? e.criadoEm)}</span>
                    <span className="evento-tipo">
                      {e.retificaId ? 'Retificação de evolução' : 'Evolução'}
                    </span>
                    {rascunho ? <span className="marca-rascunho">RASCUNHO</span> : null}
                    {e.retificadaPorId ? <span className="marca-retificada">RETIFICADA</span> : null}
                    {!rascunho && !e.assinaturaValida ? (
                      <span className="marca-invalida">ASSINATURA NÃO CONFERE</span>
                    ) : null}
                  </div>

                  {e.motivoRetificacao ? (
                    <p className="evento-motivo">Motivo da retificação: {e.motivoRetificacao}</p>
                  ) : null}

                  <p className="evento-corpo texto-clinico">{e.texto}</p>

                  <p className="evento-assinatura">
                    {e.profissionalNome} — CRO {e.cro}-{e.ufCro}
                    {rascunho ? ' · não assinado' : ` · assinado em ${dataHoraBr(e.assinadoEm!)}`}
                  </p>
                </li>
              )
            })}
          </ol>
        )}
      </section>

      <section className="declaracao">
        <h2>Declaração</h2>
        <p className="menor">
          Este documento reproduz o prontuário odontológico mantido em sistema, na data de emissão.
          Os registros assinados são imutáveis; correções constam como retificações, com a versão
          original preservada, conforme norma do Conselho Federal de Odontologia. A guarda mínima do
          prontuário é de 20 anos.
        </p>
      </section>

      <section className="assinaturas">
        <div>
          <span className="linha-assinatura" />
          <p className="menor">Cirurgião-dentista responsável</p>
        </div>
        <div>
          <span className="linha-assinatura" />
          <p className="menor">Recebido por (nome e documento)</p>
        </div>
      </section>

      <footer className="rodape">
        <p className="menor">
          {paciente.nome}
          {' · '}
          Emitido em {dataBr(hoje)} por {ator.nome}
        </p>
      </footer>
    </div>
  )
}
