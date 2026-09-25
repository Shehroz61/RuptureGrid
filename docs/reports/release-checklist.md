# RuptureGrid v1.0.0 — Release Checklist

Owner/publication actions required for the final v1.0.0 release. This
checklist is the single live to-do list for publication; the state of the
engineering tree itself is recorded in
[docs/reports/v1.0-publication-closure.md](v1.0-publication-closure.md).

## Owner decisions already applied

- [x] **License: Apache-2.0** — `LICENSE` (official Apache License 2.0
      text) added; `license` metadata set to `Apache-2.0` in the root
      manifest and in the three `@rupturegrid/*` workspace manifests that
      previously carried `UNLICENSED`; the remaining workspace manifests,
      all `private: true`, declare no license field; no invented copyright
      holder.
- [x] **Source-only release model** — the v1.0.0 release consists of
      source, documentation, migrations, tests, and verifier/showcase
      source only.
- [x] **No package publication for v1.0** — all workspaces remain
      `private: true`; no npm publish workflow or release token exists.
- [x] **No Docker image or prebuilt binary publication for v1.0.**
- [x] **ffmpeg-static is development/showcase tooling only** — no FFmpeg
      binary is bundled or distributed as a RuptureGrid release artifact;
      showcase media is generated locally, gitignored, never committed
      ([THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)).
- [x] **No placeholder metadata anywhere** — no fake repository URL,
      homepage, bugs URL, or security email has been invented or added.

## Remaining publication actions (owner, in order)

1. [x] **Public GitHub repository created and confirmed live** —
       <https://github.com/Shehroz61/RuptureGrid>
       (clone: `https://github.com/Shehroz61/RuptureGrid.git`).
2. [x] **GitHub Private Vulnerability Reporting enabled** on that public
       repository by the owner (the intended vulnerability-disclosure
       channel; see [SECURITY.md](../../SECURITY.md)).
3. [x] **Repository/homepage/bugs metadata filled with the real URL** —
       `repository`/`homepage`/`bugs` added to the root `package.json`
       only. CHANGELOG version headings remain intentionally link-less
       for the initial release (no prior version to compare against).
4. [ ] **Run final release verification** — `pnpm release:verify` plus
       integration suites on the final tree (see
       [docs/reports/v1.0-publication-closure.md](v1.0-publication-closure.md)
       for the observed totals on the closure tree).
5. [ ] **Ensure a clean tree** on the release commit.
6. [ ] **Create the `v1.0.0` annotated tag** on the release commit.
7. [ ] **Push only after explicit human approval.**
8. [ ] **Optionally create a source-only GitHub release** (source archive
       from the tagged commit; no npm/Docker/binaries/ffmpeg artifacts).

## Explicitly not automated

Push, tag creation, and release creation are owner actions performed
manually; nothing in this repository automates them and no workflow
publishes anything (CI is read-only, `permissions: contents: read`).
