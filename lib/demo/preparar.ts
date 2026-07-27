import { gerarHashSenha } from '@/lib/auth/senha'
import { gerarSegredoTotp, uriOtpauth } from '@/lib/auth/totp'
import { db, pool } from '@/lib/db'
import {
  agendamento,
  cadeira,
  clinica,
  cobranca,
  consentimento,
  convenio,
  execucao,
  evolucao,
  itemPlano,
  loteMaterial,
  material,
  movimentoEstoque,
  paciente,
  pacienteConta,
  pacienteConvenio,
  parcela,
  planoTratamento,
  precoConvenio,
  procedimento,
  profissional,
  usuario,
} from '@/lib/db/schema'
import { addDias } from '@/lib/domain/datas'
import { instanteDe } from '@/lib/domain/fuso'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import { comContextoDeClinica } from '@/lib/tenant/contexto'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { Client } from 'pg'
import { seedMateriais } from '@/lib/db/seed/materiais'
import { seedProcedimentos } from '@/lib/db/seed/procedimentos'
import { seedRegrasRetorno } from '@/lib/db/seed/regrasRetorno'
import { exigirClinicaDaDemo, idDaClinicaDaDemo } from './clinicaDaDemo'
import { garantirAssinatura } from '@/lib/onboarding/assinaturaPadrao'
import { comClinica } from '@/lib/tenant/executar'
import { desligarTriggersDeAplicacao, religarTriggersDeAplicacao } from './triggers'
import { mensagemDoBanco } from '@/lib/db/mensagemDoBanco'
import { povoarFases18a21 } from './povoar'
import { gerarTodasAsTarefas } from '@/lib/relacionamento/geradores'

/**
 * Prepara um ambiente de TESTE com dados realistas e credenciais conhecidas.
 *
 *   npm run demo:preparar     # cria tudo e imprime as credenciais
 *   npm run demo:limpar       # remove tudo o que este script criou
 *
 * ── Para que serve ──────────────────────────────────────────────────────────
 * Passear pelo sistema inteiro sem ter de cadastrar 40 coisas antes de ver a
 * primeira tela interessante. Cada dado aqui existe para que uma tela tenha o que
 * mostrar: um lote vencendo para o alerta de validade, uma parcela vencida para a
 * inadimplência, uma falta no mês passado para a taxa de comparecimento.
 *
 * ── O que ele NÃO é ─────────────────────────────────────────────────────────
 * Não é seed. O `db:seed` traz dados de referência (dentes, catálogo, materiais)
 * e **não inventa gente**. Este script inventa gente, e por isso:
 *
 *   • recusa rodar com `NODE_ENV=production`;
 *   • marca tudo com `@demo.local` no e-mail e `[DEMO]` no nome, para que
 *     `demo:limpar` saiba exatamente o que remover;
 *   • imprime senhas no terminal — o que é aceitável para dado inventado e
 *     inaceitável para dado real. É a razão de as duas coisas estarem separadas.
 *
 * ── MFA ─────────────────────────────────────────────────────────────────────
 * Os usuários nascem com o segundo fator JÁ configurado, e o script imprime o
 * segredo de cada um. Sem isso, cada login exigiria escanear um QR antes de ver
 * qualquer coisa. Em produção nada disso acontece: o segredo é gerado no
 * `/configurar-mfa` e ninguém — nem o admin — consegue lê-lo.
 */

const MARCA = '[DEMO]'
const DOMINIO = '@demo.local'

/** Senhas de teste: longas o bastante para a política, fáceis de digitar. */
const SENHAS = {
  admin: 'Facilident-Admin-2026',
  dentista: 'Facilident-Dentista-2026',
  recepcao: 'Facilident-Recepcao-2026',
  financeiro: 'Facilident-Financeiro-2026',
  paciente: 'Paciente-Portal-2026',
} as const

