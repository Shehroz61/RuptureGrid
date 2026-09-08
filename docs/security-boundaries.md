# RuptureGrid v1.0 — Security Boundaries

Status: **Phase 0 — threat model and contracts only. No runtime implementation exists.**
Authoritative for: target authorization, destination/SSRF/DNS/redirect contracts, credential handling and redaction, blast-radius limits.

Related: [architecture.md](architecture.md) §5 (target ownership), [evidence-model.md](evidence-model.md) §5, ADR-0011, ADR-0012, [product-spec.md](product-spec.md) §8 (non-goals).

---

## 1. Security philosophy

- **Narrow by design.** A deliberately narrow secure target model is preferred over unsafe "support everything" behavior.
- **Deny by default.** Nothing is executable against a target that was not explicitly registered and authorized for the requested environment class.
- **Legitimate interfaces only.** Failures are created through the target's own APIs — never by secret mutation of target state ([architecture.md](architecture.md) §5).
- **Server-side enforcement.** UI validation is convenience, never a security control; every limit in this document is enforced in the Control Plane and re-checked in the executor.
- **Honest scoping.** Phase 0 documents contracts; it implements nothing. Each mitigation names the phase that must deliver it ([phase-roadmap.md](phase-roadmap.md)).

## 2. Target authorization model

- A **TargetSystem registration** binds: identity, allowed base origin(s) (scheme + host + port), environment classification (`local-development` | `staging` | `production`), credential references, declared sensitive fields, and permitted experiment classes.
- The executor may only issue requests whose **resolved, final** destination matches a registered origin of an authorized target.
- **Production fault targeting is DENIED in v1.** A `production`-classified target cannot receive experiment execution; denial is enforced in the Control Plane at run creation and re-checked by the executor before dispatch. Enabling production would require a future dedicated security architecture (separate approval chain, guardrails, kill switches) — explicitly out of scope now.
- Credentials are stored as **references to environment-provided secrets** (never values in the database), scoped per target, and resolved only inside the executor at request time (ADR-0012).

## 3. Destination validation contract (executor, pre-request)

Every request URL is validated against all of the following, in order:

1. **Scheme allowlist** — `https` always; `http` only for explicitly registered `local-development` targets.
2. **No userinfo** — URLs containing `user:pass@` components are rejected outright.
3. **Origin match** — scheme + host + port must equal a registered origin. Path is not part of the origin contract, but the registered origin list is the only permitted destination space.
4. **Absolute-form protection** — the request line and `Host` header are derived from the registered origin; absolute-URI injection or scheme-relative tricks (`//evil.example/`) cannot bypass origin matching because the comparison happens on the *parsed, normalized* URL.
5. **Host header pinning** — `Host` is set from the registered origin, never from user-supplied headers; header allowlist logic prevents header-injection smuggling (CRLF rejection at validation).

## 4. SSRF threat model (contract table)

Status legend: **C** = documented contract now, implementation phase named in the roadmap.

| Threat | Required protection | Status |
|---|---|---|
| Arbitrary destination URLs | Registered-origin allowlist; deny by default | C — Phase 3 |
| URL scheme abuse | Scheme allowlist (§3.1) | C — Phase 3 |
| Userinfo URLs | Rejected at validation | C — Phase 3 |
| Absolute URL injection | Parse-normalize-then-compare; never string prefix matching | C — Phase 3 |
| Scheme-relative URLs (`//host`) | Normalized parsing; origin equality required | C — Phase 3 |
| Redirects (open-redirect style) | Redirect policy (§6) | C — Phase 3 |
| Cross-origin redirects | Denied by default | C — Phase 3 |
| DNS rebinding | §5 | C — Phase 3 (primary control: network isolation) |
| Private IP ranges | Address-class validation at resolution + egress isolation | C — Phase 3 |
| Localhost / link-local / loopback | Denied except `local-development` targets | C — Phase 3 |
| Cloud metadata endpoints (`169.254.169.254` etc.) | Address-class denylist incl. link-local; unreachable by default via egress isolation | C — Phase 3 |
| IPv4 | Address validation | C — Phase 3 |
| IPv6 / IPv4-mapped IPv6 (`::ffff:127.0.0.1` style bypass) | Normalize before classification; classify the true address | C — Phase 3 |
| Unique-local / site-local IPv6 | Address-class validation | C — Phase 3 |
| Host header abuse | Host pinned from registered origin (§3.5) | C — Phase 3 |
| Authorization forwarding to third parties | Credentials never attached to non-registered origins; stripped on cross-origin redirect | C — Phase 3 |
| Cookie forwarding | Cookies are not a supported credential mechanism for targets in v1; if ever added, same rules as Authorization | C — deferred |
| Credential leakage into evidence | Redaction before persistence (§7) | C — Phase 4 |
| Request-size abuse | Server-side caps (§8) | C — Phase 3 |
| Response-size abuse | Streamed size caps; over-cap responses truncated with an explicit observation flag | C — Phase 3 |
| Timeout abuse | Server-side timeout caps (§8) | C — Phase 3 |
| Repeat abuse | Server-side repeat caps (§8) | C — Phase 3 |
| Concurrency abuse | Server-side concurrency caps (§8) | C — Phase 3 |
| Unbounded total run work | Per-run total work budget (requests, bytes, wall time) | C — Phase 3 |

