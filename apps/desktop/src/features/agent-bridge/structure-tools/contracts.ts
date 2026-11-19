import { molecularConnectionQuerySchema } from '../../page/public/embeds/structure3d/molstar/molecularConnectionReadback';
export type { MolecularConnectionQuery } from '../../page/public/embeds/structure3d/molstar/molecularConnectionReadback';
import { z } from 'zod';
import { localStructureFileSourceSchema } from './local-file-source';
import { molecularScientificReviewInputSchema } from '../../page/public/embeds/structure3d/molstar/molecularScientificReviewSchema';
import { molecularExactSelectionSchema } from './molecularExactSelectionSchema';
import { molecularViewEvidenceSchema } from '../../page/public/embeds/structure3d/molecularView';
import { molecularDataLayerSchema } from '../../page/public/embeds/structure3d/molecularData';
import { molecularDataPublicationRequestSchema } from './molecular-data-source';
import { molecularParameterEditsSchema } from './document-parameter-contract';
import {
  molecularChainPageSchema,
  molecularDetailSchema,
} from '../../../shared/molecular-tool-readback';
import {
  molecularDocumentReferenceSchema,
  molecularDocumentReferenceHref,
  type MolecularDocumentReference,
} from '../../../shared/molecular-document-reference';

const molecularDataLayerRequestSchema = molecularDataLayerSchema
  .innerType()
  .extend({
    dataRevision: molecularDataLayerSchema.innerType().shape.dataRevision.optional(),
    mappingRevision: molecularDataLayerSchema.innerType().shape.mappingRevision.optional(),
    revision: z
      .literal('current')
      .optional()
      .describe(
        'Use "current" to bind this dataset’s latest published data and mapping inside the command. Omit both digest fields in this mode; the saved variation retains the exact resolved digests.'
      ),
  })
  .superRefine((layer, context) => {
    if (
      layer.revision === 'current'
        ? layer.dataRevision !== undefined || layer.mappingRevision !== undefined
        : layer.dataRevision === undefined || layer.mappingRevision === undefined
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Use revision:"current" without digest fields, or supply both exact dataRevision and mappingRevision without revision.',
      });
    const { revision: _revision, ...exact } = layer;
    const checked = molecularDataLayerSchema.safeParse({
      ...exact,
      dataRevision: exact.dataRevision ?? '0'.repeat(64),
      mappingRevision: exact.mappingRevision ?? '0'.repeat(64),
    });
    if (!checked.success) for (const issue of checked.error.issues) context.addIssue(issue);
  });

export const molDataSchema = z
  .object({
    operation: z
      .enum(['inspect', 'publish', 'apply'])
      .describe(
        'inspect reads current data; publish stores publication without changing appearance; apply displays layer. Use only the fields for the chosen operation.'
      ),
    structureViewId: z.string().min(1).optional(),
    documentReference: molecularDocumentReferenceSchema.optional(),
    includeRecords: z
      .boolean()
      .optional()
      .describe(
        'inspect only: top-level flag to return original records and tables. This is not a publication field.'
      ),
    publication: molecularDataPublicationRequestSchema
      .optional()
      .describe(
        'publish only: {id,name,source,records OR table,mapping}. table uses text OR a workspace path. Within mapping supply selectorColumn OR selectorColumns OR targets, exactly one; unresolved is optional. Do not add inspect/apply fields here.'
      ),
    layer: molecularDataLayerRequestSchema
      .optional()
      .describe(
        'apply only: {id,name,datasetId,revision:"current",column,style}, or replace revision with both exact dataRevision and mappingRevision. Other operation fields do not belong here.'
      ),
    expectedRevision: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe(
        'publish only: required to replace an existing dataset id. Never supply this field for apply.'
      ),
    expectedActiveLayerId: z
      .string()
      .min(1)
      .optional()
      .describe('apply only: optional compare-and-set guard for the displayed variation.'),
  })
  .strict()
  .superRefine((input, context) => {
    if (Boolean(input.structureViewId) === Boolean(input.documentReference))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Supply exactly one documentReference or structureViewId.',
      });
    const fields = {
      inspect: ['includeRecords'],
      publish: ['publication', 'expectedRevision'],
      apply: ['layer', 'expectedActiveLayerId'],
    }[input.operation];
    const required =
      input.operation === 'publish'
        ? 'publication'
        : input.operation === 'apply'
          ? 'layer'
          : undefined;
    if (required && !input[required])
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${input.operation} requires ${required}.`,
      });
    for (const key of [
      'includeRecords',
      'publication',
      'layer',
      'expectedRevision',
      'expectedActiveLayerId',
    ] as const)
      if (input[key] !== undefined && !fields.includes(key))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${key} is not a parameter of ${input.operation}.`,
        });
  });
