-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Fase 21 — profundidade clínica                                            ║
-- ║ periograma · ordem de laboratório · propostas alternativas · esterilização ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Escrita à mão. O `drizzle-kit generate` foi rodado e o SQL dele descartado: ele
-- não expressa coluna `GENERATED ALWAYS`, trigger, índice único parcial com
-- expressão, nem RLS. O snapshot vem dele; o SQL é este. Quinta vez que este
-- procedimento aparece — está no `CLAUDE.md`.
--
-- ══════════════════════════════════════════════════════════════════════════════
--  ⚠️ QUEM MODELOU ISTO NÃO É DENTISTA
--
--  Esta migration cria a estrutura de um exame clínico. Campo errado aqui não é
--  bug: é diagnóstico que não se sustenta. Cada regra abaixo está marcada:
--
--    [PADRÃO]   protocolo internacional verificável (6 sítios, Miller, Glickman,
--               NIC = PS + recessão).
--    ⚠️ [ESCOLHA] modelagem que **precisa de validação do dentista** — faixas
--               numéricas, quais dentes têm furca, exclusão dos decíduos.
--
--  A lista consolidada está no `GLOSSARIO.md`.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Tipos ───────────────────────────────────────────────────────────────
--
-- `CREATE TYPE` e não `ALTER TYPE … ADD VALUE`, de propósito: acrescentar valor a
-- enum existente **não pode ser usado na mesma transação que o cria** ("unsafe use
-- of new value of enum type"), e esta migration aplica em transação única. Todo
-- estado novo desta fase nasce em tipo novo — inclusive a numeração da ordem de
-- laboratório, que entrou em `contador.escopo`, que é `text` justamente por isso.
CREATE TYPE sitio_periograma AS ENUM (
  'mesio_vestibular', 'vestibular', 'disto_vestibular',
  'mesio_palatina',   'palatina',   'disto_palatina',
  'mesio_lingual',    'lingual',    'disto_lingual'
);
--> statement-breakpoint

CREATE TYPE situacao_ordem_laboratorio AS ENUM ('aberta', 'enviada', 'recebida', 'cancelada');
--> statement-breakpoint

CREATE TYPE resultado_indicador AS ENUM ('aprovado', 'reprovado');
--> statement-breakpoint

CREATE TYPE resultado_biologico AS ENUM ('pendente', 'negativo', 'positivo');
--> statement-breakpoint

-- ── 2. Quais dentes têm furca ──────────────────────────────────────────────
--
-- **Dente de raiz única não tem furca.** Registrar Glickman num incisivo é a mesma
-- família de erro que marcar face oclusal num canino — que o `CLAUDE.md` já lista
-- como armadilha do domínio.
--
-- A regra fica AQUI, em função, e não repetida em cada CHECK: um dia ela muda (ver
-- a ressalva do pré-molar abaixo) e mudar em um lugar é diferente de procurar por
-- todos. `IMMUTABLE` porque CHECK exige — e é honestamente imutável: a anatomia não
-- depende de dado no banco.
--
-- [PADRÃO] Molares (posições 6, 7, 8 na notação FDI) têm furca. Isso é pacífico.
--
-- ⚠️ [ESCOLHA] **O primeiro pré-molar SUPERIOR (14 e 24) tem duas raízes na maioria
-- das pessoas — e está FORA desta função.** A escolha é conservadora de propósito:
--
--   • deixar de fora impede registrar furca onde ela existe → perde informação, e o
--     dentista percebe na hora que o campo não aparece;
--   • deixar dentro permitiria registrar furca em dente de raiz única → cria
--     informação falsa, e ninguém percebe.
--
-- Entre perder e inventar, este projeto perde. **Precisa de validação**: se o
-- dentista confirmar, acrescentar `OR (p_fdi IN (14, 24))` é uma linha.
CREATE FUNCTION dente_multirradicular(p_fdi smallint) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_fdi BETWEEN 11 AND 48 AND (p_fdi % 10) IN (6, 7, 8);
$$;
--> statement-breakpoint

COMMENT ON FUNCTION dente_multirradicular(smallint) IS
  'Dente que pode ter furca. Molares sim; 14 e 24 estão FORA por escolha conservadora '
  'que precisa de validação do dentista — ver drizzle/0037.';
--> statement-breakpoint

-- ── 3. Periograma ──────────────────────────────────────────────────────────
CREATE TABLE periograma (
  clinica_id      uuid NOT NULL DEFAULT app_clinica_id() REFERENCES clinica(id) ON DELETE RESTRICT,
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paciente_id     uuid NOT NULL,
  profissional_id uuid NOT NULL,
  examinado_em    timestamptz NOT NULL DEFAULT now(),
  -- Nulo = exame em andamento. A boca é examinada por sextante e o dentista para no
  -- meio; exigir conclusão para gravar faria o exame interrompido virar nada.
  concluido_em    timestamptz,
  observacao      text,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT periograma_paciente_id_paciente_id_fk
    FOREIGN KEY (paciente_id, clinica_id) REFERENCES paciente(id, clinica_id) ON DELETE RESTRICT,
  CONSTRAINT periograma_profissional_id_profissional_id_fk
    FOREIGN KEY (profissional_id, clinica_id) REFERENCES profissional(id, clinica_id) ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE INDEX periograma_clinica_idx ON periograma (clinica_id);
--> statement-breakpoint

-- Unicidade de (id, clinica_id) para as filhas referenciarem com FK COMPOSTO. Sem
-- ela o Postgres recusa a constraint com "there is no unique constraint matching
-- given keys" — e o FK de uma coluna só permitiria sítio de uma clínica pendurado em
-- exame de outra, que é exatamente o que os 81 FKs compostos do projeto impedem.
CREATE UNIQUE INDEX periograma_id_clinica_uk ON periograma (id, clinica_id);
--> statement-breakpoint
CREATE INDEX periograma_paciente_idx ON periograma (paciente_id, examinado_em);
--> statement-breakpoint

-- ── 4. Achados por dente ───────────────────────────────────────────────────
--
-- A linha existe para todo dente EXAMINADO, mesmo com mobilidade e furca nulas — é
-- ela que registra "este dente estava na boca neste exame", e é disso que a
-- comparação entre exames deriva perda dentária.
CREATE TABLE periograma_dente (
  clinica_id    uuid NOT NULL DEFAULT app_clinica_id() REFERENCES clinica(id) ON DELETE RESTRICT,
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  periograma_id uuid NOT NULL,
  dente_fdi     smallint NOT NULL REFERENCES dente(fdi) ON DELETE RESTRICT,
  -- Miller 0–III. [PADRÃO] Nulo = não avaliada.
  mobilidade    smallint,
  -- Glickman I–IV, com 0 = examinada sem envolvimento. [PADRÃO] Nulo = não avaliada.
  furca         smallint,
  observacao    text,
  CONSTRAINT periograma_dente_periograma_id_periograma_id_fk
    FOREIGN KEY (periograma_id, clinica_id) REFERENCES periograma(id, clinica_id) ON DELETE CASCADE,
  CONSTRAINT periograma_dente_mobilidade_miller
    CHECK (mobilidade IS NULL OR mobilidade BETWEEN 0 AND 3),
  CONSTRAINT periograma_dente_furca_glickman
    CHECK (furca IS NULL OR furca BETWEEN 0 AND 4),
  -- A trava da furca. Sem ela, "Glickman III no incisivo central" entra no
  -- prontuário e sai num laudo.
  CONSTRAINT periograma_dente_furca_so_multirradicular
    CHECK (furca IS NULL OR dente_multirradicular(dente_fdi)),
  /*
   * ⚠️ [ESCOLHA] Só dentição PERMANENTE (11–48).
   *
   * Três razões, e nenhuma é técnica:
   *   1. o protocolo de 6 sítios com medida de nível de inserção é validado para
   *      permanentes; periodontite em criança existe (forma agressiva localizada) e
   *      é incomum;
   *   2. **mobilidade de Miller num decíduo pré-esfoliação mede o oposto de
   *      doença** — um decíduo que balança perto da troca está fazendo o que deve, e
   *      um grau III ali viraria achado patológico num evento fisiológico;
   *   3. o NIC se mede da junção cemento-esmalte, e essa referência em raiz em
   *      reabsorção não é a mesma coisa.
   *
   * **Precisa de validação.** Se o dentista registrar periodonto em criança, esta
   * linha sai e o modelo não muda.
   */
  CONSTRAINT periograma_dente_so_permanente CHECK (dente_fdi BETWEEN 11 AND 48)
);
--> statement-breakpoint

-- Um dente aparece uma vez por exame. `clinica_id` entra no índice porque é ele que
-- o FK composto de `periograma_sitio` referencia — sem os três, o Postgres recusa a
-- constraint com "there is no unique constraint matching given keys".
CREATE UNIQUE INDEX periograma_dente_uk
  ON periograma_dente (clinica_id, periograma_id, dente_fdi);
--> statement-breakpoint
CREATE INDEX periograma_dente_clinica_idx ON periograma_dente (clinica_id);
--> statement-breakpoint

-- ── 5. Medidas por sítio ───────────────────────────────────────────────────
CREATE TABLE periograma_sitio (
  clinica_id                uuid NOT NULL DEFAULT app_clinica_id() REFERENCES clinica(id) ON DELETE RESTRICT,
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  periograma_id             uuid NOT NULL,
  dente_fdi                 smallint NOT NULL,
  sitio                     sitio_periograma NOT NULL,
  -- ⚠️ [ESCOLHA] 0 a 15 mm. O limite é do INSTRUMENTO, não fisiológico: a sonda
  -- milimetrada (UNC-15) marca até 15, então acima disso não é medida, é estimativa.
  -- É por isso que serve de trava: recusa o "40" que era "4" sem recusar achado real.
  profundidade_sondagem_mm  smallint NOT NULL,
  /*
   * Margem gengival em relação à junção cemento-esmalte.
   *   POSITIVO = recessão (raiz exposta).
   *   NEGATIVO = aumento gengival (a margem cobre parte da coroa).
   *
   * O sinal negativo não é detalhe: sem ele o NIC de quem tem hiperplasia sai
   * superestimado, e é justamente nesse paciente que bolsa profunda não significa
   * perda de inserção. ⚠️ [ESCOLHA] faixa −10 a +20.
   */
  recessao_mm               smallint NOT NULL DEFAULT 0,
  /*
   * ── O NIC é DERIVADO, e esta é a garantia central da fase ────────────────
   * `GENERATED ALWAYS`: o Postgres **recusa a escrita**. Não é trigger, não é
   * disciplina de código.
   *
   * Mesmo princípio de "glosa é CALCULADA, nunca digitada" — e aqui pesa mais que
   * dinheiro. **O NIC é o número que diz se a doença progrediu**, porque a bolsa
   * pode encolher só porque a gengiva retraiu: PS de 6 para 3 com recessão de 0
   * para 3 é NIC constante em 6. Campo digitável divergindo do cálculo
   * transformaria essa distinção em ruído.
   */
  nivel_insercao_mm         smallint GENERATED ALWAYS AS (profundidade_sondagem_mm + recessao_mm) STORED,
  sangramento               boolean NOT NULL DEFAULT false,
  supuracao                 boolean NOT NULL DEFAULT false,
  /*
   * FK para o DENTE do exame, não para o exame. É isto que torna impossível medir
   * sítio de dente que não está no periograma — e é da presença do dente que a
   * comparação deriva perda dentária.
   */
  CONSTRAINT periograma_sitio_dente_fk
    FOREIGN KEY (clinica_id, periograma_id, dente_fdi)
    REFERENCES periograma_dente (clinica_id, periograma_id, dente_fdi) ON DELETE CASCADE,
  CONSTRAINT periograma_sitio_ps_faixa
    CHECK (profundidade_sondagem_mm BETWEEN 0 AND 15),
  CONSTRAINT periograma_sitio_recessao_faixa
    CHECK (recessao_mm BETWEEN -10 AND 20),
  /*
   * ── Superior tem palatina, inferior tem lingual ─────────────────────────
   * [PADRÃO] A mesma regra que `facesDe()` aplica às faces do odontograma, e que o
   * `CLAUDE.md` registra como armadilha do domínio.
   *
   * Sem esta trava, "sítio palatino no 36" entra no banco: o enum tem os nove
   * valores, e nada além disto liga o nome do sítio à arcada do dente. Um exame com
   * sítio que não existe naquele dente não é exame com rótulo errado — é exame que
   * não se pode comparar com o próximo, porque o par (dente, sítio) deixa de casar.
   *
   * Quadrantes 1 e 2 são superiores; 3 e 4, inferiores (só permanentes chegam aqui).
   */
  CONSTRAINT periograma_sitio_lado_oral_coerente CHECK (
    sitio IN ('mesio_vestibular', 'vestibular', 'disto_vestibular')
    OR (sitio IN ('mesio_palatina', 'palatina', 'disto_palatina') AND dente_fdi / 10 IN (1, 2))
    OR (sitio IN ('mesio_lingual', 'lingual', 'disto_lingual')   AND dente_fdi / 10 IN (3, 4))
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX periograma_sitio_uk
  ON periograma_sitio (periograma_id, dente_fdi, sitio);
--> statement-breakpoint
CREATE INDEX periograma_sitio_clinica_idx ON periograma_sitio (clinica_id);
--> statement-breakpoint
CREATE INDEX periograma_sitio_exame_idx ON periograma_sitio (periograma_id);
--> statement-breakpoint

-- ── 6. Laboratório de prótese ──────────────────────────────────────────────
CREATE TABLE laboratorio (
  clinica_id        uuid NOT NULL DEFAULT app_clinica_id() REFERENCES clinica(id) ON DELETE RESTRICT,
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome              text NOT NULL,
  contato_nome      text,
  contato_telefone  varchar(20),
  cnpj              varchar(14),
  prazo_padrao_dias smallint NOT NULL DEFAULT 7,
  observacoes       text,
  ativo             boolean NOT NULL DEFAULT true,
  criado_em         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT laboratorio_prazo_positivo CHECK (prazo_padrao_dias > 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX laboratorio_nome_por_clinica_uk ON laboratorio (clinica_id, nome);
--> statement-breakpoint
CREATE INDEX laboratorio_clinica_idx ON laboratorio (clinica_id);
--> statement-breakpoint

-- Unicidade de (id, clinica_id) para as filhas referenciarem com FK composto.
CREATE UNIQUE INDEX laboratorio_id_clinica_uk ON laboratorio (id, clinica_id);
--> statement-breakpoint

/*
 * Ordem de serviço.
 *
 * ── Por que pende de `item_plano` ─────────────────────────────────────────
 * A prótese é uma LINHA do plano — tem procedimento, dente, valor e cobertura. Ordem
 * sem item de plano é custo sem receita correspondente, e a margem da prótese (onde
 * a clínica ganha ou perde nesse procedimento) não fecha. `item_plano_id` é NOT NULL.
 *
 * ── Por que NÃO cria despesa automaticamente ──────────────────────────────
 * O laboratório **cobra por mês**, uma nota cobrindo várias peças. Uma despesa por
 * ordem produziria N lançamentos que não casam com a nota, e a conciliação bancária
 * não fecharia nunca — mesmo raciocínio que fez a conciliação Pix casar por
 * `end_to_end_id` em vez de por "valor e data parecidos".
 *
 * `custo` é o valor COMBINADO (serve à margem e a conferir a nota). A despesa é a
 * nota, lançada à mão, e `despesa_id` liga as duas quando a clínica quiser. Sem
 * contagem dupla.
 */
CREATE TABLE ordem_laboratorio (
  clinica_id      uuid NOT NULL DEFAULT app_clinica_id() REFERENCES clinica(id) ON DELETE RESTRICT,
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero          integer NOT NULL DEFAULT proximo_numero('ordem_laboratorio'),
  laboratorio_id  uuid NOT NULL,
  item_plano_id   uuid NOT NULL,
  especificacao   text NOT NULL,
  -- Cor da escala (Vita A2, B1…). Prótese com a cor errada volta para refação, e a
  -- cor é a informação que mais se perde entre a cadeira e o laboratório.
  cor             varchar(20),
  situacao        situacao_ordem_laboratorio NOT NULL DEFAULT 'aberta',
  enviada_em      timestamptz,
  -- Dia civil combinado: é compromisso, não instante.
  prazo_em        date,
  recebida_em     timestamptz,
  custo           numeric(10,2) NOT NULL DEFAULT 0,
  -- Refação é ordem NOVA apontando para a anterior, não situação: "quem paga a
  -- refação" é pergunta que precisa das duas linhas, e apagar a peça que não serviu
  -- apaga a evidência da conversa com o laboratório.
  refaz_id        uuid,
  motivo_refacao  text,
  despesa_id      uuid,
  observacao      text,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  atualizado_em   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ordem_laboratorio_laboratorio_id_laboratorio_id_fk
    FOREIGN KEY (laboratorio_id, clinica_id) REFERENCES laboratorio(id, clinica_id) ON DELETE RESTRICT,
  CONSTRAINT ordem_laboratorio_item_plano_id_item_plano_id_fk
    FOREIGN KEY (item_plano_id, clinica_id) REFERENCES item_plano(id, clinica_id) ON DELETE RESTRICT,
  CONSTRAINT ordem_laboratorio_despesa_id_despesa_id_fk
    FOREIGN KEY (despesa_id, clinica_id) REFERENCES despesa(id, clinica_id) ON DELETE SET NULL (despesa_id),
  CONSTRAINT ordem_laboratorio_custo_nao_negativo CHECK (custo >= 0),
  CONSTRAINT ordem_laboratorio_refacao_justificada
    CHECK (refaz_id IS NULL OR motivo_refacao IS NOT NULL),
  CONSTRAINT ordem_laboratorio_recebida_depois_de_enviada
    CHECK (recebida_em IS NULL OR enviada_em IS NULL OR recebida_em >= enviada_em),
  -- Situação e evidência andam juntas: "recebida" sem data de recebimento é estado
  -- sem fato, igual a cobrança Pix "paga" sem `end_to_end_id`.
  CONSTRAINT ordem_laboratorio_situacao_com_evidencia CHECK (
    (situacao <> 'enviada'  OR enviada_em IS NOT NULL)
    AND (situacao <> 'recebida' OR (enviada_em IS NOT NULL AND recebida_em IS NOT NULL))
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX ordem_laboratorio_id_clinica_uk ON ordem_laboratorio (id, clinica_id);
--> statement-breakpoint

ALTER TABLE ordem_laboratorio ADD CONSTRAINT ordem_laboratorio_refaz_id_ordem_laboratorio_id_fk
  FOREIGN KEY (refaz_id, clinica_id) REFERENCES ordem_laboratorio(id, clinica_id) ON DELETE RESTRICT;
--> statement-breakpoint

CREATE UNIQUE INDEX ordem_laboratorio_numero_por_clinica_uk
  ON ordem_laboratorio (clinica_id, numero);
--> statement-breakpoint
CREATE INDEX ordem_laboratorio_clinica_idx ON ordem_laboratorio (clinica_id);
--> statement-breakpoint
CREATE INDEX ordem_laboratorio_situacao_idx
  ON ordem_laboratorio (clinica_id, situacao, prazo_em);
--> statement-breakpoint

-- ── 7. Esterilização ──────────────────────────────────────────────────────
CREATE TABLE autoclave (
  clinica_id    uuid NOT NULL DEFAULT app_clinica_id() REFERENCES clinica(id) ON DELETE RESTRICT,
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          text NOT NULL,
  fabricante    text,
  modelo        text,
  numero_serie  varchar(60),
  ativo         boolean NOT NULL DEFAULT true,
  criado_em     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX autoclave_nome_por_clinica_uk ON autoclave (clinica_id, nome);
--> statement-breakpoint
CREATE UNIQUE INDEX autoclave_id_clinica_uk ON autoclave (id, clinica_id);
--> statement-breakpoint
CREATE INDEX autoclave_clinica_idx ON autoclave (clinica_id);
--> statement-breakpoint

/*
 * Ciclo (carga) de esterilização.
 *
 * ⚠️ **NÃO É "CONFORMIDADE COM A RDC 15".** É o registro dos ciclos, que é uma das
 * coisas que a norma pede. Cobre: equipamento, responsável, data, parâmetros,
 * indicador químico e indicador biológico com resultado.
 *
 * NÃO cobre — e vale dizer com as mesmas palavras que o projeto usa para o XML TISS
 * ("válido contra o XSD ≠ aceito pela operadora"): qualificação térmica do
 * equipamento, periodicidade do teste biológico, POP escrito, registro da limpeza
 * prévia, e **rastreabilidade do pacote até o paciente**.
 *
 * ── O biológico chega DEPOIS, e é isso que molda a tabela ────────────────
 * O químico sai junto com a carga (a fita muda de cor); o biológico precisa de
 * incubação e o resultado sai dias depois. O ciclo **nasce sem veredito** e é
 * atualizado. Daí `certificado` ser coluna GERADA: ciclo com biológico pendente não
 * está certificado, e deixar isso a cargo de quem digita é o erro do campo de glosa
 * digitado.
 *
 * ── Rastreabilidade até o paciente: NÃO implementada ────────────────────
 * Exigiria uma entidade que não existe aqui — o pacote/kit, com etiqueta, ligado ao
 * ciclo na embalagem e à execução na abertura. `conteudo` é texto descritivo, o que
 * se faz no papel hoje, e **texto livre não é rastreabilidade**: se um biológico
 * voltar positivo, este modelo diz o ciclo e o dia, não a lista de pacientes.
 */
CREATE TABLE ciclo_esterilizacao (
  clinica_id          uuid NOT NULL DEFAULT app_clinica_id() REFERENCES clinica(id) ON DELETE RESTRICT,
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero              smallint NOT NULL,
  autoclave_id        uuid NOT NULL,
  -- Quem operou pode ser auxiliar, então é `usuario` e não `profissional`.
  responsavel_id      uuid NOT NULL,
  iniciado_em         timestamptz NOT NULL,
  /*
   * O DIA CIVIL da carga, gravado — não derivado de `iniciado_em`.
   *
   * A primeira versão indexava `(iniciado_em::date)` e o Postgres recusou:
   * "functions in index expression must be marked IMMUTABLE". O cast de `timestamptz`
   * para `date` é STABLE, porque **depende do fuso**, e essa recusa é o banco
   * apontando um problema de domínio real: uma carga das 21h em São Paulo é
   * "amanhã" em UTC. O número da carga que está escrito na ETIQUETA reinicia a cada
   * dia da clínica — se o índice agrupasse por outro dia, duas cargas com o mesmo
   * número conviveriam e a etiqueta ficaria ambígua, que é exatamente o que ele
   * existe para impedir.
   *
   * Então o dia é fato próprio, como manda a convenção do projeto (`date` para o que
   * é genuinamente um dia civil), e o default vem de `hoje_na_clinica()`, que lê o
   * fuso da clínica do contexto.
   */
  dia                 date NOT NULL DEFAULT hoje_na_clinica(),
  programa            text,
  temperatura_c       smallint,
  duracao_min         smallint,
  conteudo            text NOT NULL,
  indicador_quimico   resultado_indicador NOT NULL,
  biologico_resultado resultado_biologico NOT NULL DEFAULT 'pendente',
  biologico_lido_em   timestamptz,
  -- DERIVADO. Escrever aqui é recusado pelo Postgres. Pendente não certifica,
  -- positivo não certifica.
  certificado         boolean GENERATED ALWAYS AS
                        (indicador_quimico = 'aprovado' AND biologico_resultado = 'negativo') STORED,
  observacao          text,
  criado_em           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ciclo_esterilizacao_autoclave_id_autoclave_id_fk
    FOREIGN KEY (autoclave_id, clinica_id) REFERENCES autoclave(id, clinica_id) ON DELETE RESTRICT,
  CONSTRAINT ciclo_esterilizacao_responsavel_id_usuario_id_fk
    FOREIGN KEY (responsavel_id, clinica_id) REFERENCES usuario(id, clinica_id) ON DELETE RESTRICT,
  CONSTRAINT ciclo_esterilizacao_numero_positivo CHECK (numero > 0),
  CONSTRAINT ciclo_esterilizacao_conteudo_nao_vazio CHECK (length(btrim(conteudo)) > 0),
  -- Resultado sem data de leitura é resultado sem procedência; data de leitura com
  -- resultado pendente é leitura que não leu nada. Mesma família do
  -- `assinado_em`/`assinatura_hash` da evolução.
  CONSTRAINT ciclo_esterilizacao_biologico_coerente
    CHECK ((biologico_resultado = 'pendente') = (biologico_lido_em IS NULL)),
  CONSTRAINT ciclo_esterilizacao_temperatura_plausivel
    CHECK (temperatura_c IS NULL OR temperatura_c BETWEEN 100 AND 150)
);
--> statement-breakpoint

-- A etiqueta do pacote é a única ligação física entre ele e este registro: dois
-- ciclos com o mesmo número, no mesmo dia e na mesma autoclave a tornariam ambígua.
CREATE UNIQUE INDEX ciclo_esterilizacao_carga_uk
  ON ciclo_esterilizacao (clinica_id, autoclave_id, dia, numero);
--> statement-breakpoint
CREATE INDEX ciclo_esterilizacao_clinica_idx ON ciclo_esterilizacao (clinica_id);
--> statement-breakpoint
CREATE INDEX ciclo_esterilizacao_pendentes_idx
  ON ciclo_esterilizacao (clinica_id, iniciado_em) WHERE biologico_resultado = 'pendente';
--> statement-breakpoint

-- ── 8. Propostas alternativas ─────────────────────────────────────────────
--
-- Planos com o mesmo `grupo_proposta` são alternativas mutuamente exclusivas para a
-- mesma situação clínica: implante × prótese fixa, tratamento completo × o que dá
-- para fazer agora.
--
-- ⚠️ **O índice `plano_um_ativo_por_paciente` NÃO foi removido nem afrouxado.** Ele
-- existe porque o odontograma cria item no plano ativo, e com dois o item cairia num
-- plano imprevisível. Alternativas vivem em `rascunho`, quantas forem; a escolhida
-- vira `ativo`, e aí só pode haver uma.
--
-- A trava por grupo abaixo é redundante com ela **de propósito**: expressa a
-- intenção no nível do grupo, e pega o caso em que alguém amplie a unicidade por
-- paciente sem perceber que o grupo também dependia dela.
ALTER TABLE plano_tratamento ADD COLUMN grupo_proposta uuid;
--> statement-breakpoint

CREATE UNIQUE INDEX plano_um_ativo_por_grupo
  ON plano_tratamento (clinica_id, grupo_proposta)
  WHERE status = 'ativo' AND grupo_proposta IS NOT NULL;
--> statement-breakpoint

CREATE INDEX plano_grupo_proposta_idx
  ON plano_tratamento (clinica_id, grupo_proposta) WHERE grupo_proposta IS NOT NULL;
--> statement-breakpoint

/*
 * Um grupo de propostas é de UM paciente.
 *
 * Sem isto, "proposta A" do paciente X e "proposta B" do paciente Y compartilhariam
 * grupo e a tela mostraria uma como alternativa da outra — com o preço e o
 * diagnóstico de outra pessoa ao lado do nome deste. É trigger porque é regra
 * ENTRE LINHAS: CHECK só vê a linha que está sendo gravada.
 */
CREATE FUNCTION plano_grupo_de_um_paciente() RETURNS trigger AS $$
DECLARE v_outro uuid;
BEGIN
  IF NEW.grupo_proposta IS NULL THEN RETURN NEW; END IF;

  SELECT paciente_id INTO v_outro
    FROM plano_tratamento
   WHERE grupo_proposta = NEW.grupo_proposta
     AND clinica_id = NEW.clinica_id
     AND id <> NEW.id
     AND paciente_id <> NEW.paciente_id
   LIMIT 1;

  IF v_outro IS NOT NULL THEN
    RAISE EXCEPTION
      'grupo de propostas % ja pertence a outro paciente. Proposta alternativa e '
      'escolha DO MESMO paciente entre dois caminhos, nao comparacao entre pessoas.',
      NEW.grupo_proposta
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER plano_grupo_um_paciente
  BEFORE INSERT OR UPDATE OF grupo_proposta, paciente_id ON plano_tratamento
  FOR EACH ROW EXECUTE FUNCTION plano_grupo_de_um_paciente();
--> statement-breakpoint

-- ── 9. Row Level Security ─────────────────────────────────────────────────
--
-- `USING` **e** `WITH CHECK`. Só `USING` deixaria o INSERT gravar na clínica alheia.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'periograma', 'periograma_dente', 'periograma_sitio',
    'laboratorio', 'ordem_laboratorio',
    'autoclave', 'ciclo_esterilizacao'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolamento ON %I FOR ALL '
      'USING (clinica_id = app_clinica_id()) WITH CHECK (clinica_id = app_clinica_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO facilident_app', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ── 10. A trava de suspensão, que a 0027 NÃO alcança ──────────────────────
--
-- O laço da `drizzle/0027` varreu o catálogo **uma vez**. Tabela criada depois não
-- recebe política restritiva nenhuma, e clínica suspensa escreveria nela
-- livremente. O cabeçalho da 0027 afirmava o contrário; a frase foi corrigida.
--
-- INSERT e UPDATE, não DELETE: `WITH CHECK` que reprova produz ERRO; `USING` que
-- reprova produz silêncio (a linha não é vista e o comando volta "com sucesso"
-- tendo casado zero linhas). Travar DELETE por RLS diria "apagado" a quem não
-- apagou.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'periograma', 'periograma_dente', 'periograma_sitio',
    'laboratorio', 'ordem_laboratorio',
    'autoclave', 'ciclo_esterilizacao'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY assinatura_trava_insert ON %I AS RESTRICTIVE FOR INSERT '
      'WITH CHECK (assinatura_permite_escrita(clinica_id))', t);
    EXECUTE format(
      'CREATE POLICY assinatura_trava_update ON %I AS RESTRICTIVE FOR UPDATE '
      'WITH CHECK (assinatura_permite_escrita(clinica_id))', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ── 11. As asserções, rodando agora ───────────────────────────────────────
SELECT exigir_isolamento_estrutural();
--> statement-breakpoint

DO $$
DECLARE v_faltando text[];
BEGIN
  SELECT coalesce(array_agg(t ORDER BY t), ARRAY[]::text[]) INTO v_faltando
    FROM unnest(ARRAY[
      'periograma', 'periograma_dente', 'periograma_sitio',
      'laboratorio', 'ordem_laboratorio',
      'autoclave', 'ciclo_esterilizacao'
    ]) AS t
   WHERE (SELECT count(*) FROM pg_policies p
           WHERE p.tablename = t AND p.policyname LIKE 'assinatura_trava_%') <> 2;

  IF array_length(v_faltando, 1) > 0 THEN
    RAISE EXCEPTION
      'Tabelas sem a trava de suspensao: %. Clinica suspensa escreveria nelas.',
      array_to_string(v_faltando, ', ');
  END IF;
END $$;
--> statement-breakpoint

/*
 * A função da furca contra a lista escrita à mão.
 *
 * `dente_multirradicular()` é aritmética (`fdi % 10 IN (6,7,8)`), e aritmética que
 * ninguém confere é aritmética que um dia deixa de valer — se alguém trocar o
 * critério, o campo de furca aparece no dente errado e nada avisa. A lista abaixo é
 * a contraprova: os doze molares, escritos um por um. `lib/domain/periograma.ts`
 * carrega a mesma lista do lado TypeScript, com o mesmo propósito.
 */
DO $$
DECLARE
  v_esperados smallint[] := ARRAY[16,17,18,26,27,28,36,37,38,46,47,48]::smallint[];
  v_obtidos   smallint[];
BEGIN
  SELECT coalesce(array_agg(fdi ORDER BY fdi), ARRAY[]::smallint[]) INTO v_obtidos
    FROM dente
   WHERE denticao = 'permanente' AND dente_multirradicular(fdi);

  IF v_obtidos <> v_esperados THEN
    RAISE EXCEPTION
      'dente_multirradicular() diverge da lista: esperados %, obtidos %. '
      'Furca em dente de raiz unica e diagnostico que nao se sustenta.',
      v_esperados, v_obtidos;
  END IF;
END $$;
