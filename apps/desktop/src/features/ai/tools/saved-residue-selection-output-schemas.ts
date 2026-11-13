import { z } from 'zod';
const count = z.number().int().nonnegative();
const interval = z.object({ start: z.number().int(), end: z.number().int() });
const chain = z.object({
  chain: z.string(),
  baseChain: z.string().optional(),
  labelAsymId: z.string().optional(),
  authAsymId: z.string().optional(),
  entityId: z.string().optional(),
  operator: z.string().optional(),
});
const sourceArtifact = z.object({
  entityId: z.string(),
  gitCommit: z.string().optional(),
  path: z.string().optional(),
});
const polymerRevision = z.object({
  moleculeId: z.string(),
  moleculeKind: z.string(),
  sequenceDigestSha256: z.string(),
  sourceArtifact: sourceArtifact.optional(),
  translation: z
    .object({
      featureId: z.string().optional(),
      strand: z.union([z.literal(1), z.literal(-1)]),
      geneticCode: z.number().int(),
      frame: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    })
    .optional(),
});
const structureRevision = z.object({
  id: z.string(),
  structureId: z.string(),
  providerIdentityKey: z.string().optional(),
  coordinateDigestSha256: z.string(),
  assemblyId: z.string().optional(),
  sourceArtifact: sourceArtifact.optional(),
});
const member = z.object({
  id: z.string(),
  selection: z.object({
    selectionId: z.string().optional(),
    source: z
      .object({
        kind: z.string(),
        id: z.string().optional(),
        surface: z.string().optional(),
        label: z.string().optional(),
      })
      .optional(),
    target: z.object({
      moleculeId: z.string(),
      moleculeKind: z.string(),
      coordinateSystem: z.literal('residue'),
      intervals: z.array(interval),
      label: z.string().optional(),
    }),
  }),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('polymer') }),
    z.object({
      kind: z.literal('structure-chain-instance'),
      structureRevisionId: z.string(),
      chain,
    }),
  ]),
  polymerRevision,
  residueIdentities: z
    .array(
      z.object({
        polymerIndex: count,
        authSeqId: z.number().int(),
        labelSeqId: z.number().int().optional(),
        labelCompId: z.string(),
        oneLetterCode: z.string(),
      })
    )
    .optional(),
});
const revision = z.object({
  id: z.string(),
  parentRevisionId: z.string().optional(),
  createdAt: z.string(),
  actor: z.object({ kind: z.enum(['user', 'agent', 'system']), id: z.string().optional() }),
  reason: z.string().optional(),
  members: z.array(member),
  structureRevisions: z.array(structureRevision),
});
const page = z.object({
  offset: count,
  returned: count,
  total: count,
  nextOffset: count.nullable(),
});
const warnings = z.array(z.object({ stage: z.string(), error: z.string() })).optional();
const exactSelection = chain.extend({
  compId: z.string().optional(),
  ranges: z.array(z.array(z.number().int()).length(2)),
});
export const listSavedResidueSelectionsOutputSchema = z.object({
  ok: z.literal(true),
  selections: z.array(
    z.object({
      selectionId: z.string(),
      currentRevisionId: z.string(),
      name: z.string(),
      color: z.string(),
      revisionCount: count,
      relativePath: z.string(),
      workspaceRoot: z.string(),
    })
  ),
  errors: z.array(z.object({ artifactPath: z.string(), error: z.string() })),
});
export const getSavedResidueSelectionOutputSchema = z.object({
  ok: z.literal(true),
  selectionId: z.string(),
  revisionId: z.string(),
  name: z.string(),
  color: z.string(),
  artifactPath: z.string(),
  revision,
  page: z.object({
    memberIndex: count,
    totalMembers: count,
    nextMemberIndex: count.nullable(),
    intervals: page,
    residueIdentities: page,
  }),
});
export const saveActiveResidueSelectionOutputSchema = z.object({
  ok: z.literal(true),
  stateChanged: z.literal(true),
  selectionId: z.string(),
  revisionId: z.string(),
  artifactPath: z.string(),
  structureRef: z.string(),
  exactSelection: z.array(exactSelection),
  warnings,
});
export const applySavedResidueSelectionOutputSchema = z.object({
  ok: z.literal(true),
  stateChanged: z.literal(true),
  structureRef: z.string(),
  selectionId: z.string(),
  revisionId: z.string(),
  visible: z.boolean(),
  warnings,
});