import {
  interfaceDetailBasisSchema,
  interfaceDetailSideSchema,
  interfaceProteinAtomicModeSchema,
} from '../../page/public/embeds/structure3d/molstar/molecularBindingIntent';

export const MOLSTAR_MCP_REPRESENTATION_RECIPE_IDS = [
  'cartoon',
  'ball-and-stick',
  'spacefill',
  'surface',
  'illustrative',
  'hybrid',
  'query-in-complex',
  'query-in-complex-surface',
  'assembly-overview',
] as const;

export const structureSourceSchema = z.discriminatedUnion('kind', [
  localStructureFileSourceSchema,
  z
    .object({
      kind: z.literal('pdb'),
      pdbId: z.string().min(4).max(4),
    })
    .strict(),
  z
    .object({
      kind: z.literal('uniprot'),
      accession: z.string().min(1).max(30),
    })
    .strict(),
  z
    .object({
      kind: z.literal('url'),
      url: z.string().url().max(2000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('data'),
      format: z.enum(['pdb', 'cif']),
      data: z.string().min(1).max(10_000_000),
    })
    .strict(),
]);

export const molOpenTabSchema = z
  .object({
    structure: structureSourceSchema.optional(),
    documentReference: molecularDocumentReferenceSchema.optional(),
    label: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (input) => Boolean(input.structure) !== Boolean(input.documentReference),
    'Supply one documentReference or coordinate structure source.'
  );

export const molOpenDrawerSchema = z
  .object({
    documentId: z
      .string()
      .min(1)
      .describe(
        'Stable package/catalog sequence document ID or waypoint://sequence/{documentId} URI.'
      ),
    annotationIndex: z.number().int().min(0),
  })
  .strict();

export const molListStructuresSchema = z
  .object({ detail: molecularDetailSchema.optional() })
  .strict();

export const molActivateViewSchema = z.object({ structureViewId: z.string().min(1) }).strict();

const alignmentRegionSchema = z
  .object({
    label_asym_id: z.string().min(1).optional(),
    auth_asym_id: z.string().min(1).optional(),
    instance_id: z.string().min(1).optional(),
    beg_auth_seq_id: z.number().int().optional(),
    end_auth_seq_id: z.number().int().optional(),
    beg_label_seq_id: z.number().int().optional(),
    end_label_seq_id: z.number().int().optional(),
  })
  .strict()
  .refine(
    (region) => Boolean(region.label_asym_id || region.auth_asym_id),
    'Declare a label or author chain identity for the scientific alignment region.'
  );

export const molAlignStructuresSchema = z
  .object({
    structureViewId: z.string().min(1),
    referenceStructureRef: z
      .string()
      .min(1)
      .describe(
        'Exact MVS structure ref from mol_get_scene.structureIdentities; this structure stays fixed.'
      ),
    mobileStructureRef: z
      .string()
      .min(1)
      .describe('Different loaded MVS structure ref whose placement will change.'),
    referenceRegion: alignmentRegionSchema.describe(
      'One physical polymer chain, optionally restricted to a partial residue interval.'
    ),
    mobileRegion: alignmentRegionSchema.describe(
      'Corresponding scientific region in the mobile structure. Residue numbering need not match.'
    ),
    maximumRmsd: z
      .number()
      .finite()
      .min(0)
      .optional()
      .describe(
        'Optional maximum allowed coordinate fit RMSD in angstroms; exceeding it fails before mutation.'
      ),
  })
  .strict();

const structureTargetShape = {
  documentReference: molecularDocumentReferenceSchema
    .optional()
    .describe(
      'Exact typed molecular document reference returned by Save or inspection. Supply this or one runtime target, exactly one.'
    ),
  structureViewId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Preferred logical structure view ID. Supply only one target field: structureViewId, bindingId, or legacy viewerId. Omit the other two.'
    ),
  bindingId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Alternative sequence-to-structure binding ID. Use this instead of structureViewId; never combine target fields.'
    ),
  viewerId: z
    .string()
    .min(1)
    .optional()
    .describe('Legacy alternative target ID. Omit when using structureViewId or bindingId.'),
};

