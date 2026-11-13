import {
  displayGroupSchema,
  DISPLAY_GROUP_CONTRACT,
  molecularColorIsDataPalette,
  molecularColorIsElementPalette,
  type MolecularBindingScope,
} from '../../../../../shared/molecular-display-group-contract';
export {
  displayGroupSchema,
  DISPLAY_GROUP_CONTRACT,
  molecularColorIsDataPalette,
  molecularColorIsElementPalette,
  type MolecularBindingScope,
  designationSchema,
  MOLECULAR_DATA_COLOR_KEY,
} from '../../../../../shared/molecular-display-group-contract';
import { z } from 'zod';
import type { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import type { MolecularProfileNode as Node } from './nucleotidePresentationSettings';
import { assignStructureRefsInRoot } from './molViewSpecStructureIdentity';

export type DisplayGroup = z.infer<typeof displayGroupSchema>;
export type SelectionDesignation = {
  label: string;
  ionId?: string;
  color?: string;
  empty?: boolean;
  elementColorLayer?: boolean;
  ligandCopyId?: string;
  ligandCopyCount?: number;
  physicalOwnerId?: string;
};

export class MolecularDisplayGroupError extends Error {
  readonly code = 'MVS_DISPLAY_GROUP_REQUIRED';
}

export function molecularRepresentationVisible(node: Node): boolean {
  if (node.custom?.is_hidden === true) return false;
  const opacities = node.children?.filter((child) => child.kind === 'opacity') ?? [];
  const opacity = opacities[opacities.length - 1];
  const native = node.custom?.molstar_representation_params as { alpha?: number } | undefined;
  return (opacity?.params?.opacity ?? native?.alpha ?? 1) !== 0;
}

function name(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80)
    throw new MolecularDisplayGroupError('Display-group names must contain 1–80 characters.');
  return value.trim().replace(/\s+/g, ' ');
}

function swatch(node: Node): string {
  const theme = node.custom?.molstar_color_theme_params as
    | {
        carbonColor?: { params?: { value?: number } };
      }
    | undefined;
  const carbon = theme?.carbonColor?.params?.value;
  if (typeof carbon === 'number' && Number.isInteger(carbon) && carbon >= 0 && carbon <= 0xffffff)
    return `#${carbon.toString(16).padStart(6, '0')}`;
  const raw = node.params?.color;
  return typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw) ? raw : '#909090';
}

function renderedCarbonHue(node: Node): string | undefined {
  const themeName = node.custom?.molstar_color_theme_name;
  const theme = node.custom?.molstar_color_theme_params as
    | { value?: number; carbonColor?: { name?: string; params?: { value?: number } } }
    | undefined;
  const value =
    themeName === 'uniform'
      ? theme?.value
      : themeName === 'element-symbol' && theme?.carbonColor?.name === 'uniform'
        ? theme.carbonColor.params?.value
        : undefined;
  if (themeName === undefined) {
    const color = node.params?.color;
    return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)
      ? color.toLowerCase()
      : undefined;
  }
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff
    ? `#${value.toString(16).padStart(6, '0')}`
    : undefined;
}

