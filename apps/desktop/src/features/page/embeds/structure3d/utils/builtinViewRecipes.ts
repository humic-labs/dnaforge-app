import type {
  CanvasRenderSettings,
  ColorPrimitive,
  Structure3dRepresentation,
  StructureTargetSelector,
  StructureViewState,
  ViewRecipe,
  VisualLayer,
} from '../types';

export function visualLayer(input: {
  id: string;
  target: StructureTargetSelector;
  representation: Structure3dRepresentation;
  color: ColorPrimitive;
  order: number;
  visible?: boolean;
  material?: VisualLayer['material'];
}): VisualLayer {
  return {
    id: input.id,
    target: input.target,
    representation: { kind: input.representation },
    color: input.color,
    material: input.material,
    visible: input.visible ?? true,
    order: input.order,
  };
}

const SURFACE_CONTEXT_ALPHA = 0.13;
const FOCUS_CONTEXT_SURFACE_ALPHA = 0.2;

const DEFAULT_CARTOON_CANVAS: CanvasRenderSettings = {
  outlineEnabled: false,
  aoEnabled: false,
  ambientIntensity: 0.4,
  advancedSettings: {
    outlineEnabled: false,
    aoEnabled: false,
    ambientIntensity: 0.4,
  },
};

interface StructureViewStateSeed {
  cameraSnapshot?: string;
  showWater?: boolean;
  spin?: boolean;
  backgroundColor?: string;
}

export function createCartoonRecipe(
  target: StructureTargetSelector = { kind: 'whole-structure' },
  options: { colorMode?: ColorPrimitive['mode'] } = {}
): ViewRecipe {
  return {
    schemaVersion: 1,
    id: 'cartoon',
    name: 'Cartoon',
    origin: 'builtin',
    layers: [
      visualLayer({
        id: 'cartoon-primary',
        target,
        representation: 'cartoon',
        color: { mode: options.colorMode ?? 'source-default' },
        order: 10,
      }),
    ],
    canvas: DEFAULT_CARTOON_CANVAS,
  };
}

export function createBallAndStickRecipe(
  target: StructureTargetSelector = { kind: 'whole-structure' }
): ViewRecipe {
  return {
    schemaVersion: 1,
    id: 'ball-and-stick',
    name: 'Ball-and-Stick',
    origin: 'builtin',
    layers: [
      visualLayer({
        id: 'ball-and-stick-primary',
        target,
        representation: 'ball-and-stick',
        color: { mode: 'element' },
        order: 10,
      }),
    ],
    canvas: {
      outlineEnabled: false,
      aoEnabled: false,
      ambientIntensity: 0.4,
      advancedSettings: {
        outlineEnabled: false,
        aoEnabled: false,
        ambientIntensity: 0.4,
      },
    },
  };
}

export function createSpacefillRecipe(
  target: StructureTargetSelector = { kind: 'whole-structure' }
): ViewRecipe {
  return {
    schemaVersion: 1,
    id: 'spacefill',
    name: 'Spacefill',
    origin: 'builtin',
    layers: [
      visualLayer({
        id: 'spacefill-primary',
        target,
        representation: 'spacefill',
        color: { mode: 'element' },
        material: { sizeFactor: 1, quality: 'auto' },
        order: 10,
      }),
    ],
    canvas: DEFAULT_CARTOON_CANVAS,
  };
}

export function createSurfaceRecipe(
  target: StructureTargetSelector = { kind: 'whole-structure' },
  options: { colorMode?: ColorPrimitive['mode'] } = {}
): ViewRecipe {
  return {
    schemaVersion: 1,
    id: 'surface',
    name: 'Surface',
    origin: 'builtin',
    layers: [
      visualLayer({
        id: 'surface-primary',
        target,
        representation: 'surface',
        color: { mode: options.colorMode ?? 'source-default' },
        material: { quality: 'auto' },
        order: 10,
      }),
    ],
    canvas: {
      outlineEnabled: true,
      aoEnabled: true,
      ambientIntensity: 0.5,
      advancedSettings: {
        outlineEnabled: true,
        outlineThreshold: 0.4,
        aoEnabled: true,
        aoBias: 0.6,
        ambientIntensity: 0.5,
      },
    },
  };
}

export function createHybridRecipe(
  target: StructureTargetSelector = { kind: 'whole-structure' },
  options: { colorMode?: ColorPrimitive['mode'] } = {}
): ViewRecipe {
  return {
    schemaVersion: 1,
    id: 'hybrid',
    name: 'Hybrid',
    origin: 'builtin',
    layers: [
      visualLayer({
        id: 'hybrid-cartoon-primary',
        target,
        representation: 'cartoon',
        color: { mode: options.colorMode ?? 'source-default' },
        order: 10,
      }),
      visualLayer({
        id: 'hybrid-surface-overlay',
        target,
        representation: 'surface',
        color: { mode: options.colorMode ?? 'source-default' },
        material: { alpha: 0.22, quality: 'auto' },
        order: 20,
      }),
    ],
    canvas: DEFAULT_CARTOON_CANVAS,
  };
}

