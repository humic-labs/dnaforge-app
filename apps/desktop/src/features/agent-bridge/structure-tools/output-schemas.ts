import {
  resolverResultOutputSchema,
  pdbStructureReferenceOutputSchema,
  uniprotStructureReferenceOutputSchema,
  urlStructureReferenceOutputSchema,
} from './resolver-output-schemas';
import { jsonObjectSchema, jsonValueSchema } from '../../../shared/json-value';
import { molecularScientificReviewScreenshotSchema } from '../../../shared/molecular-scientific-review';
import { z } from 'zod';
import { molecularConnectionQuerySchema } from '../../page/public/embeds/structure3d/molstar/molecularConnectionReadback';
import {
  molecularRenderProfileSchema,
  molecularRenderProfileSelectionSchema,
} from '../../page/public/embeds/structure3d/molstar/molecularRenderProfile';
import {
  molecularDataSelectorExpressionSchema,
  molecularDatasetSchema,
  molecularDataMappingSchema,
  molecularDataLayerSchema,
} from '../../page/public/embeds/structure3d/molecularData';
import { residueMeasurementSchema } from '../../page/public/embeds/structure3d/residueMeasurement';
import {
  molecularAlleleSchema,
  molecularComparisonSchema,
  molecularViewEvidenceSchema,
} from '../../page/public/embeds/structure3d/molecularView';
import { molSetColorSchema, molSetRepresentationSchema } from './contracts';
import { molecularDocumentReferenceSchema } from '../../../shared/molecular-document-reference';
import { molecularDataLoadSchema } from '../../../shared/molecular-data-ipc';
import { molecularChainPageOutputSchema } from '../../../shared/molecular-tool-readback';
import {
  molecularDocumentBindingOutputFields,
  molecularDocumentParametersOutputSchema,
} from './document-output-schemas';

