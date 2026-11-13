import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, after } from 'node:test';
import {
  createJournal,
  parseArgs,
  recordRequest,
  startMockDiagnosticsServer,
  summarizeJournal,
} from '../mock-diagnostics-server.mjs';

describe('mock-diagnostics-server', () => {
  const dirs = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('parses port and journal args', () => {
    const a = parseArgs(['--port', '8799', '--journal', '/tmp/j.json']);
    assert.equal(a.port, 8799);
    assert.equal(a.journal, '/tmp/j.json');
  });

  it('summarizes beacons and uploads', () => {
    const j = createJournal();
    recordRequest(j, {
      method: 'POST',
      path: '/api/diagnostics/install-beacon',
      body: { event: 'init' },
    });
    recordRequest(j, {
      method: 'POST',
      path: '/api/diagnostics/upload',
      body: { kind: 'boot_ok' },
    });
    const s = summarizeJournal(j);
    assert.deepEqual(s.beacons, ['init']);
    assert.deepEqual(s.uploads, ['boot_ok']);
  });

  it('accepts beacon and upload POSTs and persists journal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mock-diag-'));
    dirs.push(dir);
    const journalPath = join(dir, 'journal.json');
    const server = await startMockDiagnosticsServer({ port: 0, journal: journalPath });
    try {
      const health = await fetch(`${server.baseUrl}/health`);
      assert.equal(health.status, 200);

      const beacon = await fetch(`${server.baseUrl}/api/diagnostics/install-beacon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schema: 1,
          event: 'init',
          app_version: '0.3.0',
          platform: 'win-x64',
          attempt_id: 'test-attempt',
        }),
      });
      assert.equal(beacon.status, 201);

      const upload = await fetch(`${server.baseUrl}/api/diagnostics/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schema: 1,
          kind: 'boot_failure',
          error_class: 'forced_boot_failure',
          files: [{ name: 'main-boot.log', content: 'schema=1 boot' }],
        }),
      });
      assert.equal(upload.status, 201);

      const summary = server.summarize();
      assert.deepEqual(summary.beacons, ['init']);
      assert.deepEqual(summary.uploads, ['boot_failure']);

      const disk = JSON.parse(readFileSync(journalPath, 'utf8'));
      assert.equal(disk.requests.length, 2);
    } finally {
      await server.stop();
    }
  });
});
