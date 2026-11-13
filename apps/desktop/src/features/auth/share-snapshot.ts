import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';
export const SHARE_SNAPSHOT_PUBLIC_WARNING = userMessage('sharing.snapshotWarning');
export const SHARE_SNAPSHOT_EDIT_MODE_BLOCKED = userMessage('sharing.snapshotEditBlocked');
export const SHARE_SNAPSHOT_SIGN_IN_REQUIRED = userMessage('sharing.snapshotSignIn');
export const SHARE_SNAPSHOT_CONFIRM_TITLE = userMessage('sharing.snapshotTitle');
export const SHARE_SNAPSHOT_CONFIRM_MESSAGE = userMessage('sharing.snapshotConfirm');
export function formatShareSnapshotSuccess(input: {
  versionNumber?: number;
  url: string;
}): UserMessage {
  return userMessageWithValues('sharing.snapshotCopied', {
    version: userMessageValue(
      typeof input.versionNumber === 'number' ? ' (v' + input.versionNumber + ')' : ''
    ),
  });
}
export function formatShareSnapshotCopyFailure(input: {
  versionNumber?: number;
  url: string;
}): UserMessage {
  return userMessageWithValues('sharing.snapshotCopyFailed', {
    version: userMessageValue(
      typeof input.versionNumber === 'number' ? ' (v' + input.versionNumber + ')' : ''
    ),
    url: userMessageValue(input.url),
  });
}