const count = z.number().int().nonnegative();
const indices = z.array(z.number().int());
const vec3 = z.array(z.number()).length(3);
const pluginParameters = jsonObjectSchema.describe(
  'Native Mol* plugin parameters; keys depend on the named representation or theme.'
);
export const cameraSnapshotOutputSchema = z.object({
  mode: z.enum(['perspective', 'orthographic']),
  fov: z.number(),
  position: vec3,
  up: vec3,
  target: vec3,
  radius: z.number(),
  radiusMax: z.number(),
  fog: z.number(),
  clipFar: z.boolean(),
  minNear: z.number(),
  minFar: z.number(),
});
const chainScope = {
  baseChain: z.string().optional(),
  labelAsymId: z.string().optional(),
  authAsymId: z.string().optional(),
  entityId: z.string().optional(),
  operator: z.string().optional(),
};
export const residueLocationOutputSchema = z.object({
  chain: z.string(),
  position: z.number().int(),
  compId: z.string().optional(),
  labelCompId: z.string().optional(),
  labelSeqId: z.number().int().optional(),
  ...chainScope,
});
const selectedResidue = z.object({
  chain: z.string(),
  position: z.number().int(),
  labelSeqId: z.number().int().nullable(),
  compId: z.string(),
  selectedAtomCount: count,
  totalResidueAtomCount: count,
  ...chainScope,
});
const chainSummary = z.object({
  chainId: z.string(),
  chainLabel: z.string(),
  polymerType: z.string().optional(),
  baseChain: z.string().nullable(),
  labelAsymId: z.string().nullable(),
  authAsymId: z.string().nullable(),
  entityId: z.string().nullable(),
  operator: z.string().nullable(),
  instanceId: z.string().nullable(),
  residueCount: count,
  residueRange: z.object({ start: z.number().int(), end: z.number().int() }).nullable(),
  residueRanges: z.array(z.object({ start: z.number().int(), end: z.number().int() })),
  sequenceLength: count,
});
const coloration = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('uniform'), color: z.number().int() }),
  z.object({ kind: z.literal('multiple'), colors: indices }),
  z.object({ kind: z.literal('partial'), colors: indices }),
  z.object({ kind: z.literal('unrepresented') }),
  z.object({ kind: z.literal('unavailable') }),
]);
const ligand = z.object({
  name: z.string(),
  chainId: z.string(),
  position: z.number().int(),
  atomCount: count,
  coloration: coloration.optional(),
  ...chainScope,
});
const endpoint = z.object({
  labelAsymId: z.string(),
  authAsymId: z.string(),
  authSeqId: z.number().int(),
  labelCompId: z.string(),
  labelAtomId: z.string(),
  element: z.string(),
  instanceId: z.string(),
  moleculeType: z.number().int(),
  polymerType: z.number().int(),
  coordinateAvailable: z.boolean(),
  selector: molecularDataSelectorExpressionSchema,
  residueSelector: molecularDataSelectorExpressionSchema,
});
export const molecularConnectionOutputSchema = z.object({
  id: z.string(),
  structureIndex: count,
  kind: z.enum(['covalent', 'disulfide', 'metal-coordination', 'hydrogen-bond', 'unknown']),
  source: z.enum(['deposited-struct_conn', 'molstar-computed', 'molstar-source-graph']),
  sourceType: z.string(),
  bondPresent: z.boolean(),
  attachment: z.boolean(),
  a: endpoint,
  b: endpoint,
  status: z.enum([
    'drawn',
    'not-depicted',
    'missing-attachment-geometry',
    'missing-coordinates',
    'source-bond-unavailable',
    'suppressed-unsupported-coordination',
  ]),
  depictionIssue: z.literal('ionic-metal-to-metal').optional(),
  representationOwners: z.array(z.string()),
});
export const molecularConnectionSummaryOutputSchema = z.object({
  total: count,
  attachmentCount: count,
  incompleteAttachmentCount: count,
  countsByKind: z.record(z.string(), count),
  countsByStatus: z.record(z.string(), count),
  page: z.object({
    query: molecularConnectionQuerySchema,
    offset: count,
    limit: count,
    matched: count,
    returned: count,
    nextOffset: count.nullable(),
  }),
  guidance: z.string(),
});
export const nativeSceneOutputSchema = z.object({
  colorSelectionGuidance: z.string(),
  camera: cameraSnapshotOutputSchema.nullable(),
  componentRefs: z.array(z.string()),
  molecularConnections: z.array(molecularConnectionOutputSchema),
  molecularConnectionSummary: molecularConnectionSummaryOutputSchema,
  components: z.array(
    z.object({
      label: z.string().nullable(),
      elementCount: count,
      representations: z.array(
        z.object({
          type: z.string().nullable(),
          alpha: z.number().nullable(),
          colorTheme: z.string().nullable(),
          color: z.number().nullable(),
          visuals: z.array(z.string()),
          typeParams: pluginParameters,
          colorThemeParams: pluginParameters,
          sizeTheme: z.object({ name: z.string(), params: pluginParameters }).nullable(),
        })
      ),
    })
  ),
});
const renderProfile = z.object({
  selection: molecularRenderProfileSelectionSchema,
  resolvedProfile: z.union([z.literal('native'), molecularRenderProfileSchema, z.null()]),
});
const story = z.object({
  activeIndex: count,
  steps: z.array(
    z.object({
      index: count,
      title: z.string(),
      description: z.string().optional(),
      key: z.string().optional(),
    })
  ),
});
const resource = z.object({
  uri: z.string(),
  format: z.enum(['pdb', 'mmcif', 'bcif']),
  boundTo: z.literal('current-structure-view'),
});

