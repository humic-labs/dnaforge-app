import { z } from 'zod';
import type { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import {
  nucleotideRenderDefaultsSchema,
  resolveNucleotidePresentations,
} from './nucleotidePresentationSettings';
import { molecularPresentationOverrideSchema } from '../../../../../shared/molecular-presentation-override';
import {
  molecularPresentationPreferencesSchema,
  useMolecularPresentationPreferences,
} from './molecularPresentationPreferences';
import { resolveMolecularPresentationRoles } from './molecularPresentationRoles';
import {
  molecularContactTypesSchema,
  LEGACY_MOLECULAR_CONTACT_TYPES,
} from './molecularContactPolicy';

const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

export const molecularRenderProfileSchema = z
  .object({
    id: z.string().min(1).max(100),
    version: z.number().int().positive(),
    ballAndStick: z
      .object({
        sizeFactor: z.number().positive().max(10),
        atomScale: z.number().positive().max(10),
        bondToAtomRatio: z.number().positive().max(3),
      })
      .strict(),
    atomicColors: z
      .object({
        carbonColor: hexColorSchema,
        saturation: z.number().min(-6).max(6),
        lightness: z.number().min(-6).max(6),
      })
      .strict(),
    atomicOpacity: z.number().min(0).max(1).optional(),
    nucleotide: nucleotideRenderDefaultsSchema.optional(),
    nucleotideAppearance: z.enum(['linked-residue-v1', 'linked-residue-v2']).optional(),
    surfaceOwnership: z.literal('single-side-v1').optional(),
    presentation: molecularPresentationPreferencesSchema.optional(),
    interactionContactTypes: molecularContactTypesSchema.optional(),
  })
  .strict();

export type MolecularRenderProfile = z.infer<typeof molecularRenderProfileSchema>;
export const molecularRenderProfileSelectionSchema = z.union([
  z.enum(['default', 'native']),
  molecularRenderProfileSchema,
]);
export type MolecularRenderProfileSelection = z.infer<typeof molecularRenderProfileSelectionSchema>;

export const DEFAULT_MOLECULAR_RENDER_PROFILE: MolecularRenderProfile = {
  id: 'dnaforge-detail',
  version: 2,
  ballAndStick: { sizeFactor: 0.55, atomScale: 0.5, bondToAtomRatio: 0.5 },
  atomicColors: { carbonColor: '#909090', saturation: 0, lightness: 0 },
  atomicOpacity: 1,
  nucleotide: {
    connectorMode: 'simplified',
    baseOpacity: 0.35,
    baseThickness: 0.08,
    connectorRadius: 0.15,
  },
};

export function currentMolecularRenderProfile(): MolecularRenderProfile {
  const presentation = structuredClone(useMolecularPresentationPreferences.getState().preferences);
  return {
    ...structuredClone(DEFAULT_MOLECULAR_RENDER_PROFILE),
    version: 12,
    interactionContactTypes: [...LEGACY_MOLECULAR_CONTACT_TYPES],
    surfaceOwnership: 'single-side-v1',
    nucleotideAppearance: 'linked-residue-v2',
    nucleotide: {
      ...DEFAULT_MOLECULAR_RENDER_PROFILE.nucleotide!,
      connectorMode: presentation.nucleotideDetail,
    },
    presentation,
  };
}

export const MOLECULAR_RENDER_PROFILE_GUIDANCE =
  'The resolved profile records the active presentation preferences. Nucleotide ball_and_stick detail automatically uses its preferred base-atom/connector mode; ordinary context remains cartoon geometry at the configured scale. Existing polymer context is retained during edits. An exact component may declare custom.dnaforge_presentation_role:"binding-site"|"interface"|"focus"|"context". Binding-site and interface regions receive preferred local atomic detail; interface surfaces require an explicit single owner. The bindingSiteSurface:"translucent" preference adds a uniform translucent contour to a complete molecular ligand, including attached carbohydrates. Native computed ligand-binding regions always assign that contour to the ligand, independently of an authored interface role or protein-side request; historical non-native scenes and bindingSiteSurface:"authored" or a recorded exception retain their authored presentation. Declare custom.dnaforge_binding_region:{target:selector,partner:selector,surfaceSide:"target"|"partner",surfaceExtent:"complete"|"contact-patch",seed:selector,radius:number} on a component with a unique ref. Surface geometry comes only from the complete chosen scientific side. surfaceExtent:"complete" displays its whole contour without a burial mask; "contact-patch" displays only its native buried-residue patch. Sides containing molecular ligands or attached glycans always keep their complete contour; pure protein interfaces default to contact-patch and can explicitly request complete. Optional seed defaults to target; discovery uses a fixed 5 angstrom native neighborhood. Computed ligand-binding pockets retain all whole residues with partner-induced native surface burial, plus typed contact support and chemical attachments. Every new native protein interface requires explicit interfaceDetailSide:target|partner|both AND interfaceDetailBasis:contacts|burial (interfaceProteinAtomicMode defaults to sidechain-with-trace through the maintained native selector and real trace paths; explicitly choose full-residue when backbone evidence matters) from the question; missing or partial choices fail before rendering. Complete both-side native burial measurements remain separate from atomic presentation. Selected-side contact residues are complete; burial additionally expands buried protein packing on that side. Required opposing guide features and native chemical attachments remain visible as minimum support atoms. Interface detail side and evidence basis are explicit scientific choices. Nonprotein chemistry and complete glycan contours remain intact; ligand, ion and RNA-only contexts do not require these choices. Archived saved scenes replay their recorded presentation. Display membership is independent of which contact categories generate dotted lines. Disconnected single-atom ions retain their declared sites and physical context without a merged ligand envelope. custom.dnaforge_binding_region.detailMode:"neighborhood" deliberately retains wider discovery context. surfaceColorMode:"identity" preserves complete-owner colors; "emphasis" explicitly projects local patches onto a surface. Contact guides use installed native Molstar classifications, engine-default categories and standard geometry; exact parameters are recorded with the guides. Binding explanations retain every calculated contact crossing their declared scientific partners and exclude contacts internal to either side. Ordinary local residue-focus views retain the complete native Focus neighborhood. Agents cannot choose a category subset, contact-search radius or contact subset. Surface colors inherit the complete chosen side\'s cartoon identity, independently of the local atomic palette; exported detail selectors are ignored during construction. Atomic interaction detail may include both sides; a surface cannot use that union. Surface selectors, local contact ownership and legends are compiler-owned output derived from that binding intent. Editing an exported surface selector does not change its scientific ownership; change the binding intent instead. For an overview without binding regions or computed contact guides, ordinary surfaces can cover complete chains or entities. In a binding view, separate context contours use the component context role and stay disjoint from the chosen binding surface side. The interaction-context tool records scientific sides and their complete atomic environment automatically. Unannotated overviews keep their authored representations. In profile12, verified nucleic cartoon paths default to one broad ribbon width and cross-section. Only the explicit viewer preference nucleotideBackbone:"authored" permits authored path shape and width; author step overrides cannot opt out of the ribbon default. Backbone path shape is independent of local base/attachment chemistry: adding base atomic detail does not thin the path or require full sugar/phosphate chemistry. Nucleotide detail uses one attachment/atomic mode for each physically selected focused region: base atoms and schematic connectors when all required contact endpoints are bases, or complete atomic detail throughout that region when a ribose/phosphate endpoint is required. Color and opacity partitions cannot expose sugar/phosphate atoms residue by residue. To deliberately change nucleotideDetail, protein cartoonScale, preservePolymerContext, bindingSiteDetail, bindingSiteSurface or interfaceSurface, put custom.dnaforge_presentation_override:{reason:"scientific reason",fields:[affected preference names]} on the step root. Co-loaded pinned sources remain available through the story. Choose registration and overlays when aligned correspondence answers the selected contrast; the fit anchor and complete compared objects are separate declarations. Matched marked comparison steps share one camera, while unmarked overview and detail framing remain independent. Report source-specific limits when scientific correspondence cannot be established. Viewer-bound preferences govern supported presentation choices; they cannot weaken physical ownership, nucleotide consistency or contact contracts. Defaults, effective appearance and the exception are saved with the scene. Saved scenes replay their recorded appearance exactly. custom.dnaforge_molecular_identity on a scientific color layer identifies the same biological object across coordinate states independently of its explanatory label; a shared identity has one stable hue. Native cartoon parameters support tubularHelices:true for tube-shaped alpha helices and roundCap:true for rounded tube ends; these are optional representation controls. Foreground nucleotide detail gives its matching cartoon backbone and attachment at least the same opacity; surrounding context keeps its recorded opacity. Element paint layers belong to their scientific group and never create separate legend objects. Carbon tints and independent base planes remain editable.';

export class MolecularRenderProfileError extends Error {
  readonly code = 'MVS_INVALID_RENDER_PROFILE';
  constructor(message: string) {
    super(message);
    this.name = 'MolecularRenderProfileError';
  }
}

type ProfileSceneNode = {
  ref?: string;
  kind: string;
  params?: Record<string, unknown>;
  custom?: Record<string, unknown>;
  children?: ProfileSceneNode[];
};

const pluginProfiles = new WeakMap<object, MolecularRenderProfileSelection>();

export function setMolViewSpecRenderProfile(
  plugin: object,
  selection: MolecularRenderProfileSelection
): void {
  pluginProfiles.set(plugin, molecularRenderProfileSelectionSchema.parse(selection));
}

export function getMolViewSpecRenderProfile(plugin: object): MolecularRenderProfileSelection {
  return structuredClone(pluginProfiles.get(plugin) ?? 'default');
}

function parseProfile(value: unknown): MolecularRenderProfile {
  const parsed = molecularRenderProfileSchema.safeParse(value);
  if (!parsed.success)
    throw new MolecularRenderProfileError(
      `Invalid molecular render profile: ${parsed.error.issues[0]?.message ?? 'invalid settings'}.`
    );
  return parsed.data;
}

function nativeRepresentationParams(node: ProfileSceneNode): Record<string, unknown> {
  const custom = node.custom?.molstar_representation_params;
  if (custom === undefined) return {};
  if (custom === null || typeof custom !== 'object' || Array.isArray(custom))
    throw new MolecularRenderProfileError('molstar_representation_params must be an object.');
  return custom as Record<string, unknown>;
}

function resolveRepresentation(node: ProfileSceneNode, profile: MolecularRenderProfile): void {
  if (node.custom?.dnaforge_render_profile === 'native') return;
  const type = node.params?.type;
  if (type === 'ball_and_stick') {
    node.params = { size_factor: profile.ballAndStick.sizeFactor, ...node.params };
    node.custom = {
      ...node.custom,
      molstar_representation_params: {
        sizeFactor: profile.ballAndStick.atomScale,
        sizeAspectRatio: profile.ballAndStick.bondToAtomRatio,
        ...nativeRepresentationParams(node),
      },
    };
  }
  if (type !== 'ball_and_stick' && type !== 'spacefill' && type !== 'line') return;
  if (
    profile.atomicOpacity !== undefined &&
    !node.children?.some((child) => child.kind === 'opacity') &&
    nativeRepresentationParams(node).alpha === undefined
  ) {
    node.custom = {
      ...node.custom,
      molstar_representation_params: {
        alpha: profile.atomicOpacity,
        ...nativeRepresentationParams(node),
      },
    };
  }
  if (
    node.children?.some(
      (child) =>
        child.kind === 'color' ||
        child.kind === 'color_from_uri' ||
        child.kind === 'color_from_source'
    )
  )
    return;
  const carbonColor = node.custom?.dnaforge_carbon_color ?? profile.atomicColors.carbonColor;
  const parsedColor = hexColorSchema.safeParse(carbonColor);
  if (!parsedColor.success)
    throw new MolecularRenderProfileError('The carbon color must be a #RRGGBB color.');
  const legendLabel = node.custom?.dnaforge_legend_label;
  node.children = [
    ...(node.children ?? []),
    {
      kind: 'color',
      params: { color: parsedColor.data },
      custom: {
        molstar_color_theme_name: 'element-symbol',
        molstar_color_theme_params: {
          carbonColor: {
            name: 'uniform',
            params: { value: parseInt(parsedColor.data.slice(1), 16) },
          },
          saturation: profile.atomicColors.saturation,
          lightness: profile.atomicColors.lightness,
          colors: { name: 'default', params: {} },
        },
        ...(typeof legendLabel === 'string' ? { dnaforge_legend_label: legendLabel } : {}),
      },
    },
  ];
}

export function resolveMolViewSpecRenderProfile(
  document: MVSData,
  selection: MolecularRenderProfileSelection = 'default',
  hasNucleotides?: (selector: unknown, structureRef?: string) => boolean
): MVSData {
  const resolved = structuredClone(document);
  if (selection === 'native') return resolved;
  const selectedProfile =
    selection === 'default' ? currentMolecularRenderProfile() : parseProfile(selection);
  const roots =
    resolved.kind === 'multiple'
      ? resolved.snapshots.map((snapshot) => snapshot.root)
      : [resolved.root];
  for (const typedRoot of roots) {
    const root = typedRoot as ProfileSceneNode;
    const recorded = root.custom?.dnaforge_render_profile;
    if (recorded === 'native') continue;
    const profile = recorded === undefined ? selectedProfile : parseProfile(recorded);
    const rawOverride = root.custom?.dnaforge_presentation_override;
    const override =
      rawOverride === undefined
        ? undefined
        : molecularPresentationOverrideSchema.parse(rawOverride);
    const fields = new Set(override?.fields);
    root.custom = { ...root.custom, dnaforge_render_profile: structuredClone(profile) };
    if (profile.presentation) resolveMolecularPresentationRoles(root, profile.presentation, fields);
    const pending: Array<{
      node: ProfileSceneNode;
      selector?: unknown;
      structureRef?: string;
    }> = [{ node: root }];
    while (pending.length) {
      const entry = pending.pop()!;
      const node = entry.node;
      const selector =
        node.kind === 'component' ? (node.params?.selector ?? 'all') : entry.selector;
      const structureRef = node.kind === 'structure' ? node.ref : entry.structureRef;
      const polymerTrace =
        node.kind === 'representation' &&
        ['cartoon', 'backbone'].includes(String(node.params?.type)) &&
        !node.custom?.dnaforge_nucleotide_generated;
      const nucleicTrace =
        polymerTrace &&
        (hasNucleotides ? hasNucleotides(selector, structureRef) : selector === 'nucleic');
      const authoredNucleicTrace =
        profile.version >= 12 &&
        nucleicTrace &&
        profile.presentation?.nucleotideBackbone === 'authored';
      const uniformNucleicTrace = profile.version >= 12 && nucleicTrace && !authoredNucleicTrace;
      if (
        profile.presentation &&
        !authoredNucleicTrace &&
        (uniformNucleicTrace || !fields.has('cartoonScale')) &&
        polymerTrace
      ) {
        node.params = { ...node.params, size_factor: profile.presentation.cartoonScale };
        const native = nativeRepresentationParams(node);
        node.custom = {
          ...node.custom,
          molstar_representation_params: { ...native, sizeFactor: 0.2 },
        };
      }
      if (
        (uniformNucleicTrace ||
          (profile.presentation?.nucleotideBackbone === 'ribbon' &&
            !fields.has('nucleotideBackbone'))) &&
        nucleicTrace
      ) {
        node.params = { ...node.params, type: 'cartoon' };
        node.custom = {
          ...node.custom,
          molstar_representation_params: {
            ...nativeRepresentationParams(node),
            aspectRatio: 5,
            nucleicProfile: 'square',
          },
        };
      }
      if (node.kind === 'representation') resolveRepresentation(node, profile);
      pending.push(
        ...(node.children ?? []).map((child) => ({ node: child, selector, structureRef }))
      );
    }
    if (profile.nucleotide)
      resolveNucleotidePresentations(root, profile.nucleotide, profile.atomicColors.carbonColor, {
        automatic: !!profile.presentation,
        coherentAppearance: !!profile.nucleotideAppearance,
        enforceMode: !!profile.presentation && !fields.has('nucleotideDetail'),
        hasNucleotides,
      });
  }
  return resolved;
}
