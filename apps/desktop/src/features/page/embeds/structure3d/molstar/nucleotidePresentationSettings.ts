import type { MolecularProfileNode } from '../../../../../shared/molecular-scene-node';
export type { MolecularProfileNode } from '../../../../../shared/molecular-scene-node';
import { z } from 'zod';

export const NUCLEOTIDE_BASE_PLANE_VISUAL = 'dnaforge-nucleotide-base-plane';
export const NUCLEOTIDE_CONNECTOR_VISUAL = 'dnaforge-nucleotide-connector';

export const nucleotideRenderDefaultsSchema = z
  .object({
    connectorMode: z.enum(['simplified', 'atomic']),
    baseOpacity: z.number().min(0).max(1),
    baseThickness: z.number().positive().max(2),
    connectorRadius: z.number().positive().max(2),
  })
  .strict();

export const nucleotidePresentationSchema = nucleotideRenderDefaultsSchema
  .partial()
  .extend({
    baseColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
  })
  .strict();

export type NucleotideRenderDefaults = z.infer<typeof nucleotideRenderDefaultsSchema>;
export type NucleotidePresentation = z.infer<typeof nucleotidePresentationSchema>;

function nucleotideContactAtoms(root: MolecularProfileNode): Map<MolecularProfileNode, unknown[]> {
  const structures = new Map<string, MolecularProfileNode>();
  const result = new Map<MolecularProfileNode, unknown[]>();
  const index = (node: MolecularProfileNode) => {
    if (node.kind === 'structure' && node.ref) structures.set(node.ref, node);
    for (const child of node.children ?? []) index(child);
  };
  index(root);
  const visit = (
    node: MolecularProfileNode,
    parentStructure: MolecularProfileNode | undefined,
    visible: boolean
  ) => {
    const structure = node.kind === 'structure' ? node : parentStructure;
    visible = visible && node.custom?.is_hidden !== true && Number(node.params?.opacity ?? 1) > 0;
    if (
      visible &&
      node.kind === 'primitive' &&
      ['tube', 'distance_measurement'].includes(String(node.params?.kind)) &&
      node.params?.start &&
      node.params?.end &&
      Number(node.params?.radius ?? 1) > 0
    ) {
      for (const point of [node.params?.start, node.params?.end]) {
        if (!point || typeof point !== 'object' || Array.isArray(point)) continue;
        const position = point as Record<string, unknown>;
        const owner =
          typeof position.structure_ref === 'string'
            ? structures.get(position.structure_ref)
            : structure;
        if (!owner) continue;
        const expressions = Array.isArray(position.expressions) ? position.expressions : [position];
        const selected = result.get(owner) ?? [];
        for (const expression of expressions)
          if (
            expression &&
            typeof expression === 'object' &&
            ['atom_index', 'atom_id', 'label_atom_id', 'auth_atom_id'].some(
              (field) => (expression as Record<string, unknown>)[field] !== undefined
            ) &&
            !selected.some((old) => JSON.stringify(old) === JSON.stringify(expression))
          )
            selected.push(structuredClone(expression));
        result.set(owner, selected);
      }
    }
    for (const child of node.children ?? []) visit(child, structure, visible);
  };
  visit(root, undefined, true);
  return result;
}

export function nucleotideGroupColors(
  representation: MolecularProfileNode,
  fallback: string
): MolecularProfileNode[] {
  const label =
    (representation.custom?.dnaforge_display_group as { label?: string } | undefined)?.label ??
    representation.custom?.dnaforge_legend_label;
  const colors: MolecularProfileNode[] = [
    {
      kind: 'color',
      params: { color: fallback },
      ...(typeof label === 'string' ? { custom: { dnaforge_legend_label: label } } : {}),
    },
  ];
  for (const child of representation.children ?? []) {
    if (child.kind === 'color_from_uri' || child.kind === 'color_from_source')
      throw Object.assign(
        new Error('Nucleotide schematic colors require resolved group color layers.'),
        { code: 'MVS_NUCLEOTIDE_COLOR_UNRESOLVED' }
      );
    if (child.kind !== 'color') continue;
    const theme = child.custom?.molstar_color_theme_name;
    const params = child.custom?.molstar_color_theme_params as
      | { value?: number; carbonColor?: { name?: string; params?: { value?: number } } }
      | undefined;
    const value =
      theme === 'element-symbol' && params?.carbonColor?.name === 'uniform'
        ? params.carbonColor.params?.value
        : theme === 'uniform'
          ? params?.value
          : undefined;
    if (
      (theme !== undefined && value === undefined) ||
      child.custom?.molstar_use_default_coloring === true
    )
      throw Object.assign(
        new Error(
          'Nucleotide schematics need an explicit group/carbon hue for this native color theme.'
        ),
        { code: 'MVS_NUCLEOTIDE_COLOR_UNRESOLVED' }
      );
    const color =
      value === undefined ? child.params?.color : '#' + value.toString(16).padStart(6, '0');
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))
      throw Object.assign(new Error('Nucleotide schematic group color is invalid.'), {
        code: 'MVS_NUCLEOTIDE_COLOR_UNRESOLVED',
      });
    const custom = structuredClone(child.custom ?? {});
    delete custom.molstar_color_theme_name;
    delete custom.molstar_color_theme_params;
    delete custom.molstar_use_default_coloring;
    if (child.params?.selector === undefined || child.params.selector === 'all') colors.length = 0;
    colors.push({
      kind: 'color',
      params: { ...structuredClone(child.params), color },
      ...(Object.keys(custom).length ? { custom } : {}),
    });
  }
  return colors;
}

