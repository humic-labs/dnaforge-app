import { platform } from '../../../platform';
import type { ImportFileResult } from '../../../shared/workspace-git-types';

export interface TabularSourceBytes {
  fileName: string;
  sourcePath?: string;
  text?: string;
  arrayBuffer?: ArrayBuffer;
}

export async function copyTabularSourceIntoWorkspace(
  targetRoot: string,
  source: TabularSourceBytes
): Promise<ImportFileResult> {
  if (source.sourcePath) {
    return platform().workspace.importFile({ sourcePath: source.sourcePath, targetRoot });
  }
  if (source.arrayBuffer) {
    return platform().workspace.importFileFromContent({
      targetRoot,
      fileName: source.fileName,
      contentBytes: source.arrayBuffer,
    });
  }
  if (source.text != null) {
    return platform().workspace.importFileFromContent({
      targetRoot,
      fileName: source.fileName,
      content: source.text,
    });
  }
  throw new Error(`No source bytes available to save "${source.fileName}" into the project.`);
}
