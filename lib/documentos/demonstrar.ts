import { createHash, randomUUID } from 'node:crypto'
import { armazenamento } from '@/lib/armazenamento'
import { gerarCodigoTotp, gerarSegredoTotp } from '@/lib/auth/totp'
import { gerarHashSenha } from '@/lib/auth/senha'
import type { Ator } from '@/lib/authz/sessao'
import { db, pool } from '@/lib/db'
import { auditLog, documento, paciente, profissional, usuario } from '@/lib/db/schema'
import { LIMITE_BYTES } from '@/lib/domain/arquivo'
import { anexarComAtor } from './anexar'
import { comparacoesPorDente, documentosDoPaciente, documentosRemovidos } from './consultas'
import { and, eq } from 'drizzle-orm'

/**
 * Demonstração ponta a ponta da Fase 10, contra o Postgres e o disco de verdade.
 *
 * `npm run documentos:demo` (dentro do container, ver README).
 *
 * Cobre o que teste unitário não cobre: a costura entre validação, storage, banco
 * e a rota HTTP de download — inclusive os dois casos que importam mais e que só
 * aparecem com arquivo real no disco:
 *
 *   - **integridade**: arquivo trocado no storage bloqueia o download
 *   - **compensação**: falha no banco não deixa arquivo órfão
 *
 * Limpa tudo no final.
 */

const BASE = 'http://localhost:3000'
const SENHA = 'Demo-Documentos-2026!x'
const EMAIL_DENTISTA = 'demo-doc-dentista@local'
const EMAIL_FINANCEIRO = 'demo-doc-financeiro@local'

function passo(n: number, texto: string): void {
  console.log(`\n\x1b[36m${n}.\x1b[0m ${texto}`)
}

function conferir(condicao: boolean, texto: string): void {
  if (condicao) {
    console.log(`   \x1b[32m✓\x1b[0m ${texto}`)
  } else {
    console.error(`   \x1b[31m✗ ${texto}\x1b[0m`)
    process.exitCode = 1
    throw new Error(texto)
  }
}

/** JPEG mínimo mas real: assinatura + carga variada. */
function jpeg(semente: number, bytes = 4096): Uint8Array {
  const b = new Uint8Array(bytes)
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
  for (let i = 10; i < bytes; i++) b[i] = (i * semente + 13) % 256
  return b
}

function juntarCookies(...listas: string[][]): string {
  const mapa = new Map<string, string>()
  for (const lista of listas) {
    for (const bruto of lista) {
      const par = bruto.split(';')[0]!
      mapa.set(par.slice(0, par.indexOf('=')), par)
    }
  }
  return [...mapa.values()].join('; ')
}

async function criarUsuario(
  email: string,
  perfil: 'dentista' | 'financeiro',
): Promise<{ ator: Ator; segredo: string }> {
  const segredo = gerarSegredoTotp()
  // As duas linhas na MESMA transação: a trava deferida de `drizzle/0021` cobra
  // no commit que dentista ativo tenha cadastro de profissional.
  const { u, profissionalId } = await db.transaction(async (tx) => {
    const [novoUsuario] = await tx
      .insert(usuario)
      .values({
        nome: `Demo ${perfil}`,
        email,
        senhaHash: await gerarHashSenha(SENHA),
        perfil,
        mfaSecret: segredo,
        mfaAtivo: true,
      })
      .returning({ id: usuario.id })

    let id: string | null = null
    if (perfil === 'dentista') {
      const [p] = await tx
        .insert(profissional)
        .values({ usuarioId: novoUsuario!.id, cro: `X${Date.now() % 100000}`, ufCro: 'SP' })
        .returning({ id: profissional.id })
      id = p!.id
    }
    return { u: novoUsuario, profissionalId: id }
  })

  return {
    ator: { usuarioId: u!.id, nome: `Demo ${perfil}`, email, perfil, profissionalId },
    segredo,
  }
}

async function entrar(email: string, segredo: string): Promise<string> {
  const r1 = await fetch(`${BASE}/api/auth/csrf`)
  const c1 = juntarCookies(r1.headers.getSetCookie())
  const { csrfToken } = (await r1.json()) as { csrfToken: string }

  const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: c1 },
    body: new URLSearchParams({
      email,
      senha: SENHA,
      codigo: gerarCodigoTotp(segredo),
      csrfToken,
      callbackUrl: BASE,
      json: 'true',
    }),
    redirect: 'manual',
  })

  const cookies = juntarCookies(c1.split('; '), r2.headers.getSetCookie())
  if (!cookies.includes('authjs.session-token')) {
    throw new Error(`login falhou para ${email}: ${r2.status}`)
  }
  return cookies
}

