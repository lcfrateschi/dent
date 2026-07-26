import { describe, expect, it } from 'vitest'
import {
  type DadosGuiaParaExportar,
  VERSAO_TISS,
  conferirAntesDeEnviar,
  folhaDeConferencia,
  xmlGuiaOdontologica,
} from './exportar'

const GUIA: DadosGuiaParaExportar = {
  numero: '1042',
  registroAns: '123456',
  convenioNome: 'Odonto Exemplo',
  numeroLote: 'LOTE-2026-07',
  pacienteNome: 'Joana Pereira da Silva',
  pacienteCpf: '52998224725',
  pacienteNascimento: '1988-03-12',
  numeroCarteirinha: 'CART-99887',
  profissionalNome: 'Dra. Helena Marques',
  cro: '54321',
  ufCro: 'sp',
  clinicaNome: 'Clínica Sorriso',
  clinicaCnpj: '12345678000199',
  emitidaEm: new Date('2026-07-26T13:00:00Z'),
  valorApresentado: '280.00',
  itens: [
    {
      codigoTuss: '81000403',
      descricao: 'Restauração em resina composta',
      denteFdi: 36,
      faces: 'oclusal e mesial',
      quantidade: 1,
      dataExecucao: '2026-07-10',
      valorApresentado: '180.00',
    },
    {
      codigoTuss: '81000012',
      descricao: 'Profilaxia',
      denteFdi: null,
      faces: null,
      quantidade: 1,
      dataExecucao: '2026-07-10',
      valorApresentado: '100.00',
    },
  ],
}

describe('folha de conferência', () => {
  const folha = folhaDeConferencia(GUIA)

  it('traz os campos que o portal da operadora pede', () => {
    expect(folha).toContain('GUIA 1042')
    expect(folha).toContain('Registro ANS: 123456')
    expect(folha).toContain('CART-99887')
    expect(folha).toContain('12/03/1988')
    // A UF sai em maiúscula mesmo cadastrada minúscula: quem digita no portal é
    // uma pessoa, e "sp" é campo recusado.
    expect(folha).toContain('CRO .............. SP 54321')
    expect(folha).toContain('LOTE-2026-07')
  })

  it('lista os procedimentos com TUSS, data, dente e valor', () => {
    expect(folha).toContain('81000403')
    expect(folha).toContain('10/07/2026')
    expect(folha).toContain('36')
    expect(folha).toContain('Restauração em resina composta')
    expect(folha).toContain('TOTAL: R$ 280.00')
  })

  it('MARCA item sem código TUSS, porque é glosa na entrada', () => {
    const semTuss = folhaDeConferencia({
      ...GUIA,
      itens: [{ ...GUIA.itens[0]!, codigoTuss: null }, GUIA.itens[1]!],
    })
    expect(semTuss).toContain('!! SEM TUSS')
    expect(semTuss).toContain('Tabela 22 da ANS')
  })

  it('não avisa de TUSS quando todos têm código', () => {
    expect(folha).not.toContain('SEM TUSS')
    expect(folha).not.toContain('ATENÇÃO')
  })

  it('procedimento sem dente aparece com travessão, não vazio', () => {
    // Célula vazia numa folha impressa parece campo esquecido.
    expect(folha).toMatch(/Profilaxia/)
    const linhaProfilaxia = folha.split('\n').find((l) => l.includes('Profilaxia'))!
    expect(linhaProfilaxia).toContain('—')
  })
})

