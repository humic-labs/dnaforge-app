import { Mapping } from '@tiptap/pm/transform';

export type InsertionToken = number & { readonly __brand: 'InsertionToken' };

export type ResolvedInsertionRange =
  | { ok: true; pos: number }
  | { ok: false; reason: 'range-deleted' | 'unknown-token' };

export interface InsertionRangeTracker {
  capture(pos: number): InsertionToken;
  onTransaction(mapping: Mapping): void;
  resolve(token: InsertionToken): ResolvedInsertionRange;
  release(token: InsertionToken): void;
  inFlightCount(): number;
}

export function createInsertionRangeTracker(): InsertionRangeTracker {
  const live = new Map<InsertionToken, { pos: number; mapping: Mapping }>();
  let nextToken = 1;

  return {
    capture(pos: number): InsertionToken {
      const token = nextToken as InsertionToken;
      nextToken += 1;
      live.set(token, { pos, mapping: new Mapping() });
      return token;
    },

    onTransaction(mapping: Mapping): void {
      for (const entry of live.values()) {
        entry.mapping.appendMapping(mapping);
      }
    },

    resolve(token: InsertionToken): ResolvedInsertionRange {
      const entry = live.get(token);
      if (!entry) return { ok: false, reason: 'unknown-token' };

      const result = entry.mapping.mapResult(entry.pos);
      if (result.deleted) return { ok: false, reason: 'range-deleted' };

      return { ok: true, pos: result.pos };
    },

    release(token: InsertionToken): void {
      live.delete(token);
    },

    inFlightCount(): number {
      return live.size;
    },
  };
}
