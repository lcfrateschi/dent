import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { formatarTelefone } from '@/lib/domain/cpf'
import { TEXTO_TERMO_WHATSAPP } from '@/lib/mensageria/consentimento'
import { meusDados, registrarAcessoDoPortal } from '@/lib/portal/consultas'
import { sessaoAtual, sessoesAbertas } from '@/lib/portal/sessao'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { ControlesDeConsentimento, FormularioTrocarSenha } from './Controles'

export const metadata: Metadata = { title: 'Meus dados' }

const ROTULO_FINALIDADE: Readonly<Record<string, string>> = {
  contato_whatsapp: 'Receber lembretes por WhatsApp',
}

/**
 * Meus dados e privacidade.
 *
 * É aqui que a LGPD deixa de ser texto e passa a ser botão: o titular vê quais
 * consentimentos deu, **revoga sozinho** o que quiser, e enxerga de onde a conta
 * dele foi acessada. Fazer isso depender de uma ligação para a clínica seria
 * cumprir a lei no papel e não na prática.
 *
 * Alterar cadastro (nome, telefone, endereço) **não** é feito aqui: o cadastro é
 * base de documento clínico e de cobrança, e mudança sem conferência viraria
 * atestado com nome errado. O pedido de correção passa pela clínica.
 */
export default async function Page() {
  const sessao = await sessaoAtual()
  if (!sessao) redirect('/meu/entrar')

  const [dados, sessoes] = await Promise.all([meusDados(sessao), sessoesAbertas(sessao.contaId)])
  await registrarAcessoDoPortal(sessao, 'dados')

  const whatsapp = dados.consentimentos.find(
    (c) => c.finalidade === 'contato_whatsapp' && !c.revogadoEm,
  )

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg">Meus dados</h1>
        <p className="text-sm text-fg-3">O que a clínica tem sobre você, e o que você autoriza.</p>
      </div>

      <Card>
        <CardHeader
          titulo="Cadastro"
          descricao="Para corrigir qualquer dado, fale com a clínica — o cadastro é usado em atestado e cobrança."
        />
        <CardBody>
          {dados.paciente ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <Linha rotulo="Nome">{dados.paciente.nomeSocial ?? dados.paciente.nome}</Linha>
              <Linha rotulo="Nascimento">
                {dados.paciente.dataNascimento.split('-').reverse().join('/')}
              </Linha>
              <Linha rotulo="Telefone">
                {dados.paciente.telefone ? formatarTelefone(dados.paciente.telefone) : '—'}
              </Linha>
              <Linha rotulo="WhatsApp">
                {dados.paciente.telefoneWhatsapp
                  ? formatarTelefone(dados.paciente.telefoneWhatsapp)
                  : '—'}
              </Linha>
              <Linha rotulo="E-mail de acesso">{sessao.email}</Linha>
            </dl>
          ) : (
            <p className="text-sm text-fg-3">Cadastro não encontrado.</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          titulo="Lembretes por WhatsApp"
          descricao="Você decide, e pode mudar de ideia quando quiser."
        />
        <CardBody className="space-y-3">
          <ControlesDeConsentimento
            autorizado={whatsapp !== undefined}
            termo={TEXTO_TERMO_WHATSAPP}
          />
        </CardBody>
      </Card>

      {dados.consentimentos.length > 0 ? (
        <Card>
          <CardHeader
            titulo="Histórico de autorizações"
            descricao="Revogar não apaga o registro: fica a data em que valeu e a data em que você revogou."
          />
          <CardBody className="p-0">
            <ul className="divide-y divide-border">
              {dados.consentimentos.map((c) => (
                <li key={c.id} className="px-4 py-2.5 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="text-fg">
                      {ROTULO_FINALIDADE[c.finalidade] ?? c.finalidade}
                    </span>
                    <span className="text-xs text-fg-3">versão {c.versaoTermo}</span>
                    <span className="ml-auto text-xs text-fg-3">
                      {c.aceitoEm.toLocaleDateString('pt-BR')}
                    </span>
                  </div>
                  {c.revogadoEm ? (
                    <p className="text-xs text-fg-3">
                      Revogado em {c.revogadoEm.toLocaleDateString('pt-BR')}
                    </p>
                  ) : (
                    <p className="text-xs text-sucesso">Ativo</p>
                  )}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          titulo="Acessos à sua conta"
          descricao="Se você não reconhece algum destes, troque a senha e avise a clínica."
        />
        <CardBody className="p-0">
          <ul className="divide-y divide-border">
            {sessoes.map((s) => (
              <li key={s.id} className="px-4 py-2.5 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="text-fg">
                    {s.ultimoUsoEm.toLocaleString('pt-BR')}
                  </span>
                  {s.id === sessao.sessaoId ? (
                    <span className="text-xs font-medium text-primary">este dispositivo</span>
                  ) : null}
                  <span className="ml-auto font-mono text-xs text-fg-3">{s.ip ?? '—'}</span>
                </div>
                {s.userAgent ? (
                  <p className="truncate text-xs text-fg-3">{s.userAgent}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          titulo="Trocar senha"
          descricao="Ao trocar, todos os dispositivos são desconectados — inclusive este."
        />
        <CardBody>
          <FormularioTrocarSenha />
        </CardBody>
      </Card>

      <Card>
        <CardHeader titulo="Seu prontuário completo" />
        <CardBody>
          <p className="text-sm text-fg-2">
            Você tem direito à íntegra do seu prontuário. Peça na clínica: a cópia é preparada,
            entregue com explicação e o pedido fica registrado — como a lei exige.
          </p>
        </CardBody>
      </Card>
    </div>
  )
}

function Linha({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-fg-3">{rotulo}</dt>
      <dd className="text-fg">{children}</dd>
    </>
  )
}
