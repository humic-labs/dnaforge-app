import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import {
  parseSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import {
  isMocloScenarioPresetId,
  MOCLO_SCENARIO_PRESETS,
  type MaterializeMocloScenarioKitRequest,
  type MaterializedMocloScenarioKit,
} from '../shared/internal-fixtures';
import { writeWorkspaceTextFileAtomicInMain } from './primer-artifact-files';

export class MocloScenarioPublicationError extends Error {
  readonly code = 'MOCLO_SCENARIO_PUBLICATION_INCOMPLETE';
  readonly stateMayHaveChanged = true;

  constructor(
    readonly publishedPaths: readonly string[],
    cause: unknown
  ) {
    super(
      `MOCLO_SCENARIO_PUBLICATION_INCOMPLETE: Published files were retained at ${publishedPaths.join(', ')}. ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  }
}

async function physicalDirectory(
  root: string,
  relativePath: string,
  create = false
): Promise<string> {
  let path = root;
  for (const segment of relativePath.split('/').filter(Boolean)) {
    path = join(path, segment);
    let entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!entry && create) {
      await mkdir(path);
      entry = await lstat(path);
    }
    if (!entry?.isDirectory() || entry.isSymbolicLink())
      throw new Error(`MoClo fixture directory is not a physical directory: ${path}`);
  }
  return path;
}

async function physicalFile(root: string, relativePath: string): Promise<string> {
  await physicalDirectory(root, posix.dirname(relativePath));
  const path = join(root, relativePath);
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new Error(`MoClo fixture source is not a regular file: ${path}`);
  return readFile(path, 'utf8');
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  );
}

export async function materializeMocloScenarioKit(
  request: MaterializeMocloScenarioKitRequest,
  resourcesRoot: string,
  assertCurrent: () => void
): Promise<MaterializedMocloScenarioKit> {
  if (
    !isMocloScenarioPresetId(request?.presetId) ||
    Object.keys(request).some(
      (key) => !['workspaceRoot', 'presetId', 'reuseExisting'].includes(key)
    ) ||
    (request.reuseExisting !== undefined && request.reuseExisting !== true)
  )
    throw new Error('MoClo materialization requires a registered bundled scenario preset.');
  assertCurrent();
  const root = await realpath(request.workspaceRoot);
  if (root !== request.workspaceRoot || !(await lstat(root)).isDirectory())
    throw new Error('MoClo materialization requires the canonical admitted project root.');
  const source = await realpath(join(resourcesRoot, 'standard-samples', 'workspace'));
  const kitId = MOCLO_SCENARIO_PRESETS[request.presetId];
  const kitRelativeRoot = `sequences/kits/moclo-${kitId}`;
  const definitionPath = `.forge/moclo-kits/${kitId}.json`;
  const kitRoot = await physicalDirectory(source, kitRelativeRoot);
  const definition = JSON.parse(await physicalFile(source, definitionPath)) as {
    schema: string;
    id: string;
    members: Array<{ id: string; sequencePackageId: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  if (
    definition.schema !== 'dnaforge.moclo-kit' ||
    definition.id !== (kitId === 'cidar' ? 'moclo-cidar' : 'ytk') ||
    !Array.isArray(definition.members)
  )
    throw new Error('The bundled MoClo kit definition is invalid.');
  const packages: MaterializedMocloScenarioKit['packages'] = [];
  const files = new Map<string, string>();
  const sourceIds = new Set<string>();
  const destinationExists = await exists(join(root, kitRelativeRoot));
  const definitionExists = await exists(join(root, definitionPath));
  if (
    (destinationExists || definitionExists) &&
    (!request.reuseExisting || !destinationExists || !definitionExists)
  )
    throw new Error('MoClo fixture destination already exists or is incomplete.');
  for (const entry of (await readdir(kitRoot, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('The bundled MoClo kit contains an unsupported package entry.');
    const relativeRoot = `${kitRelativeRoot}/${entry.name}`;
    const metaPath = `${relativeRoot}/.forge/plasmid.json`;
    const document = parseSequencePackageDocument(await physicalFile(source, metaPath));
    if (sourceIds.has(document.id))
      throw new Error('The bundled MoClo kit repeats a package identity.');
    sourceIds.add(document.id);
    const productRelativePath = `${relativeRoot}/${document.product.file}`;
    if (
      posix.normalize(productRelativePath) !== productRelativePath ||
      !document.product.file.endsWith('.gb') ||
      document.product.file.includes('/')
    )
      throw new Error('The bundled MoClo sequence product path is invalid.');
    const product = await physicalFile(source, productRelativePath);
    if (product.startsWith('version https://git-lfs.github.com/spec/v1'))
      throw new Error('The bundled MoClo sequence product has not been hydrated.');
    const packageId = destinationExists
      ? parseSequencePackageDocument(await physicalFile(root, metaPath)).id
      : randomUUID();
    if (
      !/^[0-9a-f-]{36}$/i.test(packageId) ||
      packages.some((item) => item.packageId === packageId)
    )
      throw new Error('The copied MoClo package identities are invalid or repeated.');
    files.set(metaPath, serializeSequencePackageDocument({ ...document, id: packageId }));
    files.set(productRelativePath, product);
    packages.push({ sourcePackageId: document.id, packageId, relativeRoot, productRelativePath });
  }
  if (packages.length === 0)
    throw new Error('The bundled MoClo kit contains no sequence packages.');
  const identities = new Map(packages.map((item) => [item.sourcePackageId, item.packageId]));
  const members = definition.members.map((member) => {
    const packageId = identities.get(member.sequencePackageId);
    if (!packageId) throw new Error('The bundled MoClo kit references an unavailable package.');
    return { ...member, id: identities.get(member.id) ?? member.id, sequencePackageId: packageId };
  });
  files.set(definitionPath, `${JSON.stringify({ ...definition, members }, null, 2)}\n`);
  if (destinationExists) {
    for (const [path, expected] of files) {
      if ((await physicalFile(root, path)) !== expected)
        throw new Error(`The existing MoClo fixture changed and was preserved: ${path}`);
    }
    assertCurrent();
    return { files: [...files.keys()], packages };
  }
  const stage = await mkdtemp(join(root, '.dnaforge-moclo-scenario-'));
  const publishedPaths: string[] = [];
  try {
    try {
      for (const [path, content] of files) {
        if (path === definitionPath) continue;
        const stagedPath = join(stage, path);
        await mkdir(dirname(stagedPath), { recursive: true });
        await writeFile(stagedPath, content, { flag: 'wx' });
      }
      assertCurrent();
      await physicalDirectory(root, 'sequences/kits', true);
      await physicalDirectory(root, '.forge/moclo-kits', true);
      if ((await exists(join(root, kitRelativeRoot))) || (await exists(join(root, definitionPath))))
        throw new Error('The MoClo fixture destination changed before publication.');
      await rename(join(stage, kitRelativeRoot), join(root, kitRelativeRoot));
      publishedPaths.push(join(root, kitRelativeRoot));
      assertCurrent();
      const definition = await writeWorkspaceTextFileAtomicInMain(
        {
          workspaceRoot: root,
          path: join(root, definitionPath),
          content: files.get(definitionPath)!,
          mode: 'create',
          artifactNoun: 'MoClo kit',
        },
        { beforePublish: assertCurrent }
      );
      publishedPaths.push(definition.path);
      if (definition.cleanupWarning) throw new Error(definition.cleanupWarning);
      assertCurrent();
      return { files: [...files.keys()], packages };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  } catch (cause) {
    if (publishedPaths.length) throw new MocloScenarioPublicationError(publishedPaths, cause);
    throw cause;
  }
}
