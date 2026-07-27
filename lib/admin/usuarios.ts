import { registrar } from '@/lib/auditoria/registrar'
import { avaliarSenha, gerarHashSenha, gerarSenhaTemporaria, verificarSenha } from '@/lib/auth/senha'
import type { Ator } from '@/lib/authz/sessao'
import type { Perfil } from '@/lib/authz/politicas'
import { db } from '@/lib/db'
import { profissional, usuario } from '@/lib/db/schema'
import {
  type EstadoDoUsuario,
  emailEhPlausivel,
  exigeProfissional,
  normalizarEmail,
  normalizarProfissional,
  podeDesativarUsuario,
  podeTrocarPerfil,
  validarProfissional,
} from '@/lib/domain/administracao'
import { eq } from 'drizzle-orm'

/**
 * Administração de usuários do staff. **Núcleo, sem `'use server'`.**
 *
 * ── O que NUNCA sai daqui ───────────────────────────────────────────────────
 * A senha temporária é devolvida **uma vez**, no resultado da criação, para a
 * tela mostrar ao admin. Ela não vai para o `audit_log`, não fica em coluna
 * nenhuma e não é recuperável depois — mesma disciplina do convite do portal.
 * Se a pessoa perder, o caminho é gerar outra.
 *
 * `mfa_secret` nunca é lido por este módulo. Reiniciar o MFA é apagá-lo, não
 * mostrá-lo: o segredo é do usuário, e um admin que consegue vê-lo consegue
 * gerar códigos válidos em nome dele.
 *
 * ── O que o banco garante, e este arquivo só explica ────────────────────────
 * Nunca zero admins ativos, e dentista ativo com cadastro de profissional
 * (`drizzle/0021`). As checagens abaixo existem para dar mensagem boa na tela;
 * se falharem, o banco recusa de todo jeito.
 */

export type ResultadoAdmin =
  | { readonly ok: true; readonly mensagem: string; readonly senhaTemporaria?: string; readonly id?: string }
  | { readonly ok: false; readonly mensagem: string }

async function estadoDosUsuarios(): Promise<readonly EstadoDoUsuario[]> {
  const linhas = await db
    .select({
      id: usuario.id,
      perfil: usuario.perfil,
      ativo: usuario.ativo,
      profissionalId: profissional.id,
    })
    .from(usuario)
    .leftJoin(profissional, eq(profissional.usuarioId, usuario.id))

  return linhas.map((l) => ({
    id: l.id,
    perfil: l.perfil,
    ativo: l.ativo,
    temProfissional: l.profissionalId !== null,
  }))
}

export interface DadosDoUsuario {
  readonly nome: string
  readonly email: string
  readonly perfil: Perfil
  /** Só para perfil `dentista`. */
  readonly cro?: string
  readonly ufCro?: string
  readonly comissaoPct?: string
  readonly especialidade?: string
  /**
   * CBO-S do dentista, obrigatório no XML TISS e opcional aqui — ver o campo em
   * `DadosDeProfissional`. Família 2232 conforme `dm_CBOS` do XSD da ANS.
   */
  readonly cbos?: string
}

/**
 * Cria um usuário com senha temporária.
 *
 * A senha é gerada, não escolhida pelo admin: senha escolhida por terceiro é
 * senha que o terceiro sabe, e "Clinica@2026" acaba servindo para todo mundo.
 * Ela nasce marcada como temporária, e o middleware prende quem a tem em
 * `/trocar-senha` até a troca.
 *
 * Dentista sai daqui já com `profissional`, na mesma transação — a trava
 * deferida de `drizzle/0021` recusaria o contrário.
 */
