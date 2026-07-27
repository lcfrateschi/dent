import { type Db, db } from '@/lib/db'
import {
  agendamento,
  clinica,
  mensagemWhatsapp,
  paciente,
  profissional,
  usuario,
} from '@/lib/db/schema'
import { REGRA_PADRAO, type RegraLembrete, quandoEnviarLembrete } from '@/lib/domain/lembrete'
import {
  TEMPLATE_LEMBRETE,
  chaveLembrete,
  parametrosLembrete,
  textoLembrete,
} from '@/lib/domain/textoMensagem'
import { ehCelular, paraE164 } from '@/lib/domain/whatsapp'
import { DA_CLINICA_ATUAL } from '@/lib/tenant/sql'
import { and, eq, gte, lt, lte, sql } from 'drizzle-orm'

/**
 * A fila: enfileirar, reivindicar, concluir.
 *
 * Nada aqui fala com a Meta — isso é `provedor/`. Este módulo só mexe em linhas,
 * e é o que dá para testar contra um Postgres de verdade sem credencial nenhuma.
 *
 * **Enfileirar é idempotente por construção.** `ON CONFLICT DO NOTHING` na
 * `chave_idempotencia`: rodar o job duas vezes no mesmo minuto insere zero
 * linhas na segunda. Não é "verifica antes de inserir" — esse padrão tem corrida
 * entre o SELECT e o INSERT, e duas execuções paralelas do job passariam as duas.
 */

export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

export interface ResultadoEnfileiramento {
  readonly enfileirada: boolean
  readonly id?: string
  /** Por que não enfileirou. Texto para a recepção ler, não código de erro. */
  readonly motivo?: string
}

/**
 * Enfileira o lembrete de um agendamento.
 *
 * Recusa (sem lançar) em quatro situações que não são erro de programa, são a
 * realidade: paciente sem WhatsApp, telefone que não é celular, atendimento
 * cancelado, e horário em que a mensagem não chega em tempo útil. Todas viram
 * `motivo` para aparecer na tela — mensagem não enviada precisa ser visível, não
 * silenciosa.
 */
export async function enfileirarLembrete(
  agendamentoId: string,
  agora: Date,
  opcoes: { readonly regra?: RegraLembrete; readonly executor?: Executor } = {},
): Promise<ResultadoEnfileiramento> {
  const regra = opcoes.regra ?? REGRA_PADRAO
  const ex = opcoes.executor ?? db

  const [linha] = await ex
    .select({
      id: agendamento.id,
      inicio: agendamento.inicio,
      status: agendamento.status,
      pacienteId: paciente.id,
      pacienteNome: paciente.nome,
      pacienteNomeSocial: paciente.nomeSocial,
      telefone: paciente.telefone,
      telefoneWhatsapp: paciente.telefoneWhatsapp,
      profissionalNome: usuario.nome,
    })
    .from(agendamento)
    .innerJoin(paciente, eq(paciente.id, agendamento.pacienteId))
    .innerJoin(profissional, eq(profissional.id, agendamento.profissionalId))
    .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
    .where(eq(agendamento.id, agendamentoId))
    .limit(1)

  if (!linha) return { enfileirada: false, motivo: 'Agendamento não encontrado.' }

  if (linha.status === 'cancelado' || linha.status === 'faltou') {
    return { enfileirada: false, motivo: `Agendamento está ${linha.status}.` }
  }

  const bruto = linha.telefoneWhatsapp ?? linha.telefone
  if (!bruto) {
    return { enfileirada: false, motivo: 'Paciente não tem telefone cadastrado.' }
  }
  if (!ehCelular(bruto)) {
    return {
      enfileirada: false,
      motivo: 'O telefone cadastrado não é celular — WhatsApp não chega em fixo.',
    }
  }

  const decisao = quandoEnviarLembrete(linha.inicio, agora, regra)
  if (!decisao.enviar) {
    return { enfileirada: false, motivo: motivoLegivel(decisao.motivo) }
  }

  const dados = {
    // Nome social tem precedência: é como a pessoa é chamada.
    pacienteNome: linha.pacienteNomeSocial ?? linha.pacienteNome,
    profissionalNome: linha.profissionalNome,
    clinicaNome: await nomeDaClinica(ex),
    inicio: linha.inicio,
    fuso: regra.fuso,
  }

  const inseridas = await ex
    .insert(mensagemWhatsapp)
    .values({
      pacienteId: linha.pacienteId,
      agendamentoId: linha.id,
      tipo: 'lembrete_consulta',
      chaveIdempotencia: chaveLembrete(linha.id, linha.inicio),
      destino: paraE164(bruto),
      corpo: textoLembrete(dados),
      template: TEMPLATE_LEMBRETE,
      parametros: parametrosLembrete(dados),
      agendadoPara: decisao.quando,
    })
    .onConflictDoNothing({ target: mensagemWhatsapp.chaveIdempotencia })
    .returning({ id: mensagemWhatsapp.id })

  const criada = inseridas[0]
  if (!criada) {
    return { enfileirada: false, motivo: 'Lembrete já havia sido enfileirado para este horário.' }
  }
  return { enfileirada: true, id: criada.id }
}

