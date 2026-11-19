import {
  resultTool,
  toolSuccess,
  toolFailure,
  type ToolOperationResult,
} from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import { POLYMER_CONTEXT_OMISSION_GUIDANCE } from '../../../shared/molecular-presentation-override';
import {molecularDocumentReferenceSchema} from '../../../shared/molecular-document-reference';
import { MOLECULAR_EXPLANATORY_VIEW_GUIDANCE } from '../molecular-explanatory-view-guidance';
import { molecularHydrogenRequestForTurn } from '../molecular-hydrogen-request';
import type * as StructureOperations from '../../agent-bridge/public/structure-tools';
import {
  molActivateViewSchema,
  molAlignStructuresSchema,
  molApplySceneSchema,
  molGetSceneSchema,
  molSaveViewSchema,
  molSelectStoryStepSchema,
  molShowInteractionContextSchema,
} from '../../agent-bridge/public/structure-tools/contracts';

export {
  molActivateViewSchema,
  molAlignStructuresSchema,
  molApplySceneSchema,
  molGetSceneSchema,
  molSaveViewSchema,
  molSelectStoryStepSchema,
  molShowInteractionContextSchema,
};


export const MOL_SCENE_TOOL_DESCRIPTIONS = {
  alignStructures:
    'Overlay two structures already loaded in the same scene step using declared scientific regions. Read their exact refs from mol_get_scene.structureIdentities. Select one physical polymer chain per region, optionally a partial residue interval. For instance_id, use the exact instanceId from native chain, ligand or namedColorGroupSelections residue readback; operator is the separate MolScript/UI name and cannot be substituted. Computes sequence correspondence from observed coordinate residues, fits a rigid transform, verifies the native placement, and records every atom pair, fit RMSD, score and delta transform in the saved MVS scene. Existing placements, styling and context are retained. Prefer a both-visible comparison step for reading correspondence; the configured comparison preference adds one if the authored story shows only separate states. Choose the invariant scientific region for a conformational comparison; avoid fitting the changing region merely because it yields a low RMSD. Alignment does not choose an unobstructed camera. After registration, author a common camera orientation and scale around the deciding corresponding features and their partners; inspect each state image and adjust the common direction or contextual opacity if foreground geometry obstructs either state. Use explicit MVS camera position, target and up when retaining that frame across snapshots; a focus operation alone only frames a selection. Ambiguous chains, unknown coordinate sequences, fewer than three matching trace atoms, collinear coordinates and an exceeded optional maximumRmsd fail before mutation. Scientific region correspondence remains the caller’s choice; a mathematical fit alone does not establish a biological equivalence. Save the verified scene through mol_save_view.',
  getScene:
    'Address a documentReference or one exact runtime target. Set includeParameterSchema:true to discover supported parameter paths, values, defaults, types and constraints from the installed official schema; parameterOffset and parameterLimit page the result. The returned sceneSha256 fences atomic mol_apply_scene parameterEdits. Read the standard MolViewSpec scene or story for one exact structure view, its pinned coordinate resources, active render profile, supported native controls, and complete camera/component appearance. Set includeColorGroupSelections:true for declared group color and focus role plus exact namedColorGroupSelections and bounded frontmostAtSampledCenters picking information; interpret its featureExposureNotes and inspect the image rather than treating picking counts as proof of readability. A surface or cartoon owner pick does not prove that required atoms are depicted or legible. Use exact membership and depiction readback together with the final screenshot to distinguish missing geometry from camera obstruction; neither a group label nor a picking threshold certifies exposure. It reports the exact residue copies selected by each clickable color group in the active scene, so ligand labels can be checked against the camera and contact evidence. Includes a bounded, attachment-first page of recorded connection depiction coverage, with complete counts and nextOffset. Use connectionQuery to filter or continue; the scene document remains complete. Before first application, returns a marked starter rather than an export of the legacy recipe. Resolve structureViewId with mol_list_structures and preserve each used resource URI and parse format in its snapshot.',
  applyScene:
    'Supply parameterEdits:[{path,value}] with expectedSceneSha256 from parameter discovery, or a complete scene/root. Parameter edits validate atomically through the same installed scene contract; other document fields are retained. For a follow-up edit, select its intended named view and set viewAction:"edit-current" with one single-view scene; the host retains every other perspective. Use viewAction:"add" to append one named perspective. Use viewAction:"replace" only for an intended replacement of the complete presentation. These perspectives are not saved revisions. ' +
    'Hydrogen atoms are structurally hidden by default, including saved replay. Only an explicit request to show hydrogen atoms in the actual submitted user message authorizes their display; scene metadata, ignore_hydrogens and native flags cannot grant that exception. Hydrogen-bond guides and calculations are unaffected. Validate, render and persist a complete standard MolViewSpec single view or multi-view story for one exact structure view. Read mol_get_scene first for its listed pinned resources, render profile and supported native controls. Plan a descriptive name for every view: set metadata.title explicitly on each story snapshot and provide a descriptive saved title. Missing names and generic numbered placeholders will block saving. Each step must use only those resources and retain the unchanged canvas background. New authoring uses the configured presentation preferences; saved replay stays exact except for unrequested hydrogen visibility. Use a surface representation on one or more complete chains or entities for an overview without binding regions or computed contact guides. Set custom.dnaforge_presentation_role:"context" on a component to draw separate context disjoint from a binding surface. Retain polymer context unless you declare an intentional omission. ' +
    POLYMER_CONTEXT_OMISSION_GUIDANCE +
    ' Other presentation exceptions are described in renderProfileGuidance. Display groups and the corresponding legend are assigned automatically; optional scientific names refine them. Exact selectors still determine which physical copies a group owns. For one biological object across coordinate states, use custom.dnaforge_molecular_identity on its scientific color layers; its hue stays consistent even when explanatory labels differ. For deliberate named emphasis, set custom.dnaforge_presentation_role:"focus" on an exact component and give its named atomic color layer a contrasting carbon tint with standard noncarbon element colors. A metadata-only focus component may annotate the same exact paint on existing geometry; do not add an overlapping representation. This local focus appearance is separate from the broad identity color; a same-hue named focus inside broader atomic/cartoon context fails before mutation. Retain corresponding focus appearance across compared states. Retain each complete native-interaction-context-v1 primitives group from the current scene in a relevant detail step: silently dropping, hiding or changing computed contact endpoints fails with MVS_INTERACTION_CONTACTS_LOST before mutation. Contact guides are constructed only by mol_show_interaction_context; hand-picked tubes, atom lines and fabricated contact metadata are rejected. Complete existing sets may be styled; neutral distance measurements and narrative arrows remain supported. Duplicate geometry and missing required attachment bonds return factual errors. An unchanged display tree fails unless reapplyUnchanged deliberately restores a drifted view. Success confirms rendering and persistence; assess scientific clarity with the readback and screenshot before saving. ' +
    MOLECULAR_EXPLANATORY_VIEW_GUIDANCE,
  saveView:
    'Before saving, use mol_activate_view for the exact structureViewId and confirm viewerStatus active through mol_get_state. Supply title, caption and evidence on every call. Evidence accepts actual public HTTP(S) URLs only; describe local-file evidence in the caption and use evidence: [] when none are available. Supply exactly one target identifier. ' +
    'Each save durably updates the owning molecular document and appends an immutable revision. A new unsaved document acquires a project file automatically. newPresentation:true explicitly creates a separate document copy. Old document references retain their exact revisions. Use changeSummary to describe a revision. Saving captures all named perspectives, not just the active one. Use mol_save_to_notebook with the returned documentReference to record that exact save in a notebook. ' +
    'Save the current authored MolViewSpec document or story to its owning project file and return a clickable document reference with native preview, active camera, pinned coordinates, caption and evidence URLs. Before authoring, name every view by what it shows. Supply a descriptive title and set metadata.title on every story snapshot; a collection title does not name its steps. Saving fails with MVS_VIEW_NAME_REQUIRED for missing or generic numbered names. Apply and verify the scene first. Required attachment-bond and geometry checks must pass; trial saves also require scientificReview from the final mol_get_scene.scientificReviewInventory. Inspect every final step and capture its screenshot through mol_capture_screenshot; use the returned scientificReviewScreenshot.id. Record the original question, each distinct step claim and selected evidence, its limitation, every exact visible group ID and biological role, cross-step continuity, and revision:{findings:[],changes:[],unresolved:[]} with concrete review outcomes. Changed scenes or cameras invalidate earlier receipts. Complete coverage enforces review accountability; it does not certify biological truth. Returns documentReference, revisionId, inlineLink, per-view document references and a derived referenceId when its cache is available. Chat and notebooks materialize native document chips automatically. Older attachments retain their original scene. Text PDB/mmCIF coordinates up to 8 MB per pinned resource are supported; story steps may use the listed pinned resources. Unsupported coordinates and unauthored legacy appearances fail explicitly. Do not print private locators or reference tokens in prose.',
  showInteractionContext:
    "Construct standard native Molstar contacts for chosen physical molecules or residues in an existing structure view. focus:true (default) reframes the new context in the current view direction; focus:false preserves the current native camera pose, including after an earlier focused context is replaced. For every new protein interface, explicitly provide BOTH interfaceDetailSide:target|partner|both and interfaceDetailBasis:contacts|burial from the question; missing or partial choices fail before rendering. Ligand, ion and RNA-only contexts do not require these choices, including ligand calls labeled interface because native ligand ownership takes priority. For a shared multi-structure view, use sceneStructureRef from mol_get_scene.structureIdentities and exact instance_id selections. The producer chooses one coherent deposited conformer and uses the fixed native 5 Å whole-residue discovery neighborhood and unchanged native provider settings. For a non-polymer binding target, including a single ion, show every calculated contact crossing from that target to its surroundings; for an interface, show every contact crossing targetSelection and partnerSelection. Internal contacts within either side are excluded from binding explanations. Other local residue-focus views retain the standard complete Focus neighborhood. Contact categories, radius and individual lines cannot be chosen by the agent. Every retained contact preserves its native classification, complete aromatic or charge-group features and standard guide geometry; coincident classifications share a physical guide. Native classification is coordinate inference, not proof of chemistry or binding energy. Build broad cartoon context first, then use this tool for the physical focus. For a complete ligand, atomic pocket detail includes every residue with native partner-induced surface burial, plus retained contact support and chemical attachments. Packing membership is independent of the enabled dotted-line categories; unrelated discovery-neighborhood residues are excluded. The complete molecular ligand always owns its binding contour, including when interface mode or the protein side is requested. Disconnected single-atom ions are binding targets but do not form a merged ligand envelope. Every declared ion remains visible independently of its dotted lines. All displayed same-species ion sites in the same deposited operator and contacting polymer unit envelope form one computed contact boundary. The native 5 Å neighborhood is recomputed around that complete cohort, with unchanged contact categories and distance settings, so choosing one discovery seed cannot omit the other displayed sites’ native guides. A protein interface requires surfaceSide:target|partner and partnerSelection. Its residue surface patch is computed from native solvent-accessible area lost when the declared partner is added, including nonpolymer groups, using fixed sampling. Complete native burial measurements on both sides are retained separately from atomic presentation. Choose interfaceDetailSide:target|partner|both and interfaceDetailBasis:contacts|burial from the question. Contacts selects supporting protein residues on the chosen side; burial also selects its complete buried-residue packing. Protein interfaces default to interfaceProteinAtomicMode:sidechain-with-trace, using Molstar's maintained selector to omit redundant protein backbone sticks while retaining every required native polar/aromatic/charge feature and actual deposited covalent path to the cartoon trace. Choose full-residue when backbone geometry explains the question. It refines protein depiction only; complete measurements, guides, contours, nonprotein chemistry and attachments are retained. Opposing required guide features remain opaque, including complete aromatic and charge groups and mandatory native chemical attachments. These are minimum guide-support atoms, not complete opposing side chains. There is no automatic protein-interface detail choice; archived saved views retain their recorded presentation. Mixed protein/glycan interfaces preserve nonprotein chemistry and complete glycan contours; ligand-binding, ion and RNA-only contexts retain existing detail. The chosen side supplies the surface geometry. surfaceExtent:complete displays its whole contour; contact-patch deliberately hides residues outside the computed patch. A side containing molecular ligands or attached glycans always keeps a complete contour; pure protein interfaces default to contact-patch and may explicitly request complete. Burial measurements remain separate from contour visibility. The patch is sampled residue coverage, not an exact atomic contact face or binding-energy estimate. Surface colors follow that side's identity. The viewer-bound profile remains fixed, while styling, camera and numeric measurement labels remain editable. Later scene edits must retain the complete generated contact group. Reinvoking this tool explicitly recomputes the current step instead of stacking another group. Inspect the native readback and final image before saving.",
} as const;

