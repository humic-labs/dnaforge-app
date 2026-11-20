import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function contractHandler(content: string, method: string): string {
  const group = content.slice(content.indexOf('handleGroup(fsContract, {'));
  const start = group.search(new RegExp(`\\n    ${method}: `));
  expect(start, `fs.${method}`).toBeGreaterThan(0);
  const next = group.slice(start + 1).search(/\n    [A-Za-z0-9]+: /);
  return group.slice(start, next < 0 ? group.indexOf('\n  });') : start + 1 + next);
}

describe('filesystem IPC boundary', () => {
  const fsHandlerPath = resolve(__dirname, 'filesystem.ts');
  const content = readFileSync(fsHandlerPath, 'utf8');

  it('rejects relative paths with an error (not just a warning)', () => {
    expect(content).not.toContain("console.warn('[fs:readTextFile] Received RELATIVE path");

    expect(content).toContain('throw new Error');
    expect(content).toContain('must be absolute');
  });

  it('checks isAbsolute before any file operations', () => {
    const readTextFileHandler = contractHandler(content, 'readTextFile');
    const isAbsolutePos = readTextFileHandler.indexOf('isAbsolute');
    const assertSafePos = readTextFileHandler.indexOf('assertSafePath');
    const readFilePos = readTextFileHandler.indexOf('readFile');

    expect(isAbsolutePos).toBeGreaterThan(0);
    expect(assertSafePos).toBeGreaterThan(isAbsolutePos);
    expect(readFilePos).toBeGreaterThan(assertSafePos);
  });

  it('returns canonical, nanosecond-safe generation metadata from fs:stat', () => {
    const handler = contractHandler(content, 'stat');

    expect(handler).toContain('const canonicalPath = await assertSafePath(path)');
    expect(handler).toContain('stat(canonicalPath, { bigint: true })');
    expect(handler).toContain('mtimeNs: s.mtimeNs.toString()');
    expect(handler).toContain('ctimeNs: s.ctimeNs.toString()');
    expect(handler).toContain('device: s.dev.toString()');
    expect(handler).toContain('inode: s.ino.toString()');
  });

  it('keeps expected missing-path existence probes quiet without hiding authorization errors', () => {
    const handler = contractHandler(content, 'exists');

    expect(handler).toContain("code === 'ENOENT' || code === 'ENOTDIR'");
    expect(handler).toContain('throw error');
  });

  it('reenters an owning renderer mutation before attempting a second workspace lock', () => {
    const handler = contractHandler(content, 'beginWorkspaceMutation');
    const lifecycle = handler.indexOf('mutationRendererLifecycle.register(event.sender)');
    const pathAdmission = handler.indexOf('await assertSafePath(workspaceRoot');
    const reentry = handler.indexOf('workspaceMutationCapabilities.issueReentry');
    const acquire = handler.indexOf('acquireWorkspaceMutationShared');
    expect(lifecycle).toBeGreaterThan(0);
    expect(pathAdmission).toBeGreaterThan(lifecycle);
    expect(reentry).toBeGreaterThan(0);
    expect(acquire).toBeGreaterThan(reentry);
    const recovery = handler.indexOf('await recoverNativeCatalogRecordPublications');
    const tokenIssue = handler.indexOf('workspaceMutationCapabilities.issue(event.sender.id');
    expect(recovery).toBeGreaterThan(acquire);
    expect(tokenIssue).toBeGreaterThan(recovery);
  });

  it('releases renderer-owned mutation state when the main frame reloads or navigates', () => {
    const start = content.indexOf('const mutationRendererLifecycle');
    const end = start + content.slice(start).search(/mainIpc\.handle\(|handleGroup\(/);
    const lifecycle = content.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(lifecycle).toContain('new RendererOwnerLifecycle(');
    expect(lifecycle).toContain('workspaceMutationCapabilities.releaseOwner(sender.id)');
    expect(lifecycle).toContain('packageScratchCapabilities.releaseOwner(sender.id)');
    expect(lifecycle).toContain('controller.abort()');
    expect(lifecycle).toContain('pendingMutationWaits.delete(sender)');
  });

  it('coalesces and caps renderer-owned queued mutation waits', () => {
    const handler = contractHandler(content, 'beginWorkspaceMutation');

    expect(handler).toContain('WORKSPACE_MUTATION_WAIT_ALREADY_PENDING');
    expect(handler).toContain('WORKSPACE_MUTATION_RENDERER_WAIT_LIMIT');
    expect(handler).toContain('signal: waitController.signal');
  });
});

describe('filesystem IPC hard cap  Layer B)', () => {
  const fsHandlerPath = resolve(__dirname, 'filesystem.ts');
  const content = readFileSync(fsHandlerPath, 'utf8');

  it('imports HARD_CAP_BYTES + OversizedFileError from the shared module', () => {
    expect(content).toContain('HARD_CAP_BYTES');
    expect(content).toContain('OversizedFileError');
    expect(content).toContain("from '../../shared/oversized-guard'");
  });

  it('readTextFile stats before reading and throws above the cap', () => {
    const handler = contractHandler(content, 'readTextFile');
    expect(handler).toContain('await stat(path)');
    expect(handler).toMatch(/if\s*\(\s*s\.size\s*>\s*HARD_CAP_BYTES\s*\)/);
    expect(handler).toContain('throw new OversizedFileError');
  });

  it('readFile (binary) also enforces the hard cap', () => {
    const handler = contractHandler(content, 'readFile');
    expect(handler).toContain('await stat(path)');
    expect(handler).toContain('throw new OversizedFileError');
  });

  it('sha256File streams exact bytes outside the renderer and preserves the hard cap', () => {
    const handler = contractHandler(content, 'sha256File');
    expect(handler).toContain('isAbsolute');
    expect(handler).toContain('assertSafePath(path)');
    expect(handler).toContain('await stat(path)');
    expect(handler).toContain('throw new OversizedFileError');
    expect(handler).toContain("createHash('sha256')");
    expect(handler).toContain('createReadStream(path)');
    expect(handler).not.toMatch(/await\s+readFile\(/);
  });

  it('readTextFileSlice validates safe absolute paths and bounds reads by HARD_CAP_BYTES', () => {
    const handler = contractHandler(content, 'readTextFileSlice');
    expect(handler).toContain('isAbsolute');
    expect(handler).toContain('assertSafePath(path)');
    expect(handler).toContain('maxBytes > HARD_CAP_BYTES');
    expect(handler).toContain("await open(path, 'r')");
    expect(handler).toContain('handle.read');
  });

  it('rename and move refuse a source symbolic link', () => {
    const renameHandler = contractHandler(content, 'rename');
    const moveHandler = contractHandler(content, 'move');
    expect(renameHandler).toContain('lstat(safeOldPath)');
    expect(renameHandler).toContain('isSymbolicLink');
    expect(renameHandler).toContain('Refusing to rename through a symbolic link');
    expect(moveHandler).toContain('lstat(safeSourcePath)');
    expect(moveHandler).toContain('isSymbolicLink');
    expect(moveHandler).toContain('Refusing to move through a symbolic link');
  });

  it('writeTextFile refuses to follow a leaf symbolic link', () => {
    const handler = contractHandler(content, 'writeTextFile');
    expect(handler).toContain('lstat(safePath)');
    expect(handler).toContain('isSymbolicLink');
    expect(handler).toContain('Refusing to write through a symbolic link');
  });

  it('admits only the selected atomic-save destination before the main-process commit', () => {
    const handler = contractHandler(content, 'writeTextFileAtomic');

    expect(handler).toContain('assertTextFileAtomicWriteInput(input)');
    expect(handler).toContain('withSafeWritablePath(');
    expect(handler).toContain('input.path,');
    expect(handler).toContain('requireAbsolute: true');
    expect(handler).toContain("errorPrefix: 'fs:writeTextFileAtomic'");
    expect(handler).toMatch(
      /writeTextFileAtomicInMain\(\s*\{\s*\.\.\.input,\s*path\s*\},\s*\{\s*beforePublish:\s*\(staged\) => \{\s*assertCurrent\(\);\s*mark\(staged\);/
    );
    expect(handler).not.toContain('workspaceRoot');
    expect(handler).not.toContain('withSafeWritablePaths');
  });

  it('validates every renderer-supplied notebook authority path before main-process mutation', () => {
    const start = content.indexOf("'fs:publishNotebookPackageV2'");
    const end = content.indexOf("'fs:packageSequenceFile'", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const handlers = content.slice(start, end);

    expect(handlers).toContain('assertSafePath(input.workspaceRoot');
    expect(handlers).toContain('withSafeWritablePath(input.packageRoot');
    expect(handlers).toContain('[{ path: input.packageRoot }, { path: input.nextPackageRoot }]');
    expect(handlers).toContain('withDeclaredRendererFilesystemMutation({');
    expect(handlers).toContain('workspaceRoot');
    expect(handlers).toContain('mutationPaths: [packageRoot]');
    expect(handlers).toContain('mutationToken: input.mutationToken');
    expect(handlers).not.toContain('withKnownWorkspaceMutation(event.sender.id, [packageRoot]');
  });
});

describe('filesystem package scratch capability boundary ', () => {
  const fsHandlerPath = resolve(__dirname, 'filesystem.ts');
  const content = readFileSync(fsHandlerPath, 'utf8');
  const start = content.indexOf("'fs:createPackageScratch'");
  const end = content.indexOf("'fs:convertFileSrc'", start);
  const handlers = content.slice(start, end);

  it('creates scratch in main and binds the lease to the requesting renderer', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(handlers).toContain('assertInsideKnownWorkspace(safePackageRoot');
    expect(handlers).toContain('assertExistingPlasmidPackageRoot(safePackageRoot)');
    expect(handlers).toContain('authorizedExistingMembers');
    expect(handlers).not.toContain('allowPackageMemberMoves');
    expect(handlers).toContain('requireAbsolute: true');
    expect(handlers).toContain('mutationRendererLifecycle.register(event.sender)');
  });

  it('borrows the owning finalize transaction instead of taking a second workspace lock', () => {
    expect(handlers).toContain('mutationToken?: string');
    expect(handlers).toContain('workspaceMutationCapabilities.issueReentry(');
    expect(handlers).toContain('mutationToken,');
    expect(handlers).toContain('mutationRelease: releaseMutation');
  });

  it('removes scratch only through an opaque token, never a renderer-selected path', () => {
    const removeStart = handlers.indexOf("'fs:removePackageScratch'");
    const removeHandler = handlers.slice(removeStart);
    expect(removeStart).toBeGreaterThan(0);
    expect(removeHandler).toContain(
      'packageScratchCapabilities.remove(cleanupToken, event.sender.id)'
    );
    expect(removeHandler).not.toContain('isForgePackageScratchPath');
    expect(removeHandler).not.toContain('dirPath');
    expect(removeHandler).not.toMatch(/\brm\s*\(/);
  });

  it('rejects a generic rename across active scratch before waiting on the workspace lock', () => {
    const renameHandler = contractHandler(content, 'rename');
    const preflight = renameHandler.indexOf(
      'packageScratchCapabilities.assertGenericMutationAllowed(safeOldPath, safeNewPath)'
    );
    const workspaceLock = renameHandler.indexOf('withKnownWorkspaceMutation(');
    expect(preflight).toBeGreaterThan(0);
    expect(workspaceLock).toBeGreaterThan(preflight);
  });

  it('rejects a generic move across active scratch before waiting on the workspace lock', () => {
    const moveHandler = contractHandler(content, 'move');
    const preflight = moveHandler.search(
      /packageScratchCapabilities\.assertGenericMutationAllowed\(\s*safeSourcePath,\s*safeDestinationDir,\s*destPath\s*\)/
    );
    const workspaceLock = moveHandler.indexOf('withKnownWorkspaceMutation(');
    expect(preflight).toBeGreaterThan(0);
    expect(workspaceLock).toBeGreaterThan(preflight);
  });
});

describe('filesystem package-sequence workspace authority ', () => {
  const fsHandlerPath = resolve(__dirname, 'filesystem.ts');
  const content = readFileSync(fsHandlerPath, 'utf8');
  const start = content.indexOf("'fs:packageSequenceFile'");
  const end = content.indexOf("'fs:createPackageScratch'", start);
  const handler = content.slice(start, end);

  it('requires an overwrite source and package target to resolve to the same workspace', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(handler).toContain('sourceWorkspaceRoot');
    expect(handler).toContain('overwriteWorkspaceRoot');
    expect(handler).toContain(
      'assertSameKnownWorkspaceRoot(sourceWorkspaceRoot, overwriteWorkspaceRoot)'
    );
  });
});