const primaryConformer = z.object({
  contract: z.literal('primary-deposited-conformer-v1'),
  mode: z.enum(['primary', 'comparison']),
  reason: z.string().optional(),
  selectedAtomCount: count,
  excludedAtomCount: count,
  alternatives: z.array(
    z.object({
      modelId: z.string(),
      instanceId: z.string(),
      labelAsymId: z.string(),
      authSeqId: z.number().int(),
      insertionCode: z.string(),
      selectedAltId: z.string().nullable(),
      choices: z.array(
        z.object({ altId: z.string(), meanOccupancy: z.number(), atomCount: count })
      ),
    })
  ),
});
const authoredMvsMetadata = jsonObjectSchema.describe(
  'Extensible custom metadata retained from the authored MolViewSpec document.'
);
const burialSide = z.object({
  selector: jsonValueSchema.describe('Native MolViewSpec atom selector.'),
  buriedArea: z.number(),
  residueCount: count,
  atomCount: count,
});
const interfaceBurial = z.object({
  contract: z.literal('native-molstar-interface-burial-v1'),
  parameters: z.object({
    probeSize: z.number(),
    numberOfSpherePoints: count,
    nonPolymer: z.boolean(),
    traceOnly: z.boolean(),
  }),
  target: burialSide,
  partner: burialSide,
});
const alignmentAnchor = z.object({
  labelAsymId: z.string(),
  authAsymId: z.string(),
  authSeqId: z.number().int(),
  labelSeqId: z.number().int(),
  insertionCode: z.string(),
  compId: z.string(),
  atomName: z.string(),
  atomIndex: count,
  sequenceCode: z.string(),
  polymer: z.enum(['protein', 'nucleic']),
  position: vec3,
});
const alignment = z.object({
  contract: z.literal('source-polymer-alignment-v1'),
  referenceStructureRef: z.string(),
  mobileStructureRef: z.string(),
  referenceRegion: jsonValueSchema.describe('Declared MolViewSpec reference-region selector.'),
  mobileRegion: jsonValueSchema.describe('Declared MolViewSpec mobile-region selector.'),
  referenceSelector: jsonValueSchema.describe('Resolved MolViewSpec reference selector.'),
  mobileSelector: jsonValueSchema.describe('Resolved MolViewSpec mobile selector.'),
  matrix: z.array(z.number()).length(16),
  rmsd: z.number(),
  alignmentScore: z.number(),
  correspondenceSource: z.literal('coordinates'),
  pairs: z.array(z.object({ reference: alignmentAnchor, mobile: alignmentAnchor })),
});
const scientificInventory = z.object({
  version: z.literal(1),
  sceneDigestSha256: z.string(),
  requiredForTrials: z.boolean(),
  questionCoverageRequiredForTrials: z.boolean(),
  guidance: z.string(),
  steps: z.array(
    z.object({
      index: count,
      title: z.string(),
      groups: z.array(z.object({ id: z.string(), label: z.string() })),
    })
  ),
});
const featureExposure = z.object({
  status: z.enum(['unavailable', 'sampled']),
  reason: z.string().optional(),
  selectedAtomCount: count.optional(),
  nonAtomicElementCount: count.optional(),
  sampledAtomCount: count.optional(),
  sampleLimit: count.optional(),
  counts: z.record(z.string(), count).optional(),
  matchingSampleAtomCount: count.optional(),
  picksFromRepresentationsWithTransparency: count.optional(),
  sampledCenterBoundsCss: z
    .object({ minX: z.number(), minY: z.number(), maxX: z.number(), maxY: z.number() })
    .nullable()
    .optional(),
  representationPicks: z.record(z.string(), count).optional(),
  viewport: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .optional(),
  cameraSnapshot: cameraSnapshotOutputSchema.nullable().optional(),
  pickSettings: z
    .object({
      alphaThreshold: z.number(),
      nativePaddingSetting: z.number(),
      pixelRatio: z.number(),
    })
    .optional(),
  transparentGeometryPresent: z.boolean().optional(),
  unpickableGeometryPresent: z.boolean().optional(),
  customClippingPresent: z.boolean().optional(),
});
const namedGroupSelection = z.object({
  label: z.string(),
  color: z.string(),
  presentationRole: z.string().optional(),
  selectable: z.boolean(),
  atomCount: count.optional(),
  residueCount: count.optional(),
  residues: z.array(selectedResidue.extend({ structureRef: z.string() })).optional(),
  truncated: z.boolean().optional(),
  frontmostAtSampledCenters: featureExposure,
  error: z.string().optional(),
});

