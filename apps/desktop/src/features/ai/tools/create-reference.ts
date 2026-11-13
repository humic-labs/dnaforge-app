import { referenceNavigationLinks } from '../../../services/entity-navigation';
import {
  resultTool,
  toolFailure,
  toolSuccess,
  type ToolStateChange,
} from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import { platform } from '../../../platform';
import {
  createEntityReference,
  getEntityReference,
  type DBEntityReference,
} from '../../../db/entity-references';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  loadSequenceDocumentBiologyFile,
  resolveMultiRootPath,
  resolveUniqueOpenTabWorkspaceBasename,
  type ResolvedMultiRootPath,
} from './path-utils';
import { getFilename } from '../../../utils/fileTypes';
import { matchFeatures } from './feature-matching';
import {
  buildStructureSelectionDescriptor,
  hasCompleteStructureResidueIdentities,
  resolvedStructureComponentId,
  structureSelectionsFromResidues,
} from '../selection-descriptor/structure';
import type {
  ChainSequence,
  ResidueLocation,
  Structure3dAttrs,
} from '../../page/public/embeds/structure3d/types';
import {
  projectSavedSelectionRevisionToHighlightGroup,
  residueLocationsForSavedSelectionRevision,
} from '../../page/public/embeds/structure3d/utils/savedSelectionProjection';
import { resolveSavedResidueSelectionRecord } from './saved-residue-selections';
import { workspaceRootPathForGitLocator } from '../references/inline/origin';
import { findContainingPathBoundary } from '../../../shared/path-boundary';
import { looksLikeWorkspacePath } from '../../../shared/resolve-entity-path';
import {
  molecularViewFromReferenceData,
  molecularViewReferenceTargets,
  molecularViewTargetSnapshotIndex,
  validateMolecularViewCoordinates,
} from '../../page/public/embeds/structure3d/molecularView';
import { encodeInlineReferenceDeclaration } from '../references/inline/codec';
import {
  molecularViewTargetLocator,
  resolveMolecularReference,
} from '../../../shared/molecular-reference';
import { resolveMolecularReferenceSnapshot } from '../references/molecular';
import {
  resolveCanonicalPrimerReference,
  type PrimerReferenceRequest,
} from '../../primers/public/primer-references';
import { resolveWorkspaceScope } from '../../../db/workspace-catalog';
import {
  molecularDocumentReferenceHref,
  molecularDocumentReferenceLocator,
} from '../../../shared/molecular-document-reference';

const ENTITY_TYPES = [
  'sequence',
  'sequence_region',
  'annotation',
  'primer',
  'notebook',
  'alignment',
  'structure',
  'molecular-document',
  'assembly',
  'protein',
] as const;

const directStructureSelectionSchema = z
  .object({
    kind: z.literal('structure'),
    structureRef: z
      .string()
      .min(1)
      .max(2000)
      .describe('Exact live/persisted structure id, for example PDB:3OAA or AFDB:P39702'),
    residues: z
      .array(
        z
          .object({
            chain: z.string().min(1).max(100),
            authSeqId: z.number().int().min(1),

            labelCompId: z.string().min(1).max(20),
            labelSeqId: z.number().int().min(1).optional(),
            baseChain: z.string().min(1).max(100).optional(),
            labelAsymId: z.string().min(1).max(100).optional(),
            authAsymId: z.string().min(1).max(100).optional(),
            entityId: z.string().min(1).max(100).optional(),
            operator: z.string().min(1).max(100).optional(),
            compId: z.string().min(1).max(20).optional(),
          })
          .strict()
      )
      .min(1)
      .max(200)
      .describe('Exact selected residue objects; never collapse a discontinuous set to min/max'),
  })
  .strict();

const savedResidueSelectionSchema = z
  .object({
    kind: z.literal('saved_residue_selection'),
    selectionId: z.string().min(1).max(200),
    revisionId: z.string().min(1).max(200).optional(),
  })
  .strict();

const existingReferenceSelectionSchema = z
  .object({
    kind: z.literal('existing_reference'),
    referenceId: z
      .string()
      .uuid()
      .describe(
        'Authoritative staged structure-selection reference id from the attached <wp-sel-…> descriptor'
      ),
  })
  .strict();

const structureSelectionSchema = z.discriminatedUnion('kind', [
  directStructureSelectionSchema,
  savedResidueSelectionSchema,
  existingReferenceSelectionSchema,
  z
    .object({
      kind: z.literal('molecular_view_target'),
      viewReferenceId: z.string().uuid(),
      viewId: z.string().min(1).max(1000).optional(),
      snapshotIndex: z.number().int().nonnegative().optional(),
      groupId: z.string().min(1).max(1000).optional(),
    })
    .strict(),
]);

