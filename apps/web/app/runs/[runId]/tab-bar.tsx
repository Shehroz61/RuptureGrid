// RuptureGrid v1.0 — run detail tab bar (Phase 6).
// Preserves run context across the investigation views. The active tab
// is derived from the real URL pathname (client-side), so deep links,
// refreshes, and nested routes (e.g. a finding detail) mark the correct
// tab. aria-current marks the active view; the underline is styled from
// that attribute.

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Route } from 'next';

const TABS: ReadonlyArray<{ readonly segment: string; readonly label: string }> = [
  { segment: '', label: 'Overview' },
  { segment: 'execution', label: 'Execution' },
  { segment: 'findings', label: 'Findings' },
  { segment: 'timeline', label: 'Timeline' },
  { segment: 'evidence', label: 'Evidence' },
  { segment: 'reproduction', label: 'Reproduction' },
  { segment: 'comparison', label: 'Comparison' },
];

export function RunTabBar({ runId }: { readonly runId: string }) {
  const pathname = usePathname();
  const base = `/runs/${runId}`;
  const rest = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : '';
  const active = rest.split('/')[0] ?? '';

  return (
    <nav className="tab-bar" aria-label={`Run ${runId} views`}>
      {TABS.map((tab) => {
        const href = tab.segment === '' ? `/runs/${runId}` : `/runs/${runId}/${tab.segment}`;
        return (
          <Link
            key={tab.segment}
            href={href as Route}
            aria-current={tab.segment === active ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
