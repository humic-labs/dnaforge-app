interface HastPosition {
  start?: { offset?: number };
  end?: { offset?: number };
}

interface HastNode {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: HastPosition;
}

interface InlineReferenceRehypeOptions {
  sourceOffset: number;
}

function visit(node: HastNode, visitor: (candidate: HastNode) => void): void {
  visitor(node);
  for (const child of node.children ?? []) visit(child, visitor);
}

export function rehypeInlineReferences(options: InlineReferenceRehypeOptions) {
  return (tree: HastNode): void => {
    visit(tree, (node) => {
      if (node.type !== 'element' || node.tagName !== 'a') return;
      const href = node.properties?.href;
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (
        typeof href !== 'string' ||
        !href.startsWith('dnaforge-chat://') ||
        typeof start !== 'number' ||
        typeof end !== 'number'
      ) {
        return;
      }

      node.tagName = 'span';
      node.properties = {
        'data-dnaforge-inline-reference-key': `inline-reference-${options.sourceOffset + start}-${
          options.sourceOffset + end
        }`,
      };
    });
  };
}