const referenceDeepLinkParamsSchema = z
  .object({
    start: z.number().int().min(1).optional().describe('1-indexed inclusive region start'),
    end: z.number().int().min(1).optional().describe('1-indexed inclusive region end'),
    wraps: z.boolean().optional().describe('True only when a circular region crosses the origin'),
    bindingStart: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('1-indexed inclusive primer binding start'),
    bindingEnd: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('1-indexed inclusive primer binding end'),
    featureName: z.string().min(1).max(200).optional().describe('Exact annotation feature name'),
  })
  .passthrough();

function hasEntries(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

async function resolveReferenceFilePath(
  folders: WorkspaceFolder[],
  filePath: string
): Promise<ResolvedMultiRootPath> {
  try {
    return resolveMultiRootPath(folders, filePath);
  } catch (error) {
    const openTabPath = await resolveUniqueOpenTabWorkspaceBasename(folders, filePath);
    if (openTabPath) return openTabPath;
    throw error;
  }
}

export function createReferenceSchemaForFolders(folders: WorkspaceFolder[]) {
  return z
    .object({
      entityType: z.enum(ENTITY_TYPES).describe('Type of entity being referenced'),
      displayLabel: z
        .string()
        .max(200)
        .describe('Short label for the reference chip (e.g., "pUC19", "GFP_F1")'),
      documentId: z
        .string()
        .max(500)
        .optional()
        .describe(
          'Stable package/catalog identity for sequence, sequence_region, or annotation references. ' +
            'For a whole sequence only, a bare filename is accepted when it identifies exactly one currently open sequence tab; physical paths remain forbidden.'
        ),
      primerId: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          'Existing canonical Registry oligo ID returned as registryEntityId by create_primer. Standalone unbound oligos are valid. Legacy library IDs are accepted only after explicit translation and verification.'
        ),
      bindingId: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          'Optional existing primer attachment ID returned by get_primer. Omit to reference the oligo itself.'
        ),
      workspace: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe(
          'Exact mounted source project name or root for a primer artifact when ownership is ambiguous.'
        ),
      filePath: z
        .string()
        .max(2000)
        .optional()
        .describe(
          'For non-sequence file-based entities: project-relative path from list_files. ' +
            'For a whole sequence only, a bare filename is accepted when it identifies exactly one currently open sequence tab. ' +
            (folders.length > 1
              ? '(e.g., "Lab Data/plasmids/file.gb"). Prefix with folder name unless the basename identifies exactly one currently open file tab.'
              : '(e.g., "data/cas9-validation/file.gb"). Auto-constructs locator and validates the file exists.')
        ),
      locator: z
        .string()
        .max(2000)
        .optional()
        .describe(
          'For non-file entities: entity://type/id URI. Use filePath instead for file-based entities.'
        ),
      deepLinkParams: referenceDeepLinkParamsSchema
        .optional()
        .default({})
        .describe(
          'Type-specific params for navigating to a specific state in the viewer. ' +
            'For sequence_region: { start: number, end: number, wraps?: boolean } (1-indexed positions, GenBank convention). ' +
            'For annotation: { featureName: string }; the app resolves the exact start/end from the file. ' +
            'For primer: optional bindingStart/bindingEnd assertions (1-indexed inclusive); bindingId selects the actual saved attachment. No coordinates are needed for a standalone oligo. ' +
            'For structure: { representation?: "cartoon"|"ball-and-stick"|"surface"|"spacefill", ' +
            'colorMode?: "chain"|"element"|"plddt"|"bfactor", ' +
            'highlightGroups?: Array<{ label: string, selections: Array<{ chain: string, ranges: [number, number][] }>, color?: string }> }.'
        ),
      featureName: z
        .string()
        .max(200)
        .optional()
        .describe(
          'Name of an annotation/feature in the file. When provided with filePath, ' +
            'the server reads the file, finds the matching feature, and auto-populates ' +
            'deepLinkParams with exact coordinates. Use instead of manually specifying coordinates.'
        ),
      data: z
        .record(z.unknown())
        .optional()
        .describe(
          'Optional type-specific view context. Primer identity, bases and chemistry come from the existing canonical oligo; use primerId and optional bindingId rather than inline primer data.'
        ),
      selection: structureSelectionSchema
        .optional()
        .describe(
          'Use existing_reference to return the same staged entity unchanged; its entityType must match. ' +
            'An optional locator may repeat the staged reference locator as a checked consistency assertion. ' +
            'Use the documentReference and inlineLink returned by mol_save_view directly. The legacy molecular_view_target form requires verified document ownership and returns a canonical document reference. ' +
            'The structure and saved_residue_selection forms are structure-only and are the sole source ' +
            'of truth for locator, descriptor data, and highlight deep links.'
        ),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (
        value.entityType === 'molecular-document' &&
        value.selection?.kind !== 'existing_reference'
      )
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selection'],
          message: 'A molecular-document reference requires an existing verified referenceId.',
        });
      if (value.selection) {
        if (value.selection.kind !== 'existing_reference' && value.entityType !== 'structure') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['entityType'],
            message: 'A structure selection requires entityType "structure".',
          });
        }
        if (
          value.filePath ||
          value.primerId ||
          value.bindingId ||
          value.workspace ||
          value.documentId ||
          (value.locator && value.selection.kind !== 'existing_reference') ||
          value.featureName ||
          hasEntries(value.data) ||
          hasEntries(value.deepLinkParams)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['selection'],
            message:
              'When selection is provided, selection is the source of truth; omit documentId, filePath, featureName, data, and deepLinkParams. Only existing_reference may include a locator consistency assertion.',
          });
        }
        return;
      }

      const params = value.deepLinkParams ?? {};
      const isSequenceEntity = ['sequence', 'sequence_region', 'annotation'].includes(
        value.entityType
      );
      const hasOpenSequenceFilename = value.entityType === 'sequence' && Boolean(value.filePath);
      if (isSequenceEntity && !value.documentId && !hasOpenSequenceFilename) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['documentId'],
          message: `${value.entityType} requires a stable sequence documentId.`,
        });
      }
      if (isSequenceEntity && value.filePath && value.entityType !== 'sequence') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['filePath'],
          message: 'Sequence regions and annotations require documentId.',
        });
      }
      if (value.entityType === 'sequence' && value.documentId && value.filePath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['filePath'],
          message: 'Use documentId or one open sequence filename, not both.',
        });
      }
      const requirePositiveInteger = (field: string): void => {
        const coordinate = params[field];
        if (!Number.isInteger(coordinate) || (coordinate as number) < 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['deepLinkParams', field],
            message: `${value.entityType} requires a positive integer deepLinkParams.${field}.`,
          });
        }
      };
      if (value.entityType === 'sequence_region') {
        requirePositiveInteger('start');
        requirePositiveInteger('end');
      } else if (value.entityType === 'primer') {
        if (!value.primerId && !value.locator)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['primerId'],
            message:
              'A primer reference requires an existing canonical primerId or a verified legacy entity locator.',
          });
        if (value.filePath)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['filePath'],
            message: 'Use the existing oligo identity for a primer reference.',
          });
        if (params.bindingStart !== undefined || params.bindingEnd !== undefined) {
          requirePositiveInteger('bindingStart');
          requirePositiveInteger('bindingEnd');
        }
        if (
          Object.keys(value.data ?? {}).some(
            (key) =>
              !['registryEntityId', 'primerId', 'documentId', 'targetDocumentId'].includes(key)
          )
        )
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['data'],
            message:
              'Inline data cannot define a primer. Read its canonical oligo and supply primerId.',
          });
      } else if (
        value.entityType === 'annotation' &&
        !value.featureName &&
        (typeof params.featureName !== 'string' || params.featureName.trim().length === 0)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deepLinkParams', 'featureName'],
          message:
            'annotation requires top-level featureName or a non-empty deepLinkParams.featureName.',
        });
      }
    });
}

