CREATE TYPE "public"."etapa_documento" AS ENUM('inicial', 'durante', 'final');--> statement-breakpoint
-- O drop/recria de `mensagem_enviada_tem_carimbo` abaixo é ruído do gerador: a
-- 0008 foi editada à mão depois de o snapshot dela ser escrito, então o Drizzle
-- viu divergência. A definição é idêntica à que já está no banco; deixar aqui
-- alinha o snapshot e evita que todo `db:generate` futuro repita isto.
ALTER TABLE "mensagem_whatsapp" DROP CONSTRAINT "mensagem_enviada_tem_carimbo";--> statement-breakpoint
ALTER TABLE "documento" ADD COLUMN "etapa" "etapa_documento";--> statement-breakpoint
ALTER TABLE "documento" ADD COLUMN "evolucao_id" uuid;--> statement-breakpoint
ALTER TABLE "documento" ADD COLUMN "removido_por_id" uuid;--> statement-breakpoint
ALTER TABLE "documento" ADD CONSTRAINT "documento_evolucao_id_evolucao_id_fk" FOREIGN KEY ("evolucao_id") REFERENCES "public"."evolucao"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documento" ADD CONSTRAINT "documento_removido_por_id_usuario_id_fk" FOREIGN KEY ("removido_por_id") REFERENCES "public"."usuario"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documento_dente_idx" ON "documento" USING btree ("paciente_id","dente_fdi","data_exame") WHERE "documento"."dente_fdi" is not null and "documento"."removido_em" is null;--> statement-breakpoint
CREATE INDEX "documento_evolucao_idx" ON "documento" USING btree ("evolucao_id");--> statement-breakpoint
ALTER TABLE "documento" ADD CONSTRAINT "documento_sha256_hex" CHECK ("documento"."sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "documento" ADD CONSTRAINT "documento_nome_nao_vazio" CHECK (length(btrim("documento"."nome")) > 0);--> statement-breakpoint
ALTER TABLE "documento" ADD CONSTRAINT "documento_mime_nao_vazio" CHECK (length(btrim("documento"."mime_type")) > 0);--> statement-breakpoint
ALTER TABLE "mensagem_whatsapp" ADD CONSTRAINT "mensagem_enviada_tem_carimbo" CHECK (case
        when "mensagem_whatsapp"."situacao" in ('enviada','entregue','lida') then "mensagem_whatsapp"."enviado_em" is not null
        when "mensagem_whatsapp"."situacao" in ('pendente','enviando','cancelada') then "mensagem_whatsapp"."enviado_em" is null
        else true
      end);