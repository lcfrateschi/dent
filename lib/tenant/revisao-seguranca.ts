import { armazenamento } from '@/lib/armazenamento'
import { cifrarSegredo } from '@/lib/auth/mfaSegredo'
import { gerarHashSenha } from '@/lib/auth/senha'
import { gerarCodigoTotp, gerarSegredoTotp } from '@/lib/auth/totp'
import { gerarTokenDeSessao } from '@/lib/auth/convite'
import { db, pool } from '@/lib/db'
import {
  agendamento,
  cadeira,
  clinica,
  convenio,
  documento,
  material,
  orcamento,
  orcamentoItem,
  paciente,
  pacienteConta,
  pacienteSessao,
  profissional,
  usuario,
} from '@/lib/db/schema'
import { COOKIE_PORTAL } from '@/lib/portal/sessao'
import { chaveArmazenamento } from '@/lib/domain/arquivo'
import { comClinica } from '@/lib/tenant/executar'
import { eq, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'

/**
 * ╔════════════════════════════════════════════════════════════════════════╗
 * ║ Isolamento entre clínicas, provado por HTTP com DUAS clínicas de verdade ║
 * ╚════════════════════════════════════════════════════════════════════════╝
 *
 * ── Como rodar (a forma importa) ───────────────────────────────────────────
 *
 *     docker compose exec -T \
 *       -e DATABASE_URL=postgres://facilident:facilident_dev@db:5432/facilident \
 *       app npm run tenant:seguranca
 *
 * **Dentro do container do app**, e com a credencial do DONO. Os dois detalhes têm
 * motivo, e rodar do host falha de formas que confundem:
 *
 *   • **dentro do container** porque o script GRAVA os anexos de teste, e o
 *     armazenamento é um volume Docker (`/anexos`). Do host, os bytes vão para
 *     outro lugar, o app não os acha, a rota de documento responde 502 — e 502 na
 *     contraprova esvazia o caso, mesmo com o isolamento perfeito.
 *   • **como dono** porque criar clínica é onboarding: `facilident_app` só vê a
 *     própria clínica, e por desenho não consegue criar a segunda. Quem atende
 *     requisição não deve poder criar tenant.
 *
 * O app, esse sim, roda como `facilident_app` — e o passo 1 CONFERE isso, porque é
 * disso que depende todo o resto.
 *
 * ── Por que este script existe, e por que ele é diferente dos outros ────────
 * A Fase 17 pôs `clinica_id` em 39 tabelas, políticas de RLS em 41 e FK composto
 * em 80 relações. Nada disso prova o que interessa. A pergunta que interessa é
 * uma só, e ela se responde de fora:
 *
 *   **uma sessão da clínica A consegue ler o prontuário da clínica B?**
 *
 * Todas as verificações anteriores rodaram por SQL, como o dono das tabelas — e
 * dono de tabela ignora política de RLS. Rodar assim é medir a fechadura com a
 * chave mestra na mão. Aqui o teste passa pelo mesmo caminho de um atacante:
 * cookie de sessão legítimo da clínica A, id da clínica B na URL, HTTP.
 *
 * ── As duas armadilhas deste tipo de teste ─────────────────────────────────
 * 1. **Um 500 não é isolamento.** Se toda rota estourar, o script "passa" e não
 *    provou nada — já aconteceu neste projeto: o `portal:seguranca` acusou
 *    "VAZOU" em dois casos porque tudo respondia 500 (era `npm run build` rodado
 *    dentro do container do `next dev`, que compartilha `/app/.next`). Aqui 500 é
 *    FALHA, tão grave quanto 200.
 * 2. **Sem contraprova, "não vi o dado de B" pode ser "não vi dado nenhum".** Uma
 *    rota quebrada nega tudo. Por isso cada negação vem acompanhada da mesma rota
 *    com o id da PRÓPRIA clínica, que tem de responder 200. E ao fim, o caso 5
 *    desliga a política de uma tabela e mostra que o script então **acusa
 *    vazamento** — é o que separa um teste que funciona de um teste que só diz
 *    sim.
 *
 * ── O que este script NÃO prova ────────────────────────────────────────────
 * Não prova ausência de vazamento em rota que ele não visita. Ele cobre as sete
 * rotas por id do staff e duas do portal; rota nova precisa entrar aqui.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const MARCA = `TEN-${Date.now()}`
const SENHA = 'Isolamento-Tenant-2026!'

let falhas = 0
let avisos = 0

function passo(n: number, texto: string): void {
  console.log(`\n\x1b[36m${n}.\x1b[0m ${texto}`)
}

function conferir(condicao: boolean, texto: string): void {
  if (condicao) {
    console.log(`   \x1b[32m✓\x1b[0m ${texto}`)
  } else {
    console.error(`   \x1b[31m✗ ${texto}\x1b[0m`)
    falhas++
  }
}

/**
 * A mensagem de verdade do Postgres.
 *
 * O Drizzle embrulha o erro do `pg`: `e.message` é só "Failed query: commit", e o
 * texto que diz o que aconteceu está em `e.cause` — às vezes dois níveis abaixo.
 * Sem isto, uma violação de constraint deferida (que estoura **no commit**, longe
 * do insert que a causou) aparece como uma linha que não ajuda em nada. Foi
 * exatamente o que atrasou este script.
 */
function mensagemDoBanco(e: unknown): string {
  const partes: string[] = []
  let atual: unknown = e
  while (atual && typeof atual === 'object') {
    const m = (atual as { message?: string }).message
    const d = (atual as { detail?: string }).detail
    const c = (atual as { constraint?: string }).constraint
    if (m && !partes.includes(m)) partes.push(m)
    if (c) partes.push(`constraint: ${c}`)
    if (d) partes.push(d)
    atual = (atual as { cause?: unknown }).cause
  }
  return partes.join(' | ') || String(e)
}

function avisar(texto: string): void {
  console.log(`   \x1b[33m⚠\x1b[0m ${texto}`)
  avisos++
}

/** Dedupe de cookie por nome, mantendo o último. Mesmo helper dos outros scripts. */
function juntar(...listas: readonly string[][]): string {
  const porNome = new Map<string, string>()
  for (const lista of listas) {
    for (const bruto of lista) {
      const par = bruto.split(';')[0]
      if (!par || !par.includes('=')) continue
      porNome.set(par.slice(0, par.indexOf('=')), par)
    }
  }
  return [...porNome.values()].join('; ')
}

/**
 * Entra como staff, **funcionando com o segundo fator ligado ou desligado**.
 *
 * Antes isto mandava `codigo: ''` e um comentário dizendo que o ambiente de
 * desenvolvimento roda com `MFA_DESABILITADO=true`. Verdadeiro, e mesmo assim uma
 * dependência escondida: no dia em que a bateria subiu o app com o segundo fator
 * LIGADO — para poder verificar a cifra do `mfa_secret` — o login parou de formar
 * sessão e o script acusou `0/6 rotas próprias abrem`.
 *
 * O que salvou o diagnóstico foi a contraprova do passo 6: ela apontou que os 404 do
 * passo 4 não estavam medindo a RLS, e não que a RLS tinha quebrado. Um teste de
 * isolamento que só funciona com uma trava de segurança desligada é um teste que vai
 * apodrecer — então ele passou a gerar o código, como `admin:verificar` sempre fez.
 */
async function entrarComoStaff(
  email: string,
  segredo?: string,
): Promise<{ cookie: string; erro: string | null }> {
  const r1 = await fetch(`${BASE}/api/auth/csrf`)
  const c1 = juntar(r1.headers.getSetCookie())
  const { csrfToken } = (await r1.json()) as { csrfToken: string }
  const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: c1 },
    body: new URLSearchParams({
      email,
      senha: SENHA,
      // Com `MFA_DESABILITADO=true` o campo é IGNORADO (não existe código mágico —
      // ver `lib/auth/mfa.ts`); com o segundo fator ligado, este código é o que faz a
      // sessão existir. Mandar o código nos dois casos custa nada e remove a
      // dependência do ambiente.
      codigo: segredo ? gerarCodigoTotp(segredo) : '',
      csrfToken,
      callbackUrl: BASE,
      json: 'true',
    }),
    redirect: 'manual',
  })
  const destino = r2.headers.get('location') ?? ''
  return {
    cookie: juntar(c1.split('; '), r2.headers.getSetCookie()),
    erro: destino.includes('error=') ? destino : null,
  }
}

