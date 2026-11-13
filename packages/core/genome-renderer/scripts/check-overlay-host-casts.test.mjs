
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HOST_CAST_CEILING,
  SIBLING_HOST_CAST_CEILING,
  checkOverlaySiblingHostCasts,
  countHostCasts,
} from './check-overlay-host-casts.mjs';

const SCRIPT = fileURLToPath(new URL('./check-overlay-host-casts.mjs', import.meta.url));

let scratchDir = null;

afterEach(() => {
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = null;
  }
});

function plant(count) {
  scratchDir = mkdtempSync(join(tmpdir(), 'overlay-host-casts-'));
  const file = join(scratchDir, 'annotation-overlay.ts');
  const lines = Array.from({ length: count }, (_, i) => `const x${i} = this as unknown as Host;\n`);
  writeFileSync(file, lines.join(''));
  return file;
}

function runCli(file) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, OVERLAY_HOST_CAST_FILE: file },
  });
}

describe('check-overlay-host-casts', () => {
  it('counts the as-unknown-as substring', () => {
    assert.equal(countHostCasts('this as unknown as Host'), 1);
    assert.equal(countHostCasts('no casts here'), 0);
    assert.equal(countHostCasts('a as unknown as B as unknown as C'), 2);
  });

  it('PASS at the ceiling', () => {
    const result = runCli(plant(HOST_CAST_CEILING));
    assert.equal(result.status, 0);
    assert.match(result.stdout, /PASS/);
    assert.doesNotMatch(result.stdout, /HINT/);
  });

  it('does not hint when the façade ceiling is already 0', () => {
    assert.equal(HOST_CAST_CEILING, 0);
    const result = runCli(plant(0));
    assert.equal(result.status, 0);
    assert.match(result.stdout, /PASS/);
    assert.doesNotMatch(result.stdout, /HINT/);
  });

  it('FAIL when over the ceiling', () => {
    const result = runCli(plant(HOST_CAST_CEILING + 1));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL/);
    assert.match(result.stdout, /may only fall/);
  });

  it('PASS on the real overlay at or under the ceiling', () => {
    const overlay = resolve(
      import.meta.dirname,
      '../src/renderers/pixi/overlays/annotation-overlay.ts'
    );
    const result = runCli(overlay);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /PASS/);
  });

  it('PASS on sibling overlay production files at or under the sibling ceiling', () => {
    const siblings = checkOverlaySiblingHostCasts();
    assert.equal(siblings.ok, true);
    assert.ok(siblings.count <= SIBLING_HOST_CAST_CEILING);
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /siblings=/);
  });
});
