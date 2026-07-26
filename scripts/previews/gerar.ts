import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { layoutOdontograma, mapearFaces, rotuloFace } from '@/components/odontograma/geometria'
import { ESTILO_STATUS } from '@/components/agenda/estilos'
import { catalogoDentes } from '@/lib/domain/dentes'
import { HORARIO_PADRAO, descreverDia } from '@/lib/domain/horario'
import { CSS_TOKENS, TOKENS_ESPERADOS } from './tokens'
import { grupo, linha, montarPreview, nota } from './pagina'

/**
 * Gera os previews do design system em `design/`.
 *
 *   npm run design:previews
 *
 * Depois, `/design-sync` publica a pasta no projeto do Claude Design. Os cards
 * saem do marcador `@dsCard` na primeira linha de cada arquivo.
 *
 * Os componentes de domínio (odontograma, agenda) são gerados a partir das
 * MESMAS funções puras que a aplicação usa — `layoutOdontograma`,
 * `mapearFaces`, `ESTILO_STATUS`. Assim o catálogo não pode divergir do produto:
 * se a geometria mudar, o preview muda junto.
 */

const SAIDA = 'design'

async function escrever(caminho: string, html: string): Promise<void> {
  const destino = join(SAIDA, caminho)
  await mkdir(dirname(destino), { recursive: true })
  await writeFile(destino, html, 'utf8')
  console.log(`  ${destino}`)
}

// ── Fundações ────────────────────────────────────────────────────────────────

function previewCores(): string {
  const grupos: Record<string, string[]> = {
    Superfícies: ['bg', 'surface', 'surface-2', 'surface-3', 'border', 'border-forte'],
    Texto: ['fg', 'fg-2', 'fg-3'],
    Marca: ['primary', 'primary-hover', 'primary-fg', 'ring'],
    Semânticas: ['sucesso', 'atencao', 'critico'],
    Odontograma: [
      'dente-higido',
      'dente-borda',
      'planejado',
      'executado',
      'ausente',
      'coroa',
      'implante',
      'selecionado',
    ],
  }

  const corpo = Object.entries(grupos)
    .map(([titulo, tokens]) =>
      grupo(
        titulo,
        linha(
          tokens
            .map(
              (t) =>
                `<div style="width:104px"><div class="amostra" style="background:var(--${t})"></div>
                 <code class="token">--${t}</code></div>`,
            )
            .join(''),
        ),
      ),
    )
    .join('')

  return montarPreview({
    grupo: 'Fundações',
    nome: 'Cores',
    subtitulo: `${TOKENS_ESPERADOS.length} tokens, claro e escuro`,
    altura: 620,
    css: `.amostra{height:40px;border-radius:6px;border:1px solid var(--border)}
      .token{display:block;font-size:10px;color:var(--fg-3);margin-top:4px;
        font-family:ui-monospace,monospace}`,
    corpo:
      corpo +
      nota(
        'Contraste mais alto que o usual, de propósito: a recepção lê a agenda a dois metros da tela e sob reflexo de janela.',
      ),
  })
}

function previewTipografia(): string {
  const amostras = [
    ['Título de página', 'font-size:20px;font-weight:600'],
    ['Título de cartão', 'font-size:13px;font-weight:600'],
    ['Corpo', 'font-size:14px'],
    ['Apoio', 'font-size:14px;color:var(--fg-2)'],
    ['Secundário', 'font-size:12px;color:var(--fg-3)'],
    ['Rótulo de seção', 'font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--fg-3)'],
  ]

  return montarPreview({
    grupo: 'Fundações',
    nome: 'Tipografia',
    subtitulo: 'Escala e numerais tabulares',
    altura: 460,
    corpo:
      grupo(
        'Escala',
        amostras
          .map(([texto, estilo]) => `<p style="${estilo};margin:0 0 8px">${texto}</p>`)
          .join(''),
      ) +
      grupo(
        'Numerais tabulares',
        `<table style="max-width:240px"><tbody>
          <tr><td>Restauração</td><td style="text-align:right">1.230,00</td></tr>
          <tr><td>Coroa</td><td style="text-align:right">890,50</td></tr>
          <tr><td>Profilaxia</td><td style="text-align:right">160,00</td></tr>
        </tbody></table>`,
      ) +
      nota(
        '<code>font-variant-numeric: tabular-nums</code> no body: coluna de valores no financeiro tem que alinhar.',
      ),
  })
}

