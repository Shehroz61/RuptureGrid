// RuptureGrid v1.0 — page scaffolding (Phase 6).
// Every page states the engineering question it answers
// (docs/product-design.md §3): if a screen cannot state its question,
// it is decoration.

import Link from 'next/link';

export function PageHeader({
  question,
  title,
  meta,
  breadcrumb,
}: {
  readonly question: string;
  readonly title: string;
  readonly meta?: React.ReactNode;
  readonly breadcrumb?: ReadonlyArray<{ readonly href: string; readonly label: string }>;
}) {
  return (
    <header className="page-header">
      {breadcrumb !== undefined && breadcrumb.length > 0 ? (
        <nav className="breadcrumb" aria-label="Breadcrumb">
          {breadcrumb.map((crumb, index) => (
            <span key={`${crumb.href}-${index}`} className="breadcrumb-item">
              {index > 0 ? <span className="breadcrumb-sep">/</span> : null}
              <Link href={crumb.href as never}>{crumb.label}</Link>
            </span>
          ))}
        </nav>
      ) : null}
      <p className="page-question">{question}</p>
      <h1 className="page-title">{title}</h1>
      {meta !== undefined ? <div className="page-meta">{meta}</div> : null}
    </header>
  );
}

export function Section({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">{title}</h2>
        {description !== undefined ? <p className="section-description">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
