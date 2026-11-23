import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  __resetSampleWorkspaceInflightForTests,
  createSampleWorkspaceInstanceWithLock,
  resolveAppCreatedSampleWorkspaceSource,
  resolveSampleWorkspaceResourceRoot,
} from './factory';
import { SEQUENCE_PACKAGE_FORMAT_VERSION } from '../../db/sequence-package-contract';

import { setImmediate as nextFactoryTurn } from 'node:timers/promises';
import { sep } from 'node:path';
import { assertWorkspaceShape } from '../../db/scan-workspace-shape';

interface HeldFactoryCopy {
  from: string;
  to: string;
  release(): void;
  reject(reason: Error): void;
}

interface FactoryCopyProbe {
  active: boolean;
  holdMode: 'none' | 'first' | 'all';
  metadata: Set<Promise<unknown>>;
  runnableCopies: Set<Promise<unknown>>;
  copies: Set<Promise<void>>;
  operations: Promise<void>[];
  held: HeldFactoryCopy[];
  calls: { from: string; to: string }[];
  peak: number;
  completed: number;
  expectedCopies: number;
  failureInjected: boolean;
  cleanupBeforeDrain: boolean;
  publicationBeforeDrain: boolean;
}

const factoryCopyProbe = vi.hoisted<FactoryCopyProbe>(() => ({
  active: false,
  holdMode: 'none',
  metadata: new Set(),
  runnableCopies: new Set(),
  copies: new Set(),
  operations: [],
  held: [],
  calls: [],
  peak: 0,
  completed: 0,
  expectedCopies: 0,
  failureInjected: false,
  cleanupBeforeDrain: false,
  publicationBeforeDrain: false,
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const tracked = <T>(set: Set<Promise<unknown>>, promise: Promise<T>): Promise<T> => {
    if (!factoryCopyProbe.active) return promise;
    set.add(promise);
    void promise.then(
      () => set.delete(promise),
      () => set.delete(promise)
    );
    return promise;
  };
  const metadata = <T>(promise: Promise<T>): Promise<T> =>
    tracked(factoryCopyProbe.metadata, promise);

  return {
    ...actual,
    lstat: vi.fn(actual.lstat).mockImplementation((...args) => metadata(actual.lstat(...args))),
    mkdir: vi.fn(actual.mkdir).mockImplementation((...args) => metadata(actual.mkdir(...args))),
    readFile: vi
      .fn(actual.readFile)
      .mockImplementation((...args) => metadata(actual.readFile(...args))),
    readdir: vi
      .fn(actual.readdir)
      .mockImplementation((...args) => metadata(actual.readdir(...args))),
    realpath: vi
      .fn(actual.realpath)
      .mockImplementation((...args) => metadata(actual.realpath(...args))),
    stat: vi.fn(actual.stat).mockImplementation((...args) => metadata(actual.stat(...args))),
    rename: vi.fn(actual.rename).mockImplementation((...args) => {
      if (factoryCopyProbe.active && factoryCopyProbe.completed !== factoryCopyProbe.expectedCopies)
        factoryCopyProbe.publicationBeforeDrain = true;
      return metadata(actual.rename(...args));
    }),
    rm: vi.fn(actual.rm).mockImplementation((...args) => {
      if (
        factoryCopyProbe.active &&
        factoryCopyProbe.failureInjected &&
        factoryCopyProbe.copies.size > 0
      )
        factoryCopyProbe.cleanupBeforeDrain = true;
      return metadata(actual.rm(...args));
    }),
    writeFile: vi.fn(actual.writeFile).mockImplementation((...args) => {
      if (
        factoryCopyProbe.active &&
        typeof args[0] === 'string' &&
        args[0].endsWith('.dnaforge-sample-workspace.json') &&
        factoryCopyProbe.completed !== factoryCopyProbe.expectedCopies
      )
        factoryCopyProbe.publicationBeforeDrain = true;
      return metadata(actual.writeFile(...args));
    }),
    copyFile: vi.fn(actual.copyFile).mockImplementation((...args) => {
      if (!factoryCopyProbe.active) return actual.copyFile(...args);
      const [from, to] = args;
      if (typeof from !== 'string' || typeof to !== 'string')
        throw new Error('FACTORY_COPY_FIXTURE_EXPECTED_STRING_PATHS');
      const hold =
        factoryCopyProbe.holdMode === 'all' ||
        (factoryCopyProbe.holdMode === 'first' && factoryCopyProbe.calls.length === 0);
      factoryCopyProbe.calls.push({ from, to });
      let gate = Promise.resolve();
      if (hold) {
        gate = new Promise<void>((resolve, reject) => {
          factoryCopyProbe.held.push({
            from,
            to,
            release: () => resolve(),
            reject: (reason) => {
              factoryCopyProbe.failureInjected = true;
              reject(reason);
            },
          });
        });
      }
      const operation = gate.then(() =>
        tracked(factoryCopyProbe.runnableCopies, actual.copyFile(...args))
      );
      factoryCopyProbe.copies.add(operation);
      factoryCopyProbe.operations.push(operation);
      factoryCopyProbe.peak = Math.max(factoryCopyProbe.peak, factoryCopyProbe.copies.size);
      void operation.then(
        () => {
          factoryCopyProbe.completed += 1;
          factoryCopyProbe.copies.delete(operation);
        },
        () => factoryCopyProbe.copies.delete(operation)
      );
      return operation;
    }),
  };
});

const tempRoots: string[] = [];

afterEach(() => {
  __resetSampleWorkspaceInflightForTests();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('sample workspace factory', () => {
  it('issues import authority only for native-created sample roots', async () => {
    const { resourcesRoot, userData } = createTemplate();
    const rawRoot = join(userData, 'Sample Workspaces', 'raw', 'workspace');
    mkdirSync(rawRoot, { recursive: true });
    expect(await resolveAppCreatedSampleWorkspaceSource(rawRoot)).toBeNull();
    const instance = await createSampleWorkspaceInstanceWithLock(
      { templateId: 'standard-samples' },
      { userDataPath: userData, resourcesRootPath: resourcesRoot }
    );
    expect(await resolveAppCreatedSampleWorkspaceSource(instance.rootPath)).toEqual({
      rootPath: realpathSync(instance.rootPath),
      displayName: instance.displayName,
    });
    expect(await resolveAppCreatedSampleWorkspaceSource(join(instance.rootPath, '..'))).toBeNull();
    expect(await resolveAppCreatedSampleWorkspaceSource(resourcesRoot)).toBeNull();
    __resetSampleWorkspaceInflightForTests();
    expect(await resolveAppCreatedSampleWorkspaceSource(instance.rootPath)).toBeNull();
    const reopened = await createSampleWorkspaceInstanceWithLock(
      { templateId: 'standard-samples' },
      { userDataPath: userData, resourcesRootPath: resourcesRoot }
    );
    expect(reopened.rootPath).toBe(instance.rootPath);
    expect(await resolveAppCreatedSampleWorkspaceSource(reopened.rootPath)).toMatchObject({
      displayName: 'DNAForge Samples',
    });
  });

  it('materializes standard samples into user data and reuses the existing copy', async () => {
    const { resourcesRoot, userData } = createTemplate();

    const first = await createSampleWorkspaceInstanceWithLock(
      { templateId: 'standard-samples' },
      { userDataPath: userData, resourcesRootPath: resourcesRoot }
    );
    const second = await createSampleWorkspaceInstanceWithLock(
      { templateId: 'standard-samples' },
      { userDataPath: userData, resourcesRootPath: resourcesRoot }
    );

    expect(first.rootPath).toBe(join(userData, 'Sample Workspaces/standard-samples/v1/workspace'));
    expect(first.rootPath.startsWith(userData)).toBe(true);
    expect(
      readFileSync(join(first.rootPath, 'sequences/plasmids/pUC19/pUC19.gb'), 'utf8')
    ).toContain('LOCUS');
    expect(existsSync(first.markerPath)).toBe(true);
    expect(second.rootPath).toBe(first.rootPath);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('keeps canonical template files unchanged when the materialized copy is edited', async () => {
    const { resourcesRoot, userData, workspacePath } = createTemplate();
    const canonicalFilePath = join(workspacePath, 'sequences/plasmids/pUC19/pUC19.gb');
    const canonicalBefore = readFileSync(canonicalFilePath, 'utf8');

    const instance = await createSampleWorkspaceInstanceWithLock(
      { templateId: 'standard-samples' },
      { userDataPath: userData, resourcesRootPath: resourcesRoot }
    );
    writeFileSync(
      join(instance.rootPath, 'sequences/plasmids/pUC19/pUC19.gb'),
      `${canonicalBefore}\nFEATURES             Location/Qualifiers\n`
    );

    expect(readFileSync(canonicalFilePath, 'utf8')).toBe(canonicalBefore);
    expect(
      readFileSync(join(instance.rootPath, 'sequences/plasmids/pUC19/pUC19.gb'), 'utf8')
    ).not.toBe(canonicalBefore);
  });

  it('deduplicates concurrent reuse requests', async () => {
    const { resourcesRoot, userData } = createTemplate();

    const [first, second] = await Promise.all([
      createSampleWorkspaceInstanceWithLock(
        { templateId: 'standard-samples' },
        { userDataPath: userData, resourcesRootPath: resourcesRoot }
      ),
      createSampleWorkspaceInstanceWithLock(
        { templateId: 'standard-samples' },
        { userDataPath: userData, resourcesRootPath: resourcesRoot }
      ),
    ]);

    expect(first.rootPath).toBe(second.rootPath);
    expect(first.createdAt).toBe(second.createdAt);
  });

  it('rejects unknown or traversal template ids', async () => {
    const { resourcesRoot, userData } = createTemplate();

    await expect(
      createSampleWorkspaceInstanceWithLock(
        { templateId: '../standard-samples' },
        { userDataPath: userData, resourcesRootPath: resourcesRoot }
      )
    ).rejects.toThrow(/Unknown sample workspace template/);
  });

  it('rejects unsafe asset paths in the canonical manifest', async () => {
    const { resourcesRoot, userData, manifestPath } = createTemplate();
    writeManifest(manifestPath, [{ id: 'bad', label: 'Bad', path: '../bad.gb' }]);

    await expect(
      createSampleWorkspaceInstanceWithLock(
        { templateId: 'standard-samples' },
        { userDataPath: userData, resourcesRootPath: resourcesRoot }
      )
    ).rejects.toThrow(/traverse/);
  });

  it('rejects symlinks inside the canonical template payload', async () => {
    const { resourcesRoot, userData, workspacePath } = createTemplate();
    symlinkSync('/etc/passwd', join(workspacePath, 'sequences/plasmids/passwd-link'));

    await expect(
      createSampleWorkspaceInstanceWithLock(
        { templateId: 'standard-samples' },
        { userDataPath: userData, resourcesRootPath: resourcesRoot }
      )
    ).rejects.toThrow(/symlinks/);
  });

  it('resolves dev and packaged sample resource roots', () => {
    const root = makeTempRoot();
    const desktopAppPath = join(root, 'apps/desktop');
    mkdirSync(join(desktopAppPath, 'resources/sample-workspaces'), { recursive: true });

    expect(
      resolveSampleWorkspaceResourceRoot({
        isPackaged: false,
        resourcesPath: '/ignored',
        appPath: desktopAppPath,
      })
    ).toBe(join(desktopAppPath, 'resources/sample-workspaces'));

    expect(
      resolveSampleWorkspaceResourceRoot({
        isPackaged: true,
        resourcesPath: '/Applications/DNAForge.app/Contents/Resources',
        appPath: desktopAppPath,
      })
    ).toBe(join('/Applications/DNAForge.app/Contents/Resources', 'sample-workspaces'));
  });
});

function createTemplate(): {
  resourcesRoot: string;
  userData: string;
  manifestPath: string;
  workspacePath: string;
} {
  const root = makeTempRoot();
  const resourcesRoot = join(root, 'resources/sample-workspaces');
  const templateRoot = join(resourcesRoot, 'standard-samples');
  const workspacePath = join(templateRoot, 'workspace');
  const packageDir = join(workspacePath, 'sequences/plasmids/pUC19');
  const userData = join(root, 'user-data');
  mkdirSync(join(packageDir, '.forge'), { recursive: true });
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(packageDir, 'pUC19.gb'), 'LOCUS       pUC19 1 bp DNA circular SYN\n//');
  writeFileSync(
    join(packageDir, '.forge/plasmid.json'),
    JSON.stringify({
      schema: 'waypoint.sequence.v1',
      kind: 'sequence',
      formatVersion: SEQUENCE_PACKAGE_FORMAT_VERSION,
      id: 'fixture-puc19',
      name: 'pUC19',
      product: { file: 'pUC19.gb' },
    })
  );
  const manifestPath = join(templateRoot, 'manifest.json');
  writeManifest(manifestPath, [
    { id: 'puc19', label: 'pUC19 plasmid', path: 'sequences/plasmids/pUC19' },
  ]);
  return { resourcesRoot, userData, manifestPath, workspacePath };
}

function writeManifest(
  manifestPath: string,
  assets: Array<{ id: string; label: string; path: string }>
): void {
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        templateId: 'standard-samples',
        version: 'v1',
        displayName: 'DNAForge Samples',
        assets,
      },
      null,
      2
    )
  );
}

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dnaforge-sample-workspace-'));
  tempRoots.push(root);
  return root;
}

