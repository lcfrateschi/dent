import { randomUUID } from 'node:crypto'
import { gerarHashSenha } from '@/lib/auth/senha'
import { db, pool } from '@/lib/db'
import {
  agendamento,
  anamnese,
  consentimento,
  listaEspera,
  paciente,
  procedimento,
  profissional,
  regraAutoatendimento,
  usuario,
} from '@/lib/db/schema'
import { clinicaParaScript } from '@/lib/demo/clinicaDaDemo'
import { desligarTriggersDeAplicacao, religarTriggersDeAplicacao } from '@/lib/demo/triggers'
import {
  NIVEL_ASSINATURA,
  REGRA_PADRAO,
  avaliarPedido,
  idadeEmAnos,
  janelaDeDias,
  podeDesmarcarSozinho,
  quemAssina,
} from '@/lib/domain/autoatendimento'
import { horariosLivres } from '@/lib/agenda/consultas'
import { comContextoDeClinica } from '@/lib/tenant/contexto'
import { and, eq, sql } from 'drizzle-orm'

/**
 * Fase 19 contra o Postgres: o autoatendimento conferido por NÚMERO.
 *
 *   npm run autoatendimento:demo
 *
 * Confere número, não fluxo — no molde dos outros `demonstrar.ts`. O que ele mede é o
 * que só aparece com banco de verdade:
 *
 *   • a grade do paciente é a MESMA que a recepção vê (reuso, não reimplementação);
 *   • um agendamento do portal ocupa o horário de fato, e o segundo é recusado pelo
 *     Postgres — não por um `if` nosso;
 *   • a anamnese do portal entra como versão nova e nasce SEM conferência;
 *   • ⚖️ a assinatura eletrônica grava o rastro completo, e o menor não assina;
 *   • a lista de espera não aceita o segundo pedido igual.
 *
 * ⚠️ Roda como DONO das tabelas (a limpeza precisa de `DISABLE TRIGGER`), e **dono não
 * tem política de RLS filtrando por ele**. Por isso toda consulta aqui filtra
 * `clinica_id` explicitamente — três vezes neste projeto isso foi esquecido, e quem
 * avisou foi o FK composto.
 */

let falhas = 0

function titulo(t: string): void {
  console.log(`\n\x1b[36m${t}\x1b[0m`)
}

function conferir(ok: boolean, texto: string): void {
  if (ok) console.log(`   \x1b[32m✓\x1b[0m ${texto}`)
  else {
    console.log(`   \x1b[31m✗ ${texto}\x1b[0m`)
    falhas++
  }
}

const SENHA = 'Autoatendimento-Demo-2026'
const MARCA = `AUT-${Date.now()}`

interface Fixture {
  readonly clinicaId: string
  readonly usuarioId: string
  readonly profissionalId: string
  readonly adultoId: string
  readonly menorId: string
  readonly maeId: string
  readonly procLiberadoId: string
  readonly procTravadoId: string
}

