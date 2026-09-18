// RuptureGrid v1.0 — finding structured details (Phase 6).
// Renders the evaluation-derived detail record: counts stay integers,
// amounts render FROM minor units with their currency (ADR-0004),
// attribution basis is named exactly. Unknown fields are never
// invented; the raw JSON is one disclosure away.

import { formatMinorUnits } from '@/lib/semantics';

export function FindingDetails({ details }: { readonly details: unknown }) {
  if (typeof details !== 'object' || details === null) {
    return null;
  }
  const record = details as Record<string, unknown>;
  const rows: Array<{ readonly label: string; readonly value: string }> = [];
  for (const [key, value] of Object.entries(record)) {
    if (key === 'amountMinor' || key === 'balanceMinor') {
      const currency = typeof record['currency'] === 'string' ? record['currency'] : 'PKR';
      rows.push({
        label: key,
        value:
          typeof value === 'string' || typeof value === 'number'
            ? formatMinorUnits(value, currency)
            : String(value),
      });
      continue;
    }
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      rows.push({ label: key, value: String(value) });
    }
  }
  if (rows.length === 0) {
    return null;
  }
  return (
    <div className="kv-table">
      <table>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>
                <span className="mono-value">{row.value}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