function motivoLegivel(motivo: string): string {
  switch (motivo) {
    case 'ja_passou':
      return 'O atendimento já passou.'
    case 'muito_proximo':
      return 'Falta pouco tempo para o atendimento — ligue para o paciente.'
    case 'sem_janela_util':
      return 'Não há horário permitido de envio que chegue em tempo — ligue para o paciente.'
    default:
      return motivo
  }
}

/** Nome fantasia se houver; é como o paciente conhece a clínica. */
async function nomeDaClinica(ex: Executor): Promise<string> {
  const [c] = await ex
    .select({ fantasia: clinica.nomeFantasia, razao: clinica.razaoSocial })
    .from(clinica)
    .where(DA_CLINICA_ATUAL)
  // O `?? 'sua clínica'` continua, e só para o nome fantasia ausente — que é
  // cadastro incompleto, não erro. O que saiu foi a possibilidade de mandar ao
  // paciente o nome de OUTRA clínica.
  if (!c) throw new Error('Clínica do contexto não encontrada ao montar a mensagem.')
  return c.fantasia ?? c.razao ?? 'sua clínica'
}

/**
 * Enfileira lembrete para todos os agendamentos de uma faixa.
 *
 * O job chama isto com uma janela generosa (por exemplo, os próximos 3 dias) e
 * confia na idempotência: quem já tem lembrete não ganha outro, e quem foi
 * remarcado ganha um novo porque a chave mudou.
 */
export async function enfileirarLembretesDoPeriodo(
  deIso: Date,
  ateIso: Date,
  agora: Date,
  regra: RegraLembrete = REGRA_PADRAO,
): Promise<{ readonly enfileiradas: number; readonly recusadas: readonly string[] }> {
  const alvos = await db
    .select({ id: agendamento.id })
    .from(agendamento)
    .where(
      and(
        gte(agendamento.inicio, deIso),
        lt(agendamento.inicio, ateIso),
        sql`${agendamento.status} in ('agendado','confirmado')`,
      ),
    )
    .orderBy(agendamento.inicio)

  let enfileiradas = 0
  const recusadas: string[] = []
  for (const a of alvos) {
    const r = await enfileirarLembrete(a.id, agora, { regra })
    if (r.enfileirada) enfileiradas++
    else if (r.motivo) recusadas.push(r.motivo)
  }
  return { enfileiradas, recusadas }
}

/**
 * Índice de string por causa de `db.execute`, que exige `Record<string, unknown>`
 * — o `returning` de SQL cru não tem tipo derivado do schema.
 */
export interface MensagemParaEnviar {
  readonly id: string
  readonly destino: string
  readonly corpo: string
  readonly template: string | null
  readonly parametros: unknown
  readonly tentativas: number
  readonly [coluna: string]: unknown
}

