# RUPTUREGRID v1.0 — PHASE 8 INDEPENDENT AUDIT

Auditor: independent principal engineer (not the Phase 8 builder)
Date: 2026-09-21
Branch audited: `phase-8-showcase-automation` (Phase 8 fully uncommitted at audit time)
Baseline: annotated tag `phase-7-accepted` → peeled commit `a98e033ed4b36d8a9360e0a8b8158690ef2b81a1`
Audit corrections referenced below: [phase-8-audit-corrections.md](phase-8-audit-corrections.md)
Builder's own pre-audit self-audit: [phase-8-self-audit.md](phase-8-self-audit.md) (historical, unchanged)

## 1. Verdict
PHASE 8 ACCEPTED

## 2. Repository / Git
path = `E:\RuptureGrid-v1.0`
branch = `phase-8-showcase-automation`
phase-7 baseline = `a98e033ed4b36d8a9360e0a8b8158690ef2b81a1` (annotated tag `phase-7-accepted`, tag object `5092ee1…`, peeled mechanically via `git rev-parse phase-7-accepted^{commit}`; merge-base HEAD = a98e033)
Phase 8 committed = NO (fully uncommitted by phase-boundary design; no `phase-8-accepted` tag exists)
complete diff inspected = YES — every changed/new file read in full; corrected files re-read after fixes
baseline preserved = YES (`git diff phase-7-accepted --name-only` contains ONLY Phase 8 files; migrations, demo-db, engine, evidence, forensics, incident-zero, apps/* all empty diffs)

## 3. Phase Boundary
showcase automation = capture/presentation only (`packages/showcase/`, one root script, docs, tests)
business truth changes = NONE (migration, demo-schema, engine, evidence, forensics, incident-zero and UI guards all empty; no capture-only UI hacks — `SHOWCASE|CAPTURE|DEMO_MODE|HIDE_` search across `apps/**` clean)
Phase 9 = absent (no observability, no new faults/invariants)
AI = absent
result = presentation-only confirmed

## 4. Golden Verifier Integration
actual invocation = `node packages/incident-zero/dist/cli.js --json` (exact spawn, cwd = repo root, owned child, bounded timeout, SIGTERM on timeout) — the execution step of `incident-zero:verify`; manifest records the exact spawned command
structured source = verifier's own JSON report (shape checked against `packages/incident-zero/src/cli.ts`; no CLI-prose scraping anywhere)
verifier exit handling = exit ≠ 0 → `VerifierFailureError` → classified refusal, zero artifacts (mechanically proven §15: exit 2, 0 files)
fresh run binding = run/payment/finding IDs only from this invocation's report; finding UUID resolved from the durable row the verifier just asserted (refuses to invent); no "latest run in database" fallback
duplicate truth logic = NONE — no second Incident Zero runner, no invariant re-implementation
result = PASS

## 5. Fresh Showcase Session
session ID/path = auditor session A → `.artifacts/auditor-s1/` (six auditor sessions total: A, B, C, D, final, final2 — final2 retained for review)
phase7 commit = `a98e033ed4b36d8a9360e0a8b8158690ef2b81a1` (peeled — verified against `git rev-parse phase-7-accepted^{commit}`, not the tag object)
scenario version = `v1` (from `GOLDEN_SCENARIO_VERSION` import, matches report)
vulnerable run = `c12d4a76-095b-4b88-9a18-641858f80edb`, payment `pp-f53151320a9c18a1e5e47c283f15cb3f`, COMPLETED / INV-IZ-1 FAIL
secure run = `460e0456-4380-4e70-8ea1-e62d57661275`, payment `pp-ac37f90a…`, COMPLETED / INV-IZ-1 PASS
finding = `2a2228bd-3cdb-4632-b041-7bbd478bf869` (resolved from the durable row; route-bound)
result = PASS

## 6. Stale Artifact Defense
old session present = YES — session B's output dir pre-seeded with all of session A's PNGs, sidecar, and manifest before the run
new run IDs = B vulnerable `5a7fa3d2-…`, secure `082a1fe6-…`, finding `d2cd0e23-…` — all different from A
old IDs in new manifest = NONE
old PNG reuse = NONE — all 10 B PNGs hash-differ from the pre-seeded A files; every B hash matches B's manifest only
old video-frame reuse = NONE — video sources enumerated from this session's `artifacts` array only (missing file = hard error); frame 0.5s shows B's run IDs; post-correction (C1) a stale MP4 is removed at session start
result = PASS

## 7. Capture Plan
required captures = 10 (runs index; vulnerable: overview/finding/timeline/evidence/reproduction; secure: overview/timeline/evidence/reproduction) — pinned by `capture-plan.test.ts`
actual captures = 10/10 every session
viewport = 1440×900, deviceScaleFactor 1 (IHDR-verified independently + ffprobe cross-check on samples)
result = PASS

## 8. Vulnerable Screenshots
overview = run `c12d4a76…` COMPLETED + INV-IZ-1 **FAIL** distinctly shown; subject `pp-f5315132…`
finding = reason `DUPLICATE_EQUIVALENT_FINANCIAL_EFFECT`, subject `pp-f5315132…`, `PKR 5,000.00` (500000 minor units), `equivalentEffectCount 2`, basis `lineage-complete`, evaluator `identity-chain/v1` — zoom-inspected
timeline = real timeline page, `order: sequence` / `order: wall-clock` bases visible, fresh run-bound
evidence = integrity chain intact, 25 observations, honest wording ("detects post-hoc modification… is not tamper-proofing or guaranteed non-repudiation")
reproduction = snapshot `f3485caa…` bound, credential **names only**, `Bearer ${credential.…}` templates — no values
runs index = both fresh shortened IDs (product's exact `shortenId(id, 10)` rule, confirmed against `apps/web/lib/semantics.ts`)
fresh-run binding = every route carries this session's exact IDs
result = PASS

## 9. Secure Screenshots
overview = run `460e0456…` COMPLETED + INV-IZ-1 **PASS**, "0 FAIL · 1 PASS · 0 NOT_EVALUABLE"
timeline = same canonical 20-delivery pressure, real ordering bases
evidence = suppressed duplicate attempts recorded as observations, chain intact
reproduction = SECURE requirement shown, credential names only
fresh-run binding = verified
result = PASS

## 10. PNG Validation
count = 10/10
signature = 8-byte PNG signature present (independent parser)
dimensions = 1440×900 all (independent IHDR read + ffprobe cross-check)
hashes = SHA-256 recomputed externally — all match manifest AND per-artifact sidecar; one-bit-flip test changes the hash; post-C3 the session gate rejects any mismatch
corruption rejection = validated (unit tests + external probe)
result = PASS

## 11. Manual Screenshot Review
wrong pages = none (contact-sheet visual review of all 10 + zoom crops of finding/evidence/reproduction)
blank/loading/error = none
critical clipping = none
secret exposure = none (values nowhere; credential names only)
visual truth = pages match live product rendering; no edited UI values possible (zero web diffs)
result = PASS

## 12. Artifact Manifest
phase7 commit = peeled commit SHA, correct
scenario = `v1`
run IDs = verifier-derived, fresh per session
routes = exact, ID-bound
hashes = correct, now also enforced in-session (C3)
verifier report = full report embedded; audited field-by-field — assertion actuals are counts/states/IDs only; the frozen intent's credential-REF templates (e.g. `Bearer ${credential.DEMO_ADMIN_TOKEN}`) are names, never values; Phase 7 assertions are numeric/identity facts by design, so future growth does not add credential exposure
secret values = none (external scans for `password|DATABASE_URL|postgres://|redis://|Authorization|Bearer <value>` across manifests, sidecars, logs, stdout/stderr captures, video composition files, filenames)
result = PASS

## 13. Video
implemented = YES (`--video`), ffprobe-verified independently
codec = H.264 (High profile)
pixel format = yuv420p
resolution = 1920×1080
duration = exactly 10.000000s, 100 frames @10fps (independent ffprobe, not manifest-read)
source screenshots = exactly this session's 10, enumerated from session artifacts (no globs, no "latest directory")
same-session binding = verified visually (frames carry the session's own run IDs)
result = PASS

## 14. Video Tail / Final Slide
concat implementation = final file appended without a duration directive (correct concat-demuxer workaround)
frame at ~9.0s = closing slide held, overlay rendered
frame at ~9.5s = held
frame at ~9.9s = held (extracted + visually inspected)
result = PASS

## 15. Video Overlay Truth
contract-derived facts = delivery/attempt counts from imported canonical contract constants (no literal `20` in source)
observed facts = run state + verdicts transcribed from verifier-report actuals (C2 closed the last literal-verdict path; regression test pins the derivation)
hard-coded runtime values = none (searches for 20/2/1/FAIL/PASS/1000000/500000/149/146 in overlay code: only contract imports and session fields)
incorrect claims = none; chronology is presentation order, no implied causality
result = PASS

## 16. Manual Video Review
blank frames = none
stale run = none
wrong verdict = none
readability = overlays legible
chronology = honest (vulnerable → secure narrative, no causal arrows)
secret exposure = none
result = PASS

## 17. Browser Runtime
browser executable = real Chromium-family browser via Playwright channel cascade (system Edge → system Chrome → bundled Chromium), headless, owned temporary profile inside the session output tree
console = no serious page errors observed during capture
page errors = none surfaced
network = pages served by owned API/web on 127.0.0.1
hydration = content gates waited on rendered DOM; no skeleton states captured
result = PASS

## 18. Browser Portability
Edge = first in cascade (code path)
Chrome = second (code path)
bundled Chromium = final fallback (code path); not exercised live on this machine (a system browser won every launch) — honestly noted
clean-install requirement = documented: `pnpm install` does NOT download browsers; bundled fallback needs `pnpm exec playwright install chromium` (stated in `docs/showcase.md`)
docs = accurate
result = PASS

## 19. Process Ownership
API = owned child, exact PID, SIGTERM → SIGKILL after grace
Web = owned child, exact PID
Verifier children = the verifier manages its own children (Phase 7 model untouched); showcase owns only the verifier process
browser = owned handle + owned temp profile
success cleanup = verified (no listeners on showcase ports, no profiles left)
failure cleanup = verified (readiness-timeout and port-conflict runs left no leftovers)
hard-kill orphan defense = §57 bind-probe gate proven mechanically: a squatting listener on the API port → exit 2, "refusing to capture against an unknown service", 0 artifacts. Note: in this console environment `kill -9` of the parent tore down the whole job tree, so true orphans could not be preserved; the equivalent threat (unknown listener on a showcase port) is refused
result = PASS

## 20. Output Safety
output root = `.artifacts/` default; explicit paths supported
normalization = `resolve()` collapses traversal spellings before checks (C4)
traversal = refused for repository-inside targets
repository-root protection = `.`, `packages`, `.git`, `packages/showcase/src` refused with exit 1 before any write; `..` fails safely at the drive root (EPERM, nothing written)
junction/symlink safety = documented model: cleanup operates only on the exact session output directory and exact canonical filenames; containment guard + no-pattern removal bound the blast radius
cleanup ownership = stale-video removal is exact-filename only (unit-proven it never touches other files)
result = PASS

## 21. Options
default = no video, exit 0
`--video` = generated + ffprobe-validated + manifest agrees
`--no-video` = skipped, manifest `video: null`, stale MP4 removed (C1)
`--screenshots-only` = alias verified, honest skipped status
`--output path` = works
`--output=path` = works (both forms live-tested)
`--json` = valid JSON only on stdout; diagnostics on stderr
result = PASS

## 22. Failure Behavior
verifier failure = exit 2, classified, 0 files (mechanically proven)
content-gate failure = capture aborts with `CaptureError`, exit 1, classified (gate mechanics unit-pinned; gates held on all real sessions)
port conflict = exit 2 classified, 0 files (live impostor test)
timeout = exit 3 classified (API readiness timeout observed live)
video failure = validation problems → `validation.pass = false` → exit 1; post-C5 truncated/corrupt video fails validation
partial artifact handling = no successful final manifest on failure
result = PASS

## 23. Security
canary = live canary secret carried through every golden session; 0 hits in manifests, sidecars, logs, stdout/stderr captures, video composition files, filenames
manifest = no credential values, no DB URLs, no tokens
logs = clean
screenshots = clean (manual review; names only)
video = clean (frame review)
credential refs vs values = refs only, everywhere
result = PASS

## 24. Repeatability
auditor showcase runs = 6 full sessions + standalone verifier runs
first V/S IDs = `c12d4a76…` / `460e0456…`
second V/S IDs = `5a7fa3d2…` / `082a1fe6…` (four further distinct pairs)
artifact plan stable = identical 10 filenames/routes/order every session
stale contamination = none (§6 evidence)
result = PASS

## 25. Phase 7 Preservation
incident-zero source = zero diffs vs baseline
incident-zero verifier = green after all Phase 8 changes (exit 0, all assertions pass, fresh run IDs)
golden assertions = untouched
result = PASS

## 26. Tests
Phase 8 unit files = 5 (capture-plan, verifier, validate, video, output-safety)
Phase 8 unit tests = 36 (24 builder + 12 auditor regression tests)
Phase 8 integration = 1 file / 1 test — real golden execution + real web UI + real PNG capture + real PNG validation
workspace unit = 264/264
workspace integration = 136/136 — including `execution-mechanics`, which passed in-suite this run
real browser = yes
real PNG = yes
real video = yes (decode-gated, C5)
result = PASS

## 27. Prior Phase Regression
Phase 1 = green
Phase 2 = green
Phase 3 = green (`execution-mechanics` passed in-suite)
Phase 4 = green
Phase 5 = green
Phase 6 = green (zero UI diffs)
Phase 7 = green (golden verifier exit 0)
result = PASS

## 28. Quality Gates
format = pass
lint = pass
typecheck = pass
unit = 264/264
integration = 136/136
build = pass
verify = pass
incident-zero verifier = pass
showcase no-video = pass
showcase video = pass

## 29. Dependencies
playwright = production dependency of the showcase CLI (runtime browser automation — justified; rationale documented); also a root devDependency for the integration suite
browser binaries = NOT auto-installed; documented `pnpm exec playwright install chromium` requirement for the bundled fallback
ffmpeg-static = production dep, binary present and executing after `pnpm install` (build approved via pnpm-workspace allowBuilds)
ffprobe-static = production dep, binary present and executing (`.d.ts` shim for its CJS shape)
other = lockfile additions limited to showcase tooling + transitive deps — reviewed, explained
result = PASS

## 30. Builder Defect Verification
1. NaN timeout → unbounded waits — VERIFIED (positive-integer validation in place)
2. `/runs` full-ID gate — VERIFIED (gate uses the product's exact `shortenId(id, 10)` rule)
3. evidence-page prose gate — VERIFIED (gates on stable rendered semantic content, visually confirmed)
4. annotated tag object vs commit SHA — VERIFIED (`^{commit}` peeling; manifests record the peeled commit)
5. hard-coded verdicts/run state — VERIFIED (transcribed from report actuals with refusal; C2 closed the residual overlay literal)
6. overstated verifier command string — VERIFIED (manifest records the exact spawn; mapping documented)
7. dead `skipVerifier` — VERIFIED (rejected as unknown argument)
8. broken `--output=` form — VERIFIED (both forms live-tested)
9. phantom §57 gate — VERIFIED (bind-probe + exit-2 classification; proven live against a squatting listener)
10. hard-coded overlay count — VERIFIED (overlay counts from imported contract constants)
11. latent package-root type import — VERIFIED (pinned restatement; bridge tests import it)
12. one-frame closing slide — VERIFIED (final file appended without duration directive; tail frames held)

## 31. Auditor Corrections
FILE = `packages/showcase/src/output-safety.ts` (new) + `orchestrator.ts` + `video.ts` + `validate.ts` + tests + `docs/showcase.md`
DEFECT = five defects found and fixed, each regression-tested and re-run against fresh real golden sessions (full detail: [phase-8-audit-corrections.md](phase-8-audit-corrections.md)):
- **C1** — no-video session left an earlier session's MP4 in the active output dir → `removeStaleVideo` at session start; live-verified
- **C2** — video overlay verdicts were literals, not `story.verdict` → now transcribed; regression test proves the derivation
- **C3** — session validation never recomputed artifact SHA-256 → hash gate added; swapped-file test fails as required
- **C4** — `--output` could target repository sources (incl. repo root) → containment guard refuses repo-inside paths outside `.artifacts/`; live-probed against `.`, `..`, `packages`, `.git`, src
- **C5** — half-truncated faststart MP4 passed video validation (moov-at-front probes clean while frames are missing) → full ffmpeg decode pass added; truncated copy rejected, intact video passes
WHY = stale-output honesty, overlay truth (R-02), artifact identity, output safety, validator honesty (R-03)
CHANGE = as above; all re-verified end to end on fresh sessions

## 32. Report Truth Audit
result = builder's self-audit claims verified accurate in all 12 defect accounts, all quality-gate numbers, and the honest remaining-risks list; one stale comment corrected; docs now state the browser-install requirement explicitly
incorrect claims = none remaining

## 33. Remaining Risks
Non-blocking:
- Per-artifact browser channel is not recorded (machine-dependent pixels across environments; within-session deterministic) — cosmetic provenance gap.
- True hard-kill orphans could not be preserved in this console environment (job teardown killed the tree); the §57 impostor-refusal path is proven, and Job-Object kill-on-close remains future hardening.
- `execution-mechanics` had a documented historical full-suite flake; it passed in-suite (136/136) and standalone in this audit — monitor, no action.
- Bundled-Chromium fallback branch not exercised live (a system browser won every launch); its failure path is explicit and documented.
- A no-font environment would fail video rendering loudly (ffmpeg error → session failure) — acceptable, documented behavior.

## 34. Phase Preservation
accepted migrations = untouched
Demo schema = untouched
engine = untouched
evidence/invariants = untouched
forensics = untouched
product UI = untouched
golden scenario = untouched; verifier remains the single truth engine
result = PRESERVED

## 35. Git
branch = `phase-8-showcase-automation`
modified = `.gitignore`, `README.md`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`
new = showcase package sources/tests, docs (incl. this report and the corrections/self-audit reports), integration test
generated artifacts staged = NONE (`.artifacts/` ignored; `git status` clean of media)
git diff --check = clean
commit = NO
tag = NO
push = NO

## 36. Acceptance Blockers
NONE
