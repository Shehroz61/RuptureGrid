# RUPTUREGRID v1.0 — PHASE 10 SECURITY AUDIT

Session: Phase 10 audit (branch `phase-10-full-engineering-audit` from
`phase-9-accepted` = `e39cbfe`). Date: 2026-09-23. Every proof below was
executed in this session against the real stack; source citations are
line-verified reads, not recollections. All work uncommitted.

## 1. Verdict

**NO UNRESOLVED SECURITY FINDINGS.** No P0/P1/P2 security defects found.
One test-infrastructure defect class fixed (DEF-2 in the full audit) with
a security-relevant property explicitly preserved (global origin
uniqueness enforcement untouched).

## 2. SSRF / destination validation (§22–§25 of the brief)

Verified in `packages/engine/src/executor.ts`, `validate.ts`,
`target.ts`:

- **Arbitrary destinations:** impossible by construction — the URL is
  built ONLY from the snapshot's registered origin plus a validated
  relative path; absolute and scheme-relative forms cannot exist
  (`validateRelativePath` rejects `^https?://`, `//`, embedded/decoded
  schemes, `//` in the path portion, pseudo-schemes, leading `@`; a
  parse round-trip must keep the origin host). The executor RE-checks
  `url.origin === origin.origin` after construction.
- **Userinfo:** rejected at registration (`normalizeOrigin`) and cannot
  re-enter through paths.
- **Scheme policy:** https always; http only for LOCAL_DEVELOPMENT
  registrations (`registerTarget`).
- **Redirects:** `redirect: 'manual'` in the executor (a 3xx is an
  observation, never followed) AND in the worker fault-control fetch
  (3xx = failure; response origin must equal the registered origin).
  Grep across engine/worker/evidence/showcase/verifier clients: no
  helper relies on default automatic redirects. Read-only adapters
  (lineage/fault-status) target the frozen registered origin only.
- **Address classes:** `isDeniedAddress` denies loopback, RFC1918,
  link-local (169.254/16 incl. metadata), CGNAT 100.64/10, unique-local
  fc00::/7, IPv4-mapped IPv6 (recursive), NAT64 64:ff9b::/96, `::`,
  `::1`, and unparseable input (deny). `assertDestinationAllowed`
  resolve-once-validates all resolved addresses BEFORE any connection
  for non-local environments; the DNS-rebinding TOCTOU honesty
  limitation stands (egress isolation is the primary control) exactly
  as documented.
- **Host header pinning:** executor-owned from the origin; `host` in
  FORBIDDEN_HEADER_NAMES; CR/LF/NUL rejected in paths and headers.
- **Credentials forwarding:** only `Bearer ${credential.<REF>}` parses;
  values resolved at request time inside the executor; Authorization
  header values are removed from evidence (REDACTED_HEADERS); no cookie
  mechanism exists.

Attack results: no bypass found. The accepted Phase 3 security probe
suites re-ran green in every full integration pass.

## 3. Target origin registration (§23)

- Global origin uniqueness enforced in-transaction (`target_origin.origin`
  unique + pre-check with an explicit, safe error). NOT weakened in the
  Phase 10 test fix — the fix changed only how TESTS generate candidate
  origins (random + authoritative non-registration check before use).
- Duplicate registration (same displayName) refused; duplicate origins
  within one request refused; path/query/fragment/credentials in an
  origin refused; mixed case normalized; default ports preserved
  explicitly; IPv6 literal form accepted through URL parsing and stored
  bracket-free lowercased; trailing slash → pathname `/` accepted,
  deeper paths refused.
- Same origin, different environment class: impossible — the origin is
  globally unique, so its environment is unambiguous.

## 4. Secrets and redaction (§34, §35, §97, §110, §150)

- Redaction happens BEFORE hashing/persistence
  (`redactBoundedText` redacts the FULL raw text first, then bounds the
  redacted representation — a secret after a large prefix cannot
  survive truncation; Phase 4's corrected property re-verified in
  source this session).
- Header removal list (Authorization, Cookie, Set-Cookie,
  proxy-authorization, provider-signature) + name-pattern deep masking
  + value-shape masking (bearer/JWT/URL-credentials) regardless of key.
