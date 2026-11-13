import { isTabDirty } from '../canvas/public/artifact-document-lifecycle';
import { withUserMessage } from '@waypoint/user-messages';
import { platform } from '../../platform';
import { isBrowserOnly } from '../../utils/environment';
import { flushFileDocumentClients } from './file-document-client';
import { useCanvasStore } from '../canvas/public/store';
import { useSequenceStore } from '../sequence/public/store';
import { resolveSequenceDocument } from '../sequence/public/sequence-document-repository';
import { getCurrentCatalogFileForEntity } from '../../db/workspace-catalog';
import { isAbsolutePathLike, pathIsAtOrUnder } from '../../shared/path-boundary';

export async function assertWorkspaceDocumentsClean(targetPath: string) {
  if (!isBrowserOnly()) {
    await flushFileDocumentClients();
    await platform().fs.assertFileDocumentsClean(targetPath);
  }
  const store = useSequenceStore.getState();
  for (const tab of Object.values(useCanvasStore.getState().panels).flatMap(
    (panel) => panel.tabs
  )) {
    if (!isTabDirty(tab) && !(tab.type === 'sequence' && store.isDirty(tab.entityId))) continue;
    const source = tab.sequenceDocument
      ? (await resolveSequenceDocument(tab.sequenceDocument)).sourcePath
      : isAbsolutePathLike(tab.entityId)
        ? tab.entityId
        : (await getCurrentCatalogFileForEntity(tab.entityId))?.path;
    if (!source)
      throw new Error(
        'An open dirty document has no current file binding. Save or discard it before changing its project.'
      );
    if (pathIsAtOrUnder(source, targetPath))
      throw withUserMessage(
        new Error('Save or discard the affected document draft first.'),
        'validation.compatible.35'
      );
  }
}