function titulo(t: string): void {
  console.log(`\n\x1b[36m${t}\x1b[0m`)
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'demo:preparar não roda em produção. Ele cria pessoas fictícias e imprime senhas.',
    )
  }

  console.log('\n═══ Preparando ambiente de teste do Facilident ═══')

  // ── 1. A clínica ───────────────────────────────────────────────────────────
  // Sem isso o orçamento sai sem cabeçalho e o atestado sem CRO.
  //
  // Ela vem ANTES de tudo e devolve o id porque **é o tenant do resto do
  // script**. Antes, `main()` inteiro contava com o atalho de "existe uma clínica
  // só": o `lib/db/index.ts` preenchia `app.clinica_id` a partir da única linha da
  // tabela. Num banco que já tinha a clínica do `db:seed`, este script criava a
  // segunda e o atalho passava a estourar com "more than one row returned by a
  // subquery" — o fail-closed funcionando, e o script morrendo na seção 2.
  //
  // Um script de linha de comando declara o próprio contexto. Ele não é uma
  // requisição HTTP com sessão, então não há de onde herdar.
  titulo('1. Configuração da clínica')
  /**
   * A clínica da demonstração é identificada pelo CNPJ, não por `id = 1`.
   *
   * `clinica` virou o tenant e o id é uuid gerado — um `ON CONFLICT (id)` nunca
   * mais colide, e rodar `demo:preparar` duas vezes criaria uma segunda clínica
   * Sorriso Vivo com os mesmos pacientes dentro. O CNPJ tem índice único parcial
   * (`clinica_cnpj_uk`), e é a chave natural certa aqui. O `WHERE` repetindo o
   * predicado do índice é exigência do Postgres para índice parcial — sem ele o
   * erro é "no unique or exclusion constraint matching the ON CONFLICT
   * specification", que não diz a palavra "parcial".
   *
   * ── Por que um cliente `pg` cru, e não o `db` do projeto ──────────────────
   * Porque criar clínica é a única operação do sistema que acontece SEM tenant —
   * é o onboarding, e não existe clínica ainda para pôr no contexto.
   *
   * O `db` (`lib/db/index.ts`) define `app.clinica_id` em toda acquisição de
   * conexão e, sem contexto de sessão, cai na subconsulta escalar
   * `(select id from clinica)`. Com DUAS clínicas no banco ela estoura de
   * propósito — "more than one row returned by a subquery" —, o que é o
   * fail-closed correto para uma consulta de dado de paciente e é uma parede para
   * esta linha aqui: num banco que já tem a clínica do `db:seed`, o `demo:preparar`
   * não conseguia nem LER a tabela `clinica`, muito menos inserir nela.
   *
   * Então esta única instrução usa conexão própria, sem o envelope. Tudo o que vem
   * depois volta para o `db`, dentro de `comContextoDeClinica`.
   *
   * ⚠️ Isto é contorno de script de demonstração, não desenho. O onboarding de
   * verdade precisa de um caminho declarado "sem tenant" em `lib/db/index.ts` —
   * está anotado no relatório da Fase 17.
   */
  const conexaoDeOnboarding = new Client({ connectionString: process.env.DATABASE_URL })
  await conexaoDeOnboarding.connect()
  let clinicaDaDemo: string
  try {
    const r = await conexaoDeOnboarding.query<{ id: string }>(
      `insert into clinica (
         razao_social, nome_fantasia, cnpj, cro_responsavel, uf_cro_responsavel,
         telefone, email, cep, logradouro, numero, bairro, cidade, uf)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (cnpj) where cnpj is not null do update set
         razao_social = excluded.razao_social,
         nome_fantasia = excluded.nome_fantasia,
         cro_responsavel = excluded.cro_responsavel,
         uf_cro_responsavel = excluded.uf_cro_responsavel,
         telefone = excluded.telefone,
         email = excluded.email,
         cep = excluded.cep,
         logradouro = excluded.logradouro,
         numero = excluded.numero,
         bairro = excluded.bairro,
         cidade = excluded.cidade,
         uf = excluded.uf
       returning id`,
      [
        'Clínica Odontológica Sorriso Vivo Ltda',
        'Sorriso Vivo',
        '11222333000181',
        '54321',
        'SP',
        '1133334444',
        'contato@sorrisovivo.demo.local',
        '01310100',
        'Avenida Paulista',
        '1000',
        'Bela Vista',
        'São Paulo',
        'SP',
      ],
    )
    const linha = r.rows[0]
    if (!linha) throw new Error('o upsert da clínica não devolveu id')
    clinicaDaDemo = linha.id
  } finally {
    await conexaoDeOnboarding.end()
  }
  console.log('   Sorriso Vivo · CNPJ 11.222.333/0001-81 · CRO-SP 54321')

  // Daqui para baixo, todo `db.*` roda com esta clínica no contexto — é o
  // AsyncLocalStorage de `lib/tenant/contexto.ts` que `lib/db/index.ts` lê ao pegar
  // conexão. Nenhuma das ~200 escritas abaixo precisou aprender o que é tenant.
  await comContextoDeClinica(clinicaDaDemo, () => prepararDados())
}