const sceneShape = {
  format: z.literal('mvsj'),
  sceneOrigin: z.enum(['authored', 'starter']),
  scene: z.string(),
  renderProfile,
  renderProfileGuidance: z.string(),
  story: story.optional(),
  resource,
  supportedMajorVersion: z.number(),
  limitations: z.array(z.string()),
  guidance: z.string(),
  native: nativeSceneOutputSchema,
  primaryConformers: z
    .object({
      default: z.string(),
      recorded: jsonValueSchema,
      comparison: jsonValueSchema,
      guidance: z.string(),
    })
    .optional(),
  interactionContacts: z
    .array(
      z.object({
        snapshotIndex: count,
        contactCount: count,
        visible: z.boolean(),
        nativeOwnerContactCount: count.optional(),
      })
    )
    .optional(),
  resources: z
    .array(
      z.object({
        uri: z.string(),
        format: z.enum(['pdb', 'mmcif', 'bcif']),
        boundTo: z.enum(['current-structure-view', 'pinned-comparison-asset']),
        label: z.string().optional(),
        sha256: z.string().optional(),
      })
    )
    .optional(),
  structureIdentities: z
    .array(
      z.object({
        ref: z.string(),
        resourceUri: z.string().optional(),
        structureParams: pluginParameters.optional(),
      })
    )
    .optional(),
  comparisonContract: authoredMvsMetadata.optional(),
  displayGroupContract: z.string().optional(),
};
const sideChains = z.object({ visibleBackbones: z.boolean(), selection: z.boolean() });
const residueTarget = z.object({
  chain: z.string(),
  labelAsymId: z.string().optional(),
  authAsymId: z.string().optional(),
  entityId: z.string().optional(),
  operator: z.string().optional(),
  baseChain: z.string().optional(),
  residueMappingKind: z.literal('identity').optional(),
  residues: z
    .array(
      z.object({
        residueIndex: z.number().int(),
        position: z.number().int(),
        labelSeqId: z.number().int().optional(),
      })
    )
    .optional(),
});
export const registeredStructureOutputSchema = z.object({
  documentOwner: molecularDocumentBindingOutputFields.documentOwner.optional(),
  documentReference: molecularDocumentReferenceSchema.optional(),
  documentUnavailable: z.string().optional(),
  comparison: z
    .object({
      reference: z.object({ title: z.string(), chainId: z.string(), coordinateSha256: z.string() }),
      alternate: z.object({ title: z.string(), chainId: z.string(), coordinateSha256: z.string() }),
      alignment: molecularComparisonSchema.shape.alignment,
      allele: molecularAlleleSchema,
    })
    .nullable()
    .optional(),
  registrationId: z.string().optional(),
  structureId: z.string().optional(),
  structureViewId: z.string(),
  bindingId: z.string().nullable().optional(),
  viewerId: z.string().optional(),
  label: z.string(),
  source: z.enum(['pdb', 'alphafold', 'url', 'file']).nullable().optional(),
  inactiveReason: z.string().optional(),
  reactivation: z
    .object({ tool: z.literal('mol_activate_view'), structureViewId: z.string() })
    .optional(),
  savedViewReferenceId: z.string().nullable().optional(),
  retainedProtein: z
    .object({
      proteinSequenceSha256: z.string(),
      proteinLength: count,
      candidateId: z.string().nullable().optional(),
      measurements: z.array(residueMeasurementSchema),
      activeMeasurementId: z.string().optional(),
    })
    .optional(),
  sourceId: z.string().nullable().optional(),
  coordinateArtifact: z
    .object({
      entityId: z.string(),
      revisionId: z.string(),
      coordinateDigestSha256: z.string(),
      format: z.enum(['pdb', 'mmcif', 'binary-cif']),
    })
    .nullable()
    .optional(),
  proteinMapping: z
    .object({
      proteinSequenceSha256: z.string(),
      proteinLength: count,
      label: z.string(),
      residueTargets: z.array(residueTarget).optional(),
      measurements: z.array(residueMeasurementSchema).optional(),
      activeMeasurementId: z.string().optional(),
    })
    .nullable()
    .optional(),
  sceneFormat: z.enum(['molviewspec', 'recipe']).optional(),
  representation: z.string().optional(),
  colorMode: z.string().optional(),
  sideChains: sideChains.optional(),
  selectedResidues: z.array(residueLocationOutputSchema).optional(),
  selectionCount: count.nullable().optional(),
  currentSelection: z.object({
    selection: z.null(),
    lastMcpSelectionExpression: z.string().nullable(),
    selectedResidues: z.array(residueLocationOutputSchema),
    molstarSelectedResidues: z.array(selectedResidue),
    molstarElementCount: count.nullable(),
    molstarStatsLabel: z.string().nullable(),
  }).optional(),
  viewerStatus: z.enum(['active', 'inactive', 'loading', 'error']),
  chainCount: count.optional(),
  chainPage: molecularChainPageOutputSchema.optional(),
  chains: z.array(chainSummary).optional(),
  ligandCount: count.optional(),
  ligands: z.array(ligand).optional(),
  camera: cameraSnapshotOutputSchema.nullable().optional(),
  molecularConnections: z.array(molecularConnectionOutputSchema).nullable().optional(),
  molecularConnectionSummary: molecularConnectionSummaryOutputSchema.nullable().optional(),
  native: nativeSceneOutputSchema
    .omit({ molecularConnections: true, molecularConnectionSummary: true })
    .nullable()
    .optional(),
  renderProfile: renderProfile.nullable().optional(),
  stateError: z.string().optional(),
});
export const molListStructuresOutputSchema = z.object({
  ok: z.literal(true),
  structures: z.array(registeredStructureOutputSchema),
});
export const molGetStateOutputSchema = molListStructuresOutputSchema;
const fullSceneOutputSchema = z.object({
  ok: z.literal(true),
  structureViewId: z.string(),
  ...molecularDocumentBindingOutputFields,
  parameterSchema: molecularDocumentParametersOutputSchema.optional(),
  ...sceneShape,
  savedReferenceId: z.string().nullable().optional(),
  scientificReviewInventory: scientificInventory.optional(),
  featureExposureNotes: z.string().optional(),
  namedColorGroupSelections: z.array(namedGroupSelection).optional(),
});
export const molGetSceneOutputSchema = fullSceneOutputSchema
  .partial({
    scene: true,
    renderProfileGuidance: true,
    limitations: true,
    guidance: true,
    native: true,
  })
  .extend({
    sceneSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    activeIndex: count.optional(),
    viewCount: count.optional(),
    molecularConnections: z.array(molecularConnectionOutputSchema).optional(),
    molecularConnectionSummary: molecularConnectionSummaryOutputSchema.optional(),
  });
