import { erro } from './erros'

/**
 * Regras de arquivo anexado ao prontuário.
 *
 * Três coisas moram aqui, e nenhuma delas é sobre "gostar de validar":
 *
 * 1. **O tipo real, lido dos bytes.** A extensão e o `Content-Type` vêm do
 *    cliente e mentem — por engano (o celular manda `application/octet-stream`)
 *    ou de propósito. Radiografia é dado de prontuário; o que entra ali tem de
 *    ser o que diz ser.
 *
 * 2. **A chave de armazenamento, que nunca é o nome original.** `../../etc/passwd`
 *    é o caso óbvio; os que realmente acontecem são acento e espaço quebrando
 *    assinatura de URL, dois pacientes com `panoramica.jpg`, e nome de arquivo
 *    carregando dado pessoal ("joana-silva-hiv.pdf") para dentro do bucket.
 *
 * 3. **Limite de tamanho por tipo.** Tomografia é grande, receita não. Um limite
 *    único ou barra o exame legítimo ou aceita 200 MB de vídeo por engano.
 */

// ── Tipos de arquivo aceitos ─────────────────────────────────────────────────

export type FormatoArquivo = 'jpeg' | 'png' | 'webp' | 'heic' | 'pdf' | 'dicom' | 'tiff'

export interface Formato {
  readonly formato: FormatoArquivo
  readonly mime: string
  readonly extensao: string
  readonly rotulo: string
  /**
   * `false` quando o navegador não exibe o formato direto.
   *
   * HEIC é o caso que aparece na clínica: o dentista fotografa com iPhone e o
   * arquivo não abre no Chrome nem no Firefox. Aceitar e avisar é melhor que
   * recusar — o arquivo é legítimo e é o único registro daquele momento.
   */
  readonly exibivelNoNavegador: boolean
}

export const FORMATOS: Readonly<Record<FormatoArquivo, Formato>> = {
  jpeg: {
    formato: 'jpeg',
    mime: 'image/jpeg',
    extensao: 'jpg',
    rotulo: 'JPEG',
    exibivelNoNavegador: true,
  },
  png: {
    formato: 'png',
    mime: 'image/png',
    extensao: 'png',
    rotulo: 'PNG',
    exibivelNoNavegador: true,
  },
  webp: {
    formato: 'webp',
    mime: 'image/webp',
    extensao: 'webp',
    rotulo: 'WebP',
    exibivelNoNavegador: true,
  },
  heic: {
    formato: 'heic',
    mime: 'image/heic',
    extensao: 'heic',
    rotulo: 'HEIC (foto de iPhone)',
    exibivelNoNavegador: false,
  },
  pdf: {
    formato: 'pdf',
    mime: 'application/pdf',
    extensao: 'pdf',
    rotulo: 'PDF',
    exibivelNoNavegador: true,
  },
  dicom: {
    formato: 'dicom',
    mime: 'application/dicom',
    extensao: 'dcm',
    rotulo: 'DICOM (imagem de tomógrafo)',
    exibivelNoNavegador: false,
  },
  tiff: {
    formato: 'tiff',
    mime: 'image/tiff',
    extensao: 'tif',
    rotulo: 'TIFF',
    exibivelNoNavegador: false,
  },
}

/**
 * Detecta o formato pelos bytes iniciais.
 *
 * Não confia em extensão nem em `Content-Type`. Precisa de pelo menos 132 bytes
 * para reconhecer DICOM, cuja marca fica no deslocamento 128 — o cabeçalho de
 * 128 bytes antes dela é preâmbulo livre, então DICOM é o único formato aqui que
 * não se identifica no começo do arquivo.
 */
