# Phase 8 Independent Audit — Corrections Addendum

Five defects found by the independent auditor (this file), fixed in the
same session, regression-tested, and re-run against fresh real golden
sessions. The builder's own self-audit
([phase-8-self-audit.md](phase-8-self-audit.md)) is unchanged.

## C1. Stale video survived a no-video session (§55/§56)

- **FILE:** `packages/showcase/src/output-safety.ts` (new),
  `packages/showcase/src/orchestrator.ts`, `packages/showcase/src/video.ts`
  (`VIDEO_FILENAME`), `docs/showcase.md`
- **DEFECT:** a `--screenshots-only` / `--no-video` session left an
  earlier session's `showcase-walkthrough.mp4` in the active output
  directory next to the fresh manifest; the stale video could be
  mistaken for the current session's product.
- **WHY:** nothing removed output from a previous session, and the
  manifest honestly says `video: null` — so the stale file's presence
  contradicts the manifest without failing any gate.
- **CHANGE:** `removeStaleVideo(outputDir)` runs at session start and
  removes exactly the canonical video filename (never a pattern) from
  the session's own output directory before any stage runs.
- **EVIDENCE:** unit tests (`output-safety.test.ts`); live rerun —
  pre-seeded stale MP4 present, session exit 0, `video: skipped`,
  stale MP4 gone afterwards.

## C2. Overlay verdicts were literals, not session truth (§45)

- **FILE:** `packages/showcase/src/video.ts`, `video.test.ts`
- **DEFECT:** slide overlays hard-coded `INV-… FAIL` for vulnerable
  slides and `INV-… PASS` for secure slides instead of transcribing
  the verifier-observed verdict the session story already carries.
- **WHY:** R-02/R-07 — a displayed verdict must come from the run
  report; a literal renders a wrong verdict if verifier truth ever
  changes, and the video test suite could not pin the derivation.
- **CHANGE:** both overlay branches now render `story.verdict`
  (verifier assertion actual, refused if absent); new regression test
  proves a `PASS`-carrying vulnerable story renders `PASS`.
- **EVIDENCE:** 36/36 showcase unit tests; full `--video` session
  re-run — overlays render the fresh session's observed verdicts.

## C3. Session validation did not enforce artifact hashes (§31)

- **FILE:** `packages/showcase/src/validate.ts`, `validate.test.ts`
- **DEFECT:** `validateSessionArtifacts` checked signature, IHDR
  dimensions, and byte count but never recomputed the PNG SHA-256
  against the sidecar, so a swapped/stale/edited PNG of the right
  dimensions and byte length could pass validation.
- **WHY:** file identity is the artifact's provenance anchor; the
  byte-count check alone does not distinguish same-length tampering.
- **CHANGE:** the session gate recomputes SHA-256 per artifact and
  fails the session on mismatch.
- **EVIDENCE:** new test case (swapped hash ⇒ `sha256 mismatch`
  problem, session fails); all live sessions validate clean.

## C4. Output path could target repository sources (§22)

- **FILE:** `packages/showcase/src/output-safety.ts` (new),
  `packages/showcase/src/orchestrator.ts` (`safeOutputDir` re-exported
  from the new module), `docs/showcase.md`
- **DEFECT:** `safeOutputDir` resolved the path but imposed no
  containment: `--output .` targeted the repository root itself, where
  the session writes artifacts, a browser profile, and removes the
  canonical video filename on later no-video sessions.
- **WHY:** cleanup must only ever operate on a positively identified
  owned output directory; a repository-root output target puts that
  removal one spelling mistake away from repository content.
- **CHANGE:** output targets inside the repository are refused unless
  they live under the designated generated-output root `.artifacts/`;
  paths outside the repository remain operator territory. Guard runs
  before any filesystem effect; failure is a classified non-zero exit
  with nothing written.
- **EVIDENCE:** unit tests cover root refusal, source-directory
  refusal, traversal spellings, `.artifacts`-sibling lookalikes, and
  the allowed roots; live runs refuse `.`, `..`, `packages`, `.git`,
  `packages/showcase/src` and run fully under `.artifacts/…`.

## C5. Truncated MP4 passed video validation (§49)

- **FILE:** `packages/showcase/src/validate.ts`
- **DEFECT:** `validateVideo` probed container metadata only. With
  `+faststart` the moov atom leads the file, so a half-truncated MP4
  probed with perfect codec/dimensions/duration and **passed**
  validation while half its frames were missing — the documented
  "decodability" check did not exist.
- **WHY:** R-03/R-07 — a validator that certifies an undecodable video
  is fake evidence; §49 requires corruption to be rejected.
- **CHANGE:** validation now adds a full decode pass with the bundled
  ffmpeg (`-xerror -f null -` over the entire stream); any decode error
  fails the video and therefore the session.
- **EVIDENCE:** half-truncated copy of a real walkthrough →
  `valid=false, stream does not decode end to end`; intact video →
  `valid=true`; wrong-dimension and non-video files still rejected.

## Post-correction verification

- format:check, lint, typecheck, build: pass.
- Workspace unit: 264/264 (27 files; showcase now 36).
- Full integration suite: 136/136 (including the real-browser
  showcase test and the previously flaky `execution-mechanics`).
- Fresh golden sessions after the fixes: no-video session (stale-MP4
  removal proven), repository-guard probes, and a full `--video`
  session (H.264 yuv420p 1920×1080, probed 10.000s, tail frames at
  9.0s/9.9s show the held closing slide, canary scan zero hits).