export const molApplySceneOutputSchema = molGetSceneOutputSchema
  .omit({
    documentOwner: true,
    documentReference: true,
  })
  .extend({
    rendered: z.literal(true),
  });
export const molAlignStructuresOutputSchema = fullSceneOutputSchema
  .omit({ documentOwner: true, documentReference: true })
  .extend({ rendered: z.literal(true), alignment });
export const molSaveToNotebookOutputSchema = z.object({
  ok: z.literal(true),
  referenceId: z.string(),
  pageId: z.string(),
  title: z.string(),
  inlineLink: z.string(),
  savedPresentationReferenceId: z.string(),
});
const contactFeature = z.object({
  expressions: z.array(z.object({ atom_index: count, instance_id: z.string().optional() })),
});
export const molShowInteractionContextOutputSchema = z.object({
  ok: z.literal(true),
  structureViewId: z.string(),
  rendered: z.literal(true),
  renderProfile,
  story: story.optional(),
  camera: cameraSnapshotOutputSchema.nullable(),
  message: z.string(),
  interactionContext: z.object({
    source: z.literal('molstar-native-interactions'),
    detailMode: z.string(),
    contactCalculation: z.object({
      contract: z.string(),
      engine: z.literal('molstar-native-interactions'),
      version: z.string(),
      types: z.array(z.string()),
      parameters: pluginParameters,
      scope: z.string(),
      primaryConformer,
      endpointPolicy: z.string(),
      excludedClassifications: z.array(
        z.object({
          classification: z.string(),
          reason: z.string(),
          featureA: contactFeature,
          featureB: contactFeature,
        })
      ),
    }),
    physicalIonContext: z
      .object({
        contract: z.literal('native-molstar-ion-physical-context-v2'),
        declaredTargetAtomCount: count,
        cohortAtomCount: count,
        contextualIonAtomCount: count,
        polymerUnitCount: count,
        selector: jsonValueSchema.describe('Native MolViewSpec ion-cohort selector.'),
        envelope: z.object({ min: vec3, max: vec3, margin: z.number() }).optional(),
        packing: interfaceBurial.optional(),
        meaning: z.string(),
      })
      .optional(),
    interfaceDetailSide: z.string().optional(),
    interfaceDetailBasis: z.string().optional(),
    interfaceProteinAtomicMode: z.string().optional(),
    requiredGuideFeatureAtomCount: count.optional(),
    interfaceBurial: interfaceBurial.optional(),
    interfaceSurfaceMeaning: z.string().optional(),
    presentationRole: z.string(),
    ligandContourMeaning: z.string().optional(),
    pocketDetailMeaning: z.string().optional(),
    surfaceSide: z.enum(['target', 'partner']).optional(),
    surfaceExtent: z.enum(['complete', 'contact-patch']).optional(),
    surfaceAtomCount: count.optional(),
    radius: z.number(),
    targetAtomCount: count,
    scientificTargetAtomCount: count,
    environmentAtomCount: count,
    contactCount: count,
    nativeCalculatedContactCount: count,
    unrelatedContactCount: count,
    displayedGuideCount: count,
    excludedContactCount: count,
    featureCenterMarkerCount: count,
    measurementCount: count,
    countsByType: z.record(z.string(), count),
    guidance: z.string(),
  }),
});
export const molActivateViewOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    structureViewId: z.string(),
    panelId: z.string(),
    tabId: z.string(),
  }),
  z.object({
    ok: z.literal(true),
    structureViewId: z.string(),
    surface: z.literal('background-worker'),
  }),
]);
export const molSaveViewOutputSchema = z.object({
  ok: z.literal(true),
  referenceId: z.string().optional(),
  revisionId: z.string().uuid(),
  structureViewId: z.string(),
  documentReference: molecularDocumentReferenceSchema,
  activeViewReference: molecularDocumentReferenceSchema,
  inlineLink: z.string(),
  molecularDocumentId: z.string().uuid(),
  molecularDocumentReference: molecularDocumentReferenceSchema,
  molecularDocumentProjectId: z.string(),
  molecularDocumentPath: z.string(),
  molecularDocumentRevision: z.string(),
  molecularDocumentSavedReferenceId: z.string().uuid(),
  referenceTargets: z
    .array(
      z.object({
        label: z.string(),
        documentReference: molecularDocumentReferenceSchema,
        inlineLink: z.string(),
        namedSelections: z.array(
          z.object({
            label: z.string(),
            documentReference: molecularDocumentReferenceSchema,
            inlineLink: z.string(),
          })
        ),
      })
    )
    .optional(),
  scientificReview: z
    .object({ sceneDigestSha256: z.string(), savedSceneDigestSha256: z.string(), stepCount: count })
    .optional(),
  warning: z.string().optional(),
  title: z.string(),
  caption: z.string(),
  evidence: z.array(molecularViewEvidenceSchema),
  coordinateDigestSha256: z.string(),
  format: z.literal('mvsj'),
  message: z.string(),
});
export const molSelectStoryStepOutputSchema = z.object({
  ok: z.literal(true),
  structureViewId: z.string(),
  rendered: z.literal(true),
  index: count,
  title: z.string().optional(),
  story: story.optional(),
});
const selectedOutput = z.object({
  ok: z.literal(true),
  viewerId: z.string(),
  selection: z.string(),
  warnings: z.array(z.string()).optional(),
});
export const molSelectResiduesOutputSchema = selectedOutput;
export const molFocusOutputSchema = selectedOutput;
export const molSetRepresentationOutputSchema = z.object({
  ok: z.literal(true),
  viewerId: z.string(),
  representation: molSetRepresentationSchema.innerType().shape.representation,
});
export const molSetColorOutputSchema = z.object({
  ok: z.literal(true),
  viewerId: z.string(),
  colorMode: molSetColorSchema.innerType().shape.colorMode,
});
export const molSetSideChainsOutputSchema = z.object({
  ok: z.literal(true),
  viewerId: z.string(),
  target: z.enum(['visible_backbones', 'selection']),
  visible: z.boolean(),
  sideChains,
});
export const molCaptureScreenshotOutputSchema = z.object({
  ok: z.literal(true),
  returns_image: z.literal(true),
  data: z.string(),
  mimeType: z.literal('image/png'),
  viewerId: z.string(),
  byteLength: count,
  width: count.nullable(),
  height: count.nullable(),
  maxBytes: count,
  downscaled: z.boolean(),
  scientificReviewScreenshot: molecularScientificReviewScreenshotSchema.optional(),
  warnings: z.array(z.string()).optional(),
});
const sourceRef = z.union([
  z.object({ kind: z.literal('file'), path: z.string() }),
  pdbStructureReferenceOutputSchema,
  uniprotStructureReferenceOutputSchema,
  urlStructureReferenceOutputSchema,
  z.object({ kind: z.literal('data'), format: z.enum(['pdb', 'cif']), byteLength: count }),
]);
export const molOpenTabOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    tabId: z.string(),
    structureViewId: z.string().optional(),
    documentReference: molecularDocumentReferenceSchema,
    viewerStatus: z.literal('loading'),
  }),
  z.object({
    ok: z.literal(true),
    tabId: z.string(),
    label: z.string(),
    structureViewId: z.string(),
    source: sourceRef,
    viewerStatus: z.literal('loading'),
    next: z.string(),
  }),
  z.object({
    ok: z.literal(true),
    viewerId: z.string(),
    tabId: z.string(),
    label: z.string(),
    source: sourceRef.nullable(),
  }),
]);
export const molOpenDrawerOutputSchema = z.object({
  ok: z.literal(true),
  status: z.enum(['idle', 'resolving', 'rendering', 'ready', 'no_match', 'error']),
  bytesReady: z.boolean(),
  documentId: z.string(),
  resourceUri: z.string(),
  annotationIndex: count,
  resolved: resolverResultOutputSchema.nullable(),
});
const unresolved = z.array(z.object({ row: count, reason: z.string() }));
const inspectedDataset = molecularDatasetSchema
  .partial({ records: true, originalTable: true })
  .extend({ rowCount: count.optional(), columns: z.array(z.string()).optional() });