export async function criarUsuarioComAtor(
  ator: Ator,
  dados: DadosDoUsuario,
): Promise<ResultadoAdmin> {
  const nome = dados.nome.trim()
  if (nome.length < 3) return { ok: false, mensagem: 'Informe o nome completo.' }

  const email = normalizarEmail(dados.email)
  if (!emailEhPlausivel(email)) return { ok: false, mensagem: 'E-mail inválido.' }

  if (exigeProfissional(dados.perfil)) {
    const v = validarProfissional({
      cro: dados.cro ?? '',
      ufCro: dados.ufCro ?? '',
      comissaoPct: dados.comissaoPct ?? '0',
      cbos: dados.cbos,
    })
    if (!v.ok) return { ok: false, mensagem: v.motivo }
  }

  const senha = gerarSenhaTemporaria()

  try {
    const id = await db.transaction(async (tx) => {
      const [novo] = await tx
        .insert(usuario)
        .values({
          nome,
          email,
          senhaHash: await gerarHashSenha(senha),
          perfil: dados.perfil,
          senhaTemporaria: true,
          mfaAtivo: false,
        })
        .returning({ id: usuario.id })

      if (!novo) throw new Error('usuário não criado')

      if (exigeProfissional(dados.perfil)) {
        const p = normalizarProfissional({
          cro: dados.cro ?? '',
          ufCro: dados.ufCro ?? '',
          comissaoPct: dados.comissaoPct ?? '0',
          cbos: dados.cbos,
        })
        await tx.insert(profissional).values({
          usuarioId: novo.id,
          cro: p.cro,
          ufCro: p.ufCro,
          comissaoPct: p.comissaoPct,
          // `?? null` e não `|| null`: `normalizarProfissional` já devolve
          // `undefined` quando vazio, e o Drizzle omitiria a coluna do INSERT em
          // vez de gravar nulo — o que na EDIÇÃO deixaria o valor antigo de pé.
          cbos: p.cbos ?? null,
          especialidade: dados.especialidade?.trim() || null,
        })
      }

      return novo.id
    })

    // A senha NÃO entra nos detalhes. O que se audita é que um acesso foi criado.
    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'usuario',
      entidadeId: id,
      detalhes: { email, perfil: dados.perfil },
    })

    return {
      ok: true,
      id,
      senhaTemporaria: senha,
      mensagem: `${nome} cadastrado. Entregue a senha abaixo — ela aparece uma vez só.`,
    }
  } catch (e) {
    return { ok: false, mensagem: traduzir(e) }
  }
}

/** Edita nome, perfil e dados de profissional. E-mail e senha têm caminho próprio. */
export async function salvarUsuarioComAtor(
  ator: Ator,
  id: string,
  dados: DadosDoUsuario,
): Promise<ResultadoAdmin> {
  const todos = await estadoDosUsuarios()
  const alvo = todos.find((u) => u.id === id)
  if (!alvo) return { ok: false, mensagem: 'Usuário não encontrado.' }

  const troca = podeTrocarPerfil(alvo, dados.perfil, todos, ator.usuarioId)
  if (!troca.ok) return { ok: false, mensagem: troca.motivo }

  const nome = dados.nome.trim()
  if (nome.length < 3) return { ok: false, mensagem: 'Informe o nome completo.' }

  if (exigeProfissional(dados.perfil)) {
    const v = validarProfissional({
      cro: dados.cro ?? '',
      ufCro: dados.ufCro ?? '',
      comissaoPct: dados.comissaoPct ?? '0',
      cbos: dados.cbos,
    })
    if (!v.ok) return { ok: false, mensagem: v.motivo }
  }

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(usuario)
        .set({ nome, perfil: dados.perfil, atualizadoEm: new Date() })
        .where(eq(usuario.id, id))

      if (exigeProfissional(dados.perfil)) {
        const p = normalizarProfissional({
          cro: dados.cro ?? '',
          ufCro: dados.ufCro ?? '',
          comissaoPct: dados.comissaoPct ?? '0',
          cbos: dados.cbos,
        })
        const valores = {
          cro: p.cro,
          ufCro: p.ufCro,
          comissaoPct: p.comissaoPct,
          cbos: p.cbos ?? null,
          especialidade: dados.especialidade?.trim() || null,
          atualizadoEm: new Date(),
        }
        if (alvo.temProfissional) {
          await tx.update(profissional).set(valores).where(eq(profissional.usuarioId, id))
        } else {
          // Promoção a dentista: a linha de profissional nasce agora.
          await tx.insert(profissional).values({ usuarioId: id, ...valores })
        }
      } else if (alvo.temProfissional) {
        /**
         * Rebaixado de dentista: o `profissional` é DESATIVADO, nunca apagado.
         * Evolução assinada, execução e comissão apurada apontam para ele — o
         * histórico do prontuário não pode perder o autor.
         */
        await tx
          .update(profissional)
          .set({ ativo: false, atualizadoEm: new Date() })
          .where(eq(profissional.usuarioId, id))
      }
    })

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'usuario',
      entidadeId: id,
      detalhes: { perfil: dados.perfil, perfilAnterior: alvo.perfil },
    })

    return { ok: true, id, mensagem: `${nome} atualizado.` }
  } catch (e) {
    return { ok: false, mensagem: traduzir(e) }
  }
}