interface Fixture {
  readonly clinicaId: string
  /**
   * Segredo TOTP dos dois usuários desta clínica.
   *
   * Existe para o login funcionar **com o segundo fator ligado**. Um teste de
   * isolamento que só passa com uma trava de segurança desligada apodrece — e este
   * apodreceu por algumas horas, até a bateria subir o app com MFA ligado.
   */
  readonly segredoMfa: string
  /** Admin — tem `configuracao`, `convenio`, `estoque`, `paciente`. */
  readonly email: string
  /**
   * Dentista — tem `orcamento`, `documento`, `prontuario`, `agenda`.
   *
   * São dois logins porque **nenhum perfil sozinho abre todas as rotas por id**, e
   * isso é a política de acesso funcionando, não um obstáculo: o `admin` não lê
   * orçamento nem documento (decisão da Fase 3 — quem administra o sistema não
   * precisa ver prontuário). Usar um só daria 403/307 nas rotas do outro e o teste
   * concluiria "isolado" a partir de uma negação que não tem nada a ver com tenant.
   */
  readonly emailDentista: string
  readonly pacienteId: string
  readonly documentoId: string
  readonly orcamentoId: string
  readonly agendamentoId: string
  readonly materialId: string
  readonly convenioId: string
  /** Tipo que o portal EXPÕE. Radiografia não aparece no portal, por decisão. */
  readonly documentoDoPortalId: string
  readonly tokenDoPortal: string
}

