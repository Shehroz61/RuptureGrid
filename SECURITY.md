# Security Policy

## Supported surface (v1.0)

RuptureGrid v1.0 is a **local-first, source-available developer tool**.
The security model assumes:

- You run the stack on your own machine or an isolated environment you
  control (Docker Compose networks; see `.env.example`).
- Targets are **registered, authorized systems only**. RuptureGrid is not
  a scanning or attack tool and refuses unregistered destinations by
  construction.
- **Production and staging targets are denied for experiment execution in
  v1** (server-side denial at run creation and again in the executor).
  The Demo Fintech target is classified `LOCAL_DEVELOPMENT`.
- The Demo Target's non-production credentials in `.env.example` are
  placeholders for local development only — they are not secrets and must
  never be reused anywhere real.

Full model: [docs/security-boundaries.md](docs/security-boundaries.md),
[ADR-0011](docs/decisions/ADR-0011-target-security-model.md),
[ADR-0012](docs/decisions/ADR-0012-credential-handling-and-redaction.md).

## Honest limitations (read before deploying)

- **DNS rebinding (TOCTOU):** destination validation resolves and checks
  addresses before connecting, but a second, attacker-influenced
  resolution inside the HTTP stack cannot be fully excluded. The primary
  control is **network egress isolation** — run executors where they have
  no route to systems you care about.
- **Evidence integrity is detection, not prevention:** the hash-chained
  evidence log detects post-hoc modification by the application's
  writers; it is not tamper-proofing, and database records are logically
  append-only, not immutable.
- **Fault plans are LOCAL_DEVELOPMENT-only** and bounded server-side
  (max 10 triggers, 15-minute TTL, one active kind per document).

## Reporting a vulnerability

**Owner decision pending:** the public security contact (dedicated
mailbox or GitHub Security Advisories enablement) is a release decision
recorded in `docs/reports/phase-11-self-audit.md` §17 (owner
decisions). Until a public
repository exists, report findings directly to the maintainer through
the private channel agreed with the project owner.

Please include: affected component(s), reproduction steps, and — if you
can — a failing check against the real stack (the project's verifiers
are the accepted way to prove behavior). Do not open public issues for
unfixed vulnerabilities.

## What we will not accept as a vulnerability report

- "It can execute against a system I registered" — that is the product.
- The Demo Target's deliberate VULNERABLE mode credits a wallet twice —
  that is the flagship scenario, switched through the target's own admin
  API.
- Secrets in your own uncommitted `.env` — they never leave your machine.
