/**
 * Seletor de período: formulário GET, sem JavaScript.
 *
 * `method="get"` de propósito — o período fica na URL, então o link é compartilhável e
 * o botão "voltar" funciona. Um seletor com estado de cliente perderia as duas coisas
 * para ganhar nada: não há interação além de escolher duas datas e submeter.
 *
 * O mesmo padrão de `financeiro/comissoes`.
 */
export function Periodo({ deIso, ateIso, rotulo }: { deIso: string; ateIso: string; rotulo: string }) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-2">
      <div>
        <label htmlFor="de" className="mb-1 block text-sm font-medium text-fg-2">
          De
        </label>
        <input
          id="de"
          name="de"
          type="date"
          defaultValue={deIso}
          className="h-10 rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
        />
      </div>
      <div>
        <label htmlFor="ate" className="mb-1 block text-sm font-medium text-fg-2">
          Até
        </label>
        <input
          id="ate"
          name="ate"
          type="date"
          defaultValue={ateIso}
          className="h-10 rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
        />
      </div>
      <button
        type="submit"
        className="h-10 rounded-(--radius-controle) bg-primary px-4 text-sm font-medium text-primary-fg"
      >
        {rotulo}
      </button>
    </form>
  )
}

/** Aceita só `AAAA-MM-DD`. Qualquer outra coisa cai no padrão de quem chamou. */
export function dataValida(v: string | undefined): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}