/**
 * Cria uma clínica inteira, com tudo o que as rotas por id precisam alcançar.
 *
 * Roda como DONO do banco (a `DATABASE_URL` do `.env`), o que é o certo: criar
 * clínica é onboarding, operação — não é o app agindo em nome de um cliente. O
 * `comClinica` define `app.clinica_id` na transação, e é dele que sai o
 * `clinica_id` de cada linha, pelo `DEFAULT app_clinica_id()`.
 *
 * **Tudo numa transação só**, e não por elegância: a trava deferida de
 * `drizzle/0021` cobra no COMMIT que todo usuário de perfil `dentista` ativo tenha
 * linha em `profissional`. Dois inserts soltos comitam separado e o primeiro já
 * viola. Esta lição já apareceu três vezes neste projeto.
 */
async function criarClinica(rotulo: string): Promise<Fixture> {
  const [nova] = await db
    .insert(clinica)
    .values({
      razaoSocial: `Clínica ${rotulo} ${MARCA} Ltda`,
      nomeFantasia: `${rotulo} ${MARCA}`,
      fusoHorario: 'America/Sao_Paulo',
    })
    .returning({ id: clinica.id })
  if (!nova) throw new Error('INSERT em clinica não devolveu id')

  /**
   * Os bytes existem de verdade, e o `sha256` é o dos bytes.
   *
   * A primeira versão inventava chave e hash, o que parecia inofensivo: "o que se
   * testa é a autorização, não o arquivo". Só que a rota LÊ o arquivo depois de
   * autorizar, e sem ele responde **502**. A contraprova então dizia "o próprio
   * documento não abre", e uma contraprova que falha esvazia o caso todo — mesmo
   * com o isolamento funcionando. Fixture pela metade produz relatório pela metade.
   */
  const bytes = new TextEncoder().encode(`documento de teste ${rotulo} ${MARCA}`)
  const sha = createHash('sha256').update(bytes).digest('hex')

  const email = `adm-${rotulo.toLowerCase()}-${MARCA}@local`.toLowerCase()
  const emailDentista = `dent-${rotulo.toLowerCase()}-${MARCA}@local`.toLowerCase()
  const senhaHash = await gerarHashSenha(SENHA)
  const { token, hash } = gerarTokenDeSessao()

  /**
   * Ids gerados aqui, antes do INSERT.
   *
   * A chave de armazenamento é `clinicas/<clinicaId>/…/<documentoId>.<ext>` e
   * `chaveArmazenamento()` exige os três ids — mas o documento só teria id depois
   * de inserido. Gerar o uuid antes desfaz a circularidade sem inventar formato de
   * chave: usar um caminho "qualquer" fez a gravação ser recusada pela própria
   * validação que existe para impedir uma clínica pedir arquivo de outra.
   */
  /**
   * Ids do staff gerados antes do INSERT, pelo mesmo motivo dos ids de documento
   * abaixo: `cifrarSegredo` amarra o texto cifrado ao `usuario.id` (é o dado
   * autenticado adicional que impede copiar o próprio segredo cifrado para a linha de
   * outra pessoa), e o id só existiria depois de inserir.
   */
  const idAdmin = randomUUID()
  const idDentista = randomUUID()
  const segredoMfa = gerarSegredoTotp()

  const pacienteFixo = randomUUID()
  const docRadiografia = randomUUID()
  const docAtestado = randomUUID()
  const ano = new Date().getUTCFullYear()
  const chaveRadiografia = chaveArmazenamento({
    clinicaId: nova.id,
    pacienteId: pacienteFixo,
    documentoId: docRadiografia,
    extensao: 'png',
    ano,
  })
  const chaveAtestado = chaveArmazenamento({
    clinicaId: nova.id,
    pacienteId: pacienteFixo,
    documentoId: docAtestado,
    extensao: 'pdf',
    ano,
  })
  await armazenamento().salvar(chaveRadiografia, bytes, 'image/png')
  await armazenamento().salvar(chaveAtestado, bytes, 'application/pdf')

  return await comClinica(nova.id, async (tx) => {
    const [adm] = await tx
      .insert(usuario)
      .values({
        id: idAdmin,
        nome: `Admin ${rotulo}`,
        email,
        senhaHash,
        perfil: 'admin',
        ativo: true,
        mfaSecret: cifrarSegredo(segredoMfa, idAdmin),
        mfaAtivo: true,
      })
      .returning({ id: usuario.id })

    const [dent] = await tx
      .insert(usuario)
      .values({
        id: idDentista,
        nome: `Dentista ${rotulo}`,
        email: emailDentista,
        senhaHash,
        perfil: 'dentista',
        ativo: true,
        mfaSecret: cifrarSegredo(segredoMfa, idDentista),
        mfaAtivo: true,
      })
      .returning({ id: usuario.id })

    const [prof] = await tx
      .insert(profissional)
      .values({ usuarioId: dent!.id, cro: `${MARCA.slice(-5)}`, ufCro: 'SP' })
      .returning({ id: profissional.id })

    const [cad] = await tx
      .insert(cadeira)
      .values({ nome: `Consultório ${rotulo}`, ordem: 1 })
      .returning({ id: cadeira.id })

    const [pac] = await tx
      .insert(paciente)
      .values({
        id: pacienteFixo,
        nome: `Paciente da ${rotulo} ${MARCA}`,
        dataNascimento: '1990-05-14',
        telefoneWhatsapp: '11999990000',
      })
      .returning({ id: paciente.id })

    const [doc] = await tx
      .insert(documento)
      .values({
        id: docRadiografia,
        pacienteId: pac!.id,
        tipo: 'radiografia',
        nome: `Radiografia da ${rotulo}`,
        // Chave e hash de mentira: nenhum byte é lido. O que se testa é a
        // AUTORIZAÇÃO da rota, que acontece antes de tocar no arquivo.
        storageKey: chaveRadiografia,
        mimeType: 'image/png',
        tamanhoBytes: bytes.byteLength,
        sha256: sha,
        criadoPorId: adm!.id,
      })
      .returning({ id: documento.id })

    /**
     * Um segundo documento, tipo `atestado`.
     *
     * O portal **não expõe radiografia**, por decisão fechada: imagem sem laudo
     * gera interpretação errada. `documentoDoPortalParaDownload` filtra por tipo, e
     * a primeira versão deste script pedia a radiografia ao portal e recebia 404 —
     * negação legítima que eu quase leu como isolamento.
     */
    const [docPortal] = await tx
      .insert(documento)
      .values({
        id: docAtestado,
        pacienteId: pac!.id,
        tipo: 'atestado',
        nome: `Atestado da ${rotulo}`,
        storageKey: chaveAtestado,
        mimeType: 'application/pdf',
        tamanhoBytes: bytes.byteLength,
        sha256: sha,
        criadoPorId: adm!.id,
      })
      .returning({ id: documento.id })

    const [orc] = await tx
      .insert(orcamento)
      .values({
        pacienteId: pac!.id,
        validadeAte: '2026-12-31',
        valorBruto: '1000.00',
        valorTotal: '1000.00',
        criadoPorId: adm!.id,
      })
      .returning({ id: orcamento.id })

    /**
     * A linha do orçamento não é enfeite de fixture: a trigger de `drizzle/0004`
     * é DEFERIDA e cobre no COMMIT que a soma das linhas seja igual ao valor
     * bruto. Um orçamento sem linha estoura com "soma das linhas (0.00) difere do
     * valor bruto (1000.00)" **no commit**, longe de onde o erro parece estar —
     * foi assim que este script falhou na primeira execução, e é a razão de
     * `mensagemDoBanco` existir aqui.
     */
    await tx.insert(orcamentoItem).values({
      orcamentoId: orc!.id,
      descricao: `Procedimento de teste ${rotulo}`,
      quantidade: 1,
      valorUnitario: '1000.00',
    })

    const inicio = new Date(Date.now() + 86_400_000)
    const [ag] = await tx
      .insert(agendamento)
      .values({
        pacienteId: pac!.id,
        profissionalId: prof!.id,
        cadeiraId: cad!.id,
        inicio,
        fim: new Date(inicio.getTime() + 1_800_000),
        criadoPorId: adm!.id,
      })
      .returning({ id: agendamento.id })

    const [mat] = await tx
      .insert(material)
      .values({
        codigo: `MAT-${MARCA.slice(-6)}`,
        nome: `Material da ${rotulo}`,
        categoria: 'descartavel',
        unidade: 'unidade',
      })
      .returning({ id: material.id })

    const [conv] = await tx
      .insert(convenio)
      .values({ nome: `Operadora da ${rotulo} ${MARCA}` })
      .returning({ id: convenio.id })

    // Conta e sessão do portal — o segundo realm. A sessão é criada como o
    // servidor a criaria; o que se testa é o CONSUMO do cookie.
    const [conta] = await tx
      .insert(pacienteConta)
      .values({
        pacienteId: pac!.id,
        email: `pac-${rotulo.toLowerCase()}-${MARCA}@local`.toLowerCase(),
        senhaHash,
        senhaDefinidaEm: new Date(),
        ativo: true,
      })
      .returning({ id: pacienteConta.id })

    await tx.insert(pacienteSessao).values({
      contaId: conta!.id,
      tokenHash: hash,
      expiraEm: new Date(Date.now() + 12 * 3_600_000),
      ip: '127.0.0.1',
      userAgent: 'tenant:seguranca',
    })

    return {
      clinicaId: nova.id,
      email,
      emailDentista,
      // O segredo volta para quem entra: sem ele o login não forma sessão com o
      // segundo fator ligado.
      segredoMfa,
      pacienteId: pac!.id,
      documentoId: doc!.id,
      orcamentoId: orc!.id,
      agendamentoId: ag!.id,
      materialId: mat!.id,
      convenioId: conv!.id,
      documentoDoPortalId: docPortal!.id,
      tokenDoPortal: token,
    }
  })
}