async function main(): Promise<void> {
  console.log('\n═══ Fase 10 ponta a ponta ═══')

  const store = armazenamento()
  console.log(`   provedor de armazenamento: ${store.nome}`)

  const dentista = await criarUsuario(EMAIL_DENTISTA, 'dentista')
  const financeiro = await criarUsuario(EMAIL_FINANCEIRO, 'financeiro')

  const [pac] = await db
    .insert(paciente)
    .values({ nome: 'Demo Documentos', dataNascimento: '1979-04-22' })
    .returning({ id: paciente.id })
  const pacienteId = pac!.id

  try {
    passo(1, 'Anexar radiografia inicial do dente 11')
    const antes = jpeg(7)
    const r1 = await anexarComAtor(
      dentista.ator,
      {
        pacienteId,
        tipo: 'radiografia',
        nome: 'Periapical 11 antes.jpg',
        denteFdi: 11,
        etapa: 'inicial',
        dataExame: '2026-03-10',
      },
      antes,
      'image/jpeg',
    )
    conferir(r1.ok, r1.ok ? `anexado: ${r1.id}` : r1.mensagem)
    if (!r1.ok) return

    const [gravado] = await db
      .select({
        storageKey: documento.storageKey,
        sha256: documento.sha256,
        mimeType: documento.mimeType,
        tamanho: documento.tamanhoBytes,
      })
      .from(documento)
      .where(eq(documento.id, r1.id))

    conferir(
      gravado!.storageKey === `pacientes/${pacienteId}/2026/${r1.id}.jpg`,
      `chave derivada do id, não do nome: ${gravado!.storageKey}`,
    )
    conferir(
      gravado!.sha256 === createHash('sha256').update(antes).digest('hex'),
      'sha256 do conteúdo gravado no banco',
    )
    conferir(await store.existe(gravado!.storageKey), 'arquivo existe no armazenamento')

    passo(2, 'Anexar a radiografia final do mesmo dente')
    const depois = jpeg(29)
    const r2 = await anexarComAtor(
      dentista.ator,
      {
        pacienteId,
        tipo: 'radiografia',
        nome: 'Periapical 11 depois.jpg',
        denteFdi: 11,
        etapa: 'final',
        dataExame: '2026-06-15',
      },
      depois,
      'image/jpeg',
    )
    conferir(r2.ok, r2.ok ? `anexado: ${r2.id}` : r2.mensagem)
    if (!r2.ok) return

    passo(3, 'O par antes/depois aparece pareado por dente')
    const pares = await comparacoesPorDente(pacienteId)
    conferir(pares.length === 1, `${pares.length} dente com comparação completa`)
    conferir(pares[0]!.denteFdi === 11, `dente ${pares[0]!.denteFdi}`)
    conferir(
      pares[0]!.inicial!.id === r1.id && pares[0]!.final!.id === r2.id,
      'inicial e final na ordem certa',
    )

    passo(4, 'Arquivo que mente sobre o tipo é recusado')
    const falso = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3, 4])
    const r3 = await anexarComAtor(
      dentista.ator,
      { pacienteId, tipo: 'foto_clinica', nome: 'foto.jpg' },
      falso,
      'image/jpeg',
    )
    conferir(!r3.ok, r3.ok ? 'ACEITOU um executável como foto' : `recusado: ${r3.mensagem}`)

    passo(5, 'Arquivo acima do limite do tipo é recusado')
    const grande = jpeg(3, LIMITE_BYTES.foto_clinica + 1024)
    const r4 = await anexarComAtor(
      dentista.ator,
      { pacienteId, tipo: 'foto_clinica', nome: 'gigante.jpg' },
      grande,
      'image/jpeg',
    )
    conferir(!r4.ok, r4.ok ? 'ACEITOU acima do limite' : `recusado: ${r4.mensagem}`)

    passo(6, 'Divergência entre extensão e conteúdo é aceita, mas avisada')
    // PNG declarado, JPEG de verdade: grava como JPEG e avisa.
    const r5 = await anexarComAtor(
      dentista.ator,
      { pacienteId, tipo: 'foto_clinica', nome: 'sorriso.png' },
      jpeg(11),
      'image/png',
    )
    conferir(r5.ok, r5.ok ? 'aceito' : r5.mensagem)
    if (r5.ok) {
      conferir(!!r5.aviso, `avisou: ${r5.aviso}`)
      const [m] = await db
        .select({ mime: documento.mimeType })
        .from(documento)
        .where(eq(documento.id, r5.id))
      conferir(m!.mime === 'image/jpeg', `mime gravado é o real: ${m!.mime}`)
    }

    passo(7, 'Falha no banco NÃO deixa arquivo órfão no armazenamento')
    // Paciente inexistente: a chave estrangeira derruba o insert depois de o
    // arquivo já ter sido gravado. A compensação tem de apagá-lo.
    const fantasma = randomUUID()
    const antesDeTudo = await contarArquivos(store, fantasma)
    const r6 = await anexarComAtor(
      dentista.ator,
      { pacienteId: fantasma, tipo: 'radiografia', nome: 'orfa.jpg' },
      jpeg(41),
      'image/jpeg',
    )
    conferir(!r6.ok, r6.ok ? 'inseriu para paciente inexistente' : 'insert recusado pelo banco')
    conferir(
      (await contarArquivos(store, fantasma)) === antesDeTudo,
      'nenhum arquivo sobrou no armazenamento',
    )

    passo(8, 'Download pela rota: autorizado, com o tipo e o nome certos')
    const cookieDentista = await entrar(EMAIL_DENTISTA, dentista.segredo)
    const resposta = await fetch(`${BASE}/api/documentos/${r1.id}`, {
      headers: { cookie: cookieDentista },
    })
    conferir(resposta.status === 200, `status ${resposta.status}`)
    conferir(
      resposta.headers.get('content-type') === 'image/jpeg',
      `content-type: ${resposta.headers.get('content-type')}`,
    )
    conferir(
      (resposta.headers.get('content-disposition') ?? '').includes('Periapical-11-antes.jpg'),
      `nome higienizado: ${resposta.headers.get('content-disposition')}`,
    )
    conferir(
      resposta.headers.get('x-content-type-options') === 'nosniff',
      'nosniff presente',
    )
    conferir(
      (resposta.headers.get('cache-control') ?? '').includes('no-store'),
      `cache privado: ${resposta.headers.get('cache-control')}`,
    )
    const baixado = new Uint8Array(await resposta.arrayBuffer())
    conferir(
      createHash('sha256').update(baixado).digest('hex') ===
        createHash('sha256').update(antes).digest('hex'),
      'bytes baixados são idênticos aos enviados',
    )

    passo(9, 'Sem sessão, nem 200 nem vazamento')
    const semSessao = await fetch(`${BASE}/api/documentos/${r1.id}`, { redirect: 'manual' })
    conferir(
      semSessao.status !== 200,
      `status ${semSessao.status}${semSessao.headers.get('location') ? ` → ${semSessao.headers.get('location')}` : ''}`,
    )

    passo(10, 'Perfil sem permissão de documento leva 403')
    const cookieFinanceiro = await entrar(EMAIL_FINANCEIRO, financeiro.segredo)
    const negado = await fetch(`${BASE}/api/documentos/${r1.id}`, {
      headers: { cookie: cookieFinanceiro },
      redirect: 'manual',
    })
    conferir(negado.status === 403, `status ${negado.status} para o financeiro`)

    passo(11, 'INTEGRIDADE: arquivo trocado no armazenamento bloqueia o download')
    // Simula troca do objeto no storage por baixo do registro.
    await store.remover(gravado!.storageKey)
    await store.salvar(gravado!.storageKey, jpeg(99), 'image/jpeg')

    const adulterado = await fetch(`${BASE}/api/documentos/${r1.id}`, {
      headers: { cookie: cookieDentista },
    })
    conferir(adulterado.status === 500, `status ${adulterado.status}`)
    const textoErro = await adulterado.text()
    conferir(
      textoErro.includes('não corresponde'),
      `mensagem explica: "${textoErro.slice(0, 60)}"`,
    )

    passo(12, 'Remoção lógica: exige motivo e autor, e some da listagem')
    await db
      .update(documento)
      .set({
        removidoEm: new Date(),
        motivoRemocao: 'demonstração',
        removidoPorId: dentista.ator.usuarioId,
      })
      .where(eq(documento.id, r2.id))

    const listados = await documentosDoPaciente(dentista.ator, pacienteId)
    conferir(
      !listados.some((d) => d.id === r2.id),
      'documento removido não aparece na listagem',
    )
    const removidos = await documentosRemovidos(pacienteId)
    conferir(removidos.length === 1, `${removidos.length} na trilha de removidos, com motivo`)

    passo(13, 'Download de documento removido é 404, igual ao inexistente')
    const removido = await fetch(`${BASE}/api/documentos/${r2.id}`, {
      headers: { cookie: cookieDentista },
    })
    conferir(removido.status === 404, `status ${removido.status}`)
    const inexistente = await fetch(`${BASE}/api/documentos/${randomUUID()}`, {
      headers: { cookie: cookieDentista },
    })
    conferir(inexistente.status === 404, `inexistente também 404 (${inexistente.status})`)

    passo(14, 'Todo acesso deixou rastro na auditoria')
    const trilha = await db
      .select({ acao: auditLog.acao, entidade: auditLog.entidade })
      .from(auditLog)
      .where(and(eq(auditLog.pacienteId, pacienteId), eq(auditLog.entidade, 'documento')))
    const criacoes = trilha.filter((t) => t.acao === 'criacao').length
    const exportacoes = trilha.filter((t) => t.acao === 'exportacao').length
    const leituras = trilha.filter((t) => t.acao === 'leitura').length
    conferir(criacoes === 3, `${criacoes} criações registradas`)
    conferir(exportacoes >= 1, `${exportacoes} download(s) registrado(s)`)
    conferir(leituras >= 1, `${leituras} leitura(s) de listagem registrada(s)`)

    console.log('\n\x1b[32m═══ Upload, download, integridade e auditoria verificados ═══\x1b[0m\n')
  } finally {
    await limpar(pacienteId)
  }
}

