import { toUserMessage, renderUserMessage, type UserMessage } from '@waypoint/user-messages';
import { useMemo, useState } from 'react';
import { designSaturationLibrary, saturationLibraryTsv } from '../saturation-library';

interface SaturationLibraryPanelProps {
  referenceSequence: string;
}

export function SaturationLibraryPanel({ referenceSequence }: SaturationLibraryPanelProps) {
  const [cdsStart, setCdsStart] = useState('');
  const [cdsEnd, setCdsEnd] = useState('');
  const [strand, setStrand] = useState<'forward' | 'reverse'>('forward');
  const [firstResidue, setFirstResidue] = useState('1');
  const [lastResidue, setLastResidue] = useState('');
  const [flankLength, setFlankLength] = useState('20');
  const [codon, setCodon] = useState<'NNK' | 'NNS'>('NNK');
  const [copyStatus, setCopyStatus] = useState('');
  const result:
    | { kind: 'ready'; pairs: ReturnType<typeof designSaturationLibrary>; tsv: string }
    | { kind: 'error'; message: UserMessage }
    | null = useMemo(() => {
    if (
      ![cdsStart, cdsEnd, firstResidue, lastResidue, flankLength].every(
        (value) => value.trim() !== ''
      )
    )
      return null;
    try {
      const pairs = designSaturationLibrary({
        reference: referenceSequence,
        cdsStart: Number(cdsStart) - 1,
        cdsEnd: Number(cdsEnd),
        strand,
        firstResidue: Number(firstResidue),
        lastResidue: Number(lastResidue),
        flankLength: Number(flankLength),
        codon,
      });
      return { kind: 'ready', pairs, tsv: saturationLibraryTsv(pairs, codon) } as const;
    } catch (error) {
      return {
        kind: 'error',
        message: toUserMessage(error, 'primer.failed'),
      } as const;
    }
  }, [referenceSequence, cdsStart, cdsEnd, strand, firstResidue, lastResidue, flankLength, codon]);
  const numberField = (label: string, value: string, update: (value: string) => void) => (
    <label className="flex flex-col gap-1 text-xs">
      {label}
      <input
        type="number"
        min="1"
        step="1"
        value={value}
        onChange={(event) => {
          update(event.target.value);
          setCopyStatus('');
        }}
        className="rounded border border-border bg-background px-2 py-1.5"
      />
    </label>
  );
  return (
    <section aria-label="Saturation library" className="p-3 space-y-3">
      <h3 className="text-sm font-medium">Saturation-mutagenesis oligos</h3>
      <p className="text-xs text-muted-foreground">
        Enter a single-exon CDS and the residues to mutate. Each residue gets a fully overlapping
        pair with one degenerate codon and fixed matching flanks. These pairs use the standard
        genetic code.
      </p>
      <p className="text-xs text-muted-foreground">
        Coordinates refer to this loaded template of {referenceSequence.length.toLocaleString()}{' '}
        bases.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {numberField('CDS start (1-based)', cdsStart, setCdsStart)}
        {numberField('CDS end (inclusive)', cdsEnd, setCdsEnd)}
        <label className="flex flex-col gap-1 text-xs">
          Coding strand
          <select
            value={strand}
            onChange={(event) => {
              setStrand(event.target.value === 'reverse' ? 'reverse' : 'forward');
              setCopyStatus('');
            }}
            className="rounded border border-border bg-background px-2 py-1.5"
          >
            <option value="forward">Forward</option>
            <option value="reverse">Reverse</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Degenerate codon
          <select
            value={codon}
            onChange={(event) => {
              setCodon(event.target.value === 'NNS' ? 'NNS' : 'NNK');
              setCopyStatus('');
            }}
            className="rounded border border-border bg-background px-2 py-1.5"
          >
            <option value="NNK">NNK</option>
            <option value="NNS">NNS</option>
          </select>
        </label>
        {numberField('First residue', firstResidue, setFirstResidue)}
        {numberField('Last residue', lastResidue, setLastResidue)}
        {numberField('Matching bases per side', flankLength, setFlankLength)}
      </div>
      <p className="text-xs text-muted-foreground">
        NNK and NNS each encode 32 codons, all 20 amino acids and one stop codon. Amino acids are
        not equally represented. Flanks do not wrap around the template origin.
      </p>
      {result?.kind === 'error' && (
        <p role="alert" className="text-xs text-destructive">
          {renderUserMessage(result.message)}
        </p>
      )}
      {result?.kind === 'ready' && (
        <div className="space-y-2">
          <p className="text-xs">
            {result.pairs.length} residues, {result.pairs.length * 2} oligos. All sequences run 5′
            to 3′. F follows the coding strand; R is its reverse complement.
          </p>
          <p className="text-xs text-muted-foreground">
            Fixed-flank designs do not optimize Tm, hairpins or dimers. Check the pair against your
            mutagenesis protocol before ordering.
          </p>
          <label className="flex flex-col gap-1 text-xs">
            Oligo table (TSV)
            <textarea
              readOnly
              value={result.tsv}
              rows={8}
              className="w-full rounded border border-border bg-background p-2 font-mono text-xs"
            />
          </label>
          <button
            type="button"
            className="rounded border border-border px-3 py-1.5 text-xs"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(result.tsv);
                setCopyStatus('Copied oligo table.');
              } catch {
                setCopyStatus('Could not copy. Select the oligo table and copy it manually.');
              }
            }}
          >
            Copy oligo table
          </button>
          <p role="status" className="text-xs">
            {copyStatus}
          </p>
        </div>
      )}
    </section>
  );
}