/**
 * As rotas por id do staff, cada uma com o PERFIL que tem permissão nela.
 *
 * O perfil faz parte do caso de teste, e descobri isso errando: com o login de
 * `admin` em tudo, quatro rotas devolviam 403/307 **para o próprio dado** — porque
 * admin não lê orçamento nem documento (`lib/authz/politicas.ts`). Eu teria lido
 * essas negações como isolamento, quando eram autorização de perfil. Um caso que
 * passa pelo motivo errado é pior que caso nenhum, e este teria passado bonito.
 *
 * Rota nova precisa entrar nesta lista, com o perfil certo.
 */
type Perfil = 'admin' | 'dentista'
function rotasDoStaff(f: Fixture): ReadonlyArray<{ nome: string; caminho: string; perfil: Perfil }> {
  return [
    { nome: 'prontuário do paciente', caminho: `/pacientes/${f.pacienteId}`, perfil: 'dentista' },
    { nome: 'orçamento', caminho: `/orcamentos/${f.orcamentoId}`, perfil: 'dentista' },
    { nome: 'bytes do documento', caminho: `/api/documentos/${f.documentoId}`, perfil: 'dentista' },
    {
      nome: 'reagendamento',
      caminho: `/agenda/${f.agendamentoId}/reagendar`,
      perfil: 'dentista',
    },
    { nome: 'material do estoque', caminho: `/estoque/${f.materialId}`, perfil: 'admin' },
    { nome: 'tabela do convênio', caminho: `/convenios/cadastro/${f.convenioId}`, perfil: 'admin' },
  ]
}

