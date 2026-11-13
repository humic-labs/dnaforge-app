import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSchema } from '@tiptap/core';

import { getBaseExtensions, MentionExtension, EmbedNode } from './extensions';

const REL = 'resources/sample-workspaces/standard-samples/workspace';
const WS = [join(process.cwd(), REL), join(process.cwd(), 'apps/desktop', REL)].find(
  existsSync
) as string;
const NB = join(
  WS,
  'notebooks/MoClo Golden Gate — red fluorescent transcription unit/.forge/notebook.json'
);

describe('bundled MoClo notebook renders in the real editor schema', () => {
  it('round-trips through getBaseExtensions + Mention + Embed with no dropped/invalid nodes', () => {
    const doc = JSON.parse(readFileSync(NB, 'utf8')).content;
    const schema = getSchema([...getBaseExtensions(), MentionExtension, EmbedNode] as never);
    const node = schema.nodeFromJSON(doc);
    expect(node.type.name).toBe('doc');
    const types = new Set<string>();
    let count = 0;
    node.descendants((n) => {
      types.add(n.type.name);
      count += 1;
      return true;
    });
    expect(count).toBeGreaterThan(30);
    for (const t of ['mention', 'embed', 'taskItem', 'heading', 'codeBlock', 'blockquote'])
      expect(types.has(t), `editor schema is missing node type: ${t}`).toBe(true);
  });
});