export function detectarFormato(bytes: Uint8Array): FormatoArquivo | null {
  const b = bytes

  // JPEG: FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return 'png'
  }

  // PDF: %PDF-
  if (b.length >= 5 && texto(b, 0, 5) === '%PDF-') return 'pdf'

  // DICOM: 'DICM' no deslocamento 128.
  if (b.length >= 132 && texto(b, 128, 132) === 'DICM') return 'dicom'

  // RIFF....WEBP
  if (b.length >= 12 && texto(b, 0, 4) === 'RIFF' && texto(b, 8, 12) === 'WEBP') return 'webp'

  // ISO-BMFF: '....ftyp' + marca. HEIC/HEIF do iPhone.
  if (b.length >= 12 && texto(b, 4, 8) === 'ftyp') {
    const marca = texto(b, 8, 12)
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis'].includes(marca)) {
      return 'heic'
    }
  }

  // TIFF: II*\0 (little endian) ou MM\0* (big endian). Alguns scanners de
  // radiografia ainda entregam TIFF.
  if (b.length >= 4) {
    if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) return 'tiff'
    if (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a) return 'tiff'
  }

  return null
}

function texto(b: Uint8Array, de: number, ate: number): string {
  let s = ''
  for (let i = de; i < ate && i < b.length; i++) s += String.fromCharCode(b[i]!)
  return s
}

/** Bytes necessários para decidir o formato. Menos que isso não conclui DICOM. */
export const BYTES_PARA_DETECTAR = 132

// ── Limite de tamanho ────────────────────────────────────────────────────────

export type TipoDocumento =
  | 'atestado'
  | 'receita'
  | 'termo_consentimento'
  | 'orcamento_pdf'
  | 'radiografia'
  | 'foto_clinica'
  | 'exame'
  | 'documento_pessoal'
  | 'outro'

const MB = 1024 * 1024

/**
 * Limite por tipo, em bytes.
 *
 * Tomografia (DICOM) e radiografia panorâmica passam fácil de 20 MB; receita e
 * atestado são PDF de uma página. Um limite único serviria mal aos dois.
 */
export const LIMITE_BYTES: Readonly<Record<TipoDocumento, number>> = {
  atestado: 5 * MB,
  receita: 5 * MB,
  termo_consentimento: 10 * MB,
  orcamento_pdf: 10 * MB,
  radiografia: 60 * MB,
  foto_clinica: 30 * MB,
  exame: 60 * MB,
  documento_pessoal: 10 * MB,
  outro: 20 * MB,
}

/** Formatos que fazem sentido por tipo. Vazio = qualquer um da lista geral. */
const FORMATOS_POR_TIPO: Readonly<Partial<Record<TipoDocumento, readonly FormatoArquivo[]>>> = {
  atestado: ['pdf'],
  receita: ['pdf'],
  orcamento_pdf: ['pdf'],
  termo_consentimento: ['pdf', 'jpeg', 'png', 'heic'],
  // Radiografia digitalizada vem como imagem; do tomógrafo, como DICOM.
  radiografia: ['jpeg', 'png', 'webp', 'heic', 'tiff', 'dicom', 'pdf'],
  foto_clinica: ['jpeg', 'png', 'webp', 'heic'],
}

export interface ArquivoRecebido {
  readonly nome: string
  readonly tamanhoBytes: number
  /** `Content-Type` informado pelo cliente. Serve de pista, não de prova. */
  readonly mimeDeclarado?: string
  /** Primeiros bytes, para detectar o formato real. */
  readonly bytesIniciais: Uint8Array
}

export interface ArquivoValidado {
  readonly formato: Formato
  /** `true` quando o tipo declarado pelo cliente não corresponde ao real. */
  readonly mimeDivergente: boolean
}

/**
 * Valida o arquivo para um tipo de documento.
 *
 * Lança com mensagem para a tela — quem faz upload precisa saber *o que* trocar,
 * não que "houve um erro".
 */
