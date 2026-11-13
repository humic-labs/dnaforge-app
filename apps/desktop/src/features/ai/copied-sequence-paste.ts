import { resolveSequenceClipboardText } from '../sequence-clipboard/public/clipboard-service';
import type { RichSequenceFragment } from '../sequence-clipboard/public/rich-sequence-clipboard';

export function copiedSequenceForChatPaste(
  text: string,
  cached: RichSequenceFragment | null
): RichSequenceFragment | null {
  const resolved = resolveSequenceClipboardText(text, cached);
  if (!resolved || resolved.format !== 'dnaforge') return null;
  const fragment = resolved.fragment;
  const coordinates = fragment.sourceCoordinates;
  if (!fragment.sourceId || fragment.sourceId.startsWith('clipboard:')) return null;
  if (
    !coordinates ||
    !Number.isInteger(coordinates.start) ||
    !Number.isInteger(coordinates.end) ||
    coordinates.start < 1 ||
    coordinates.end < 1
  ) {
    return null;
  }
  return fragment;
}
