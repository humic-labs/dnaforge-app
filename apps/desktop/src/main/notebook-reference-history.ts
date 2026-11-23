import type { JSONContent } from '@tiptap/core';
import { canonicalJson } from '../shared/canonical-json';
import {
  extractNotebookReferenceOccurrences,
  mapNotebookReferenceNodes,
} from '../shared/notebook-reference-occurrences';

export class NativeNotebookReferenceHistory {
  private readonly entries = new Map<string, { node: JSONContent; bytes: number }>();
  private bytes = 0;
  constructor(private readonly limits = { maxEntries: 10_000, maxBytes: 4 * 1024 * 1024 }) {}

  remember(content: JSONContent): void {
    mapNotebookReferenceNodes(content, (node) => {
      const occurrence = extractNotebookReferenceOccurrences(node)[0];
      if (!occurrence) return node;
      const key = canonicalJson(occurrence);
      const prior = this.entries.get(key);
      if (prior) {
        this.entries.delete(key);
        this.entries.set(key, prior);
        return node;
      }
      const bytes = Buffer.byteLength(canonicalJson(node));
      if (bytes > this.limits.maxBytes) return node;
      this.entries.set(key, { node: structuredClone(node), bytes });
      this.bytes += bytes;
      while (this.entries.size > this.limits.maxEntries || this.bytes > this.limits.maxBytes) {
        const oldest = this.entries.entries().next().value;
        if (!oldest) break;
        this.entries.delete(oldest[0]);
        this.bytes -= oldest[1].bytes;
      }
      return node;
    });
  }

  references(): readonly JSONContent[] {
    return [...this.entries.values()].map((entry) => entry.node);
  }
}
