import { gerarHashSenha, gerarSenhaTemporaria } from '@/lib/auth/senha'
import { db } from '@/lib/db'
import { assinatura, auditLog, cadeira, clinica, planoAssinatura, usuario } from '@/lib/db/schema'
import { seedMateriais } from '@/lib/db/seed/materiais'
import { seedProcedimentos } from '@/lib/db/seed/procedimentos'
import { cnpjEhValido, normalizarCnpj } from '@/lib/domain/cnpj'
import { emailEhPlausivel, normalizarEmail } from '@/lib/domain/administracao'
import { comClinica } from '@/lib/tenant/executar'
import { and, eq, sql } from 'drizzle-orm'
import { Client } from 'pg'

/**
 * Onboarding: nasce uma clínica.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  QUEM PODE RODAR ISTO, E POR QUE NÃO É O APP
 *
 *  Isto é **operação**, não aplicação. Roda com a credencial do DONO do banco,
 *  por script, na máquina do servidor — nunca atendendo requisição.
 *
 *  Três desenhos foram considerados:
 *
 *  1. **Rota HTTP no app** (`POST /admin/clinicas`). Descartado. Exigiria que
 *     `facilident_app` soubesse criar tenant: `INSERT` em `clinica` sem contexto
 *     (a política de `clinica` é `id = app_clinica_id()`, e o tenant ainda não
 *     existe) e escrita em `assinatura`, que é a tabela da nossa própria cobrança.
 *     O processo que serve o prontuário dos pacientes passaria a poder criar
 *     tenants e mexer no faturamento — e aí qualquer falha de lógica, SSRF ou
 *     desserialização vira criação de tenant e reativação de assinatura.
 *
 *  2. **Role própria `facilident_ops`**, com poder de criar tenant. Descartado, e
 *     por um motivo concreto deste deploy: o despachante roda **no mesmo
 *     container** do app (`docker compose --profile prod up despachante` usa a
 *     mesma imagem). Uma credencial mais privilegiada no ambiente fica disponível
 *     para todo o processo, **inclusive para o código que atende requisição** —
 *     mais bonita no diagrama e pior na prática. É o mesmo raciocínio já escrito
 *     em `lib/tenant/operador.ts` para `clinicas_para_processamento()`.
 *
 *  3. **Script de operação com a credencial do dono** (escolhido). A credencial
 *     mais forte é fornecida no momento do uso, por quem opera, e não mora no
 *     ambiente do serviço web. É a mesma disciplina de `migrate`, `db:seed`,
 *     `db:verificar` e `backup.sh`.
 *
 *  O custo é honesto e fica registrado: **não existe tela de onboarding.** Cadastrar
 *  cliente novo é alguém com acesso ao servidor rodando um comando. Para dezenas de
 *  clínicas isso funciona; para centenas, o caminho é um serviço separado, com
 *  credencial própria, fora do container que atende requisição — e não afrouxar
 *  este.
 * ══════════════════════════════════════════════════════════════════════════
 */

export interface DadosDoOnboarding {
  readonly razaoSocial: string
  /** Chave natural do cliente. Obrigatória aqui — ver `clinicaExistente`. */
  readonly cnpj: string
  readonly nomeFantasia?: string
  /** Código do plano em `plano_assinatura` ('essencial' | 'profissional' | 'clinica'). */
  readonly plano: string
  readonly adminNome: string
  readonly adminEmail: string
}

export type ResultadoOnboarding =
  | {
      readonly ok: true
      readonly criada: boolean
      readonly clinicaId: string
      readonly adminEmail: string
      /** Só quando `criada`. Aparece uma vez e não é recuperável. */
      readonly senhaTemporaria?: string
      readonly resumo: string
    }
  | { readonly ok: false; readonly mensagem: string }

