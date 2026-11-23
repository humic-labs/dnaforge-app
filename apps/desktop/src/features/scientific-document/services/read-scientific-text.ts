import type { ScientificAcceptedDocumentRevision } from '@waypoint/domain-services';
import { platform } from '../../../platform';
import { readCompressedGenBank } from '../../../shared/compressed-genbank-reader';
import { isCompressedGenBankPath } from '../../../shared/scientific-file-types';
import { isBrowserOnly, isHostedBrowserRuntime } from '../../../utils/environment';
import { readDesktopScientificDocument } from './desktop-scientific-documents';

export async function readScientificText(
  filePath: string,
  workspaceRoot: string | null,
  readLegacy: (path: string) => Promise<string> = (path) => platform().fs.readTextFile(path),
  acceptedHead?: string
): Promise<{ content: string; acceptedRevision: ScientificAcceptedDocumentRevision | null }> {
  if (!workspaceRoot || isBrowserOnly() || isHostedBrowserRuntime()) {
    const content = isCompressedGenBankPath(filePath)
      ? await readCompressedGenBank(await platform().fs.readFile(filePath))
      : await readLegacy(filePath);
    return { content, acceptedRevision: null };
  }
  const result = await readDesktopScientificDocument({ filePath, workspaceRoot, acceptedHead });
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return {
    content: result.document.content,
    acceptedRevision:
      result.document.revision.kind === 'accepted-object' ? result.document.revision : null,
  };
}