async function montar(clinicaId: string): Promise<Fixture> {
  // Ids antes do INSERT: o dentista precisa de `usuario` e `profissional` na MESMA
  // transação (trava deferida da `0021`), e a mãe precisa existir antes do menor.
  const idUsuario = randomUUID()
  const idProf = randomUUID()

  await db.transaction(async (tx) => {
    await tx.insert(usuario).values({
      id: idUsuario,
      nome: `[${MARCA}] Dra. Autoatendimento`,
      email: `${MARCA.toLowerCase()}@demo.local`,
      senhaHash: await gerarHashSenha(SENHA),
      perfil: 'dentista',
    })
    await tx
      .insert(profissional)
      .values({ id: idProf, usuarioId: idUsuario, cro: MARCA.slice(-6), ufCro: 'SP' })
  })

  const [mae] = await db
    .insert(paciente)
    .values({ nome: `[${MARCA}] Mãe`, dataNascimento: '1985-04-10' })
    .returning({ id: paciente.id })

  const [adulto] = await db
    .insert(paciente)
    .values({ nome: `[${MARCA}] Adulto`, dataNascimento: '1990-06-15' })
    .returning({ id: paciente.id })

  // Menor de idade com responsável legal: 10 anos, para a maioridade não chegar
  // durante a vida deste script.
  const [menor] = await db
    .insert(paciente)
    .values({
      nome: `[${MARCA}] Menor`,
      dataNascimento: '2016-03-20',
      responsavelLegalId: mae!.id,
    })
    .returning({ id: paciente.id })

  const [liberado] = await db
    .insert(procedimento)
    .values({
      codigo: `${MARCA}-LIB`,
      nome: `[${MARCA}] Consulta de avaliação`,
      valorParticular: '180.00',
      duracaoMinutos: 30,
      permiteAutoagendamento: true,
    })
    .returning({ id: procedimento.id })

  const [travado] = await db
    .insert(procedimento)
    .values({
      codigo: `${MARCA}-TRV`,
      nome: `[${MARCA}] Exodontia de terceiro molar`,
      valorParticular: '900.00',
      duracaoMinutos: 80,
      // Falso: é o padrão, e é o ponto. Ninguém marca isto pelo celular.
      permiteAutoagendamento: false,
    })
    .returning({ id: procedimento.id })

  // A clínica liga o autoatendimento. Sem isto, tudo abaixo seria recusado por
  // 'desligado' — e o script provaria apenas que o interruptor funciona.
  await db
    .insert(regraAutoatendimento)
    .values({ clinicaId, ativo: true, termoDeAtendimento: 'Termo de atendimento — demonstração.' })
    .onConflictDoUpdate({
      target: regraAutoatendimento.clinicaId,
      set: { ativo: true, termoDeAtendimento: 'Termo de atendimento — demonstração.' },
    })

  return {
    clinicaId,
    usuarioId: idUsuario,
    profissionalId: idProf,
    adultoId: adulto!.id,
    menorId: menor!.id,
    maeId: mae!.id,
    procLiberadoId: liberado!.id,
    procTravadoId: travado!.id,
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('autoatendimento:demo cria pessoas fictícias. Não roda em produção.')
  }

  const clinicaId = await clinicaParaScript()
  console.log('\n═══ Fase 19: autoatendimento do paciente ═══')

  const f = await montar(clinicaId)

  try {
    // ── 1. A grade ────────────────────────────────────────────────────────────
    titulo('1. A grade do paciente é a MESMA da recepção')

    // Um dia bem dentro da janela: depois da antecedência mínima, antes da máxima.
    const dia = new Date(Date.now() + 10 * 86_400_000)
    // Segunda-feira garantida, para não cair em dia sem funcionamento.
    while (dia.getUTCDay() !== 1) dia.setUTCDate(dia.getUTCDate() + 1)
    const diaIso = dia.toISOString().slice(0, 10)

    const livres = await horariosLivres({
      diaIso,
      profissionalId: f.profissionalId,
      duracaoMin: 30,
    })
    conferir(livres.length > 0, `${livres.length} horário(s) livre(s) em ${diaIso}`)

    // A garantia de não-vazamento: o retorno só tem hora/início/fim. Se um dia alguém
    // acrescentar `ocupadoPor` para a tela da recepção, este caso quebra — e é isso
    // que se quer, porque a mesma função alimenta o portal.
    const campos = Object.keys(livres[0] ?? {}).sort()
    conferir(
      JSON.stringify(campos) === JSON.stringify(['fim', 'hora', 'inicio']),
      `a grade devolve só ${campos.join(', ')} — nada sobre quem ocupa os tomados`,
    )

    // ── 2. A regra decide, e o Postgres executa ───────────────────────────────
    titulo('2. Marcar: a regra decide, o banco garante')

    const escolhido = livres[0]!
    const regra = { ...REGRA_PADRAO, ativo: true }

    conferir(
      avaliarPedido({
        inicio: escolhido.inicio,
        agora: new Date(),
        procedimentoLiberado: true,
        futurosDoPaciente: 0,
        regra,
      }) === null,
      'a regra aceita o horário escolhido da grade',
    )

    conferir(
      avaliarPedido({
        inicio: escolhido.inicio,
        agora: new Date(),
        procedimentoLiberado: false,
        futurosDoPaciente: 0,
        regra,
      })?.motivo === 'procedimento_nao_liberado',
      'procedimento não liberado é recusado antes de tocar o banco',
    )

    const [marcado] = await db
      .insert(agendamento)
      .values({
        pacienteId: f.adultoId,
        profissionalId: f.profissionalId,
        inicio: escolhido.inicio,
        fim: escolhido.fim,
        origem: 'portal',
      })
      .returning({ id: agendamento.id })
    conferir(marcado !== undefined, 'agendamento gravado com origem = portal')

    const [conta] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agendamento)
      .where(
        and(
          eq(agendamento.clinicaId, f.clinicaId),
          eq(agendamento.pacienteId, f.adultoId),
          eq(agendamento.origem, 'portal'),
        ),
      )
    conferir(conta?.n === 1, `1 agendamento de origem portal para este paciente (${conta?.n})`)

    // O horário saiu da grade — a prova de que o autoatendimento ocupa de verdade e
    // não vive numa tabela paralela a reconciliar depois.
    const depois = await horariosLivres({
      diaIso,
      profissionalId: f.profissionalId,
      duracaoMin: 30,
    })
    /**
     * Quantos horários somem, exatamente.
     *
     * A primeira versão afirmava `depois.length === livres.length - 1` e reprovou: a
     * grade caiu de 34 para 32. O motivo não é bug — é que o passo da agenda é 15 min
     * e o atendimento dura 30, então o candidato das 11:15 também deixa de caber.
     *
     * A asserção passou a medir a propriedade de verdade — **todo candidato que
     * sobrepõe o intervalo marcado desaparece** — em vez de um número que só valeria
     * se passo e duração coincidissem. Contar 1 era chutar a configuração da clínica.
     */
    const sobrepostos = livres.filter(
      (h) => h.inicio < escolhido.fim && h.fim > escolhido.inicio,
    ).length
    conferir(
      depois.length === livres.length - sobrepostos,
      `a grade caiu de ${livres.length} para ${depois.length}: saíram os ${sobrepostos} candidatos que sobrepõem ${escolhido.hora}`,
    )
    conferir(
      !depois.some((h) => h.hora === escolhido.hora),
      `o horário ${escolhido.hora} não é mais oferecido`,
    )

    // ── 3. Quem chega depois é recusado pelo POSTGRES ─────────────────────────
    titulo('3. Dois pacientes, o mesmo minuto')

    let recusadoPelaExclude = false
    let mensagem = ''
    try {
      await db.insert(agendamento).values({
        pacienteId: f.menorId,
        profissionalId: f.profissionalId,
        inicio: escolhido.inicio,
        fim: escolhido.fim,
        origem: 'portal',
      })
    } catch (e) {
      recusadoPelaExclude = true
      mensagem = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : ''
    }
    conferir(recusadoPelaExclude, `o segundo foi recusado: ${mensagem.slice(0, 70)}`)
    // Recusado pela trava certa: se fosse por FK ou por NOT NULL, o caso passaria
    // provando outra coisa. Sétima vez que esta distinção importa neste projeto.
    conferir(
      /sobreposi|exclusion|conflicting key/i.test(mensagem),
      'e recusado pela EXCLUDE constraint de sobreposição, não por outra trava',
    )

    // ── 4. Desmarcar o que o paciente marcou ──────────────────────────────────
    titulo('4. Desmarcar: só o que veio do portal, e só antes da hora')

    conferir(
      podeDesmarcarSozinho({
        origem: 'portal',
        status: 'agendado',
        inicio: escolhido.inicio,
        agora: new Date(),
        regra,
      }),
      'o que o paciente marcou, ele desmarca',
    )
    conferir(
      !podeDesmarcarSozinho({
        origem: 'recepcao',
        status: 'agendado',
        inicio: escolhido.inicio,
        agora: new Date(),
        regra,
      }),
      'o que a recepção deu, ele NÃO desmarca — vale a decisão fechada',
    )

    await db
      .update(agendamento)
      // `motivoCancelamento` e `canceladoEm`, não `motivo`: o CHECK
      // `agendamento_cancelado_tem_motivo` cobra a coluna certa, e foi assim que o bug
      // da ação de produção apareceu.
      .set({
        status: 'cancelado',
        motivoCancelamento: 'Desmarcado pelo paciente: demonstração',
        canceladoEm: new Date(),
      })
      .where(and(eq(agendamento.id, marcado!.id), eq(agendamento.clinicaId, f.clinicaId)))

    const voltou = await horariosLivres({
      diaIso,
      profissionalId: f.profissionalId,
      duracaoMin: 30,
    })
    conferir(
      voltou.length === livres.length,
      `desmarcado, a grade voltou a ${voltou.length} horário(s) — o horário não fica preso`,
    )

    // ── 5. Anamnese autodeclarada ─────────────────────────────────────────────
    titulo('5. Anamnese do portal: versão nova, sem conferência')

    const [a1] = await db
      .insert(anamnese)
      .values({
        pacienteId: f.adultoId,
        profissionalId: f.profissionalId,
        versao: 1,
        respostas: { hipertenso: false },
        versaoFormulario: 'v1',
        origem: 'clinica',
      })
      .returning({ id: anamnese.id })

    const [a2] = await db
      .insert(anamnese)
      .values({
        pacienteId: f.adultoId,
        versao: 2,
        respostas: { hipertenso: true, alergia: 'penicilina' },
        versaoFormulario: 'v1',
        origem: 'portal',
      })
      .returning({ id: anamnese.id })

    const versoes = await db
      .select({ versao: anamnese.versao, origem: anamnese.origem, conferida: anamnese.conferidaEm })
      .from(anamnese)
      .where(and(eq(anamnese.clinicaId, f.clinicaId), eq(anamnese.pacienteId, f.adultoId)))
      .orderBy(anamnese.versao)

    conferir(versoes.length === 2, `2 versões coexistem — a do portal não sobrescreveu (${versoes.length})`)
    conferir(versoes[0]?.origem === 'clinica' && versoes[1]?.origem === 'portal', 'origens registradas')
    conferir(
      versoes[1]?.conferida === null,
      'a do portal nasce SEM conferência — alergia autodeclarada não é decisão de anestésico',
    )

    await db
      .update(anamnese)
      .set({ conferidaEm: new Date(), conferidaPorId: f.profissionalId })
      .where(and(eq(anamnese.id, a2!.id), eq(anamnese.clinicaId, f.clinicaId)))

    const [conferida] = await db
      .select({ em: anamnese.conferidaEm, por: anamnese.conferidaPorId })
      .from(anamnese)
      .where(and(eq(anamnese.id, a2!.id), eq(anamnese.clinicaId, f.clinicaId)))
    conferir(
      conferida?.em !== null && conferida?.por === f.profissionalId,
      'depois de conferida, a linha diz QUEM conferiu',
    )
    void a1

    // ── 6. ⚖️ Assinatura eletrônica simples ───────────────────────────────────
    titulo('6. ⚖️ Assinatura: rastro completo, e o menor não assina')

    const hoje = new Date().toISOString().slice(0, 10)
    conferir(idadeEmAnos('2016-03-20', hoje) < 18, 'o menor da fixture é menor de idade hoje')

    let menorBloqueado = false
    try {
      quemAssina({
        pacienteId: f.menorId,
        responsavelLegalId: f.maeId,
        ehMenor: true,
        sessaoPacienteId: f.menorId,
      })
    } catch {
      menorBloqueado = true
    }
    conferir(menorBloqueado, 'o menor não assina o próprio termo, nem com sessão própria')

    const pelaMae = quemAssina({
      pacienteId: f.menorId,
      responsavelLegalId: f.maeId,
      ehMenor: true,
      sessaoPacienteId: f.maeId,
    })
    conferir(
      pelaMae.pacienteId === f.menorId && pelaMae.assinadoPorId === f.maeId,
      'a responsável assina PELO menor, e a linha guarda os dois lados',
    )

    const [assinatura] = await db
      .insert(consentimento)
      .values({
        pacienteId: pelaMae.pacienteId,
        baseLegal: 'consentimento',
        finalidade: 'termo_de_atendimento',
        versaoTermo: 'v1',
        textoHash: 'a'.repeat(64),
        assinadoPorId: pelaMae.assinadoPorId,
        nivelAssinatura: NIVEL_ASSINATURA,
        ip: '203.0.113.7',
        userAgent: 'autoatendimento:demo',
      })
      .returning({ id: consentimento.id })

    const [gravada] = await db
      .select({
        nivel: consentimento.nivelAssinatura,
        ip: consentimento.ip,
        ua: consentimento.userAgent,
        assinadoPor: consentimento.assinadoPorId,
      })
      .from(consentimento)
      .where(and(eq(consentimento.id, assinatura!.id), eq(consentimento.clinicaId, f.clinicaId)))

    conferir(gravada?.nivel === 'eletronica_simples', `nível gravado NA LINHA: ${gravada?.nivel}`)
    conferir(
      gravada?.ip !== null && gravada?.ua !== null,
      'com IP e user_agent — sem rastro, o CHECK recusaria',
    )
    conferir(gravada?.assinadoPor === f.maeId, 'e diz quem assinou pelo menor')

    // ── 7. Lista de espera ────────────────────────────────────────────────────
    titulo('7. Lista de espera: um pedido ativo por par')

    await db.insert(listaEspera).values({
      pacienteId: f.adultoId,
      validoAte: new Date(Date.now() + 30 * 86_400_000),
    })

    let segundoRecusado = false
    try {
      await db.insert(listaEspera).values({
        pacienteId: f.adultoId,
        validoAte: new Date(Date.now() + 30 * 86_400_000),
      })
    } catch {
      segundoRecusado = true
    }
    conferir(
      segundoRecusado,
      'segundo pedido SEM procedimento é recusado — `NULL` colide, por causa do coalesce',
    )

    await db.insert(listaEspera).values({
      pacienteId: f.adultoId,
      procedimentoId: f.procLiberadoId,
      validoAte: new Date(Date.now() + 30 * 86_400_000),
    })
    const [naFila] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(listaEspera)
      .where(and(eq(listaEspera.clinicaId, f.clinicaId), eq(listaEspera.pacienteId, f.adultoId)))
    conferir(naFila?.n === 2, `procedimento diferente é outro pedido: ${naFila?.n} na fila`)

    // ── 8. A janela da regra bate com o que a grade oferece ───────────────────
    titulo('8. A grade não oferece o que a regra recusa')

    const { de, ate } = janelaDeDias(regra, new Date())
    const foraDaJanela = await horariosLivres({
      diaIso: new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10),
      profissionalId: f.profissionalId,
      duracaoMin: 30,
    })
    const ofertaveis = foraDaJanela.filter((h) => h.inicio >= de && h.inicio <= ate)
    conferir(
      ofertaveis.length === 0,
      `hoje tem ${foraDaJanela.length} horário(s) livre(s) e ${ofertaveis.length} ofertável(is) — a antecedência mínima corta`,
    )
  } finally {
    await limpar(f)
  }
}

