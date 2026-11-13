import {
  renderUserMessage,
  userEntityLabel,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';
import type { UnconvertedSequenceFile } from '../../shared/workspace-git-types';
import { useToastStore } from '../../stores/toast-store';

const NAMED_FILES = 3;

export function unconvertedSequenceMessage(
  files: readonly UnconvertedSequenceFile[] | undefined
): UserMessage | null {
  if (!files?.length) return null;
  const names = files
    .slice(0, NAMED_FILES)
    .map(({ relPath }) => userEntityLabel(relPath.split('/').pop() ?? relPath))
    .join(', ');
  if (files.length === 1)
    return userMessageWithValues('sequenceImport.plainFile', { names: userMessageValue(names) });
  const more =
    files.length > NAMED_FILES
      ? userMessageWithValues('sequenceImport.additionalFiles', {
          count: userMessageValue(files.length - NAMED_FILES),
        })
      : '';
  return userMessageWithValues('sequenceImport.plainFiles', {
    count: userMessageValue(files.length),
    names: userMessageValue(names),
    more: userMessageValue(more),
  });
}

export function reportUnconvertedSequenceFiles(
  files: readonly UnconvertedSequenceFile[] | undefined
): void {
  const message = unconvertedSequenceMessage(files);
  if (!message) return;
  useToastStore.getState().addToast(renderUserMessage(message), {
    definition: 'workspace-loader-unconverted-sequence-files',
  });
}