export const createReferenceSchema = createReferenceSchemaForFolders([]);

type RegisteredStructureContext = {
  structureId: string;
  attrs: Structure3dAttrs;
  chains: ChainSequence[];
  selectedResidues: ResidueLocation[];
};

export interface CreateReferenceToolDependencies {
  getStructureContext: (structureRef?: string) => Promise<RegisteredStructureContext>;
  getReference: (referenceId: string) => Promise<DBEntityReference | null>;
  resolvePrimerReference: (
    input: PrimerReferenceRequest,
    folders: readonly WorkspaceFolder[]
  ) => ReturnType<typeof resolveCanonicalPrimerReference>;
}

const defaultDependencies: CreateReferenceToolDependencies = {
  getStructureContext: async (structureRef) =>
    (
      await import('../../agent-bridge/public/structure-tools')
    ).getRegisteredStructureSelectionContext(structureRef),
  getReference: getEntityReference,
  resolvePrimerReference: resolveCanonicalPrimerReference,
};

type DirectStructureSelection = z.infer<typeof directStructureSelectionSchema>;

async function isReusableMolecularReference(reference: DBEntityReference | null): Promise<boolean> {
  if (
    !reference ||
    !['structure', 'molecular-document'].includes(reference.entity_type) ||
    reference.status !== 'created' ||
    !reference.data
  )
    return false;
  try {
    const subject = resolveMolecularReference(reference);
    if (
      subject?.kind === 'document' ||
      subject?.kind === 'visualization' ||
      subject?.kind === 'view'
    )
      return Boolean((await resolveMolecularReferenceSnapshot(reference)).view);
    if (subject?.kind !== 'selection' || !hasCompleteStructureResidueIdentities(subject.descriptor))
      return false;
    if (subject.target) await resolveMolecularReferenceSnapshot(reference);
    return true;
  } catch {
    return false;
  }
}