async function pedir(caminho: string, cookie: string): Promise<number> {
  const r = await fetch(`${BASE}${caminho}`, { headers: { cookie }, redirect: 'manual' })
  return r.status
}

/**
 * O veredito de uma tentativa de atravessar tenant.
 *
 * 200 é vazamento. 500 **também é falha**, e por um motivo que não é pedantismo:
 * um 500 diz que a rota quebrou, e uma rota quebrada nega tudo — inclusive o
 * acesso legítimo. Aceitar 500 como "isolado" é aceitar que o teste passe num
 * sistema inteiramente fora do ar.
 */
function vereditoDeAtravessamento(status: number, nome: string): void {
  if (status === 200) {
    conferir(false, `VAZOU: ${nome} respondeu 200 para sessão de outra clínica`)
    return
  }
  if (status >= 500) {
    conferir(false, `${nome} respondeu ${status} — 500 não é isolamento, é erro`)
    return
  }
  conferir(true, `${nome}: ${status} (negado)`)
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('tenant:seguranca cria clínicas fictícias. Não roda em produção.')
  }

  console.log('\n═══ Isolamento entre clínicas — dois tenants, por HTTP ═══')
  console.log(`    ${BASE}`)

  let a: Fixture | null = null
  let b: Fixture | null = null

  try {
    passo(1, 'O app está no ar, e com QUAL credencial de banco?')
    const home = await fetch(`${BASE}/entrar`)
    conferir(home.status === 200, `/entrar responde ${home.status}`)

    passo(2, 'Duas clínicas, cada uma com prontuário, orçamento, documento e agenda')
    a = await criarClinica('Alfa')
    b = await criarClinica('Beta')
    conferir(a.clinicaId !== b.clinicaId, 'duas clínicas distintas criadas')
    conferir(
      a.pacienteId !== b.pacienteId && a.documentoId !== b.documentoId,
      'cada uma com paciente e documento próprios',
    )

    passo(3, 'Sessão da clínica Alfa alcança o que é DELA (contraprova)')
    const loginA = await entrarComoStaff(a.email, a.segredoMfa)
    const loginDentistaA = await entrarComoStaff(a.emailDentista, a.segredoMfa)
    conferir(loginA.erro === null, `login do admin da Alfa: ${loginA.erro ?? 'ok'}`)
    conferir(
      loginDentistaA.erro === null,
      `login do dentista da Alfa: ${loginDentistaA.erro ?? 'ok'}`,
    )
    const cookieDe = (perfil: Perfil): string =>
      perfil === 'admin' ? loginA.cookie : loginDentistaA.cookie

    /**
     * Este passo não é formalidade. Sem ele, o passo 4 poderia estar medindo
     * "a sessão não alcança NADA" — que é o que aconteceria com uma sessão
     * inválida, um app fora do ar ou um erro de fixture. A negação só significa
     * isolamento se o acesso legítimo funcionar no mesmo instante, pelo mesmo
     * caminho, com o mesmo cookie.
     */
    /**
     * A pergunta que decide se o resto do script vale algo.
     *
     * `FORCE ROW LEVEL SECURITY` não se aplica a superusuário — e o `POSTGRES_USER`
     * da imagem oficial do Postgres é superusuário. Se o app estiver conectando
     * como dono, **todas as políticas são decorativas** e este script passaria
     * inteiro com o vazamento de pé. É exatamente o resultado falso-verde que a
     * Fase 17 mais teme.
     *
     * Aqui o script pergunta ao BANCO quem está conectado, e não ao próprio
     * `process.env` — que é o do script, não o do servidor. Essa distinção já
     * custou um relatório errado neste projeto (`admin:verificar` lia o env
     * próprio e reprovou uma trava que estava desligada do outro lado).
     */
    const conexoesDoApp = await db.execute<{ usename: string; n: number }>(sql`
      select usename, count(*)::int as n
        from pg_stat_activity
       where datname = current_database()
         and application_name not like '%psql%'
         and usename is not null
       group by usename
    `)
    const usuariosConectados = (
      conexoesDoApp as unknown as { rows: ReadonlyArray<{ usename: string; n: number }> }
    ).rows
    const temAppRole = usuariosConectados.some((l) => l.usename === 'facilident_app')
    conferir(
      temAppRole,
      `o app conecta como facilident_app (conectados: ${usuariosConectados
        .map((l) => `${l.usename}×${l.n}`)
        .join(', ')})`,
    )
    if (!temAppRole) {
      avisar(
        'Sem a role de aplicação, RLS é decorativa (dono/superusuário ignora política).',
      )
      avisar('Rode ./docker/credencial-app.sh e confira o DATABASE_URL do serviço app.')
    }

    let proprias = 0
    for (const rota of rotasDoStaff(a)) {
      const status = await pedir(rota.caminho, cookieDe(rota.perfil))
      if (status === 200) proprias++
      else avisar(`${rota.nome} própria respondeu ${status} (esperado 200, ${rota.perfil})`)
    }
    conferir(
      proprias === rotasDoStaff(a).length,
      `${proprias}/${rotasDoStaff(a).length} rotas próprias abrem para a sessão da Alfa`,
    )

    passo(4, 'A MESMA sessão tentando os ids da clínica Beta')
    for (const rota of rotasDoStaff(b)) {
      vereditoDeAtravessamento(await pedir(rota.caminho, cookieDe(rota.perfil)), rota.nome)
    }

    passo(5, 'Portal: paciente da Alfa tentando documento e orçamento da Beta')
    const cookieA = `${COOKIE_PORTAL}=${a.tokenDoPortal}`
    const proprioPortal = await pedir(`/api/meu/documentos/${a.documentoDoPortalId}`, cookieA)
    conferir(
      proprioPortal < 400,
      `contraprova: o próprio documento responde ${proprioPortal} no portal`,
    )
    vereditoDeAtravessamento(
      await pedir(`/api/meu/documentos/${b.documentoDoPortalId}`, cookieA),
      'documento da Beta pelo portal',
    )
    vereditoDeAtravessamento(
      await pedir(`/meu/orcamentos/${b.orcamentoId}`, cookieA),
      'orçamento da Beta pelo portal',
    )

    /**
     * ── Passo 6: a contraprova do próprio teste ────────────────────────────
     *
     * Tudo acima passa igual em duas situações muito diferentes: (a) a RLS
     * funciona, e (b) o teste não consegue detectar vazamento nenhum. Para
     * distinguir, este passo **cria o vazamento de propósito** — desliga a política
     * de `paciente` — e exige que a rota passe a responder 200.
     *
     * Se ela NÃO responder 200 com a política desligada, então a negação do passo 4
     * vinha de outro lugar (autorização de aplicação, um `where` explícito, uma
     * rota quebrada) e este script não estava medindo a RLS. Saber disso vale mais
     * que o verde.
     *
     * O `finally` religa. E o passo 7 confere que religou — porque um `ENABLE` que
     * não acontecesse deixaria a tabela de pacientes aberta entre clínicas, em
     * silêncio, e o script teria acabado de imprimir "tudo certo".
     */
    passo(6, 'Contraprova: com a política de `paciente` desligada, o teste ACUSA?')
    let statusComRlsDesligada = 0
    try {
      await db.execute(sql`alter table paciente disable row level security`)
      statusComRlsDesligada = await pedir(`/pacientes/${b.pacienteId}`, loginDentistaA.cookie)
    } finally {
      await db.execute(sql`alter table paciente enable row level security`)
      await db.execute(sql`alter table paciente force row level security`)
    }
    conferir(
      statusComRlsDesligada === 200,
      `sem a política, o prontuário da Beta abriu (${statusComRlsDesligada}) — ` +
        'logo o passo 4 estava medindo a RLS, e não outra coisa',
    )
    if (statusComRlsDesligada !== 200) {
      avisar('A negação do passo 4 vem de outro mecanismo. Investigue ANTES de confiar nele.')
    }

    passo(7, 'A política voltou, e a asserção estrutural continua de pé')
    const rls = await db.execute<{ ligada: boolean; forcada: boolean }>(sql`
      select relrowsecurity as ligada, relforcerowsecurity as forcada
        from pg_class where relname = 'paciente'
    `)
    const linha = (
      rls as unknown as { rows: ReadonlyArray<{ ligada: boolean; forcada: boolean }> }
    ).rows[0]
    conferir(linha?.ligada === true, 'RLS religada em `paciente`')
    conferir(linha?.forcada === true, 'FORCE religado em `paciente`')
    await db.execute(sql`select exigir_isolamento_estrutural()`)
    conferir(true, 'exigir_isolamento_estrutural() passou (ela estoura quando não)')
  } finally {
    passo(8, 'Limpando as duas clínicas')
    for (const f of [a, b]) {
      if (f) await apagarClinica(f.clinicaId)
    }
    const [restou] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(clinica)
      .where(sql`${clinica.nomeFantasia} like ${'%' + MARCA + '%'}`)
    conferir(
      (restou?.n ?? -1) === 0,
      'nenhuma clínica de teste restou (senão o banco fica com dois tenants)',
    )
  }

  console.log(
    falhas === 0
      ? `\n\x1b[32m═══ Isolamento entre clínicas verificado${avisos ? ` (${avisos} aviso${avisos > 1 ? 's' : ''})` : ''} ═══\x1b[0m`
      : `\n\x1b[31m═══ ${falhas} FALHA(S) ═══\x1b[0m`,
  )
  if (falhas > 0) process.exitCode = 1
}

