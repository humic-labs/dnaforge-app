import { z } from 'zod';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import {
  linkAssemblyPrimerOligos,
  type AssemblyPrimerOligoEntry,
  type LinkAssemblyPrimerOligosInput,
  type LinkAssemblyPrimerOligosRefusal,
  type LinkAssemblyPrimerOligosResult,
} from '../../assembly/public/saved-primer-oligos';

export const SAVE_DESIGN_PRIMERS_DESCRIPTION =
  "Register a draft assembly's primers as saved oligos, or link each one to the identical oligo " +
  'already saved in the same project (exact bases and chemistry), and record on the design which ' +
  "saved oligo and revision each primer uses. Each primer's binding part, 5-prime tail, part, " +
  'direction and source site stay with the design. The call creates no source attachments, never ' +
  'finalizes, is safe to repeat, and reports several identical saved oligos as ambiguous instead ' +
  'of guessing; settle those with choices. restoreMissingBindingSplit records the binding and ' +
  'tail split on a linked oligo that lacks one. Do not retype assembly primers through ' +
  'create_primer. Use get_design to read the current version and primer IDs.';

export const saveDesignPrimersSchema = z
  .object({
    designId: z.string().min(1).describe('Design id or waypoint://design/<id>.'),
    expectedDesignVersion: z
      .number()
      .int()
      .nonnegative()
      .describe('Design version last returned by get_design.'),
    saveUnsaved: z
      .boolean()
      .optional()
      .describe(
        'Register primers that have no identical saved oligo. Defaults to true; false links existing oligos and reports the rest.'
      ),
    restoreMissingBindingSplit: z
      .boolean()
      .optional()
      .describe(
        'Record the binding and tail split on linked or matched oligos that have none. Defaults to false.'
      ),
    choices: z
      .array(z.object({ primerId: z.string().min(1), oligoId: z.string().min(1) }).strict())
      .optional()
      .describe('Saved oligo to use for each primer reported as ambiguous.'),
  })
  .strict();

type LinkCommand = (
  input: LinkAssemblyPrimerOligosInput
) => Promise<LinkAssemblyPrimerOligosResult>;

const REFUSALS: Record<LinkAssemblyPrimerOligosRefusal, { code: string; retriable: boolean }> = {
  'design-not-found': { code: 'DESIGN_NOT_FOUND', retriable: false },
  'stale-design-version': { code: 'STALE_DESIGN_VERSION', retriable: true },
  'project-unavailable': { code: 'PROJECT_UNAVAILABLE', retriable: false },
  'no-primers': { code: 'NO_PRIMERS', retriable: false },
  'invalid-choice': { code: 'INVALID_CHOICE', retriable: false },
  'design-busy': { code: 'DESIGN_BUSY', retriable: true },
};

function projectSourceAttachment(agreement: AssemblyPrimerOligoEntry['sourceAttachment']) {
  if (agreement.kind !== 'agrees') return { state: agreement.kind };
  const { id, placement, confirmed, sourceDigest } = agreement.binding;
  return { state: agreement.kind, binding: { id, placement, confirmed, sourceDigest } };
}

function projectPrimerEntry(entry: AssemblyPrimerOligoEntry) {
  const { use, oligo } = entry;
  const link = oligo && entry.link?.oligoId === oligo.oligoId ? entry.link : null;
  return {
    primerId: use.primerId,
    name: use.primerName,
    partNumber: use.partNumber,
    direction: use.direction,
    sequence: use.sequence,
    bindingSequence: use.bindingSequence,
    tailSequence: use.tailSequence,
    tmC: use.tmC,
    sourceSite: use.sourceSite,
    status: entry.status,
    savedOligo: oligo
      ? {
          oligoId: oligo.oligoId,
          catalogNumber: oligo.catalogNumber,
          name: oligo.name,
          artifactRevision: oligo.artifactRevision,
          linkedArtifactRevision: link?.artifactRevision ?? null,
          linkedAtDesignVersion: link?.linkedAtDesignVersion ?? null,
          via: link?.via ?? null,
          oligoBindingSplit: entry.oligoBindingSplit,
          tmC: oligo.tmC,
          tmConcentrationNm: oligo.tmConcentrationNm,
          tmModelLabel: oligo.tmModelLabel,
        }
      : null,
    candidateOligoIds: entry.candidates.map((candidate) => candidate.oligoId),
    sourceAttachment: projectSourceAttachment(entry.sourceAttachment),
  };
}

export function createSaveDesignPrimersTool(link: LinkCommand = linkAssemblyPrimerOligos) {
  return resultTool({
    description: SAVE_DESIGN_PRIMERS_DESCRIPTION,
    inputSchema: saveDesignPrimersSchema,
    execute: async (input) => {
      const designId = input.designId.startsWith('waypoint://design/')
        ? decodeURIComponent(input.designId.slice('waypoint://design/'.length))
        : input.designId;
      let result: LinkAssemblyPrimerOligosResult;
      try {
        result = await link({
          designId,
          expectedDesignVersion: input.expectedDesignVersion,
          saveUnsaved: input.saveUnsaved ?? true,
          restoreMissingBindingSplit: input.restoreMissingBindingSplit ?? false,
          ...(input.choices ? { choices: input.choices } : {}),
        });
      } catch (error) {
        return toolFailure({
          code: 'SAVE_DESIGN_PRIMERS_FAILED',
          error: error instanceof Error ? error.message : String(error),
          retriable: false,
          stateChanged: 'unknown',
          partialEffects: [],
          details: { designId },
        });
      }
      const report = result.report;
      if (result.status === 'refused') {
        const refusal = result.refusal ? REFUSALS[result.refusal.code] : null;
        return toolFailure({
          code: refusal?.code ?? 'SAVE_DESIGN_PRIMERS_REFUSED',
          error: result.refusal?.message ?? 'The design primers could not be saved or linked.',
          retriable: refusal?.retriable ?? false,
          stateChanged: result.oligoWrites.length > 0,
          partialEffects: result.oligoWrites.map((write) => ({ ...write })),
          details: {
            designId,
            ...(report
              ? {
                  designVersion: report.designVersion,
                  primers: report.primers.map(projectPrimerEntry),
                }
              : {}),
          },
        });
      }
      if (!report)
        return toolFailure({
          code: 'SAVE_DESIGN_PRIMERS_FAILED',
          error: 'The design primers were processed, but their current state could not be read.',
          retriable: false,
          stateChanged: 'unknown',
          partialEffects: [],
          details: { designId },
        });
      return toolSuccess({
        changed: result.changed,
        designId,
        designVersion: report.designVersion,
        linked: result.linked,
        kept: result.kept,
        ambiguous: result.ambiguous,
        unsaved: result.unsaved,
        unresolved: result.unresolved,
        bindingSplitRestored: result.bindingSplitRestored,
        failed: result.failed,
        tm: report.tm,
        primers: report.primers.map(projectPrimerEntry),
      });
    },
  });
}