export function validarArquivo(a: ArquivoRecebido, tipo: TipoDocumento): ArquivoValidado {
  if (a.tamanhoBytes <= 0) {
    erro('ARQUIVO_VAZIO', 'O arquivo está vazio.')
  }

  const limite = LIMITE_BYTES[tipo]
  if (limite === undefined) {
    erro('TIPO_DOCUMENTO_INVALIDO', `Tipo de documento desconhecido: "${tipo}".`, { tipo })
  }
  if (a.tamanhoBytes > limite) {
    erro(
      'ARQUIVO_GRANDE',
      `Arquivo de ${emMegabytes(a.tamanhoBytes)} excede o limite de ${emMegabytes(limite)} para ${tipo.replace('_', ' ')}.`,
      { tamanhoBytes: a.tamanhoBytes, limite },
    )
  }

  const detectado = detectarFormato(a.bytesIniciais)
  if (!detectado) {
    erro(
      'FORMATO_NAO_RECONHECIDO',
      'Não reconheci o formato do arquivo. Aceito JPEG, PNG, WebP, HEIC, TIFF, PDF e DICOM.',
      { nome: a.nome },
    )
  }

  const permitidos = FORMATOS_POR_TIPO[tipo]
  if (permitidos && !permitidos.includes(detectado)) {
    erro(
      'FORMATO_INCOMPATIVEL',
      `${FORMATOS[detectado].rotulo} não serve para ${tipo.replace('_', ' ')}. Aceito: ${permitidos.map((f) => FORMATOS[f].rotulo).join(', ')}.`,
      { detectado, tipo },
    )
  }

  const formato = FORMATOS[detectado]
  const declarado = (a.mimeDeclarado ?? '').toLowerCase().split(';')[0]!.trim()
  const mimeDivergente =
    declarado.length > 0 &&
    declarado !== 'application/octet-stream' &&
    declarado !== formato.mime &&
    // O navegador manda 'image/heif' e 'image/jpg' com frequência.
    !(formato.formato === 'heic' && declarado === 'image/heif') &&
    !(formato.formato === 'jpeg' && declarado === 'image/jpg')

  return { formato, mimeDivergente }
}