export type StructureTargetInput = {
  documentReference?: MolecularDocumentReference;
  structureViewId?: string;
  bindingId?: string;
  viewerId?: string;
};

function validateStructureTarget(
  input: StructureTargetInput,
  context: z.RefinementCtx,
  allowEmpty: boolean
): void {
  const count = [
    input.documentReference,
    input.structureViewId,
    input.bindingId,
    input.viewerId,
  ].filter(Boolean).length;
  if ((allowEmpty && count <= 1) || (!allowEmpty && count === 1)) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: allowEmpty
      ? 'Provide at most one documentReference, structureViewId, bindingId, or legacy viewerId.'
      : 'Provide exactly one documentReference, structureViewId, bindingId, or legacy viewerId.',
  });
}

export function structureTargetRef(input: StructureTargetInput): string | undefined {
  return input.documentReference
    ? molecularDocumentReferenceHref(input.documentReference)
    : (input.structureViewId ?? input.bindingId ?? input.viewerId);
}

export const molSaveViewSchema = z
  .object({
    ...structureTargetShape,
    destinationProject: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        'Exact writable project name or root for a new document or an explicit copy. Existing documents retain their owning project.'
      ),
    title: z.string().min(1).max(200),
    caption: z.string().max(2000),
    evidence: z
      .array(molecularViewEvidenceSchema)
      .max(20)
      .describe(
        'Required evidence array of actual public HTTP(S) URLs. Supply [] when none are available; describe local-file evidence in the caption and never invent URLs or private app locators.'
      ),
    saveToProject: z
      .literal(true)
      .optional()
      .describe(
        'Deprecated compatibility field. Every save writes the owning molecular document and returns its typed documentReference automatically.'
      ),
    newPresentation: z
      .boolean()
      .optional()
      .describe(
        'Explicitly create a separate molecular document copy. Ordinary saves update the owning document and retain immutable earlier revisions.'
      ),
    changeSummary: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe('Brief description of what changed in this save.'),
    scientificReview: molecularScientificReviewInputSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => validateStructureTarget(input, context, false));

export const molGetStateSchema = z
  .object({
    ...structureTargetShape,
    detail: molecularDetailSchema.optional(),
    chainPage: molecularChainPageSchema.optional(),
    connectionQuery: molecularConnectionQuerySchema
      .optional()
      .describe(
        'Bounded native connection inventory: filter kind, attachmentsOnly, labelAsymId/authSeqId, or page with offset and limit (max 64). Read molecularConnectionSummary for totals and nextOffset.'
      ),
  })
  .strict()
  .superRefine((input, context) => {
    validateStructureTarget(input, context, !input.chainPage);
  });

export const molSetRepresentationSchema = z
  .object({
    ...structureTargetShape,
    representation: z.enum(MOLSTAR_MCP_REPRESENTATION_RECIPE_IDS),
  })
  .strict()
  .superRefine((input, context) => validateStructureTarget(input, context, false));

