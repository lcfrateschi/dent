CREATE TYPE "public"."estado_dente" AS ENUM('ausente', 'coroa', 'implante', 'raiz_residual');--> statement-breakpoint
CREATE TABLE "dente_paciente" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paciente_id" uuid NOT NULL,
	"dente_fdi" smallint NOT NULL,
	"estado" "estado_dente" NOT NULL,
	"observacao" text,
	"profissional_id" uuid,
	"registrado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dente_paciente" ADD CONSTRAINT "dente_paciente_paciente_id_paciente_id_fk" FOREIGN KEY ("paciente_id") REFERENCES "public"."paciente"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dente_paciente" ADD CONSTRAINT "dente_paciente_dente_fdi_dente_fdi_fk" FOREIGN KEY ("dente_fdi") REFERENCES "public"."dente"("fdi") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dente_paciente" ADD CONSTRAINT "dente_paciente_profissional_id_profissional_id_fk" FOREIGN KEY ("profissional_id") REFERENCES "public"."profissional"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dente_paciente_uk" ON "dente_paciente" USING btree ("paciente_id","dente_fdi");--> statement-breakpoint
CREATE INDEX "dente_paciente_idx" ON "dente_paciente" USING btree ("paciente_id");