/**
 * Limpeza.
 *
 * `DISABLE TRIGGER USER` e **não** `session_replication_role = 'replica'`: o atalho
 * desliga também as triggers de FK, já produziu 5 linhas órfãs e derrubou uma
 * migration. O helper religa **conferindo** — `DISABLE TRIGGER` é DDL, e comitar com
 * ela desligada a deixa desligada para sempre.
 */
async function limpar(f: Fixture): Promise<void> {
  /**
   * Cliente cru do pool, e não `db.transaction`: os helpers de trigger recebem uma
   * conexão `pg` porque fazem `ALTER TABLE`, não consulta do ORM. É como os outros
   * `demonstrar.ts` fazem, e o contexto de clínica vem da acquisição do pool
   * (`lib/db/index.ts`), então a RLS continua valendo aqui.
   */
  const c = await db.$client.connect()
  try {
    await c.query('begin')
    const desligadas = await desligarTriggersDeAplicacao(c)

    const pacientes = [f.adultoId, f.menorId, f.maeId]
    await c.query('delete from lista_espera where paciente_id = any($1::uuid[])', [pacientes])
    await c.query('delete from anamnese where paciente_id = any($1::uuid[])', [pacientes])
    await c.query('delete from consentimento where paciente_id = any($1::uuid[])', [pacientes])
    await c.query('delete from agendamento where paciente_id = any($1::uuid[])', [pacientes])
    // O menor ANTES da mãe: `responsavel_legal_id` é FK entre pacientes.
    await c.query('delete from paciente where id = any($1::uuid[])', [[f.adultoId, f.menorId]])
    await c.query('delete from paciente where id = $1', [f.maeId])
    await c.query('delete from procedimento where id = any($1::uuid[])', [
      [f.procLiberadoId, f.procTravadoId],
    ])
    // Profissional e usuário juntos, na mesma transação: a trava deferida da `0021`
    // cobra no commit que dentista ativo tenha cadastro — apagar `profissional`
    // sozinho dispara, e a lição já apareceu na criação E na exclusão.
    await c.query('delete from profissional where id = $1', [f.profissionalId])
    await c.query('delete from usuario where id = $1', [f.usuarioId])

    /**
     * A configuração volta a DESLIGADA.
     *
     * O script ligou o autoatendimento para poder medir. Deixar ligado mudaria o
     * comportamento do portal para quem for testar depois — e essa pessoa não teria
     * como saber que foi um script de demonstração que abriu a agenda dela.
     */
    await c.query(
      'update regra_autoatendimento set ativo = false, termo_de_atendimento = null where clinica_id = $1',
      [f.clinicaId],
    )

    // ANTES do commit, sempre. `religar` confere que religou.
    await religarTriggersDeAplicacao(c, desligadas)
    await c.query('commit')
    console.log('\nDados removidos (e o autoatendimento voltou a DESLIGADO).')
  } catch (e) {
    await c.query('rollback')
    throw e
  } finally {
    c.release()
  }
}

clinicaParaScript()
  .then((c) => comContextoDeClinica(c, main))
  .then(async () => {
    await pool.end()
    console.log(
      falhas === 0
        ? '\n\x1b[32m═══ Autoatendimento verificado contra o Postgres ═══\x1b[0m\n'
        : `\n\x1b[31m${falhas} falha(s).\x1b[0m\n`,
    )
    process.exit(falhas > 0 ? 1 : 0)
  })
  .catch(async (e) => {
    console.error(e)
    await pool.end()
    process.exit(1)
  })