/**
 * Desativa o acesso. **Não apaga.**
 *
 * O usuário aparece em evolução assinada, em execução, em movimento de estoque e
 * no `audit_log`. Apagar quebraria a trilha justamente onde ela é exigida —
 * guarda de 20 anos. Desativado não entra: `authorize` recusa antes da senha.
 */
export async function desativarUsuarioComAtor(
  ator: Ator,
  id: string,
): Promise<ResultadoAdmin> {
  const todos = await estadoDosUsuarios()
  const alvo = todos.find((u) => u.id === id)
  if (!alvo) return { ok: false, mensagem: 'Usuário não encontrado.' }

  const r = podeDesativarUsuario(alvo, todos, ator.usuarioId)
  if (!r.ok) return { ok: false, mensagem: r.motivo }

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(usuario)
        .set({ ativo: false, atualizadoEm: new Date() })
        .where(eq(usuario.id, id))
      if (alvo.temProfissional) {
        await tx
          .update(profissional)
          .set({ ativo: false, atualizadoEm: new Date() })
          .where(eq(profissional.usuarioId, id))
      }
    })

    await registrar({ ator, acao: 'atualizacao', entidade: 'usuario', entidadeId: id, detalhes: { ativo: false } })
    return { ok: true, id, mensagem: 'Acesso desativado. O histórico do usuário permanece.' }
  } catch (e) {
    return { ok: false, mensagem: traduzir(e) }
  }
}

export async function reativarUsuarioComAtor(ator: Ator, id: string): Promise<ResultadoAdmin> {
  const todos = await estadoDosUsuarios()
  const alvo = todos.find((u) => u.id === id)
  if (!alvo) return { ok: false, mensagem: 'Usuário não encontrado.' }
  if (alvo.ativo) return { ok: false, mensagem: 'Este usuário já está ativo.' }

  try {
    await db.transaction(async (tx) => {
      await tx.update(usuario).set({ ativo: true, atualizadoEm: new Date() }).where(eq(usuario.id, id))
      if (alvo.temProfissional) {
        await tx
          .update(profissional)
          .set({ ativo: true, atualizadoEm: new Date() })
          .where(eq(profissional.usuarioId, id))
      }
    })
    await registrar({ ator, acao: 'atualizacao', entidade: 'usuario', entidadeId: id, detalhes: { ativo: true } })
    return { ok: true, id, mensagem: 'Acesso reativado.' }
  } catch (e) {
    return { ok: false, mensagem: traduzir(e) }
  }
}

/**
 * Gera nova senha temporária. É o "esqueci a senha" da clínica.
 *
 * Não há autoatendimento por e-mail para staff, e é decisão: recuperação por
 * e-mail transfere a segurança do prontuário para a caixa de entrada de quem
 * esqueceu a senha. Aqui outra pessoa, identificada e auditada, entrega uma senha
 * temporária — e o MFA continua exigido no login seguinte.
 */
export async function resetarSenhaComAtor(ator: Ator, id: string): Promise<ResultadoAdmin> {
  const [alvo] = await db
    .select({ id: usuario.id, nome: usuario.nome })
    .from(usuario)
    .where(eq(usuario.id, id))
    .limit(1)
  if (!alvo) return { ok: false, mensagem: 'Usuário não encontrado.' }

  const senha = gerarSenhaTemporaria()
  await db
    .update(usuario)
    .set({ senhaHash: await gerarHashSenha(senha), senhaTemporaria: true, atualizadoEm: new Date() })
    .where(eq(usuario.id, id))

  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'usuario',
    entidadeId: id,
    detalhes: { senhaRedefinida: true },
  })

  return {
    ok: true,
    id,
    senhaTemporaria: senha,
    mensagem: `Nova senha para ${alvo.nome}. Aparece uma vez só, e terá de ser trocada no primeiro acesso.`,
  }
}

