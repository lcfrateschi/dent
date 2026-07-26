import { comparaData } from './datas'
import type { Perfil } from '@/lib/authz/politicas'

/**
 * Regras de administração: usuários, perfis e tabela negociada de convênio.
 *
 * Três coisas aqui merecem ser lidas antes de mexer, porque todas já causaram
 * incidente em sistemas parecidos:
 *
 * 1. **Não se pode ficar sem administrador.** Desativar o último admin ativo, ou
 *    rebaixá-lo de perfil, tranca a clínica fora do próprio sistema — e a saída
 *    passa a ser `UPDATE` no banco por quem tiver acesso ao servidor. É o mesmo
 *    raciocínio do bloqueio de login do paciente nunca ser permanente: a trava
 *    que não tem saída pela porta da frente vira negação de serviço.
 *
 * 2. **Dentista sem `profissional` não trabalha.** Evolução, execução e comissão
 *    exigem `profissional_id`. Um usuário de perfil `dentista` sem a linha de
 *    profissional entra no sistema, vê o prontuário e **não consegue assinar
 *    nada** — falha silenciosa que aparece na frente do paciente.
 *
 * 3. **Preço de convênio não se corrige por cima.** O valor faturado é o da DATA
 *    DA EXECUÇÃO (decisão fechada, ver CLAUDE.md). Editar uma vigência passada
 *    reescreve o que já foi apresentado à operadora. Reajuste é vigência nova,
 *    fechando a anterior no dia anterior.
 */

// ── Usuários e perfis ─────────────────────────────────────────────────────────

export type Resultado =
  | { readonly ok: true }
  | { readonly ok: false; readonly motivo: string }

export interface EstadoDoUsuario {
  readonly id: string
  readonly perfil: Perfil
  readonly ativo: boolean
  readonly temProfissional: boolean
}

/** Quantos admins ativos existem, contando só quem pode de fato entrar. */
export function adminsAtivos(usuarios: readonly EstadoDoUsuario[]): number {
  return usuarios.filter((u) => u.perfil === 'admin' && u.ativo).length
}

/**
 * Pode desativar este usuário?
 *
 * Duas recusas, e as duas são sobre não se trancar fora:
 * o último admin ativo, e você mesmo. A segunda é menos óbvia e mais frequente:
 * o admin que se desativa por engano no meio do cadastro fica sem sessão no
 * próximo clique.
 */
export function podeDesativarUsuario(
  alvo: EstadoDoUsuario,
  todos: readonly EstadoDoUsuario[],
  atorId: string,
): Resultado {
  if (!alvo.ativo) return { ok: false, motivo: 'Este usuário já está inativo.' }

  if (alvo.id === atorId) {
    return {
      ok: false,
      motivo:
        'Você não pode desativar o seu próprio acesso. Peça a outro administrador — ' +
        'assim sempre há alguém logado para desfazer um erro.',
    }
  }

  if (alvo.perfil === 'admin' && adminsAtivos(todos) <= 1) {
    return {
      ok: false,
      motivo:
        'Este é o único administrador ativo. Desativá-lo trancaria a clínica fora do ' +
        'sistema — crie ou reative outro administrador antes.',
    }
  }

  return { ok: true }
}

/**
 * Pode trocar o perfil?
 *
 * Rebaixar o último admin tem o mesmo efeito de desativá-lo, então tem a mesma
 * recusa. Trocar o **próprio** perfil também é recusado: quem se rebaixa perde,
 * no mesmo instante, a permissão de se promover de volta.
 */
export function podeTrocarPerfil(
  alvo: EstadoDoUsuario,
  novoPerfil: Perfil,
  todos: readonly EstadoDoUsuario[],
  atorId: string,
): Resultado {
  if (alvo.perfil === novoPerfil) return { ok: true }

  if (alvo.id === atorId) {
    return {
      ok: false,
      motivo:
        'Você não pode mudar o seu próprio perfil. Ao sair de administrador você perderia, ' +
        'no mesmo clique, a permissão de voltar.',
    }
  }

  if (alvo.perfil === 'admin' && novoPerfil !== 'admin' && adminsAtivos(todos) <= 1) {
    return {
      ok: false,
      motivo: 'Este é o único administrador ativo. Promova outro antes de rebaixá-lo.',
    }
  }

  // Dentista que deixa de ser dentista mantém a linha de `profissional` para o
  // histórico: evolução assinada e comissão apurada apontam para ela. O que se
  // faz é desativar o profissional, nunca apagá-lo.
  return { ok: true }
}

