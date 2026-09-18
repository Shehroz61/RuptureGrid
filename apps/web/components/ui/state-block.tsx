// =====================================================================
// RuptureGrid v1.0 — truthful state blocks (Phase 6)
// =====================================================================
// Empty states say WHAT is empty and WHY; error states carry the real
// failure detail from the API. Nothing here invents content or fills
// space with fake suggestions (product-design §7, data-truth rule).

import Link from 'next/link';

export function EmptyState({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <div className="state-block" role="status">
      <p className="state-block-title">{title}</p>
      <p className="state-block-detail">{detail}</p>
    </div>
  );
}

export function ErrorState({ title, error }: { readonly title: string; readonly error: Error }) {
  const apiCode = 'code' in error && typeof error.code === 'string' ? error.code : null;
  return (
    <div className="state-block state-block-error" role="alert">
      <p className="state-block-title">{title}</p>
      <p className="state-block-detail">{error.message}</p>
      {apiCode !== null ? (
        <p className="state-block-code">
          API error code: <code>{apiCode}</code>
        </p>
      ) : null}
      <p className="state-block-detail">
        The API process may not be running. Start the stack with <code>pnpm infra:up</code> and{' '}
        <code>pnpm dev</code>.
      </p>
    </div>
  );
}

export function NotFoundState({
  title,
  detail,
  backHref,
  backLabel,
}: {
  readonly title: string;
  readonly detail: string;
  readonly backHref: string;
  readonly backLabel: string;
}) {
  return (
    <div className="state-block" role="status">
      <p className="state-block-title">{title}</p>
      <p className="state-block-detail">{detail}</p>
      <p>
        <Link href={backHref as never}>{backLabel}</Link>
      </p>
    </div>
  );
}
