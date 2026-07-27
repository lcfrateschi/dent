import { cifrarSegredo } from '@/lib/auth/mfaSegredo'
import { gerarHashSenha } from '@/lib/auth/senha'
import { gerarCodigoTotp, gerarSegredoTotp } from '@/lib/auth/totp'
import { db, pool } from '@/lib/db'
import { listaEspera, paciente, profissional, usuario } from '@/lib/db/schema'
import { idDaPrimeiraClinica } from '@/lib/demo/clinicaDaDemo'
import { desligarTriggersDeAplicacao, religarTriggersDeAplicacao } from '@/lib/demo/triggers'
import { comContextoDeClinica } from '@/lib/tenant/contexto'
import { randomUUID } from 'node:crypto'

/**
 * Verificação da tela da LISTA DE ESPERA, por HTTP e com sessão de verdade.
 *
 *   npm run espera:telas    (com o app rodando)
 *
 * Existe pelo mesmo motivo das outras: `tsc` e `next build` provam que a página
 * compila, não que ela mostra a linha certa para o perfil certo. Entre os dois cabe a
 * classe de erro que mais aparece aqui — a tela que renderiza com o filtro invertido,
 * ou que abre para quem não deveria.
 *
 * ── O que este script prova, e o que ele NÃO prova ─────────────────────────
 * Prova: a recepção abre e vê a fila; o dentista abre e **não** vê os botões de
 * trabalho; um perfil sem o recurso vai para `/sem-permissao`.
 *
 * Não prova IDOR de portal — isso é `portal:seguranca`, que tem o caso "sessão de
 * paciente abrindo `/espera`". Aqui é o lado da clínica.
 *
 * O IDOR entre CLÍNICAS também não é daqui: quem prova é `tenant:seguranca`. Este
 * script cria uma linha na fila e confere que ela aparece — se a RLS estivesse
 * furada, o número seria maior, não menor, e o caso não veria.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const SENHA = 'Espera-Telas-2026!'
const MARCA = `ESP-${Date.now()}`

let falhas = 0

function conferir(condicao: boolean, texto: string): void {
  if (condicao) {
    console.log(`   \x1b[32m✓\x1b[0m ${texto}`)
  } else {
    console.error(`   \x1b[31m✗ ${texto}\x1b[0m`)
    falhas++
  }
}

/**
 * Junta `Set-Cookie` deduplicando por nome, mantendo o último.
 *
 * Sem a dedupe o login falha com `MissingCSRF`: `/api/auth/csrf` responde
 * `authjs.csrf-token` duas vezes, e concatenar as duas faz o servidor ler a primeira,
 * que não casa com o token do corpo. Já custou uma execução inteira reprovando como se
 * as telas estivessem quebradas.
 */
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

async function entrar(email: string, segredo: string): Promise<string> {
  const r1 = await fetch(`${BASE}/api/auth/csrf`)
  const c1 = juntar(r1.headers.getSetCookie())
  const { csrfToken } = (await r1.json()) as { csrfToken: string }
  const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: c1 },
    body: new URLSearchParams({
      email,
      senha: SENHA,
      // O código vai SEMPRE, mesmo com `MFA_DESABILITADO=true` (onde é ignorado).
      // Mandar `codigo: ''` fez o `tenant:seguranca` quebrar no dia em que a bateria
      // subiu o app com o segundo fator ligado — um script de verificação não pode
      // depender de uma trava de segurança estar desligada.
      codigo: gerarCodigoTotp(segredo),
      csrfToken,
      callbackUrl: BASE,
      json: 'true',
    }),
    redirect: 'manual',
  })
  if (r2.status >= 400 || r2.headers.get('location')?.includes('error=')) {
    throw new Error(`login falhou: ${r2.status} ${r2.headers.get('location') ?? ''}`)
  }
  return juntar(c1.split('; '), r2.headers.getSetCookie())
}

/**
 * Cria um usuário com MFA já configurado.
 *
 * O uuid é gerado ANTES do insert porque `cifrarSegredo` amarra o texto cifrado ao
 * `usuario.id` (dado autenticado adicional): sem o id não há como cifrar, e gravar o
 * segredo em claro funcionaria hoje (o formato legado é aceito) e deixaria de funcionar
 * quando a tolerância ao legado sair.
 */
async function criarUsuario(
  perfil: 'recepcao' | 'financeiro' | 'dentista',
): Promise<{ id: string; email: string; segredo: string }> {
  const id = randomUUID()
  const segredo = gerarSegredoTotp()
  const email = `esp-${perfil}-${Date.now()}-${Math.floor(Math.random() * 1000)}@local`

  /**
   * As duas linhas na MESMA transação quando o perfil é `dentista`.
   *
   * A trava deferida de `drizzle/0021` cobra **no commit** que usuário de perfil
   * `dentista` ativo tenha linha em `profissional`. Dois inserts soltos comitam
   * separado e o primeiro já viola — é a lição que o `CLAUDE.md` registra, e ela vale
   * também na exclusão.
   */
  await db.transaction(async (tx) => {
    await tx.insert(usuario).values({
      id,
      nome: `${MARCA} ${perfil}`,
      email,
      senhaHash: await gerarHashSenha(SENHA),
      perfil,
      mfaSecret: cifrarSegredo(segredo, id),
      mfaAtivo: true,
    })
    if (perfil === 'dentista') {
      await tx
        .insert(profissional)
        .values({ usuarioId: id, cro: `E${Date.now() % 100000}`, ufCro: 'SP' })
    }
  })

  return { id, email, segredo }
}