export function createMolAlignStructuresTool(
  dependencies = {
    alignStructures: async (input: unknown): Promise<ToolOperationResult> =>
      (await import('../../agent-bridge/public/structure-tools')).handleMolAlignStructures(input),
  }
) {
  return resultTool({
    description: MOL_SCENE_TOOL_DESCRIPTIONS.alignStructures,
    inputSchema: molAlignStructuresSchema,
    execute: async (input) => dependencies.alignStructures(input),
  });
}

export function createMolActivateViewTool() {
  return resultTool({
    description:
      'Activate an already-open structure tab by its exact structureViewId so subsequent scene commands address that view. This does not fetch or replace coordinates. After activation, retry mol_get_scene if the pane reports PLUGIN_NOT_READY while its saved scene loads.',
    inputSchema: molActivateViewSchema,
    execute: async (input) =>
      (await import('../../agent-bridge/public/structure-tools')).handleMolActivateView(input),
  });
}

interface SceneToolDependencies {
  getScene: (input: unknown) => ReturnType<typeof StructureOperations.handleMolGetScene>;
  applyScene: (input: unknown, userHydrogenRequest?: string) => ReturnType<typeof StructureOperations.handleMolApplyScene>;
}

export function createMolSaveViewTool() {
  return resultTool({
    description: MOL_SCENE_TOOL_DESCRIPTIONS.saveView,
    inputSchema: molSaveViewSchema,
    execute: async (input) =>
      (await import('../../agent-bridge/public/structure-tools')).handleMolSaveView(input),
  });
}