type FactoryCopyOutcome =
  | { status: 'pending' }
  | {
      status: 'fulfilled';
      value: Awaited<ReturnType<typeof createSampleWorkspaceInstanceWithLock>>;
    }
  | { status: 'rejected'; reason: unknown };

function beginFactoryCopyProbe(
  template: ReturnType<typeof createTwoPackageCopyTemplate>,
  holdMode: 'first' | 'all'
) {
  expect(factoryCopyProbe.copies.size).toBe(0);
  expect(factoryCopyProbe.metadata.size).toBe(0);
  expect(factoryCopyProbe.runnableCopies.size).toBe(0);
  factoryCopyProbe.active = true;
  factoryCopyProbe.holdMode = holdMode;
  factoryCopyProbe.calls.length = 0;
  factoryCopyProbe.held.length = 0;
  factoryCopyProbe.operations.length = 0;
  factoryCopyProbe.peak = 0;
  factoryCopyProbe.completed = 0;
  factoryCopyProbe.expectedCopies = template.relativeFiles.length;
  factoryCopyProbe.failureInjected = false;
  factoryCopyProbe.cleanupBeforeDrain = false;
  factoryCopyProbe.publicationBeforeDrain = false;
  const outcome: { current: FactoryCopyOutcome } = { current: { status: 'pending' } };
  const promise = createSampleWorkspaceInstanceWithLock(
    { templateId: 'standard-samples' },
    { userDataPath: template.userData, resourcesRootPath: template.resourcesRoot }
  );
  const settled = promise.then(
    (value) => {
      outcome.current = { status: 'fulfilled', value };
    },
    (reason: unknown) => {
      outcome.current = { status: 'rejected', reason };
    }
  );
  return { outcome, settled };
}