// ── Componentes base ─────────────────────────────────────────────────────────

function previewBotoes(): string {
  const variantes = [
    ['btn-primario', 'Primário'],
    ['', 'Secundário'],
    ['btn-fantasma', 'Fantasma'],
    ['btn-perigo', 'Perigo'],
  ]

  return montarPreview({
    grupo: 'Componentes',
    nome: 'Botões',
    subtitulo: '4 variantes, 3 tamanhos, ativo e desabilitado',
    altura: 420,
    corpo:
      grupo(
        'Variantes',
        linha(
          variantes.map(([c, t]) => `<button class="btn ${c}">${t}</button>`).join(''),
        ),
      ) +
      grupo(
        'Tamanhos',
        linha(
          `<button class="btn btn-primario btn-sm">Pequeno</button>
           <button class="btn btn-primario">Médio</button>
           <button class="btn btn-primario btn-lg">Grande (44px)</button>`,
        ),
      ) +
      grupo(
        'Estados',
        linha(
          `<button class="btn btn-ativo">Ativo</button>
           <button class="btn btn-primario" disabled>Desabilitado</button>
           <button class="btn" disabled>Desabilitado</button>`,
        ),
      ) +
      nota(
        'O tamanho grande tem 44px — alvo mínimo de toque para tablet no consultório. O estado <em>ativo</em> existe para botões que funcionam como ferramenta, como no odontograma.',
      ),
  })
}

function previewCampos(): string {
  return montarPreview({
    grupo: 'Componentes',
    nome: 'Campos de formulário',
    subtitulo: 'Texto, seleção, ajuda, erro e obrigatório',
    altura: 560,
    corpo:
      grupo(
        'Normal e obrigatório',
        `<div class="campo"><label class="rotulo">Nome completo <span class="obrig">*</span></label>
          <input class="entrada" value="Maria Aparecida Souza"></div>`,
      ) +
      grupo(
        'Com texto de ajuda',
        `<div class="campo"><label class="rotulo">CPF</label>
          <input class="entrada" placeholder="000.000.000-00">
          <p class="ajuda">Opcional — criança costuma não ter.</p></div>`,
      ) +
      grupo(
        'Com erro',
        `<div class="campo"><label class="rotulo">CPF</label>
          <input class="entrada entrada-erro" value="529.982.247-26" aria-invalid="true">
          <p class="msg-erro">CPF inválido.</p></div>`,
      ) +
      grupo(
        'Seleção',
        `<div class="campo"><label class="rotulo">Responsável legal <span class="obrig">*</span></label>
          <select class="entrada"><option>Maria Aparecida Souza</option></select>
          <p class="ajuda">Obrigatório: o paciente é menor de idade.</p></div>`,
      ) +
      nota(
        'A mensagem de erro SUBSTITUI o texto de ajuda, não soma. Duas linhas competindo abaixo do campo é ruído no momento em que a pessoa precisa de clareza.',
      ),
  })
}

