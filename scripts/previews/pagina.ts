import { CSS_BASE, CSS_TOKENS } from './tokens'

/**
 * Monta o HTML de um preview.
 *
 * Regras que fazem o catálogo do Claude Design ficar bom:
 *
 * 1. **`@dsCard` na PRIMEIRA linha.** É o marcador que o painel Design System
 *    usa para indexar o card. Sem ele o arquivo é publicado mas não aparece.
 * 2. **Autocontido.** Uma CSP estrita bloqueia CDN, fonte remota e imagem
 *    externa. Todo CSS é inline; nada de `<link>` nem `<script src>`.
 * 3. **Claro e escuro lado a lado.** Quem revisa precisa ver os dois de uma vez;
 *    um card por tema dobra o catálogo e esconde as regressões de contraste.
 * 4. **Estados, não só o estado feliz.** Um card de botão que mostra apenas o
 *    primário em repouso não serve para revisar nada.
 */

export interface OpcoesPreview {
  /** Grupo na lateral do painel — a taxonomia do catálogo. */
  readonly grupo: string
  /** Nome do card. */
  readonly nome: string
  /** Variantes cobertas, mostrado como subtítulo. */
  readonly subtitulo?: string
  readonly largura?: number
  readonly altura?: number
  /** CSS extra, específico do componente. */
  readonly css?: string
  /** Conteúdo, renderizado uma vez em cada tema. */
  readonly corpo: string
  /** Quando o componente só faz sentido num tema, não duplica. */
  readonly temaUnico?: boolean
}

export function montarPreview(o: OpcoesPreview): string {
  const conteudo = o.temaUnico
    ? `<div class="pagina">${o.corpo}</div>`
    : `<div class="par">
    <div class="metade">
      <p class="tema-rotulo">Claro</p>
      ${o.corpo}
    </div>
    <div class="metade escuro">
      <p class="tema-rotulo">Escuro</p>
      ${o.corpo}
    </div>
  </div>`

  // A primeira linha É o marcador. Não mover.
  return `<!-- @dsCard group="${escapar(o.grupo)}" name="${escapar(o.nome)}"${
    o.subtitulo ? ` subtitle="${escapar(o.subtitulo)}"` : ''
  }${o.largura ? ` width="${o.largura}"` : ''}${o.altura ? ` height="${o.altura}"` : ''} -->
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapar(o.nome)} · dent</title>
<style>
${CSS_TOKENS}
${CSS_BASE}
${o.css ?? ''}
</style>
</head>
<body>
${conteudo}
</body>
</html>
`
}

function escapar(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** Bloco rotulado, para agrupar variantes dentro de um card. */
export function grupo(titulo: string, conteudo: string): string {
  return `<div class="grupo"><p class="grupo-titulo">${titulo}</p>${conteudo}</div>`
}

export function linha(conteudo: string): string {
  return `<div class="linha">${conteudo}</div>`
}

export function nota(texto: string): string {
  return `<p class="nota">${texto}</p>`
}