/**
 * Reinicia o segundo fator: apaga o segredo e obriga a reconfigurar.
 *
 * É o caminho de quem trocou de celular. O admin **não vê** o segredo em momento
 * nenhum — quem o visse geraria códigos válidos em nome do outro. Quem reinicia
 * fica registrado, porque é uma redução momentânea de segurança da conta.
 */
export async function resetarMfaComAtor(ator: Ator, id: string): Promise<ResultadoAdmin> {
  const [alvo] = await db
    .select({ id: usuario.id, nome: usuario.nome })
    .from(usuario)
    .where(eq(usuario.id, id))
    .limit(1)
  if (!alvo) return { ok: false, mensagem: 'Usuário não encontrado.' }

  await db
    .update(usuario)
    .set({ mfaSecret: null, mfaAtivo: false, atualizadoEm: new Date() })
    .where(eq(usuario.id, id))

  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'usuario',
    entidadeId: id,
    detalhes: { mfaReiniciado: true },
  })

  return {
    ok: true,
    id,
    mensagem: `${alvo.nome} vai configurar o autenticador de novo no próximo acesso.`,
  }
}

/**
 * Troca da própria senha. Exige a senha atual.
 *
 * Pedir a atual não é burocracia: sem isso, uma sessão esquecida aberta no balcão
 * permite trocar a senha e tomar a conta. É a mesma razão de o portal exigir a
 * atual do paciente.
 */
export async function trocarPropriaSenhaComAtor(
  ator: Ator,
  atual: string,
  nova: string,
): Promise<ResultadoAdmin> {
  const [linha] = await db
    .select({ senhaHash: usuario.senhaHash, nome: usuario.nome, email: usuario.email })
    .from(usuario)
    .where(eq(usuario.id, ator.usuarioId))
    .limit(1)
  if (!linha) return { ok: false, mensagem: 'Usuário não encontrado.' }

  if (!(await verificarSenha(atual, linha.senhaHash))) {
    return { ok: false, mensagem: 'A senha atual não confere.' }
  }
  if (atual === nova) {
    return { ok: false, mensagem: 'A nova senha tem de ser diferente da atual.' }
  }

  // O contexto entra na avaliação: senha que contém o próprio nome ou e-mail é
  // a primeira que alguém tenta.
  const avaliacao = avaliarSenha(nova, [linha.nome, linha.email])
  if (!avaliacao.aceita) return { ok: false, mensagem: avaliacao.problemas.join(' ') }

  await db
    .update(usuario)
    .set({
      senhaHash: await gerarHashSenha(nova),
      senhaTemporaria: false,
      atualizadoEm: new Date(),
    })
    .where(eq(usuario.id, ator.usuarioId))

  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'usuario',
    entidadeId: ator.usuarioId,
    detalhes: { senhaTrocadaPeloProprio: true },
  })

  return { ok: true, mensagem: 'Senha trocada.' }
}

function traduzir(e: unknown): string {
  const partes: string[] = []
  let atual: unknown = e
  for (let i = 0; i < 5 && atual instanceof Error; i++) {
    partes.push(atual.message)
    atual = (atual as { cause?: unknown }).cause
  }
  const bruto = partes.join(' | ')

  if (bruto.includes('usuario_email_uk')) {
    return 'Já existe usuário com este e-mail.'
  }
  if (bruto.includes('profissional_cro_uk')) {
    return 'Já existe profissional com este CRO nesta UF.'
  }
  if (bruto.includes('sem nenhum administrador ativo')) {
    return 'Não é possível deixar a clínica sem nenhum administrador ativo.'
  }
  if (bruto.includes('perfil dentista e nenhum cadastro de profissional')) {
    return 'Perfil dentista exige CRO: sem ele não assina evolução nem apura comissão.'
  }
  return 'Não foi possível salvar. Confira os dados e tente de novo.'
}
