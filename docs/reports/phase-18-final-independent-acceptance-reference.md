# Phase 18 — Final Independent Acceptance Reference

Current status: 17 October 2026, Asia/Karachi. The approved architectural
implementation is complete and the final independent acceptance audit
**PASSED**. This record is a documentation/evidence handoff, not a new audit
or a declaration that Phase 18 is accepted or published.

## Independent audit identity and results

The original report is
`phase-18-final-independent-acceptance-recheck.md`, dated 17 October 2026.
Its SHA-256, verified against the original bytes, is
`80835f49f0513a5786411681f54e23f79353b220db5ab3c049fb6ab5e01c5eb2`.
The complete original report is included in the evidence ZIP below at
`originals/phase-18-final-independent-acceptance-recheck.md`; the summary
here does not replace it. Its verdict is PASS, with no blocking findings.

The following results belong to that independent audit. Documentation
closure does not claim to have rerun the infrastructure suites.

| Independent verification | Recorded result |
| --- | --- |
| Standard unfiltered `pnpm test:integration` | 457 passed across 44 files; zero failures or skips; exit 0 |
| Unit suite | 767 passed across 60 files; zero failures or skips; exit 0 |
| Exact shuffle, seed 18027 | 59 passed across five files; zero failures; eight intentionally filtered cases, all covered by the unfiltered gate; exit 0 |
| Registration order, seed 18031 | 58 passed across six files; zero failures or skips; exit 0 |
| Registration order, seed 18032 | 58 passed across six files; zero failures or skips; exit 0 |
| Commerce lifecycle | Genuine FAIL, no-fix control, legitimate target-side remediation, and independently evaluated PASS using the original reproduction and identical stored snapshot row/hash; original history preserved |
| Historical Fintech | Both persisted reproductions replayed through fresh CLI/worker/target processes; vulnerable exit 1 and secure exit 0; frozen v1 bindings and original snapshots preserved |
| Phase 17 | All 167 cases across 11 files passed; accepted exit, fencing, uncertainty and repeat/retry semantics retained |
| Remaining verification | Format, lint, typecheck, build, Incident Zero and Controlled Faults passed; migration status/drift checks passed for Control/Fintech/Commerce with 9/4/3 migrations and no drift |
| Security | The audit found no acceptance-blocking authorization/security defect; hostile refusal coverage and the fresh transient credential canary passed, with no canary leak recorded |

The exact shuffle command, registration file orders, run identities,
business-state proof and verification limits remain in the full original
report. Raw logs, executable receipts and database evidence referenced by
those reports are **not included** in this four-report archive. No public
URL or durable remote archive for those additional materials is claimed.

## Current gate status

| Gate or milestone | Status at this documentation closure |
| --- | --- |
| Approved architectural implementation | COMPLETED; audited implementation bytes unchanged |
| Final independent acceptance audit | PASSED |
| Controlled Phase 18 commit | NOT YET CREATED; separate authorization required |
| CI on the new Phase 18 commit | NOT YET RUN; must verify the exact resulting SHA |
| Phase 18 acceptance tag | NOT YET CREATED; separate authorization after successful CI required |
| Phase 19 | NOT STARTED |

The accepted Phase 17 baseline remains
`eb95c157824f8990be609311a18c668e52ec2b76` (`phase-17-accepted`). No commit,
push, tag, release or Phase 19 action is authorized by the audit PASS or
this documentation closure.

## Credential guarantee and deferred proposal

Existing credential-reference, registration and current-grant authorization
checks remain enforced. Missing runtime values fail pre-send. Secret-value
changes behind an unchanged, still-authorized reference are not
fingerprint-verified. [ADR-0027](../decisions/ADR-0027-replay-lifecycle-mode-pinned-setup.md)
Section L.5 remains PROPOSED, DEFERRED, and UNIMPLEMENTED. No fingerprint
key/metadata, ADR-0012 change, or legacy-replay restriction is approved.

## Portable evidence index and archival status

The owner approved a repository evidence ZIP and manifest on 17 October
2026 after no verifiable existing archive was found in the checked
repository documentation, GitHub release assets or GitHub Actions
artifacts. The originals were copied byte-for-byte without overwriting,
rewriting, deleting or sanitizing their source files.

- [Original audit reports ZIP](../evidence/phase-18/phase-18-original-audit-reports.zip)
- [SHA-256 manifest](../evidence/phase-18/SHA256SUMS)

ZIP SHA-256:
`c895cfafc74d8754e4a9f9121dff33563d7ea0fc498efb0b0dc03494331820d2`.
The ZIP contains four original reports plus `ORIGINAL-SHA256SUMS`.
The external manifest covers the ZIP and all four original report entries.

**Archival status: prepared and locally verified; NOT YET COMMITTED OR
PUSHED.** These relative references resolve to files included in the
proposed source candidate. They are not public archive URLs and do not
establish durable remote preservation before controlled Git finalization.
After an authorized commit and push, verify the retrieved ZIP and manifest
against the same hashes at the exact published commit. Additional raw
receipts remain outside this archive and require their own preservation
decision if they are to be distributed.

| ZIP entry | Bytes | Original SHA-256 |
| --- | ---: | --- |
| `originals/phase-18-final-independent-acceptance-recheck.md` | 38248 | `80835f49f0513a5786411681f54e23f79353b220db5ab3c049fb6ab5e01c5eb2` |
| `originals/phase-18-final-post-repair-verification.md` | 25451 | `55c2f4c2ef9209eed400a4c9a5840a69416059f90f94017e156a34b57f81c3f5` |
| `originals/phase-18-redis-outage-registration-repair-verification.md` | 24706 | `29b206d05d1f0940d935b5a3496017d28f227f96790a3acf7f38471800862a55` |
| `originals/phase-18-registration-isolation-root-cause-repair.md` | 22754 | `eb32cb8a5d654da7c06bc32e9c83d784b8ef0fe98f90cc454115201022291bca` |

Historical results remain historical. The Redis repair report records the
prior independent 445-pass/1-fail result and its own 444-pass/3-fail full
run. The registration-isolation report preserves its 456-pass/1-fail full
run and subsequent focused B1 correction. The final post-repair report
records a later builder verification with 457 passes. The final independent
PASS is a separate invocation, not a relabeling of any of those results.

The three machine-path-bearing historical Markdown originals remain
untouched in the working tree and are excluded as standalone paths from
the proposed commit. Their exact bytes, including historical paths, are
preserved only as explicitly approved forensic contents of the portable
ZIP. Those paths are provenance, not runtime configuration or functioning
portable links. Other historical reports already in the candidate are not
rewritten by this closure.

From the repository root, this read-only command verifies the ZIP and each
report in memory without extracting files:

```bash
python - <<'PY'
from hashlib import sha256
from pathlib import Path
from zipfile import ZipFile

directory = Path('docs/evidence/phase-18')
archive = directory / 'phase-18-original-audit-reports.zip'
with ZipFile(archive) as bundle:
    assert bundle.testzip() is None
    for line in (directory / 'SHA256SUMS').read_text().splitlines():
        expected, name = line.split('  ', 1)
        data = archive.read_bytes() if name == archive.name else bundle.read(name)
        if sha256(data).hexdigest() != expected:
            raise SystemExit(f'hash mismatch: {name}')
        print(f'OK {name}')
PY
```

## Controlled finalization boundary

Documentation/evidence preparation does not authorize staging. Review the
refreshed exact inclusion/exclusion inventory first. Commit and push
require Gate B authorization; GitHub CI must then pass on the exact new
commit under Gate C; creating/pushing `phase-18-accepted` requires separate
Gate D authorization. Phase 19 remains closed.
