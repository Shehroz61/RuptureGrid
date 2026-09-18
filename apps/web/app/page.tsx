import { redirect } from 'next/navigation';

// RuptureGrid v1.0 — Phase 6: the product opens on the run list, the
// investigator's entry point. The Phase 1 foundation placeholder page
// is retired (its content described absent product features).
export default function HomePage() {
  redirect('/runs');
}