/**
 * A clínica com este CNPJ, se existir. **Sem contexto de tenant.**
 *
 * Precisa de conexão crua pelo mesmo motivo de `lib/tenant/operador.ts`: o pool
 * define contexto de clínica em toda acquisição, e "existe clínica com este CNPJ?"
 * é justamente a pergunta que não pode ter contexto — a resposta certa pode ser
 * "não existe nenhuma".
 *
 * O `WHERE cnpj = $1` faz o filtro **no SQL**, e não pela política de RLS. Isso é
 * deliberado: como dono (que é superusuário e ignora política), uma consulta que
 * dependesse da política para filtrar responderia sobre a clínica errada. Já
 * aconteceu nesta fase: uma sonda `select 1 from clinica where cnpj = $1` com o
 * contexto posto parecia filtrar e devolvia sempre a primeira clínica.
 */
async function clinicaExistente(cnpj: string): Promise<string | null> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL não definida.')
  const cru = new Client({ connectionString: url })
  await cru.connect()
  try {
    const r = await cru.query<{ id: string }>('select id::text from clinica where cnpj = $1', [cnpj])
    return r.rows[0]?.id ?? null
  } finally {
    await cru.end()
  }
}

/**
 * Cria clínica + primeiro admin + catálogo + assinatura. **Idempotente.**
 *
 * ── O que "idempotente" significa aqui, e o que não significa ───────────────
 * Rodar duas vezes com o mesmo CNPJ **não cria nada**: devolve a clínica que já
 * existe e `criada: false`. Em particular **não gera outra senha temporária** — se
 * gerasse, um segundo `onboarding` acidental invalidaria a senha que o cliente já
 * recebeu e ninguém entenderia por quê. Senha perdida tem caminho próprio:
 * `resetarSenhaComAtor`, feito por um admin identificado e auditado.
 *
 * O que É repetível: o catálogo. `seedProcedimentos` e `seedMateriais` fazem
 * `ON CONFLICT`, então rodá-los de novo na mesma clínica atualiza em vez de
 * duplicar — mas nem chegam a rodar, porque a função sai antes.
 */