async function main(): Promise<void> {
  console.log('\n═══ Tela da lista de espera, por HTTP e com sessão ═══')

  const recepcao = await criarUsuario('recepcao')
  // `financeiro` tem `relacionamento` e também trabalha fila — então para provar o
  // `/sem-permissao` eu preciso de um perfil SEM o recurso. Só o dentista tem
  // `relacionamento: ['ler']` (vê e não trabalha), e nenhum perfil fica de fora do
  // recurso — então o caso do 403 usa uma rota que a recepção não tem.
  const financeiro = await criarUsuario('financeiro')
  // Declarado fora do `try` para a limpeza no `finally` alcançá-lo mesmo se um caso
  // do meio estourar — usuário fictício comitado é lixo que o próximo script encontra.
  let dentistaId: string | null = null

  const [pac] = await db
    .insert(paciente)
    .values({ nome: `${MARCA} Paciente da fila`, dataNascimento: '1990-05-05', telefone: '11988887777' })
    .returning({ id: paciente.id })

  const [pedido] = await db
    .insert(listaEspera)
    .values({
      pacienteId: pac!.id,
      turno: 'manha',
      validoAte: new Date(Date.now() + 30 * 86_400_000),
      observacao: `${MARCA}-OBSERVACAO`,
    })
    .returning({ id: listaEspera.id })

  try {
    console.log('\n\x1b[36m1.\x1b[0m A recepção abre a fila e vê quem está esperando')
    const cookieRecepcao = await entrar(recepcao.email, recepcao.segredo)
    const r = await fetch(`${BASE}/espera`, { headers: { cookie: cookieRecepcao }, redirect: 'manual' })
    const html = r.status === 200 ? await r.text() : ''

    conferir(r.status === 200, `/espera responde 200 para a recepção (${r.status})`)
    // A linha do paciente renderizou — a contraprova que dá sentido aos casos
    // seguintes. Sem ela, "não aparece o botão" seria verdade numa página vazia, que é
    // a forma como quatro casos de IDOR passaram vazios na Fase 19.
    conferir(html.includes(`${MARCA} Paciente da fila`), 'o paciente da fila aparece na tela')
    conferir(html.includes(`${MARCA}-OBSERVACAO`), 'a observação do pedido aparece')
    conferir(html.includes('Manhã'), 'o turno pedido aparece (é o campo que decide a ligação)')
    conferir(
      html.includes('Agendei — marcar como atendido'),
      'a recepção vê o botão de trabalho da fila',
    )

    console.log('\n\x1b[36m2.\x1b[0m O dentista VÊ a fila e NÃO a trabalha')
    /**
     * `relacionamento: ['ler']` para o dentista — ele vê e não age.
     *
     * A tela abre de propósito: esconder seria pior, porque ele precisa saber que o
     * paciente está esperando por um horário. O que não aparece são os botões.
     *
     * Este par de asserções é o que prova o `podeTrabalhar`: só o "não vê o botão" seria
     * verdade também se a página tivesse quebrado, então ele vem acompanhado do "vê o
     * paciente" — que só é possível se a tela renderizou.
     */
    const dentista = await criarUsuario('dentista')
    dentistaId = dentista.id
    const cookieDentista = await entrar(dentista.email, dentista.segredo)
    const rd = await fetch(`${BASE}/espera`, {
      headers: { cookie: cookieDentista },
      redirect: 'manual',
    })
    const htmlDentista = rd.status === 200 ? await rd.text() : ''
    conferir(rd.status === 200, `/espera responde 200 para o dentista (${rd.status})`)
    conferir(
      htmlDentista.includes(`${MARCA} Paciente da fila`),
      'o dentista vê quem está na fila (senão o caso abaixo seria vazio)',
    )
    conferir(
      !htmlDentista.includes('Agendei — marcar como atendido'),
      'o dentista NÃO vê o botão de trabalhar a fila',
    )
    conferir(
      htmlDentista.includes('vê a fila e não a trabalha'),
      'a tela explica ao dentista por que ele não tem os botões',
    )

    const cookieFinanceiro = await entrar(financeiro.email, financeiro.segredo)
    const rf = await fetch(`${BASE}/espera`, {
      headers: { cookie: cookieFinanceiro },
      redirect: 'manual',
    })
    conferir(rf.status === 200, `/espera responde 200 para o financeiro (${rf.status})`)

    console.log('\n\x1b[36m3.\x1b[0m Perfil sem o recurso vai para /sem-permissao')
    /**
     * A recepção **não** tem `usuario` — é o recurso do admin. Usar uma rota que ela
     * não pode abrir prova a trava de permissão sem precisar inventar um perfil que
     * não existe na matriz.
     *
     * Isto é sobre a MESMA trava que protege `/espera`: `exigirPermissaoPagina`. Se ela
     * estivesse quebrada, este caso reprovaria — e o caso 1 passaria de qualquer jeito,
     * o que é exatamente por que ele sozinho não bastaria.
     */
    const semPermissao = await fetch(`${BASE}/usuarios`, {
      headers: { cookie: cookieRecepcao },
      redirect: 'manual',
    })
    const foiBarrada =
      semPermissao.status !== 200 ||
      (await semPermissao.text()).includes('sem-permissao') ||
      (semPermissao.headers.get('location') ?? '').includes('sem-permissao')
    conferir(foiBarrada, `recepção barrada em /usuarios (${semPermissao.status})`)

    console.log('\n\x1b[36m4.\x1b[0m Encerrar sem motivo é recusado')
    // A regra está no domínio (`encerrarEsperaComAtor`) e no CHECK do banco. O caso
    // existe para provar que a tela não tem um caminho que fure as duas.
    const { encerrarEsperaComAtor } = await import('./fila')
    const semMotivo = await encerrarEsperaComAtor(
      { usuarioId: recepcao.id, clinicaId: await idDaPrimeiraClinica(), nome: 'x', email: recepcao.email, perfil: 'recepcao', profissionalId: null },
      { id: pedido!.id, situacao: 'encerrada' },
    )
    conferir(!semMotivo.ok, `recusado: "${semMotivo.mensagem}"`)

    const comMotivo = await encerrarEsperaComAtor(
      { usuarioId: recepcao.id, clinicaId: await idDaPrimeiraClinica(), nome: 'x', email: recepcao.email, perfil: 'recepcao', profissionalId: null },
      { id: pedido!.id, situacao: 'encerrada', motivo: 'Desistiu por telefone' },
    )
    conferir(comMotivo.ok, `aceito com motivo: "${comMotivo.mensagem}"`)

    // Duplo encerramento: o `where situacao = 'aguardando'` é o que impede o segundo
    // clique sobrescrever o motivo do primeiro com outro carimbo de hora.
    const deNovo = await encerrarEsperaComAtor(
      { usuarioId: recepcao.id, clinicaId: await idDaPrimeiraClinica(), nome: 'x', email: recepcao.email, perfil: 'recepcao', profissionalId: null },
      { id: pedido!.id, situacao: 'atendida' },
    )
    conferir(!deNovo.ok, `segundo encerramento recusado: "${deNovo.mensagem}"`)
  } finally {
    await limpar([recepcao.id, financeiro.id, ...(dentistaId ? [dentistaId] : [])], [pac!.id])
  }

  console.log(
    falhas === 0
      ? '\n\x1b[32m═══ Tela da lista de espera conferida ═══\x1b[0m\n'
      : `\n\x1b[31m═══ ${falhas} FALHA(S) ═══\x1b[0m\n`,
  )
  process.exitCode = falhas > 0 ? 1 : 0
}

