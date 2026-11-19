import { useMemo, useState } from 'react';
import { parseFasta, type ParsedFastaSequence } from '@waypoint/plasmid-viewer/parsers';
import { classifyMoleculeType, PARSER_DISPATCH_LIMITS } from '@waypoint/sequence-utils';
import { Button, Select } from '../../components/ui';
import { DocumentInfoRow } from './DocumentInfoRow';
import { usePreviewSource, useDisplayedSnapshot, type PreviewProps } from './use-preview-source';

const SYMBOLS_PER_PAGE = 4000;
const RECORDS_PER_PAGE = 250;
const alphabetLabel = {
  dna: 'DNA-like',
  rna: 'RNA-like',
  protein: 'Protein-like',
  ambiguous: 'Ambiguous alphabet',
} as const;

function FastaRecords({
  records,
  controls,
}: {
  records: ParsedFastaSequence[];
  controls?: PreviewProps['controls'];
}) {
  const [ordinal, setOrdinal] = useState(0);
  const [page, setPage] = useState(0);
  const record = records[ordinal];
  const recordGroup = Math.floor(ordinal / RECORDS_PER_PAGE) * RECORDS_PER_PAGE;
  const options = useMemo(
    () =>
      records.slice(recordGroup, recordGroup + RECORDS_PER_PAGE).map((entry, index) => ({
        value: String(recordGroup + index),
        label: `${recordGroup + index + 1}. ${entry.name}`,
      })),
    [recordGroup, records]
  );
  const alphabet = useMemo(
    () => alphabetLabel[classifyMoleculeType(record.sequence).kind],
    [record]
  );
  const selectRecord = (index: number) => {
    setOrdinal(index);
    setPage(0);
  };
  const start = page * SYMBOLS_PER_PAGE;
  const end = Math.min(start + SYMBOLS_PER_PAGE, record.length);
  return (
    <section aria-label="FASTA sequences" className="flex h-full min-h-0 flex-col text-sm text-fg">
      <DocumentInfoRow controls={controls}>
        <span className="text-fg-muted">
          {records.length.toLocaleString()} {records.length === 1 ? 'record' : 'records'}
        </span>
        {records.length > RECORDS_PER_PAGE && (
          <Button
            disabled={recordGroup === 0}
            onClick={() => selectRecord(recordGroup - RECORDS_PER_PAGE)}
          >
            Previous records
          </Button>
        )}
        {records.length > 1 && (
          <Select
            containerClassName="min-w-0 max-w-full sm:max-w-56"
            ariaLabel="FASTA record"
            value={String(ordinal)}
            options={options}
            onValueChange={(value) => selectRecord(Number(value))}
          />
        )}
        {records.length > RECORDS_PER_PAGE && (
          <Button
            disabled={recordGroup + RECORDS_PER_PAGE >= records.length}
            onClick={() => selectRecord(recordGroup + RECORDS_PER_PAGE)}
          >
            Next records
          </Button>
        )}
      </DocumentInfoRow>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        <h2 className="break-words font-semibold">{record.name}</h2>
        {record.description && (
          <p className="mt-1 whitespace-pre-wrap break-words text-fg">{record.description}</p>
        )}
        <p className="my-3 text-fg-muted">
          {alphabet} · {record.length.toLocaleString()} symbols
        </p>
        <pre
          aria-label="Sequence"
          className="whitespace-pre-wrap break-all rounded border border-border bg-bg-subtle p-3 font-mono leading-6"
        >
          {record.sequence.slice(start, end)}
        </pre>
        {record.length > SYMBOLS_PER_PAGE && (
          <div className="mt-3 flex items-center gap-2">
            <Button disabled={page === 0} onClick={() => setPage(page - 1)}>
              Previous positions
            </Button>
            <span>
              {(start + 1).toLocaleString()}–{end.toLocaleString()} of{' '}
              {record.length.toLocaleString()}
            </span>
            <Button disabled={end === record.length} onClick={() => setPage(page + 1)}>
              Next positions
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function decodeFasta(bytes: Uint8Array) {
  return parseFasta(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { complete: true });
}

export function FastaPreview({ path, onSnapshot, controls }: PreviewProps) {
  const state = usePreviewSource(path, PARSER_DISPATCH_LIMITS.fastaIndexedBytes, decodeFasta);
  useDisplayedSnapshot(onSnapshot, state?.status === 'loaded' ? state.sha256 : null);
  if (state?.status !== 'loaded')
    return (
      <DocumentInfoRow controls={controls}>
        <span role={state ? 'alert' : 'status'}>{state ? state.message : 'Reading FASTA…'}</span>
      </DocumentInfoRow>
    );
  return <FastaRecords key={path} records={state.document} controls={controls} />;
}
