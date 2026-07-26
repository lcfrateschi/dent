CREATE TABLE "paciente_sessao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conta_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"expira_em" timestamp with time zone NOT NULL,
	"ultimo_uso_em" timestamp with time zone DEFAULT now() NOT NULL,
	"revogada_em" timestamp with time zone,
	"revogada_por_usuario_id" uuid,
	"ip" varchar(45),
	"user_agent" text,
	CONSTRAINT "paciente_sessao_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "paciente_sessao_prazo_futuro" CHECK ("paciente_sessao"."expira_em" > "paciente_sessao"."criado_em")
);
--> statement-breakpoint
ALTER TABLE "paciente_conta" ALTER COLUMN "senha_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "paciente_conta" ADD COLUMN "senha_definida_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paciente_conta" ADD COLUMN "token_convite_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "paciente_conta" ADD COLUMN "token_convite_expira_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paciente_conta" ADD COLUMN "bloqueado_ate" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paciente_conta" ADD COLUMN "atualizado_em" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "paciente_sessao" ADD CONSTRAINT "paciente_sessao_conta_id_paciente_conta_id_fk" FOREIGN KEY ("conta_id") REFERENCES "public"."paciente_conta"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paciente_sessao_conta_idx" ON "paciente_sessao" USING btree ("conta_id","criado_em");--> statement-breakpoint
CREATE INDEX "paciente_conta_convite_idx" ON "paciente_conta" USING btree ("token_convite_hash") WHERE "paciente_conta"."token_convite_hash" is not null;--> statement-breakpoint
ALTER TABLE "paciente_conta" ADD CONSTRAINT "paciente_conta_convite_tem_prazo" CHECK ("paciente_conta"."token_convite_hash" is null or "paciente_conta"."token_convite_expira_em" is not null);--> statement-breakpoint
ALTER TABLE "paciente_conta" ADD CONSTRAINT "paciente_conta_senha_tem_carimbo" CHECK (("paciente_conta"."senha_hash" is null) = ("paciente_conta"."senha_definida_em" is null));