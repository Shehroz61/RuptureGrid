# Project status

Status checked on **17 October 2026**. This page separates implementation,
verification and publication; a passed audit does not create an acceptance tag.

| Milestone | Observed state |
| --- | --- |
| Latest published version | [v1.0.1](https://github.com/Shehroz61/RuptureGrid/releases/tag/v1.0.1), Apache-2.0, source-only |
| Accepted checkpoints | Phases 0–17; `phase-17-accepted` is unchanged |
| Phase 18 implementation | Committed as [`f3dccda3c2b8e6ac1d07512a4ed89a5de520fbd7`](https://github.com/Shehroz61/RuptureGrid/commit/f3dccda3c2b8e6ac1d07512a4ed89a5de520fbd7) |
| Final independent Phase 18 audit | PASS; [reference and original-report archive](reports/phase-18-final-independent-acceptance-reference.md) |
| Official CI for that commit | [Run 39031711047](https://github.com/Shehroz61/RuptureGrid/actions/runs/39031711047): completed, success |
| Phase 18 acceptance tag | Not created; separate authorization remains required |
| Repository presentation overhaul | Documentation/community-template changes awaiting their own commit review, authorization and new-commit CI |
| Phase 19 / v1.1.0 release | Not started / not published |

The independent audit recorded 457 integration tests across 44 files and
767 unit tests, with zero failures or skips in those full suites. It also
verified exact shuffle, both registration orders, same-snapshot Commerce
FAIL→fix→PASS, historical Fintech replay, Phase 17 regressions and security
gates. These counts describe that audit invocation, not a permanently fixed
suite size or tests rerun during documentation editing.

The [roadmap](phase-roadmap.md) defines phase scope; the
[ADRs](decisions/) record accepted decisions and explicit amendments.
Dated reports and ADR status addenda preserve what was known at their own
checkpoint. In particular, the earlier evidence-closure report's pending
commit/CI statements are historical, not the current Git state.

## Publication and evidence

The [source-pinned CI recipe](external-ci-recipe.md) accepts a full verified
commit SHA. The implementation commit above is CI-green; consumers must
review and verify the specific revision they select. It is not a v1.1 release
or a substitute for the pending final documentation commit's CI.

The [evidence ZIP](evidence/phase-18/phase-18-original-audit-reports.zip) and
[manifest](evidence/phase-18/SHA256SUMS) are committed in the implementation
revision. Gate B retrieved both from that exact remote commit and verified
their bytes and all four original-report hashes. Additional raw receipts
referenced by the reports are not included in this archive.

Public npm, Docker-image and prebuilt-binary distribution remain outside the
source-only policy. Credential-value fingerprinting remains explicitly
PROPOSED, DEFERRED and UNIMPLEMENTED under ADR-0027; reference/grant checks
remain enforced. Documentation presentation work does not open Phase 19.
