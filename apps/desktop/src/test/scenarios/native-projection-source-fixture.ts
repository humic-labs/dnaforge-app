import { platform } from '../../platform';
import { createTrackedEmptyWorkspace } from '../../features/workspace-loader/workspace-created-telemetry';

export async function materializeNativeProjectionSource(input: {
  projectName: string;
  relativePath: string;
  sha256: string;
}): Promise<{ project: string; path: string }> {
  const bridge = platform();
  const checkout = await bridge.path.projectRoot();
  if (!checkout) throw new Error('Native projection examples require a development checkout.');
  const project = await createTrackedEmptyWorkspace({ name: input.projectName });
  const imported = await bridge.workspace.importFile({
    targetRoot: project.rootPath,
    sourcePath: `${checkout}/test-fixtures/${input.relativePath}`,
  });
  const hash = await bridge.fs.contentHash({
    workspaceRoot: project.rootPath,
    workspaceRelativePath: imported.relPath,
  });
  if (hash !== `sha256:${input.sha256}`)
    throw new Error('The imported native projection source differs from its registered fixture.');
  return { project: project.rootPath, path: imported.relPath };
}