export function createQueryInComplexRecipe(): ViewRecipe {
  return {
    schemaVersion: 1,
    id: 'query-in-complex',
    name: 'Cartoon Context',
    origin: 'builtin',
    layers: [
      visualLayer({
        id: 'context-complex-cartoon',
        target: { kind: 'whole-complex' },
        representation: 'cartoon',
        color: { mode: 'context-muted' },
        order: 10,
      }),
      visualLayer({
        id: 'query-anchor-cartoon',
        target: { kind: 'query-anchor' },
        representation: 'cartoon',
        color: { mode: 'source-default' },
        order: 20,
      }),
      visualLayer({
        id: 'ligands-ball-and-stick',
        target: { kind: 'member-kind', memberKinds: ['ligand', 'ion'] },
        representation: 'ball-and-stick',
        color: { mode: 'element' },
        order: 30,
      }),
    ],
    canvas: {
      outlineEnabled: false,
      aoEnabled: false,
      ambientIntensity: 0.4,
      advancedSettings: {
        outlineEnabled: false,
        aoEnabled: false,
        ambientIntensity: 0.4,
      },
    },
  };
}

export function createStandardViewRecipes(): ViewRecipe[] {
  return [
    createCartoonRecipe(),
    createBallAndStickRecipe(),
    createSpacefillRecipe(),
    createSurfaceRecipe(),
    createIllustrativeRecipe(),
    createHybridRecipe(),
  ];
}

export function createDefaultStructureViewState(
  attrs: StructureViewStateSeed = {}
): StructureViewState {
  return createStructureViewStateFromRecipe(createCartoonRecipe(), attrs);
}

export function createStructureViewStateFromRecipe(
  recipe: ViewRecipe,
  attrs: StructureViewStateSeed = {}
): StructureViewState {
  return {
    schemaVersion: 1,
    activeRecipeId: recipe.id,
    recipe,
    ...(attrs.cameraSnapshot !== undefined ? { cameraSnapshot: attrs.cameraSnapshot } : {}),
    showWater: attrs.showWater ?? false,
    spin: attrs.spin ?? false,
    ...(attrs.backgroundColor !== undefined ? { backgroundColor: attrs.backgroundColor } : {}),
  };
}

export function createQueryInComplexPreviewRecipe(): ViewRecipe {
  return {
    schemaVersion: 1,
    id: 'query-in-complex-preview',
    name: 'Complex Preview',
    origin: 'builtin',
    layers: [
      visualLayer({
        id: 'preview-context-complex-cartoon',
        target: { kind: 'whole-complex' },
        representation: 'cartoon',
        color: { mode: 'context-muted' },
        order: 10,
      }),
      visualLayer({
        id: 'preview-query-anchor-cartoon',
        target: { kind: 'query-anchor' },
        representation: 'cartoon',
        color: { mode: 'source-default' },
        order: 20,
      }),
      visualLayer({
        id: 'preview-ligands-ball-and-stick',
        target: { kind: 'member-kind', memberKinds: ['ligand', 'ion'] },
        representation: 'ball-and-stick',
        color: { mode: 'element' },
        order: 30,
      }),
    ],
    canvas: {
      outlineEnabled: false,
      aoEnabled: false,
      ambientIntensity: 0.4,
      advancedSettings: {
        outlineEnabled: false,
        aoEnabled: false,
        ambientIntensity: 0.4,
      },
    },
  };
}

export function createQueryInComplexSurfaceRecipe(): ViewRecipe {
  return {
    schemaVersion: 1,
    id: 'query-in-complex-surface',
    name: 'Surface Context',
    origin: 'builtin',
    layers: [
      visualLayer({
        id: 'whole-structure-surface-overlay',
        target: { kind: 'whole-structure' },
        representation: 'surface',
        color: { mode: 'context-muted' },
        material: { alpha: SURFACE_CONTEXT_ALPHA, quality: 'auto' },
        order: 10,
      }),
      visualLayer({
        id: 'query-anchor-cartoon',
        target: { kind: 'query-anchor' },
        representation: 'cartoon',
        color: { mode: 'source-default' },
        order: 20,
      }),
      visualLayer({
        id: 'ligands-ball-and-stick',
        target: { kind: 'member-kind', memberKinds: ['ligand', 'ion'] },
        representation: 'ball-and-stick',
        color: { mode: 'element' },
        order: 30,
      }),
    ],
    canvas: {
      outlineEnabled: true,
      aoEnabled: false,
      ambientIntensity: 0.45,
      advancedSettings: {
        outlineEnabled: true,
        outlineScale: 1,
        outlineThreshold: 0.4,
        outlineColor: 0x000000,
        ambientIntensity: 0.45,
      },
    },
  };
}