- Snapshots and reproduction definitions carry credential REFERENCE
  names only (schema-verified; no value path exists).
- Canary scans (final): durable Control DB stores — 0 hits;
  verifier-internal 10-store canary scan — 0 leaks (both final golden
  runs); showcase manifest/sidecars — reference-form names only;
  `.env` untracked; `.env.example` placeholders only.
- Logging: structured logger masks sensitive keys and credential-URL
  strings pre-emission; telemetry carries correlation IDs only
  (unit-asserted).

## 5. HMAC / signatures (§58, §59)

- Provider authenticity = HMAC-SHA256 over the EXACT raw request bytes;
  raw-body capture is bound to the single JSON parser that supplies it
  (second-parser skip hazard avoided by design). Re-serialization,
  field reordering, and whitespace changes break the signature
  (accepted suites re-run green).
- Verification returns false (never throws) for malformed hex, odd
  length, and length mismatch; comparison uses `timingSafeEqual` over
  fixed-length SHA-256 digests of the two strings — equal-length
  cryptographic material compared in constant time, unequal-length
  inputs safe because the digest length is constant.
- Demo admin/inspection boundaries: distinct `requireBearerToken`
  middlewares; wrong-role tokens refused (proven by the accepted
  suites); tokens never logged or echoed.

## 6. Controlled-fault safety (§29, §30)

- Definition gate + execution-time re-derivation (LOCAL_DEVELOPMENT
  only, `/webhooks/provider` only, MUTATING only, one faultKind per
  document) — both layers verified in source; unit refusals green.
- Activation = atomic conditional UPDATE with DB CHECK bounds; TTL
  15 min lazy-expired; disarm best-effort AFTER the terminal write;
  arming failure fails the step BEFORE any delivery (KNOWN_ABSENT).
- No arbitrary-URL faulting path exists: the arm/disarm URLs are
  derived exclusively from the frozen snapshot origin + fixed Demo
  admin routes; the engine never sees a URL.
- Trigger atomicity under concurrency: exactly one activation at
  maxTriggers=1 (real-concurrency suites green; this session's final
  controlled-faults runs re-proved 80/80 twice).

## 7. Input bounds, XSS, log injection, JSON safety (§55, §121, §127, §128, §129)

- API pagination bounds (1..200) and cursor validation (closed enum
  lists BEFORE raw SQL; parameterized tuple comparison; malformed
  cursor ⇒ 400). `$queryRawUnsafe` strings contain no user data — the
  only two production uses bind parameters (`forensics.controller.ts`
  timeline; `incident-zero/src/cli.ts` canary scanner with
  compile-time constant table/column names).
- Web app: no `dangerouslySetInnerHTML` anywhere; no `NEXT_PUBLIC_*`;
  every page `force-dynamic`; server-side fetch only (no browser DB
  access); hostile strings render React-escaped; the final showcase +
  browser suites recorded zero console/hydration errors over real
  fault-tainted data.
- JSON serialization: BigInt fencing tokens serialized as decimal
  strings at the API boundary (`runStatus`); canonicalization rejects
  non-JSON values rather than coercing (`canonicalize.ts`); money is
  bigint in the Demo and exact decimal strings on HTTP.

## 8. Filesystem / process safety (§62, §75, §112)

- Showcase output-path safety: refuses directories inside the repo
  outside `.artifacts/`; stale-video removal scoped to the session
  output dir; owned-process-by-PID management; refuses unknown
  listeners (proves the API serves THIS session's run IDs before
  capture).
- Destructive-command scan: no `rm -rf`/`taskkill`/`DROP` in tracked
  source; migration SQL contains no destructive statements; Demo reset
  deletes only the Demo's own business rows inside the target's own
  admin API (target-owned surface, by design and documented).
- The only scratch cleanup performed by this audit was of
  auditor-created artifacts (temp DBs, logs, `.artifacts/showcase`,
  an empty stale Playwright temp profile) — nothing else was deleted.

## 9. Findings summary

| ID | Severity | Area | Status |
|---|---|---|---|
| DEF-2 | P1 (test-infra) | test-origin generation collisions | FIXED (security property preserved) |
| — | P0/P1/P2 | production security surfaces | NONE FOUND |

Security blockers = NONE. Phase 10 security result: **PASS**.
