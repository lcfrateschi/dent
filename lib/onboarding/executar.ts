import { pool } from '@/lib/db'
import { criarClinica, mudarSituacao } from './criar'

/**
 * O comando do operador.
 *
 *   npm run clinica:criar -- --razao-social="Clínica X Ltda" --cnpj=11222333000181 \
 *                            --plano=profissional --admin-nome="Dra. Y" --admin-email=y@x.com
 *
 *   npm run clinica:situacao -- --clinica=<uuid> --situacao=suspensa --motivo="boleto 3 meses"
 *
 * Precisa da credencial do **dono** do banco. O container do `app` não a tem, de
 * propósito — ver o cabeçalho de `criar.ts`:
 *
 *   docker compose exec -T \
 *     -e DATABASE_URL=postgres://facilident:...@db:5432/facilident \
 *     app npm run clinica:criar -- …
 *
 * ── Por que se recusa a rodar em produção sem confirmação ───────────────────
 * Não se recusa. Criar clínica em produção é justamente o objetivo. O que ele NÃO
 * faz é apagar nada, e o que ele imprime — a senha temporária — aparece uma vez e
 * não vai para o `audit_log`.
 */

function arg(nome: string): string | undefined {
  const prefixo = `--${nome}=`
  return process.argv.find((a) => a.startsWith(prefixo))?.slice(prefixo.length)
}

function exigir(nome: string): string {
  const v = arg(nome)
  if (!v) {
    console.error(`ERRO: --${nome}= é obrigatório.`)
    process.exit(1)
  }
  return v
}

async function criar(): Promise<void> {
  const r = await criarClinica({
    razaoSocial: exigir('razao-social'),
    cnpj: exigir('cnpj'),
    nomeFantasia: arg('nome-fantasia'),
    plano: arg('plano') ?? 'profissional',
    adminNome: exigir('admin-nome'),
    adminEmail: exigir('admin-email'),
  })

  if (!r.ok) {
    console.error(`\n\x1b[31m${r.mensagem}\x1b[0m`)
    process.exitCode = 1
    return
  }

  console.log(`\n${r.resumo}`)
  console.log(`  clínica: ${r.clinicaId}`)

  /**
   * ── O que decide imprimir a senha é a SENHA, não `criada` ──────────────────
   *
   * A primeira versão ramificava em `r.criada`. Parecia certo e engolia a senha na
   * retomada: uma clínica que tinha ficado pela metade era completada, um admin
   * novo nascia com senha temporária — e o script imprimia "Nada foi criado" e
   * voltava. Ficou um administrador no banco cuja senha ninguém sabia. Aconteceu
   * de verdade, com a clínica que a minha própria primeira tentativa deixou pela
   * metade.
   *
   * `criada` responde "o tenant nasceu agora?"; a pergunta que importa aqui é
   * "existe credencial nova para entregar?". São diferentes na retomada, e é
   * exatamente ali que o erro dói.
   */
  if (!r.senhaTemporaria) {
    console.log('\n\x1b[33mNenhuma credencial nova — esta clínica já estava completa.\x1b[0m')
    console.log('  Senha perdida se resolve com reset por um admin, não repetindo este comando.')
    return
  }

  console.log('\n' + '─'.repeat(68))
  console.log('  PRIMEIRO ACESSO — aparece UMA vez, não é recuperável')
  console.log(`    e-mail: ${r.adminEmail}`)
  console.log(`    senha:  ${r.senhaTemporaria}`)
  console.log('')
  console.log('  A pessoa vai configurar o autenticador ANTES de trocar a senha:')
  console.log('  trocar já protegido por segundo fator é melhor que trocar com a')
  console.log('  credencial que circulou por telefone.')
  console.log('─'.repeat(68))
}

async function situacao(): Promise<void> {
  const s = exigir('situacao')
  if (s !== 'ativa' && s !== 'suspensa' && s !== 'cancelada') {
    console.error('ERRO: --situacao= deve ser ativa, suspensa ou cancelada.')
    process.exit(1)
  }
  const r = await mudarSituacao(exigir('clinica'), s, arg('motivo') ?? '')
  console.log(r.ok ? `\n${r.mensagem}` : `\n\x1b[31m${r.mensagem}\x1b[0m`)
  if (!r.ok) process.exitCode = 1
}

const acao = process.argv.includes('--situacao') || arg('situacao') ? situacao : criar

acao()
  .catch((e) => {
    console.error('\nFalha:', e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => pool.end())
