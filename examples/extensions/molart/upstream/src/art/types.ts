import type { RibbonOptions } from '../geometry/ribbon';

/** Ink (contour) parameters consumed by the shared screen-space composite pass. Widths are in
 *  reference pixels: 1 unit = 1/1000 of the output image height, so exports match the preview. */
export interface InkParams {
  color: [number, number, number]; // sRGB 0..1
  color2: [number, number, number]; // secondary ink, mixed along the chain
  width: number;
  /** 0..1 relative variation of width along the chain (anchored to residue parameter). */
  widthVar: number;
  /** 0..1 fraction of contour that is broken (gaps). */
  breaks: number;
  /** Probability-like strength of a second, offset contour stroke. */
  double: number;
  /** Wobble of the contour offset (reference px). */
  wobble: number;
  /** Width of crease lines between facets / folds (0 disables). */
  crease: number;
  /** Draw creases wherever the style's own plane id changes, also between coplanar planes. */
  creaseAll?: boolean;
  /** Colour misregistration offset of the wash (reference px). */
  misregister: [number, number];
  /** Darkening of the wash along its own edge (watercolour pooling). */
  pooling: number;
  opacity: number;
  /** Edge softness in reference px. */
  softness: number;
  /** Frequency (per residue) of width / break variation. */
  frequency: number;
  /** 0..1: dissolve the wash near its silhouette into paper (dry / soft edges), anchored noise. */
  dissolve: number;
  /** Depth of the dissolve band in reference px. */
  dissolveWidth: number;
}

export type MeshKind = 'smooth' | 'faceted' | 'melted' | 'splatter' | 'surface';

export interface ArtStyle {
  id: string;
  label: string;
  /** One-line description of the drawing logic (shown in UI and README). */
  technique: string;
  mesh: MeshKind;
  ribbon?: RibbonOptions;
  /** Options for the 'surface' mesh kind (a molecular surface instead of a cartoon). */
  surface?: import('../geometry/surface').SurfaceOptions;
  /** GLSL defining `vec3 shadeSurface(Surface s)` returning LINEAR rgb. */
  surfaceGLSL: string;
  ink: InkParams;
  /** 0..1: how strongly the surface behind shows through (multiplicative glaze, one layer). */
  translucency?: number;
  /**
   * Glass material: the surface shader returns a tint (transmitted colour per Å of glass) and the composite
   * pass resolves thickness absorption, refraction and highlights over three depth layers.
   * `colors` are the default sRGB tints (A: helices / strands, B: loops and edges); the user may override them.
   */
  glass?: { colors: [[number, number, number], [number, number, number]]; density: number; refraction: number };
  /**
   * ASCII text overlay: a final pass replaces character cells by glyphs picked from the image brightness.
   * `rows` is the number of text rows over the image height; `blend` gives the horizontal positions
   * (fractions of the image width) where the hand-over from text (left) to ribbon (right) starts and ends.
   */
  ascii?: { rows: number; blend: [number, number] };
  /**
   * Translucent body (frosted glass, jelly): the composite pass measures how thick the front lobe is along the
   * view ray and makes it only that opaque; the next lobe behind shows through it, and where nothing lies
   * behind, the paper does. `density` is the opacity gained per Å; `clear` is how untinted the paper stays when
   * seen through the material (0..1). With `layers`, edges of the layers behind are drawn faintly.
   */
  wax?: { density: number; clear: number; /** 0..1: how strongly the outlines of the layer behind show through */ layers?: number; /** bodies made of overlapping pieces (spheres): behind a piece lies the dense interior, in a deeper tone of its own colour */ core?: boolean; /** frosted finish: radius in reference px over which the shading is softened */ frost?: number; /** 0..1 opacity of the lobe seen through the front one (default 0.82); lower lets more paper through */ behind?: number; /** radius in reference px over which the lobe seen through is blurred (default 0 = sharp) */ soft?: number };
  /** Options for the 'splatter' mesh kind (display-only marks around the backbone). */
  splatter?: import('../geometry/splatter').SplatterOptions;
  /**
   * Give every helix and strand a face anchor (`Surface.face`) for character styles. The ribbon swells into a
   * "head" at the anchor (display only): width grows by 1 + helixHead / strandHead, fading over `span` residues.
   */
  faces?: { helixHead: number; strandHead: number; span: number; /** draw a few short loops as hose arms with a gloved fist */ arms?: boolean; /** fist diameter in Å */ fist?: number };
  /** Art mode (opt-in, global switch): ribbon options that replace the true ribbon with simplified or reshaped forms. Display only. */
  art?: {
    ribbon: import('../geometry/ribbon').RibbonOptions;
    note: string;
    /** shrink the widths of the forms on large proteins so they do not crowd: factor (150 / residues)^fit, at least 0.5 */
    fit?: number;
    /** stretch the drawn form along the protein's up axis (1 = none) */
    stretch?: number;
    /** deformable styles: amount of the style's deformation that art mode applies when its slider is at 0 */
    deform?: number;
  };
  /** True when the style offers the opt-in artistic deformation slider. */
  deformable?: boolean;
  /** Name of the deformation in the UI (default: Melt). */
  deformLabel?: string;
  /** One line under the slider saying what it does for this style. */
  deformHint?: string;
}

export const baseInk: InkParams = {
  color: [0.12, 0.1, 0.09],
  color2: [0.12, 0.1, 0.09],
  width: 1.1,
  widthVar: 0,
  breaks: 0,
  double: 0,
  wobble: 0,
  crease: 0,
  misregister: [0, 0],
  pooling: 0,
  opacity: 1,
  softness: 0.6,
  frequency: 1,
  dissolve: 0,
  dissolveWidth: 0,
};