function optionalChainFieldMatches(
  requested: string | undefined,
  actual: string | undefined
): boolean {
  return requested === undefined || requested === actual;
}

async function validateAndCanonicalizeStructureResidues(
  selection: DirectStructureSelection,
  deps: CreateReferenceToolDependencies
): Promise<{ structureRef: string; residues: ResidueLocation[] }> {
  const context = await deps.getStructureContext(selection.structureRef);
  const residues: ResidueLocation[] = [];

  for (const requested of selection.residues) {
    const matchingChains = context.chains.filter(
      (chain) =>
        chain.chainId === requested.chain &&
        optionalChainFieldMatches(requested.baseChain, chain.baseChain) &&
        optionalChainFieldMatches(requested.labelAsymId, chain.labelAsymId) &&
        optionalChainFieldMatches(requested.authAsymId, chain.authAsymId) &&
        optionalChainFieldMatches(requested.entityId, chain.entityId) &&
        optionalChainFieldMatches(requested.operator, chain.operator)
    );
    if (matchingChains.length !== 1) {
      throw new Error(
        `Residue ${requested.chain}:${requested.authSeqId} does not identify exactly one live physical chain`
      );
    }

    const chain = matchingChains[0];
    const matchingResidues = chain.residues.filter(
      (residue) =>
        residue.position === requested.authSeqId &&
        (requested.labelSeqId === undefined || residue.labelSeqId === requested.labelSeqId)
    );
    if (matchingResidues.length !== 1) {
      throw new Error(
        `Residue ${requested.chain}:${requested.authSeqId} does not identify exactly one residue in the live structure`
      );
    }

    const liveResidue = matchingResidues[0];
    const requestedIdentity = resolvedStructureComponentId(requested.labelCompId);
    const liveIdentity = resolvedStructureComponentId(liveResidue.name3);
    if (!requestedIdentity || !liveIdentity) {
      throw new Error(
        `Residue ${chain.chainId}:${liveResidue.position} does not have a resolved live component identity`
      );
    }
    if (requestedIdentity !== liveIdentity) {
      throw new Error(
        `Agent-supplied residue identity ${requestedIdentity} disagrees with live structure identity ${liveIdentity} at ${chain.chainId}:${liveResidue.position}`
      );
    }

    residues.push({
      chain: chain.chainId,
      position: liveResidue.position,
      labelCompId: liveIdentity,
      ...(liveResidue.labelSeqId !== undefined ? { labelSeqId: liveResidue.labelSeqId } : {}),
      ...(chain.baseChain ? { baseChain: chain.baseChain } : {}),
      ...(chain.labelAsymId ? { labelAsymId: chain.labelAsymId } : {}),
      ...(chain.authAsymId ? { authAsymId: chain.authAsymId } : {}),
      ...(chain.entityId ? { entityId: chain.entityId } : {}),
      ...(chain.operator ? { operator: chain.operator } : {}),
    });
  }

  return { structureRef: context.structureId, residues };
}

