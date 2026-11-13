import { platform } from '../../../platform';
import type { PlatformBridge } from '../../../platform/types';
import { parseHostedFsPath, hostedAbsolutePath } from '../../../hosted/paths';
import { withRendererWorkspaceMutation } from '../../../services/workspace-mutation-transaction';
import { stageAlignmentQueryPaths } from './stage-alignment-query';

export async function selectAlignmentQueryFiles(
  referencePath: string,
  options: Parameters<PlatformBridge['dialog']['open']>[0]
): Promise<string | string[] | null> {
  const location = parseHostedFsPath(referencePath);
  const workspaceId = location?.workspaceId;
  if (!workspaceId) return platform().dialog.open(options);
  const [
    { openHostedFileDialog },
    { importHostedSequenceFiles },
    { hostedWorkspaceSessionController },
  ] = await Promise.all([
    import('../../../hosted/open-file-dialog'),
    import('../../../hosted/import-files'),
    import('../../../hosted/controller'),
  ]);
  const expectedAccountId = hostedWorkspaceSessionController.getState().principal?.id;
  const assertPickerScope = () => {
    const current = hostedWorkspaceSessionController.getState();
    if (
      !expectedAccountId ||
      current.principal?.id !== expectedAccountId ||
      current.activeWorkspaceId !== workspaceId
    ) {
      throw new Error(
        'The account or project changed while choosing alignment files. Reopen the picker.'
      );
    }
  };
  return openHostedFileDialog(options, (files) => {
    assertPickerScope();
    const workspaceRoot = hostedAbsolutePath(workspaceId, '');
    return withRendererWorkspaceMutation(workspaceRoot, async (mutationToken) => {
      assertPickerScope();
      const imported = await importHostedSequenceFiles(
        files,
        undefined,
        async (writes) => {
          for (const write of writes) {
            assertPickerScope();
            await platform().fs.writeWorkspaceBinaryFileAtomic({
              workspaceRoot,
              path: hostedAbsolutePath(workspaceId, write.path),
              content: write.bytes,
              mutationToken,
              artifactNoun: 'sequencing file',
            });
          }
        },
        { convertSequences: false }
      );
      assertPickerScope();
      return {
        workspaceId: imported.workspaceId,
        paths: await stageAlignmentQueryPaths(referencePath, imported.paths),
      };
    });
  });
}
