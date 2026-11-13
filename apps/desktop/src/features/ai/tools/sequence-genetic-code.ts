
import { z } from 'zod';
import {
  resultTool,
  toolFailure,
  toolSuccess,
  type ToolOperationResult,
} from '../../agent-bridge/public/tool-result';
import {
  GENETIC_CODES,
  geneticCodeLabel,
  isCodingFeature,
  isKnownGeneticCodeId,
  parseTranslTableQualifier,
  resolveSequenceGeneticCode,
  STANDARD_GENETIC_CODE_ID,
  type AnnotatedSequence,
  type GeneticCodeSpec,
} from '@waypoint/sequence-utils';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { setSequenceGeneticCodeOnDocument } from '../../sequence/public/set-sequence-genetic-code';
import { loadSequenceDocumentBiologyFile, normalizeSequenceDocumentId } from './path-utils';

const documentIdField = z
  .string()
  .min(1)
  .describe('Stable package/catalog sequence document ID or waypoint://sequence/{documentId} URI.');

export const getSequenceGeneticCodeSchema = z.object({ documentId: documentIdField }).strict();

export const setSequenceGeneticCodeSchema = z
  .object({
    documentId: documentIdField,
    geneticCode: z
      .union([z.number().int().min(1), z.null()])
      .describe(
        'NCBI genetic code id to record for this file, or null to remove the override so ' +
          'the file falls back to whatever its coding features declare. Call ' +
          'get_sequence_genetic_code first to see the published ids and what the file ' +
          'already says.'
      ),
  })
  .strict();

function declaredCodeCounts(sequence: AnnotatedSequence): Array<{
  geneticCode: number;
  label: string;
  codingFeatures: number;
}> {
  const counts = new Map<number, number>();
  for (const annotation of sequence.annotations ?? []) {
    if (!isCodingFeature(annotation)) continue;
    const declared = parseTranslTableQualifier(annotation);
    if (declared === null) continue;
    counts.set(declared, (counts.get(declared) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([geneticCode, codingFeatures]) => ({
      geneticCode,
      label: geneticCodeLabel(geneticCode),
      codingFeatures,
    }));
}

export function createGetSequenceGeneticCodeTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Read which genetic code a sequence file is translated by, and where that came from. ' +
      'Call this BEFORE reasoning about any protein from a record you did not write: ' +
      'mitochondrial and several nuclear codes reassign codons, so the same bases mean ' +
      'different amino acids. Returns the resolved code, its basis, every code the ' +
      "file's coding features declare, and whether the file is mixed or needs an answer.",
    inputSchema: getSequenceGeneticCodeSchema as z.ZodTypeAny,
    execute: async ({ documentId }: z.infer<typeof getSequenceGeneticCodeSchema>) => {
      try {
        const loaded = await loadSequenceDocumentBiologyFile(documentId, folders);
        const sequence = loaded.biology.sequence;
        const resolution = resolveSequenceGeneticCode(sequence);

        return toolSuccess({
          documentId: loaded.documentId,
          geneticCode: resolution.code,
          label: geneticCodeLabel(resolution.code),
          basis: resolution.basis,
          basisExplanation: explainBasis(resolution.basis),
          mixed: resolution.mixed,
          declaredByFeatures: declaredCodeCounts(sequence),
          needsUserChoice: resolution.needsUserChoice,
          ...(resolution.organelle ? { organelle: resolution.organelle } : {}),
          publishedGeneticCodes: GENETIC_CODES.map((code) => ({ id: code.id, name: code.name })),
          note:
            'A coding feature that declares its own /transl_table is always read by that ' +
            'code, whatever this file-level answer says.',
        });
      } catch (error) {
        return toolFailure({
          code: 'SEQUENCE_NOT_FOUND',
          error:
            error instanceof Error
              ? error.message
              : `No sequence document matches "${documentId}".`,
          retriable: false,
          stateChanged: false,
          partialEffects: [],
        });
      }
    },
  });
}

function explainBasis(basis: string): string {
  switch (basis) {
    case 'declared':
      return "Every coding feature that declares a code declares this one.";
    case 'declared-mixed':
      return 'Coding features declare more than one code; this is the most common of them, used only for regions not covered by a declaring feature.';
    case 'chosen':
      return 'A user (or an agent) set this code, and it is recorded in the file.';
    default:
      return 'Nothing in the file declares a code, so the standard code is assumed.';
  }
}

export function createSetSequenceGeneticCodeTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Record which genetic code a sequence file should be translated by, saving it into ' +
      'the file. Use this only when the file genuinely does not declare one — for example ' +
      'an organellar record whose coding features were stripped of /transl_table. ' +
      'Do NOT use it to "fix" a file that already declares a code; a declaring feature is ' +
      'always read by its own code and this setting will not change that. Pass null to ' +
      'remove a previously recorded code.',
    inputSchema: setSequenceGeneticCodeSchema as z.ZodTypeAny,
    execute: async ({
      documentId,
      geneticCode,
    }: z.infer<typeof setSequenceGeneticCodeSchema>) => {
      let spec: GeneticCodeSpec | null;
      if (geneticCode === null) {
        spec = null;
      } else if (!isKnownGeneticCodeId(geneticCode)) {
        return toolFailure({
          code: 'UNKNOWN_GENETIC_CODE',
          error:
            `${geneticCode} is not a published NCBI genetic code. ` +
            `Call get_sequence_genetic_code for the list of valid ids.`,
          retriable: false,
          stateChanged: false,
          partialEffects: [],
        });
      } else {
        spec = geneticCode;
      }

      const normalized = normalizeSequenceDocumentId(documentId);
      const outcome = await setSequenceGeneticCodeOnDocument({
        documentId: normalized,
        geneticCode: spec,
        folders,
      });
      if (!outcome.ok) {
        return toolFailure({
          code: outcome.error.toUpperCase(),
          error: outcome.message,
          retriable: outcome.error === 'write_failed',
          stateChanged: outcome.error === 'write_failed' ? 'unknown' : false,
          partialEffects: [],
        });
      }

      return toolSuccess({
        documentId: normalized,
        geneticCode: spec,
        label: spec === null ? null : geneticCodeLabel(spec),
        resolvedGeneticCode: outcome.resolved.code,
        resolvedLabel: geneticCodeLabel(outcome.resolved.code),
        basis: outcome.resolved.basis,
        featuresStillReadingByTheirOwnCode: outcome.featuresDeclaringTheirOwnCode,
        savedToFile: outcome.savedToFile,
      });
    },
  });
}

export const SEQUENCE_GENETIC_CODE_TOOL_STANDARD_ID = STANDARD_GENETIC_CODE_ID;
