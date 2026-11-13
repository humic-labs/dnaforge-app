import type { ContentBlock } from './chat-types';

export function presentCliReferencesInline(
  blocks: ContentBlock[],
  inlineReferenceIds: ReadonlySet<string>
): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type !== 'ref' || !inlineReferenceIds.has(block.reference.id)) return block;
    const content: unknown = JSON.parse(block.message.content);
    if (
      typeof content !== 'object' ||
      content === null ||
      Array.isArray(content) ||
      !('referenceData' in content)
    ) {
      throw new Error('CLI reference history is invalid');
    }
    const { referenceData: _referenceData, ...history } = content;
    return {
      type: 'tool',
      message: {
        ...block.message,
        content: JSON.stringify(history),
        referenceIds: [],
      },
    };
  });
}
