import { useCallback, useState } from 'react';
import { decodeSequenceDocument, type TraceData } from '@waypoint/sequence-utils';
import { SequenceViewer1D } from '@waypoint/workspace-editor';
import { chromatogramLane } from '../sequence/public/chromatogram-lane';
import { useDisplayedSnapshot, usePreviewSource, type PreviewProps } from './use-preview-source';

const MAX_TRACE_BYTES = 8 * 1024 * 1024;

function readChromatogram(bytes: Uint8Array, path: string) {
  const { sequence } = decodeSequenceDocument(bytes, { format: 'ab1', path });
  const trace = sequence.metadata?.trace as TraceData | undefined;
  if (!trace) throw new Error('This read has no four-channel chromatogram.');
  const samples = trace.channels.A.length;
  if (!samples || !Object.values(trace.channels).every((channel) => channel.length === samples))
    throw new Error('The chromatogram dye channels are incomplete.');
  if (
    trace.peakPositions.length !== sequence.length ||
    trace.peakPositions.some(
      (position, i, positions) =>
        position < 0 || position >= samples || (i > 0 && position < positions[i - 1])
    )
  )
    throw new Error('The chromatogram has missing or invalid base-call positions.');
  const lanes = [
    chromatogramLane({ trace, sequence: sequence.sequence, quality: sequence.quality }),
  ];
  return { sequence, trace, lanes };
}

function TraceViewer({
  document,
  sha256,
  onSnapshot,
}: {
  document: ReturnType<typeof readChromatogram>;
  sha256: string;
  onSnapshot?: PreviewProps['onSnapshot'];
}) {
  const [ready, setReady] = useState(false);
  const reportViewport = useCallback(() => setReady(true), []);
  useDisplayedSnapshot(onSnapshot, ready ? sha256 : null);
  const [cursor, setCursor] = useState<number | null>(0);
  const { sequence, trace, lanes } = document;
  const base = cursor === null ? null : sequence.sequence[cursor];
  const quality = cursor === null ? undefined : sequence.quality?.[cursor];
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="external-chromatogram-preview">
      <p className="px-4 py-2 text-xs text-fg-muted">
        {sequence.length.toLocaleString()} base calls · {trace.channels.A.length.toLocaleString()}{' '}
        samples per channel
      </p>
      <div className="min-h-0 flex-1">
        <SequenceViewer1D
          sequence={sequence}
          extraLanes={lanes}
          initialPxPerBase={14}
          onViewportChange={reportViewport}
          viewCursor={cursor}
          onViewCursorChange={setCursor}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
      {cursor !== null && base && (
        <p
          className="px-4 py-2 font-mono text-xs text-fg-muted"
          data-testid="external-chromatogram-call"
        >
          Base {cursor + 1} · {base} ·{' '}
          {quality === undefined ? 'Quality unavailable' : `Phred ${quality}`}
        </p>
      )}
    </div>
  );
}

export function ChromatogramPreview({ path, onSnapshot }: PreviewProps) {
  const source = usePreviewSource(path, MAX_TRACE_BYTES, readChromatogram);
  useDisplayedSnapshot(source?.status === 'loaded' ? undefined : onSnapshot, null);
  if (!source)
    return (
      <p role="status" className="p-4 text-sm">
        Reading chromatogram…
      </p>
    );
  if (source.status === 'error')
    return (
      <p role="alert" className="p-4 text-sm">
        {source.message}
      </p>
    );
  return (
    <TraceViewer
      key={source.sha256}
      document={source.document}
      sha256={source.sha256}
      onSnapshot={onSnapshot}
    />
  );
}