export function emMegabytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`
  const mb = bytes / MB
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

// ── Chave de armazenamento ───────────────────────────────────────────────────

/**
 * Onde o arquivo mora no bucket.
 *
 * **Nunca deriva do nome enviado.** É
 * `clinicas/<clinicaId>/pacientes/<pacienteId>/<ano>/<documentoId>.<ext>`: o id do
 * documento é a chave única, e o ano só existe para o prefixo não virar um
 * diretório com dez mil objetos — o que atrapalha listagem e ciclo de vida no S3.
 *
 * O nome original continua guardado em `documento.nome`, para exibir e para
 * baixar com um nome que faça sentido. Ele simplesmente não decide caminho.
 *
 * ── Por que o prefixo de clínica existe ─────────────────────────────────────
 * Não é para impedir vazamento na leitura: `documento.storage_key` vem de uma
 * consulta já filtrada por tenant (RLS), então a chave que o app resolve é, por
 * construção, da clínica da sessão. O prefixo resolve outras três coisas, e a
 * segunda é a que obriga:
 *
 * 1. **Defesa em profundidade.** Uma chave vinda de importação, de um backup
 *    antigo ou de um bug passa a ser identificável: `chaveTemTenant()` recusa o
 *    que não declara de quem é.
 * 2. **Exportar e restaurar UMA clínica.** Sem prefixo, os arquivos de todos os
 *    clientes ficam na mesma árvore `pacientes/<uuid>/` e não há como levar só os
 *    de um. Isso não é conforto: é portabilidade de dado do titular (LGPD) para a
 *    clínica que sai, e é restauração seletiva quando uma só precisa voltar. Um
 *    dump de banco por clínica sem os arquivos correspondentes **não reconstitui
 *    prontuário**.
 * 3. **Ciclo de vida e custo por cliente** no S3, que se declara por prefixo.
 *
 * O `clinicaId` vem do `Ator`/`SessaoPortal`, nunca de parâmetro que o chamador
 * escolhe — mesma regra que vale para todo o resto do tenant.
 */
export function chaveArmazenamento(p: {
  readonly clinicaId: string
  readonly pacienteId: string
  readonly documentoId: string
  readonly extensao: string
  readonly ano: number
}): string {
  if (!/^[0-9a-f-]{36}$/i.test(p.clinicaId)) {
    erro('CLINICA_INVALIDA', 'Id de clínica inválido para chave de armazenamento.')
  }
  if (!/^[0-9a-f-]{36}$/i.test(p.pacienteId)) {
    erro('PACIENTE_INVALIDO', 'Id de paciente inválido para chave de armazenamento.')
  }
  if (!/^[0-9a-f-]{36}$/i.test(p.documentoId)) {
    erro('DOCUMENTO_INVALIDO', 'Id de documento inválido para chave de armazenamento.')
  }
  if (!/^[a-z0-9]{1,8}$/.test(p.extensao)) {
    erro('EXTENSAO_INVALIDA', `Extensão inválida: "${p.extensao}".`, { extensao: p.extensao })
  }
  if (!Number.isInteger(p.ano) || p.ano < 2000 || p.ano > 2200) {
    erro('ANO_INVALIDO', `Ano inválido para chave: ${p.ano}.`, { ano: p.ano })
  }

  return `clinicas/${p.clinicaId.toLowerCase()}/pacientes/${p.pacienteId.toLowerCase()}/${p.ano}/${p.documentoId.toLowerCase()}.${p.extensao}`
}

/** O prefixo de uma clínica. Um lugar só, para exportação e backup não divergirem do gerador. */
export function prefixoDaClinica(clinicaId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(clinicaId)) {
    erro('CLINICA_INVALIDA', 'Id de clínica inválido para prefixo de armazenamento.')
  }
  return `clinicas/${clinicaId.toLowerCase()}/`
}

/**
 * `true` quando a chave declara a que clínica pertence.
 *
 * Separada de `chaveEhSegura()` de propósito, e não juntada a ela: são duas
 * perguntas diferentes e mandam quem lê o erro para lugares diferentes. "Chave
 * insegura" é tentativa de travessia de diretório; "chave sem tenant" é dado
 * anterior à Fase 17 que não foi migrado, ou um gerador novo que esqueceu o
 * prefixo. Uma mensagem só para as duas faria o segundo caso ser investigado como
 * ataque.
 *
 * ⚠️ **Não confunda com autorização.** Isto diz que a chave tem *um* tenant, não
 * que tem o *seu*. Quem garante que é o seu é a consulta que trouxe a linha do
 * `documento`, filtrada por RLS. Se um dia alguém quiser a checagem redundante no
 * ponto de leitura, o lugar é onde o `Ator` existe — não aqui, que é domínio puro
 * e não conhece sessão.
 */
export function chaveTemTenant(chave: string): boolean {
  return /^clinicas\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//.test(chave)
}

/**
 * Recusa chave que escape do prefixo esperado.
 *
 * O provedor em disco resolve a chave em caminho de arquivo. Sem esta checagem,
 * uma chave com `..` viraria leitura de qualquer arquivo do servidor — e as
 * chaves nem sempre vêm do nosso gerador: vêm do banco, e um dia virão de uma
 * importação.
 */
export function chaveEhSegura(chave: string): boolean {
  if (chave.length === 0 || chave.length > 512) return false
  if (chave.startsWith('/') || chave.includes('//')) return false
  if (chave.includes('\0') || chave.includes('\\')) return false
  // Rejeita '..' como segmento inteiro; 'a..b' num nome não é travessia.
  if (chave.split('/').some((s) => s === '.' || s === '..' || s.length === 0)) return false
  return /^[A-Za-z0-9._/-]+$/.test(chave)
}

/**
 * Nome com que o arquivo é baixado.
 *
 * Tira acento, espaço e tudo que possa quebrar o cabeçalho `Content-Disposition`
 * ou virar injeção de linha nele (`"` e `\r\n` são os que importam). Mantém a
 * extensão real, não a que veio.
 */
export function nomeParaDownload(nomeOriginal: string, extensao: string): string {
  const base = nomeOriginal
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9 ._-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 80)

  return `${base.length > 0 ? base : 'documento'}.${extensao}`
}

/**
 * `true` quando o arquivo pode ser exibido embutido na página.
 *
 * Só imagem e PDF, e **nunca** por confiança no `Content-Type` do banco: o
 * formato aqui vem da detecção por bytes. Servir `text/html` embutido a partir
 * do nosso domínio seria XSS com o prontuário do lado.
 */
export function podeExibirEmbutido(formato: FormatoArquivo): boolean {
  return FORMATOS[formato].exibivelNoNavegador
}
