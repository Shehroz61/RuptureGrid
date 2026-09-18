'use client';

// =====================================================================
// RuptureGrid v1.0 — active-section navigation (Phase 6)
// =====================================================================
// usePathname is inherently client-side; this is the only client
// component in the shell. aria-current='page' is the accessible active
// marker; the visual active state (background + border) is styled from
// that attribute so state is never color-alone.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Route } from 'next';

export interface NavItem {
  readonly href: Route;
  readonly label: string;
}

export function NavLinks({ items }: { readonly items: ReadonlyArray<NavItem> }) {
  const pathname = usePathname();
  return (
    <ul>
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={active ? 'nav-active' : undefined}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
