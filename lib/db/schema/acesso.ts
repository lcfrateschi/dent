import { sql } from 'drizzle-orm'
import {
  foreignKey,
  boolean,
  check,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { HORARIO_PADRAO } from '@/lib/domain/horario'
import { baseComissaoEnum, perfilUsuarioEnum } from './enums'
import { clinicaId } from './tenant'

/**
 * A clínica. **É o tenant.**
 *
 * Era uma linha singleton (`id = 1`) enquanto o sistema atendia uma clínica só.
 * Virou tenant quando o Facilident passou a ser produto para várias: agora toda
 * tabela de dados carrega `clinica_id` (ver `tenant.ts`), e o isolamento é
 * garantido por Row Level Security no banco — não por disciplina nas consultas.
 *
 * A PK é `uuid` como no resto do sistema. O id do tenant nunca aparece em URL:
 * ele vem da sessão. Mas ele aparece em nome de arquivo de exportação, em chave
 * de storage e em log — e um `1` sequencial ali conta quantos clientes existem.
 */
export const clinica = pgTable(
  'clinica',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    razaoSocial: text('razao_social').notNull(),
    nomeFantasia: text('nome_fantasia'),
    cnpj: varchar('cnpj', { length: 14 }),
    croResponsavel: varchar('cro_responsavel', { length: 20 }),
    ufCroResponsavel: varchar('uf_cro_responsavel', { length: 2 }),
    telefone: varchar('telefone', { length: 20 }),
    email: text('email'),
    cep: varchar('cep', { length: 8 }),
    logradouro: text('logradouro'),
    numero: varchar('numero', { length: 20 }),
    complemento: text('complemento'),
    bairro: text('bairro'),
    cidade: text('cidade'),
    uf: varchar('uf', { length: 2 }),
    /** Base de cálculo da comissão, padrão da clínica. Ver GLOSSARIO.md. */
    baseComissao: baseComissaoEnum('base_comissao').notNull().default('valor_recebido'),
    /**
     * Fuso da clínica. A agenda converte instante ↔ hora local por aqui, nunca
     * pelo fuso do servidor — senão o mesmo atendimento aparece em horas
     * diferentes no container e na máquina do dentista. Ver lib/domain/fuso.ts.
     */
    fusoHorario: text('fuso_horario').notNull().default('America/Sao_Paulo'),
    /**
     * Faixas de atendimento por dia da semana ('0'..'6' → [{inicio, fim}]).
     * Duas faixas por dia é o normal: quase todo consultório fecha para almoço.
     * Validado por lib/domain/horario.ts.
     */
    horarioFuncionamento: jsonb('horario_funcionamento').notNull().default(HORARIO_PADRAO),
    /**
     * Base da comissão quando existe taxa de meio de pagamento (MDR).
     *
     * `false` (padrão) = valor **bruto** pago pelo paciente. `true` = valor **líquido**
     * que entrou na conta.
     *
     * A pergunta não é técnica: o paciente paga R$ 100 no crédito, caem R$ 97,51, e a
     * diferença sai do bolso de alguém. É contrato de trabalho. O padrão é o que **não
     * muda a folha** de quem já está em operação; trocar é um UPDATE, reversível. Ver
     * `lib/domain/taxaPagamento.ts`.
     */
    comissaoSobreLiquido: boolean('comissao_sobre_liquido').notNull().default(false),
    /**
     * CNES do estabelecimento — sete dígitos, obrigatório no XML TISS.
     *
     * Anulável porque clínica só particular não tem e nunca vai ter. O que cobra o
     * preenchimento é a emissão da guia, no momento em que ele importa; até lá,
     * `conferirAntesDeEnviar` o lista como pendência. Formato travado por CHECK
     * (`clinica_cnes_formato`): é padrão nacional, e CNES com 6 dígitos é erro de
     * digitação que só aparece na guia recusada.
     */
    cnes: varchar('cnes', { length: 7 }),
    /** Granularidade dos horários oferecidos na agenda, em minutos. */
    passoAgendaMinutos: smallint('passo_agenda_minutos').notNull().default(15),
    /**
     * O número da Cloud API que atende esta clínica — e o único jeito de saber de
     * quem é uma mensagem que o paciente **inicia**.
     *
     * O webhook da Meta chega sem cookie e sem sessão. Para resposta a lembrete
     * dá para resolver pelo `id_externo`, porque a linha de `mensagem_whatsapp`
     * já sabe de quem é; para conversa iniciada pelo paciente não existe linha
     * anterior, e sem esta coluna o tenant seria adivinhado. Ver `drizzle/0024`.
     *
     * A resolução é **por evento**, não por bloco: o `metadata` do payload vem por
     * bloco e um lote pode misturar números.
     *
     * ⚠️ Isto resolve a ENTRADA. A saída (`WHATSAPP_TOKEN`) continua sendo uma
     * credencial de ambiente, ou seja **uma conta da Meta para todas as clínicas**.
     * Token por clínica é segredo no banco e puxa cifragem, como `mfa_secret` —
     * está no ROADMAP, não aqui.
     */
    whatsappPhoneNumberId: text('whatsapp_phone_number_id'),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // O CHECK `clinica_singleton` (id = 1) morreu aqui: era a trava que garantia
    // uma clínica só. O que sobra é unicidade de CNPJ, para o mesmo cliente não
    // entrar duas vezes por engano no onboarding.
    uniqueIndex('clinica_cnpj_uk').on(t.cnpj).where(sql`${t.cnpj} is not null`),
    /**
     * Um número da Meta pertence a uma clínica só. Duas clínicas com o mesmo
     * número deixariam **indefinido** de quem é a mensagem que chega — e o
     * webhook escolheria "alguma", que é como se manda o histórico de um paciente
     * para a caixa de entrada de outra clínica.
     */
    uniqueIndex('clinica_whatsapp_numero_uk')
      .on(t.whatsappPhoneNumberId)
      .where(sql`${t.whatsappPhoneNumberId} is not null`),
  ],
)

