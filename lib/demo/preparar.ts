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
import { eq, or, sql } from 'drizzle-orm'

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

  const hoje = await hojeDaClinica()

  // ── 1. A clínica ───────────────────────────────────────────────────────────
  // Sem isso o orçamento sai sem cabeçalho e o atestado sem CRO.
  titulo('1. Configuração da clínica')
  await db
    .insert(clinica)
    .values({
      id: 1,
      razaoSocial: 'Clínica Odontológica Sorriso Vivo Ltda',
      nomeFantasia: 'Sorriso Vivo',
      cnpj: '11222333000181',
      croResponsavel: '54321',
      ufCroResponsavel: 'SP',
      telefone: '1133334444',
      email: 'contato@sorrisovivo.demo.local',
      cep: '01310100',
      logradouro: 'Avenida Paulista',
      numero: '1000',
      bairro: 'Bela Vista',
      cidade: 'São Paulo',
      uf: 'SP',
    })
    .onConflictDoUpdate({
      target: clinica.id,
      set: {
        razaoSocial: sql`excluded.razao_social`,
        nomeFantasia: sql`excluded.nome_fantasia`,
        cnpj: sql`excluded.cnpj`,
        croResponsavel: sql`excluded.cro_responsavel`,
        ufCroResponsavel: sql`excluded.uf_cro_responsavel`,
        telefone: sql`excluded.telefone`,
        email: sql`excluded.email`,
        cep: sql`excluded.cep`,
        logradouro: sql`excluded.logradouro`,
        numero: sql`excluded.numero`,
        bairro: sql`excluded.bairro`,
        cidade: sql`excluded.cidade`,
        uf: sql`excluded.uf`,
      },
    })
  console.log('   Sorriso Vivo · CNPJ 11.222.333/0001-81 · CRO-SP 54321')

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
  await criarStaff('financeiro', 'Financeiro Fábio', 'financeiro')

  // ── 3. Cadeiras ────────────────────────────────────────────────────────────
  const cadeiras = await db.select({ id: cadeira.id, nome: cadeira.nome }).from(cadeira).limit(2)
  const cadeiraA = cadeiras[0]!.id

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
      or(
        eq(procedimento.codigo, 'CONS-001'),
        eq(procedimento.codigo, 'DENT-001'),
        eq(procedimento.codigo, 'DENT-002'),
        eq(procedimento.codigo, 'PREV-001'),
        eq(procedimento.codigo, 'ENDO-001'),
        eq(procedimento.codigo, 'CIR-001'),
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

  await db.insert(itemPlano).values([
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
  ])

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
    .where(
      or(
        eq(material.codigo, 'BIO-001'),
        eq(material.codigo, 'ANE-001'),
        eq(material.codigo, 'ANE-004'),
        eq(material.codigo, 'RES-001'),
        eq(material.codigo, 'RES-003'),
        eq(material.codigo, 'RES-004'),
        eq(material.codigo, 'BIO-002'),
        eq(material.codigo, 'BIO-003'),
        eq(material.codigo, 'BIO-004'),
        eq(material.codigo, 'BIO-005'),
        eq(material.codigo, 'RES-006'),
        eq(material.codigo, 'END-001'),
        eq(material.codigo, 'IMP-001'),
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
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query("set local session_replication_role = 'replica'")

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
    console.error('\n✗', e instanceof Error ? e.message : e)
    await pool.end()
    process.exit(1)
  })
