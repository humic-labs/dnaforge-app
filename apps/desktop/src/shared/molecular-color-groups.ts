import { Color } from 'molstar/lib/mol-util/color';
import { ColorNames } from 'molstar/lib/mol-util/color/names';
import {
  displayGroupSchema,
  DISPLAY_GROUP_CONTRACT,
  molecularColorIsDataPalette,
  molecularColorIsElementPalette,
  type MolecularBindingScope,
} from './molecular-display-group-contract';
import type { MolecularProfileNode } from './molecular-scene-node';
import { assignStructureRefsInRoot } from './molecular-scene-structure-identity';
import { surfaceOwnerSchema } from './molecular-surface-owner-contract';

export const MVS_LEGEND_LABEL_KEY = 'dnaforge_legend_label';

export type SceneNode = {
  kind?: unknown;
  ref?: string;
  params?: {
    color?: unknown;
    opacity?: unknown;
    selector?: unknown;
    type?: unknown;
  };
  custom?: Record<string, unknown>;
  children?: SceneNode[];
};

export type MolViewSpecColorTarget = {
  structureIndex: number;
  structureRef?: string;
  componentSelector: unknown;
  colorSelector: unknown;
  laterColorSelectors: unknown[];
  nucleotideAtomicMode?: 'base-only' | 'full';
  nucleotideKeepAtoms?: unknown[];
  nucleotideJunctionAtoms?: unknown[];
  colorTheme?: {
    name: string;
    params: Record<string, unknown>;
  };
};

export type MolViewSpecSwatch =
  | {
      kind: 'colors';
      colors: Color[];
    }
  | {
      kind: 'gradient';
      colors: Color[];
    };

export type MolViewSpecColorGroup = {
  id: string;
  label: string;
  color: Color;
  structureCount: number;
  selectable: boolean;
  targets: MolViewSpecColorTarget[];
  bindingScope?: MolecularBindingScope;
  presentationRole?: 'focus';
  multicolor?: true;
  swatch?: MolViewSpecSwatch;
};

export function colorValue(value: unknown): Color | null {
  if (typeof value !== 'string') return null;
  if (/^#[0-9a-f]{6}$/i.test(value)) return Color.fromHexStyle(value);
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    const [red, green, blue] = value.slice(1).split('');
    return Color.fromHexStyle(`#${red}${red}${green}${green}${blue}${blue}`);
  }
  return Object.prototype.hasOwnProperty.call(ColorNames, value)
    ? ColorNames[value as keyof typeof ColorNames]
    : null;
}

export function isAnonymousGeneratedSurfaceSupplement(
  component: SceneNode | undefined,
  representation: SceneNode,
  color: SceneNode
): boolean {
  const identity = color.custom?.dnaforge_molecular_identity;
  const label = color.custom?.dnaforge_legend_label;
  const helperLabel = representation.custom?.dnaforge_legend_label;
  return (
    surfaceOwnerSchema.safeParse(component?.custom?.dnaforge_surface_owner).success &&
    ['surface', 'molecular-surface', 'gaussian-surface'].includes(
      String(representation.params?.type)
    ) &&
    ['binding-site', 'interface'].includes(
      String(representation.custom?.dnaforge_presentation_generated)
    ) &&
    color.custom?.dnaforge_legend_generated === true &&
    !(typeof identity === 'string' && identity.trim()) &&
    typeof label === 'string' &&
    typeof helperLabel === 'string' &&
    label.trim() === helperLabel.trim()
  );
}

