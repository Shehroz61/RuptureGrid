# Third-Party Notices

This file records the v1.0 license and distribution policy for
third-party material. It states dependency metadata and project policy
only; it makes no legal conclusions beyond that. Each dependency's full
license text lives in that dependency's own package (`node_modules` at
install time) — third-party licenses are not modified or re-licensed by
this project.

## Project license

RuptureGrid's own source is licensed under **Apache-2.0** — see
[LICENSE](LICENSE). Dependencies retain their own licenses; nothing here
re-licenses them.

## Dependency licensing summary (v1.0)

Direct dependencies are permissive (MIT / Apache-2.0 / ISC / BSD lineage),
as reviewed in the Phase 11 independent audit
([docs/reports/phase-11-independent-audit.md](docs/reports/phase-11-independent-audit.md)
§17). The notable exception:

- **`ffmpeg-static` — GPL-3.0-or-later.** It is a build-time-downloaded
  binary used only by the optional Phase 8 showcase video encoder.

## ffmpeg / ffmpeg-static policy (v1.0)

- `ffmpeg-static` is a **development / showcase dependency only**. It
  downloads a prebuilt FFmpeg binary at dependency-install time for
  local, optional showcase video composition (`pnpm showcase:generate
  --video`).
- The **v1.0 source release does not bundle or distribute any FFmpeg
  binary as a RuptureGrid release artifact.** No release artifact ships
  it; contributors who want showcase video obtain it themselves through
  the normal dependency install on their own machine.
- Showcase media (screenshots, video) is **generated locally only** and
  is gitignored (`.artifacts/`); it is not committed and not distributed
  as part of the release.

## Source-only distribution (v1.0)

The v1.0.0 release consists of **source, documentation, migrations,
tests, and verifier/showcase source only**. It does not include: npm
package publication, Docker image publication, prebuilt application
binaries, bundled FFmpeg binaries, or generated showcase media.