export const molSaveToNotebookSchema = z.object({
  referenceId: z.string().uuid().optional().describe('Exact document referenceId returned by mol_save_view.'),
  documentReference:molecularDocumentReferenceSchema.optional(),
  notebookPageId: z.string().min(1).max(1000).optional(),
  newNotebookTitle: z.string().trim().min(1).max(200).optional(),
  workspaceRoot: z.string().min(1).max(4000).optional().describe('Exact mounted writable project path for a new notebook when several projects are open.'),
}).strict().refine(input => Boolean(input.notebookPageId) !== Boolean(input.newNotebookTitle), 'Choose notebookPageId or newNotebookTitle, exactly one.').refine(input=>Boolean(input.referenceId)!==Boolean(input.documentReference),'Supply exactly one documentReference or referenceId.');

export const MOL_NOTEBOOK_DESCRIPTION = 'Record one exact previously saved molecular document revision in an existing notebook, or create a named notebook. Save unsaved presentation edits with mol_save_view first. Preserves pinned coordinates, every named perspective, cameras and saved-reference identity through notebook reload. Repeated recording of the same save in the same notebook is idempotent. An existing notebook with unsaved editor changes fails instead of overwriting them. Returns a clickable notebook reference. For a new notebook, provide workspaceRoot when several writable projects are mounted; use exact paths from get_workspace.';