function referenceFailure(error: string, stateChanged: ToolStateChange = false) {
  return {
    ...toolFailure({
      code: stateChanged === false ? 'REFERENCE_REJECTED' : 'REFERENCE_CREATION_FAILED',
      error,
      retriable: false,
      stateChanged,
      partialEffects: [],
    }),
    referenceId: null,
  };
}
export const CREATE_REFERENCE_TOOL_DESCRIPTION =
  'Create a durable clickable reference to a whole sequence document or a rich DNAForge entity or selection. ' +
  'For a whole sequence document, use entityType:"sequence" with the stable documentId returned by workspace tools; ' +
  'do not link its physical path or resourceUri as a workspace file. ' +
  'For an ordinary non-sequence workspace file or folder, link its path inline instead. ' +
  'Identity is mandatory: sequence_region requires deepLinkParams.start/end (1-indexed inclusive), ' +
  'primer uses a validated canonical Registry oligo, including a standalone unbound oligo, with bindingId optional for a saved attachment; annotation requires top-level featureName or deepLinkParams.featureName. ' +
  'For an attached structure selection returned unchanged, reuse its authoritative refId with ' +
  'selection.kind="existing_reference" instead of copying residues or depending on a mounted viewer. ' +
  'Returns a referenceId; the app renders the chip from the completed tool result.';