async function drainFactoryCopyDiscovery(): Promise<void> {
  for (;;) {
    await Promise.allSettled([...factoryCopyProbe.metadata, ...factoryCopyProbe.runnableCopies]);
    await nextFactoryTurn();
    if (factoryCopyProbe.metadata.size === 0 && factoryCopyProbe.runnableCopies.size === 0) return;
  }
}

async function finishFactoryCopyProbe(settled: Promise<void>): Promise<void> {
  factoryCopyProbe.holdMode = 'none';
  for (const gate of factoryCopyProbe.held) gate.release();
  await settled;
  await drainFactoryCopyDiscovery();
  await Promise.allSettled(factoryCopyProbe.operations);
  await drainFactoryCopyDiscovery();
  factoryCopyProbe.active = false;
}

function createTwoPackageCopyTemplate() {
  const template = createTemplate();
  const first = join(template.workspacePath, 'sequences/plasmids/pUC19');
  const second = join(template.workspacePath, 'sequences/plasmids/pBR322');
  mkdirSync(join(second, '.forge'), { recursive: true });
  writeFileSync(join(first, 'notes.txt'), 'owned first package notes\n');
  writeFileSync(join(second, 'notes.txt'), 'owned second package notes\n');
  writeFileSync(join(second, 'pBR322.gb'), 'LOCUS       pBR322 1 bp DNA circular SYN\n//');
  writeFileSync(
    join(second, '.forge/plasmid.json'),
    JSON.stringify({
      schema: 'waypoint.sequence.v1',
      kind: 'sequence',
      formatVersion: SEQUENCE_PACKAGE_FORMAT_VERSION,
      id: 'fixture-pbr322',
      name: 'pBR322',
      product: { file: 'pBR322.gb' },
    })
  );
  writeManifest(template.manifestPath, [
    { id: 'puc19', label: 'pUC19 plasmid', path: 'sequences/plasmids/pUC19' },
    { id: 'pbr322', label: 'pBR322 plasmid', path: 'sequences/plasmids/pBR322' },
  ]);
  assertWorkspaceShape(template.workspacePath, 'Owned two-package copy fixture');
  const relativeFiles = [
    'sequences/plasmids/pUC19/.forge/plasmid.json',
    'sequences/plasmids/pUC19/notes.txt',
    'sequences/plasmids/pUC19/pUC19.gb',
    'sequences/plasmids/pBR322/.forge/plasmid.json',
    'sequences/plasmids/pBR322/notes.txt',
    'sequences/plasmids/pBR322/pBR322.gb',
  ];
  return {
    ...template,
    packageRoots: [first, second],
    relativeFiles,
    destination: join(template.userData, 'Sample Workspaces/standard-samples/v1'),
  };
}

