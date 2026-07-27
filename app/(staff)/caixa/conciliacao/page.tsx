import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { cobrancasPixEmAberto, eventosPixPendentes } from '@/lib/caixa/consultas'
import { somar } from '@/lib/domain/dinheiro'
import { provedorPixConfigurado } from '@/lib/caixa/pix'
import { dataHoraBr, reais } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import { PerguntaDaTela } from '../PerguntaDaTela'

export const metadata: Metadata = { title: 'Conciliação do Pix' }

/**
 * Conciliação do Pix — e a primeira lista é a que importa.
 *
 * ── Por que "liquidações sem dono" vem antes de tudo ────────────────────────
 * Cada linha ali é **dinheiro que caiu na conta da clínica e o sistema não sabe de
 * quem é**: Pix sem cobrança correspondente, valor diferente do cobrado, ou segundo
 * pagamento do mesmo QR. Nenhum desses casos é apagado — apagar a notificação seria a
 * única coisa pior que não conciliar — e nenhum é conciliado por aproximação.
 *
 * "Casar por valor e data parecidos" é o que fecha o mês com o dinheiro do paciente
 * errado, e o erro aparece semanas depois como uma parcela quitada que ninguém pagou.
 * O casamento é por `txid`, que nós geramos na emissão. Sem `txid`, a decisão é humana.
 *
 * ── Por que não há botão de "conciliar à mão" aqui ─────────────────────────
 * Porque resolver essas linhas quase nunca é lançar um pagamento: é devolver o dinheiro,
 * ou descobrir que era outra pessoa pagando na chave errada. Um botão que casasse a
 * liquidação com uma parcela escolhida na tela transformaria a exceção em rotina, e é
 * exatamente a rotina que produz conciliação errada. O caminho é decidir e usar as telas
 * de cobrança do paciente.
 */
export default async function Page() {
  await exigirPermissaoPagina('despesa', 'ler')

  const [pendentes, cobrancas] = await Promise.all([
    eventosPixPendentes(),
    cobrancasPixEmAberto(),
  ])

  const totalSemDono = pendentes.length === 0 ? '0.00' : somar(...pendentes.map((e) => e.valor))
  const expiradas = cobrancas.filter((c) => c.expirada)
  const provedor = provedorPixConfigurado()

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PerguntaDaTela
        titulo="Conciliação do Pix"
        pergunta="que dinheiro caiu na conta e ainda não tem dono?"
        regime="Casamento por txid, gerado por nós na emissão da cobrança. Nunca por valor e data parecidos."
        ativa="conciliacao"
      />

      {/*
        O aviso do provedor simulado é permanente e não some com um clique. Uma tela de
        conciliação que parece funcionar sem PSP configurado é a que faz alguém concluir
        que o Pix está no ar — a mesma razão pela qual o provedor de WhatsApp avisa que
        está simulado.
      */}
      {provedor === 'simulado' && (
        <div className="rounded-(--radius-controle) border-l-2 border-atencao bg-atencao/10 px-3 py-2.5 text-sm text-fg-2">
          <strong className="font-medium text-fg">Provedor Pix simulado.</strong> Nenhuma cobrança
          real é emitida e nenhuma liquidação real chega. O código que fala com o PSP foi escrito
          pela documentação da API Pix do Banco Central e <strong>nunca executou contra uma conta
          de verdade</strong> — o que muda entre PSPs é justamente a autenticação e o cabeçalho de
          assinatura, que não dá para verificar sem credencial.
        </div>
      )}

      <Card>
        <CardHeader
          titulo="Liquidações sem dono"
          descricao="Chegaram do PSP e não viraram pagamento. Cada linha é dinheiro na conta que o sistema não sabe atribuir."
        />
        {pendentes.length === 0 ? (
          <CardBody>
            <p className="text-sm text-fg-2">
              Nenhuma liquidação pendente. Toda notificação recebida casou com uma cobrança.
            </p>
          </CardBody>
        ) : (
          <>
            <CardBody className="border-b border-border">
              <p className="text-sm text-fg-2">
                <strong className="font-medium text-critico">{reais(totalSemDono)}</strong> em{' '}
                {pendentes.length} liquidação(ões) sem destino. Resolver é decisão humana:
                devolver, ou descobrir de quem é.
              </p>
            </CardBody>
            <ul className="divide-y divide-border">
              {pendentes.map((e) => (
                <li key={e.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-fg">{reais(e.valor)}</p>
                      <p className="text-sm text-critico">{e.motivo}</p>
                      {/*
                        O `endToEndId` aparece inteiro de propósito: é o número que o
                        banco entende, e quem for resolver vai procurá-lo no extrato ou
                        passá-lo ao suporte do PSP. Truncar pouparia espaço e obrigaria
                        a abrir o banco de dados.
                      */}
                      <p className="mt-1 break-all font-mono text-xs text-fg-3">
                        {e.endToEndId} · txid {e.txid}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-fg-3">
                      liquidado {dataHoraBr(e.liquidadoEm)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <Card>
        <CardHeader
          titulo="Cobranças em aberto"
          descricao="QR emitido e ainda não pago. Expira sozinho quando a hora passa — não há estado gravado."
        />
        {cobrancas.length === 0 ? (
          <CardBody>
            <p className="text-sm text-fg-2">Nenhuma cobrança Pix pendente.</p>
          </CardBody>
        ) : (
          <>
            {expiradas.length > 0 && (
              <CardBody className="border-b border-border">
                <p className="text-sm text-fg-2">
                  {expiradas.length} cobrança(s) já expiraram. Um QR expirado não é pagável — para
                  cobrar de novo, emita outra na tela da cobrança do paciente.
                </p>
              </CardBody>
            )}
            <ul className="divide-y divide-border">
              {cobrancas.map((c) => (
                <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-fg">{reais(c.valor)}</p>
                    <p className="break-all font-mono text-xs text-fg-3">txid {c.txid}</p>
                  </div>
                  <span
                    className={
                      c.expirada
                        ? 'shrink-0 rounded bg-surface-2 px-2 py-0.5 text-xs text-fg-3'
                        : 'shrink-0 rounded bg-atencao/15 px-2 py-0.5 text-xs text-atencao'
                    }
                  >
                    {c.expirada ? 'expirada' : `expira ${dataHoraBr(c.expiraEm)}`}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <p className="text-xs text-fg-3">
        Notificação repetida do PSP <strong>não</strong> concilia duas vezes: cada liquidação é
        registrada pelo seu identificador único antes de qualquer movimento de dinheiro, e a
        reentrega colide no índice. É a mesma ideia que impede dois lembretes de WhatsApp para o
        mesmo paciente — aqui o custo do erro é maior.
      </p>
    </div>
  )
}