/**
 * Reivindica até `limite` mensagens vencidas para envio.
 *
 * `FOR UPDATE SKIP LOCKED` é o que permite mais de um worker: cada um pega
 * linhas diferentes em vez de esperar o outro. E a transição para `enviando`
 * acontece na mesma instrução — quem reivindicou tem posse exclusiva, então dois
 * workers não podem mandar a mesma mensagem.
 */
export async function reivindicarMensagens(
  agora: Date,
  limite = 20,
): Promise<readonly MensagemParaEnviar[]> {
  const resultado = await db.execute<MensagemParaEnviar>(sql`
    with alvo as (
      select "id" from "mensagem_whatsapp"
       where "situacao" = 'pendente'
         and "agendado_para" <= ${agora.toISOString()}::timestamptz
       order by "agendado_para"
       for update skip locked
       limit ${limite}
    )
    update "mensagem_whatsapp" m
       set "situacao" = 'enviando',
           "reivindicado_em" = now(),
           "tentativas" = m."tentativas" + 1
      from alvo
     where m."id" = alvo."id"
    returning m."id", m."destino", m."corpo", m."template", m."parametros", m."tentativas"
  `)

  return (Array.isArray(resultado) ? resultado : resultado.rows) as MensagemParaEnviar[]
}

/** Marca como enviada. `enviado_em` é imutável daqui para frente (trigger). */
export async function marcarEnviada(
  id: string,
  provedor: 'meta' | 'simulado',
  idExterno: string,
): Promise<void> {
  await db
    .update(mensagemWhatsapp)
    .set({ situacao: 'enviada', enviadoEm: new Date(), provedor, idExterno })
    .where(and(eq(mensagemWhatsapp.id, id), eq(mensagemWhatsapp.situacao, 'enviando')))
}

/**
 * Marca como falhada, com o erro visível.
 *
 * Não devolve para `pendente`: ver a trigger de transição em
 * drizzle/0009_mensageria_travas.sql. Reenvio é decisão humana, porque a Meta
 * pode ter entregue antes de a nossa chamada falhar.
 */
export async function marcarFalha(
  id: string,
  codigo: string,
  mensagem: string,
): Promise<void> {
  await db
    .update(mensagemWhatsapp)
    .set({
      situacao: 'falhou',
      falhouEm: new Date(),
      erroCodigo: codigo,
      erroMensagem: mensagem.slice(0, 500),
    })
    .where(and(eq(mensagemWhatsapp.id, id), eq(mensagemWhatsapp.situacao, 'enviando')))
}

/** Cancela lembretes pendentes de um agendamento — usado ao cancelar/remarcar. */
export async function cancelarPendentesDoAgendamento(
  agendamentoId: string,
  executor?: Executor,
): Promise<number> {
  const ex = executor ?? db
  const linhas = await ex
    .update(mensagemWhatsapp)
    .set({ situacao: 'cancelada' })
    .where(
      and(
        eq(mensagemWhatsapp.agendamentoId, agendamentoId),
        eq(mensagemWhatsapp.situacao, 'pendente'),
      ),
    )
    .returning({ id: mensagemWhatsapp.id })
  return linhas.length
}

/**
 * Mensagens travadas em `enviando` há mais que `minutos`.
 *
 * Esta lista é a razão de `enviando` não voltar para a fila sozinho: alguém
 * precisa olhar e decidir, e para decidir precisa ver.
 */
export async function mensagensTravadas(agora: Date, minutos = 15) {
  const limite = new Date(agora.getTime() - minutos * 60_000)
  return db
    .select({
      id: mensagemWhatsapp.id,
      destino: mensagemWhatsapp.destino,
      reivindicadoEm: mensagemWhatsapp.reivindicadoEm,
      tentativas: mensagemWhatsapp.tentativas,
      pacienteNome: paciente.nome,
    })
    .from(mensagemWhatsapp)
    .innerJoin(paciente, eq(paciente.id, mensagemWhatsapp.pacienteId))
    .where(
      and(
        eq(mensagemWhatsapp.situacao, 'enviando'),
        lte(mensagemWhatsapp.reivindicadoEm, limite),
      ),
    )
    .orderBy(mensagemWhatsapp.reivindicadoEm)
}
