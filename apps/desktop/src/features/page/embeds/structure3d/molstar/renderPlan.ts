import type { StructureRepresentationBuiltInProps } from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params';
import type { Structure3dColorMode, Structure3dRepresentation } from '../types';
import {
  chainIdPaletteParams,
  contextChainPaletteParams,
  getPolymerConfig,
  type RepresentationConfig,
} from '../molstarConfigs';
import {
  isContextPolymerComponentLabel,
  isFocusPolymerComponentLabel,
  isQueryPolymerComponentLabel,
  STRUCTURE_COMPONENT_LABELS,
} from './componentLabels';

export type PolymerRenderRole = 'query' | 'focus' | 'context' | 'unscoped';
export type PolymerRepresentationSlot = 'primary' | 'detail';

export interface PolymerRepresentationPlanEntry {
  role: PolymerRenderRole;
  slot: PolymerRepresentationSlot;
  tag: string;
  props: StructureRepresentationBuiltInProps;
}

export const DEFAULT_CARTOON_TYPE_PARAMS = { sizeFactor: 0.2 } as const;
export const HIDDEN_BALL_AND_STICK_TYPE_PARAMS = {
  sizeFactor: 0.15,
  sizeAspectRatio: 2 / 3,
  alpha: 0,
} as const;
export const WAYPOINT_POLYMER_REPRESENTATION_TAG_PREFIX = 'waypoint.structure3d.polymer';

export function polymerRenderRoleForComponentLabel(label: string): PolymerRenderRole | null {
  if (label === STRUCTURE_COMPONENT_LABELS.polymer) return 'unscoped';
  if (isQueryPolymerComponentLabel(label)) return 'query';
  if (isFocusPolymerComponentLabel(label)) return 'focus';
  if (isContextPolymerComponentLabel(label)) return 'context';
  return null;
}

export function polymerRepresentationTag(
  role: PolymerRenderRole,
  slot: PolymerRepresentationSlot
): string {
  return `${WAYPOINT_POLYMER_REPRESENTATION_TAG_PREFIX}.${role}.${slot}`;
}

export function polymerRepresentationSlotForCell(
  role: PolymerRenderRole,
  representation: unknown,
  fallbackIndex: number
): PolymerRepresentationSlot | null {
  const tags = representationTags(representation);
  if (tags.includes(polymerRepresentationTag(role, 'primary'))) return 'primary';
  if (tags.includes(polymerRepresentationTag(role, 'detail'))) return 'detail';

  if (fallbackIndex === 0) return 'primary';
  if (fallbackIndex === 1 && role !== 'context') return 'detail';
  return null;
}

export function getInitialPolymerRepresentationPlanForRole(
  role: PolymerRenderRole
): PolymerRepresentationPlanEntry[] {
  const colorParams = role === 'context' ? contextChainPaletteParams() : chainIdPaletteParams();
  const plan: PolymerRepresentationPlanEntry[] = [
    {
      role,
      slot: 'primary',
      tag: polymerRepresentationTag(role, 'primary'),
      props: {
        type: 'cartoon',
        typeParams: { ...DEFAULT_CARTOON_TYPE_PARAMS },
        color: 'chain-id',
        colorParams,
      },
    },
  ];

  if (role !== 'context') {
    plan.push({
      role,
      slot: 'detail',
      tag: polymerRepresentationTag(role, 'detail'),
      props: {
        type: 'ball-and-stick',
        typeParams: { ...HIDDEN_BALL_AND_STICK_TYPE_PARAMS },
        color: 'element-symbol',
      },
    });
  }

  return plan;
}

export function getInitialPolymerRepresentationsForRole(
  role: PolymerRenderRole
): StructureRepresentationBuiltInProps[] {
  return getInitialPolymerRepresentationPlanForRole(role).map((entry) => entry.props);
}

export function getPolymerRepresentationConfigForRole(
  role: PolymerRenderRole,
  representation: Structure3dRepresentation,
  colorMode: Structure3dColorMode,
  chainPaletteColors?: readonly number[]
): RepresentationConfig {
  const config = getPolymerConfig(representation, colorMode, chainPaletteColors);
  if (role !== 'context') return config;

  if (representation === 'illustrative') {
    return {
      ...config,
      colorTheme: 'illustrative',
      colorParams: {
        style: { name: 'chain-id', params: contextChainPaletteParams() },
      },
    };
  }

  return {
    ...config,
    colorTheme: 'chain-id',
    colorParams: contextChainPaletteParams(),
  };
}

function representationTags(representation: unknown): string[] {
  const cell = (
    representation as { cell?: { transform?: { tags?: unknown }; obj?: { tags?: unknown } } }
  )?.cell;
  const tags = cell?.transform?.tags ?? cell?.obj?.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
}
