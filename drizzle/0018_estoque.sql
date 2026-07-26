CREATE TYPE "public"."categoria_material" AS ENUM('anestesico', 'restaurador', 'endodontia', 'cirurgia', 'protese', 'ortodontia', 'radiologia', 'descartavel', 'instrumental', 'esterilizacao', 'medicamento', 'escritorio');--> statement-breakpoint
CREATE TYPE "public"."tipo_movimento_estoque" AS ENUM('entrada', 'consumo', 'descarte', 'devolucao', 'ajuste');--> statement-breakpoint
CREATE TYPE "public"."unidade_material" AS ENUM('unidade', 'tubete', 'caixa', 'frasco', 'ml', 'g', 'par', 'rolo', 'folha');--> statement-breakpoint
CREATE TABLE "insumo_procedimento" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"procedimento_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"quantidade" numeric(12, 3) NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "insumo_procedimento_material_uk" UNIQUE("procedimento_id","material_id"),
	CONSTRAINT "insumo_quantidade_positiva" CHECK ("insumo_procedimento"."quantidade" > 0)
);
--> statement-breakpoint
CREATE TABLE "lote_material" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"material_id" uuid NOT NULL,
	"codigo_fabricante" varchar(60),
	"validade" date,
	"custo_unitario" numeric(10, 2) NOT NULL,
	"saldo" numeric(12, 3) DEFAULT '0' NOT NULL,
	"fornecedor" text,
	"nota_fiscal" varchar(60),
	"recebido_em" date NOT NULL,
	"criado_por_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lote_id_material_uk" UNIQUE("id","material_id"),
	CONSTRAINT "lote_saldo_nao_negativo" CHECK ("lote_material"."saldo" >= 0),
	CONSTRAINT "lote_custo_nao_negativo" CHECK ("lote_material"."custo_unitario" >= 0)
);
--> statement-breakpoint
CREATE TABLE "material" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"codigo" varchar(30) NOT NULL,
	"nome" text NOT NULL,
	"descricao" text,
	"categoria" "categoria_material" NOT NULL,
	"unidade" "unidade_material" NOT NULL,
	"unidades_por_embalagem" integer DEFAULT 1 NOT NULL,
	"embalagem" text,
	"quantidade_minima" numeric(12, 3) DEFAULT '0' NOT NULL,
	"controlado" boolean DEFAULT false NOT NULL,
	"exige_lote_do_fabricante" boolean DEFAULT false NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "material_codigo_unique" UNIQUE("codigo"),
	CONSTRAINT "material_embalagem_positiva" CHECK ("material"."unidades_por_embalagem" >= 1),
	CONSTRAINT "material_minimo_nao_negativo" CHECK ("material"."quantidade_minima" >= 0)
);
--> statement-breakpoint
CREATE TABLE "movimento_estoque" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lote_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"tipo" "tipo_movimento_estoque" NOT NULL,
	"quantidade" numeric(12, 3) NOT NULL,
	"custo_unitario" numeric(10, 2),
	"motivo" text,
	"execucao_id" uuid,
	"profissional_id" uuid,
	"registrado_por_id" uuid,
	"ocorrido_em" timestamp with time zone DEFAULT now() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movimento_quantidade_nao_zero" CHECK ("movimento_estoque"."quantidade" <> 0),
	CONSTRAINT "movimento_sinal_pelo_tipo" CHECK (case
        when "movimento_estoque"."tipo" = 'entrada' then "movimento_estoque"."quantidade" > 0
        when "movimento_estoque"."tipo" in ('consumo','descarte','devolucao') then "movimento_estoque"."quantidade" < 0
        else true
      end),
	CONSTRAINT "movimento_ajuste_e_descarte_com_motivo" CHECK ("movimento_estoque"."tipo" not in ('ajuste','descarte') or ("movimento_estoque"."motivo" is not null and btrim("movimento_estoque"."motivo") <> '')),
	CONSTRAINT "movimento_custo_nao_negativo" CHECK ("movimento_estoque"."custo_unitario" is null or "movimento_estoque"."custo_unitario" >= 0),
	CONSTRAINT "movimento_execucao_so_em_consumo" CHECK ("movimento_estoque"."execucao_id" is null or "movimento_estoque"."tipo" = 'consumo')
);
--> statement-breakpoint
ALTER TABLE "insumo_procedimento" ADD CONSTRAINT "insumo_procedimento_procedimento_id_procedimento_id_fk" FOREIGN KEY ("procedimento_id") REFERENCES "public"."procedimento"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insumo_procedimento" ADD CONSTRAINT "insumo_procedimento_material_id_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."material"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lote_material" ADD CONSTRAINT "lote_material_material_id_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."material"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lote_material" ADD CONSTRAINT "lote_material_criado_por_id_usuario_id_fk" FOREIGN KEY ("criado_por_id") REFERENCES "public"."usuario"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimento_estoque" ADD CONSTRAINT "movimento_estoque_lote_id_lote_material_id_fk" FOREIGN KEY ("lote_id") REFERENCES "public"."lote_material"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimento_estoque" ADD CONSTRAINT "movimento_estoque_material_id_material_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."material"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimento_estoque" ADD CONSTRAINT "movimento_estoque_execucao_id_execucao_id_fk" FOREIGN KEY ("execucao_id") REFERENCES "public"."execucao"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimento_estoque" ADD CONSTRAINT "movimento_estoque_profissional_id_profissional_id_fk" FOREIGN KEY ("profissional_id") REFERENCES "public"."profissional"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimento_estoque" ADD CONSTRAINT "movimento_estoque_registrado_por_id_usuario_id_fk" FOREIGN KEY ("registrado_por_id") REFERENCES "public"."usuario"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "insumo_material_idx" ON "insumo_procedimento" USING btree ("material_id");--> statement-breakpoint
CREATE INDEX "lote_fefo_idx" ON "lote_material" USING btree ("material_id","validade" asc nulls last,"recebido_em") WHERE "lote_material"."saldo" > 0;--> statement-breakpoint
CREATE INDEX "lote_validade_idx" ON "lote_material" USING btree ("validade") WHERE "lote_material"."saldo" > 0;--> statement-breakpoint
CREATE INDEX "lote_codigo_fabricante_idx" ON "lote_material" USING btree ("codigo_fabricante");--> statement-breakpoint
CREATE INDEX "material_categoria_idx" ON "material" USING btree ("categoria","nome");--> statement-breakpoint
CREATE INDEX "movimento_lote_idx" ON "movimento_estoque" USING btree ("lote_id","ocorrido_em");--> statement-breakpoint
CREATE INDEX "movimento_material_idx" ON "movimento_estoque" USING btree ("material_id","ocorrido_em");--> statement-breakpoint
CREATE INDEX "movimento_execucao_idx" ON "movimento_estoque" USING btree ("execucao_id") WHERE "movimento_estoque"."execucao_id" is not null;--> statement-breakpoint
CREATE INDEX "movimento_tipo_idx" ON "movimento_estoque" USING btree ("tipo","ocorrido_em");