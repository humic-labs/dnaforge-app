import {
  decodeSequenceDocument,
  parseAb1,
  reverseComplement as sharedReverseComplement,
  type TraceData,
} from '@waypoint/sequence-utils';
import { getFileSystem } from '../../../hooks/useMockedFileSystem';
import { callPairwiseCircularAware } from '../../alignment-manager/public/utils/circular-alignment';
import { useAttachedReadsStore, type AttachedRead } from './attached-reads-store';
import { buildAlignedChromatogramOptions } from './aligned-chromatogram';

function reverseComplement(seq: string): string {
  return sharedReverseComplement(seq.toUpperCase());
}

async function readReference(refPath: string): Promise<{ sequence: string; isCircular: boolean }> {
  const fs = await getFileSystem();
  const filename = refPath.split(/[\\/]/).pop() || refPath;
  const content = isBinarySequencePath(filename)
    ? await fs.readFile(refPath)
    : await fs.readTextFile(refPath);
  const document = decodeSequenceDocument(content, { path: refPath, filename });
  return {
    sequence: document.sequence.sequence,
    isCircular: document.sequence.circular ?? false,
  };
}

function isBinarySequencePath(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext === 'ab1' || ext === 'abi' || ext === 'dna';
}

async function readAb1(ab1Path: string): Promise<{
  trace: TraceData;
  sequence: string;
  quality: number[];
}> {
  const fs = await getFileSystem();
  const bytes = await fs.readFile(ab1Path);
  const arrayBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const parsed = parseAb1(arrayBuf, ab1Path.split('/').pop());
  const trace = parsed.metadata?.trace as TraceData | undefined;
  if (!trace) throw new Error(`No trace data in ${ab1Path}`);
  return { trace, sequence: parsed.sequence, quality: parsed.quality ?? [] };
}

export interface AttachResult {
  read: AttachedRead;
  identity: number;
  reverseComplemented: boolean;
  wraps: boolean;
}

export interface AttachOptions {
  readIdOverride?: string;
}

export async function attachReadToReference(
  documentId: string,
  refPath: string,
  ab1Path: string,
  opts: AttachOptions = {}
): Promise<AttachResult> {
  const { sequence: referenceSequence, isCircular } = await readReference(refPath);
  const { trace, sequence: readSequence, quality } = await readAb1(ab1Path);
  const L = referenceSequence.length;

  if (!documentId.trim()) throw new Error('A sequence document ID is required.');

  const [fwdAln, rcAln] = await Promise.all([
    callPairwiseCircularAware({
      query: readSequence,
      reference: referenceSequence,
      isCircular,
    }),
    callPairwiseCircularAware({
      query: reverseComplement(readSequence),
      reference: referenceSequence,
      isCircular,
    }),
  ]);
  const useRc = rcAln.identity > fwdAln.identity;
  const winning = useRc ? rcAln : fwdAln;
  const orientedReadSequence = useRc ? reverseComplement(readSequence) : readSequence;
  const orientedReadQuality = useRc ? [...quality].reverse() : quality;

  const built = buildAlignedChromatogramOptions({
    referenceSequence,
    trace,
    readSequence: orientedReadSequence,
    readQuality: orientedReadQuality,
    alignedQuery: winning.aligned_query,
    alignedReference: winning.aligned_reference,
    reverseComplemented: useRc,
    referenceOffset: winning.refStart,
  });

  const laneOptions = winning.wraps
    ? {
        ...built.laneOptions,
        cycleLength: L,
        totalColumns: L,
      }
    : built.laneOptions;

  const read: AttachedRead = {
    id: opts.readIdOverride ?? ab1Path,
    label: ab1Path.split('/').pop() ?? ab1Path,
    laneOptions,
    identity: winning.identity,
    coverageStart: built.coverageStart,
    coverageEnd: built.coverageEnd,
  };

  useAttachedReadsStore.getState().attach(documentId, read);

  return {
    read,
    identity: winning.identity,
    reverseComplemented: useRc,
    wraps: winning.wraps,
  };
}
