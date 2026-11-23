import { useCallback, useRef } from 'react';
import { DocumentReadError } from '../../shared/document-read-failure';
import { HARD_CAP_BYTES } from '../../shared/oversized-guard';
import type { TabularDelimiter, TabularPreview } from '../../shared/tabular-file';

type WorkbookSnapshot = {
  kind: 'table';
  format: 'workbook';
  preview: { parsed: TabularPreview; size: number };
};

type DelimitedSnapshot = {
  kind: 'table';
  format: 'delimited';
  delimiter: TabularDelimiter;
  preview: {
    parsed: TabularPreview;
    size: number;
    text: string;
    bytesRead: number;
    slicedPreview: boolean;
  };
};

export type LiteralOpenSnapshot =
  | { kind: 'pdf'; bytes: Uint8Array }
  | { kind: 'image'; bytes: Uint8Array }
  | { kind: 'html'; text: string }
  | WorkbookSnapshot
  | DelimitedSnapshot;
export type LiteralDocumentKind = LiteralOpenSnapshot['kind'];
type SnapshotOf<K extends LiteralDocumentKind> = Extract<LiteralOpenSnapshot, { kind: K }>;

type PendingSnapshot = {
  snapshot: LiteralOpenSnapshot;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
};

const MAX_PENDING_SNAPSHOTS = 8;
const MAX_PENDING_BYTES = 2 * HARD_CAP_BYTES;
const UNUSED_SNAPSHOT_TTL_MS = 30_000;
const pendingSnapshots = new Map<string, PendingSnapshot>();
let pendingBytes = 0;

export function stageLiteralOpenSnapshot(path: string, snapshot: LiteralOpenSnapshot): () => void {
  const prior = pendingSnapshots.get(path);
  const bytes = snapshotSize(snapshot);
  if (
    (!prior && pendingSnapshots.size >= MAX_PENDING_SNAPSHOTS) ||
    pendingBytes - (prior?.bytes ?? 0) + bytes > MAX_PENDING_BYTES
  ) {
    throw new DocumentReadError(bytes > MAX_PENDING_BYTES ? 'too-large' : 'runtime', true);
  }
  if (prior) releaseSnapshot(path, prior);

  const entry: PendingSnapshot = {
    snapshot,
    bytes,
    timer: setTimeout(() => releaseSnapshot(path, entry), UNUSED_SNAPSHOT_TTL_MS),
  };
  pendingSnapshots.set(path, entry);
  pendingBytes += bytes;
  return () => releaseSnapshot(path, entry);
}

export function takeLiteralOpenSnapshot<K extends LiteralDocumentKind>(
  path: string,
  kind: K
): SnapshotOf<K> | undefined {
  const entry = pendingSnapshots.get(path);
  if (!entry || entry.snapshot.kind !== kind) return;
  releaseSnapshot(path, entry);
  return entry.snapshot as SnapshotOf<K>;
}

export function useInitialLiteralOpenSnapshot<K extends LiteralDocumentKind>(
  path: string,
  kind: K
) {
  const initial = useRef<{ path: string; kind: K; snapshot: SnapshotOf<K> | undefined } | null>(
    null
  );
  return useCallback(() => {
    if (initial.current?.path !== path || initial.current.kind !== kind) {
      const opening = { path, kind, snapshot: takeLiteralOpenSnapshot(path, kind) };
      initial.current = opening;
      // React's initial effect replay shares this read. A later reload goes to the source.
      queueMicrotask(() => {
        opening.snapshot = undefined;
      });
    }
    return initial.current.snapshot;
  }, [kind, path]);
}

function releaseSnapshot(path: string, entry: PendingSnapshot): void {
  if (pendingSnapshots.get(path) !== entry) return;
  clearTimeout(entry.timer);
  pendingSnapshots.delete(path);
  pendingBytes -= entry.bytes;
}

function snapshotSize(snapshot: LiteralOpenSnapshot): number {
  if (snapshot.kind === 'pdf' || snapshot.kind === 'image') return snapshot.bytes.buffer.byteLength;
  if (snapshot.kind === 'html') return snapshot.text.length * 2;
  let bytes = snapshot.format === 'delimited' ? snapshot.preview.text.length * 2 : 0;
  for (const row of snapshot.preview.parsed.sourceRows) {
    bytes += 24 + row.length * 48;
    for (const cell of row) bytes += cell.length * 2;
  }
  return bytes;
}