export function createFocusInContextRecipe(): ViewRecipe {
  return {
    schemaVersion: 1,
    id: 'focus-in-context',
    name: 'Focus in Context',
    origin: 'builtin',
    layers: [
      visualLayer({
        id: 'context-complex-surface',
        target: { kind: 'whole-complex' },
        representation: 'surface',
        color: { mode: 'context-muted' },
        material: { alpha: FOCUS_CONTEXT_SURFACE_ALPHA, quality: 'auto' },
        order: 10,
      }),
      visualLayer({
        id: 'query-anchor-reference-surface',
        target: { kind: 'query-anchor' },
        representation: 'surface',
        color: { mode: 'context-muted' },
        material: { alpha: 0.18, quality: 'auto' },
        order: 20,
      }),
      visualLayer({
        id: 'active-focus-cartoon',
        target: { kind: 'active-focus' },
        representation: 'cartoon',
        color: { mode: 'source-default' },
        order: 30,
      }),
      visualLayer({
        id: 'ligands-ball-and-stick',
        target: { kind: 'member-kind', memberKinds: ['ligand', 'ion'] },
        representation: 'ball-and-stick',
        color: { mode: 'element' },
        order: 40,
      }),
    ],
    canvas: {
      outlineEnabled: true,
      aoEnabled: false,
      ambientIntensity: 0.45,
      advancedSettings: {
        outlineEnabled: true,
        outlineScale: 1,
        outlineThreshold: 0.4,
        outlineColor: 0x000000,
        ambientIntensity: 0.45,
      },
    },
  };
}

export function createAssemblyOverviewRecipe(): ViewRecipe {
  return {
    schemaVersion: 1,
    id: 'assembly-overview',
    name: 'Solid Surface Context',
    origin: 'builtin',
    layers: [
      visualLayer({
        id: 'opaque-context-surface',
        target: { kind: 'context' },
        representation: 'surface',
        color: { mode: 'context-muted' },
        material: { alpha: 1, quality: 'auto' },
        order: 10,
      }),
      visualLayer({
        id: 'query-anchor-highlight-cartoon',
        target: { kind: 'query-anchor' },
        representation: 'cartoon',
        color: { mode: 'source-default' },
        order: 20,
      }),
      visualLayer({
        id: 'assembly-ligands-ball-and-stick',
        target: { kind: 'member-kind', memberKinds: ['ligand', 'ion'] },
        representation: 'ball-and-stick',
        color: { mode: 'element' },
        order: 30,
      }),
    ],
    canvas: {
      outlineEnabled: true,
      aoEnabled: false,
      ambientIntensity: 0.5,
      advancedSettings: {
        outlineEnabled: true,
        outlineScale: 1,
        outlineThreshold: 0.4,
        outlineColor: 0x000000,
        ambientIntensity: 0.5,
      },
    },
  };
}

export function createInterfaceRecipe(): ViewRecipe {
  return {
    schemaVersion: 1,
    id: 'interface',
    name: 'Interface',
    origin: 'builtin',
    layers: [
      visualLayer({
        id: 'interface-context-surface',
        target: { kind: 'context' },
        representation: 'surface',
        color: { mode: 'context-muted' },
        material: { alpha: 0.1, quality: 'auto' },
        order: 10,
      }),
      visualLayer({
        id: 'interface-query-cartoon',
        target: { kind: 'query-anchor' },
        representation: 'cartoon',
        color: { mode: 'source-default' },
        order: 20,
      }),
      visualLayer({
        id: 'interface-focus-cartoon',
        target: { kind: 'active-focus' },
        representation: 'cartoon',
        color: { mode: 'source-default' },
        order: 30,
      }),
      visualLayer({
        id: 'interface-ligands-ball-and-stick',
        target: { kind: 'member-kind', memberKinds: ['ligand', 'ion'] },
        representation: 'ball-and-stick',
        color: { mode: 'element' },
        order: 40,
      }),
    ],
    canvas: {
      outlineEnabled: true,
      aoEnabled: false,
      ambientIntensity: 0.45,
      advancedSettings: {
        outlineEnabled: true,
        outlineScale: 1,
        outlineThreshold: 0.4,
        outlineColor: 0x000000,
        ambientIntensity: 0.45,
      },
    },
  };
}

