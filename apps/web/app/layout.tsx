import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ProductShell } from '@/components/shell/product-shell';
import './globals.css';

export const metadata: Metadata = {
  title: 'RuptureGrid v1.0',
  description:
    'RuptureGrid — did the system remain business-correct when realistic distributed-system failures occurred?',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ProductShell>{children}</ProductShell>
      </body>
    </html>
  );
}