function previewAlertas(): string {
  return montarPreview({
    grupo: 'Componentes',
    nome: 'Alertas e etiquetas',
    subtitulo: 'Crítico, atenção, sucesso e status de paciente',
    altura: 420,
    corpo:
      grupo(
        'Alertas de formulário',
        `<div class="alerta alerta-critico" style="margin-bottom:8px">E-mail, senha ou código incorretos.</div>
         <div class="alerta alerta-atencao" style="margin-bottom:8px">Nenhum horário livre neste dia para essa duração.</div>
         <div class="alerta alerta-sucesso">Agendamento criado.</div>`,
      ) +
      grupo(
        'Status de paciente',
        linha(
          `<span class="etiqueta" style="border-color:color-mix(in oklab,var(--sucesso) 30%,transparent);background:color-mix(in oklab,var(--sucesso) 12%,transparent);color:var(--sucesso)">ativo</span>
           <span class="etiqueta" style="border-color:var(--border);background:var(--surface-3);color:var(--fg-3)">inativo</span>
           <span class="etiqueta" style="border-color:color-mix(in oklab,var(--atencao) 30%,transparent);background:color-mix(in oklab,var(--atencao) 12%,transparent);color:var(--atencao)">arquivado</span>`,
        ),
      ) +
      nota(
        'Alerta crítico usa <code>role="alert"</code>; os outros, <code>role="status"</code> — só o primeiro interrompe o leitor de tela.',
      ),
  })
}

// ── Componentes de domínio ───────────────────────────────────────────────────

function previewFaixaAlertas(): string {
  return montarPreview({
    grupo: 'Domínio',
    nome: 'Faixa de alertas clínicos',
    subtitulo: 'Crítico e atenção',
    altura: 360,
    css: `.faixa{border-radius:12px;border:2px solid;padding:12px 16px;margin-bottom:12px}
      .faixa-titulo{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin:0}
      .faixa ul{margin:6px 0 0;padding:0;list-style:none}
      .faixa li{font-size:14px;margin:0 0 4px}
      .faixa strong{margin-right:6px}`,
    corpo:
      grupo(
        'Com item crítico',
        `<div class="faixa" style="border-color:var(--critico);background:color-mix(in oklab,var(--critico) 10%,transparent)" role="alert">
          <p class="faixa-titulo" style="color:var(--critico)">Atenção — alertas clínicos</p>
          <ul>
            <li><strong style="color:var(--critico)">Alergia</strong><span style="color:var(--fg-2)">Alergia a penicilina — confirmada em 2024</span></li>
            <li><strong style="color:var(--atencao)">Anticoagulante</strong><span style="color:var(--fg-2)">Uso contínuo de varfarina</span></li>
          </ul>
        </div>`,
      ) +
      grupo(
        'Só atenção',
        `<div class="faixa" style="border-color:color-mix(in oklab,var(--atencao) 50%,transparent);background:color-mix(in oklab,var(--atencao) 10%,transparent)" role="status">
          <p class="faixa-titulo" style="color:var(--atencao)">Alertas clínicos</p>
          <ul><li><strong style="color:var(--atencao)">Diabetes</strong><span style="color:var(--fg-2)">Tipo 2, controlada</span></li></ul>
        </div>`,
      ) +
      nota(
        'Sempre a PRIMEIRA coisa da tela do paciente, e não recolhível. Alergia a anestésico e uso de anticoagulante mudam a conduta — precisam estar na frente de quem vai colocar a pessoa na cadeira.',
      ),
  })
}