/**
 * Conta arquivos gravados para um paciente, olhando o ARMAZENAMENTO.
 *
 * Tem de ser assim, e não pelo banco: um arquivo órfão é justamente o que existe
 * no storage **sem** linha no banco — contar linhas daria zero sempre e o teste
 * não provaria nada.
 *
 * Específico do provedor em disco, por isso o `if`: a interface não tem
 * `listar()` de propósito (nada na aplicação precisa listar o bucket, e uma
 * listagem é exatamente o que não se quer expor num bucket de prontuário).
 */
async function contarArquivos(
  store: ReturnType<typeof armazenamento>,
  pacienteId: string,
): Promise<number> {
  if (store.nome !== 'disco') return 0

  const raiz = process.env.ARMAZENAMENTO_RAIZ ?? '/tmp/dent-anexos'
  const { readdir } = await import('node:fs/promises')
  const { join } = await import('node:path')

  async function contar(dir: string): Promise<number> {
    let n = 0
    try {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory()) n += await contar(join(dir, String(e.name)))
        else n++
      }
    } catch {
      // Diretório não existe = nenhum arquivo, que é a resposta certa.
      return 0
    }
    return n
  }

  return contar(join(raiz, 'pacientes', pacienteId))
}

async function limpar(pacienteId: string): Promise<void> {
  const store = armazenamento()

  const chaves = await db
    .select({ chave: documento.storageKey })
    .from(documento)
    .where(eq(documento.pacienteId, pacienteId))
  for (const { chave } of chaves) {
    try {
      await store.remover(chave)
    } catch {
      // Já removido pela compensação.
    }
  }

  const cliente = await pool.connect()
  try {
    await cliente.query('begin')
    // As triggers proíbem DELETE em documento — é a garantia legal. Só a
    // demonstração as desliga, e só dentro desta transação.
    await cliente.query("set local session_replication_role = 'replica'")
    await cliente.query('delete from documento where paciente_id = $1', [pacienteId])
    await cliente.query('delete from audit_log where paciente_id = $1', [pacienteId])
    await cliente.query('delete from paciente where id = $1', [pacienteId])
    await cliente.query(
      'delete from profissional where usuario_id in (select id from usuario where email = any($1))',
      [[EMAIL_DENTISTA, EMAIL_FINANCEIRO]],
    )
    await cliente.query('delete from usuario where email = any($1)', [
      [EMAIL_DENTISTA, EMAIL_FINANCEIRO],
    ])
    await cliente.query('commit')
    console.log('Dados da demonstração removidos.')
  } catch (e) {
    await cliente.query('rollback')
    console.error('Falha ao limpar a demonstração:', e)
  } finally {
    cliente.release()
  }
}

main()
  .then(async () => {
    await pool.end()
    process.exit(process.exitCode ?? 0)
  })
  .catch(async (e) => {
    console.error(e)
    await pool.end()
    process.exit(1)
  })
