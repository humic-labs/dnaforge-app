import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

import { describe, expect, it } from 'vitest';
import { GIT_READ_CONFIG_ARGS } from '../ipc/git-read-policy';

function handlerBody(
  source: string,
  contract: string,
  method: string,
  mutationCall?: string
): string {
  const tree = ts.createSourceFile(`${contract}.ts`, source, ts.ScriptTarget.Latest, true);
  const groups: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'handleGroup' &&
      node.arguments[0] &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === contract
    )
      groups.push(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (groups.length !== 1) throw new Error(`Expected one ${contract} registration`);
  const group = groups[0].arguments[1];
  if (!group || !ts.isObjectLiteralExpression(group))
    throw new Error(`Expected literal ${contract} handlers`);
  const handlers = group.properties.filter(
    (node): node is ts.PropertyAssignment =>
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === method
  );
  if (handlers.length !== 1) throw new Error(`Expected one ${contract}.${method} handler`);
  if (!mutationCall) return handlers[0].getText(tree);
  const calls: ts.CallExpression[] = [];
  const findMutation = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === mutationCall
    )
      calls.push(node);
    ts.forEachChild(node, findMutation);
  };
  findMutation(handlers[0]);
  if (calls.length !== 1) throw new Error(`Expected one ${mutationCall} in ${contract}.${method}`);
  return calls[0].getText(tree);
}

describe('prepared reference runtime write surface', () => {
  it('guards every renderer cache writer and broad-raster repair before mutation', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/main/ipc/genome-data.ts'), 'utf8');

    for (const [channel, writer] of [
      ['genome:writeAssemblyOverviewTexture', 'writeAssemblyOverviewTextureCache(input'],
      ['genome:writeAssemblyAnnotationScene', 'writeAssemblyAnnotationSceneCache(input'],
      ['genome:writeAssemblyOverviewFeatures', 'writeAssemblyOverviewFeaturesCache(input'],
    ] as const) {
      const handlerStart = source.indexOf(`'${channel}'`);
      const guard = source.indexOf(
        'assertViewerRuntimeWriteAllowed(input.workspaceRoot)',
        handlerStart
      );
      const mutation = source.indexOf(writer, handlerStart);
      expect(handlerStart, `${channel} handler`).toBeGreaterThanOrEqual(0);
      expect(guard, `${channel} reference-cache guard`).toBeGreaterThan(handlerStart);
      expect(mutation, `${channel} mutation`).toBeGreaterThan(guard);
    }

    const repair = source.indexOf('compiledBroadRasterPreparation.repairKnownCorruptArtifact');
    const repairGuard = source.lastIndexOf(
      'isPreparedReferenceRuntimePath(repairInput.scene.workspaceRoot)',
      repair
    );
    expect(repair).toBeGreaterThanOrEqual(0);
    expect(repairGuard).toBeGreaterThanOrEqual(0);
    expect(repairGuard).toBeLessThan(repair);
  });

  it('marks every prepared reference child session with its admitted generation', async () => {
    const source = await readFile(
      resolve(process.cwd(), 'src/features/sequence/components/IndexedGenomeTab.tsx'),
      'utf8'
    );
    const internalIntent = source.indexOf("kind: 'internal-assembly-segment' as const");
    const generation = source.lastIndexOf(
      'assetGeneration: activeAnnotationAssetGeneration',
      internalIntent + 200
    );

    expect(internalIntent).toBeGreaterThanOrEqual(0);
    expect(generation).toBeGreaterThanOrEqual(0);
  });

  it('routes generic renderer filesystem mutations through the same boundary', async () => {
    const [filesystem, shell] = await Promise.all([
      readFile(resolve(process.cwd(), 'src/main/ipc/filesystem.ts'), 'utf8'),
      readFile(resolve(process.cwd(), 'src/main/ipc/shell.ts'), 'utf8'),
    ]);

    for (const method of ['writeTextFile', 'mkdir', 'rename', 'move']) {
      const body = handlerBody(filesystem, 'fsContract', method);
      expect(body, `fs.${method} writable-path lease`).toContain('withSafeWritablePath');
      expect(body, `fs.${method} workspace-mutation authority`).toContain(
        'withKnownWorkspaceMutation'
      );
    }

    for (const method of ['trashItem', 'execute']) {
      const body = handlerBody(shell, 'shellContract', method);
      expect(body, `shell.${method} writable-path lease`).toContain('withSafeWritablePath');
    }
  });

  it('operates on the canonical path returned by the writable-path boundary', async () => {
    const [filesystem, shell, managedGit] = await Promise.all([
      readFile(resolve(process.cwd(), 'src/main/ipc/filesystem.ts'), 'utf8'),
      readFile(resolve(process.cwd(), 'src/main/ipc/shell.ts'), 'utf8'),
      readFile(resolve(process.cwd(), 'src/main/workspace-git/native.ts'), 'utf8'),
    ]);

    expect(filesystem).toContain('return withSafeWritablePath(path, (safePath)');
    expect(filesystem).toContain('await writeFile(safePath, content');
    expect(filesystem).toContain('mkdir(safePath');
    expect(filesystem).toContain('renamePathWithoutReplacement(safeOldPath, safeNewPath)');
    expect(filesystem).toContain(
      'const plan = planMoveIntoDirectory(safeSourcePath, safeDestinationDir)'
    );
    expect(filesystem).toContain(
      'await movePathWithoutReplacement(safeSourcePath, destPath, assertCurrent,'
    );
    const trash = handlerBody(shell, 'shellContract', 'trashItem');
    expect(trash).toContain('withSafeWritablePath(path,');
    const mutation = handlerBody(
      shell,
      'shellContract',
      'trashItem',
      'withKnownRendererFilesystemMutation'
    );
    expect(mutation).toContain('withKnownRendererFilesystemMutation({');
    expect(mutation).toContain('db: getDb(),');
    expect(mutation).toContain('paths: [safePath]');
    expect(mutation).toContain('return shell.trashItem(safePath);');
    expect(handlerBody(shell, 'shellContract', 'execute')).toContain(
      'await executeManagedGitProcess(safeCwd, invocation,'
    );
    expect(managedGit).toContain("import { GIT_READ_CONFIG_ARGS } from '../ipc/git-read-policy';");
    expect(managedGit).toMatch(
      /const MANAGED_GIT_CONFIG_ARGS = Object\.freeze\(\[\s*\.\.\.GIT_READ_CONFIG_ARGS,/u
    );
    expect(managedGit).toMatch(
      /return execute\(\s*STERILE_GIT_READ_RUNTIME\.executable,\s*\[\.\.\.MANAGED_GIT_CONFIG_ARGS, '--literal-pathspecs', \.\.\.commandArgs\],\s*\{\s*cwd: dir,/u
    );
    const hooksPathIndex = GIT_READ_CONFIG_ARGS.indexOf('core.hooksPath=/dev/null');
    expect(hooksPathIndex).toBeGreaterThan(0);
    expect(GIT_READ_CONFIG_ARGS[hooksPathIndex - 1]).toBe('-c');
  });
});