function previewOdontograma(): string {
  const layout = layoutOdontograma({ denticao: 'permanente', tamanho: 'compacto' })

  // Estados de exemplo, para o card mostrar as convenções em uso.
  const marcado: Record<number, Record<string, 'planejado' | 'executado'>> = {
    16: { oclusal: 'executado', mesial: 'executado' },
    26: { oclusal: 'planejado' },
    11: { incisal: 'executado' },
    36: { oclusal: 'planejado', distal: 'planejado' },
  }
  const ausentes = new Set([18, 28])

  const dentes = layout.dentes
    .map((d) => {
      const regioes = d.regioes
        .map((r) => {
          const estado = marcado[d.fdi]?.[r.face]
          const fill =
            estado === 'planejado'
              ? 'url(#hachura)'
              : estado === 'executado'
                ? 'var(--executado-fill)'
                : 'var(--dente-higido)'
          return `<path d="${r.path}" fill="${fill}" fill-rule="${r.posicao === 'cervical' ? 'evenodd' : 'nonzero'}" stroke="var(--dente-borda)" stroke-width="0.6"><title>Dente ${d.fdi} — ${rotuloFace(r.face)}</title></path>`
        })
        .join('')

      const x = ausentes.has(d.fdi)
        ? `<g stroke="var(--ausente)" stroke-width="2.4" stroke-linecap="round">
             <line x1="${d.x + 4}" y1="${d.y + 4}" x2="${d.x + d.lado - 4}" y2="${d.y + d.lado - 4}"/>
             <line x1="${d.x + d.lado - 4}" y1="${d.y + 4}" x2="${d.x + 4}" y2="${d.y + d.lado - 4}"/>
           </g>`
        : ''

      return `<g opacity="${ausentes.has(d.fdi) ? 0.35 : 1}">
        <rect x="${d.x}" y="${d.y}" width="${d.lado}" height="${d.lado}" fill="var(--dente-higido)" stroke="var(--dente-borda)" stroke-width="0.8"/>
        ${regioes}
      </g>${x}
      <text x="${d.rotulo.x}" y="${d.rotulo.y}" text-anchor="middle" font-size="9.5" font-weight="600" fill="var(--fg-2)">${d.fdi}</text>`
    })
    .join('')

  const svg = `<svg viewBox="-2 -2 ${layout.largura + 4} ${layout.altura + 4}" style="width:100%;height:auto">
    <defs>
      <pattern id="hachura" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
        <rect width="4" height="4" fill="var(--planejado-fill)"/>
        <line x1="0" y1="0" x2="0" y2="4" stroke="var(--planejado)" stroke-width="1.4"/>
      </pattern>
    </defs>
    <line x1="${layout.linhaMediaX}" y1="0" x2="${layout.linhaMediaX}" y2="${layout.altura}" stroke="var(--border)" stroke-dasharray="3 4"/>
    <line x1="0" y1="${layout.linhaArcadasY}" x2="${layout.largura}" y2="${layout.linhaArcadasY}" stroke="var(--border)"/>
    ${dentes}
  </svg>`

  const legenda = `
    <div class="linha" style="gap:14px;font-size:12px;color:var(--fg-2);margin-top:10px">
      <span class="linha" style="gap:6px"><span class="amostra-legenda" style="background:var(--dente-higido);border-color:var(--dente-borda)"></span>Hígido</span>
      <span class="linha" style="gap:6px"><span class="amostra-legenda hachura" style="border-color:var(--planejado)"></span><strong style="color:var(--planejado)">Planejado</strong></span>
      <span class="linha" style="gap:6px"><span class="amostra-legenda" style="background:var(--executado-fill);border-color:var(--executado);border-width:2px"></span><strong style="color:var(--executado)">Executado</strong></span>
      <span class="linha" style="gap:6px"><span class="amostra-legenda" style="border-color:var(--ausente)">✗</span>Ausente</span>
    </div>`

  return montarPreview({
    grupo: 'Domínio',
    nome: 'Odontograma',
    subtitulo: '32 permanentes, 6 faces por dente, estados por convenção brasileira',
    largura: 1100,
    altura: 560,
    css: `.amostra-legenda{display:inline-flex;align-items:center;justify-content:center;
        width:18px;height:18px;border-radius:3px;border:1px solid;font-size:11px}
      .hachura{background-image:repeating-linear-gradient(45deg,var(--planejado) 0 1.5px,var(--planejado-fill) 1.5px 5px)}`,
    corpo: grupo('Dentição permanente', svg + legenda) + nota(
      '<strong>Vermelho = planejado, azul = executado</strong> — a convenção do prontuário em papel. A hachura garante que a distinção não dependa só de cor. A moldura em volta do quadrado é a face <strong>cervical</strong>: o colo do dente circunda todas as faces. <strong>Mesial aponta para a linha média</strong>, e por isso troca de lado entre os quadrantes.',
    ),
  })
}

