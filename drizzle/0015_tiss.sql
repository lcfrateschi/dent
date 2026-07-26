CREATE TYPE "public"."classe_glosa" AS ENUM('erro_de_envio', 'nao_coberto', 'elegibilidade', 'valor', 'falta_documento', 'prazo', 'outro');--> statement-breakpoint
CREATE TYPE "public"."situacao_guia" AS ENUM('rascunho', 'enviada', 'em_analise', 'paga', 'glosada_parcial', 'glosada_total', 'cancelada');--> statement-breakpoint
CREATE TYPE "public"."situacao_item_guia" AS ENUM('apresentado', 'pago', 'glosado_parcial', 'glosado_total', 'em_recurso', 'reapresentado');--> statement-breakpoint
CREATE TABLE "glosa" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_guia_id" uuid NOT NULL,
	"codigo_operadora" varchar(20),
	"classe" "classe_glosa" NOT NULL,
	"motivo" text NOT NULL,
	"valor" numeric(10, 2) NOT NULL,
	"registrada_em" timestamp with time zone DEFAULT now() NOT NULL,
	"registrada_por_id" uuid,
	CONSTRAINT "glosa_valor_positivo" CHECK ("glosa"."valor" > 0),
	CONSTRAINT "glosa_motivo_nao_vazio" CHECK (length(btrim("glosa"."motivo")) > 0)
);
--> statement-breakpoint
CREATE TABLE "guia_tiss" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" numeric(12, 0) DEFAULT nextval('guia_numero_seq') NOT NULL,
	"convenio_id" uuid NOT NULL,
	"paciente_id" uuid NOT NULL,
	"numero_carteirinha" varchar(40) NOT NULL,
	"profissional_id" uuid NOT NULL,
	"situacao" "situacao_guia" DEFAULT 'rascunho' NOT NULL,
	"valor_apresentado" numeric(12, 2) DEFAULT '0' NOT NULL,
	"valor_pago" numeric(12, 2) DEFAULT '0' NOT NULL,
	"numero_lote" varchar(30),
	"protocolo_operadora" varchar(60),
	"emitida_em" timestamp with time zone DEFAULT now() NOT NULL,
	"enviada_em" timestamp with time zone,
	"retorno_em" timestamp with time zone,
	"previsao_repasse" date,
	"observacao" text,
	"criado_por_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guia_tiss_numero_unique" UNIQUE("numero"),
	CONSTRAINT "guia_valores_nao_negativos" CHECK ("guia_tiss"."valor_apresentado" >= 0 and "guia_tiss"."valor_pago" >= 0),
	CONSTRAINT "guia_enviada_tem_carimbo" CHECK ("guia_tiss"."situacao" = 'rascunho' or "guia_tiss"."situacao" = 'cancelada' or "guia_tiss"."enviada_em" is not null),
	CONSTRAINT "guia_rascunho_sem_carimbo" CHECK ("guia_tiss"."situacao" <> 'rascunho' or "guia_tiss"."enviada_em" is null)
);
--> statement-breakpoint
CREATE TABLE "item_guia" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guia_id" uuid NOT NULL,
	"item_plano_id" uuid NOT NULL,
	"codigo_tuss" varchar(20),
	"descricao" text NOT NULL,
	"dente_fdi" smallint,
	"faces" varchar(60),
	"quantidade" smallint DEFAULT 1 NOT NULL,
	"data_execucao" date NOT NULL,
	"valor_apresentado" numeric(10, 2) NOT NULL,
	"valor_pago" numeric(10, 2),
	"situacao" "situacao_item_guia" DEFAULT 'apresentado' NOT NULL,
	"tentativa" smallint DEFAULT 1 NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_guia_valor_positivo" CHECK ("item_guia"."valor_apresentado" > 0),
	CONSTRAINT "item_guia_pago_nao_negativo" CHECK ("item_guia"."valor_pago" is null or "item_guia"."valor_pago" >= 0),
	CONSTRAINT "item_guia_quantidade_positiva" CHECK ("item_guia"."quantidade" > 0),
	CONSTRAINT "item_guia_tentativa_positiva" CHECK ("item_guia"."tentativa" > 0)
);
--> statement-breakpoint
CREATE TABLE "recurso_glosa" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"glosa_id" uuid NOT NULL,
	"argumento" text NOT NULL,
	"documento_ids" uuid[],
	"enviado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"deferido" boolean,
	"resposta_em" timestamp with time zone,
	"resposta_motivo" text,
	"enviado_por_id" uuid,
	CONSTRAINT "recurso_argumento_nao_vazio" CHECK (length(btrim("recurso_glosa"."argumento")) > 0),
	CONSTRAINT "recurso_resposta_coerente" CHECK (("recurso_glosa"."deferido" is null) = ("recurso_glosa"."resposta_em" is null))
);
--> statement-breakpoint
CREATE TABLE "repasse" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"convenio_id" uuid NOT NULL,
	"valor_total" numeric(12, 2) NOT NULL,
	"valor_conciliado" numeric(12, 2) DEFAULT '0' NOT NULL,
	"recebido_em" date NOT NULL,
	"demonstrativo" varchar(60),
	"observacao" text,
	"fechado_em" timestamp with time zone,
	"criado_por_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repasse_valor_positivo" CHECK ("repasse"."valor_total" > 0),
	CONSTRAINT "repasse_conciliado_nao_negativo" CHECK ("repasse"."valor_conciliado" >= 0)
);
--> statement-breakpoint
CREATE TABLE "repasse_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repasse_id" uuid NOT NULL,
	"item_guia_id" uuid NOT NULL,
	"valor" numeric(10, 2) NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repasse_item_valor_nao_negativo" CHECK ("repasse_item"."valor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "glosa" ADD CONSTRAINT "glosa_item_guia_id_item_guia_id_fk" FOREIGN KEY ("item_guia_id") REFERENCES "public"."item_guia"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glosa" ADD CONSTRAINT "glosa_registrada_por_id_usuario_id_fk" FOREIGN KEY ("registrada_por_id") REFERENCES "public"."usuario"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guia_tiss" ADD CONSTRAINT "guia_tiss_convenio_id_convenio_id_fk" FOREIGN KEY ("convenio_id") REFERENCES "public"."convenio"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guia_tiss" ADD CONSTRAINT "guia_tiss_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id") REFERENCES "public"."paciente"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guia_tiss" ADD CONSTRAINT "guia_tiss_profissional_id_profissional_id_fk" FOREIGN KEY ("profissional_id") REFERENCES "public"."profissional"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guia_tiss" ADD CONSTRAINT "guia_tiss_criado_por_id_usuario_id_fk" FOREIGN KEY ("criado_por_id") REFERENCES "public"."usuario"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_guia" ADD CONSTRAINT "item_guia_guia_id_guia_tiss_id_fk" FOREIGN KEY ("guia_id") REFERENCES "public"."guia_tiss"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_guia" ADD CONSTRAINT "item_guia_item_plano_id_item_plano_id_fk" FOREIGN KEY ("item_plano_id") REFERENCES "public"."item_plano"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurso_glosa" ADD CONSTRAINT "recurso_glosa_glosa_id_glosa_id_fk" FOREIGN KEY ("glosa_id") REFERENCES "public"."glosa"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurso_glosa" ADD CONSTRAINT "recurso_glosa_enviado_por_id_usuario_id_fk" FOREIGN KEY ("enviado_por_id") REFERENCES "public"."usuario"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repasse" ADD CONSTRAINT "repasse_convenio_id_convenio_id_fk" FOREIGN KEY ("convenio_id") REFERENCES "public"."convenio"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repasse" ADD CONSTRAINT "repasse_criado_por_id_usuario_id_fk" FOREIGN KEY ("criado_por_id") REFERENCES "public"."usuario"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repasse_item" ADD CONSTRAINT "repasse_item_repasse_id_repasse_id_fk" FOREIGN KEY ("repasse_id") REFERENCES "public"."repasse"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repasse_item" ADD CONSTRAINT "repasse_item_item_guia_id_item_guia_id_fk" FOREIGN KEY ("item_guia_id") REFERENCES "public"."item_guia"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "glosa_item_idx" ON "glosa" USING btree ("item_guia_id");--> statement-breakpoint