export const molSetColorSchema = z
  .object({
    ...structureTargetShape,
    colorMode: z.enum(['chain', 'element', 'plddt', 'bfactor', 'alphamissense']),
  })
  .strict()
  .superRefine((input, context) => validateStructureTarget(input, context, false));

export const molSetSideChainsSchema = z
  .object({
    ...structureTargetShape,
    target: z.enum(['visible_backbones', 'selection']),
    visible: z.boolean(),
  })
  .strict()
  .superRefine((input, context) => validateStructureTarget(input, context, false));

export const molSelectionSchema = z
  .object({
    ...structureTargetShape,
    selection: z.string().min(1).max(2000),
  })
  .strict()
  .superRefine((input, context) => validateStructureTarget(input, context, false));

export const molCaptureScreenshotSchema = z
  .object({
    ...structureTargetShape,
  })
  .strict()
  .superRefine((input, context) => validateStructureTarget(input, context, false));

export const molGetSceneSchema = z
  .object({
    ...structureTargetShape,
    detail: molecularDetailSchema.optional(),
    includeScene: z
      .boolean()
      .optional()
      .describe('Export the complete MolViewSpec JSON in scene without the full native readback.'),
    includeParameterSchema: z
      .boolean()
      .optional()
      .describe(
        'Return revision-fenced paths, current values, defaults, types and constraints from the installed official MolViewSpec parameter schema.'
      ),
    parameterOffset: z.number().int().nonnegative().optional(),
    parameterLimit: z.number().int().min(1).max(256).optional(),
    parameterNodeKind: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('Filter parameter discovery by exact node kind, such as camera.'),
    parameterSnapshotIndex: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Filter parameter discovery to one zero-based perspective. Use 0 for a single-view scene.'),
    includeColorGroupSelections: z
      .boolean()
      .optional()
      .describe(
        'Set true to resolve each clickable color group to its exact selected residues in the active scene; use this before saving a ligand close-up. The readback does not alter the current selection.'
      ),
    connectionQuery: molecularConnectionQuerySchema
      .optional()
      .describe(
        'Optional filters/page for native connection readback; max 64 records. The complete scene document is unchanged.'
      ),
  })
  .strict()
  .superRefine((input, context) => validateStructureTarget(input, context, false));

export const molSelectStoryStepSchema = z
  .object({
    ...structureTargetShape,
    index: z.number().int().nonnegative().describe('Zero-based index of a MolViewSpec story step.'),
  })
  .strict()
  .superRefine((input, context) => validateStructureTarget(input, context, false));

export const MAX_MOL_SCENE_BYTES = 2_000_000;

export const molApplySceneSchema = z
  .object({
    ...structureTargetShape,
    detail: molecularDetailSchema.optional(),
    parameterEdits: molecularParameterEditsSchema
      .optional()
      .describe(
        'Atomic parameter values at exact paths returned by mol_get_scene with includeParameterSchema. Supply these instead of scene, scenePath or root, with expectedSceneSha256.'
      ),
    expectedSceneSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
      .describe('Current sceneSha256 from mol_get_scene or the previous edit receipt. Required for parameterEdits.'),
    expectedActiveIndex: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Optional active perspective guard. Use activeIndex from mol_get_scene when editing the selected view.'),
    viewAction: z
      .enum(['edit-current', 'add', 'replace'])
      .optional()
      .describe(
        'edit-current replaces only the active named perspective; add appends one perspective. Supply a single-view scene for these actions; other views are retained by the host. In an existing multi-view presentation, omitting the action edits the active perspective. Use replace explicitly to replace the complete presentation. Select the intended view first.'
      ),
    scene: z
      .string()
      .min(1)
      .max(MAX_MOL_SCENE_BYTES)
      .optional()
      .describe(
        'Complete standard MolViewSpec JSON (MVSJ) for one view or kind:"multiple" snapshots. Export a starting document with mol_get_scene and includeScene:true. Keep its resource URI, parse format and canvas background in every view.'
      ),
    scenePath: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe('Path to a complete MolViewSpec JSON file inside an authorized workspace, up to 2 MB. Use viewAction:"replace" to replace the whole presentation.'),
    root: z
      .record(z.unknown())
      .optional()
      .describe(
        'Author one standard MolViewSpec root node: {kind:"root",children:[...]}. Supply root instead of scene; DNAForge stamps official format/version/time metadata. Use mol_get_scene with includeScene:true to read the starting root and retain its coordinate URI, parse format and canvas background.'
      ),
    reapplyUnchanged: z
      .boolean()
      .optional()
      .describe(
        'Set true only to deliberately restore the same authored scene after the live camera or renderer has drifted.'
      ),
    renderProfile: z
      .literal('default')
      .optional()
      .describe(
        'Use the viewer-bound versioned profile. Omit this field or use default; native and replacement profile objects are unavailable to the agent. Explicit scene styling remains editable.'
      ),
  })
  .strict()
  .superRefine((input, context) => {
    validateStructureTarget(input, context, false);
    if (
      [input.scene, input.scenePath, input.root, input.parameterEdits].filter(
        (value) => value !== undefined
      ).length !== 1
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Supply exactly one of scene, scenePath, root, or parameterEdits.',
      });
    if (
      input.parameterEdits &&
      (!input.expectedSceneSha256 || (input.viewAction && input.viewAction !== 'replace'))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Parameter edits require expectedSceneSha256 and no viewAction or replace.',
      });
  });