/**
 * Usuário interno (staff). Realm de autenticação SEPARADO de `paciente_conta`.
 * Nunca compartilhe query entre os dois — ver CLAUDE.md, decisão 2.
 */
export const usuario = pgTable(
  'usuario',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    nome: text('nome').notNull(),
    email: text('email').notNull(),
    senhaHash: text('senha_hash').notNull(),
    perfil: perfilUsuarioEnum('perfil').notNull(),
    /**
     * MFA é obrigatório para staff (dado de saúde).
     *
     * **Cifrado em repouso** (`lib/auth/mfaSegredo.ts`): AES-256-GCM com subchave
     * derivada de `MFA_CHAVE` por HKDF, no formato `v1$nonce$cifrado`. O `usuario.id`
     * entra como dado autenticado adicional — sem isso, quem consegue um `UPDATE`
     * copiaria o próprio valor cifrado, de que já tem o autenticador, para a linha do
     * administrador e passaria a gerar o segundo fator dele.
     *
     * Segredo anterior à cifra é reconhecido pela ausência do prefixo `v1$` (base32
     * não tem `$`) e recifrado no login seguinte, sem janela de manutenção. Para saber
     * se a conversão terminou:
     * `select count(*) from usuario where mfa_secret is not null and mfa_secret not like 'v1$%'`.
     *
     * ⚠️ **Rotação de chave não existe ainda.** O formato suporta (`v1` → `v2`), mas
     * hoje trocar `MFA_CHAVE` tranca todos fora do segundo fator. Falta uma
     * `MFA_CHAVE_ANTERIOR` e um mapa versão→subchave; está avisado no `.env.example`.
     *
     * Continua valendo: **nenhuma consulta de `lib/admin/` seleciona esta coluna.**
     * Cifrar não afrouxa isso — chave vazada mais coluna exposta é o mesmo problema de
     * antes.
     */
    mfaSecret: text('mfa_secret'),
    mfaAtivo: boolean('mfa_ativo').notNull().default(false),
    /**
     * Senha ditada pelo admin no cadastro, que precisa ser trocada no primeiro
     * acesso. Senha que passou por terceiro é senha comprometida; sem esta marca
     * ela viraria definitiva em silêncio. O middleware prende quem a tem em
     * `/trocar-senha`, como já faz com quem não configurou MFA.
     */
    senhaTemporaria: boolean('senha_temporaria').notNull().default(false),
    ativo: boolean('ativo').notNull().default(true),
    ultimoLoginEm: timestamp('ultimo_login_em', { withTimezone: true }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  /**
   * O e-mail do staff é único **globalmente**, não por clínica — e isso é
   * deliberado, ao contrário de `paciente.cpf`, que virou por clínica.
   *
   * O login é e-mail + senha. Se o mesmo e-mail existisse em duas clínicas, a
   * pergunta "quem está entrando?" não teria resposta: ou o sistema pediria a
   * clínica num terceiro campo (atrito diário para resolver um caso raro), ou
   * exigiria subdomínio por cliente antes de haver cliente pedindo. Com
   * unicidade global, **o tenant é derivado da credencial** e não existe
   * ambiguidade a resolver.
   *
   * O preço: um dentista que atenda em duas clínicas do Facilident precisa de um
   * e-mail por clínica. É uma limitação real e conhecida — e o dia em que um
   * cliente precisar de acesso a várias unidades, o desenho certo não é afrouxar
   * este índice, é um vínculo `usuario × clinica` com papel por unidade.
   *
   * `paciente_conta.email` segue a mesma regra, pelo mesmo motivo (`pacientes.ts`).
   */
  (t) => [uniqueIndex('usuario_email_uk').on(sql`lower(${t.email})`)],
)

/** Dentista. 1:1 com um `usuario` de perfil 'dentista'. */
export const profissional = pgTable(
  'profissional',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    usuarioId: uuid('usuario_id').notNull().unique(),
    cro: varchar('cro', { length: 20 }).notNull(),
    ufCro: varchar('uf_cro', { length: 2 }).notNull(),
    especialidade: text('especialidade'),
    /**
     * CBO-S, seis dígitos, obrigatório no XML TISS.
     *
     * O CHECK exige a família **2232** (cirurgião-dentista), e isso não é dedução: o
     * domínio `dm_CBOS` do XSD da ANS documenta a faixa, e a procedência do arquivo
     * está em `dados/tiss-xsd-3.05.00/PROCEDENCIA.md`. A trava é segura aqui porque
     * esta tabela é 1:1 com usuário `dentista` e exige CRO — auxiliar de saúde bucal
     * (família 3224) não entra. Se um dia entrar, a trava é que vai avisar.
     */
    cbos: varchar('cbos', { length: 6 }),
    /** Percentual de comissão, 0–100. Base definida em `clinica.base_comissao`. */
    comissaoPct: numeric('comissao_pct', { precision: 5, scale: 2 }).notNull().default('0'),
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'profissional_usuario_id_usuario_id_fk',
      columns: [t.usuarioId, t.clinicaId],
      foreignColumns: [usuario.id, usuario.clinicaId],
    }).onDelete('restrict'),
    uniqueIndex('profissional_cro_uk').on(t.clinicaId, t.cro, t.ufCro),
    check('profissional_comissao_faixa', sql`${t.comissaoPct} >= 0 and ${t.comissaoPct} <= 100`),
  ],
)