export function createLigandSiteRecipe(): ViewRecipe {
  return {
    schemaVersion: 1,
    id: 'ligand-site',
    name: 'Ligand Site',
    origin: 'builtin',
    layers: [
      visualLayer({
        id: 'ligand-site-context-surface',
        target: { kind: 'whole-complex' },
        representation: 'surface',
        color: { mode: 'context-muted' },
        material: { alpha: 0.12, quality: 'auto' },
        order: 10,
      }),
      visualLayer({
        id: 'ligand-site-query-cartoon',
        target: { kind: 'query-anchor' },
        representation: 'cartoon',
        color: { mode: 'source-default' },
        order: 20,
      }),
      visualLayer({
        id: 'ligand-site-ligands-ball-and-stick',
        target: { kind: 'member-kind', memberKinds: ['ligand', 'ion'] },
        representation: 'ball-and-stick',
        color: { mode: 'element' },
        order: 30,
      }),
    ],
    canvas: {
      outlineEnabled: true,
      aoEnabled: false,
      ambientIntensity: 0.48,
      advancedSettings: {
        outlineEnabled: true,
        outlineScale: 1,
        outlineThreshold: 0.4,
        outlineColor: 0x000000,
        ambientIntensity: 0.48,
      },
    },
  };
}

export function createSurfaceDetailRecipe(): ViewRecipe {
  return {
    schemaVersion: 1,
    id: 'surface-detail',
    name: 'Surface + Detail',
    origin: 'builtin',
    layers: [
      visualLayer({
        id: 'surface-detail-cartoon',
        target: { kind: 'whole-structure' },
        representation: 'cartoon',
        color: { mode: 'source-default' },
        order: 10,
      }),
      visualLayer({
        id: 'surface-detail-overlay',
        target: { kind: 'whole-structure' },
        representation: 'surface',
        color: { mode: 'source-default' },
        material: { alpha: 0.24, quality: 'auto' },
        order: 20,
      }),
      visualLayer({
        id: 'surface-detail-ligands-ball-and-stick',
        target: { kind: 'member-kind', memberKinds: ['ligand', 'ion'] },
        representation: 'ball-and-stick',
        color: { mode: 'element' },
        order: 30,
      }),
    ],
    canvas: {
      outlineEnabled: false,
      aoEnabled: false,
      ambientIntensity: 0.45,
      advancedSettings: {
        outlineEnabled: false,
        aoEnabled: false,
        ambientIntensity: 0.45,
      },
    },
  };
}

export function createAtomicDetailRecipe(): ViewRecipe {
  return {
    schemaVersion: 1,
    id: 'atomic-detail',
    name: 'Atomic Detail',
    origin: 'builtin',
    layers: [
      visualLayer({
        id: 'atomic-detail-ball-and-stick',
        target: { kind: 'whole-structure' },
        representation: 'ball-and-stick',
        color: { mode: 'element' },
        order: 10,
      }),
    ],
    canvas: {
      outlineEnabled: false,
      aoEnabled: false,
      ambientIntensity: 0.45,
      advancedSettings: {
        outlineEnabled: false,
        aoEnabled: false,
        ambientIntensity: 0.45,
      },
    },
  };
}

export function createConfidenceRecipe(): ViewRecipe {
  return {
    schemaVersion: 1,
    id: 'confidence',
    name: 'Confidence',
    origin: 'builtin',
    layers: [
      visualLayer({
        id: 'confidence-cartoon',
        target: { kind: 'whole-structure' },
        representation: 'cartoon',
        color: { mode: 'plddt' },
        order: 10,
      }),
    ],
    canvas: {
      outlineEnabled: false,
      aoEnabled: false,
      ambientIntensity: 0.45,
      advancedSettings: {
        outlineEnabled: false,
        aoEnabled: false,
        ambientIntensity: 0.45,
      },
    },
  };
}

export function createIllustrativeRecipe(
  target: StructureTargetSelector = { kind: 'whole-structure' },
  options: { colorMode?: ColorPrimitive['mode'] } = {}
): ViewRecipe {
  return {
    schemaVersion: 1,
    id: 'illustrative',
    name: 'Illustrative',
    origin: 'builtin',
    layers: [
      visualLayer({
        id: 'illustrative-spacefill',
        target,
        representation: 'illustrative',
        color: { mode: options.colorMode ?? 'source-default' },
        material: { ignoreLight: true, sizeFactor: 1, quality: 'auto' },
        order: 10,
      }),
    ],
    canvas: {
      outlineEnabled: true,
      aoEnabled: true,
      ambientIntensity: 1,
      advancedSettings: {
        outlineEnabled: true,
        aoEnabled: true,
        ambientIntensity: 1,
      },
    },
  };
}