CREATE INDEX "glosa_classe_idx" ON "glosa" USING btree ("classe","registrada_em");--> statement-breakpoint
CREATE INDEX "guia_convenio_idx" ON "guia_tiss" USING btree ("convenio_id","situacao");--> statement-breakpoint
CREATE INDEX "guia_paciente_idx" ON "guia_tiss" USING btree ("paciente_id","emitida_em");--> statement-breakpoint
CREATE INDEX "guia_lote_idx" ON "guia_tiss" USING btree ("numero_lote") WHERE "guia_tiss"."numero_lote" is not null;--> statement-breakpoint
CREATE INDEX "guia_previsao_idx" ON "guia_tiss" USING btree ("previsao_repasse") WHERE "guia_tiss"."situacao" in ('enviada','em_analise','glosada_parcial');--> statement-breakpoint
CREATE INDEX "item_guia_guia_idx" ON "item_guia" USING btree ("guia_id");--> statement-breakpoint
CREATE INDEX "item_guia_plano_idx" ON "item_guia" USING btree ("item_plano_id");--> statement-breakpoint
CREATE UNIQUE INDEX "item_guia_unico_por_tentativa" ON "item_guia" USING btree ("guia_id","item_plano_id","tentativa");--> statement-breakpoint
CREATE INDEX "recurso_glosa_idx" ON "recurso_glosa" USING btree ("glosa_id");--> statement-breakpoint
CREATE INDEX "repasse_convenio_idx" ON "repasse" USING btree ("convenio_id","recebido_em");--> statement-breakpoint
CREATE INDEX "repasse_item_repasse_idx" ON "repasse_item" USING btree ("repasse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repasse_item_unico" ON "repasse_item" USING btree ("repasse_id","item_guia_id");