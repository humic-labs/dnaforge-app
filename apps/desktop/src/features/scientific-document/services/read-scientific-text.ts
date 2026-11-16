import type { ScientificAcceptedDocumentRevision } from '@waypoint/domain-services';
import { platform } from '../../../platform';
import { isBrowserOnly, isHostedBrowserRuntime } from '../../../utils/environment';
import { readDesktopScientificDocument } from './desktop-scientific-documents';
import { isDeveloperImportSourcePath } from '../../../shared/developer-import-sources';

export async function readScientificText(
  filePath: string,
  workspaceRoot: string | null,
  readLegacy: (path: string) => Promise<string> = (path) => platform().fs.readTextFile(path),
  acceptedHead?: string
): Promise<{ content: string; acceptedRevision: ScientificAcceptedDocumentRevision | null }> {
  if (
    !workspaceRoot ||
    isBrowserOnly() ||
    isHostedBrowserRuntime() ||
    isDeveloperImportSourcePath(filePath)
  )
    return { content: await readLegacy(filePath), acceptedRevision: null };
  const result = await readDesktopScientificDocument({ filePath, workspaceRoot, acceptedHead });
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return {
    content: result.document.content,
    acceptedRevision:
      result.document.revision.kind === 'accepted-object' ? result.document.revision : null,
  };
}
