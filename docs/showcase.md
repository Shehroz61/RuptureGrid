# Showcasing RuptureGrid — Phase 8

The showcase **presents** the accepted Incident Zero system; it never
manufactures truth. There is no showcase-specific business logic, no second
invariant checker, no demo page: every captured pixel comes from the real
Phase 6 product UI rendering real data produced by the accepted runtime
(`docs/incident-zero.md`, `docs/evidence-model.md`).

## One command

```
pnpm showcase:generate
```

What one run does, in order:

1. **Prerequisites** — validates environment configuration and Control-DB
   reachability (real PostgreSQL).
2. **Golden verifier first** — runs the canonical Phase 7 verifier's
   machine-readable mode (`node packages/incident-zero/dist/cli.js --json`,
   the execution step of the `incident-zero:verify` script). Its
   machine-readable report is the *only* source of run IDs, payment IDs,
   finding ID, snapshot hashes, verdicts, and counts. If the verifier exits
   non-zero, the showcase **stops** — no artifacts are produced from partial
   truth.
3. **Owned services** — starts the production Control-Plane API and web UI on
   dedicated showcase ports (default API 3231, web 3232; override with
   `SHOWCASE_API_PORT` / `SHOWCASE_WEB_PORT`). Ports are probed first; a
   conflict fails clearly rather than talking to an unknown process, and the
   API must then prove it serves *this session's* verifier-created runs
   before any capture. Every spawned process is recorded by PID and only
   owned processes are stopped.
4. **Real browser capture** — Playwright drives a real Chromium-family
   browser (system Edge → system Chrome → bundled Chromium, first that
   launches) through the live UI in an owned temporary profile, at a
   deterministic 1440×900 viewport, deviceScaleFactor 1.
5. **Content-gated screenshots** — each planned capture navigates its exact
   route and waits (bounded, no fixed sleeps) for content bound to *this
   session's* identifiers before saving: the run's own ID, its execution
   state, its verdict, the Finding, the invariant key. Assertions run against
   the rendered DOM; a blank, wrong, or partially loaded page aborts the run
   with a non-zero exit instead of saving a misleading image.
6. **Provenance** — every screenshot gets a sidecar entry (filename, runId,
   route, capturedAt, viewport, deviceScaleFactor, sourceVerdict, sha256)
   and the session gets a manifest whose identifiers come only from the
   verifier report. No credentials, tokens, or database URLs are ever
   written to manifests, sidecars, or logs.
7. **Validation** — PNGs are checked by signature, IHDR dimensions, and
   expected size; the optional video is probed with ffprobe (codec,
   resolution, duration, decodability). Any problem fails the command.
8. **Cleanup** — owned processes stopped, owned browser profile deleted.

## Options

| Option                | Effect                                              |
| --------------------- | --------------------------------------------------- |
| `--output <dir>`      | Write artifacts to an explicit directory (refused if inside the repository but outside `.artifacts/`) |
| `--video`             | Also compose the walkthrough video                  |
| `--no-video`          | Explicitly skip the video (default)                 |
| `--screenshots-only`  | Alias of `--no-video`                               |
| `--json`              | Print the full session manifest as JSON             |

Output defaults to `.artifacts/showcase/` (git-ignored). Generated
screenshots, videos, manifests, and logs are never committed. A session
that does not generate the video removes any MP4 left in the output
directory by an earlier session, so the directory never contains a
stale video alongside a fresh manifest.

## The captured story

Ten screenshots, in narrative order (stable semantic filenames, never
run-ID-based):

| File                          | Route                                     | Shows                                                       |
| ----------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `00-runs-index.png`           | `/runs`                                   | Both real runs listed                                        |
| `01-vulnerable-overview.png`  | `/runs/<vulnerable>/`                     | COMPLETED execution, INV-IZ-1 **FAIL**, wallet PKR 1,000,000.00 |
| `02-vulnerable-finding.png`   | `/runs/<vulnerable>/findings/<findingId>` | The deterministic Finding, subject payment, both equivalent effects |
| `03-vulnerable-timeline.png`  | `/runs/<vulnerable>/timeline`             | 20 deliveries / 20 attempts, honest ordering bases           |
| `04-vulnerable-evidence.png`  | `/runs/<vulnerable>/evidence`             | Chain integrity ("intact"), REDACTED raw observations        |
| `05-vulnerable-reproduction.png` | `/runs/<vulnerable>/reproduction`      | Snapshot-bound reproduction; credential names only           |
| `06-secure-overview.png`      | `/runs/<secure>/`                         | COMPLETED execution, INV-IZ-1 **PASS**, wallet PKR 500,000.00 |
| `07-secure-timeline.png`      | `/runs/<secure>/timeline`                 | Same 20-delivery pressure recorded honestly                  |
| `08-secure-evidence.png`      | `/runs/<secure>/evidence`                 | Suppressed attempts remain recorded as observations          |
| `09-secure-reproduction.png`  | `/runs/<secure>/reproduction`             | SECURE-mode reproduction definition                          |

The contrast is the point: **same physical pressure, different business
outcome** — transport success is not business correctness.

## The video

`--video` composes a silent 1920×1080 H.264 walkthrough (`showcase-walkthrough.mp4`,
one second per slide, ffprobe-verified, ffmpeg-static) from *exactly this session's*
screenshots, each letterboxed onto the video canvas. Overlays are factual text derived from the verified session
(e.g. "VULNERABLE — execution COMPLETED, INV-IZ-1 FAIL") — no hype, no
narration, no fake terminal output, no fake typing.

## Troubleshooting

- **"showcase port … already in use"** — another process (often leftover
  children of an earlier session that was hard-killed) holds a showcase
  port. Identify it (`netstat -ano | findstr :3231` on Windows, then match
  the PID's command line) and stop that specific process, or select free
  ports via `SHOWCASE_API_PORT` / `SHOWCASE_WEB_PORT`. The showcase never
  captures against an unknown listener.
- **"refusing output directory inside the repository"** — the output
  directory must live under `.artifacts/` or outside the repository
  entirely; the showcase never writes or cleans repository source
directories.

## Output structure

```
.artifacts/showcase/
  00-runs-index.png … 09-secure-reproduction.png
  artifacts-metadata.json     # per-artifact provenance sidecar
  showcase-manifest.json      # session manifest (verifier-derived truth)
  showcase-walkthrough.mp4    # only with --video
```

## Dependencies

The showcase CLI declares `playwright`, `ffmpeg-static`, and
`ffprobe-static` as **production dependencies** because the CLI performs
browser automation and video encoding at runtime (not at development
time). The browser executable is resolved at launch in order: system
Edge → system Chrome → Playwright's bundled Chromium; if none is
available, run `pnpm exec playwright install chromium` (the repository
does not download browser binaries during `pnpm install`). The FFmpeg
and ffprobe binaries ship inside their packages — no global install and
no runtime download is required.

## Tests

- Unit (`packages/showcase/src/*.test.ts`): capture-plan stability (exact
  artifact set, filenames, routes, assertions), PNG validation, overlay
  truthfulness, verifier-output parsing and failure classification.
- Integration (`tests/integration/showcase-browser.test.ts`): a real browser
  opens real product pages and captures a real PNG — no mocked page as
  acceptance proof.

## Honest limits

- Screenshots record file identity (sha256), not truth; truth lives in the
  Control Plane database and the verifier report.
- The video is a composition of real screenshots, not live footage; it is
  labeled as such in the manifest (`generatedBy`).
- Run IDs and timestamps differ between runs by design; the artifact plan,
  filenames, and narrative order are stable.
