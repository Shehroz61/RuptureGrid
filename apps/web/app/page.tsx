// RuptureGrid v1.0 — Phase 1 foundation page.
// Deliberately minimal: no fake metrics, no dashboard, no product
// feature simulation (product-design.md §7, Phase 1 spec §41–42).

export default function HomePage() {
  return (
    <main>
      <p className="version">RuptureGrid v1.0</p>
      <h1>Break systems before users do.</h1>
      <p>
        This is the Phase 1 engineering foundation. Product workflows — controlled failure
        experiments, invariant verification, and forensic investigation — are not implemented yet.
      </p>
      <span className="status">FOUNDATION</span>
    </main>
  );
}