function previewFacesDente(): string {
  // Compara um anterior e um posterior, superior e inferior — o quadro que
  // explica de uma vez por que as faces não são iguais em todo dente.
  const exemplos = [11, 16, 41, 46]
  const cartoes = exemplos
    .map((fdi) => {
      const l = layoutOdontograma({ denticao: 'permanente', tamanho: 'confortavel' })
      const d = l.dentes.find((x) => x.fdi === fdi)
      if (!d) return ''
      const posicoes = mapearFaces(d.dente)
      const deslocado = d.regioes
        .map(
          (r) =>
            `<path d="${r.path}" fill="var(--dente-higido)" fill-rule="${r.posicao === 'cervical' ? 'evenodd' : 'nonzero'}" stroke="var(--dente-borda)" stroke-width="0.8"/>`,
        )
        .join('')
      const vb = `${d.x - 3} ${d.y - 3} ${d.lado + 6} ${d.lado + 6}`
      return `<div style="text-align:center">
        <svg viewBox="${vb}" style="width:86px;height:86px">${deslocado}</svg>
        <p style="font-size:12px;font-weight:600;margin:4px 0 0">${fdi}</p>
        <p style="font-size:10px;color:var(--fg-3);margin:2px 0 0;line-height:1.5">
          centro: <strong>${posicoes.centro}</strong><br>
          topo: ${posicoes.topo}<br>base: ${posicoes.base}<br>
          ◀ ${posicoes.esquerda} · ${posicoes.direita} ▶
        </p>
      </div>`
    })
    .join('')

  return montarPreview({
    grupo: 'Domínio',
    nome: 'Faces por anatomia',
    subtitulo: 'Anterior vs. posterior, superior vs. inferior',
    altura: 380,
    corpo:
      grupo('Quatro dentes, quatro mapeamentos', linha(cartoes)) +
      nota(
        `Do catálogo real: ${catalogoDentes().length} dentes, cada um com exatamente 6 faces válidas. Incisivo tem <strong>incisal</strong> e nunca oclusal; molar tem <strong>oclusal</strong> e nunca incisal. Superior tem <strong>palatina</strong>; inferior, <strong>lingual</strong>.`,
      ),
  })
}

