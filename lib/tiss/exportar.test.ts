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
  // Campos que o XSD da ANS exige e que não estavam aqui — a ausência deles era
  // parte do motivo de o XML nunca ter validado. Ver `CadastroParaTiss`.
  cadastro: {
    codigoPrestadorNaOperadora: 'PREST-00042',
    cnes: '1234567',
    cbos: '223208',
    planoBeneficiario: 'Odonto Pleno',
    tipoAtendimento: '1',
    tipoFaturamento: '4',
    atendimentoRecemNascido: 'N',
  },
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

  it('declara a versão do padrão no elemento que o XSD nomeia', () => {
    // `Padrao`, com maiúscula — não `versaoPadrao`, que era o nome inventado antes
    // de o XSD ser carregado. O schema recusa elemento desconhecido.
    expect(xml).toContain(`<ans:Padrao>${VERSAO_TISS}</ans:Padrao>`)
  })

  it('tem origem, destino e hora de registro — obrigatórios e ausentes antes', () => {
    expect(xml).toContain('<ans:horaRegistroTransacao>13:00:00</ans:horaRegistroTransacao>')
    expect(xml).toContain('<ans:CNPJ>12345678000199</ans:CNPJ>')
    expect(xml).toMatch(/<ans:destino>\s*<ans:registroANS>123456<\/ans:registroANS>/)
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

  it('ESCAPA caractere especial nos campos de texto', () => {
    // "Sanches & Filhos" ou um `<` num campo quebrariam o XML inteiro.
    //
    // O apóstrofo é conferido no nome do PACIENTE, e não no da clínica: a guia
    // odontológica do TISS 3.05.00 **não tem** nome de contratado. A clínica é
    // identificada por CNPJ (no cabeçalho), CNES e código na operadora — o
    // `nomeContratado` que o gerador antigo emitia não existe no schema.
    const perigoso = xmlGuiaOdontologica({
      ...GUIA,
      pacienteNome: `Maria & João <teste> "aspas" d'Ouro`,
      profissionalNome: 'Dra. Helena & Silva',
    })
    expect(perigoso).toContain('Maria &amp; João &lt;teste&gt; &quot;aspas&quot; d&apos;Ouro')
    expect(perigoso).toContain('Dra. Helena &amp; Silva')
    // E continua bem formado.
    expect(perigoso).not.toMatch(/<teste>/)
  })

  it('inclui um item por procedimento', () => {
    // `procedimentosExecutados` é o elemento REPETIDO (maxOccurs unbounded), não um
    // invólucro com filhos — era assim que o gerador antigo fazia, e é invalidez
    // estrutural que só o XSD revela.
    const ocorrencias = [...xml.matchAll(/<ans:procedimentosExecutados>/g)].length
    expect(ocorrencias).toBe(GUIA.itens.length)
  })

  it('numera os itens sequencialmente, como o XSD exige', () => {
    expect(xml).toContain('<ans:sequencialItem>1</ans:sequencialItem>')
    expect(xml).toContain('<ans:sequencialItem>2</ans:sequencialItem>')
  })

  it('omite dente e face quando não se aplicam', () => {
    // Profilaxia não tem dente. Mandar tag vazia é motivo de rejeição de schema.
    const blocos = xml.split('<ans:procedimentosExecutados>')
    const profilaxia = blocos.find((b) => b.includes('Profilaxia'))!
    expect(profilaxia).not.toContain('denteRegiao')
    expect(profilaxia).not.toContain('denteFace')
  })

  it('a UF sai em código IBGE, porque dm_UF do TISS não aceita sigla', () => {
    // SP = 35. O gerador antigo emitia `<ans:UF>SP</ans:UF>` e o schema recusava:
    // dm_UF enumera 11…53. A sigla continua sendo o que a clínica cadastra.
    expect(xml).toContain('<ans:ufExec>35</ans:ufExec>')
    expect(xml).not.toContain('<ans:ufExec>SP</ans:ufExec>')
  })

  it('a face vira código de até 5 caracteres', () => {
    // `denteFace` é st_texto5. "oclusal e mesial" tem 16 e era recusado.
    const m = /<ans:denteFace>([^<]*)<\/ans:denteFace>/.exec(xml)
    expect(m).not.toBeNull()
    expect(m![1]!.length).toBeLessThanOrEqual(5)
    expect(m![1]).toBe('MO')
  })

  it('a tabela do procedimento é a 22 (TUSS de procedimentos)', () => {
    expect(xml).toContain('<ans:codigoTabela>22</ans:codigoTabela>')
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
      valorApresentado: '180.00',
    })
    expect(semTuss).toContain('<ans:codigoProcedimento></ans:codigoProcedimento>')
  })

  it('ESTOURA em vez de emitir XML sem o cadastro obrigatório', () => {
    // Emitir com campo vazio produz documento que passa em parser e morre na
    // operadora — semanas depois, sem dizer o motivo. Falhar aqui é mais barato.
    expect(() => xmlGuiaOdontologica({ ...GUIA, cadastro: undefined })).toThrowError(/falta/)
    expect(() =>
      xmlGuiaOdontologica({ ...GUIA, cadastro: { ...GUIA.cadastro!, cnes: null } }),
    ).toThrowError(/CNES/)
  })

  it('ESTOURA em UF sem código IBGE, em vez de emitir sigla', () => {
    expect(() => xmlGuiaOdontologica({ ...GUIA, ufCro: 'XX' })).toThrowError(/IBGE/)
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

  it('aponta o cadastro TISS que falta, um por um', () => {
    // Estes campos são obrigatórios no XSD e o banco ainda não os guarda. Aparecem
    // como pendência em vez de valor plausível, pelo mesmo motivo dos 13 códigos
    // TUSS em branco: inventado passa no schema e volta como glosa.
    const r = conferirAntesDeEnviar({ ...GUIA, cadastro: undefined }).join(' ')
    expect(r).toContain('cadastro TISS')
    expect(r).toContain('folha de conferência')

    const parcial = conferirAntesDeEnviar({
      ...GUIA,
      cadastro: { ...GUIA.cadastro!, cnes: null, cbos: null },
    }).join(' ')
    expect(parcial).toContain('CNES')
    expect(parcial).toContain('CBOS')
    // E não reclama do que está preenchido.
    expect(parcial).not.toContain('plano do beneficiário')
  })

  it('aponta UF que não é sigla conhecida', () => {
    expect(conferirAntesDeEnviar({ ...GUIA, ufCro: 'XX' }).join(' ')).toContain('não é uma sigla')
  })

  it('guia sem item é apontada', () => {
    expect(conferirAntesDeEnviar({ ...GUIA, itens: [], valorApresentado: '0.00' }).join(' ')).toContain(
      'não tem procedimento',
    )
  })
})
