// =====================================================================
// Unit — artifact validation (Phase 8)
// =====================================================================
// Pins the PNG gate (real signature + IHDR parse, real dimensions —
// §47) and the session gate (required files, byte agreement — §46).

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePngDimensions, validateSessionArtifacts, PNG_SIGNATURE } from './validate.js';
import type { ArtifactMetadata } from './types.js';

function ihdrPng(width: number, height: number): Buffer {
  // Signature + IHDR chunk (length 13, type IHDR, 13 data bytes, CRC).
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  const crc = Buffer.alloc(4); // zeros suffice for the parse contract
  return Buffer.concat([PNG_SIGNATURE, length, Buffer.from('IHDR', 'ascii'), ihdrData, crc]);
}

describe('parsePngDimensions', () => {
  it('accepts a real PNG signature + IHDR', () => {
    const dims = parsePngDimensions(ihdrPng(1440, 900));
    expect(dims).toEqual({ width: 1440, height: 900 });
  });

  it('rejects a non-PNG buffer (e.g. a text file renamed .png)', () => {
    const fake = Buffer.from('definitely not a png at all, just text padding '.repeat(4), 'utf8');
    expect(parsePngDimensions(fake)).toBeNull();
  });

  it('rejects a truncated buffer', () => {
    expect(parsePngDimensions(PNG_SIGNATURE)).toBeNull();
  });

  it('rejects zero dimensions', () => {
    expect(parsePngDimensions(ihdrPng(0, 900))).toBeNull();
  });
});

describe('validateSessionArtifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rg8-validate-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const fileHash = (name: string): string =>
    createHash('sha256')
      .update(readFileSync(join(dir, name)))
      .digest('hex');

  it('reports missing required artifacts and byte mismatches, passes on a real set', async () => {
    const { CAPTURE_PLAN } = await import('./capture-plan.js');
    const metadata: ArtifactMetadata[] = [];
    for (const step of CAPTURE_PLAN) {
      const filename = `${step.artifact}.png`;
      writeFileSync(join(dir, filename), ihdrPng(1440, 900));
      metadata.push({
        filename,
        runId: step.mode === 'VULNERABLE' ? 'run-v' : 'run-s',
        findingId: null,
        route: step.route({
          vulnerableRunId: 'run-v',
          secureRunId: 'run-s',
          vulnerableFindingId: 'f',
        }),
        capturedAt: new Date().toISOString(),
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        sourceVerdict: step.mode === 'VULNERABLE' ? 'FAIL' : 'PASS',
        sha256: fileHash(filename),
        bytes: ihdrPng(1440, 900).length,
        purpose: step.purpose,
        status: 'captured',
      });
    }
    const result = await validateSessionArtifacts({ outputDir: dir, artifacts: metadata });
    expect(result.pass).toBe(true);
    expect(result.problems).toEqual([]);

    // Corrupt one artifact's byte count → validation must fail.
    const tampered = metadata.map((entry) =>
      entry.filename === '01-vulnerable-overview.png' ? { ...entry, bytes: 1 } : entry,
    );
    const bad = await validateSessionArtifacts({ outputDir: dir, artifacts: tampered });
    expect(bad.pass).toBe(false);
    expect(bad.problems.join(' ')).toContain('01-vulnerable-overview.png');

    // Corrupt one artifact's sidecar hash (a swapped/stale/edited file
    // with intact dimensions) → validation must fail (§31).
    const swapped = metadata.map((entry) =>
      entry.filename === '02-vulnerable-finding.png' ? { ...entry, sha256: 'f'.repeat(64) } : entry,
    );
    const badHash = await validateSessionArtifacts({ outputDir: dir, artifacts: swapped });
    expect(badHash.pass).toBe(false);
    expect(badHash.problems.join(' ')).toContain('sha256 mismatch');
  });

  it('fails when a required artifact file is absent', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'rg8-empty-'));
    try {
      const result = await validateSessionArtifacts({ outputDir: empty, artifacts: [] });
      expect(result.pass).toBe(false);
      expect(result.problems.length).toBe(10);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