async function prepararDados(): Promise<void> {
  // Contrato da clínica de demonstração. A `drizzle/0027` só dá assinatura às
  // clínicas que existiam quando ela rodou; num banco recriado, esta nasce depois.
  // Sem isto o caso 19 de `verificar-assinatura.sql` reprova — e ele é a única
  // coisa que enxerga clínica sem contrato, já que a escrita destrava por decisão.
  await comClinica(await exigirClinicaDaDemo(), (tx) => garantirAssinatura(tx))

  const hoje = await hojeDaClinica()

  // ── 1b. O catálogo DA CLÍNICA ──────────────────────────────────────────────
  /**
   * Sem isto, o `demo:preparar` montava um plano de tratamento cujos `item_plano`
   * apontavam para `procedimento` de OUTRA clínica.
   *
   * O erro era silencioso e fácil de cometer: as consultas abaixo procuram
   * procedimento por código (`DENT-001`) e cadeira pelas duas primeiras linhas,
   * presumindo que `npm run db:seed` já as criou. E ele criou — **para a clínica
   * dele**. Na 0022 o catálogo virou por clínica (valor particular, `requer_dente`
   * e ficha técnica são decisão de cada uma), então a clínica da demonstração
   * nascia com zero procedimentos e ia buscar os do vizinho. Medido: 4 itens de
   * plano cruzando clínica.
   *
   * Enquanto o FK olhava só `procedimento_id`, isso entrava e ninguém via. Com o FK
   * composto `(procedimento_id, clinica_id)` da `drizzle/0023`, passa a ser
   * recusado — o banco vira o revisor.
   *
   * A correção certa não é afrouxar o FK nem apontar para o catálogo alheio: é a
   * clínica ter o próprio catálogo, que é o que o onboarding faz. Os mesmos
   * `seedProcedimentos`/`seedMateriais` do `db:seed`, rodando no contexto desta
   * clínica — o `clinica_id` sai do DEFAULT.
   */
  const qtdProcs = await seedProcedimentos(db)
  const qtdMats = await seedMateriais(db)
  const cadeirasDaDemo = await db
    .insert(cadeira)
    .values([
      { nome: 'Consultório 1', ordem: 1 },
      { nome: 'Consultório 2', ordem: 2 },
    ])
    .onConflictDoUpdate({
      target: [cadeira.clinicaId, cadeira.nome],
      set: { ordem: sql`excluded.ordem` },
    })
    .returning({ id: cadeira.id })
  /**
   * As regras de retorno, pelo mesmo motivo do catálogo: elas apontam para
   * `procedimento` desta clínica, e o `db:seed` as criou para a clínica DELE.
   * Sem isto a fila de retorno programado fica silenciosa aqui — e silêncio numa
   * fila parece funcionalidade quebrada, não configuração ausente.
   */
  const regras = await seedRegrasRetorno(db)
  console.log(
    `   catálogo próprio: ${qtdProcs} procedimentos, ${qtdMats.materiais} materiais, 2 cadeiras, ${regras.criadas} regras de retorno`,
  )

  // ── 2. Equipe ──────────────────────────────────────────────────────────────
  titulo('2. Equipe (um usuário por perfil, com MFA já configurado)')

  const segredos: Record<string, { email: string; senha: string; segredo: string; perfil: string }> = {}

  async function criarStaff(
    chave: keyof typeof SENHAS,
    nome: string,
    perfil: 'admin' | 'dentista' | 'recepcao' | 'financeiro',
    dadosProfissional?: { cro: string; ufCro: string; comissaoPct: string; especialidade?: string },
  ): Promise<{ usuarioId: string; profissionalId: string | null }> {
    const email = `${perfil}${DOMINIO}`
    const segredo = gerarSegredoTotp()
    const senha = SENHAS[chave]

    // Usuário e profissional na MESMA transação: a trava deferida de
    // `drizzle/0021` cobra no commit que dentista ativo tenha cadastro de
    // profissional.
    const ids = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(usuario)
        .values({
          nome: `${MARCA} ${nome}`,
          email,
          senhaHash: await gerarHashSenha(senha),
          perfil,
          mfaSecret: segredo,
          mfaAtivo: true,
          senhaTemporaria: false,
        })
        .returning({ id: usuario.id })

      let profissionalId: string | null = null
      if (dadosProfissional) {
        const [p] = await tx
          .insert(profissional)
          .values({ usuarioId: u!.id, ...dadosProfissional })
          .returning({ id: profissional.id })
        profissionalId = p!.id
      }
      return { usuarioId: u!.id, profissionalId }
    })

    segredos[chave] = { email, senha, segredo, perfil }
    console.log(`   ${perfil.padEnd(11)} ${email}`)
    return ids
  }

  const admin = await criarStaff('admin', 'Administradora Alice', 'admin')
  const dentista = await criarStaff('dentista', 'Dra. Débora Dias', 'dentista', {
    cro: '12345',
    ufCro: 'SP',
    comissaoPct: '40',
    especialidade: 'Clínica geral e endodontia',
  })
  const recepcao = await criarStaff('recepcao', 'Recepcionista Rita', 'recepcao')
  const financeiro = await criarStaff('financeiro', 'Financeiro Fábio', 'financeiro')

  // ── 3. Cadeiras ────────────────────────────────────────────────────────────
  /**
   * A cadeira vem do `returning` do upsert acima, não de uma leitura nova.
   *
   * Aqui estava `db.select().from(cadeira).limit(2)` — sem filtro e sem ordem. Num
   * banco com duas clínicas ela devolvia "duas cadeiras quaisquer", e como a clínica
   * do `db:seed` também tem 'Consultório 1' e 'Consultório 2' e nasceu antes, o
   * script marcava **7 agendamentos na cadeira da outra clínica**. Medido, não
   * suposto.
   *
   * É a mesma família das dez leituras `.from(clinica).limit(1)` que a Fase 17
   * corrigiu na aplicação: `LIMIT` sem `ORDER BY` e sem `WHERE` não é uma consulta,
   * é um sorteio. Usar o que acabei de inserir dispensa filtro, ordem e sorte.
   */
  const cadeiraA = cadeirasDaDemo[0]?.id
  if (!cadeiraA) throw new Error('o upsert das cadeiras não devolveu id')

  // ── 4. Pacientes ───────────────────────────────────────────────────────────
  titulo('3. Pacientes')

  const [pacAna] = await db
    .insert(paciente)
    .values({
      nome: `${MARCA} Ana Souza Lima`,
      dataNascimento: '1988-04-12',
      cpf: '11144477735',
      telefone: '11987654321',
      email: `ana${DOMINIO}`,
      sexo: 'feminino',
      cep: '04532000',
      logradouro: 'Rua Tabapuã',
      numero: '500',
      cidade: 'São Paulo',
      uf: 'SP',
    })
    .returning({ id: paciente.id })

  const [pacBruno] = await db
    .insert(paciente)
    .values({
      nome: `${MARCA} Bruno Carvalho`,
      dataNascimento: '1975-09-30',
      cpf: '52998224725',
      telefone: '11912345678',
      sexo: 'masculino',
    })
    .returning({ id: paciente.id })

  // Menor de idade, com a mãe como responsável legal: consentimento e assinatura
  // são do responsável (ver GLOSSARIO).
  const [pacPedro] = await db
    .insert(paciente)
    .values({
      nome: `${MARCA} Pedro Souza Lima`,
      dataNascimento: addDias(hoje, -8 * 365),
      responsavelLegalId: pacAna!.id,
      sexo: 'masculino',
    })
    .returning({ id: paciente.id })

  console.log(`   Ana Souza Lima      adulta, com convênio e conta no portal`)
  console.log(`   Bruno Carvalho      adulto, particular, com parcela vencida`)
  console.log(`   Pedro Souza Lima    8 anos, responsável = Ana (dentição mista)`)

  // Consentimento de WhatsApp para a Ana: sem ele, a trigger recusa qualquer
  // mensagem na fila.
  await db.insert(consentimento).values({
    pacienteId: pacAna!.id,
    baseLegal: 'consentimento',
    finalidade: 'contato_whatsapp',
    versaoTermo: '1.0',
    textoHash: 'a'.repeat(64),
    aceitoEm: new Date(),
    ip: '127.0.0.1',
  })

  // ── 5. Convênio e carteirinha ──────────────────────────────────────────────
  titulo('4. Convênio com tabela negociada')
  const [conv] = await db
    .insert(convenio)
    .values({
      nome: `${MARCA} Odonto Prev Demo`,
      registroAns: '412345',
      cnpj: '11444777000161',
      prazoPagamentoDias: 30,
      diaFechamento: 25,
      contatoNome: 'Central do prestador',
      contatoTelefone: '1140041234',
    })
    .returning({ id: convenio.id })

  const procs = await db
    .select({ id: procedimento.id, codigo: procedimento.codigo, nome: procedimento.nome })
    .from(procedimento)
    .where(
      and(
        /**
         * O filtro de clínica é OBRIGATÓRIO aqui, e a ausência dele foi um bug de
         * verdade — a TERCEIRA ocorrência da mesma armadilha, dentro do script que a
         * documenta duas seções acima.
         *
         * `procedimento.codigo` é único POR CLÍNICA desde a `drizzle/0022`. Num banco
         * com várias (a do seed, a da demonstração, as sobras de teste), esta consulta
         * trazia o mesmo código de todas, e o `Map` guardava **o último que aparecesse**
         * — de uma clínica qualquer. O `preco_convenio` resultante ligava operadora
         * desta clínica a procedimento de outra, e o FK composto da `drizzle/0023`
         * recusava:
         *
         *   preco_convenio_procedimento_id_procedimento_id_fk
         *
         * Funcionava num banco com duas clínicas por sorte da ordenação, e falhava em
         * um com cinco. Rodar como DONO piora: não há RLS filtrando por você.
         */
        sql`${procedimento.clinicaId} = app_clinica_id()`,
        or(
          eq(procedimento.codigo, 'CONS-001'),
          eq(procedimento.codigo, 'DENT-001'),
          eq(procedimento.codigo, 'DENT-002'),
          eq(procedimento.codigo, 'PREV-001'),
          eq(procedimento.codigo, 'ENDO-001'),
          eq(procedimento.codigo, 'CIR-001'),
        ),
      ),
    )
  const porCodigo = new Map(procs.map((p) => [p.codigo, p]))

  // Duas vigências para o mesmo procedimento: é o que prova que o valor faturado
  // é o da DATA DA EXECUÇÃO, não o de hoje.
  await db.insert(precoConvenio).values([
    {
      convenioId: conv!.id,
      procedimentoId: porCodigo.get('CONS-001')!.id,
      valor: '45.00',
      coberturaPct: '100',
      vigenciaInicio: '2025-01-01',
      vigenciaFim: addDias(hoje, -1),
    },
    {
      convenioId: conv!.id,
      procedimentoId: porCodigo.get('CONS-001')!.id,
      valor: '52.00',
      coberturaPct: '100',
      vigenciaInicio: hoje,
    },
    {
      convenioId: conv!.id,
      procedimentoId: porCodigo.get('DENT-001')!.id,
      valor: '120.00',
      coberturaPct: '70',
      carenciaDias: 90,
      vigenciaInicio: '2025-01-01',
    },
    {
      convenioId: conv!.id,
      procedimentoId: porCodigo.get('PREV-001')!.id,
      valor: '80.00',
      coberturaPct: '100',
      vigenciaInicio: '2025-01-01',
    },
  ])

  await db.insert(pacienteConvenio).values({
    pacienteId: pacAna!.id,
    convenioId: conv!.id,
    numeroCarteirinha: '9988776655',
    plano: 'Odonto Prev Master',
    ehTitular: true,
    adesaoEm: '2025-03-01',
  })
  console.log('   Odonto Prev Demo · 4 preços (um com reajuste hoje) · Ana é titular')

  // ── 6. Agenda ──────────────────────────────────────────────────────────────
  titulo('5. Agenda')
  const agendamentos = [
    { paciente: pacAna!.id, hora: '09:00', fim: '10:00', status: 'confirmado' as const, dia: hoje },
    { paciente: pacBruno!.id, hora: '10:30', fim: '11:15', status: 'agendado' as const, dia: hoje },
    { paciente: pacPedro!.id, hora: '14:00', fim: '14:45', status: 'agendado' as const, dia: hoje },
    { paciente: pacAna!.id, hora: '09:00', fim: '10:00', status: 'agendado' as const, dia: addDias(hoje, 3) },
    { paciente: pacBruno!.id, hora: '11:00', fim: '11:45', status: 'concluido' as const, dia: addDias(hoje, -20) },
    { paciente: pacBruno!.id, hora: '15:00', fim: '15:45', status: 'faltou' as const, dia: addDias(hoje, -13) },
    { paciente: pacAna!.id, hora: '16:00', fim: '16:45', status: 'concluido' as const, dia: addDias(hoje, -6) },
  ]
  for (const a of agendamentos) {
    await db.insert(agendamento).values({
      pacienteId: a.paciente,
      profissionalId: dentista.profissionalId!,
      cadeiraId: cadeiraA,
      inicio: instanteDe(a.dia, a.hora),
      fim: instanteDe(a.dia, a.fim),
      status: a.status,
      origem: 'recepcao',
    })
  }
  console.log(`   ${agendamentos.length} agendamentos: 3 hoje, 1 futuro, 3 no passado (1 falta)`)

  // ── 7. Plano de tratamento ─────────────────────────────────────────────────
  titulo('6. Plano de tratamento, execução e prontuário')
  const [plano] = await db
    .insert(planoTratamento)
    .values({
      pacienteId: pacAna!.id,
      profissionalId: dentista.profissionalId!,
      status: 'ativo',
      titulo: `${MARCA} Plano inicial da Ana`,
    })
    .returning({ id: planoTratamento.id })

  // Um item já executado (gera evolução e permite testar a baixa de estoque),
  // dois aprovados e um proposto — para exercitar a máquina de estados.
  const [itemExecutado] = await db
    .insert(itemPlano)
    .values({
      planoId: plano!.id,
      procedimentoId: porCodigo.get('DENT-001')!.id,
      valor: '230.00',
      denteFdi: 36,
      faces: ['oclusal'],
      status: 'executado',
      aprovadoEm: instanteDe(addDias(hoje, -6), '15:00'),
    })
    .returning({ id: itemPlano.id })

  // O `returning` aqui não é estilo: a ordem de laboratório da Fase 21 precisa de um
  // `item_plano` aprovado, e o FK é composto `(item_plano_id, clinica_id)` — ir buscar
  // depois "um item aprovado qualquer" traria o de outra clínica num banco com várias,
  // que é o erro que o FK composto passou a recusar.
  const itensAprovados = await db.insert(itemPlano).values([
    {
      planoId: plano!.id,
      procedimentoId: porCodigo.get('DENT-002')!.id,
      valor: '300.00',
      denteFdi: 46,
      faces: ['oclusal', 'mesial'],
      status: 'aprovado',
      aprovadoEm: instanteDe(addDias(hoje, -6), '15:00'),
    },
    {
      planoId: plano!.id,
      procedimentoId: porCodigo.get('ENDO-001')!.id,
      valor: '850.00',
      denteFdi: 24,
      status: 'aprovado',
      aprovadoEm: instanteDe(addDias(hoje, -6), '15:00'),
    },
    {
      planoId: plano!.id,
      procedimentoId: porCodigo.get('CIR-001')!.id,
      valor: '350.00',
      denteFdi: 18,
      status: 'proposto',
    },
  ]).returning({ id: itemPlano.id, status: itemPlano.status })

  const [exec] = await db
    .insert(execucao)
    .values({
      itemPlanoId: itemExecutado!.id,
      profissionalId: dentista.profissionalId!,
      executadoEm: instanteDe(addDias(hoje, -6), '16:10'),
      observacao: 'Restauração em resina, dente 36, face oclusal.',
    })
    .returning({ id: execucao.id })

  // Evolução ASSINADA: o teste interessante é tentar editá-la depois.
  await db.insert(evolucao).values({
    pacienteId: pacAna!.id,
    profissionalId: dentista.profissionalId!,
    texto:
      'Paciente compareceu para restauração do 36. Anestesia infiltrativa com lidocaína 2%. ' +
      'Remoção de tecido cariado, isolamento relativo, restauração em resina composta A2. ' +
      'Ajuste oclusal e polimento. Orientada sobre higiene interproximal.',
    assinadoEm: instanteDe(addDias(hoje, -6), '16:40'),
    assinaturaHash: 'b'.repeat(64),
  })
  console.log('   Plano com 4 itens (1 executado, 2 aprovados, 1 proposto) + evolução assinada')

  // ── 8. Financeiro ──────────────────────────────────────────────────────────
  titulo('7. Financeiro')
  // Cobrança do Bruno com uma parcela VENCIDA — é o que faz a inadimplência
  // aparecer na tela sem esperar o mês passar.
  // Cobrança e parcelas na MESMA transação: a soma das parcelas tem de ser igual
  // ao total, e isso é constraint DEFERIDA (drizzle/0001). Inserir a cobrança
  // sozinha comita uma cobrança sem parcela — que o banco recusa, e com razão.
  await db.transaction(async (tx) => {
    const [cob] = await tx
      .insert(cobranca)
      .values({
        pacienteId: pacBruno!.id,
        valorTotal: '900.00',
        forma: 'credito',
        qtdParcelas: 3,
        observacao: `${MARCA} tratamento do Bruno`,
      })
      .returning({ id: cobranca.id })

    await tx.insert(parcela).values([
      { cobrancaId: cob!.id, numero: 1, vencimento: addDias(hoje, -35), valor: '300.00', status: 'paga' },
      { cobrancaId: cob!.id, numero: 2, vencimento: addDias(hoje, -5), valor: '300.00', status: 'aberta' },
      { cobrancaId: cob!.id, numero: 3, vencimento: addDias(hoje, 25), valor: '300.00', status: 'aberta' },
    ])
  })
  console.log('   Cobrança de R$ 900 em 3× — 1 paga, 1 VENCIDA há 5 dias, 1 a vencer')

  // ── 9. Estoque ─────────────────────────────────────────────────────────────
  titulo('8. Estoque')
  const materiais = await db
    .select({ id: material.id, codigo: material.codigo, nome: material.nome, unidade: material.unidade })
    .from(material)
    // Filtro de clínica pelo mesmo motivo do catálogo de procedimentos, logo acima:
    // `material.codigo` é único POR CLÍNICA, e sem isto o `Map` guarda o material de
    // outra — que o FK composto de `lote_material` recusa. Foi a quarta ocorrência.
    .where(
      and(
        sql`${material.clinicaId} = app_clinica_id()`,
        inArray(material.codigo, [
          'BIO-001',
          'ANE-001',
          'ANE-004',
          'RES-001',
          'RES-003',
          'RES-004',
          'BIO-002',
          'BIO-003',
          'BIO-004',
          'BIO-005',
          'RES-006',
          'END-001',
          'IMP-001',
        ]),
      ),
    )
  const mat = new Map(materiais.map((m) => [m.codigo, m]))

  async function entrada(
    codigo: string,
    quantidade: string,
    custo: string,
    opcoes?: { validade?: string | null; lote?: string; recebidoEm?: string },
  ): Promise<string> {
    const m = mat.get(codigo)
    if (!m) throw new Error(`material ${codigo} não existe no seed`)
    const [l] = await db
      .insert(loteMaterial)
      .values({
        materialId: m.id,
        codigoFabricante: opcoes?.lote ?? `L-${codigo}-${Math.floor(Number(quantidade))}`,
        validade: opcoes?.validade ?? addDias(hoje, 540),
        custoUnitario: custo,
        fornecedor: 'Dental Distribuidora Demo',
        notaFiscal: 'NF-2026-0417',
        recebidoEm: opcoes?.recebidoEm ?? addDias(hoje, -30),
      })
      .returning({ id: loteMaterial.id })
    await db.insert(movimentoEstoque).values({
      loteId: l!.id,
      materialId: m.id,
      tipo: 'entrada',
      quantidade,
      custoUnitario: custo,
    })
    return l!.id
  }

  // Estoque saudável para a maioria dos insumos da ficha técnica.
  await entrada('BIO-001', '300', '1.10')
  await entrada('BIO-002', '200', '0.55')
  await entrada('BIO-003', '150', '0.40')
  await entrada('BIO-004', '200', '0.35')
  await entrada('BIO-005', '400', '0.08')
  await entrada('ANE-001', '150', '3.20')
  await entrada('ANE-004', '200', '0.60')
  await entrada('RES-003', '8', '95.00')
  await entrada('RES-004', '6', '38.00')
  await entrada('RES-006', '100', '0.25')
  await entrada('END-001', '4', '210.00')

  // Dois lotes de resina A2: um que vence em 20 dias e um de validade longa.
  // É o caso do FEFO — o lote CURTO tem de sair primeiro, mesmo tendo chegado
  // depois.
  await entrada('RES-001', '4', '180.00', {
    validade: addDias(hoje, 400),
    lote: 'RES-LONGO',
    recebidoEm: addDias(hoje, -90),
  })
  await entrada('RES-001', '3', '195.00', {
    validade: addDias(hoje, 20),
    lote: 'RES-CURTO-VENCE-EM-20',
    recebidoEm: addDias(hoje, -5),
  })

  // Um lote JÁ VENCIDO com saldo: o sistema recusa consumi-lo e a tela pede
  // descarte.
  await entrada('BIO-006' in Object.fromEntries(mat) ? 'BIO-006' : 'BIO-005', '30', '0.09', {
    validade: addDias(hoje, -12),
    lote: 'LOTE-VENCIDO',
    recebidoEm: addDias(hoje, -400),
  })

  // Implante com rastreabilidade obrigatória, saldo baixo (mínimo 2).
  await entrada('IMP-001', '1', '890.00', { lote: 'TI-2026-A45', validade: addDias(hoje, 900) })

  console.log('   14 lotes: 1 vencendo em 20 dias, 1 já vencido, implante abaixo do mínimo')
  console.log('   RES-001 tem dois lotes — o que vence primeiro chegou depois (FEFO)')

  // ── 10. Portal do paciente ─────────────────────────────────────────────────
  titulo('9. Conta no portal (Ana)')
  await db.insert(pacienteConta).values({
    pacienteId: pacAna!.id,
    email: `ana${DOMINIO}`,
    senhaHash: await gerarHashSenha(SENHAS.paciente),
    senhaDefinidaEm: new Date(),
    ativo: true,
  })
  console.log(`   ana${DOMINIO} — entra direto, sem convite`)

  // ── 10. Fases 18 a 21 ──────────────────────────────────────────────────────
  /**
   * As nove seções acima foram escritas antes das Fases 18 a 21, e por isso as telas
   * novas abriam VAZIAS — periograma, laboratório, esterilização, despesas, fluxo de
   * caixa, lista de espera, propostas alternativas e as filas de relacionamento.
   *
   * Estado vazio bem feito é uma coisa boa, e várias dessas telas têm um. Mas ele não
   * deixa ninguém **avaliar** a tela, e é exatamente onde o projeto está: nenhuma das 20
   * telas foi vista por uma pessoa.
   */
  titulo('10. Fases 18 a 21 (periograma, laboratório, esterilização, caixa, filas)')
  const itemAprovado = itensAprovados.find((i) => i.status === 'aprovado')
  if (!itemAprovado) throw new Error('nenhum item de plano aprovado: a ordem de laboratório precisa de um')

  const povoado = await povoarFases18a21({
    hoje,
    pacienteAnaId: pacAna!.id,
    pacienteBrunoId: pacBruno!.id,
    pacientePedroId: pacPedro!.id,
    profissionalId: dentista.profissionalId!,
    usuarioDentistaId: dentista.usuarioId,
    usuarioFinanceiroId: financeiro.usuarioId,
    planoDaAnaId: plano!.id,
    itemAprovadoId: itemAprovado.id,
    cadeiraId: cadeiraA,
  })
  for (const [tabela, n] of Object.entries(povoado.linhas)) {
    console.log(`   ${tabela.padEnd(26)} ${n}`)
  }

  /**
   * As cinco filas de relacionamento nascem de GERADORES, não de INSERT à mão — e isso
   * é deliberado: inserir a tarefa direto criaria linha que nenhum gerador reconhece
   * como sua, e o próximo `whatsapp:despachar` a duplicaria. A chave de idempotência é
   * por FATO, então rodar os geradores sobre o dado que acabou de nascer produz
   * exatamente o que a produção produziria.
   */
  const filas = await gerarTodasAsTarefas()
  const totalFilas = filas.reduce((soma, f) => soma + f.criadas, 0)
  console.log(`   ${'tarefa_relacionamento'.padEnd(26)} ${totalFilas} (${filas.map((f) => `${f.tipo}:${f.criadas}`).join(' ')})`)

  console.log('\n   \x1b[33m⚠ Os valores são DE PARTIDA e vários são arbitrários:\x1b[0m')
  for (const a of povoado.arbitrarios) console.log(`     • ${a}`)

  // ── Credenciais ────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(74)}`)
  console.log('  CREDENCIAIS DO AMBIENTE DE TESTE')
  console.log('═'.repeat(74))
  console.log('\n  Equipe — http://localhost:3000/entrar')
  for (const [chave, d] of Object.entries(segredos)) {
    console.log(`\n  ${d.perfil.toUpperCase()}`)
    console.log(`    e-mail:  ${d.email}`)
    console.log(`    senha:   ${d.senha}`)
    console.log(`    MFA:     ${d.segredo}`)
    console.log(`    QR/URI:  ${uriOtpauth({ segredoBase32: d.segredo, email: d.email })}`)
    void chave
  }
  console.log('\n  Paciente — http://localhost:3000/meu/entrar')
  console.log(`    e-mail:  ana${DOMINIO}`)
  console.log(`    senha:   ${SENHAS.paciente}`)
  console.log('\n' + '═'.repeat(74))
  console.log('  O código de 6 dígitos sai do seu autenticador (Google Authenticator,')
  console.log('  1Password, Authy…) — adicione o segredo acima. Sem app à mão:')
  console.log('      npm run demo:codigo')
  console.log('  imprime o código atual de cada usuário de demonstração.')
  console.log('═'.repeat(74))
  console.log('\n  Para remover tudo isto:  npm run demo:limpar\n')
}

