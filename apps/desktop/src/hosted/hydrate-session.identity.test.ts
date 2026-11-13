import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSessionSnapshot } from '@waypoint/domain-services';
import { createHostedMemoryDb } from './memory-db';
import {
  buildSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../db/sequence-package';

const mocks = vi.hoisted(() => ({ platform: vi.fn(), state: vi.fn() }));
vi.mock('../platform', () => ({ platform: mocks.platform }));
vi.mock('./controller', () => ({
  hostedWorkspaceSessionController: { getState: mocks.state },
}));
vi.mock('../lib/analytics', () => ({
  trackRendererEvent: vi.fn(),
  subscribeAnalyticsCaptureReady: vi.fn(() => () => {}),
}));

import { hydrateHostedSnapshot, resolveHostedTabDocument } from './hydrate-session';
import { useCanvasStore } from '../features/canvas/store';
import { useWorkspaceStore } from '../stores/workspaceStore';
import {
  __resetInflightForTests,
  openSequenceFileResult,
} from '../features/sequence/openSequenceFile';
import { __resetFileOpenTelemetryForTests } from '../features/sequence/file-open-telemetry';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const root = `/hosted/${workspaceId}`;
const files = new Map<string, string>();
let snapshot: WorkspaceSessionSnapshot;

function addFile(path: string, content: string): void {
  files.set(`${root}/${path}`, content);
  snapshot = {
    ...snapshot,
    files: [
      ...snapshot.files,
      {
        path,
        resourceId: crypto.randomUUID(),
        contentRevision: 'sha256:fixture',
        contentSha256: 'a'.repeat(64),
        contentType: path.endsWith('.gb') ? 'application/genbank' : 'application/json',
        sizeBytes: new TextEncoder().encode(content).byteLength,
      },
    ],
  };
}

function addPackage(name: string, packageId: string) {
  const packageRoot = `${root}/sequences/${name}`;
  const paths = sequencePackagePaths(`sequences/${name}`);
  addFile(
    paths.metaPath,
    serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: packageId,
        name,
        product: { file: `${name}.gb`, topology: 'linear' },
      })
    )
  );
  addFile(paths.productPath, `LOCUS       ${name} 4 bp DNA linear\nORIGIN\n        1 acgt\n//\n`);
  return {
    path: `${root}/${paths.productPath}`,
    ref: { kind: 'managed-sequence' as const, packageId, packageRoot },
  };
}

beforeEach(() => {
  document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';
  files.clear();
  snapshot = {
    workspaceId,
    revisionId: null,
    revisionNumber: 0,
    localRevisionId: 'local-import',
    files: [],
  };
  mocks.state.mockImplementation(() => ({ snapshot }));
  mocks.platform.mockReturnValue({
    db: createHostedMemoryDb(),
    fileAssociations: { prepareQuickLookPackage: vi.fn(async () => undefined) },
    fs: {
      exists: async (path: string) =>
        files.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`)),
      readTextFile: async (path: string) => {
        const content = files.get(path);
        if (content === undefined)
          throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' });
        return content;
      },
      writeTextFile: async (path: string, content: string) => {
        files.set(path, content);
      },
      readDir: async (path: string) => {
        const entries = new Map<string, { name: string; isDirectory: boolean; isFile: boolean }>();
        for (const file of files.keys()) {
          if (!file.startsWith(`${path}/`)) continue;
          const relative = file.slice(path.length + 1);
          const name = relative.split('/')[0];
          const isDirectory = relative.includes('/');
          entries.set(name, { name, isDirectory, isFile: !isDirectory });
        }
        return [...entries.values()];
      },
      stat: async (path: string) => {
        const content = files.get(path);
        if (content === undefined)
          throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' });
        return { size: new TextEncoder().encode(content).byteLength, mtime: 0, ctime: 0 };
      },
    },
  });
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    oversizeScanComplete: true,
    recentlyClosed: [],
  });
  useWorkspaceStore.setState({
    folders: [{ path: root, name: 'Hosted fixture', addedAt: 1 }],
    activeWorkspaceFile: null,
    expandedPaths: new Set(),
  });
  __resetInflightForTests();
  __resetFileOpenTelemetryForTests();
});

afterEach(() => {
  delete document.documentElement.dataset.dnaforgeRuntime;
  __resetInflightForTests();
  __resetFileOpenTelemetryForTests();
});

describe('hosted hydration preserves managed sequence identity', () => {
  it('reuses two imported package tabs after local hydration and accepted ACK hydration', async () => {
    const first = addPackage('annotated-hosted-journey', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
    const second = addPackage('untouched-control', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2');
    const firstOpen = await openSequenceFileResult({ filePath: first.path, label: 'first' });
    const secondOpen = await openSequenceFileResult({ filePath: second.path, label: 'second' });
    expect(firstOpen.status).toBe('presented');
    expect(secondOpen.status).toBe('presented');
    const tabIds = useCanvasStore.getState().panels.main.tabs.map((tab) => tab.id);

    await hydrateHostedSnapshot(snapshot);
    snapshot = {
      ...snapshot,
      revisionId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
      revisionNumber: 1,
      localRevisionId: undefined,
    };
    await hydrateHostedSnapshot(snapshot);
    const reopened = await openSequenceFileResult({ filePath: second.path, label: 'second' });

    const tabs = useCanvasStore.getState().panels.main.tabs;
    expect(tabs).toHaveLength(2);
    expect(reopened).toMatchObject({ ...secondOpen, disposition: 'reused' });
    expect(tabs.map((tab) => tab.id)).toEqual(tabIds);
    expect(tabs.map((tab) => tab.sequenceDocument)).toEqual([first.ref, second.ref]);
    expect(tabs.map((tab) => tab.entityId)).toEqual([first.ref.packageId, second.ref.packageId]);
  });

  it('recovers a restored managed tab with its portable package ID, not a new loose-file ID', async () => {
    const sequence = addPackage('restored', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4');
    await hydrateHostedSnapshot(snapshot);
    expect(await resolveHostedTabDocument('restored.gb')).toMatchObject({
      ref: sequence.ref,
      documentId: sequence.ref.packageId,
      sourcePath: sequence.path,
    });
  });

  it('keeps legacy loose-file recovery but refuses an ambiguous basename', async () => {
    addFile('files/one/shared.gb', 'first loose GenBank');
    addFile('files/two/shared.gb', 'second loose GenBank');
    expect(await resolveHostedTabDocument('shared.gb')).toBeNull();
    const resolved = await resolveHostedTabDocument('files/one/shared.gb');
    expect(resolved).toMatchObject({
      ref: { kind: 'catalog-sequence' },
      sourcePath: `${root}/files/one/shared.gb`,
    });
    expect(resolved?.documentId).toBe(
      resolved?.ref.kind === 'catalog-sequence' ? resolved.ref.entityId : null
    );
  });
});
