import { afterEach, describe, expect, it } from 'vitest';
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