describe('sample workspace whole-template copy admission', () => {
  it('admits an independent package copy before the first held copy settles', async () => {
    const template = createTwoPackageCopyTemplate();
    const probe = beginFactoryCopyProbe(template, 'first');
    try {
      await drainFactoryCopyDiscovery();
      expect(
        factoryCopyProbe.calls.length,
        'WHOLE_TEMPLATE_COPY_REMAINED_SERIAL_BEHIND_FIRST_FILE'
      ).toBeGreaterThanOrEqual(2);
      const firstCopy = factoryCopyProbe.calls[0];
      expect(firstCopy).toBeDefined();
      const firstPackage = template.packageRoots.find((root) =>
        firstCopy.from.startsWith(root + sep)
      );
      expect(firstPackage).toBeDefined();
      expect(
        factoryCopyProbe.calls.some((copy) =>
          template.packageRoots.some(
            (root) => root !== firstPackage && copy.from.startsWith(root + sep)
          )
        ),
        'SECOND_PACKAGE_COPY_WAS_NOT_ADMITTED_BEFORE_FIRST_RELEASE'
      ).toBe(true);
      expect(probe.outcome.current.status).toBe('pending');
    } finally {
      await finishFactoryCopyProbe(probe.settled);
    }
    expect(probe.outcome.current.status).toBe('fulfilled');
  });

  it('keeps at most four unsettled copies across the complete nested template', async () => {
    const template = createTwoPackageCopyTemplate();
    const probe = beginFactoryCopyProbe(template, 'all');
    try {
      await drainFactoryCopyDiscovery();
      expect(factoryCopyProbe.calls.length).toBeGreaterThan(0);
      expect(
        factoryCopyProbe.peak,
        'WHOLE_TEMPLATE_COPY_ADMISSION_EXCEEDED_GLOBAL_BOUND'
      ).toBeLessThanOrEqual(4);
      expect(probe.outcome.current.status).toBe('pending');
    } finally {
      await finishFactoryCopyProbe(probe.settled);
    }
    expect(factoryCopyProbe.peak).toBeLessThanOrEqual(4);
    expect(probe.outcome.current.status).toBe('fulfilled');
  });

  it('publishes no sample marker or import authority until every copy succeeds', async () => {
    const template = createTwoPackageCopyTemplate();
    const probe = beginFactoryCopyProbe(template, 'all');
    try {
      await drainFactoryCopyDiscovery();
      expect(factoryCopyProbe.calls.length).toBeGreaterThan(0);
      expect(probe.outcome.current.status).toBe('pending');
      expect(existsSync(template.destination)).toBe(false);
      expect(
        await resolveAppCreatedSampleWorkspaceSource(join(template.destination, 'workspace'))
      ).toBeNull();
      expect(factoryCopyProbe.publicationBeforeDrain).toBe(false);
    } finally {
      await finishFactoryCopyProbe(probe.settled);
    }
    expect(probe.outcome.current.status).toBe('fulfilled');
    if (probe.outcome.current.status !== 'fulfilled')
      throw new Error('FACTORY_COPY_DID_NOT_FINISH_AFTER_RELEASE');
    const instance = probe.outcome.current.value;
    expect(existsSync(instance.markerPath)).toBe(true);
    expect(await resolveAppCreatedSampleWorkspaceSource(instance.rootPath)).toEqual({
      rootPath: realpathSync(instance.rootPath),
      displayName: instance.displayName,
    });
    for (const relativePath of template.relativeFiles) {
      expect(readFileSync(join(instance.rootPath, relativePath))).toEqual(
        readFileSync(join(template.workspacePath, relativePath))
      );
    }
    expect(factoryCopyProbe.calls).toHaveLength(template.relativeFiles.length);
    expect(factoryCopyProbe.publicationBeforeDrain).toBe(false);
  });

  it('drains admitted copies before failed temporary-workspace cleanup', async () => {
    const template = createTwoPackageCopyTemplate();
    const probe = beginFactoryCopyProbe(template, 'all');
    const failure = new Error('OWNED_TEMPLATE_COPY_REJECTED');
    try {
      await drainFactoryCopyDiscovery();
      const first = factoryCopyProbe.held[0];
      expect(first).toBeDefined();
      first.reject(failure);
      await drainFactoryCopyDiscovery();
      const outstanding = factoryCopyProbe.copies.size;
      if (outstanding > 0) {
        expect(
          probe.outcome.current.status,
          'FACTORY_REJECTED_BEFORE_ADMITTED_COPIES_SETTLED'
        ).toBe('pending');
      }
      expect(
        factoryCopyProbe.cleanupBeforeDrain,
        'FACTORY_CLEANED_TEMPORARY_ROOT_BEFORE_COPY_DRAIN'
      ).toBe(false);
      expect(factoryCopyProbe.publicationBeforeDrain).toBe(false);
      expect(existsSync(template.destination)).toBe(false);
      expect(
        await resolveAppCreatedSampleWorkspaceSource(join(template.destination, 'workspace'))
      ).toBeNull();
    } finally {
      await finishFactoryCopyProbe(probe.settled);
    }
    expect(probe.outcome.current.status).toBe('rejected');
    if (probe.outcome.current.status !== 'rejected')
      throw new Error('FACTORY_COPY_REJECTION_WAS_LOST');
    expect(probe.outcome.current.reason).toBe(failure);
    expect(factoryCopyProbe.copies.size).toBe(0);
    expect(factoryCopyProbe.cleanupBeforeDrain).toBe(false);
    expect(factoryCopyProbe.publicationBeforeDrain).toBe(false);
    expect(existsSync(template.destination)).toBe(false);
    expect(existsSync(template.workspacePath)).toBe(true);
  });
});