/**
 * O que o perfil exige de cadastro complementar.
 *
 * `dentista` exige CRO e percentual de comissão; os outros perfis não têm CRO
 * nenhum, e oferecer o campo convida a inventar um.
 */
export function exigeProfissional(perfil: Perfil): boolean {
  return perfil === 'dentista'
}

export interface DadosDeProfissional {
  readonly cro: string
  readonly ufCro: string
  readonly comissaoPct: string
}

/**
 * Valida o cadastro de dentista.
 *
 * A UF do CRO é gravada em MAIÚSCULA porque ela sai impressa na folha de
 * conferência do convênio, e a recepção digita aquilo no portal da operadora —
 * onde "sp" é recusado. Já custou uma correção na Fase 13.
 */
export function validarProfissional(dados: DadosDeProfissional): Resultado {
  const cro = dados.cro.trim()
  if (cro.length < 2) return { ok: false, motivo: 'Informe o número do CRO.' }
  if (!/^[0-9A-Za-z.\-/ ]+$/.test(cro)) {
    return { ok: false, motivo: 'CRO com caracteres inválidos.' }
  }
  if (!/^[A-Za-z]{2}$/.test(dados.ufCro.trim())) {
    return { ok: false, motivo: 'UF do CRO deve ter duas letras (ex.: SP).' }
  }
  const pct = Number(dados.comissaoPct)
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return { ok: false, motivo: 'Comissão deve ser um percentual entre 0 e 100.' }
  }
  return { ok: true }
}

export function normalizarProfissional(dados: DadosDeProfissional): DadosDeProfissional {
  return {
    cro: dados.cro.trim(),
    ufCro: dados.ufCro.trim().toUpperCase(),
    comissaoPct: Number(dados.comissaoPct).toFixed(2),
  }
}

/** Normaliza e-mail para o realm de staff. O índice único é sobre `lower(email)`. */
export function normalizarEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function emailEhPlausivel(email: string): boolean {
  const e = normalizarEmail(email)
  /**
   * Deliberadamente frouxo, e **sem exigir ponto no domínio**.
   *
   * A versão anterior pedia `algo.algo` depois da arroba e recusava
   * `ana@clinica` — endereço válido em rede interna — e recusava também
   * `admin@local`, que é a convenção do próprio seed deste projeto. Descoberto na
   * primeira execução de `npm run admin:verificar`.
   *
   * O que importa é não gravar espaço, não gravar endereço sem arroba e não
   * estourar o limite do protocolo. Validar e-mail por regex estrita recusa
   * endereço legítimo, e o custo do falso negativo aqui é a clínica não
   * conseguir cadastrar o próprio funcionário.
   */
  return /^[^\s@]+@[^\s@]+$/.test(e) && e.length <= 254
}

// ── Tabela negociada ──────────────────────────────────────────────────────────

export interface VigenciaDePreco {
  readonly id?: string
  readonly vigenciaInicio: string
  readonly vigenciaFim: string | null
}

/**
 * Onde entra uma vigência nova na linha do tempo de um procedimento.
 *
 * Devolve o que fazer com a anterior. O caso normal do reajuste é: a vigência
 * aberta que existe hoje **fecha no dia anterior** ao início da nova. Isso é
 * automático de propósito — pedir que a pessoa digite as duas datas é pedir para
 * ficar um dia sem preço (ou com dois preços válidos, que é pior: aí
 * `precoVigenteEm` fica ambíguo e o valor faturado depende da ordem da consulta).
 */
export type EncaixeDeVigencia =
  | {
      readonly ok: true
      /** Vigência aberta que precisa ser fechada, e em que dia. */
      readonly fechar?: { readonly id: string; readonly em: string }
    }
  | { readonly ok: false; readonly motivo: string }

