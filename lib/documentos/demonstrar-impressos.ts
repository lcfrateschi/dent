import { gerarHashSenha } from '@/lib/auth/senha'
import { gerarSegredoTotp } from '@/lib/auth/totp'
import type { Ator } from '@/lib/authz/sessao'
import { db, pool } from '@/lib/db'
import { documento, paciente, profissional, usuario } from '@/lib/db/schema'
import { idDaPrimeiraClinica } from '@/lib/demo/clinicaDaDemo'
import { comContextoDeClinica } from '@/lib/tenant/contexto'
import { eq } from 'drizzle-orm'
import { emitirAtestado, emitirReceita } from './emitir'

/**
 * Emite atestado e receita de verdade e **deixa os PDFs no disco**.
 *
 *   npm run impressos:demo
 *
 * ── Por que este script existe ──────────────────────────────────────────────
 * `emitirAtestado` e `emitirReceita` só eram chamados pelas server actions, ou seja:
 * **o gerador de PDF nunca era exercitado fora do navegador**. `lib/documentos/pdf.test.ts`
 * prova a estrutura do arquivo (a tabela xref é relida), e `documentos:demo` prova
 * upload, download, integridade e auditoria — mas ninguém montava um impresso do
 * começo ao fim.
 *
 * A consequência estava escrita na lista de pendências do `CLAUDE.md`: *"O PDF gerado
 * nunca foi aberto num visualizador por mim. Layout fino — margem, alinhamento —
 * merece uma olhada humana antes de o primeiro atestado sair para valer."* Não se
 * pode olhar o que não existe em disco.
 *
 * ── O que ele NÃO faz, de propósito ────────────────────────────────────────
 * Não apaga os arquivos no fim. Todo outro script de demonstração limpa o que criou,
 * e aqui o artefato **é** o entregável: o PDF fica para ser aberto. O que ele limpa é
 * o banco (usuário, paciente, documento), para não deixar pessoa fictícia no
 * cadastro. Então sim: sobra arquivo órfão no volume de anexos, e isso é dito na
 * saída em vez de ficar implícito.
 *
 * Também não confere layout: alinhamento e margem não têm asserção possível que
 * signifique algo. O que ele confere é o que dá para afirmar por programa — que o
 * arquivo é PDF, que tem as páginas que devia, e que o CID **não** foi impresso sem
 * autorização, que é regra de domínio e não de aparência.
 */

const SENHA = 'Impressos-Demo-2026'

/**
 * CPF válido e diferente a cada execução.
 *
 * Um CPF fixo colide com `paciente_cpf_uk` na segunda rodada — e o CPF é **por
 * clínica** desde a `drizzle/0022`, então a colisão acontece dentro da mesma clínica,
 * que é o caso legítimo. O atestado imprime o CPF, e é justamente essa linha do
 * layout que se quer olhar, então não dá para simplesmente omiti-lo.
 *
 * Os dígitos verificadores são calculados, não sorteados: `lib/domain/cpf.ts` recusa
 * CPF inválido, e é bom que recuse.
 */
function cpfValidoAleatorio(): string {
  const base = String(Date.now()).slice(-9).padStart(9, '0')
  const digito = (parcial: string): number => {
    const peso = parcial.length + 1
    const soma = [...parcial].reduce((acc, d, i) => acc + Number(d) * (peso - i), 0)
    const resto = (soma * 10) % 11
    return resto === 10 ? 0 : resto
  }
  const d1 = digito(base)
  const d2 = digito(`${base}${d1}`)
  return `${base}${d1}${d2}`
}