export async function criarClinica(dados: DadosDoOnboarding): Promise<ResultadoOnboarding> {
  const razaoSocial = dados.razaoSocial?.trim()
  if (!razaoSocial || razaoSocial.length < 3) {
    return { ok: false, mensagem: 'Informe a razão social.' }
  }

  const cnpj = normalizarCnpj(dados.cnpj ?? '')
  if (!cnpj) {
    return {
      ok: false,
      mensagem:
        'CNPJ é obrigatório no onboarding: é a chave que impede cadastrar o mesmo cliente duas vezes.',
    }
  }
  if (!cnpjEhValido(cnpj)) {
    // O CNPJ vai no cabeçalho do orçamento, do atestado e do XML TISS. Errado, ele
    // volta como glosa de dado do prestador — semanas depois.
    return { ok: false, mensagem: 'CNPJ inválido (dígitos verificadores não conferem).' }
  }

  const adminNome = dados.adminNome?.trim()
  if (!adminNome || adminNome.length < 3) {
    return { ok: false, mensagem: 'Informe o nome do primeiro administrador.' }
  }
  const adminEmail = normalizarEmail(dados.adminEmail ?? '')
  if (!emailEhPlausivel(adminEmail)) {
    return { ok: false, mensagem: 'E-mail do administrador inválido.' }
  }

  const jaExiste = await clinicaExistente(cnpj)

  const [plano] = await db
    .select({ id: planoAssinatura.id, nome: planoAssinatura.nome })
    .from(planoAssinatura)
    .where(and(eq(planoAssinatura.codigo, dados.plano), eq(planoAssinatura.ativo, true)))
    .limit(1)
  if (!plano) {
    return { ok: false, mensagem: `Plano "${dados.plano}" não existe ou está descontinuado.` }
  }

  const senha = gerarSenhaTemporaria()
  const senhaHash = await gerarHashSenha(senha)

  let adminCriado = false
  let clinicaId: string
  if (jaExiste) {
    clinicaId = jaExiste
  } else {
    try {
      /**
       * A clínica nasce fora do envelope, porque o envelope precisa do id dela —
       * `comClinica` abre transação própria e `set_config` precisa do uuid.
       *
       * Consequência: se o passo seguinte falhar, sobra uma clínica vazia. É por
       * isso que este comando é **retomável de verdade** (ver abaixo) e não apenas
       * "reconhece que já existe": clínica pela metade com o CNPJ ocupado deixaria o
       * operador travado — não conseguiria criar de novo nem terminar a que ficou.
       */
      const inseridas = await db
        .insert(clinica)
        .values({
          razaoSocial,
          nomeFantasia: dados.nomeFantasia?.trim() || null,
          cnpj,
        })
        .returning({ id: clinica.id })
      const nova = inseridas[0]
      if (!nova) throw new Error('INSERT em clinica não devolveu id.')
      clinicaId = nova.id
    } catch (e) {
      return { ok: false, mensagem: traduzir(e) }
    }
  }

  try {
    await comClinica(clinicaId, async (tx) => {
      /**
       * Tudo daqui para baixo numa transação só, e não por elegância: a trava
       * deferida de `drizzle/0021` cobra **no commit** que a clínica tenha
       * administrador ativo. Inserts soltos comitam separado e o primeiro já
       * violaria. É a mesma lição que `criarUsuarioComAtor` aprendeu com o par
       * `usuario` + `profissional`.
       *
       * `clinica_id` de cada linha vem do `DEFAULT app_clinica_id()`, que lê o
       * contexto que `comClinica` acabou de definir. Nenhum destes seeds sabe o
       * que é tenant.
       */
      /**
       * ── Cada passo é retomável, e é isto que faz "rodar de novo" ser verdade ──
       *
       * A primeira versão saía cedo quando o CNPJ já existia. Parecia idempotência e
       * era uma armadilha: uma clínica que ficou pela metade (o passo seguinte
       * falhou) ocupava o CNPJ e **não podia mais ser terminada nem recriada**. O
       * operador ficava com uma clínica inutilizável e nenhuma saída pelo comando.
       *
       * Agora cada peça é criada só se faltar. A que NÃO se repete é a senha: se já
       * existe admin, a senha dele não é regerada, porque isso invalidaria a que o
       * cliente já recebeu, sem ninguém entender por quê. Senha perdida tem caminho
       * próprio (`resetarSenhaComAtor`), feito por alguém identificado e auditado.
       */
      const [adminExistente] = await tx
        .select({ id: usuario.id })
        .from(usuario)
        .where(and(eq(usuario.clinicaId, clinicaId), eq(usuario.perfil, 'admin')))
        .limit(1)

      if (!adminExistente) {
        await tx.insert(usuario).values({
          nome: adminNome,
          email: adminEmail,
          senhaHash,
          perfil: 'admin',
          /**
           * Senha ditada por terceiro é senha comprometida: a marca prende a pessoa
           * em `/trocar-senha`. E `mfaAtivo: false` a prende antes em
           * `/configurar-mfa` — **MFA primeiro, senha depois**, que é a ordem
           * fechada do projeto: trocar já protegido por segundo fator é melhor que
           * trocar com a credencial que circulou por telefone.
           */
          senhaTemporaria: true,
          mfaAtivo: false,
        })
        adminCriado = true
      }

      const [assinaturaExistente] = await tx
        .select({ id: assinatura.id })
        .from(assinatura)
        .where(eq(assinatura.clinicaId, clinicaId))
        .limit(1)
      if (!assinaturaExistente) {
        await tx.insert(assinatura).values({ planoId: plano.id, situacao: 'ativa' })
      }

      /**
       * ── Daqui até o fim da transação, rodando como `facilident_app` ─────────
       *
       * Isto não é zelo: sem isto o onboarding **grava dado cruzando clínica**, e
       * eu descobri porque a verificação por HTTP falhou com
       * `insumo_procedimento_procedimento_id_procedimento_id_fk` — o FK composto
       * da `0023` recusando exatamente o que ele existe para recusar.
       *
       * A causa: `seedMateriais` monta a ficha técnica com
       * `select id, codigo from procedimento` **sem filtro de clínica** e indexa
       * por código. Isso está CORRETO no mundo em que o seed foi escrito, porque a
       * RLS filtra. Só que script de operação roda como dono, que é superusuário e
       * **ignora política** — então a consulta devolve o catálogo de todas as
       * clínicas e o `Map` por código guarda o da última. A ficha técnica da clínica
       * nova sairia apontando para o procedimento de outra.
       *
       * `SET LOCAL ROLE` faz a RLS voltar a valer para o resto da transação, o que
       * torna as consultas do seed corretas **por construção** em vez de por
       * disciplina. A alternativa seria acrescentar `where clinica_id = …` em cada
       * consulta do seed — mais código, e cada linha nova é uma chance de esquecer.
       *
       * `LOCAL`: volta ao dono no commit, então a conexão retorna ao pool limpa.
       *
       * ⚠️ A ordem importa. Fica ANTES daqui, como dono:
       *   • `assinatura`, porque `INSERT` nela é revogado de `facilident_app` (uma
       *     clínica não escreve na tabela que decide se ela pode escrever);
       *   • `usuario`, que a clínica nova ainda não tem — e como `facilident_app` o
       *     INSERT em `usuario` é travado quando a assinatura não está ativa.
       *
       * ⚠️ O mesmo defeito continua em `npm run db:seed` para a SEGUNDA clínica em
       * diante: ele roda como dono e cai no mesmo `Map`. Não está corrigido aqui
       * porque `lib/db/seed/` não é meu — está no relatório.
       */
      await tx.execute(sql`set local role facilident_app`)

      await seedProcedimentos(tx)
      await seedMateriais(tx)

      /**
       * Uma cadeira, para a agenda funcionar no primeiro dia: sem cadeira não há
       * onde marcar, e a clínica nova abriria numa tela que recusa tudo. Nome e
       * quantidade se ajustam na tela de ajustes — o seed de desenvolvimento cria
       * duas, mas aqui só quem contratou sabe quantas tem.
       */
      const [cadeiraExistente] = await tx
        .select({ id: cadeira.id })
        .from(cadeira)
        .where(eq(cadeira.clinicaId, clinicaId))
        .limit(1)
      if (!cadeiraExistente) {
        await tx.insert(cadeira).values({ nome: 'Consultório 1', ordem: 1 })
      }

      /**
       * Auditoria gravada à mão, sem `registrar()`.
       *
       * `registrar()` lê `headers()` do Next, que não existe fora de uma
       * requisição — e ele engole a própria falha de propósito ("prontuário
       * indisponível por causa da auditoria é pior que registro perdido"). Num
       * script isso daria onboarding sem trilha, em silêncio. Criar tenant é
       * grande demais para ficar sem registro, então o INSERT é direto, dentro da
       * mesma transação: se ele falhar, a clínica não nasce.
       *
       * `ator_tipo = 'sistema'`: não há usuário logado. Quem rodou está no log do
       * servidor, não aqui — e a senha temporária NÃO entra em `detalhes`, mesma
       * disciplina do convite do portal.
       */
      await tx.insert(auditLog).values({
        atorTipo: 'sistema',
        acao: 'criacao',
        entidade: 'clinica',
        entidadeId: clinicaId,
        detalhes: {
          onboarding: true,
          cnpj,
          plano: dados.plano,
          adminEmail,
          // Distingue "nasceu agora" de "retomada": duas linhas de auditoria para a
          // mesma clínica são informação, não ruído — dizem que o primeiro
          // onboarding não terminou.
          retomada: jaExiste !== null,
        },
      })
    })
  } catch (e) {
    return {
      ok: false,
      mensagem:
        `${traduzir(e)} A clínica ${clinicaId} ficou criada e VAZIA — rode o mesmo ` +
        'comando de novo para continuar de onde parou.',
    }
  }

  if (jaExiste && !adminCriado) {
    return {
      ok: true,
      criada: false,
      clinicaId,
      adminEmail,
      resumo:
        `Clínica com CNPJ ${cnpj} já estava completa (${clinicaId}). Nada foi criado — ` +
        'senha perdida se resolve com reset feito por um admin, não repetindo o onboarding.',
    }
  }

  return {
    ok: true,
    criada: !jaExiste,
    clinicaId,
    adminEmail,
    ...(adminCriado ? { senhaTemporaria: senha } : {}),
    resumo: jaExiste
      ? `${razaoSocial} estava incompleta e foi TERMINADA no plano ${plano.nome}.`
      : `${razaoSocial} criada no plano ${plano.nome}.`,
  }
}