const interactionSelectionSchema = z.union([
  molSelectionSchema.innerType().shape.selection,
  molecularExactSelectionSchema,
]);

export const molShowInteractionContextSchema = z
  .object({
    ...structureTargetShape,
    surfaceColorMode: z
      .enum(['identity', 'emphasis'])
      .optional()
      .describe(
        'Surface inherits complete molecular identities by default. Use emphasis only to deliberately project local color patches onto its contour.'
      ),
    sceneStructureRef: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Exact MVS structure ref from mol_get_scene.structureIdentities. Required when this viewer contains multiple structures; all seed/target/partner selections are scoped to that source.'
      ),
    surfaceSide: z
      .enum(['target', 'partner'])
      .optional()
      .describe(
        'Single side owning an interface surface; choose target or partner, never both. Routine complete-ligand binding contours own the target ligand.'
      ),
    surfaceExtent: z
      .enum(['complete', 'contact-patch'])
      .optional()
      .describe(
        'Complete draws the entire chosen molecular side without hiding residues. Contact-patch deliberately shows only its native buried-residue patch. A side containing molecular ligands or attached glycans defaults to complete; pure protein interfaces default to contact-patch. Complete molecular ligand contours cannot be clipped.'
      ),
    interfaceDetailSide: interfaceDetailSideSchema
      .optional()
      .describe(
        'Required together with interfaceDetailBasis for new native interfaces containing protein on both declared sides. Choose target, partner, or both from the question. Selected sides receive supporting protein sidechains and traces by default; interfaceProteinAtomicMode:full-residue retains full protein backbone detail when the question needs it; opposing sides retain minimum opaque native-guide feature atoms, including complete aromatic and charge groups and mandatory chemical attachments. Complete both-side measurements and the surface owner are unchanged. Attached glycans retain their chemistry. Omit for ligand, ion and RNA-only contexts; native ligand ownership overrides an interface role. Saved historical views retain their recorded presentation.'
      ),
    interfaceDetailBasis: interfaceDetailBasisSchema
      .optional()
      .describe(
        'Required together with interfaceDetailSide for new native protein interfaces; there is no automatic detail choice. Contacts selects selected-side protein residues supporting the unchanged native contact set. Burial additionally selects every native buried protein residue on that side. Native sidechain-with-trace is the default protein depiction; full-residue is available for backbone explanations. Required opposing guide features and nonprotein chemistry remain visible. This controls presentation only, never contact categories, search radius, guide membership, ASA calculation or contour extent. Ligand, ion and RNA-only contexts do not require this field.'
      ),
    interfaceProteinAtomicMode: interfaceProteinAtomicModeSchema
      .optional()
      .describe(
        "Native protein-interface depiction. Sidechain-with-trace is the default: Molstar's maintained selector omits redundant protein backbone sticks while retaining every required native polar, aromatic and charge feature and actual deposited covalent path to the cartoon trace. Choose full-residue when the protein backbone itself explains the question. Complete residue measurements, guides, surface ownership, nonprotein chemistry and attachments are unchanged. Ligand pockets, ions and RNA-only contexts retain their existing detail. Historical scenes replay their recorded atoms."
      ),
    targetSelection: interactionSelectionSchema
      .optional()
      .describe(
        'Complete scientific target side for surface ownership, independent of the local contact seed. Omit when selection already defines the complete target. The seed must be contained in this side. For an attached epitope, include its protein and attached molecules as appropriate.'
      ),
    partnerSelection: interactionSelectionSchema
      .optional()
      .describe(
        'Complete intended binding partner side for surface ownership, including attached molecules when appropriate. This does not filter the native Focus contact set. Use a bounded PyMOL string or exact MVS expression/OR list from the source scene; instance_id distinguishes physical coordinate copies. Exact expressions require sceneStructureRef. Required for interface surfaces.'
      ),
    presentationRole: z
      .enum(['binding-site', 'interface'])
      .optional()
      .describe(
        'Scientific purpose of the computed region. Defaults to binding-site. Interface requires surfaceSide and partnerSelection: one complete scientific side owns its contour. interfaceDetailSide and interfaceDetailBasis choose protein atomic presentation, independently of the complete measurements and surface selector. Required native-guide features remain drawn on both sides.'
      ),
    selection: interactionSelectionSchema.describe(
      'Choose the physical molecule or residues to focus. Standard native Molstar contacts are computed in the fixed 5 Å discovery neighborhood. Ligand-binding and interface displays retain every contact crossing their scientific partners and exclude internal contacts. Other local focus displays keep the complete native neighborhood. Categories, radius and individual lines are not agent choices. Use a bounded PyMOL string or exact MVS expression/OR list; keys within an expression are AND and an array is OR. Use instance_id for one physical copy. Exact expressions require sceneStructureRef.'
    ),
    focus: z
      .boolean()
      .optional()
      .describe(
        'True (default) reframes the camera on the new interaction context using its current view direction. False preserves the current native camera pose, including when replacing a previously focused context; stale focus commands are removed.'
      ),
    measurements: z
      .boolean()
      .optional()
      .describe(
        'Add numeric distance labels to native contact lines; defaults to false. Enable only when the user requests distances. Contact lines and distance tooltips remain available when false.'
      ),
    maxMeasurements: z
      .number()
      .int()
      .min(0)
      .max(20)
      .optional()
      .describe(
        'Maximum numeric distance labels when measurements is true; defaults to six. Set zero to omit labels while retaining contact lines.'
      ),
    renderProfile: molApplySceneSchema.innerType().shape.renderProfile,
  })
  .strict()
  .superRefine((input, context) => {
    validateStructureTarget(input, context, false);
    if (
      [input.selection, input.targetSelection, input.partnerSelection].some(
        (selection) => selection !== undefined && typeof selection !== 'string'
      ) &&
      !input.sceneStructureRef
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Exact MVS selections require sceneStructureRef for their declared coordinate source.',
      });
    if (input.presentationRole === 'interface' && (!input.surfaceSide || !input.partnerSelection))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Interface surfaces require surfaceSide and partnerSelection.',
      });
    if (
      (input.interfaceDetailSide !== undefined ||
        input.interfaceDetailBasis !== undefined ||
        input.interfaceProteinAtomicMode !== undefined) &&
      input.presentationRole !== 'interface'
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Interface atomic-detail choices require presentationRole:interface.',
      });
    if (input.surfaceSide && !input.partnerSelection)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A surface side requires partnerSelection.',
      });
  });

export type StructureSourceInput = z.infer<typeof structureSourceSchema>;
