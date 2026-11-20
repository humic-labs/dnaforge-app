import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const native = vi.hoisted(() => ({
  createSampleInstance: vi.fn(),
  importManaged: vi.fn(),
  ensureWorkspaceOwner: vi.fn(),
  execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
  select: vi.fn().mockResolvedValue([]),
  sendBreadcrumbs: vi.fn(),
  userData: '',
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    workspace: native,
    db: native,
  }),
}));
vi.mock('./managed-workspaces-flag', () => ({ isManagedWorkspacesEnabled: () => true }));
vi.mock('../../lib/analytics', () => ({ trackRendererEvent: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: { on: vi.fn() },
  app: { getPath: () => native.userData },
}));
vi.mock('../../main/diagnostics-upload', () => ({ reportRendererErrorSignal: vi.fn() }));

import { openWorkspaceFromSource } from './open-workspace-from-source';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { installBreadcrumbCapture } from '../../lib/renderer-breadcrumbs';
import { registerDiagnosticsHandlers, writeRendererBreadcrumbs } from '../../main/ipc/diagnostics';

const sample = { kind: 'sample-template', templateId: 'standard-samples' } as const;
const privatePath = '/private/synthetic-sample';
const privateName = 'synthetic private sample';
let disposeBreadcrumbs: () => void;

function registrationSpans(lines: string[]) {
  return lines
    .filter((line) => line.startsWith('sample_registration '))
    .map((line) => {
      const fields = Object.fromEntries(
        line
          .slice('sample_registration '.length)
          .split(' ')
          .map((field) => field.split('='))
      );
      expect(Object.keys(fields).sort()).toEqual(['correlation', 'duration_ms', 'method', 'phase']);
      return {
        method: fields.method,
        correlation: fields.correlation,
        phase: fields.phase,
        duration_ms: Number(fields.duration_ms),
      };
    });
}

function spans() {
  window.dispatchEvent(new Event('pagehide'));
  const lines: string[] = native.sendBreadcrumbs.mock.calls.at(-1)?.[0] ?? [];
  return registrationSpans(lines);
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.getState().clearWorkspace();
  vi.stubGlobal('electronAPI', { sendBreadcrumbs: native.sendBreadcrumbs });
  disposeBreadcrumbs = installBreadcrumbCapture();
  native.createSampleInstance.mockResolvedValue({
    rootPath: privatePath,
    displayName: privateName,
  });
  native.importManaged.mockResolvedValue({
    workspaceUuid: 'synthetic-workspace',
    repoPath: privatePath,
    createdAt: 999999999999,
  });
  native.ensureWorkspaceOwner.mockResolvedValue(1);
});

afterEach(() => {
  disposeBreadcrumbs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('records the real sample awaits before settlement with one opaque correlation and monotonic durations', async () => {
  let finishImport!: () => void;
  native.importManaged.mockImplementationOnce(() =>
    new Promise<void>((resolve) => {
      finishImport = resolve;
    }).then(() => ({
      workspaceUuid: 'synthetic-workspace',
      repoPath: privatePath,
      createdAt: 999999999999,
    }))
  );
  let clock = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const opening = openWorkspaceFromSource(sample, { telemetrySource: 'automatic_sample' });
  await vi.waitFor(() => expect(native.importManaged).toHaveBeenCalledOnce());
  const pending = spans();
  clock = 137;
  finishImport();
  const result = await opening;

  expect(pending.map(({ method, phase }) => [method, phase])).toEqual([
    ['createSampleInstance', 'start'],
    ['createSampleInstance', 'completed'],
    ['importManaged', 'start'],
  ]);
  expect(spans().map(({ method, phase }) => [method, phase])).toEqual([
    ['createSampleInstance', 'start'],
    ['createSampleInstance', 'completed'],
    ['importManaged', 'start'],
    ['importManaged', 'completed'],
    ['ensureWorkspaceOwner', 'start'],
    ['ensureWorkspaceOwner', 'completed'],
  ]);
  expect(
    spans().find((span) => span.method === 'importManaged' && span.phase === 'completed')
      ?.duration_ms
  ).toBe(37);
  expect(new Set(spans().map((span) => span.correlation)).size).toBe(1);
  expect(spans()[0].correlation).toMatch(/^[0-9a-f-]{36}$/);
  expect(spans().every((span) => Number.isFinite(span.duration_ms) && span.duration_ms >= 0)).toBe(
    true
  );
  expect(
    spans().every(
      (span) => Object.keys(span).sort().join(',') === 'correlation,duration_ms,method,phase'
    )
  ).toBe(true);
  expect(JSON.stringify(spans())).not.toContain(privatePath);
  expect(JSON.stringify(spans())).not.toContain(privateName);
  expect(JSON.stringify(spans())).not.toContain('999999999999');
  expect(result.instance.rootFolders[0].path).toBe(privatePath);
});

it.each(['createSampleInstance', 'importManaged', 'ensureWorkspaceOwner'] as const)(
  'keeps the exact %s rejection while recording a content-free terminal span',
  async (method) => {
    const failure = new Error(`${privateName}: ${privatePath}`);
    native[method].mockRejectedValueOnce(failure);
    await expect(openWorkspaceFromSource(sample)).rejects.toBe(failure);
    expect(spans().at(-1)).toMatchObject({ method, phase: 'error' });
    expect(
      spans()
        .filter((span) => span.method === method)
        .map((span) => span.phase)
    ).toEqual(['start', 'error']);
    expect(JSON.stringify(spans())).not.toContain(privatePath);
    expect(JSON.stringify(spans())).not.toContain(privateName);
    expect(useWorkspaceStore.getState().folders).toEqual([]);
  }
);

it('does not make diagnostic delivery part of sample registration success', async () => {
  native.sendBreadcrumbs.mockImplementation(() => {
    throw new Error('diagnostics unavailable');
  });
  const result = await openWorkspaceFromSource(sample);
  expect(result.instance.rootFolders[0].path).toBe(privatePath);
  expect(native.ensureWorkspaceOwner).toHaveBeenCalledOnce();
});

it('persists interleaved sample spans and existing warnings once through the real snapshot consumer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sample-registration-'));
  native.userData = root;
  registerDiagnosticsHandlers();
  native.sendBreadcrumbs.mockImplementation((lines: string[]) =>
    writeRendererBreadcrumbs(lines, 7)
  );
  try {
    console.warn('existing-warning-before-sample');
    window.dispatchEvent(new Event('pagehide'));
    await openWorkspaceFromSource(sample);
    console.warn('existing-warning-after-sample');
    window.dispatchEvent(new Event('pagehide'));

    const retained = readFileSync(join(root, 'logs', 'renderer-breadcrumbs.log'), 'utf8');
    expect(retained.split('existing-warning-before-sample')).toHaveLength(2);
    expect(retained.split('existing-warning-after-sample')).toHaveLength(2);
    const registrations = registrationSpans(retained.split('\n'));
    expect(registrations).toHaveLength(6);
    expect(registrations.map(({ method, phase }) => [method, phase])).toEqual([
      ['createSampleInstance', 'start'],
      ['createSampleInstance', 'completed'],
      ['importManaged', 'start'],
      ['importManaged', 'completed'],
      ['ensureWorkspaceOwner', 'start'],
      ['ensureWorkspaceOwner', 'completed'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
