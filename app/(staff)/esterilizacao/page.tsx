import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import {
  autoclavesAtivas,
  ciclosDeEsterilizacao,
  proximaCargaSugerida,
} from '@/lib/periodontal/consultas'
import { dataBr, dataHoraBr } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import { LancarBiologico, NovaCarga } from './Controles'

export const metadata: Metadata = { title: 'Esterilização' }

/**
 * O livro de ciclos da autoclave.
 *
 * ── Por que esta tela existe, e por que a ordem é essa ──────────────────────
 * O indicador biológico é incubado e o resultado sai **dias depois**. Isso significa
 * que todo ciclo nasce sem veredito, e um ciclo esquecido em `pendente` é material em
 * uso cuja esterilização ninguém confirmou. Por isso pendente vem no topo: transforma
 * um esquecimento invisível em trabalho visível.
 *
 * `certificado` **não é campo desta tela** — é coluna gerada no banco (químico
 * aprovado E biológico negativo). A interface registra o que o indicador disse; quem
 * conclui é o Postgres. Mesmo princípio do nível de inserção e da glosa calculada.
 *
 * ── ⚠️ Isto NÃO é conformidade com a RDC 15 ────────────────────────────────
 * O que existe aqui é o **registro** de carga, indicadores e responsável. A norma
 * pede além disso: qualificação térmica do equipamento, periodicidade definida do
 * biológico, POP escrito e registro da limpeza prévia — nada disso está no sistema. E
 * `conteudo` é texto livre, o que significa que **não há rastreabilidade até o
 * paciente**: com um biológico positivo, o sistema diz qual ciclo e qual dia, não a
 * lista de quem foi atendido com aquele material. É a mesma distinção de "válido
 * contra o XSD ≠ aceito pela operadora".
 */
export default async function Page() {
  const ator = await exigirPermissaoPagina('estoque', 'ler')
  const podeRegistrar = pode(ator.perfil, 'estoque', 'criar')
  const podeLancar = pode(ator.perfil, 'estoque', 'editar')

  const [ciclos, autoclaves] = await Promise.all([ciclosDeEsterilizacao(), autoclavesAtivas()])
  const primeira = autoclaves[0]
  const cargaSugerida = primeira ? await proximaCargaSugerida(primeira.id) : 1

  const pendentes = ciclos.filter((c) => c.biologicoResultado === 'pendente').length
  const positivos = ciclos.filter((c) => c.biologicoResultado === 'positivo').length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-fg">Esterilização</h1>
        <p className="mt-1 text-sm text-fg-2">
          {pendentes > 0
            ? `${pendentes} carga(s) aguardando o indicador biológico.`
            : 'Nenhuma carga aguardando biológico.'}{' '}
          O resultado sai dias depois da carga — até ele, a carga não está certificada.
        </p>
      </div>

      {positivos > 0 && (
        <Card>
          <CardBody>
            <p className="text-sm font-medium text-critico">
              {positivos} carga(s) com indicador biológico POSITIVO.
            </p>
            <p className="mt-1 text-sm text-fg-2">
              Biológico positivo significa falha de esterilização: o material daquela carga não
              está estéril. O sistema registra qual carga e qual dia — <strong>não</strong> a lista
              de pacientes atendidos com ele, porque o conteúdo é texto livre e isso não é
              rastreabilidade.
            </p>
          </CardBody>
        </Card>
      )}

      {podeRegistrar && autoclaves.length > 0 && (
        <Card>
          <CardHeader
            titulo="Registrar carga"
            descricao="O número é o que vai na etiqueta do pacote e reinicia a cada dia da clínica."
          />
          <CardBody>
            <NovaCarga autoclaves={autoclaves} numeroSugerido={cargaSugerida} />
          </CardBody>
        </Card>
      )}

      {podeRegistrar && autoclaves.length === 0 && (
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">
              Nenhuma autoclave cadastrada. Sem equipamento registrado não há carga a registrar.
            </p>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          titulo="Ciclos"
          descricao="Pendentes de biológico primeiro — é o que precisa de ação."
        />
        <CardBody>
          {ciclos.length === 0 ? (
            <p className="text-sm text-fg-2">Nenhum ciclo registrado.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-fg-2">
                    <th scope="col" className="py-1 pr-2 font-medium">
                      Dia / carga
                    </th>
                    <th scope="col" className="py-1 pr-2 font-medium">
                      Autoclave
                    </th>
                    <th scope="col" className="py-1 pr-2 font-medium">
                      Conteúdo
                    </th>
                    <th scope="col" className="py-1 pr-2 font-medium">
                      Químico
                    </th>
                    <th scope="col" className="py-1 pr-2 font-medium">
                      Biológico
                    </th>
                    <th scope="col" className="py-1 pr-2 font-medium">
                      Certificado
                    </th>
                    <th scope="col" className="py-1 font-medium">
                      Responsável
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ciclos.map((c) => (
                    <tr key={c.id} className="border-b border-border/50 align-top">
                      <td className="py-2 pr-2 tabular-nums">
                        <div className="font-medium text-fg">
                          {dataBr(c.dia)} · carga {c.numero}
                        </div>
                        <div className="text-xs text-fg-3">{dataHoraBr(c.iniciadoEm)}</div>
                      </td>
                      <td className="py-2 pr-2 text-fg-2">
                        {c.autoclaveNome}
                        {c.programa && <div className="text-xs text-fg-3">{c.programa}</div>}
                      </td>
                      <td className="py-2 pr-2 text-fg-2">{c.conteudo}</td>
                      <td className="py-2 pr-2">
                        <span
                          className={
                            c.indicadorQuimico === 'reprovado' ? 'text-critico' : 'text-fg-2'
                          }
                        >
                          {c.indicadorQuimico}
                        </span>
                      </td>
                      <td className="py-2 pr-2">
                        {c.biologicoResultado === 'pendente' ? (
                          podeLancar ? (
                            <LancarBiologico id={c.id} />
                          ) : (
                            <span className="text-atencao">pendente</span>
                          )
                        ) : (
                          <div>
                            <span
                              className={
                                c.biologicoResultado === 'positivo'
                                  ? 'font-medium text-critico'
                                  : 'text-fg-2'
                              }
                            >
                              {c.biologicoResultado}
                            </span>
                            {c.biologicoLidoEm && (
                              <div className="text-xs text-fg-3">
                                lido {dataHoraBr(c.biologicoLidoEm)}
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-2">
                        {/* Coluna GERADA: o banco conclui, a tela mostra. */}
                        {c.certificado === true ? (
                          <span className="text-sucesso">✓</span>
                        ) : (
                          <span className="text-fg-3" title="Só com químico aprovado e biológico negativo">
                            não
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-fg-2">{c.responsavelNome}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <p className="text-xs text-fg-2">
        ⚠️ Este registro <strong>não</strong> constitui conformidade com a RDC 15 da Anvisa: faltam
        qualificação térmica, periodicidade definida do biológico, POP escrito e registro da
        limpeza prévia. E o conteúdo é texto livre — não há rastreabilidade do ciclo até o
        paciente.
      </p>
    </div>
  )
}