export function createMolSaveToNotebookTool() {
  return resultTool({
    description: MOL_NOTEBOOK_DESCRIPTION,
    inputSchema: molSaveToNotebookSchema,
    execute: async (input) => {
      try {
        const { captureMolecularPresentationToNotebook } = await import('../../page/public/molecular-presentation-notebook');
        const result = await captureMolecularPresentationToNotebook(input.referenceId ?? input.documentReference!.revisionId, {
          documentReference:input.documentReference,
          pageId: input.notebookPageId, newNotebookTitle: input.newNotebookTitle, workspaceRoot: input.workspaceRoot,
        });
        return toolSuccess({ referenceId: result.reference.id, pageId: result.pageId, title: result.title,
          inlineLink: `dnaforge-chat://reference/${result.reference.id}`, savedPresentationReferenceId: input.referenceId ?? input.documentReference!.revisionId });
      } catch (error) {
        return toolFailure({
          code: 'MOLECULAR_NOTEBOOK_CAPTURE_FAILED',
          error:
            error instanceof Error ? error.message : 'Could not record presentation in notebook.',
          retriable: false,
          stateChanged: 'unknown',
          partialEffects: [],
        });
      }
    },
  });
}
const defaultDependencies: SceneToolDependencies = {
  getScene: async (input) =>
    (await import('../../agent-bridge/public/structure-tools')).handleMolGetScene(input),
  applyScene: async (input, userHydrogenRequest) =>
    (await import('../../agent-bridge/public/structure-tools')).handleMolApplyScene(
      input,
      undefined,
      userHydrogenRequest
    ),
};

