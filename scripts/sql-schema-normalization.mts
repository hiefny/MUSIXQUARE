export function normalizeSchemaSql(sql: unknown): string {
  return String(sql || '')
    .replace(/--[^\r\n]*/g, '')
    .trim()
    .replace(/;\s*$/, '')
    .replace(/\bIF\s+NOT\s+EXISTS\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .replace(/\s*=\s*/g, '=')
    .trim()
    .toLowerCase();
}
