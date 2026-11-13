import {
  decodeSequenceDocument,
  normalizePlainDnaClipboardText,
  resolveSequenceGeneticCode,
  nucleicAcidOf,
  type AnnotatedSequence,
} from '@waypoint/sequence-utils';
import {
  buildRichSequenceFragmentFromSelection,
  normalizeRichSequenceFragment,
  type RichSequenceFragment,
  type RichSequenceFragmentInput,
} from './rich-sequence-clipboard';
import { useRichSequenceClipboardStore } from './store';

export type SequenceClipboardFormat = 'dnaforge' | 'genbank' | 'fasta' | 'plain-dna';

export interface ResolvedSequenceClipboard {
  format: SequenceClipboardFormat;
  fragment: RichSequenceFragment;
}

export async function writeRichSequenceClipboard(
  fragment: RichSequenceFragmentInput,
  onWritten?: (committed: RichSequenceFragment) => void
): Promise<void> {
  const normalized = normalizeRichSequenceFragment(fragment);
  await navigator.clipboard.writeText(normalized.sequence);
  const committed = useRichSequenceClipboardStore.getState().setCopiedRegion(normalized);
  try {
    onWritten?.(committed);
  } catch {
    return;
  }
}

export async function readSequenceClipboard(): Promise<ResolvedSequenceClipboard | null> {
  const text = await navigator.clipboard.readText();
  const resolved = resolveSequenceClipboardText(text);
  if (resolved) {
    useRichSequenceClipboardStore.getState().setCopiedRegion(resolved.fragment);
  } else {
    useRichSequenceClipboardStore.getState().clear();
  }
  return resolved;
}

export function resolveSequenceClipboardText(
  text: string,
  cached: RichSequenceFragment | null = useRichSequenceClipboardStore.getState().copiedRegion
): ResolvedSequenceClipboard | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (cached?.sequence === trimmed) {
    return { format: 'dnaforge', fragment: cached };
  }

  const structured = decodeStructuredSequenceText(trimmed);
  if (structured) return structured;

  const sequence = normalizePlainDnaClipboardText(trimmed);
  if (!sequence) return null;
  return {
    format: 'plain-dna',
    fragment: externalFragment(
      {
        id: 'clipboard:plain-dna',
        name: 'Pasted sequence',
        sequence,
        length: sequence.length,
        annotations: [],
        circular: false,
      },
      'clipboard:plain-dna'
    ),
  };
}

function decodeStructuredSequenceText(text: string): ResolvedSequenceClipboard | null {
  const descriptor = text.startsWith('>')
    ? ({ format: 'fasta', filename: 'clipboard.fasta' } as const)
    : /^LOCUS\s/m.test(text) && /^ORIGIN\s*$/m.test(text) && /\/\/\s*$/.test(text)
      ? ({ format: 'genbank', filename: 'clipboard.gb' } as const)
      : null;
  if (!descriptor) return null;

  try {
    const document = decodeSequenceDocument(text, descriptor);
    if (!document.sequence.sequence) return null;
    return {
      format: descriptor.format,
      fragment: externalFragment(document.sequence, `clipboard:${descriptor.format}`),
    };
  } catch {
    return null;
  }
}

function externalFragment(sequence: AnnotatedSequence, sourceId: string): RichSequenceFragment {
  return buildRichSequenceFragmentFromSelection({
    sourceId,
    sourceName: sequence.name || 'Pasted sequence',
    sourceSequence: sequence.sequence,
    sourceAnnotations: sequence.annotations ?? [],
    sourceIsCircular: sequence.circular,
    sourceNucleicAcid: nucleicAcidOf(sequence),

    sourceGeneticCode: resolveSequenceGeneticCode(sequence).code,
    range: { start: 0, end: sequence.sequence.length },
    orientation: 'forward',
  }).fragment;
}