export const molDataOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    structureViewId: z.string(),
    ...molecularDocumentBindingOutputFields,
    parameterAccess: z.object({
      tool: z.literal('mol_get_scene'),
      includeParameterSchema: z.literal(true),
    }),
    coordinateSha256: z.string(),
    resource,
    datasets: z.array(inspectedDataset),
    mappings: z.array(
      molecularDataMappingSchema.extend({
        resolution: z.object({ mappedRows: indices, unresolved }),
      })
    ),
    layers: z.array(molecularDataLayerSchema),
    activeLayerId: z.string().optional(),
  }),
  z.object({
    ok: z.literal(true),
    structureViewId: z.string(),
    datasetId: z.string(),
    dataRevision: z.string(),
    mappingRevision: z.string(),
    rowCount: count,
    mappedRows: indices,
    unresolved,
    displayChanged: z.literal(false),
    retained: molecularDataLoadSchema.pick({ datasetReferenceId: true, mappingReferenceId: true }),
  }),
  z.object({
    ok: z.literal(true),
    structureViewId: z.string(),
    rendered: z.literal(true),
    datasetId: z.string(),
    dataRevision: z.string(),
    mappingRevision: z.string(),
    activeLayer: molecularDataLayerSchema,
    mappedRows: indices,
    renderedRows: indices,
    unrenderedRows: indices,
    unresolved,
    cameraChanged: z.boolean(),
  }),
]);