export function resolveMolecularDisplayGroups(
  document: MVSData,
  describe?: (
    componentSelector: unknown,
    colorSelector?: unknown,
    colorNode?: Node
  ) => SelectionDesignation | undefined,
  selectionsFor?: (
    structure: Node & { ref?: string },
    index: number
  ) =>
    | {
        describe: NonNullable<typeof describe>;
        describeResidual?: (
          selector: unknown,
          colorSelectors: unknown[]
        ) => SelectionDesignation | undefined;
        describeResidualGroups?: (
          selector: unknown,
          colorSelectors: unknown[]
        ) => Array<SelectionDesignation & { selector: unknown }>;
        colorsCover: (
          selector: unknown,
          colorSelectors: unknown[],
          parentSelector?: unknown
        ) => boolean;
        selectionRelation?: (
          leftComponent: unknown,
          leftColor: unknown,
          rightComponent: unknown,
          rightColor: unknown,
          leftExcluded?: unknown[],
          rightExcluded?: unknown[]
        ) => {
          leftAtomCount: number;
          rightAtomCount: number;
          sharedAtomCount: number;
          leftCarbonCount: number;
          rightCarbonCount: number;
          sharedCarbonCount: number;
        };
        bindingScope?: (
          selector: unknown,
          colorSelector: unknown,
          siteSelectors: unknown[]
        ) => MolecularBindingScope;
      }
    | undefined
): MVSData {
  const result = structuredClone(document);
  const identityColors = new Map<string, string>();
  const roots = result.kind === 'multiple' ? result.snapshots.map((s) => s.root) : [result.root];
  for (const [index, typedRoot] of roots.entries()) {
    const root = typedRoot as Node;
    const namedColors: Array<{
      structureRef?: string;
      selector: unknown;
      colorSelector: unknown;
      color: Node;
      label: string;
      focus: boolean;
      excluded: unknown[];
      selections: ReturnType<NonNullable<typeof selectionsFor>>;
    }> = [];
    assignStructureRefsInRoot(root);
    root.custom = { ...root.custom, dnaforge_display_group_contract: DISPLAY_GROUP_CONTRACT };
    const visit = (
      node: Node,
      selections?: ReturnType<NonNullable<typeof selectionsFor>>,
      structureRef?: string,
      siteSelectors: unknown[] = [],
      focusSeeds: unknown[] = []
    ): void => {
      if (node.custom?.is_hidden === true) return;
      if (node.kind === 'structure') {
        selections = selectionsFor?.(node, index);
        structureRef = (node as Node & { ref?: string }).ref;
        siteSelectors = [];
        focusSeeds = [];
        const pending = [...(node.children ?? [])];
        while (pending.length) {
          const child = pending.pop()!;
          if (child.custom?.is_hidden === true || child.kind === 'structure') continue;
          const region = child.custom?.dnaforge_binding_region as
            | { target?: unknown; partner?: unknown; seed?: unknown }
            | undefined;

          if (child.kind === 'component' && child.custom?.dnaforge_presentation_role === 'focus')
            focusSeeds.push(child.params?.selector ?? 'all');
          if (region)
            for (const selector of [region.target, region.partner]) {
              if (selector !== undefined && (!Array.isArray(selector) || selector.length))
                siteSelectors.push(selector);
            }
          pending.push(...(child.children ?? []));
        }
      }
      if (
        node.kind === 'component' ||
        node.kind === 'component_from_uri' ||
        node.kind === 'component_from_source'
      ) {
        const selector = node.params?.selector ?? 'all';
        const describeSelection = selections?.describe ?? describe;
        const description = describeSelection?.(selector);
        let owner: DisplayGroup | undefined;
        for (const representation of node.children ?? []) {
          if (
            representation.kind !== 'representation' ||
            !molecularRepresentationVisible(representation)
          )
            continue;
          if (representation.custom?.dnaforge_nucleotide_generated && owner) {
            representation.custom = {
              ...representation.custom,
              dnaforge_display_group: { ...owner, supplement: true },
            };
            continue;
          }

          representation.children = representation.children?.filter(
            (child) =>
              child.kind !== 'color' ||
              describeSelection?.(selector, child.params?.selector ?? 'all', child)?.empty !== true
          );

          const isAuxiliaryColor = (color: Node) =>
            molecularColorIsDataPalette(color) ||
            molecularColorIsElementPalette(color, representation) ||
            describeSelection?.(selector, color.params?.selector ?? 'all', color)
              ?.elementColorLayer === true;
          representation.children = representation.children?.filter((child, i, children) => {
            if (child.kind !== 'color' || !selections || isAuxiliaryColor(child)) return true;
            const later = children
              .slice(i + 1)
              .filter((color) => color.kind === 'color' && !isAuxiliaryColor(color));
            return (
              !later.length ||
              !selections.colorsCover(
                child.params?.selector ?? 'all',
                later.map((color) => color.params?.selector ?? 'all'),
                selector
              )
            );
          });
          const colors =
            representation.children?.filter(
              (child) => child.kind === 'color' && !molecularColorIsDataPalette(child)
            ) ?? [];
          const authoredLabel =
            name(representation.custom?.dnaforge_legend_label) ??
            name(node.custom?.dnaforge_legend_label);
          const label = description?.ionId
            ? description.label
            : (authoredLabel ??
              (selector === 'polymer'
                ? 'Polymer context'
                : (description?.label ??
                  (
                    {
                      protein: 'Protein',
                      nucleic: 'Nucleic acid',
                      ligand: 'Ligands',
                      ion: 'Ions',
                      water: 'Water',
                      branched: 'Glycans',
                    } as Record<string, string>
                  )[String(selector)] ??
                  'Molecular detail')));
          const color = description?.color ?? (colors[0] ? swatch(colors[0]) : '#909090');
          owner = {
            label,
            color,
            id:
              description?.ionId ??
              (description?.ligandCopyId
                ? `${structureRef ?? 'source'}:${description.ligandCopyId}:${color}`
                : `${label}\u0000${color}`),
            ...(description?.ligandCopyCount && siteSelectors.length && selections?.bindingScope
              ? { bindingScope: selections.bindingScope(selector, 'all', siteSelectors) }
              : {}),
            ...(description?.empty ? { empty: true } : {}),
            ...(selections && colors.length
              ? {
                  residual: !selections.colorsCover(
                    selector,
                    colors.map((c) => c.params?.selector ?? 'all')
                  ),
                }
              : {}),
          };
          representation.custom = { ...representation.custom, dnaforge_display_group: owner };
          for (const [colorIndex, colorNode] of colors.entries()) {
            const layerDescription = describeSelection?.(
              selector,
              colorNode.params?.selector ?? 'all',
              colorNode
            );
            if (
              layerDescription?.elementColorLayer ||
              molecularColorIsElementPalette(colorNode, representation)
            )
              colorNode.custom = { ...colorNode.custom, dnaforge_element_color_layer: true };
            const layerLabel = layerDescription?.ionId
              ? layerDescription.label
              : (name(colorNode.custom?.dnaforge_legend_label) ?? label);
            const molecularIdentity = name(colorNode.custom?.dnaforge_molecular_identity);
            const colorSelector = colorNode.params?.selector ?? 'all';
            const namedFocus =
              !!(name(colorNode.custom?.dnaforge_legend_label) ?? authoredLabel) &&
              colorNode.custom?.dnaforge_legend_generated !== true &&
              !molecularColorIsElementPalette(colorNode, representation) &&
              (node.custom?.dnaforge_presentation_role === 'focus' ||
                focusSeeds.some((seed) => {
                  if (seed === undefined || !selections?.selectionRelation) return false;
                  const relation = selections.selectionRelation(
                    selector,
                    colorSelector,
                    seed,
                    'all'
                  );

                  return (
                    relation.leftAtomCount > 0 &&
                    relation.sharedAtomCount === relation.leftAtomCount
                  );
                }));
            const appearanceIdentity = namedFocus
              ? `focus:${molecularIdentity ?? layerLabel}`
              : (molecularIdentity ?? layerLabel);
            const authoredIdentity =
              molecularIdentity ?? name(colorNode.custom?.dnaforge_legend_label);
            const ligandCopyId = layerDescription?.ligandCopyId;
            const bindingScope =
              layerDescription?.ligandCopyCount && siteSelectors.length
                ? selections?.bindingScope?.(
                    selector,
                    colorNode.params?.selector ?? 'all',
                    siteSelectors
                  )
                : undefined;
            if (
              authoredIdentity &&
              colorNode.custom?.dnaforge_legend_generated !== true &&
              !layerDescription?.ionId &&
              !molecularColorIsElementPalette(colorNode, representation)
            ) {
              const canonical = identityColors.get(appearanceIdentity) ?? swatch(colorNode);
              identityColors.set(appearanceIdentity, canonical);
              colorNode.params = { ...colorNode.params, color: canonical };
              const theme = colorNode.custom?.molstar_color_theme_params as
                | {
                    value?: number;
                    carbonColor?: { name?: string; params?: { value?: number } };
                  }
                | undefined;
              if (theme?.carbonColor?.name === 'uniform')
                theme.carbonColor.params = {
                  ...theme.carbonColor.params,
                  value: parseInt(canonical.slice(1), 16),
                };
              else if (colorNode.custom?.molstar_color_theme_name === 'uniform' && theme)
                theme.value = parseInt(canonical.slice(1), 16);
            }
            colorNode.custom = {
              ...colorNode.custom,
              dnaforge_display_group_role: namedFocus ? 'focus' : undefined,
              dnaforge_legend_label: layerLabel,
              dnaforge_legend_generated:
                !authoredIdentity || colorNode.custom?.dnaforge_legend_generated === true,
              dnaforge_display_group_id:
                layerDescription?.ionId ??
                (ligandCopyId && !molecularIdentity
                  ? `${structureRef ?? 'source'}:${ligandCopyId}:${swatch(colorNode)}`
                  : undefined),
              dnaforge_binding_scope: bindingScope,
              dnaforge_display_group_color:
                layerDescription?.ionId &&
                colorNode.custom?.molstar_color_theme_name === 'element-symbol'
                  ? layerDescription.color
                  : undefined,
            };
            if (
              ['cartoon', 'backbone', 'ball_and_stick', 'spacefill', 'line'].includes(
                String(representation.params?.type)
              ) &&
              !molecularColorIsElementPalette(colorNode, representation)
            )
              namedColors.push({
                structureRef,
                selector,
                colorSelector,
                color: colorNode,
                label: layerLabel,
                focus: namedFocus,
                excluded: colors
                  .slice(colorIndex + 1)
                  .map((color) => color.params?.selector ?? 'all'),
                selections,
              });
          }
          const residual =
            !authoredLabel &&
            colors.length &&
            !representation.children?.some((child) =>
              ['color_from_uri', 'color_from_source'].includes(child.kind)
            )
              ? selections?.describeResidual?.(
                  selector,
                  colors.map((color) => color.params?.selector ?? 'all')
                )
              : undefined;
          if (residual?.ionId) {
            owner = {
              ...owner,
              label: residual.label,
              id: residual.ionId,
              color: residual.color ?? color,
            };
            representation.custom.dnaforge_display_group = owner;
          } else if (!authoredLabel && owner.residual && selections?.describeResidualGroups) {
            const residualGroups = selections.describeResidualGroups(
              selector,
              colors.map((color) => color.params?.selector ?? 'all')
            );
            if (residualGroups.length) {
              owner.residualGroups = residualGroups.map((group) => ({
                label: group.label,
                color: group.color ?? '#ffffff',
                id: group.ionId ?? `${structureRef ?? 'source'}:residual:${group.physicalOwnerId}`,
                selector: group.selector,
              }));
              representation.custom.dnaforge_display_group = owner;
            }
          }
        }
        return;
      }
      for (const child of node.children ?? [])
        visit(child, selections, structureRef, siteSelectors, focusSeeds);
    };
    visit(root);
    for (const feature of namedColors) {
      if (!feature.focus || !feature.selections?.selectionRelation) continue;
      for (const context of namedColors) {
        if (
          feature === context ||
          feature.structureRef !== context.structureRef ||
          renderedCarbonHue(feature.color) === undefined ||
          renderedCarbonHue(feature.color) !== renderedCarbonHue(context.color)
        )
          continue;
        const relation = feature.selections.selectionRelation(
          feature.selector,
          feature.colorSelector,
          context.selector,
          context.colorSelector
        );
        const visible = feature.selections.selectionRelation(
          feature.selector,
          feature.colorSelector,
          context.selector,
          context.colorSelector,
          feature.excluded,
          context.excluded
        );
        if (
          relation.leftCarbonCount > 0 &&
          relation.rightCarbonCount > relation.leftCarbonCount &&
          relation.sharedCarbonCount === relation.leftCarbonCount &&
          visible.leftCarbonCount > 0 &&
          visible.rightCarbonCount > visible.sharedCarbonCount
        ) {
          const error = new Error(
            `Named focus "${feature.label}" shares carbon hue ${swatch(feature.color)} with its broader "${context.label}" context. Give the exact feature a contrasting element-color layer; retain the broad molecular identity color.`
          );
          Object.assign(error, { code: 'MVS_NAMED_FOCUS_COLOR_COLLISION' });
          throw error;
        }
      }
    }
  }
  requireMolecularDisplayGroups(result);
  return result;
}

