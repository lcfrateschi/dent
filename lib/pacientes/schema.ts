import { apenasDigitos, cepEhValido, cpfEhValido, telefoneEhValido, UFS } from '@/lib/domain/cpf'
import { ehMenorDeIdade, parseData } from '@/lib/domain/datas'
import { z } from 'zod'

/**
 * Validação de entrada do cadastro de paciente.
 *
 * Zod valida a BORDA; as regras de domínio (`lib/domain/cpf.ts`, `datas.ts`) são
 * a fonte da verdade e são reusadas aqui. Duplicar a regra do CPF num regex
 * seria criar uma segunda definição para divergir da primeira.
 *
 * Campo vazio do formulário chega como `''` e é convertido para `null`: coluna
 * opcional guarda NULL, não string vazia — senão o índice único de CPF trata
 * "sem CPF" como um valor repetido.
 */

const vazioParaNulo = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? null : v

const textoOpcional = z.preprocess(
  vazioParaNulo,
  z.string().trim().max(200).nullable().optional(),
)

const HOJE = (): string => new Date().toISOString().slice(0, 10)

export const pacienteSchema = z
  .object({
    nome: z
      .string()
      .trim()
      .min(3, 'Informe o nome completo.')
      .max(200)
      // Nome de paciente não é campo para observação clínica.
      .refine((v) => v.split(/\s+/).length >= 2, 'Informe nome e sobrenome.'),

    nomeSocial: textoOpcional,

    cpf: z.preprocess(
      vazioParaNulo,
      z
        .string()
        .nullable()
        .optional()
        // Opcional porque criança costuma não ter CPF, e exigir travaria a recepção.
        .refine((v) => v == null || cpfEhValido(v), 'CPF inválido.')
        .transform((v) => (v == null ? null : apenasDigitos(v))),
    ),

    rg: textoOpcional,

    dataNascimento: z
      .string()
      .trim()
      .min(1, 'Informe a data de nascimento.')
      .refine((v) => {
        try {
          parseData(v)
          return true
        } catch {
          return false
        }
      }, 'Data inválida.')
      .refine((v) => v <= HOJE(), 'A data de nascimento não pode ser no futuro.')
      // 130 anos cobre qualquer paciente real e pega o ano digitado errado.
      .refine((v) => v >= '1895-01-01', 'Confira o ano de nascimento.'),

    sexo: z.enum(['feminino', 'masculino', 'outro', 'nao_informado']).default('nao_informado'),

    telefone: z.preprocess(
      vazioParaNulo,
      z
        .string()
        .nullable()
        .optional()
        .refine((v) => v == null || telefoneEhValido(v), 'Telefone inválido.')
        .transform((v) => (v == null ? null : apenasDigitos(v))),
    ),

    telefoneWhatsapp: z.preprocess(
      vazioParaNulo,
      z
        .string()
        .nullable()
        .optional()
        .refine((v) => v == null || telefoneEhValido(v), 'WhatsApp inválido.')
        .transform((v) => (v == null ? null : apenasDigitos(v))),
    ),

    email: z.preprocess(
      vazioParaNulo,
      z.string().trim().email('E-mail inválido.').max(200).nullable().optional(),
    ),

    cep: z.preprocess(
      vazioParaNulo,
      z
        .string()
        .nullable()
        .optional()
        .refine((v) => v == null || cepEhValido(v), 'CEP inválido.')
        .transform((v) => (v == null ? null : apenasDigitos(v))),
    ),

    logradouro: textoOpcional,
    numero: z.preprocess(vazioParaNulo, z.string().trim().max(20).nullable().optional()),
    complemento: textoOpcional,
    bairro: textoOpcional,
    cidade: textoOpcional,
    uf: z.preprocess(
      vazioParaNulo,
      z
        .string()
        .nullable()
        .optional()
        .transform((v) => (v == null ? null : v.toUpperCase()))
        .refine((v) => v == null || (UFS as readonly string[]).includes(v), 'UF inválida.'),
    ),

    responsavelLegalId: z.preprocess(
      vazioParaNulo,
      z.string().uuid('Responsável inválido.').nullable().optional(),
    ),

    indicadoPor: textoOpcional,
    observacoes: z.preprocess(
      vazioParaNulo,
      z.string().trim().max(4000).nullable().optional(),
    ),
    status: z.enum(['ativo', 'inativo', 'arquivado']).default('ativo'),
  })
  .superRefine((dados, ctx) => {
    // Menor de idade precisa de responsável: é quem assina consentimento e
    // orçamento. Regra de negócio, não de formato — por isso vive aqui.
    //
    // O superRefine roda mesmo quando `dataNascimento` já falhou na própria
    // validação, e `ehMenorDeIdade('')` LANÇA. Sem esta guarda, uma data
    // digitada errada viraria erro 500 em vez de erro de campo.
    let menor: boolean
    try {
      menor = ehMenorDeIdade(dados.dataNascimento, HOJE())
    } catch {
      return // a mensagem de data inválida já foi emitida
    }

    if (menor && !dados.responsavelLegalId) {
      ctx.addIssue({
        code: 'custom',
        path: ['responsavelLegalId'],
        message: 'Paciente menor de idade precisa de um responsável legal.',
      })
    }
  })

export type EntradaPaciente = z.input<typeof pacienteSchema>
export type PacienteValidado = z.output<typeof pacienteSchema>

/** Constrói a entrada a partir do FormData da server action. */
export function dosCampos(dados: FormData): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  for (const [chave, valor] of dados.entries()) {
    if (typeof valor === 'string') obj[chave] = valor
  }
  return obj
}

/** Erros por campo, no formato que o formulário consome. */
export type ErrosCampo = Partial<Record<string, string>>

export function achatarErros(erro: z.ZodError): ErrosCampo {
  const saida: ErrosCampo = {}
  for (const issue of erro.issues) {
    const campo = issue.path.join('.') || '_'
    saida[campo] ??= issue.message
  }
  return saida
}
