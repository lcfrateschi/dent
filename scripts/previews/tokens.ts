/**
 * Tokens do design system em texto, para embutir nos previews.
 *
 * **Duplicação consciente**, e o único jeito honesto de fazer isto: os previews
 * do Claude Design são HTML autocontido, sem build e sem rede — não podem
 * importar `app/globals.css`. Há um teste (`previews.test.ts`) que compara este
 * arquivo com o CSS real e falha se divergirem.
 */

export const CSS_TOKENS = `
:root {
  --bg:#f6f8fb; --surface:#ffffff; --surface-2:#eef2f7; --surface-3:#e2e8f0;
  --border:#b9c4d4; --border-forte:#8f9db2;
  --fg:#0d1523; --fg-2:#3d4a5e; --fg-3:#5b6a80;
  --primary:#0f766e; --primary-hover:#115e59; --primary-fg:#ffffff; --ring:#0d9488;
  --sucesso:#15803d; --atencao:#a16207; --critico:#b91c1c;
  --dente-higido:#ffffff; --dente-borda:#7d8ba1; --dente-hover:#d6f0ee;
  --planejado:#b91c1c; --planejado-fill:#fde8e8;
  --executado:#1d4ed8; --executado-fill:#e0e9fd;
  --ausente:#64748b; --coroa:#a16207; --implante:#7e22ce;
  --selecionado:#0d9488; --selecionado-fill:#ccfbf1;
}
.escuro {
  --bg:#0a1120; --surface:#101a2c; --surface-2:#18233a; --surface-3:#223049;
  --border:#35476a; --border-forte:#4c6289;
  --fg:#e9eef7; --fg-2:#b3c0d4; --fg-3:#8f9db4;
  --primary:#2dd4bf; --primary-hover:#5eead4; --primary-fg:#04211d; --ring:#5eead4;
  --sucesso:#4ade80; --atencao:#fbbf24; --critico:#f87171;
  --dente-higido:#1b2740; --dente-borda:#6b7d9c; --dente-hover:#164e4a;
  --planejado:#fca5a5; --planejado-fill:#4c1d1d;
  --executado:#93b4fd; --executado-fill:#1e3070;
  --ausente:#94a3b8; --coroa:#fbbf24; --implante:#c084fc;
  --selecionado:#2dd4bf; --selecionado-fill:#134e4a;
}
`.trim()

/** Nomes de token que o teste de consistência confere contra globals.css. */
export const TOKENS_ESPERADOS = [
  'bg',
  'surface',
  'surface-2',
  'surface-3',
  'border',
  'border-forte',
  'fg',
  'fg-2',
  'fg-3',
  'primary',
  'primary-hover',
  'primary-fg',
  'ring',
  'sucesso',
  'atencao',
  'critico',
  'dente-higido',
  'dente-borda',
  'dente-hover',
  'planejado',
  'planejado-fill',
  'executado',
  'executado-fill',
  'ausente',
  'coroa',
  'implante',
  'selecionado',
  'selecionado-fill',
] as const

export const CSS_BASE = `
*,*::before,*::after{box-sizing:border-box}
body{margin:0;padding:0;background:var(--bg);color:var(--fg);
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.pagina{padding:24px}
.par{display:grid;grid-template-columns:1fr 1fr;gap:0;min-height:100%}
.metade{padding:20px;background:var(--bg);color:var(--fg)}
.metade+.metade{border-left:1px solid var(--border)}
.tema-rotulo{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
  color:var(--fg-3);margin:0 0 14px}
.grupo{margin:0 0 18px}
.grupo:last-child{margin-bottom:0}
.grupo-titulo{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
  color:var(--fg-3);margin:0 0 8px}
.linha{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.nota{font-size:11px;color:var(--fg-3);margin:8px 0 0;line-height:1.5}
.cartao{background:var(--surface);border:1px solid var(--border);border-radius:12px}
.cartao-cabeca{padding:10px 14px;border-bottom:1px solid var(--border)}
.cartao-titulo{font-size:13px;font-weight:600;margin:0}
.cartao-desc{font-size:12px;color:var(--fg-3);margin:2px 0 0}
.cartao-corpo{padding:14px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:40px;
  padding:0 16px;border-radius:8px;border:1px solid var(--border);background:var(--surface);
  color:var(--fg);font-size:14px;font-weight:500;font-family:inherit;cursor:pointer}
.btn-sm{height:36px;padding:0 12px;font-size:13px}
.btn-lg{height:44px;padding:0 20px;font-size:15px}
.btn-primario{background:var(--primary);color:var(--primary-fg);border-color:transparent}
.btn-fantasma{background:transparent;border-color:transparent;color:var(--fg-2)}
.btn-perigo{background:var(--critico);color:#fff;border-color:transparent}
.btn-ativo{border-color:var(--primary);background:var(--selecionado-fill);
  box-shadow:0 0 0 1px var(--primary)}
.btn[disabled]{opacity:.5}
.campo{max-width:280px}
.rotulo{display:block;font-size:14px;font-weight:500;color:var(--fg-2);margin:0 0 4px}
.obrig{color:var(--critico)}
.entrada{width:100%;height:40px;padding:0 12px;border-radius:8px;border:1px solid var(--border);
  background:var(--surface);color:var(--fg);font-size:14px;font-family:inherit}
.entrada::placeholder{color:var(--fg-3)}
.entrada-erro{border-color:var(--critico)}
.ajuda{font-size:12px;color:var(--fg-3);margin:4px 0 0}
.msg-erro{font-size:14px;color:var(--critico);margin:4px 0 0}
.alerta{border-radius:8px;border:1px solid;padding:8px 12px;font-size:14px}
.alerta-critico{border-color:color-mix(in oklab,var(--critico) 40%,transparent);
  background:color-mix(in oklab,var(--critico) 10%,transparent);color:var(--critico)}
.alerta-atencao{border-color:color-mix(in oklab,var(--atencao) 40%,transparent);
  background:color-mix(in oklab,var(--atencao) 10%,transparent);color:var(--atencao)}
.alerta-sucesso{border-color:color-mix(in oklab,var(--sucesso) 40%,transparent);
  background:color-mix(in oklab,var(--sucesso) 10%,transparent);color:var(--sucesso)}
.etiqueta{display:inline-block;border-radius:999px;border:1px solid;padding:1px 8px;
  font-size:12px;font-weight:500}
table{width:100%;border-collapse:collapse;font-size:14px}
thead tr{background:var(--surface-2);text-align:left}
th{padding:8px 12px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
  color:var(--fg-3)}
td{padding:8px 12px;border-top:1px solid var(--border)}
`.trim()
