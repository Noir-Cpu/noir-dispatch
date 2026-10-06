// Reads the Cloudflare `_headers` file format (the subset this project uses) so the Node dev server serves the same headers as production.
// Supported: path rules with `*` splats, "Name: value" lines, and "! Name" to remove a header set by an earlier rule.

export type HeaderRule = { pattern: RegExp; set: [string, string][]; unset: string[] };

export function parseHeadersFile(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let cur: HeaderRule | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      const re = raw.trim().split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
      cur = { pattern: new RegExp(`^${re}$`), set: [], unset: [] };
      rules.push(cur);
    } else if (cur) {
      const line = raw.trim();
      if (line.startsWith("!")) cur.unset.push(line.slice(1).trim().toLowerCase());
      else {
        const i = line.indexOf(":");
        if (i > 0) cur.set.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]);
      }
    }
  }
  return rules;
}

export function headersFor(rules: HeaderRule[], path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rules) {
    if (!r.pattern.test(path)) continue;
    for (const k of r.unset) delete out[k];
    for (const [k, v] of r.set) out[k] = out[k] ? `${out[k]}, ${v}` : v;
  }
  return out;
}