function previewAgenda(): string {
  const escala = 0.8
  const inicioMin = 8 * 60
  const fimMin = 18 * 60
  const altura = (fimMin - inicioMin) * escala

  // Três agendamentos que formam um grupo transitivo — o caso que o
  // empacotamento em faixas resolve.
  const cartoes = [
    { hora: '09:00', nome: 'Maria Souza', status: 'confirmado' as const, de: 540, ate: 600, faixa: 0, de2: 2 },
    { hora: '09:30', nome: 'Ana Lima', status: 'cancelado' as const, de: 570, ate: 615, faixa: 1, de2: 2 },
    { hora: '10:00', nome: 'Pedro Souza', status: 'agendado' as const, de: 600, ate: 630, faixa: 0, de2: 2 },
    { hora: '14:00', nome: 'João Alves', status: 'em_atendimento' as const, de: 840, ate: 900, faixa: 0, de2: 1 },
    { hora: '16:00', nome: 'Rita Nunes', status: 'faltou' as const, de: 960, ate: 1020, faixa: 0, de2: 1 },
  ]
    .map((c) => {
      const e = ESTILO_STATUS[c.status]
      const largura = 100 / c.de2
      return `<button class="cartao-ag ${classeStatus(c.status)}" style="top:${(c.de - inicioMin) * escala}px;height:${(c.ate - c.de) * escala - 2}px;left:calc(${c.faixa * largura}% + 2px);width:calc(${largura}% - 4px)">
        <span class="barra ${classeBarra(c.status)}"></span>
        <span class="hora">${c.hora} <span style="opacity:.7;font-weight:400">${e.marca}</span></span>
        <span class="nome">${c.nome}</span>
      </button>`
    })
    .join('')

  const marcas = Array.from({ length: 11 }, (_, i) => inicioMin + i * 60)
  const eixo = marcas
    .map(
      (m) =>
        `<div class="marca-rotulo" style="top:${(m - inicioMin) * escala}px">${String(Math.floor(m / 60)).padStart(2, '0')}:00</div>`,
    )
    .join('')
  const linhas = marcas
    .map((m) => `<div class="linha-hora" style="top:${(m - inicioMin) * escala}px"></div>`)
    .join('')

  const legenda = Object.entries(ESTILO_STATUS)
    .map(
      ([s, e]) =>
        `<span class="linha" style="gap:5px"><span class="pastilha ${classeBarra(s)}"></span>${e.rotulo} <span style="opacity:.6">${e.marca}</span></span>`,
    )
    .join('')

  return montarPreview({
    grupo: 'Domínio',
    nome: 'Grade da agenda',
    subtitulo: '6 status, faixas para sobreposição, bloqueio e linha do agora',
    largura: 900,
    altura: 640,
    css: `.grade{position:relative;border:1px solid var(--border);border-radius:12px;
        background:var(--surface);overflow:hidden;display:grid;grid-template-columns:52px 1fr}
      .eixo{position:relative;background:var(--surface)}
      .marca-rotulo{position:absolute;transform:translateY(-50%);right:8px;font-size:11px;color:var(--fg-3)}
      .coluna{position:relative;border-left:1px solid var(--border)}
      .linha-hora{position:absolute;left:0;right:0;border-top:1px solid color-mix(in oklab,var(--border) 60%,transparent)}
      .indisponivel{position:absolute;left:0;right:0;
        background-image:repeating-linear-gradient(135deg,var(--border) 0 1px,transparent 1px 6px)}
      .bloqueio{position:absolute;left:2px;right:2px;border-radius:4px;padding:0 4px;font-size:10px;
        border:1px solid color-mix(in oklab,var(--atencao) 50%,transparent);color:var(--atencao);
        background-image:repeating-linear-gradient(135deg,color-mix(in oklab,var(--atencao) 30%,transparent) 0 2px,transparent 2px 7px)}
      .cartao-ag{position:absolute;border-radius:6px;border:1px solid;padding:4px 6px;text-align:left;
        font-size:11px;line-height:1.25;font-family:inherit;cursor:pointer;overflow:hidden;background:var(--surface)}
      .barra{position:absolute;top:0;bottom:0;left:0;width:4px}
      .hora{display:block;padding-left:6px;font-weight:600}
      .nome{display:block;padding-left:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .agora{position:absolute;left:0;right:0;border-top:2px solid var(--critico)}
      .agora::before{content:"";position:absolute;top:-4px;left:-3px;width:8px;height:8px;
        border-radius:999px;background:var(--critico)}
      .pastilha{display:inline-block;width:10px;height:10px;border-radius:3px}
      .st-agendado{background:var(--surface);border-color:var(--border-forte)}
      .st-confirmado{background:color-mix(in oklab,var(--sucesso) 10%,transparent);border-color:color-mix(in oklab,var(--sucesso) 45%,transparent)}
      .st-em_atendimento{background:color-mix(in oklab,var(--primary) 12%,transparent);border-color:var(--primary);box-shadow:0 0 0 1px color-mix(in oklab,var(--primary) 40%,transparent)}
      .st-concluido{background:var(--surface-2);border-color:var(--border);color:var(--fg-3)}
      .st-faltou{background:color-mix(in oklab,var(--critico) 10%,transparent);border-color:color-mix(in oklab,var(--critico) 45%,transparent)}
      .st-cancelado{background:var(--surface-2);border-color:var(--border);opacity:.7;text-decoration:line-through;color:var(--fg-3)}
      .ba-agendado{background:var(--fg-3)}
      .ba-confirmado{background:var(--sucesso)}
      .ba-em_atendimento{background:var(--primary)}
      .ba-concluido{background:var(--border-forte)}
      .ba-faltou{background:var(--critico)}
      .ba-cancelado{background:var(--border-forte)}`,
    temaUnico: false,
    corpo:
      grupo(
        `Terça · ${descreverDia(HORARIO_PADRAO, 2)}`,
        `<div class="grade" style="height:${altura}px">
          <div class="eixo">${eixo}</div>
          <div class="coluna">
            <div class="indisponivel" style="top:${(720 - inicioMin) * escala}px;height:${60 * escala}px"></div>
            ${linhas}
            <div class="bloqueio" style="top:${(900 - inicioMin) * escala}px;height:${120 * escala}px">Curso de atualização</div>
            ${cartoes}
            <div class="agora" style="top:${(645 - inicioMin) * escala}px"></div>
          </div>
        </div>`,
      ) +
      `<div class="linha" style="gap:12px;font-size:11px;color:var(--fg-3);margin-top:8px">${legenda}</div>` +
      nota(
        'Os três primeiros cartões formam um <strong>grupo transitivo</strong> de sobreposição e dividem a coluna em duas faixas — o cancelado liberou o horário, que foi reocupado. Sem empacotamento, um cartão esconderia o outro. A hachura clara é o intervalo de almoço; a âmbar, um bloqueio. A linha vermelha é o agora.',
      ),
  })
}