async function limpar(usuarios: readonly string[], pacientes: readonly string[]): Promise<void> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query('select set_config($1, $2, true)', [
      'app.clinica_id',
      await idDaPrimeiraClinica(),
    ])
    // `DISABLE TRIGGER USER`, nunca `session_replication_role` — o atalho desliga
    // também as triggers internas de FK e já deixou cinco linhas órfãs que depois
    // impediram uma migration de criar FK composto. O helper religa antes do commit e
    // **confere** que religou: `DISABLE TRIGGER` é DDL, e comitar com ela desligada a
    // deixa desligada para sempre.
    const desligadas = await desligarTriggersDeAplicacao(c)
    await c.query('delete from lista_espera where paciente_id = any($1)', [pacientes])
    await c.query('delete from audit_log where paciente_id = any($1)', [pacientes])
    await c.query("delete from audit_log where ator_email like 'esp-%@local'")
    await c.query('delete from paciente where id = any($1)', [pacientes])
    /**
     * `profissional` e `usuario` na MESMA transação, nesta ordem.
     *
     * A trava deferida de `drizzle/0021` cobra no COMMIT que dentista ativo tenha
     * cadastro de profissional — apagar `profissional` solto comita sozinho e dispara.
     * Dentro de uma transação, no commit as duas linhas já não existem e não há o que
     * verificar. A lição valia para a criação e vale igual para a limpeza.
     */
    await c.query('delete from profissional where usuario_id = any($1)', [usuarios])
    await c.query('delete from usuario where id = any($1)', [usuarios])
    await religarTriggersDeAplicacao(c, desligadas)
    await c.query('commit')
    console.log('\nDados da verificação removidos.')
  } catch (e) {
    await c.query('rollback')
    console.error('Falha ao limpar:', e)
  } finally {
    c.release()
  }
}

idDaPrimeiraClinica()
  .then((clinicaId) => comContextoDeClinica(clinicaId, main))
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e)
    await pool.end()
    process.exit(1)
  })