export function encaixarVigencia(
  existentes: readonly VigenciaDePreco[],
  nova: VigenciaDePreco,
): EncaixeDeVigencia {
  if (nova.vigenciaFim !== null && comparaData(nova.vigenciaFim, nova.vigenciaInicio) < 0) {
    return { ok: false, motivo: 'O fim da vigência não pode ser antes do início.' }
  }

  const fimNova = nova.vigenciaFim
  const conflitantes = existentes.filter((e) => e.id !== nova.id && seSobrepõem(e, nova))

  // Sobreposição com vigência JÁ FECHADA é erro de digitação: não há o que
  // ajustar sozinho, porque fechar de novo mudaria um período histórico.
  const fechadaEmConflito = conflitantes.find((c) => c.vigenciaFim !== null)
  if (fechadaEmConflito) {
    return {
      ok: false,
      motivo:
        `Já existe preço vigente de ${fechadaEmConflito.vigenciaInicio} a ` +
        `${fechadaEmConflito.vigenciaFim} nesse intervalo. Dois preços válidos no mesmo dia ` +
        'tornariam indefinido o valor a faturar.',
    }
  }

  const aberta = conflitantes.find((c) => c.vigenciaFim === null)
  if (!aberta) return { ok: true }

  if (comparaData(aberta.vigenciaInicio, nova.vigenciaInicio) >= 0) {
    return {
      ok: false,
      motivo:
        `Já existe preço a partir de ${aberta.vigenciaInicio}, que é igual ou posterior ao ` +
        'início informado. Um reajuste precisa começar depois do preço que ele substitui.',
    }
  }

  if (fimNova !== null) {
    // A nova fecha antes; deixar a anterior aberta criaria dois preços válidos
    // depois do fim da nova. Isso é caso de duas operações, não de adivinhação.
    return {
      ok: false,
      motivo:
        'Preço com data de fim não pode ser inserido no meio de uma vigência aberta. ' +
        'Feche a vigência atual e depois cadastre o período.',
    }
  }

  return { ok: true, fechar: { id: aberta.id!, em: diaAnterior(nova.vigenciaInicio) } }
}

function seSobrepõem(a: VigenciaDePreco, b: VigenciaDePreco): boolean {
  const fimA = a.vigenciaFim ?? '9999-12-31'
  const fimB = b.vigenciaFim ?? '9999-12-31'
  return comparaData(a.vigenciaInicio, fimB) <= 0 && comparaData(b.vigenciaInicio, fimA) <= 0
}

/** Dia civil anterior, sem `Date`: a vigência é dia da clínica, não instante. */
export function diaAnterior(iso: string): string {
  const [ano, mes, dia] = iso.split('-').map(Number)
  if (!ano || !mes || !dia) return iso
  if (dia > 1) return `${ano}-${String(mes).padStart(2, '0')}-${String(dia - 1).padStart(2, '0')}`
  const mesAnterior = mes === 1 ? 12 : mes - 1
  const anoAnterior = mes === 1 ? ano - 1 : ano
  const ultimoDia = new Date(Date.UTC(anoAnterior, mesAnterior, 0)).getUTCDate()
  return `${anoAnterior}-${String(mesAnterior).padStart(2, '0')}-${String(ultimoDia).padStart(2, '0')}`
}

// ── Cadeiras ──────────────────────────────────────────────────────────────────

export interface EstadoDaCadeira {
  readonly id: string
  readonly nome: string
  readonly ativo: boolean
  /** Agendamentos futuros nesta cadeira. */
  readonly agendamentosFuturos: number
}

/**
 * Pode desativar a cadeira?
 *
 * Não, se houver agendamento futuro nela: o horário existe, o paciente foi
 * avisado, e a cadeira desaparecer da grade deixa o atendimento órfão sem que
 * ninguém veja. Remarcar primeiro é uma decisão da recepção, não do sistema.
 */
export function podeDesativarCadeira(
  cadeira: EstadoDaCadeira,
  todas: readonly EstadoDaCadeira[],
): Resultado {
  if (!cadeira.ativo) return { ok: false, motivo: 'Esta cadeira já está inativa.' }

  if (cadeira.agendamentosFuturos > 0) {
    return {
      ok: false,
      motivo:
        `Há ${cadeira.agendamentosFuturos} agendamento(s) futuro(s) nesta cadeira. ` +
        'Remarque-os antes: cadeira inativa sai da grade e o horário ficaria sem lugar.',
    }
  }

  if (todas.filter((c) => c.ativo).length <= 1) {
    return {
      ok: false,
      motivo: 'É a única cadeira ativa. Sem nenhuma cadeira não há como agendar.',
    }
  }

  return { ok: true }
}