function classeStatus(s: string): string {
  return `st-${s}`
}
function classeBarra(s: string): string {
  return `ba-${s}`
}

// ── Índice ───────────────────────────────────────────────────────────────────

function previewIndice(): string {
  return montarPreview({
    grupo: 'Brand',
    nome: 'Sobre este design system',
    subtitulo: 'Princípios e onde vive o código',
    altura: 460,
    temaUnico: true,
    corpo: `
      <h1 style="font-size:20px;font-weight:600;margin:0 0 4px">dent · design system</h1>
      <p style="font-size:14px;color:var(--fg-2);margin:0 0 18px">Sistema de gestão para consultório odontológico.</p>
      ${grupo(
        'Princípios',
        `<ol style="font-size:13px;color:var(--fg-2);line-height:1.65;margin:0;padding-left:20px">
          <li><strong>Contraste antes de elegância.</strong> A recepção lê a agenda a dois metros, com reflexo de janela.</li>
          <li><strong>Nunca só cor.</strong> Todo estado tem cor e marca: planejado é hachurado, executado é sólido; cada status da agenda tem um símbolo.</li>
          <li><strong>Convenção clínica manda.</strong> Vermelho = a fazer, azul = feito, como no prontuário em papel. Inverter causa erro clínico.</li>
          <li><strong>Alerta clínico primeiro.</strong> Alergia e anticoagulante aparecem antes de qualquer outra coisa na tela do paciente.</li>
          <li><strong>Alvo de toque generoso, informação densa.</strong> Tablet no balcão, muita linha na tela.</li>
        </ol>`,
      )}
      ${grupo(
        'Onde vive',
        `<p style="font-size:13px;color:var(--fg-2);line-height:1.6;margin:0">
          Tokens em <code>app/globals.css</code>. Componentes em <code>components/</code>.
          A geometria do odontograma e o layout da agenda são módulos puros e testados
          (<code>components/odontograma/geometria.ts</code>, <code>lib/agenda/grade.ts</code>) —
          estes previews são gerados a partir das mesmas funções, então o catálogo
          não pode divergir do produto.
        </p>`,
      )}`,
  })
}

// ── Execução ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Gerando previews em ${SAIDA}/\n`)

  await escrever('_indice.html', previewIndice())
  await escrever('fundacoes/cores.html', previewCores())
  await escrever('fundacoes/tipografia.html', previewTipografia())
  await escrever('componentes/botoes.html', previewBotoes())
  await escrever('componentes/campos.html', previewCampos())
  await escrever('componentes/alertas.html', previewAlertas())
  await escrever('dominio/faixa-alertas.html', previewFaixaAlertas())
  await escrever('dominio/odontograma.html', previewOdontograma())
  await escrever('dominio/faces-dente.html', previewFacesDente())
  await escrever('dominio/agenda.html', previewAgenda())

  console.log(`\n${TOKENS_ESPERADOS.length} tokens · ${CSS_TOKENS.length} bytes de CSS embutido`)
  console.log('\nPronto. Publique com /design-sync.')
}

main().catch((e) => {
  console.error('Falha ao gerar previews:', e)
  process.exitCode = 1
})
