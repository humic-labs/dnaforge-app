import type { DeepSharePublishOk } from '../shared/deep-share-ipc';

export type PublishedShareCopyResult =
  | { kind: 'copied' }
  | { kind: 'retired' }
  | { kind: 'copy-failed'; error: unknown };

export async function copyPublishedShareLink(input: {
  publication: Pick<DeepSharePublishOk, 'url'>;
  isCurrent(): boolean;
  writeText(text: string): Promise<void>;
}): Promise<PublishedShareCopyResult> {
  if (!input.isCurrent()) return { kind: 'retired' };
  try {
    await input.writeText(input.publication.url);
  } catch (error) {
    return input.isCurrent() ? { kind: 'copy-failed', error } : { kind: 'retired' };
  }
  return input.isCurrent() ? { kind: 'copied' } : { kind: 'retired' };
}
