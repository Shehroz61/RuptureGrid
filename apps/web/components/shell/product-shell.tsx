// =====================================================================
// RuptureGrid v1.0 — product shell (Phase 6)
// =====================================================================
// Desktop investigation workstation: left navigation + main workspace.
// The shell renders NO data — it is structure only. Navigation labels
// name real backend surfaces (runs, experiments, findings); there are
// no decorative destinations. Active section is communicated by
// background + border, never color alone (aria-current is set).
// Styling lives in globals.css (server-component safe).

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Route } from 'next';
import { NavLinks } from './nav-links';

const NAV_ITEMS: ReadonlyArray<{ readonly href: Route; readonly label: string }> = [
  { href: '/runs', label: 'Runs' },
  { href: '/experiments', label: 'Experiments' },
  { href: '/findings', label: 'Findings' },
];

export function ProductShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="shell">
      <header className="shell-header">
        <Link href="/" className="shell-brand" aria-label="RuptureGrid home">
          <span className="shell-brand-mark" aria-hidden="true" />
          <span className="shell-brand-text">
            RuptureGrid <span className="shell-brand-version">v1.0</span>
          </span>
        </Link>
        <p className="shell-tagline">Business-correctness forensics</p>
      </header>
      <div className="shell-body">
        <nav className="shell-rail" aria-label="Primary">
          <NavLinks items={NAV_ITEMS} />
          <p className="shell-rail-note">
            Every value in this application comes from real runs against real targets.
          </p>
        </nav>
        <main className="shell-main" id="main-content">
          {children}
        </main>
      </div>
    </div>
  );
}