export function molViewSpecColorGroups(
  scene: string | undefined,
  snapshotIndex: number,
  samePhysicalAtoms?: (left: MolViewSpecColorGroup, right: MolViewSpecColorGroup) => boolean
): MolViewSpecColorGroup[] {
  if (!scene) return [];
  let root: SceneNode | undefined;
  try {
    const document = JSON.parse(scene);
    root = document.kind === 'multiple' ? document.snapshots?.[snapshotIndex]?.root : document.root;
  } catch {
    return [];
  }
  if (!root) return [];
  try {
    assignStructureRefsInRoot(root);
  } catch {
    return [];
  }
  const automatic = root.custom?.dnaforge_display_group_contract === DISPLAY_GROUP_CONTRACT;
  const groups: MolViewSpecColorGroup[] = [];
  const byId = new Map<string, MolViewSpecColorGroup>();
  const ownership = new Map<
    MolViewSpecColorGroup,
    {
      identity?: string;
      structureRef?: string;
      generatedSurfaceOnly: boolean;
    }
  >();
  const supplements: Array<{
    node: SceneNode;
    structureIndex: number;
    component?: SceneNode;
    structureRef?: string;
  }> = [];
  let structureCount = 0;
  let visited = 0;
  let truncated = false;
  function visit(
    node: SceneNode,
    structureIndex = -1,
    component?: SceneNode,
    structureRef?: string,
    supplementOwnerOnly = false
  ) {
    if (visited++ >= 2000) {
      truncated = true;
      return;
    }
    if (node.custom?.is_hidden === true) return;
    if (node.kind === 'structure') {
      structureIndex = structureCount++;
      structureRef = node.ref;
    }
    if (
      node.kind === 'component' ||
      node.kind === 'component_from_uri' ||
      node.kind === 'component_from_source'
    )
      component = node;
    if (node.kind === 'representation' || node.kind === 'volume_representation') {
      const originalChildren = Array.isArray(node.children) ? node.children : [];
      const designation = displayGroupSchema.safeParse(node.custom?.dnaforge_display_group);
      if (designation.success && designation.data.empty) return;
      if (designation.success && designation.data.supplement && !supplementOwnerOnly) {
        supplements.push({ node, structureIndex, component, structureRef });
        return;
      }
      const colors = originalChildren.filter((c) =>
        ['color', 'color_from_uri', 'color_from_source'].includes(String(c.kind))
      );
      const coversAll = colors.some(
        (c) =>
          c.kind === 'color' &&
          typeof c.custom?.dnaforge_legend_label === 'string' &&
          (c.params?.selector === undefined || c.params.selector === 'all')
      );
      const children: SceneNode[] =
        automatic &&
        !supplementOwnerOnly &&
        designation.success &&
        designation.data.residual !== false &&
        !coversAll
          ? [
              ...(designation.data.residualGroups?.length
                ? designation.data.residualGroups.map((group) => ({
                    kind: 'color',
                    params: { color: group.color, selector: group.selector },
                    custom: {
                      dnaforge_legend_label: group.label,
                      dnaforge_display_group_id: group.id,
                    },
                  }))
                : [
                    {
                      kind: 'color',
                      params: { color: designation.data.color },
                      custom: {
                        dnaforge_legend_label: designation.data.label,
                        dnaforge_display_group_id: designation.data.id,
                        dnaforge_binding_scope: designation.data.bindingScope,
                      },
                    },
                  ]),
              ...originalChildren,
            ]
          : originalChildren;
      const opacities = children.filter((child) => child.kind === 'opacity');
      const opacity = opacities[opacities.length - 1];
      if (opacity?.params?.opacity === 0) return;
      if (
        (
          node.custom?.molstar_representation_params as
            | {
                alpha?: number;
              }
            | undefined
        )?.alpha === 0
      )
        return;
      for (const [index, child] of children.entries()) {
        if (child.kind !== 'color' || child.custom?.dnaforge_nucleotide_appearance_color === true)
          continue;
        if (isAnonymousGeneratedSurfaceSupplement(component, node, child)) continue;
        if (
          molecularColorIsDataPalette(child as MolecularProfileNode) ||
          molecularColorIsElementPalette(
            child as MolecularProfileNode,
            node as MolecularProfileNode
          )
        )
          continue;
        const hasNativeTheme =
          child.custom &&
          ('molstar_use_default_coloring' in child.custom ||
            'molstar_color_theme_name' in child.custom);
        let carbonSwatch: Color | undefined;
        let multicolor = false;
        let colorTheme: MolViewSpecColorTarget['colorTheme'];
        if (hasNativeTheme) {
          const theme = child.custom?.molstar_color_theme_params as
            | {
                carbonColor?: {
                  name?: string;
                  params?: {
                    value?: unknown;
                  };
                };
              }
            | undefined;
          const value = theme?.carbonColor?.params?.value;
          const colors = children.filter(
            (other) =>
              other.kind === 'color' ||
              other.kind === 'color_from_uri' ||
              other.kind === 'color_from_source'
          );
          if (
            child.custom?.molstar_color_theme_name !== 'element-symbol' ||
            theme?.carbonColor?.name !== 'uniform' ||
            (!automatic && colors.length !== 1) ||
            typeof value !== 'number' ||
            !Number.isInteger(value) ||
            value < 0 ||
            value > 0xffffff
          ) {
            if (!automatic) continue;
            multicolor =
              child.custom?.molstar_color_theme_name !== 'uniform' &&
              child.custom?.dnaforge_display_group_color === undefined;
            if (multicolor && typeof child.custom?.molstar_color_theme_name === 'string')
              colorTheme = {
                name: child.custom.molstar_color_theme_name,
                params: (theme ?? {}) as Record<string, unknown>,
              };
          } else carbonSwatch = Color(value);
        }
        const rawLabel = child.custom?.[MVS_LEGEND_LABEL_KEY];
        if (typeof rawLabel !== 'string') continue;
        const baseLabel = rawLabel.trim().replace(/\s+/g, ' ');
        const scopeValue = child.custom?.dnaforge_binding_scope;
        const bindingScope = ['site', 'context', 'mixed'].includes(String(scopeValue))
          ? (scopeValue as MolecularBindingScope)
          : undefined;
        const scopeLabel =
          bindingScope === 'site'
            ? 'binding site'
            : bindingScope === 'mixed'
              ? 'site and context'
              : bindingScope;
        const label = scopeLabel ? `${baseLabel} · ${scopeLabel}` : baseLabel;
        const color =
          (automatic ? colorValue(child.custom?.dnaforge_display_group_color) : null) ??
          carbonSwatch ??
          colorValue(child.params?.color);
        if (!baseLabel || baseLabel.length > 80 || color === null) continue;
        const explicitId = automatic ? child.custom?.dnaforge_display_group_id : undefined;
        const selectionId = child.custom?.dnaforge_selection_id;
        const id =
          typeof selectionId === 'string' && selectionId
            ? `${selectionId}${bindingScope ? `:${bindingScope}` : ''}`
            : typeof explicitId === 'string'
              ? `${explicitId}${bindingScope ? `:${bindingScope}` : ''}`
              : `${label}\u0000${color}`;
        let group = byId.get(id);
        const identity = child.custom?.dnaforge_molecular_identity;
        const scientificIdentity =
          typeof identity === 'string' && identity.trim() ? identity.trim() : undefined;
        const generatedSurface =
          ['binding-site', 'interface'].includes(
            String(node.custom?.dnaforge_presentation_generated)
          ) &&
          ['surface', 'molecular-surface', 'gaussian-surface'].includes(String(node.params?.type));
        if (!group) {
          if (supplementOwnerOnly) continue;
          group = {
            id,
            label,
            color,
            structureCount: 0,
            selectable: true,
            targets: [],
            ...(bindingScope ? { bindingScope } : {}),
            ...(child.custom?.dnaforge_display_group_role === 'focus'
              ? { presentationRole: 'focus' as const }
              : {}),
            ...(multicolor ? { multicolor: true as const } : {}),
          };
          groups.push(group);
          byId.set(id, group);
          ownership.set(group, {
            identity: scientificIdentity,
            structureRef,
            generatedSurfaceOnly: generatedSurface,
          });
        } else {
          if (multicolor) group.multicolor = true;
          const previous = ownership.get(group)!;
          if (previous.identity !== scientificIdentity || previous.structureRef !== structureRef) {
            previous.identity = undefined;
            previous.structureRef = undefined;
          }
          previous.generatedSurfaceOnly &&= generatedSurface;
        }
        const laterColors = children
          .slice(index + 1)
          .filter(
            (later) =>
              later.custom?.dnaforge_nucleotide_appearance_color !== true &&
              (later.kind === 'color' ||
                later.kind === 'color_from_uri' ||
                later.kind === 'color_from_source') &&
              !molecularColorIsElementPalette(
                later as MolecularProfileNode,
                node as MolecularProfileNode
              )
          );
        if (
          structureIndex < 0 ||
          component?.kind !== 'component' ||
          children.some((other) => other.kind === 'clip') ||
          laterColors.some((later) => later.kind !== 'color')
        ) {
          group.selectable = false;
        } else {
          const nativeParams = node.custom?.molstar_representation_params as
            | Record<string, unknown>
            | undefined;
          group.targets.push({
            structureIndex,
            structureRef,
            componentSelector: component.params?.selector ?? 'all',
            colorSelector:
              !automatic && carbonSwatch !== undefined ? 'all' : (child.params?.selector ?? 'all'),
            laterColorSelectors: laterColors.map((later) => later.params?.selector ?? 'all'),
            ...(colorTheme ? { colorTheme } : {}),
            ...(Array.isArray(component.custom?.dnaforge_nucleotide_junction_atoms)
              ? { nucleotideJunctionAtoms: component.custom.dnaforge_nucleotide_junction_atoms }
              : {}),
            ...(nativeParams?.dnaforgeNucleotideAtomicMode === 'base-only'
              ? { nucleotideAtomicMode: 'base-only' as const }
              : {}),
            ...(Array.isArray(nativeParams?.dnaforgeNucleotideKeepAtoms) &&
            nativeParams.dnaforgeNucleotideKeepAtoms.length
              ? { nucleotideKeepAtoms: nativeParams.dnaforgeNucleotideKeepAtoms }
              : {}),
          });
        }
      }
      return;
    }
    for (const child of node.children ?? []) visit(child, structureIndex, component, structureRef);
  }
  visit(root);
  for (const { node, structureIndex, component, structureRef } of supplements)
    visit(node, structureIndex, component, structureRef, true);
  if (truncated) return [];
  for (const group of groups) {
    group.structureCount = structureCount;
    if (!group.targets.length || group.targets.some((target) => !target.structureRef))
      group.selectable = false;
  }
  if (!samePhysicalAtoms) return groups;
  const inherited = new Set<MolViewSpecColorGroup>();
  for (const surface of groups) {
    const intent = ownership.get(surface)!;
    if (!intent.generatedSurfaceOnly || !intent.identity || !intent.structureRef) continue;
    const owners = groups.filter((candidate) => {
      const owner = ownership.get(candidate)!;
      return (
        !owner.generatedSurfaceOnly &&
        owner.identity === intent.identity &&
        owner.structureRef === intent.structureRef &&
        samePhysicalAtoms(surface, candidate)
      );
    });
    if (owners.length !== 1) continue;
    owners[0].targets.push(...surface.targets);
    inherited.add(surface);
  }
  return groups.filter((group) => !inherited.has(group));
}