let falhas = 0
function conferir(ok: boolean, texto: string): void {
  if (ok) {
    console.log(`   \x1b[32m✓\x1b[0m ${texto}`)
  } else {
    console.log(`   \x1b[31m✗ ${texto}\x1b[0m`)
    falhas++
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('impressos:demo cria pessoas fictícias. Não roda em produção.')
  }

  console.log('\n═══ Impressos: atestado e receita ponta a ponta ═══\n')

  const segredo = gerarSegredoTotp()
  const email = `impressos-${Date.now()}@demo.local`

  // As duas linhas na MESMA transação: a trava deferida de `drizzle/0021` cobra no
  // commit que dentista ativo tenha cadastro de profissional.
  const { u, profissionalId } = await db.transaction(async (tx) => {
    const [novo] = await tx
      .insert(usuario)
      .values({
        nome: 'Dra. Demonstração de Impressos',
        email,
        senhaHash: await gerarHashSenha(SENHA),
        perfil: 'dentista',
        mfaSecret: segredo,
        mfaAtivo: true,
      })
      // `clinicaId` do returning: o tenant do Ator é o do USUÁRIO, lido da linha que
      // acabou de nascer — nunca de `clinicaAtual()`, que num banco com duas clínicas
      // montaria um ator cuja clínica não é a do seu próprio usuário.
      .returning({ id: usuario.id, clinicaId: usuario.clinicaId })
    const [p] = await tx
      .insert(profissional)
      .values({ usuarioId: novo!.id, cro: `IMP${Date.now() % 100000}`, ufCro: 'SP' })
      .returning({ id: profissional.id })
    return { u: novo!, profissionalId: p!.id }
  })

  const ator: Ator = {
    usuarioId: u.id,
    clinicaId: u.clinicaId,
    nome: 'Dra. Demonstração de Impressos',
    email,
    perfil: 'dentista',
    profissionalId,
  }

  const [pac] = await db
    .insert(paciente)
    .values({
      nome: 'Joana Pereira de Almeida Souza',
      dataNascimento: '1987-03-14',
      cpf: cpfValidoAleatorio(),
      telefone: '11987654321',
    })
    .returning({ id: paciente.id })

  const criados: string[] = []

  // ── 1. Atestado com afastamento, e o CID que NÃO deve sair ────────────────
  console.log('\x1b[36m1.\x1b[0m Atestado de afastamento, com CID não autorizado')
  const atestado = await emitirAtestado(ator, {
    pacienteId: pac!.id,
    atendidoEm: new Date(),
    diasAfastamento: 3,
    cid: 'K08.1',
    // Falso de propósito: o padrão é NÃO imprimir, e a tela avisa que não imprimiu.
    // O atestado costuma ir para o RH da empresa, e o diagnóstico é dado de saúde.
    cidAutorizadoPeloPaciente: false,
    observacao: 'Repouso relativo, dieta líquida nas primeiras 24 horas.',
  })
  conferir(atestado.resultado.ok, atestado.resultado.mensagem)
  conferir(
    atestado.avisos.some((a) => a.toLowerCase().includes('cid')),
    `avisou que o CID não foi impresso: ${atestado.avisos.join(' | ') || '(nenhum aviso)'}`,
  )
  if (atestado.resultado.ok && atestado.resultado.id) criados.push(atestado.resultado.id)

  // ── 2. Receita ────────────────────────────────────────────────────────────
  console.log('\n\x1b[36m2.\x1b[0m Receita com dois medicamentos')
  const receita = await emitirReceita(ator, {
    pacienteId: pac!.id,
    medicamentos: [
      {
        nome: 'Amoxicilina 500 mg',
        apresentacao: 'cápsula',
        quantidade: '21 cápsulas',
        posologia: 'Tomar 1 cápsula de 8 em 8 horas por 7 dias.',
      },
      {
        nome: 'Dipirona sódica 500 mg',
        apresentacao: 'comprimido',
        quantidade: '10 comprimidos',
        posologia: 'Tomar 1 comprimido em caso de dor, no máximo de 6 em 6 horas.',
      },
    ],
  })
  conferir(receita.resultado.ok, receita.resultado.mensagem)
  if (receita.resultado.ok && receita.resultado.id) criados.push(receita.resultado.id)

  // ── 3. Os arquivos ────────────────────────────────────────────────────────
  console.log('\n\x1b[36m3.\x1b[0m Os arquivos no disco')
  const chaves: string[] = []
  for (const id of criados) {
    const [d] = await db
      .select({ chave: documento.storageKey, tamanho: documento.tamanhoBytes, nome: documento.nome })
      .from(documento)
      .where(eq(documento.id, id))
    if (!d) continue
    chaves.push(d.chave)
    // 1 KB é o piso de um PDF com cabeçalho, corpo e xref. Abaixo disso não é
    // "PDF pequeno", é PDF que não se abre — e foi assim que descobri que os
    // arquivos que estavam no volume eram fixtures de 41 bytes, não PDF nenhum.
    conferir(d.tamanho > 1024, `${d.nome}: ${d.tamanho} bytes — ${d.chave}`)
    conferir(
      d.chave.startsWith(`clinicas/${ator.clinicaId}/`),
      'a chave está dentro do prefixo da clínica',
    )
  }

  // ── 4. Limpa o BANCO e deixa os ARQUIVOS ──────────────────────────────────
  //
  // A ordem importa: apagar `documento` antes de imprimir as chaves deixaria o
  // operador sem saber o que abrir.
  console.log('\n\x1b[36m4.\x1b[0m Limpeza')
  for (const id of criados) {
    // `documento` tem trigger que bloqueia exclusão (remoção é de mão única, com
    // motivo). Aqui é dado de demonstração, então a exclusão é feita com as
    // triggers de aplicação desligadas — e religadas, conferindo.
    await db.execute(
      `alter table documento disable trigger user;
       delete from documento where id = '${id}';
       alter table documento enable trigger user;`,
    )
  }
  /**
   * As três exclusões na MESMA transação, e o motivo é o mesmo da criação — só que
   * do outro lado.
   *
   * A trava deferida de `drizzle/0021` cobra **no commit** que usuário de perfil
   * `dentista` ativo tenha linha em `profissional`. Apagar `profissional` solto
   * comita sozinho e a trava dispara:
   *
   *   Usuário … tem perfil dentista e nenhum cadastro de profissional:
   *   sem CRO não assina evolução nem apura comissão.
   *
   * Dentro de uma transação, no commit as duas linhas já não existem e não há o que
   * verificar. O `CLAUDE.md` registra essa lição para a CRIAÇÃO ("fixture de dentista
   * precisa de transação"); ela vale igual para a limpeza, e eu redescobri aqui.
   */
  await db.transaction(async (tx) => {
    await tx.delete(paciente).where(eq(paciente.id, pac!.id))
    await tx.delete(profissional).where(eq(profissional.id, profissionalId))
    await tx.delete(usuario).where(eq(usuario.id, u.id))
  })
  console.log('   ✓ banco limpo (pessoa fictícia removida)')

  const desligadas = await db.execute(
    `select count(*)::int as n from pg_trigger where not tgisinternal and tgenabled = 'D'`,
  )
  const n = (desligadas.rows[0] as { n: number } | undefined)?.n ?? -1
  conferir(n === 0, `nenhuma trigger ficou desligada (${n})`)

  console.log('\n' + '─'.repeat(70))
  console.log('  OS PDFs FICARAM NO DISCO, de propósito — abra e olhe:')
  for (const c of chaves) console.log(`    /anexos/${c}`)
  console.log('')
  console.log('  Para trazer ao host:')
  console.log(
    `    docker cp $(docker compose ps -q app):/anexos/${chaves[0] ?? '<chave>'} ./atestado.pdf`,
  )
  console.log('')
  console.log('  ⚠ São arquivos ÓRFÃOS: o registro no banco foi removido e eles não.')
  console.log('    Layout — margem, alinhamento, quebra — não tem asserção que signifique')
  console.log('    algo. Isso é conferência humana, e é para isso que eles existem.')
  console.log('─'.repeat(70))
}

idDaPrimeiraClinica()
  .then((clinicaId) => comContextoDeClinica(clinicaId, main))
  .then(async () => {
    await pool.end()
    console.log(
      falhas === 0
        ? '\n\x1b[32m═══ Impressos emitidos e conferidos ═══\x1b[0m\n'
        : `\n\x1b[31m${falhas} falha(s).\x1b[0m\n`,
    )
    process.exit(falhas > 0 ? 1 : 0)
  })
  .catch(async (e) => {
    console.error(e)
    await pool.end()
    process.exit(1)
  })