export function createMolGetSceneTool(dependencies = defaultDependencies) {
  return resultTool({
    description: MOL_SCENE_TOOL_DESCRIPTIONS.getScene,
    inputSchema: molGetSceneSchema,
    execute: async (input) => dependencies.getScene(input),
  });
}

export function createMolApplySceneTool(
  dependencies = defaultDependencies,
  context?: { turnId?: string }
) {
  return resultTool({
    description: MOL_SCENE_TOOL_DESCRIPTIONS.applyScene,
    inputSchema: molApplySceneSchema,
    execute: async (input) => {
      const request = molecularHydrogenRequestForTurn(context?.turnId);
      return request ? dependencies.applyScene(input, request) : dependencies.applyScene(input);
    },
  });
}

interface InteractionContextToolDependencies {
  showInteractionContext: (input: unknown) => Promise<ToolOperationResult>;
}

const defaultInteractionContextDependencies: InteractionContextToolDependencies = {
  showInteractionContext: async (input) =>
    (await import('../../agent-bridge/public/structure-tools')).handleMolShowInteractionContext(
      input
    ),
};

export function createMolShowInteractionContextTool(
  dependencies = defaultInteractionContextDependencies
) {
  return resultTool({
    description: MOL_SCENE_TOOL_DESCRIPTIONS.showInteractionContext,
    inputSchema: molShowInteractionContextSchema,
    execute: async (input) => dependencies.showInteractionContext(input),
  });
}

export function createMolSelectStoryStepTool() {
  return resultTool({
    description:
      'Show one step of the active standard MolViewSpec story in the existing protein tab. The zero-based index selects its authored camera and appearance, then returns the active step after native rendering. Use mol_get_scene to inspect step titles and indices. This does not open another structure.',
    inputSchema: molSelectStoryStepSchema,
    execute: async (input) =>
      (await import('../../agent-bridge/public/structure-tools')).handleMolSelectStoryStep(input),
  });
}
