CREATE TYPE "public"."acao_audit" AS ENUM('leitura', 'criacao', 'atualizacao', 'exclusao', 'exportacao', 'impressao', 'login', 'login_falho', 'logout');--> statement-breakpoint
CREATE TYPE "public"."arcada" AS ENUM('superior', 'inferior');--> statement-breakpoint
CREATE TYPE "public"."ator_tipo" AS ENUM('staff', 'paciente', 'sistema');--> statement-breakpoint
CREATE TYPE "public"."base_comissao" AS ENUM('valor_executado', 'valor_recebido');--> statement-breakpoint
CREATE TYPE "public"."base_legal" AS ENUM('consentimento', 'tutela_da_saude', 'obrigacao_legal', 'execucao_de_contrato');--> statement-breakpoint
CREATE TYPE "public"."canal_confirmacao" AS ENUM('whatsapp', 'telefone', 'portal', 'presencial');--> statement-breakpoint
CREATE TYPE "public"."cobertura" AS ENUM('particular', 'convenio');--> statement-breakpoint
CREATE TYPE "public"."denticao" AS ENUM('permanente', 'deciduo');--> statement-breakpoint
CREATE TYPE "public"."face_dente" AS ENUM('mesial', 'distal', 'vestibular', 'lingual', 'palatina', 'oclusal', 'incisal', 'cervical');--> statement-breakpoint
CREATE TYPE "public"."forma_pagamento" AS ENUM('dinheiro', 'pix', 'debito', 'credito', 'boleto', 'transferencia', 'convenio');--> statement-breakpoint
CREATE TYPE "public"."lado" AS ENUM('direito', 'esquerdo');--> statement-breakpoint
CREATE TYPE "public"."origem_agendamento" AS ENUM('recepcao', 'telefone', 'whatsapp', 'portal', 'encaixe');--> statement-breakpoint
CREATE TYPE "public"."perfil_usuario" AS ENUM('dentista', 'recepcao', 'financeiro', 'admin');--> statement-breakpoint
CREATE TYPE "public"."severidade_alerta" AS ENUM('informativo', 'atencao', 'critico');--> statement-breakpoint
CREATE TYPE "public"."sexo" AS ENUM('feminino', 'masculino', 'outro', 'nao_informado');--> statement-breakpoint
CREATE TYPE "public"."status_agendamento" AS ENUM('agendado', 'confirmado', 'em_atendimento', 'concluido', 'faltou', 'cancelado');--> statement-breakpoint
CREATE TYPE "public"."status_item_plano" AS ENUM('proposto', 'aprovado', 'recusado', 'executado', 'faturado', 'recebido', 'glosado', 'cancelado');--> statement-breakpoint
CREATE TYPE "public"."status_orcamento" AS ENUM('rascunho', 'enviado', 'aprovado', 'recusado', 'expirado');--> statement-breakpoint
CREATE TYPE "public"."status_paciente" AS ENUM('ativo', 'inativo', 'arquivado');--> statement-breakpoint
CREATE TYPE "public"."status_parcela" AS ENUM('aberta', 'parcial', 'paga', 'vencida', 'cancelada');--> statement-breakpoint
CREATE TYPE "public"."status_plano" AS ENUM('rascunho', 'ativo', 'concluido', 'cancelado');--> statement-breakpoint
CREATE TYPE "public"."tipo_dente" AS ENUM('incisivo_central', 'incisivo_lateral', 'canino', 'primeiro_premolar', 'segundo_premolar', 'primeiro_molar', 'segundo_molar', 'terceiro_molar');--> statement-breakpoint
CREATE TYPE "public"."tipo_documento" AS ENUM('atestado', 'receita', 'termo_consentimento', 'orcamento_pdf', 'radiografia', 'foto_clinica', 'exame', 'documento_pessoal', 'outro');--> statement-breakpoint
CREATE TABLE "clinica" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"razao_social" text NOT NULL,
	"nome_fantasia" text,
	"cnpj" varchar(14),
	"cro_responsavel" varchar(20),
	"uf_cro_responsavel" varchar(2),
	"telefone" varchar(20),
	"email" text,
	"cep" varchar(8),
	"logradouro" text,
	"numero" varchar(20),
	"complemento" text,
	"bairro" text,
	"cidade" text,
	"uf" varchar(2),
	"base_comissao" "base_comissao" DEFAULT 'valor_recebido' NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinica_singleton" CHECK ("clinica"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "profissional" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"cro" varchar(20) NOT NULL,
	"uf_cro" varchar(2) NOT NULL,
	"especialidade" text,
	"comissao_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profissional_usuario_id_unique" UNIQUE("usuario_id"),
	CONSTRAINT "profissional_comissao_faixa" CHECK ("profissional"."comissao_pct" >= 0 and "profissional"."comissao_pct" <= 100)
);
--> statement-breakpoint
CREATE TABLE "usuario" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"email" text NOT NULL,
	"senha_hash" text NOT NULL,
	"perfil" "perfil_usuario" NOT NULL,
	"mfa_secret" text,
	"mfa_ativo" boolean DEFAULT false NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"ultimo_login_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consentimento" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paciente_id" uuid NOT NULL,
	"base_legal" "base_legal" NOT NULL,
	"finalidade" text NOT NULL,
	"versao_termo" varchar(20) NOT NULL,
	"texto_hash" varchar(64) NOT NULL,
	"assinado_por_id" uuid,
	"aceito_em" timestamp with time zone DEFAULT now() NOT NULL,
	"revogado_em" timestamp with time zone,
	"ip" varchar(45),
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "paciente" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"nome_social" text,
	"cpf" varchar(11),
	"rg" varchar(20),
	"data_nascimento" date NOT NULL,
	"sexo" "sexo" DEFAULT 'nao_informado' NOT NULL,
	"telefone" varchar(20),
	"telefone_whatsapp" varchar(20),
	"email" text,
	"cep" varchar(8),
	"logradouro" text,
	"numero" varchar(20),
	"complemento" text,
	"bairro" text,
	"cidade" text,
	"uf" varchar(2),
	"responsavel_legal_id" uuid,
	"indicado_por" text,
	"observacoes" text,
	"status" "status_paciente" DEFAULT 'ativo' NOT NULL,
	"primeira_consulta_em" date,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paciente_conta" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paciente_id" uuid NOT NULL,
	"email" text NOT NULL,
	"senha_hash" text NOT NULL,
	"email_verificado_em" timestamp with time zone,
	"ativo" boolean DEFAULT true NOT NULL,
	"ultimo_login_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paciente_conta_paciente_id_unique" UNIQUE("paciente_id")
);
--> statement-breakpoint
CREATE TABLE "dente" (
	"fdi" smallint PRIMARY KEY NOT NULL,
	"denticao" "denticao" NOT NULL,
	"arcada" "arcada" NOT NULL,
	"lado" "lado" NOT NULL,
	"quadrante" smallint NOT NULL,
	"tipo" "tipo_dente" NOT NULL,
	"faces_validas" "face_dente"[] NOT NULL,
	"sucessor_fdi" smallint,
	"nome" text NOT NULL,
	CONSTRAINT "dente_quadrante_valido" CHECK ("dente"."quadrante" between 1 and 8),
	CONSTRAINT "dente_fdi_valido" CHECK (("dente"."fdi" between 11 and 48 or "dente"."fdi" between 51 and 85) and ("dente"."fdi" % 10) between 1 and 8)
);
--> statement-breakpoint
CREATE TABLE "procedimento" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"codigo_tuss" varchar(20),
	"codigo" varchar(30) NOT NULL,
	"nome" text NOT NULL,
	"descricao" text,
	"especialidade" text,
	"valor_particular" numeric(10, 2) NOT NULL,
	"requer_dente" boolean DEFAULT false NOT NULL,
	"requer_face" boolean DEFAULT false NOT NULL,
	"duracao_minutos" smallint DEFAULT 30 NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "procedimento_codigo_unique" UNIQUE("codigo"),
	CONSTRAINT "procedimento_valor_nao_negativo" CHECK ("procedimento"."valor_particular" >= 0),
	CONSTRAINT "procedimento_face_implica_dente" CHECK (not "procedimento"."requer_face" or "procedimento"."requer_dente")
);
--> statement-breakpoint
CREATE TABLE "convenio" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"registro_ans" varchar(20),
	"cnpj" varchar(14),
	"prazo_pagamento_dias" smallint DEFAULT 30 NOT NULL,
	"dia_fechamento" smallint,
	"contato_nome" text,
	"contato_telefone" varchar(20),
	"observacoes" text,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "convenio_nome_unique" UNIQUE("nome")
);
--> statement-breakpoint
CREATE TABLE "paciente_convenio" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paciente_id" uuid NOT NULL,
	"convenio_id" uuid NOT NULL,
	"numero_carteirinha" varchar(40) NOT NULL,
	"plano" text,
	"eh_titular" boolean DEFAULT true NOT NULL,
	"nome_titular" text,
	"adesao_em" date,
	"validade" date,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paciente_convenio_titular_nomeado" CHECK ("paciente_convenio"."eh_titular" or "paciente_convenio"."nome_titular" is not null)
);
--> statement-breakpoint
CREATE TABLE "preco_convenio" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"convenio_id" uuid NOT NULL,
	"procedimento_id" uuid NOT NULL,
	"valor" numeric(10, 2) NOT NULL,
	"cobertura_pct" numeric(5, 2) DEFAULT '100' NOT NULL,
	"carencia_dias" smallint DEFAULT 0 NOT NULL,
	"vigencia_inicio" date NOT NULL,
	"vigencia_fim" date,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preco_convenio_valor_nao_negativo" CHECK ("preco_convenio"."valor" >= 0),
	CONSTRAINT "preco_convenio_cobertura_faixa" CHECK ("preco_convenio"."cobertura_pct" between 0 and 100),
	CONSTRAINT "preco_convenio_vigencia_ordenada" CHECK ("preco_convenio"."vigencia_fim" is null or "preco_convenio"."vigencia_fim" >= "preco_convenio"."vigencia_inicio")
);
--> statement-breakpoint
CREATE TABLE "agendamento" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paciente_id" uuid NOT NULL,
	"profissional_id" uuid NOT NULL,
	"cadeira_id" uuid,
	"inicio" timestamp with time zone NOT NULL,
	"fim" timestamp with time zone NOT NULL,
	"status" "status_agendamento" DEFAULT 'agendado' NOT NULL,
	"origem" "origem_agendamento" DEFAULT 'recepcao' NOT NULL,
	"motivo" text,
	"observacao" text,
	"confirmado_em" timestamp with time zone,
	"confirmado_via" "canal_confirmacao",
	"chegou_em" timestamp with time zone,
	"iniciado_em" timestamp with time zone,
	"concluido_em" timestamp with time zone,
	"motivo_cancelamento" text,
	"cancelado_em" timestamp with time zone,
	"criado_por_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agendamento_intervalo_valido" CHECK ("agendamento"."fim" > "agendamento"."inicio"),
	CONSTRAINT "agendamento_cancelado_tem_motivo" CHECK ("agendamento"."status" <> 'cancelado' or "agendamento"."motivo_cancelamento" is not null)
);
--> statement-breakpoint
CREATE TABLE "bloqueio_agenda" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profissional_id" uuid,
	"cadeira_id" uuid,
	"inicio" timestamp with time zone NOT NULL,
	"fim" timestamp with time zone NOT NULL,
	"motivo" text NOT NULL,
	"criado_por_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bloqueio_intervalo_valido" CHECK ("bloqueio_agenda"."fim" > "bloqueio_agenda"."inicio")
);
--> statement-breakpoint
CREATE TABLE "cadeira" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"ordem" smallint DEFAULT 0 NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	CONSTRAINT "cadeira_nome_unique" UNIQUE("nome")
);
--> statement-breakpoint
CREATE TABLE "alerta_clinico" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paciente_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"descricao" text NOT NULL,
	"severidade" "severidade_alerta" DEFAULT 'atencao' NOT NULL,
	"origem_anamnese_id" uuid,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anamnese" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paciente_id" uuid NOT NULL,
	"profissional_id" uuid,
	"versao" integer NOT NULL,
	"respostas" jsonb NOT NULL,
	"versao_formulario" varchar(20) NOT NULL,
	"preenchida_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anamnese_versao_positiva" CHECK ("anamnese"."versao" >= 1)
);
--> statement-breakpoint
CREATE TABLE "evolucao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paciente_id" uuid NOT NULL,
	"profissional_id" uuid NOT NULL,
	"agendamento_id" uuid,
	"texto" text NOT NULL,
	"assinado_em" timestamp with time zone,
	"assinatura_hash" varchar(64),
	"retifica_id" uuid,
	"motivo_retificacao" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evolucao_texto_nao_vazio" CHECK (length(btrim("evolucao"."texto")) > 0),
	CONSTRAINT "evolucao_retificacao_justificada" CHECK ("evolucao"."retifica_id" is null or "evolucao"."motivo_retificacao" is not null),
	CONSTRAINT "evolucao_assinatura_completa" CHECK (("evolucao"."assinado_em" is null) = ("evolucao"."assinatura_hash" is null))
);
--> statement-breakpoint
CREATE TABLE "execucao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_plano_id" uuid NOT NULL,
	"profissional_id" uuid NOT NULL,
	"agendamento_id" uuid,
	"executado_em" timestamp with time zone NOT NULL,
	"observacao" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_plano" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plano_id" uuid NOT NULL,
	"procedimento_id" uuid NOT NULL,
	"dente_fdi" smallint,
	"faces" "face_dente"[],
	"cobertura" "cobertura" DEFAULT 'particular' NOT NULL,
	"convenio_id" uuid,
	"guia_tiss_id" uuid,
	"valor" numeric(10, 2) NOT NULL,
	"valor_coparticipacao" numeric(10, 2) DEFAULT '0' NOT NULL,
	"status" "status_item_plano" DEFAULT 'proposto' NOT NULL,
	"ordem" smallint DEFAULT 0 NOT NULL,
	"observacao" text,
	"aprovado_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_plano_valor_nao_negativo" CHECK ("item_plano"."valor" >= 0),
	CONSTRAINT "item_plano_copart_nao_negativa" CHECK ("item_plano"."valor_coparticipacao" >= 0),
	CONSTRAINT "item_plano_convenio_coerente" CHECK (("item_plano"."cobertura" = 'convenio') = ("item_plano"."convenio_id" is not null)),
	CONSTRAINT "item_plano_face_exige_dente" CHECK ("item_plano"."faces" is null or cardinality("item_plano"."faces") = 0 or "item_plano"."dente_fdi" is not null)
);
--> statement-breakpoint
CREATE TABLE "plano_tratamento" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paciente_id" uuid NOT NULL,
	"profissional_id" uuid NOT NULL,
	"titulo" text NOT NULL,
	"diagnostico" text,
	"observacao" text,
	"status" "status_plano" DEFAULT 'rascunho' NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"concluido_em" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cobranca" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paciente_id" uuid NOT NULL,
	"orcamento_id" uuid,
	"valor_total" numeric(10, 2) NOT NULL,
	"forma" "forma_pagamento" NOT NULL,
	"qtd_parcelas" smallint DEFAULT 1 NOT NULL,
	"observacao" text,
	"criado_por_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelado_em" timestamp with time zone,
	CONSTRAINT "cobranca_valor_positivo" CHECK ("cobranca"."valor_total" > 0),
	CONSTRAINT "cobranca_parcelas_positivas" CHECK ("cobranca"."qtd_parcelas" >= 1)
);
--> statement-breakpoint
CREATE TABLE "orcamento" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" integer NOT NULL,
	"paciente_id" uuid NOT NULL,
	"plano_id" uuid,
	"status" "status_orcamento" DEFAULT 'rascunho' NOT NULL,
	"validade_ate" date NOT NULL,
	"valor_bruto" numeric(10, 2) NOT NULL,
	"desconto" numeric(10, 2) DEFAULT '0' NOT NULL,
	"valor_total" numeric(10, 2) NOT NULL,
	"observacao" text,
	"pdf_key" text,
	"criado_por_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"enviado_em" timestamp with time zone,
	"decidido_em" timestamp with time zone,
	CONSTRAINT "orcamento_numero_unique" UNIQUE("numero"),
	CONSTRAINT "orcamento_desconto_nao_negativo" CHECK ("orcamento"."desconto" >= 0),
	CONSTRAINT "orcamento_total_coerente" CHECK ("orcamento"."valor_total" = "orcamento"."valor_bruto" - "orcamento"."desconto"),
	CONSTRAINT "orcamento_total_nao_negativo" CHECK ("orcamento"."valor_total" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orcamento_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"orcamento_id" uuid NOT NULL,
	"item_plano_id" uuid,
	"descricao" text NOT NULL,
	"detalhe" text,
	"quantidade" smallint DEFAULT 1 NOT NULL,
	"valor_unitario" numeric(10, 2) NOT NULL,
	"ordem" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "orcamento_item_qtd_positiva" CHECK ("orcamento_item"."quantidade" > 0),
	CONSTRAINT "orcamento_item_valor_nao_negativo" CHECK ("orcamento_item"."valor_unitario" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pagamento" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parcela_id" uuid NOT NULL,
	"valor" numeric(10, 2) NOT NULL,
	"pago_em" date NOT NULL,
	"meio" "forma_pagamento" NOT NULL,
	"conciliado" boolean DEFAULT false NOT NULL,
	"conciliado_em" timestamp with time zone,
	"comprovante" text,
	"observacao" text,
	"registrado_por_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"estornado_em" timestamp with time zone,
	"motivo_estorno" text,
	CONSTRAINT "pagamento_valor_positivo" CHECK ("pagamento"."valor" > 0),
	CONSTRAINT "pagamento_estorno_justificado" CHECK ("pagamento"."estornado_em" is null or "pagamento"."motivo_estorno" is not null),
	CONSTRAINT "pagamento_conciliacao_coerente" CHECK ("pagamento"."conciliado" = ("pagamento"."conciliado_em" is not null))
);
--> statement-breakpoint
CREATE TABLE "parcela" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cobranca_id" uuid NOT NULL,
	"numero" smallint NOT NULL,
	"vencimento" date NOT NULL,
	"valor" numeric(10, 2) NOT NULL,
	"status" "status_parcela" DEFAULT 'aberta' NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parcela_numero_positivo" CHECK ("parcela"."numero" >= 1),
	CONSTRAINT "parcela_valor_positivo" CHECK ("parcela"."valor" > 0)
);
--> statement-breakpoint
CREATE TABLE "documento" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paciente_id" uuid NOT NULL,
	"tipo" "tipo_documento" NOT NULL,
	"nome" text NOT NULL,
	"descricao" text,
	"dente_fdi" smallint,
	"storage_key" text NOT NULL,
	"mime_type" varchar(120) NOT NULL,
	"tamanho_bytes" bigint NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"data_exame" timestamp with time zone,
	"profissional_id" uuid,
	"criado_por_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"removido_em" timestamp with time zone,
	"motivo_remocao" text,
	CONSTRAINT "documento_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "documento_tamanho_positivo" CHECK ("documento"."tamanho_bytes" > 0),
	CONSTRAINT "documento_remocao_justificada" CHECK ("documento"."removido_em" is null or "documento"."motivo_remocao" is not null)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ator_tipo" varchar(20) NOT NULL,
	"ator_id" uuid,
	"ator_email" text,
	"acao" varchar(30) NOT NULL,
	"entidade" varchar(60) NOT NULL,
	"entidade_id" text,
	"paciente_id" uuid,
	"ip" varchar(45),
	"user_agent" text,
	"detalhes" jsonb,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_ator_tipo_valido" CHECK ("audit_log"."ator_tipo" in ('staff', 'paciente', 'sistema'))
);
--> statement-breakpoint
ALTER TABLE "profissional" ADD CONSTRAINT "profissional_usuario_id_usuario_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuario"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consentimento" ADD CONSTRAINT "consentimento_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id") REFERENCES "public"."paciente"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consentimento" ADD CONSTRAINT "consentimento_assinado_por_id_paciente_id_fk" FOREIGN KEY ("assinado_por_id") REFERENCES "public"."paciente"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paciente" ADD CONSTRAINT "paciente_responsavel_legal_id_paciente_id_fk" FOREIGN KEY ("responsavel_legal_id") REFERENCES "public"."paciente"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paciente_conta" ADD CONSTRAINT "paciente_conta_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id") REFERENCES "public"."paciente"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dente" ADD CONSTRAINT "dente_sucessor_fdi_dente_fdi_fk" FOREIGN KEY ("sucessor_fdi") REFERENCES "public"."dente"("fdi") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paciente_convenio" ADD CONSTRAINT "paciente_convenio_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id") REFERENCES "public"."paciente"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paciente_convenio" ADD CONSTRAINT "paciente_convenio_convenio_id_convenio_id_fk" FOREIGN KEY ("convenio_id") REFERENCES "public"."convenio"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preco_convenio" ADD CONSTRAINT "preco_convenio_convenio_id_convenio_id_fk" FOREIGN KEY ("convenio_id") REFERENCES "public"."convenio"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preco_convenio" ADD CONSTRAINT "preco_convenio_procedimento_id_procedimento_id_fk" FOREIGN KEY ("procedimento_id") REFERENCES "public"."procedimento"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agendamento" ADD CONSTRAINT "agendamento_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id") REFERENCES "public"."paciente"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agendamento" ADD CONSTRAINT "agendamento_profissional_id_profissional_id_fk" FOREIGN KEY ("profissional_id") REFERENCES "public"."profissional"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agendamento" ADD CONSTRAINT "agendamento_cadeira_id_cadeira_id_fk" FOREIGN KEY ("cadeira_id") REFERENCES "public"."cadeira"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agendamento" ADD CONSTRAINT "agendamento_criado_por_id_usuario_id_fk" FOREIGN KEY ("criado_por_id") REFERENCES "public"."usuario"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bloqueio_agenda" ADD CONSTRAINT "bloqueio_agenda_profissional_id_profissional_id_fk" FOREIGN KEY ("profissional_id") REFERENCES "public"."profissional"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bloqueio_agenda" ADD CONSTRAINT "bloqueio_agenda_cadeira_id_cadeira_id_fk" FOREIGN KEY ("cadeira_id") REFERENCES "public"."cadeira"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bloqueio_agenda" ADD CONSTRAINT "bloqueio_agenda_criado_por_id_usuario_id_fk" FOREIGN KEY ("criado_por_id") REFERENCES "public"."usuario"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerta_clinico" ADD CONSTRAINT "alerta_clinico_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id") REFERENCES "public"."paciente"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerta_clinico" ADD CONSTRAINT "alerta_clinico_origem_anamnese_id_anamnese_id_fk" FOREIGN KEY ("origem_anamnese_id") REFERENCES "public"."anamnese"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anamnese" ADD CONSTRAINT "anamnese_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id") REFERENCES "public"."paciente"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anamnese" ADD CONSTRAINT "anamnese_profissional_id_profissional_id_fk" FOREIGN KEY ("profissional_id") REFERENCES "public"."profissional"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolucao" ADD CONSTRAINT "evolucao_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id") REFERENCES "public"."paciente"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolucao" ADD CONSTRAINT "evolucao_profissional_id_profissional_id_fk" FOREIGN KEY ("profissional_id") REFERENCES "public"."profissional"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolucao" ADD CONSTRAINT "evolucao_agendamento_id_agendamento_id_fk" FOREIGN KEY ("agendamento_id") REFERENCES "public"."agendamento"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evolucao" ADD CONSTRAINT "evolucao_retifica_id_evolucao_id_fk" FOREIGN KEY ("retifica_id") REFERENCES "public"."evolucao"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execucao" ADD CONSTRAINT "execucao_item_plano_id_item_plano_id_fk" FOREIGN KEY ("item_plano_id") REFERENCES "public"."item_plano"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execucao" ADD CONSTRAINT "execucao_profissional_id_profissional_id_fk" FOREIGN KEY ("profissional_id") REFERENCES "public"."profissional"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execucao" ADD CONSTRAINT "execucao_agendamento_id_agendamento_id_fk" FOREIGN KEY ("agendamento_id") REFERENCES "public"."agendamento"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_plano" ADD CONSTRAINT "item_plano_plano_id_plano_tratamento_id_fk" FOREIGN KEY ("plano_id") REFERENCES "public"."plano_tratamento"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_plano" ADD CONSTRAINT "item_plano_procedimento_id_procedimento_id_fk" FOREIGN KEY ("procedimento_id") REFERENCES "public"."procedimento"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_plano" ADD CONSTRAINT "item_plano_dente_fdi_dente_fdi_fk" FOREIGN KEY ("dente_fdi") REFERENCES "public"."dente"("fdi") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_plano" ADD CONSTRAINT "item_plano_convenio_id_convenio_id_fk" FOREIGN KEY ("convenio_id") REFERENCES "public"."convenio"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plano_tratamento" ADD CONSTRAINT "plano_tratamento_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id") REFERENCES "public"."paciente"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plano_tratamento" ADD CONSTRAINT "plano_tratamento_profissional_id_profissional_id_fk" FOREIGN KEY ("profissional_id") REFERENCES "public"."profissional"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca" ADD CONSTRAINT "cobranca_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id") REFERENCES "public"."paciente"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca" ADD CONSTRAINT "cobranca_orcamento_id_orcamento_id_fk" FOREIGN KEY ("orcamento_id") REFERENCES "public"."orcamento"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobranca" ADD CONSTRAINT "cobranca_criado_por_id_usuario_id_fk" FOREIGN KEY ("criado_por_id") REFERENCES "public"."usuario"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orcamento" ADD CONSTRAINT "orcamento_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id") REFERENCES "public"."paciente"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orcamento" ADD CONSTRAINT "orcamento_plano_id_plano_tratamento_id_fk" FOREIGN KEY ("plano_id") REFERENCES "public"."plano_tratamento"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orcamento" ADD CONSTRAINT "orcamento_criado_por_id_usuario_id_fk" FOREIGN KEY ("criado_por_id") REFERENCES "public"."usuario"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orcamento_item" ADD CONSTRAINT "orcamento_item_orcamento_id_orcamento_id_fk" FOREIGN KEY ("orcamento_id") REFERENCES "public"."orcamento"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orcamento_item" ADD CONSTRAINT "orcamento_item_item_plano_id_item_plano_id_fk" FOREIGN KEY ("item_plano_id") REFERENCES "public"."item_plano"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamento" ADD CONSTRAINT "pagamento_parcela_id_parcela_id_fk" FOREIGN KEY ("parcela_id") REFERENCES "public"."parcela"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamento" ADD CONSTRAINT "pagamento_registrado_por_id_usuario_id_fk" FOREIGN KEY ("registrado_por_id") REFERENCES "public"."usuario"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parcela" ADD CONSTRAINT "parcela_cobranca_id_cobranca_id_fk" FOREIGN KEY ("cobranca_id") REFERENCES "public"."cobranca"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documento" ADD CONSTRAINT "documento_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id") REFERENCES "public"."paciente"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documento" ADD CONSTRAINT "documento_dente_fdi_dente_fdi_fk" FOREIGN KEY ("dente_fdi") REFERENCES "public"."dente"("fdi") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documento" ADD CONSTRAINT "documento_profissional_id_profissional_id_fk" FOREIGN KEY ("profissional_id") REFERENCES "public"."profissional"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documento" ADD CONSTRAINT "documento_criado_por_id_usuario_id_fk" FOREIGN KEY ("criado_por_id") REFERENCES "public"."usuario"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "profissional_cro_uk" ON "profissional" USING btree ("cro","uf_cro");--> statement-breakpoint
CREATE UNIQUE INDEX "usuario_email_uk" ON "usuario" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "consentimento_paciente_idx" ON "consentimento" USING btree ("paciente_id","aceito_em");--> statement-breakpoint
CREATE UNIQUE INDEX "paciente_cpf_uk" ON "paciente" USING btree ("cpf") WHERE "paciente"."cpf" is not null;--> statement-breakpoint
CREATE INDEX "paciente_nome_idx" ON "paciente" USING btree (lower("nome"));--> statement-breakpoint
CREATE INDEX "paciente_responsavel_idx" ON "paciente" USING btree ("responsavel_legal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paciente_conta_email_uk" ON "paciente_conta" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "procedimento_tuss_uk" ON "procedimento" USING btree ("codigo_tuss") WHERE "procedimento"."codigo_tuss" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "paciente_convenio_carteirinha_uk" ON "paciente_convenio" USING btree ("convenio_id","numero_carteirinha");--> statement-breakpoint
CREATE INDEX "paciente_convenio_paciente_idx" ON "paciente_convenio" USING btree ("paciente_id");--> statement-breakpoint
CREATE UNIQUE INDEX "preco_convenio_uk" ON "preco_convenio" USING btree ("convenio_id","procedimento_id","vigencia_inicio");--> statement-breakpoint
CREATE INDEX "agendamento_profissional_periodo_idx" ON "agendamento" USING btree ("profissional_id","inicio");--> statement-breakpoint
CREATE INDEX "agendamento_paciente_idx" ON "agendamento" USING btree ("paciente_id","inicio");--> statement-breakpoint
CREATE INDEX "agendamento_dia_idx" ON "agendamento" USING btree ("inicio");--> statement-breakpoint
CREATE INDEX "bloqueio_periodo_idx" ON "bloqueio_agenda" USING btree ("inicio","fim");--> statement-breakpoint
CREATE INDEX "alerta_paciente_ativo_idx" ON "alerta_clinico" USING btree ("paciente_id") WHERE "alerta_clinico"."ativo";--> statement-breakpoint
CREATE UNIQUE INDEX "anamnese_paciente_versao_uk" ON "anamnese" USING btree ("paciente_id","versao");--> statement-breakpoint
CREATE INDEX "evolucao_paciente_idx" ON "evolucao" USING btree ("paciente_id","criado_em");--> statement-breakpoint
CREATE UNIQUE INDEX "evolucao_retifica_uk" ON "evolucao" USING btree ("retifica_id") WHERE "evolucao"."retifica_id" is not null;--> statement-breakpoint
CREATE INDEX "execucao_item_idx" ON "execucao" USING btree ("item_plano_id");--> statement-breakpoint
CREATE INDEX "execucao_profissional_periodo_idx" ON "execucao" USING btree ("profissional_id","executado_em");--> statement-breakpoint
CREATE INDEX "item_plano_plano_idx" ON "item_plano" USING btree ("plano_id","ordem");--> statement-breakpoint
CREATE INDEX "item_plano_status_idx" ON "item_plano" USING btree ("status");--> statement-breakpoint
CREATE INDEX "item_plano_dente_idx" ON "item_plano" USING btree ("dente_fdi");--> statement-breakpoint
CREATE INDEX "item_plano_guia_idx" ON "item_plano" USING btree ("guia_tiss_id") WHERE "item_plano"."guia_tiss_id" is not null;--> statement-breakpoint
CREATE INDEX "plano_paciente_idx" ON "plano_tratamento" USING btree ("paciente_id","criado_em");--> statement-breakpoint
CREATE INDEX "cobranca_paciente_idx" ON "cobranca" USING btree ("paciente_id","criado_em");--> statement-breakpoint
CREATE INDEX "orcamento_paciente_idx" ON "orcamento" USING btree ("paciente_id","criado_em");--> statement-breakpoint
CREATE INDEX "orcamento_item_orcamento_idx" ON "orcamento_item" USING btree ("orcamento_id","ordem");--> statement-breakpoint
CREATE INDEX "pagamento_parcela_idx" ON "pagamento" USING btree ("parcela_id");--> statement-breakpoint
CREATE INDEX "pagamento_data_idx" ON "pagamento" USING btree ("pago_em");--> statement-breakpoint
CREATE UNIQUE INDEX "parcela_cobranca_numero_uk" ON "parcela" USING btree ("cobranca_id","numero");--> statement-breakpoint
CREATE INDEX "parcela_vencimento_idx" ON "parcela" USING btree ("vencimento","status");--> statement-breakpoint
CREATE INDEX "documento_paciente_idx" ON "documento" USING btree ("paciente_id","criado_em");--> statement-breakpoint
CREATE INDEX "documento_tipo_idx" ON "documento" USING btree ("paciente_id","tipo");--> statement-breakpoint
CREATE INDEX "audit_paciente_idx" ON "audit_log" USING btree ("paciente_id","criado_em");--> statement-breakpoint
CREATE INDEX "audit_ator_idx" ON "audit_log" USING btree ("ator_id","criado_em");--> statement-breakpoint
CREATE INDEX "audit_acao_idx" ON "audit_log" USING btree ("acao","criado_em");--> statement-breakpoint
CREATE INDEX "audit_entidade_idx" ON "audit_log" USING btree ("entidade","entidade_id");