describe('XML TISS', () => {
  const xml = xmlGuiaOdontologica(GUIA)

  it('é XML bem formado com a declaração e o namespace da ANS', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('xmlns:ans="http://www.ans.gov.br/padroes/tiss/schemas"')
    expect(xml.trimEnd().endsWith('</ans:mensagemTISS>')).toBe(true)
  })

  it('declara a versão do padrão', () => {
    expect(xml).toContain(`<ans:versaoPadrao>${VERSAO_TISS}</ans:versaoPadrao>`)
  })

  it('as tags abrem e fecham em número igual', () => {
    // Verificação estrutural possível sem o XSD: nenhuma tag órfã, e a pilha
    // fecha na ordem inversa. O regex aceita atributo (`[^>]*`) porque a tag raiz
    // carrega o xmlns — sem isso a abertura da raiz não seria contada e o teste
    // acusaria desequilíbrio que não existe.
    const pilha: string[] = []
    for (const m of xml.matchAll(/<(\/?)ans:([A-Za-z]+)[^>]*>/g)) {
      if (m[1] === '') pilha.push(m[2]!)
      else expect(pilha.pop(), `fechou ${m[2]} fora de ordem`).toBe(m[2])
    }
    expect(pilha, 'toda tag aberta foi fechada').toHaveLength(0)
  })

  it('ESCAPA caractere especial no nome do paciente', () => {
    // "Sanches & Filhos" ou um `<` num campo quebrariam o XML inteiro.
    const perigoso = xmlGuiaOdontologica({
      ...GUIA,
      pacienteNome: 'Maria & João <teste> "aspas"',
      clinicaNome: "Clínica d'Ouro & Cia",
    })
    expect(perigoso).toContain('Maria &amp; João &lt;teste&gt; &quot;aspas&quot;')
    expect(perigoso).toContain('&apos;')
    // E continua bem formado.
    expect(perigoso).not.toMatch(/<teste>/)
  })

  it('inclui um item por procedimento', () => {
    const ocorrencias = [...xml.matchAll(/<ans:procedimentoExecutado>/g)].length
    expect(ocorrencias).toBe(GUIA.itens.length)
  })

  it('omite dente e face quando não se aplicam', () => {
    // Profilaxia não tem dente. Mandar tag vazia é motivo de rejeição de schema.
    const blocos = xml.split('<ans:procedimentoExecutado>')
    const profilaxia = blocos.find((b) => b.includes('Profilaxia'))!
    expect(profilaxia).not.toContain('denteRegiao')
    expect(profilaxia).not.toContain('<ans:face>')
  })

  it('a UF do CRO sai em maiúscula', () => {
    expect(xml).toContain('<ans:UF>SP</ans:UF>')
  })

  it('tem epílogo com hash de 32 caracteres', () => {
    const m = /<ans:hash>([0-9a-f]+)<\/ans:hash>/.exec(xml)
    expect(m).not.toBeNull()
    expect(m![1]).toHaveLength(32)
  })

  it('o hash MUDA quando o conteúdo muda', () => {
    const outro = xmlGuiaOdontologica({ ...GUIA, valorApresentado: '281.00' })
    const h1 = /<ans:hash>([0-9a-f]+)</.exec(xml)![1]
    const h2 = /<ans:hash>([0-9a-f]+)</.exec(outro)![1]
    expect(h2).not.toBe(h1)
  })

  it('é reproduzível: mesma guia, mesmo XML', () => {
    expect(xmlGuiaOdontologica(GUIA)).toBe(xml)
  })

  it('guia sem TUSS gera XML com o campo vazio — e é por isso que se confere antes', () => {
    // O gerador não inventa código. O campo sai vazio e `conferirAntesDeEnviar`
    // é quem barra.
    const semTuss = xmlGuiaOdontologica({
      ...GUIA,
      itens: [{ ...GUIA.itens[0]!, codigoTuss: null }],
    })
    expect(semTuss).toContain('<ans:codigoProcedimento></ans:codigoProcedimento>')
  })
})

describe('conferência antes de enviar', () => {
  it('guia completa não tem problema', () => {
    expect(conferirAntesDeEnviar(GUIA)).toEqual([])
  })

  it('aponta falta de registro ANS e de CNPJ', () => {
    const r = conferirAntesDeEnviar({ ...GUIA, registroAns: null, clinicaCnpj: null })
    expect(r.join(' ')).toContain('registro ANS')
    expect(r.join(' ')).toContain('CNPJ')
  })

  it('aponta procedimento sem TUSS e cita a fonte oficial', () => {
    const r = conferirAntesDeEnviar({
      ...GUIA,
      itens: [{ ...GUIA.itens[0]!, codigoTuss: null }, GUIA.itens[1]!],
    })
    expect(r.join(' ')).toContain('1 procedimento(s) sem código TUSS')
    expect(r.join(' ')).toContain('Tabela 22 da ANS')
  })

  it('aponta soma dos itens que não fecha com o total', () => {
    const r = conferirAntesDeEnviar({ ...GUIA, valorApresentado: '300.00' })
    expect(r.join(' ')).toContain('não fecha')
  })

  it('a soma é comparada em centavos, sem erro de float', () => {
    const r = conferirAntesDeEnviar({
      ...GUIA,
      valorApresentado: '0.30',
      itens: [
        { ...GUIA.itens[0]!, valorApresentado: '0.10' },
        { ...GUIA.itens[1]!, valorApresentado: '0.20' },
      ],
    })
    // 0.1 + 0.2 em float não é 0.3; em centavos é.
    expect(r.filter((p) => p.includes('não fecha'))).toEqual([])
  })

  it('guia sem item é apontada', () => {
    expect(conferirAntesDeEnviar({ ...GUIA, itens: [], valorApresentado: '0.00' }).join(' ')).toContain(
      'não tem procedimento',
    )
  })
})
