import { userMessage, type UserMessage } from '@waypoint/user-messages';
import { dispatchRouteFor } from '@waypoint/sequence-utils';
import { HARD_CAP_BYTES } from '../../shared/oversized-guard';

export function sequenceFileMetadataReadOnlyReason(
  path: string,
  sizeBytes: number
): UserMessage | undefined {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (dispatchRouteFor({ sizeBytes, ext: extension }) === 'indexed' || sizeBytes > HARD_CAP_BYTES)
    return userMessage('record.indexedMetadataReadOnly');
  if (!['.gb', '.gbk', '.gbff', '.genbank'].includes(extension))
    return userMessage('record.sequenceFileMetadataReadOnly');
  return undefined;
}
