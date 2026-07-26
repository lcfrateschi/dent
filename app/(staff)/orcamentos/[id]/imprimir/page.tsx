import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { formatarCep, formatarCpf, formatarTelefone } from '@/lib/domain/cpf'
import { acharOrcamento, cabecalhoDaClinica, hojeDaClinica } from '@/lib/orcamento/consultas'
import { ROTULO_STATUS_ORCAMENTO } from '@/lib/domain/orcamento'
import { dataBr, reais } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import './imprimir.css'

export const metadata: Metadata = { title: 'Orçamento para impressão', robots: { index: false } }

/**
 * Versão para impressão.
 *
 * ── Por que não uma biblioteca de PDF ───────────────────────────────────────
 * A clínica imprime no papel dela ou salva em PDF pelo próprio navegador — o
 * "Salvar como PDF" existe em todo sistema. Uma biblioteca de PDF no servidor
 * custaria ~2 MB, exigiria embutir fonte com acentuação (o problema clássico de
 * "orçamento" virar "orçamento" no PDF) e ainda dependeria de storage para
 * entregar o arquivo — que é a Fase 10.
 *
 * O que a coluna `orcamento.pdf_key` guarda é justamente esse arquivo
 * arquivado, quando a Fase 10 existir. Até então, esta página É o documento.
 *
 * O CSS de impressão está em `imprimir.css`, fora do Tailwind: precisa de
 * `@page` e de cores fixas, sem depender do tema claro/escuro do usuário.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ator = await exigirPermissaoPagina('orcamento', 'ler')
  const { id } = await params

  const [o, clinica, hoje] = await Promise.all([
    acharOrcamento(ator, id),
    cabecalhoDaClinica(),
    hojeDaClinica(),
  ])
  if (!o) notFound()

  const endereco = clinica
    ? [
        clinica.logradouro,
        clinica.numero ? `nº ${clinica.numero}` : null,
        clinica.bairro,
        clinica.cidade && clinica.uf ? `${clinica.cidade}/${clinica.uf}` : clinica.cidade,
        clinica.cep ? `CEP ${formatarCep(clinica.cep)}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : ''

  return (
    <div className="folha">
      <div className="acoes-tela">
        {/* Some na impressão — ver imprimir.css. */}
        <p>
          Use <strong>Ctrl/Cmd + P</strong> para imprimir ou salvar em PDF.
        </p>
      </div>

      <header className="cabecalho">
        <div>
          <h1>{clinica?.nomeFantasia ?? clinica?.razaoSocial ?? 'Consultório odontológico'}</h1>
          {clinica?.nomeFantasia && clinica.razaoSocial !== clinica.nomeFantasia ? (
            <p className="menor">{clinica.razaoSocial}</p>
          ) : null}
          {endereco ? <p className="menor">{endereco}</p> : null}
          <p className="menor">
            {clinica?.telefone ? formatarTelefone(clinica.telefone) : ''}
            {clinica?.email ? ` · ${clinica.email}` : ''}
            {clinica?.cnpj ? ` · CNPJ ${clinica.cnpj}` : ''}
          </p>
          {clinica?.croResponsavel ? (
            <p className="menor">
              Responsável técnico: CRO {clinica.croResponsavel}
              {clinica.ufCroResponsavel ? `-${clinica.ufCroResponsavel}` : ''}
            </p>
          ) : null}
        </div>
        <div className="numero">
          <span className="rotulo">Orçamento</span>
          <strong>#{o.numero}</strong>
          {o.statusVisivel !== 'enviado' && o.statusVisivel !== 'rascunho' ? (
            <span className="situacao">{ROTULO_STATUS_ORCAMENTO[o.statusVisivel]}</span>
          ) : null}
        </div>
      </header>

      {o.status === 'rascunho' ? (
        // Marca d'água textual: rascunho impresso por engano não deve circular
        // como proposta. Texto, não imagem — sobrevive a impressão em preto.
        <p className="aviso-rascunho">RASCUNHO — não entregar ao paciente</p>
      ) : null}

      <section className="paciente">
        <h2>Paciente</h2>
        <p>
          <strong>{o.pacienteNome}</strong>
          {o.pacienteCpf ? ` · CPF ${formatarCpf(o.pacienteCpf)}` : ''}
        </p>
      </section>

      <table className="itens">
        <thead>
          <tr>
            <th>Procedimento</th>
            <th>Detalhe</th>
            <th className="centro">Qtd.</th>
            <th className="direita">Valor</th>
          </tr>
        </thead>
        <tbody>
          {o.linhas.map((l) => (
            <tr key={l.id}>
              <td>{l.descricao}</td>
              <td>{l.detalhe ?? ''}</td>
              <td className="centro">{l.quantidade}</td>
              <td className="direita">{reais(l.valorUnitario)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3} className="direita">
              Subtotal
            </td>
            <td className="direita">{reais(o.valorBruto)}</td>
          </tr>
          {Number(o.desconto) > 0 ? (
            <tr>
              <td colSpan={3} className="direita">
                Desconto
              </td>
              <td className="direita">− {reais(o.desconto)}</td>
            </tr>
          ) : null}
          <tr className="total">
            <td colSpan={3} className="direita">
              Total
            </td>
            <td className="direita">{reais(o.valorTotal)}</td>
          </tr>
        </tfoot>
      </table>

      {o.observacao ? (
        <section className="observacao">
          <h2>Observações</h2>
          <p>{o.observacao}</p>
        </section>
      ) : null}

      <section className="condicoes">
        <h2>Condições</h2>
        <ul>
          <li>
            Este orçamento é válido até <strong>{dataBr(o.validadeAte)}</strong>. Após essa data os
            valores podem ser revistos.
          </li>
          <li>
            Os valores referem-se aos procedimentos listados. Procedimentos identificados durante o
            tratamento serão orçados separadamente.
          </li>
          <li>
            O plano de tratamento pode ser ajustado conforme a evolução clínica, sempre com
            comunicação prévia.
          </li>
          <li>Formas de pagamento e parcelamento são combinados na aceitação.</li>
        </ul>
      </section>

      <section className="assinaturas">
        <div>
          <span className="linha-assinatura" />
          <p className="menor">Paciente ou responsável legal</p>
        </div>
        <div>
          <span className="linha-assinatura" />
          <p className="menor">Cirurgião-dentista responsável</p>
        </div>
      </section>

      <footer className="rodape">
        <p className="menor">
          Emitido em {dataBr(hoje)} · Orçamento #{o.numero}
          {o.criadoPorNome ? ` · ${o.criadoPorNome}` : ''}
        </p>
      </footer>
    </div>
  )
}
