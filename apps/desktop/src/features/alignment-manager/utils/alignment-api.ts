import { platform } from '../../../platform';
import { readSequenceFileGuarded } from '../../sequence/public/utils/guarded-read';
import { isApiError, pairwiseAlignment } from '@waypoint/api-client';
import {
  userMessagePayload,
  userMessageValue,
  userMessageWithValues,
  withUserMessage,
} from '@waypoint/user-messages';
import {
  decodeSequenceDocument,
  detectFormat,
  parseSequenceFile,
  resolveSequenceGeneticCode,
  STANDARD_GENETIC_CODE_ID,
} from '@waypoint/sequence-utils';
import type { Annotation, GeneticCodeSpec, SequenceDocument } from '@waypoint/sequence-utils';

export interface AlignmentApiResponse {
  aligned_query: string;
  aligned_reference: string;
  identity: number;
  mutations: Array<{
    position: number;
    type: 'substitution' | 'insertion' | 'deletion';
    ref_base: string;
    query_base: string;
    length: number;
  }>;
  alignment_length: number;
  analysis?: {
    structural_regions: Array<{
      id: string;
      type: string;
      confidence: number;
      severity: 'high' | 'medium' | 'low';
      column_start: number;
      column_end: number;
      ref_start: number | null;
      ref_end: number | null;
      length_columns: number;
      forward_identity: number;
      mutation_indices: number[];
      classification_method?: string;
      classification_details?: string;
    }>;
    point_mutations: Array<{
      index: number;
      type: string;
      position: number;
    }>;
    overall_assessment: {
      result: 'PASS' | 'FAIL' | 'REVIEW';
      reason: string;
    };
    warnings: Array<{
      type: string;
      message: string;
      severity: string;
    }>;
  };
}

export async function callAlignmentApi(
  querySequence: string,
  referenceSequence: string,
  timeoutMs = 300000
): Promise<AlignmentApiResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await pairwiseAlignment(
      {
        query: querySequence,
        reference: referenceSequence,
        use_cache: false,
      },
      { signal: controller.signal }
    );

    clearTimeout(timeoutId);
    return response.data as AlignmentApiResponse;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Alignment timed out after ${Math.round(timeoutMs / 1000)}s. Try with shorter sequences.`
      );
    }
    if (isApiError(err)) {
      const detail =
        typeof err.body === 'object' && err.body !== null && 'detail' in err.body
          ? (err.body as { detail?: unknown }).detail
          : err.detail;
      if (Array.isArray(detail)) {
        throw new Error(
          detail
            .map((entry) => String((entry as { msg?: unknown }).msg ?? 'Unknown error'))
            .join('; ')
        );
      }
      throw new Error(typeof detail === 'string' ? detail : `Alignment failed: ${err.status}`);
    }
    throw err;
  }
}

export async function readSequenceFile(filePath: string): Promise<string> {
  return (await readSequenceDocument(filePath)).sequence.sequence;
}

export async function readReferenceForMutations(
  filePath: string
): Promise<{ annotations: Annotation[]; geneticCode: GeneticCodeSpec; circular: boolean }> {
  try {
    const { sequence } = await readSequenceDocument(filePath);
    return {
      annotations: sequence.annotations,
      geneticCode: resolveSequenceGeneticCode(sequence).code,
      circular: sequence.circular === true,
    };
  } catch {
    return { annotations: [], geneticCode: STANDARD_GENETIC_CODE_ID, circular: false };
  }
}

async function readSequenceDocument(filePath: string): Promise<SequenceDocument> {
  const filename = filePath.split(/[\\/]/).pop() || filePath;
  if (isBinarySequencePath(filename)) {
    return decodeSequenceDocument(await platform().fs.readFile(filePath), {
      path: filePath,
      filename,
    });
  }
  const content = await readSequenceFileGuarded(filePath);
  const format = detectFormat(content, filename);
  if (format === 'fasta' || format === 'fastq') {
    const records = parseSequenceFile(content, { filename, format });
    if (records.length !== 1) {
      const values = {
        file: userMessageValue(filename),
        count: userMessageValue(records.length),
      };
      const rendered = userMessageWithValues('alignment.multiReadInput', values);
      throw withUserMessage(
        new Error(rendered),
        userMessagePayload('alignment.multiReadInput', values)
      );
    }
  }
  return decodeSequenceDocument(content, {
    path: filePath,
    filename,
    format,
  });
}

function isBinarySequencePath(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext === 'ab1' || ext === 'abi' || ext === 'dna';
}
