CREATE TYPE "public"."interpretacao_resposta" AS ENUM('confirmou', 'cancelou', 'nao_entendido');--> statement-breakpoint
CREATE TYPE "public"."provedor_mensagem" AS ENUM('meta', 'simulado');--> statement-breakpoint
CREATE TYPE "public"."situacao_mensagem" AS ENUM('pendente', 'enviando', 'enviada', 'entregue', 'lida', 'falhou', 'cancelada');--> statement-breakpoint
CREATE TYPE "public"."tipo_mensagem" AS ENUM('lembrete_consulta', 'confirmacao_recebida', 'cancelamento_recebido', 'aviso_geral');--> statement-breakpoint
CREATE TABLE "mensagem_whatsapp" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paciente_id" uuid NOT NULL,
	"agendamento_id" uuid,
	"tipo" "tipo_mensagem" NOT NULL,
	"chave_idempotencia" text NOT NULL,
	"destino" varchar(15) NOT NULL,
	"corpo" text NOT NULL,
	"template" text,
	"parametros" jsonb,
	"situacao" "situacao_mensagem" DEFAULT 'pendente' NOT NULL,
	"agendado_para" timestamp with time zone NOT NULL,
	"provedor" "provedor_mensagem",
	"id_externo" text,
	"tentativas" smallint DEFAULT 0 NOT NULL,
	"reivindicado_em" timestamp with time zone,
	"enviado_em" timestamp with time zone,
	"entregue_em" timestamp with time zone,
	"lida_em" timestamp with time zone,
	"falhou_em" timestamp with time zone,
	"erro_codigo" text,
	"erro_mensagem" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mensagem_whatsapp_chave_idempotencia_unique" UNIQUE("chave_idempotencia"),
	CONSTRAINT "mensagem_destino_e164" CHECK ("mensagem_whatsapp"."destino" ~ '^55[0-9]{10,11}$'),
	CONSTRAINT "mensagem_corpo_nao_vazio" CHECK (length(btrim("mensagem_whatsapp"."corpo")) > 0),
	CONSTRAINT "mensagem_enviada_tem_carimbo" CHECK (case
        when "mensagem_whatsapp"."situacao" in ('enviada','entregue','lida') then "mensagem_whatsapp"."enviado_em" is not null
        when "mensagem_whatsapp"."situacao" in ('pendente','enviando','cancelada') then "mensagem_whatsapp"."enviado_em" is null
        else true
      end),
	CONSTRAINT "mensagem_falhou_tem_motivo" CHECK ("mensagem_whatsapp"."situacao" <> 'falhou' or ("mensagem_whatsapp"."falhou_em" is not null and "mensagem_whatsapp"."erro_mensagem" is not null)),
	CONSTRAINT "mensagem_tentativas_nao_negativa" CHECK ("mensagem_whatsapp"."tentativas" >= 0)
);
--> statement-breakpoint
CREATE TABLE "resposta_whatsapp" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"id_externo" text NOT NULL,
	"remetente" varchar(15) NOT NULL,
	"paciente_id" uuid,
	"mensagem_id" uuid,
	"agendamento_id" uuid,
	"texto" text NOT NULL,
	"interpretacao" "interpretacao_resposta" NOT NULL,
	"recebido_em" timestamp with time zone DEFAULT now() NOT NULL,
	"processado_em" timestamp with time zone,
	"acao_tomada" text,
	"tratado_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resposta_whatsapp_id_externo_unique" UNIQUE("id_externo"),
	CONSTRAINT "resposta_texto_nao_vazio" CHECK (length("resposta_whatsapp"."texto") > 0)
);
--> statement-breakpoint
ALTER TABLE "mensagem_whatsapp" ADD CONSTRAINT "mensagem_whatsapp_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id") REFERENCES "public"."paciente"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mensagem_whatsapp" ADD CONSTRAINT "mensagem_whatsapp_agendamento_id_agendamento_id_fk" FOREIGN KEY ("agendamento_id") REFERENCES "public"."agendamento"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resposta_whatsapp" ADD CONSTRAINT "resposta_whatsapp_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id") REFERENCES "public"."paciente"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resposta_whatsapp" ADD CONSTRAINT "resposta_whatsapp_mensagem_id_mensagem_whatsapp_id_fk" FOREIGN KEY ("mensagem_id") REFERENCES "public"."mensagem_whatsapp"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resposta_whatsapp" ADD CONSTRAINT "resposta_whatsapp_agendamento_id_agendamento_id_fk" FOREIGN KEY ("agendamento_id") REFERENCES "public"."agendamento"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mensagem_pendente_idx" ON "mensagem_whatsapp" USING btree ("agendado_para") WHERE "mensagem_whatsapp"."situacao" = 'pendente';--> statement-breakpoint
CREATE INDEX "mensagem_paciente_idx" ON "mensagem_whatsapp" USING btree ("paciente_id","criado_em");--> statement-breakpoint
CREATE INDEX "mensagem_agendamento_idx" ON "mensagem_whatsapp" USING btree ("agendamento_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mensagem_id_externo_uk" ON "mensagem_whatsapp" USING btree ("id_externo") WHERE "mensagem_whatsapp"."id_externo" is not null;--> statement-breakpoint
CREATE INDEX "resposta_remetente_idx" ON "resposta_whatsapp" USING btree ("remetente","recebido_em");--> statement-breakpoint
CREATE INDEX "resposta_agendamento_idx" ON "resposta_whatsapp" USING btree ("agendamento_id");--> statement-breakpoint
CREATE INDEX "resposta_pendente_humano_idx" ON "resposta_whatsapp" USING btree ("recebido_em") WHERE "resposta_whatsapp"."interpretacao" = 'nao_entendido' and "resposta_whatsapp"."tratado_em" is null;