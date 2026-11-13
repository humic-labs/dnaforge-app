import { toUserMessage, withUserMessage } from '@waypoint/user-messages';
import { countFastaSequences } from '@waypoint/plasmid-viewer/parsers';
import { useEffect, useState } from 'react';
import {
  loadReadonlySequence,
  ReadonlyPlasmidViewer,
  type ReadonlyRenderablePlasmid,
} from '@waypoint/plasmid-viewer/readonly';
import type { LegacyMigrationFastaRead } from '../../../shared/legacy-migration-read';
import { readLegacyMigrationFastaSource } from '../../../services/legacy-migration-fasta-read';
import { parseFastaAminoAcidSequence } from '../../../shared/amino-acid-sequence';
import { ProteinResidueTrack } from '../../proteins/public/components/ProteinResidueTrack';
import {
  commitReadableContent,
  failReadableContent,
} from '../../../lib/readable-content-telemetry';

type ReadState =
  | { status: 'loading' }
  | { status: 'unresolved'; message: string }
  | {
      status: 'ready';
      read: LegacyMigrationFastaRead;
      bases: string;
      plasmid: ReadonlyRenderablePlasmid | null;
    };
export function LegacyMigrationFastaTab({ request }: { request: LegacyMigrationFastaRead }) {
  const [state, setState] = useState<ReadState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      const { read, bytes } = await readLegacyMigrationFastaSource(request);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!text.trimStart().startsWith('>'))
        throw new Error('The legacy source has no complete FASTA header.');
      if (countFastaSequences(text) !== 1)
        throw withUserMessage(
          new Error(
            'This legacy read view requires exactly one complete FASTA record. The source contains multiple records.'
          ),
          'legacySource.multipleRecords'
        );
      let plasmid: ReadonlyRenderablePlasmid | null = null;
      let bases: string;
      if (read.readView === 'protein') bases = parseFastaAminoAcidSequence(text);
      else {
        const loaded = loadReadonlySequence({ kind: 'bytes', bytes, filename: read.path });
        if (!loaded.ok) throw new Error(loaded.error.message);
        plasmid = loaded.plasmid;
        bases = plasmid.sequence;
      }
      if (!bases) throw new Error('The legacy source contains no readable sequence.');
      if (cancelled) return;
      setState({ status: 'ready', read, bases, plasmid });
      commitReadableContent(read.destinationId);
    })().catch((error: unknown) => {
      if (cancelled) return;
      setState({
        status: 'unresolved',
        message: toUserMessage(error, 'operation.failed'),
      });
      failReadableContent(request.destinationId);
    });
    return () => {
      cancelled = true;
    };
  }, [request]);
  if (state.status === 'loading') return <div className="p-4 text-sm text-fg-muted">Loading…</div>;
  if (state.status === 'unresolved')
    return (
      <div className="p-4 text-sm text-fg-muted" data-testid="legacy-migration-fasta-unresolved">
        {toUserMessage(state.message, 'operation.failed')}
      </div>
    );
  return (
    <div
      className="h-full overflow-auto p-4"
      data-testid="legacy-migration-fasta-read"
      data-read-view={state.read.readView}
    >
      <div className="mb-3 rounded border border-border p-3 text-sm text-fg-muted">
        Legacy migration {state.read.readView === 'protein' ? 'protein' : 'sequence'} read view ·
        Read-only
      </div>
      <h2 className="mb-3 text-sm font-semibold">{state.read.title}</h2>
      {state.plasmid ? (
        <>
          <ReadonlyPlasmidViewer plasmid={state.plasmid} view="linear" />
          <pre
            className="whitespace-pre-wrap break-all font-mono text-sm"
            data-testid="legacy-migration-fasta-bases"
          >
            {state.bases}
          </pre>
        </>
      ) : (
        <ProteinResidueTrack bases={state.bases} onContextMenu={() => {}} />
      )}
      <button
        type="button"
        className="mt-3 rounded border border-border px-3 py-1 text-sm"
        onClick={() => void navigator.clipboard.writeText(state.bases)}
      >
        Copy sequence
      </button>
    </div>
  );
}