## 5. DNS and destination security

SSRF protection must **not** be a string comparison. Required future design:

- **Resolve once, validate, pin**: the executor resolves the registered host, validates every returned address against address-class policy, and pins the connection to a validated address for the life of the request (custom resolver/lookup).
- **Address-class policy**: loopback, link-local, private (RFC 1918), unique-local (fc00::/7), and metadata ranges are denied unless the target is explicitly classified `local-development` (the Demo Target is exactly that, running in an isolated compose network).
- **Redirect-aware**: every redirect hop repeats the full validation (§6).
- **DNS rebinding — honest limitation**: resolve-validate-pin narrows the classic rebinding TOCTOU window but cannot eliminate it in all environments (a second resolution inside the HTTP stack, or attacker-controlled DNS at the boundary). Therefore the **primary control is network egress isolation**: executors and targets run in isolated networks (Docker Compose networks locally; comparable isolation in later deployments) so that even a validation failure has no route to protected destinations.
- **Private executor architecture**: in later deployment models, the execution agent runs *inside* the authorized environment (private-network agent), so broad egress from a central service is never required (ADR-0011).

## 6. Redirect policy

- Default: **deny all redirects** for mutating requests; allowlist same-origin redirects for read-only requests with a bounded hop count.
- Cross-origin redirects: denied by default. If ever allowed for a target, every hop re-validates scheme, origin, and address class, and credentials are **stripped** before following to a non-registered origin.
- Every redirect encounter (followed or denied) is a recorded observation.

## 7. Credentials and redaction

- **Redaction happens before durable persistence.** Credential headers (`Authorization`, `Cookie`, `Set-Cookie`), query-string credentials, and target-registered sensitive fields are removed/masked at capture, before any byte is stored in evidence or logs ([evidence-model.md](evidence-model.md) §5).
- A **secret registry** per target declares sensitive fields; anything matched is treated as secret. Unknown headers are kept (redacted only by denylist) — the trade-off is documented: **security wins over literal byte-for-byte reproduction**; replay is semantic, not byte-faithful, and credential *values* are resolved from the live environment at replay time anyway ([incident-replay.md](incident-replay.md) §4).
- Fingerprints (e.g., truncated hash) of secret *values* may be recorded for drift detection — fingerprints are not reversible and are not themselves secrets.
- Secrets never appear in: logs, error messages, timeline entries, AI inputs (ADR-0007), or snapshots ([incident-replay.md](incident-replay.md) §2).

## 8. Blast radius — server-side limits

Enforced at snapshot creation (Control Plane) and re-checked at execution (executor). Illustrative v1 ceilings (exact values configurable, never client-trusted):

| Limit | Enforcement point |
|---|---|
| Repeat count per step | snapshot creation + executor |
| Concurrency per step | snapshot creation + executor (semaphore) |
| Per-invocation timeout, per-step timeout, per-run wall time | snapshot creation + executor |
| Request body size | executor pre-send |
| Response body size | executor streaming cap |
| Total requests per run, total bytes per run | executor accounting against the run budget |
| Cancellation | cooperative cancel points + lease expiry; a cancel is an outcome, recorded (§8 of architecture) |
| Environment authorization | run creation (deny production) + executor pre-dispatch re-check |

## 9. Evidence and data access

- Evidence store is append-only at the application layer ([evidence-model.md](evidence-model.md) §4); access follows least privilege per context ([architecture.md](architecture.md) §4).
- v1 has a single-operator trust model (no multi-tenant RBAC — [product-spec.md](product-spec.md) §8); the design must not *prevent* adding authentication/tenancy later, but none is designed now.

## 10. Security review gate

Every implementation phase ends with a security review against this document (and [engineering-rules.md](engineering-rules.md) §1) before acceptance. A phase that touches execution, destinations, credentials, or evidence storage cannot be accepted with an unreviewed security delta.