/**
 * Apaga tudo de uma clínica, na ordem de dependência.
 *
 * `DISABLE TRIGGER USER` tabela por tabela, e **não** `session_replication_role =
 * replica`: o atalho desliga também as triggers internas de FK, e foi assim que a
 * limpeza de uma demonstração deixou cinco movimentos de estoque órfãos neste
 * banco — o que depois impediu a `drizzle/0023` de criar FK composto. Aqui as
 * travas de integridade continuam de pé; só o append-only sai do caminho, para uma
 * limpeza de fixture.
 */
async function apagarClinica(clinicaId: string): Promise<void> {
  const ordem = [
    'audit_log',
    'documento',
    'agendamento',
    'orcamento_item',
    'orcamento',
    'paciente_sessao',
    'paciente_conta',
    'movimento_estoque',
    'lote_material',
    'insumo_procedimento',
    'material',
    'preco_convenio',
    'paciente_convenio',
    'convenio',
    'evolucao',
    'dente_paciente',
    'anamnese',
    'alerta_clinico',
    'consentimento',
    'execucao',
    'item_plano',
    'plano_tratamento',
    'paciente',
    'profissional',
    'usuario',
    'cadeira',
    'procedimento',
    'contador',
  ]

  for (const tabela of ordem) {
    await db.execute(sql.raw(`alter table ${tabela} disable trigger user`))
    try {
      await db.execute(sql.raw(`delete from ${tabela} where clinica_id = '${clinicaId}'`))
    } finally {
      await db.execute(sql.raw(`alter table ${tabela} enable trigger user`))
    }
  }
  await db.delete(clinica).where(eq(clinica.id, clinicaId))
}

main()
  .catch((e) => {
    console.error('\nFalha na revisão de isolamento:', mensagemDoBanco(e))
    process.exitCode = 1
  })
  .finally(() => pool.end())