export function resolveNucleotidePresentations(
  root: MolecularProfileNode,
  defaults: NucleotideRenderDefaults,
  carbonDefault: string,
  options: {
    automatic?: boolean;
    enforceMode?: boolean;
    coherentAppearance?: boolean;
    hasNucleotides?: (selector: unknown, structureRef?: string) => boolean;
  } = {}
): void {
  const contactAtoms = options.coherentAppearance ? nucleotideContactAtoms(root) : new Map();
  function visit(node: MolecularProfileNode) {
    if (node.kind !== 'structure') {
      for (const child of node.children ?? []) visit(child);
      return;
    }
    if (options.coherentAppearance)
      node.children = node.children?.filter(
        (child) => !child.custom?.dnaforge_nucleotide_appearance_part
      );
    for (const component of node.children ?? [])
      for (const rep of component.children ?? [])
        if (rep.custom?.dnaforge_nucleotide_appearance_context) {
          delete rep.custom.dnaforge_nucleotide_appearance_context;
          delete rep.custom.is_hidden;
        }
    const excludedSelectors: unknown[] = [];
    for (const component of node.children ?? []) {
      if (component.kind !== 'component') continue;
      const children: MolecularProfileNode[] = [];
      for (const representation of (component.children ?? []).filter(
        (child) =>
          (!options.enforceMode && !options.coherentAppearance) ||
          !child.custom?.dnaforge_nucleotide_generated
      )) {
        children.push(representation);
        const selector = component.params?.selector ?? 'all';
        const automatic =
          options.automatic &&
          representation.kind === 'representation' &&
          representation.params?.type === 'ball_and_stick' &&
          (options.enforceMode || representation.custom?.dnaforge_render_profile !== 'native') &&
          (options.hasNucleotides
            ? options.hasNucleotides(selector, node.ref)
            : selector === 'nucleic');
        const request =
          representation.custom?.dnaforge_nucleotide_presentation ?? (automatic ? {} : undefined);
        if (request === undefined) continue;
        if (
          representation.custom?.dnaforge_nucleotide_resolved === true &&
          !options.enforceMode &&
          !options.coherentAppearance
        ) {
          excludedSelectors.push(component.params?.selector ?? 'all');
          continue;
        }
        if (
          representation.kind !== 'representation' ||
          representation.params?.type !== 'ball_and_stick'
        )
          throw new Error('Nucleotide presentation belongs on a ball_and_stick representation.');
        const requested = nucleotidePresentationSchema.parse(request);
        const explicitBaseColor =
          options.coherentAppearance &&
          requested.baseColor !== undefined &&
          (typeof representation.custom?.dnaforge_nucleotide_base_color_override === 'boolean' ||
            representation.custom?.dnaforge_nucleotide_resolved !== true);
        const settings = {
          ...defaults,
          ...requested,
          ...(options.enforceMode ? { connectorMode: defaults.connectorMode } : {}),
        };
        if (options.coherentAppearance && !explicitBaseColor) delete settings.baseColor;
        const native = representation.custom?.molstar_representation_params as
          | Record<string, unknown>
          | undefined;
        const previouslyDerived = representation.custom?.dnaforge_nucleotide_contact_atoms;
        const previousKeys = new Set(
          Array.isArray(previouslyDerived)
            ? previouslyDerived.map((value) => JSON.stringify(value))
            : []
        );
        const keptAtoms = Array.isArray(native?.dnaforgeNucleotideKeepAtoms)
          ? native.dnaforgeNucleotideKeepAtoms.filter(
              (value) => !previousKeys.has(JSON.stringify(value))
            )
          : [];
        const derivedContactAtoms = contactAtoms.get(node) ?? [];
        for (const expression of derivedContactAtoms)
          if (!keptAtoms.some((old) => JSON.stringify(old) === JSON.stringify(expression)))
            keptAtoms.push(structuredClone(expression));
        if (
          !options.enforceMode &&
          settings.connectorMode === 'simplified' &&
          native?.includeParent === true
        )
          throw new Error(
            'Simplified nucleotide detail cannot include parent sugar/phosphate bonds.'
          );
        const elementColor = representation.children?.find(
          (child) =>
            child.kind === 'color' && child.custom?.molstar_color_theme_name === 'element-symbol'
        );
        const carbon = (
          elementColor?.custom?.molstar_color_theme_params as
            | {
                carbonColor?: { name?: string; params?: { value?: number } };
              }
            | undefined
        )?.carbonColor;
        const inheritedColor =
          carbon?.name === 'uniform' && typeof carbon.params?.value === 'number'
            ? `#${carbon.params.value.toString(16).padStart(6, '0')}`
            : carbonDefault;
        const baseColor =
          settings.baseColor ?? representation.custom?.dnaforge_carbon_color ?? inheritedColor;
        representation.custom = {
          ...representation.custom,
          dnaforge_nucleotide_resolved: true,
          dnaforge_nucleotide_presentation: options.coherentAppearance
            ? settings
            : { ...settings, baseColor },
          ...(options.coherentAppearance
            ? {
                dnaforge_nucleotide_base_color_override: explicitBaseColor,
                dnaforge_nucleotide_contact_atoms: structuredClone(derivedContactAtoms),
              }
            : {}),
          molstar_representation_params: {
            ...native,
            dnaforgeNucleotideAtomicMode:
              settings.connectorMode === 'simplified' ? 'base-only' : 'full',
            ...(keptAtoms.length || options.coherentAppearance
              ? { dnaforgeNucleotideKeepAtoms: keptAtoms }
              : {}),
            ...(settings.connectorMode === 'simplified' ? { includeParent: false } : {}),
          },
        };
        let planeColors: MolecularProfileNode[] = [{ kind: 'color', params: { color: baseColor } }];
        if (settings.baseColor === undefined) {
          for (const color of representation.children ?? []) {
            if (
              color.kind !== 'color' ||
              color.custom?.molstar_color_theme_name !== 'element-symbol'
            )
              continue;
            const tint = (
              color.custom.molstar_color_theme_params as
                | {
                    carbonColor?: { name?: string; params?: { value?: number } };
                  }
                | undefined
            )?.carbonColor;
            if (tint?.name === 'uniform' && typeof tint.params?.value === 'number') {
              if (color.params?.selector === undefined || color.params.selector === 'all')
                planeColors.length = 0;
              planeColors.push({
                kind: 'color',
                params: {
                  ...color.params,
                  color: `#${tint.params.value.toString(16).padStart(6, '0')}`,
                },
              });
            }
          }
        }
        const groupColors = options.coherentAppearance
          ? nucleotideGroupColors(representation, String(baseColor))
          : planeColors;
        if (options.coherentAppearance && !explicitBaseColor) planeColors = groupColors;
        const shape = (visual: string, alpha: number, radius: number): MolecularProfileNode => ({
          kind: 'representation',
          params: { type: 'cartoon' },
          custom: {
            dnaforge_nucleotide_generated: true,
            molstar_representation_params: {
              visuals: [visual],
              sizeFactor: radius,
              thicknessFactor: 1,
              ...(visual === NUCLEOTIDE_CONNECTOR_VISUAL && keptAtoms.length
                ? { dnaforgeNucleotideExclude: structuredClone(keptAtoms) }
                : {}),
            },
          },
          children: [
            ...structuredClone(visual === NUCLEOTIDE_CONNECTOR_VISUAL ? groupColors : planeColors),
            { kind: 'opacity', params: { opacity: alpha } },
          ],
        });
        children.push(
          shape(NUCLEOTIDE_BASE_PLANE_VISUAL, settings.baseOpacity, settings.baseThickness)
        );
        if (settings.connectorMode === 'simplified')
          children.push(shape(NUCLEOTIDE_CONNECTOR_VISUAL, 1, settings.connectorRadius));
        excludedSelectors.push(component.params?.selector ?? 'all');
      }
      component.children = children;
    }
    for (const component of node.children ?? []) {
      if (component.kind !== 'component') continue;
      for (const representation of component.children ?? []) {
        if (
          representation.params?.type !== 'cartoon' ||
          representation.custom?.dnaforge_nucleotide_generated
        )
          continue;
        const native = representation.custom?.molstar_representation_params as
          | Record<string, unknown>
          | undefined;
        if (!excludedSelectors.length && !Array.isArray(native?.dnaforgeNucleotideExclude))
          continue;
        representation.custom = {
          ...representation.custom,
          molstar_representation_params: {
            ...native,
            dnaforgeNucleotideExclude: excludedSelectors,
          },
        };
      }
    }
  }
  visit(root);
}