/**
 * Muda a situação da assinatura. **Operação**, como o onboarding.
 *
 * A escrita em `assinatura` é revogada de `facilident_app` (`drizzle/0027`): a
 * clínica lê em que plano está e não se reativa sozinha. Isso não é paranoia de
 * segurança, é lógica de negócio no lugar certo — a alternativa é uma tela do
 * cliente escrevendo na tabela que decide se ele pode escrever.
 */
export async function mudarSituacao(
  clinicaId: string,
  situacao: 'ativa' | 'suspensa' | 'cancelada',
  motivo: string,
): Promise<{ ok: boolean; mensagem: string }> {
  if (situacao !== 'ativa' && !motivo?.trim()) {
    // O CHECK do banco recusa de todo jeito; isto existe para a mensagem ser boa.
    return {
      ok: false,
      mensagem:
        'Suspender ou cancelar exige motivo: quem atende o telefone da clínica ' +
        'congelada precisa poder dizer por quê.',
    }
  }

  const r = await comClinica(clinicaId, async (tx) => {
    const atualizadas = await tx
      .update(assinatura)
      .set({
        situacao,
        motivoSituacao: situacao === 'ativa' ? null : motivo.trim(),
        situacaoDesde: sql`now()`,
        atualizadoEm: sql`now()`,
      })
      .where(eq(assinatura.clinicaId, clinicaId))
      .returning({ id: assinatura.id })

    if (atualizadas.length === 0) return null

    await tx.insert(auditLog).values({
      atorTipo: 'sistema',
      acao: 'atualizacao',
      entidade: 'assinatura',
      entidadeId: atualizadas[0]?.id ?? null,
      detalhes: { situacao, motivo: motivo?.trim() || null },
    })
    return atualizadas[0]?.id ?? null
  })

  if (!r) return { ok: false, mensagem: `Clínica ${clinicaId} não tem assinatura.` }
  return { ok: true, mensagem: `Assinatura de ${clinicaId} agora está ${situacao}.` }
}

function traduzir(e: unknown): string {
  const partes: string[] = []
  let atual: unknown = e
  for (let i = 0; i < 5 && atual instanceof Error; i++) {
    partes.push(atual.message)
    atual = (atual as { cause?: unknown }).cause
  }
  const bruto = partes.join(' | ')

  if (bruto.includes('clinica_cnpj_uk')) return 'Já existe clínica com este CNPJ.'
  if (bruto.includes('usuario_email_uk')) {
    return (
      'Este e-mail já é de um usuário do Facilident. O e-mail do staff é único no ' +
      'mundo, não por clínica, porque o login é e-mail + senha e o tenant sai da ' +
      'credencial — use outro e-mail para esta clínica.'
    )
  }
  if (bruto.includes('sem nenhum administrador ativo')) {
    return 'A clínica não pode nascer sem administrador ativo.'
  }
  if (bruto.includes('Sem contexto de clínica')) {
    return 'Contexto de clínica ausente — este comando precisa da credencial do dono do banco.'
  }
  return `Falhou: ${bruto || 'erro desconhecido'}`
}