export function createCreateReferenceTool(
  folders: WorkspaceFolder[],
  dependencies: Partial<CreateReferenceToolDependencies> = {}
) {
  const deps = { ...defaultDependencies, ...dependencies };
  const inputSchema = createReferenceSchemaForFolders(folders);

  return resultTool({
    description: CREATE_REFERENCE_TOOL_DESCRIPTION,
    inputSchema: inputSchema as z.ZodTypeAny,
    execute: async ({
      entityType,
      displayLabel,
      documentId,
      primerId,
      bindingId,
      workspace,
      filePath,
      locator,
      deepLinkParams,
      featureName,
      data,
      selection,
    }: z.infer<typeof inputSchema>) => {
      let mutationAttempted = false;
      try {
        let finalLocator: string;
        let finalLabel = displayLabel;
        let finalDeepLinkParams = deepLinkParams;
        let finalData = data;
        let workspaceRootPath: string | null = null;
        let primerIdentity: Awaited<ReturnType<typeof resolveCanonicalPrimerReference>> | undefined;

        if (selection) {
          if (
            documentId ||
            primerId ||
            bindingId ||
            workspace ||
            filePath ||
            (locator && selection.kind !== 'existing_reference') ||
            featureName ||
            hasEntries(data) ||
            hasEntries(deepLinkParams)
          ) {
            return referenceFailure(
              'When selection is provided, selection is the source of truth; omit competing documentId, filePath, featureName, data, and deepLinkParams. Only existing_reference may include a locator consistency assertion.'
            );
          }
          if (selection.kind === 'existing_reference') {
            const existingReference = await deps.getReference(selection.referenceId);
            if (
              (entityType === 'structure' || entityType === 'molecular-document') &&
              !(await isReusableMolecularReference(existingReference))
            ) {
              return referenceFailure(
                'The supplied referenceId is not an identity-complete structure selection or an available molecular view.'
              );
            }
            if (
              !existingReference ||
              existingReference.status !== 'created' ||
              existingReference.entity_type !== entityType
            ) {
              return referenceFailure(
                'The supplied referenceId does not identify a matching created entity.'
              );
            }
            if (locator && locator !== existingReference.locator) {
              return referenceFailure(
                'The supplied locator does not match the authoritative locator for referenceId.'
              );
            }
            if (entityType === 'primer') {
              const existingData = existingReference.data
                ? JSON.parse(existingReference.data)
                : null;
              if (typeof existingData?.registryEntityId !== 'string')
                throw new Error(
                  'Recreate this legacy primer reference from the canonical Registry oligo ID.'
                );
              const canonical = await deps.resolvePrimerReference(
                {
                  id: existingData.registryEntityId,
                  ...(existingReference.workspace_root_path
                    ? { workspace: existingReference.workspace_root_path }
                    : {}),
                  ...(typeof existingData.bindingId === 'string'
                    ? { bindingId: existingData.bindingId }
                    : {}),
                },
                folders
              );
              const savedParams = existingReference.deep_link_params
                ? JSON.parse(existingReference.deep_link_params)
                : null;
              if (
                existingReference.locator !== canonical.locator ||
                (existingData.primerId ?? null) !== canonical.primerId ||
                (existingData.targetDocumentId ?? null) !==
                  (canonical.data.targetDocumentId ?? null) ||
                (savedParams?.bindingStart ?? null) !==
                  (canonical.deepLinkParams?.bindingStart ?? null) ||
                (savedParams?.bindingEnd ?? null) !== (canonical.deepLinkParams?.bindingEnd ?? null)
              )
                throw new Error(
                  'The saved primer reference disagrees with its canonical oligo or current attachment. Recreate it.'
                );
            }
            return toolSuccess({
              referenceId: existingReference.id,
              reused: true,
              ...(await referenceNavigationLinks(existingReference)),
            });
          }
          if (entityType !== 'structure') {
            return referenceFailure(
              'A new or saved structure selection requires entityType "structure".'
            );
          }
          if (selection.kind === 'molecular_view_target') {
            const parent = await deps.getReference(selection.viewReferenceId);
            const view =
              parent?.entity_type === 'structure' && parent.status === 'created'
                ? molecularViewFromReferenceData(parent.data)
                : null;
            if (!parent || !view)
              throw Error('The saved molecular view is missing or unsupported.');
            let resolved: Awaited<ReturnType<typeof resolveMolecularReferenceSnapshot>>;
            try {
              resolved = await resolveMolecularReferenceSnapshot(parent);
            } catch (error) {
              return referenceFailure(error instanceof Error ? error.message : String(error));
            }
            if (!resolved.document)
              return referenceFailure('The molecular view has no verified document owner.');
            await validateMolecularViewCoordinates(view);
            const snapshotIndex = molecularViewTargetSnapshotIndex(view, selection);
            const step = molecularViewReferenceTargets(parent.id, view).find(
              (candidate) => candidate.selection.snapshotIndex === snapshotIndex
            );
            if (!step) throw Error('The saved view step does not exist.');
            const group = selection.groupId
              ? step.namedSelections.find(
                  (candidate) => candidate.selection.groupId === selection.groupId
                )
              : undefined;
            if (selection.groupId && !group)
              throw Error('The named selection does not exist in this saved view step.');
            if (!step.selection.viewId)
              throw Error(
                'Save this molecular document with stable named views before creating a view or group reference.'
              );
            const target = {
              ...resolved.document.documentReference,
              viewId: step.selection.viewId,
              ...(selection.groupId ? { groupId: selection.groupId } : {}),
            };
            mutationAttempted = true;
            const ref = await createEntityReference({
              entityType: 'molecular-document',
              displayLabel: group?.label ?? step.label,
              locator: molecularDocumentReferenceLocator(target),
              deepLinkParams: null,
              data: target,
              source: 'ai',
              workspaceScope: target.projectId,
              workspaceRootPath: resolved.document.saved.workspaceRoot,
            });
            return toolSuccess({
              referenceId: ref.id,
              ...(await referenceNavigationLinks(ref)),
              entityType: 'molecular-document',
              documentReference: target,
              inlineLink: molecularDocumentReferenceHref(target),
            });
          }
          let residues: ResidueLocation[];
          let structureRef: string;
          let savedSelectionRef: { selectionId: string; revisionId: string } | undefined;
          let savedProjection:
            | ReturnType<typeof projectSavedSelectionRevisionToHighlightGroup>
            | undefined;
          if (selection.kind === 'saved_residue_selection') {
            const record = await resolveSavedResidueSelectionRecord(folders, selection.selectionId);
            const resolvedRevisionId = selection.revisionId ?? record.document.currentRevisionId;
            const revision = record.document.revisions.find(
              (candidate) => candidate.id === resolvedRevisionId
            );
            if (!revision) {
              return referenceFailure(`Saved selection revision not found: ${resolvedRevisionId}`);
            }
            const requiredStructureIds = new Set(
              revision.members.flatMap((member) => {
                if (member.scope.kind !== 'structure-chain-instance') return [];
                const scope = member.scope;
                const pinned = revision.structureRevisions.find(
                  (candidate) => candidate.id === scope.structureRevisionId
                );
                return pinned ? [pinned.structureId] : [];
              })
            );
            if (requiredStructureIds.size !== 1) {
              return referenceFailure(
                'A clickable structure object requires exactly one pinned structure revision.'
              );
            }
            structureRef = [...requiredStructureIds][0];
            residues = residueLocationsForSavedSelectionRevision(
              record.document,
              resolvedRevisionId
            );
            savedSelectionRef = {
              selectionId: record.document.id,
              revisionId: resolvedRevisionId,
            };
            savedProjection = projectSavedSelectionRevisionToHighlightGroup(
              record.document,
              resolvedRevisionId,
              true
            );
          } else {
            const missingIdentity = selection.residues.find(
              (residue) => !residue.labelCompId?.trim()
            );
            if (missingIdentity) {
              return referenceFailure(
                'Structure selection residue identity is missing for ' +
                  `${missingIdentity.chain}:${missingIdentity.authSeqId}. ` +
                  'Read the live Mol* selection with mol_get_state and retry with labelCompId.'
              );
            }
            const validated = await validateAndCanonicalizeStructureResidues(selection, deps);
            structureRef = validated.structureRef;
            residues = validated.residues;
          }
          const descriptor = buildStructureSelectionDescriptor({
            kind: 'structure',
            path: structureRef,
            label: displayLabel,
            residues,
            visibleRepresentations: [],
            ...(savedSelectionRef ? { savedSelectionRef } : {}),
          });
          if (!descriptor) {
            return referenceFailure('Typed structure selection contains no valid residues.');
          }
          if (!hasCompleteStructureResidueIdentities(descriptor)) {
            return referenceFailure(
              'Structure selection exceeds the identity-complete reference limit or contains an unresolved residue identity.'
            );
          }
          finalLocator = `entity://structure/${structureRef}`;
          finalData = descriptor as unknown as Record<string, unknown>;
          finalDeepLinkParams = {
            highlightGroups: [
              savedProjection ?? {
                id: 'agent-reference-selection',
                label: displayLabel,
                renderMode: 'selection',
                selections: structureSelectionsFromResidues(residues).map(
                  ({ regions, ...scope }) => ({
                    ...scope,
                    ranges: regions.map(({ start, end }) => [start, end] as [number, number]),
                  })
                ),
              },
            ],
          };
        } else if (entityType === 'primer') {
          if (
            filePath ||
            Object.keys(data ?? {}).some(
              (key) =>
                !['registryEntityId', 'primerId', 'documentId', 'targetDocumentId'].includes(key)
            )
          )
            throw new Error(
              'Inline data cannot define a primer. Supply its existing canonical oligo identity.'
            );
          const locatorId = locator
            ? /^entity:\/\/(?:primer|lims)\/([^/?#]+)$/.exec(locator)?.[1]
            : undefined;
          if (locator && !locatorId)
            throw new Error('A primer locator must identify an existing canonical oligo.');
          const id = primerId ?? (locatorId ? decodeURIComponent(locatorId) : undefined);
          if (!id) throw new Error('A primer reference requires an existing canonical primerId.');
          const documentAssertions = [documentId, data?.targetDocumentId, data?.documentId].filter(
            (value): value is string => typeof value === 'string'
          );
          if (new Set(documentAssertions).size > 1)
            throw new Error('The supplied primer target document identities disagree.');
          const requestedDocument = documentAssertions[0];
          primerIdentity = await deps.resolvePrimerReference(
            {
              id,
              workspace,
              bindingId,
              documentId: requestedDocument,
              bindingStart: deepLinkParams?.bindingStart,
              bindingEnd: deepLinkParams?.bindingEnd,
            },
            folders
          );
          if (primerId && locatorId && decodeURIComponent(locatorId) !== primerId) {
            const legacy = await deps.resolvePrimerReference(
              { id: decodeURIComponent(locatorId), workspace },
              folders
            );
            if (legacy.registryEntityId !== primerIdentity.registryEntityId)
              throw new Error('The supplied primer identities disagree.');
          }
          if (
            (data?.registryEntityId && data.registryEntityId !== primerIdentity.registryEntityId) ||
            (data?.primerId && data.primerId !== primerIdentity.primerId)
          )
            throw new Error('The supplied primer context disagrees with canonical identity.');
          finalLocator = primerIdentity.locator;
          finalLabel = primerIdentity.displayLabel;
          finalData = primerIdentity.data;
          finalDeepLinkParams = primerIdentity.deepLinkParams ?? {};
          workspaceRootPath = primerIdentity.workspaceRoot;
        } else if (documentId || (entityType === 'sequence' && filePath)) {
          let resolvedDocumentId = documentId;
          if (entityType === 'sequence' && documentId && looksLikeWorkspacePath(documentId)) {
            const openTab = await resolveUniqueOpenTabWorkspaceBasename(folders, documentId);
            if (openTab?.documentId) resolvedDocumentId = openTab.documentId;
          }
          if (!resolvedDocumentId && filePath) {
            const openTab = await resolveUniqueOpenTabWorkspaceBasename(folders, filePath);
            if (!openTab?.documentId) {
              return referenceFailure(
                'A bare sequence filename must identify exactly one open sequence tab. Open the file or use its stable documentId.'
              );
            }
            resolvedDocumentId = openTab.documentId;
          }
          if (!resolvedDocumentId) {
            return referenceFailure('A stable sequence documentId is required.');
          }
          const loaded = await loadSequenceDocumentBiologyFile(resolvedDocumentId, folders);
          finalLocator = loaded.documentId;
          finalLabel = loaded.name || loaded.biology.sequence.name || displayLabel;
          finalData = { ...(finalData ?? {}), documentId: loaded.documentId };
          workspaceRootPath = findContainingPathBoundary(folders, loaded.sourcePath)?.path ?? null;
        } else if (filePath) {
          const resolved = await resolveReferenceFilePath(folders, filePath);

          finalLocator = `git://${resolved.folder.name}/${resolved.relativePath}`;
          workspaceRootPath = resolved.folder.path;

          finalLabel = getFilename(resolved.relativePath);

          const fileExists = await platform().fs.exists(resolved.absolutePath);
          if (!fileExists) {
            return referenceFailure(
              `File not found: ${filePath}. Use list_files to verify the exact path.`
            );
          }
        } else if (locator) {
          if (!locator.startsWith('git://') && !locator.startsWith('entity://')) {
            return referenceFailure('Locator must use git:// or entity:// scheme');
          }
          finalLocator = locator;

          const gitLocatorMatch = locator.match(/^git:\/\/[^/]+\/(.+)/);
          if (gitLocatorMatch) {
            finalLabel = getFilename(gitLocatorMatch[1]);
            workspaceRootPath = workspaceRootPathForGitLocator(locator, folders);
            if (!workspaceRootPath) {
              return referenceFailure('The Git locator must name exactly one open project root.');
            }
          }
        } else {
          return referenceFailure('A stable documentId or locator is required.');
        }

        const requestedFeatureName =
          featureName ??
          (typeof finalDeepLinkParams?.featureName === 'string'
            ? finalDeepLinkParams.featureName
            : undefined);
        if (requestedFeatureName) {
          if (!documentId) {
            return referenceFailure('featureName requires a stable sequence documentId.');
          }

          try {
            const loaded = await loadSequenceDocumentBiologyFile(documentId, folders);
            const result = loaded.biology;
            const matches = matchFeatures(result.features, requestedFeatureName);

            if (matches.length === 0) {
              const available = result.features
                .slice(0, 20)
                .map((f) => f.displayName)
                .join(', ');
              return referenceFailure(
                `No feature matching "${requestedFeatureName}" found. Available features: ${available}`
              );
            }

            if (matches.length > 1) {
              const matchList = matches
                .map((f) => `${f.displayName} (${f.type}, ${f.start}..${f.end})`)
                .join(', ');
              return referenceFailure(
                `Multiple features match "${requestedFeatureName}": ${matchList}. Be more specific.`
              );
            }

            const feature = matches[0];
            finalDeepLinkParams = {
              ...(finalDeepLinkParams || {}),
              featureName: feature.displayName,
              start: feature.start,
              end: feature.end,
            };
          } catch (err) {
            return referenceFailure(
              `Failed to resolve featureName: ${err instanceof Error ? err.message : 'Unknown error'}`
            );
          }
        }

        mutationAttempted = true;
        const ref = await createEntityReference({
          entityType,
          displayLabel: finalLabel,
          locator: finalLocator,
          deepLinkParams:
            finalDeepLinkParams && Object.keys(finalDeepLinkParams).length > 0
              ? finalDeepLinkParams
              : null,
          data: finalData ?? null,
          source: 'ai',
          workspaceScope: workspaceRootPath ? await resolveWorkspaceScope(workspaceRootPath) : null,
          workspaceRootPath,
        });

        return toolSuccess({
          referenceId: ref.id,
          ...(await referenceNavigationLinks(ref)),
          ...(primerIdentity
            ? {
                entityId: primerIdentity.registryEntityId,
                registryEntityId: primerIdentity.registryEntityId,
                primerId: primerIdentity.primerId,
                workspaceRoot: primerIdentity.workspaceRoot,
                localOnly: primerIdentity.localOnly,
              }
            : {}),
          inlineLink: encodeInlineReferenceDeclaration({
            kind: 'existing-reference',
            referenceId: ref.id,
          }),
        });
      } catch (error) {
        return referenceFailure(
          `Failed to create reference: ${error instanceof Error ? error.message : 'Unknown error'}`,
          mutationAttempted ? 'unknown' : false
        );
      }
    },
  });
}
