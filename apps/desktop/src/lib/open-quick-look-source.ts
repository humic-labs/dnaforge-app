import {
  toUserMessage,
  userEntityLabel,
  userMessage,
  userMessageValue,
  userMessageWithValues,
} from '@waypoint/user-messages';
import { platform } from '../platform';
import { useToastStore } from '../stores/toast-store';
import type { FileAssociationFamilyId } from '../shared/file-associations';
import { openDocument } from '../features/document-opening/open-document';
import { presentedTabId } from '../features/canvas/document-presentation';
import type { FileOpenSourceSurface } from '../features/sequence/file-open-telemetry';

export interface OpenQuickLookSourceInput {
  readonly sourcePath: string;
  readonly familyId: FileAssociationFamilyId;
  readonly sourceSurface: FileOpenSourceSurface;
}

export async function openQuickLookSource(input: OpenQuickLookSourceInput): Promise<string | null> {
  try {
    const receipt = await platform().fileAssociations.materializeQuickLookPackage({
      sourcePath: input.sourcePath,
      familyId: input.familyId,
    });
    const result = await openDocument({
      target: { kind: 'sequence-package', path: receipt.packageRoot },
      label: receipt.sourceFileName,
      placement: { kind: 'focused' },
      source: input.sourceSurface,
      sequenceOptions: { presentation: { kind: 'quick-look', receipt } },
    });
    if (result.status === 'failed') throw new Error(result.message);
    return presentedTabId(result);
  } catch (error) {
    const name = userEntityLabel(input.sourcePath.split(/[\\/]/).pop());
    const reason = toUserMessage(error, 'document.openFailed');
    useToastStore.getState().addToast(
      reason === userMessage('document.openFailed')
        ? userMessageWithValues('document.quickLookOpenFailed', { name })
        : userMessageWithValues('document.quickLookOpenFailedBecause', {
            name,
            reason: userMessageValue(reason),
          }),
      { definition: 'open-quick-look-source-could-not-open-example-example-error' }
    );
    return null;
  }
}
