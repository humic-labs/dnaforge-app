import type {
  ResolveHints,
  ResolverResult,
  ResolverSource,
  ResolverStep,
  StructureDrawerRequest,
} from '../types/structure-drawer';
import { pdbXrefStep } from './steps/pdb-xref';
import { uniprotXrefStep } from './steps/uniprot-xref';
import { proteinSequenceStep } from './steps/protein-sequence';
import { proteinIdStep } from './steps/protein-id';
import { refSeqStep } from './steps/refseq-xref';
import { geneIdStep } from './steps/geneid-xref';
import { locusTagStep } from './steps/locus-tag';
import { geneSequenceOverlapStep } from './steps/gene-sequence-overlap';
import { geneOrganismStep } from './steps/gene-organism';
import { rcsbSequenceStep } from './steps/rcsb-sequence';
import { attachResolverIdentityLedger } from './result-protein-identity';

export const BUILTIN_STEPS: readonly ResolverStep[] = [
  proteinSequenceStep,
  pdbXrefStep,
  uniprotXrefStep,
  proteinIdStep,
  refSeqStep,
  geneIdStep,
  locusTagStep,
  geneSequenceOverlapStep,
  geneOrganismStep,
];

export const NON_PROTEIN_STEPS: readonly ResolverStep[] = [rcsbSequenceStep];

export function defaultResolverStepsForRequest(
  request: StructureDrawerRequest
): readonly ResolverStep[] {
  return (request.moleculeType ?? 'protein') === 'protein' ? BUILTIN_STEPS : NON_PROTEIN_STEPS;
}

export interface ResolveOptions {
  skipSteps?: readonly ResolverSource[];
  steps?: readonly ResolverStep[];
}

export async function resolveStructure(
  translation: string,
  hints: ResolveHints,
  signal: AbortSignal,
  opts: ResolveOptions = {}
): Promise<ResolverResult | null> {
  return resolveStructureRequest({ translation, hints }, signal, opts);
}

export async function resolveStructureRequest(
  request: StructureDrawerRequest,
  signal: AbortSignal,
  opts: ResolveOptions = {}
): Promise<ResolverResult | null> {
  const skip = new Set(opts.skipSteps ?? []);
  let firstProviderError: unknown = null;
  const defaultSteps = defaultResolverStepsForRequest(request);
  const steps = (opts.steps ?? defaultSteps)
    .filter((s) => !skip.has(s.name))
    .slice()
    .sort((a, b) => a.priority - b.priority);

  for (const step of steps) {
    if (step.hintsRequired.some((k) => request.hints[k] === undefined)) continue;
    if (signal.aborted) {
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    }
    try {
      const result = await step.resolve(request.translation, request.hints, signal, request);
      if (result) return attachResolverIdentityLedger(result, request);
    } catch (err) {
      if ((err as Error).name === 'SidecarProviderError') {
        firstProviderError ??= err;
        continue;
      }
      if (
        (err as Error).name === 'AbortError' ||
        (err as Error).name === 'SidecarAuthError' ||
        (err as Error).name === 'CanonicalizationMismatchError'
      ) {
        throw err;
      }
      continue;
    }
  }

  if (firstProviderError) throw firstProviderError;
  return null;
}