export function requireMolecularDisplayGroups(document: MVSData, required = true): void {
  const roots =
    document.kind === 'multiple' ? document.snapshots.map((s) => s.root) : [document.root];
  for (const [index, typedRoot] of roots.entries()) {
    const root = typedRoot as Node;
    if (!required && root.custom?.dnaforge_display_group_contract === undefined) continue;
    if (root.custom?.dnaforge_display_group_contract !== DISPLAY_GROUP_CONTRACT)
      throw new MolecularDisplayGroupError(
        `Story step ${index + 1} has no automatic display-group contract. Apply the scene once to assign its legend before saving.`
      );
    const visit = (node: Node): void => {
      if (!molecularRepresentationVisible(node)) return;
      if (
        node.kind === 'representation' &&
        !displayGroupSchema.safeParse(node.custom?.dnaforge_display_group).success
      )
        throw new MolecularDisplayGroupError(
          `Story step ${index + 1} has a displayed representation without a valid legend designation.`
        );
      if (
        node.kind === 'representation' &&
        !(node.custom?.dnaforge_display_group as DisplayGroup | undefined)?.supplement
      )
        for (const color of node.children?.filter((child) => child.kind === 'color') ?? [])
          if (
            (!molecularColorIsDataPalette(color) ||
              color.custom?.dnaforge_molecular_data_color === true) &&
            name(color.custom?.dnaforge_legend_label) === undefined
          )
            throw new MolecularDisplayGroupError(
              `Story step ${index + 1} has an undesignated color layer.`
            );
      for (const child of node.children ?? []) visit(child);
    };
    visit(root);
  }
}