async function limpar(): Promise<void> {
  console.log('\nRemovendo dados de demonstração…')

  /**
   * `pool.connect()` também passa pelo envelope de `lib/db/index.ts`, então com
   * duas clínicas no banco esta linha estourava antes de apagar nada. O contexto da
   * clínica da demonstração resolve — e restringe: os `delete` abaixo filtram por
   * `[DEMO]%` e `@demo.local`, e agora só alcançam a clínica da demonstração.
   *
   * Se ela não existe, não há o que limpar.
   */
  const clinicaDemo = await idDaClinicaDaDemo()
  if (!clinicaDemo) {
    console.log('  nada a remover: a clínica de demonstração não existe neste banco.\n')
    return
  }
  await comContextoDeClinica(clinicaDemo, () => limparDados())
}

async function limparDados(): Promise<void> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    // Desliga só as triggers de APLICAÇÃO — as de FK ficam de pé. O
    // `session_replication_role` que estava aqui desligava as duas, e já deixou
    // 5 linhas órfãs em movimento_estoque, o que derrubou a 0023. Ver
    // lib/demo/triggers.ts.
    const tabelasDesligadas = await desligarTriggersDeAplicacao(c)

    /**
     * ── Fases 18 a 21, do mais dependente para o menos ─────────────────────────
     *
     * Isto vem ANTES dos pacientes, porque quase tudo aqui aponta para eles. E vem
     * junto num bloco identificado, porque a regra do script é que `demo:limpar`
     * remova **tudo** o que o `demo:preparar` cria: dado de demonstração que a limpeza
     * não alcança transforma o banco de desenvolvimento em lixo acumulado, e isso já
     * aconteceu aqui com clínicas de teste que não se apagam (`ON DELETE RESTRICT`).
     *
     * O filtro é o mesmo dos outros: `[DEMO]%` no nome e `@demo.local` no e-mail,
     * dentro do contexto da clínica da demonstração.
     */
    const pacientesDemo = `select id from paciente where nome like '[DEMO]%'`

    // Relacionamento: contato aponta para tarefa.
    await c.query(`delete from contato_relacionamento where tarefa_id in (
      select id from tarefa_relacionamento where paciente_id in (${pacientesDemo}))`)
    await c.query(`delete from tarefa_relacionamento where paciente_id in (${pacientesDemo})`)

    // Autoatendimento.
    await c.query(`delete from lista_espera where paciente_id in (${pacientesDemo})`)

    // Periograma: sítio e dente apontam para o exame.
    const periogramasDemo = `select id from periograma where paciente_id in (${pacientesDemo})`
    await c.query(`delete from periograma_sitio where periograma_id in (${periogramasDemo})`)
    await c.query(`delete from periograma_dente where periograma_id in (${periogramasDemo})`)
    await c.query(`delete from periograma where paciente_id in (${pacientesDemo})`)

    // Laboratório: a refação aponta para a ordem anterior, então as filhas primeiro.
    const labsDemo = `select id from laboratorio where nome like '[DEMO]%'`
    await c.query(`delete from ordem_laboratorio where refaz_id in (
      select id from ordem_laboratorio where laboratorio_id in (${labsDemo}))`)
    await c.query(`delete from ordem_laboratorio where laboratorio_id in (${labsDemo})`)
    await c.query(`delete from laboratorio where nome like '[DEMO]%'`)

    // Esterilização.
    await c.query(`delete from ciclo_esterilizacao where autoclave_id in (
      select id from autoclave where nome like '[DEMO]%')`)
    await c.query(`delete from autoclave where nome like '[DEMO]%'`)

    // Pix: o evento e a intenção apontam para pagamento/parcela, que são apagados
    // adiante junto com a cobrança do paciente — então estes vêm primeiro.
    await c.query(`delete from evento_pix where payload->>'demo' = 'true'`)
    await c.query(`delete from intencao_pix where txid like 'DEMOPIX%'`)

    // Caixa: pagamento aponta para despesa, despesa para categoria e para a regra.
    const despesasDemo = `select id from despesa where descricao like '[DEMO]%'`
    await c.query(`delete from pagamento_despesa where despesa_id in (${despesasDemo})`)
    await c.query(`delete from despesa where descricao like '[DEMO]%'`)
    await c.query(`delete from regra_despesa_recorrente where descricao like '[DEMO]%'`)
    await c.query(`delete from taxa_meio_pagamento where observacao like '[DEMO]%'`)

    /**
     * `regra_autoatendimento` e `permite_autoagendamento` são CONFIGURAÇÃO da clínica,
     * não dado de demonstração — mas o `demo:preparar` os LIGOU, e deixá-los ligados
     * seria a demonstração alterando o comportamento do sistema de forma permanente.
     * Uma clínica com a agenda aberta para a internet porque alguém rodou um script de
     * demonstração meses atrás é o oposto do default `false` que a Fase 19 escolheu.
     */
    await c.query(`update procedimento set permite_autoagendamento = false
                    where clinica_id = app_clinica_id() and permite_autoagendamento`)
    await c.query(`delete from regra_autoatendimento where clinica_id = app_clinica_id()`)

    // Propostas alternativas: itens antes do plano.
    const propostasDemo = `select id from plano_tratamento where titulo like '[DEMO]%' and grupo_proposta is not null`
    await c.query(`delete from item_plano where plano_id in (${propostasDemo})`)
    await c.query(`delete from plano_tratamento where titulo like '[DEMO]%' and grupo_proposta is not null`)

    // Ordem: do mais dependente para o menos.
    await c.query(`delete from movimento_estoque where lote_id in (
      select id from lote_material where fornecedor = 'Dental Distribuidora Demo')`)
    await c.query(`delete from lote_material where fornecedor = 'Dental Distribuidora Demo'`)

    const pacientes = `select id from paciente where nome like '[DEMO]%'`
    await c.query(`delete from pagamento where parcela_id in (
      select pa.id from parcela pa join cobranca c on c.id = pa.cobranca_id
       where c.paciente_id in (${pacientes}))`)
    await c.query(`delete from parcela where cobranca_id in (
      select id from cobranca where paciente_id in (${pacientes}))`)
    await c.query(`delete from cobranca where paciente_id in (${pacientes})`)
    await c.query(`delete from execucao where item_plano_id in (
      select i.id from item_plano i join plano_tratamento p on p.id = i.plano_id
       where p.paciente_id in (${pacientes}))`)
    await c.query(`delete from item_plano where plano_id in (
      select id from plano_tratamento where paciente_id in (${pacientes}))`)
    await c.query(`delete from orcamento where plano_id in (
      select id from plano_tratamento where paciente_id in (${pacientes}))`)
    await c.query(`delete from plano_tratamento where paciente_id in (${pacientes})`)
    await c.query(`delete from evolucao where paciente_id in (${pacientes})`)
    await c.query(`delete from documento where paciente_id in (${pacientes})`)
    await c.query(`delete from agendamento where paciente_id in (${pacientes})`)
    await c.query(`delete from consentimento where paciente_id in (${pacientes})`)
    await c.query(`delete from paciente_sessao where conta_id in (
      select id from paciente_conta where paciente_id in (${pacientes}))`)
    await c.query(`delete from paciente_conta where paciente_id in (${pacientes})`)
    await c.query(`delete from paciente_convenio where paciente_id in (${pacientes})`)
    await c.query(`delete from dente_paciente where paciente_id in (${pacientes})`)
    await c.query(`delete from alerta_clinico where paciente_id in (${pacientes})`)
    await c.query(`delete from anamnese where paciente_id in (${pacientes})`)
    await c.query(`delete from audit_log where paciente_id in (${pacientes})`)
    // Menor aponta para a mãe: apaga quem tem responsável antes.
    await c.query(`delete from paciente where nome like '[DEMO]%' and responsavel_legal_id is not null`)
    await c.query(`delete from paciente where nome like '[DEMO]%'`)

    await c.query(`delete from preco_convenio where convenio_id in (
      select id from convenio where nome like '[DEMO]%')`)
    await c.query(`delete from convenio where nome like '[DEMO]%'`)

    await c.query(`delete from audit_log where ator_id in (select id from usuario where email like '%@demo.local')`)
    await c.query(`delete from profissional where usuario_id in (
      select id from usuario where email like '%@demo.local')`)
    await c.query(`delete from usuario where email like '%@demo.local'`)

    // ANTES do commit: `disable trigger` é DDL — comitar desligado deixaria o
    // prontuário editável para sempre, em silêncio.
    await religarTriggersDeAplicacao(c, tabelasDesligadas)
    await c.query('commit')
    console.log('✓ ambiente de demonstração removido. O seed de referência permanece.\n')
  } catch (e) {
    await c.query('rollback')
    console.error('Falha ao limpar:', e)
    process.exitCode = 1
  } finally {
    c.release()
  }
}

const acao = process.argv.includes('--limpar') ? limpar : main

acao()
  .then(async () => {
    await pool.end()
  })
  .catch(async (e) => {
    /**
     * `mensagemDoBanco` e não `e.message`: o Drizzle embrulha o erro do Postgres e o
     * `message` fica só "Failed query: insert into …" com os parâmetros. A causa — o
     * nome da constraint, o DETAIL, a mensagem da trigger — está em `e.cause`, e sem
     * isso o diagnóstico exige reproduzir a consulta à mão no psql. Custou três
     * tentativas aqui.
     */
    console.error('\n✗', mensagemDoBanco(e))
    await pool.end()
    process.exit(1)
  })
