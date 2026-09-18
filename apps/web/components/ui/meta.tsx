// RuptureGrid v1.0 — monospace metadata primitives (Phase 6).
// Identifiers, hashes, amounts, and timestamps render in technical
// type (product-design §5). Long values are truncation-safe with the
// full value reachable (title + <details> blocks), never hidden.

export function MetaItem({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="meta-item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function MonoValue({ value, title }: { readonly value: string; readonly title?: string }) {
  return (
    <span className="mono-value" title={title ?? value}>
      {value}
    </span>
  );
}

export function ProofJson({ label, value }: { readonly label: string; readonly value: unknown }) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <details className="proof-json">
      <summary>{label}</summary>
      <pre>
        <code>{text}</code>
      </pre>
    </details>
  );
}
