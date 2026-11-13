import { z } from 'zod';
import type { MolecularProfileNode as Node } from './molecular-scene-node';
import { HEX_COLOR_PATTERN } from './published-schema-patterns';

export const DISPLAY_GROUP_CONTRACT = 'automatic-display-groups-v1';

export const MOLECULAR_DATA_COLOR_KEY = 'dnaforge_molecular_data_color';

export const designationSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    color: z.string().regex(HEX_COLOR_PATTERN),
    id: z.string().min(1).max(180),
    supplement: z.boolean().optional(),
    empty: z.boolean().optional(),
    residual: z.boolean().optional(),
    bindingScope: z.enum(['site', 'context', 'mixed']).optional(),
  })
  .strict();

export const displayGroupSchema = designationSchema.extend({
  residualGroups: z.array(designationSchema.extend({ selector: z.unknown() })).optional(),
});

export type MolecularBindingScope = 'site' | 'context' | 'mixed';

export function molecularColorIsDataPalette(color: Node): boolean {
  return (
    color.kind === 'color' &&
    (color.custom?.dnaforge_display_group_role === 'data' ||
      color.custom?.[MOLECULAR_DATA_COLOR_KEY] === true)
  );
}

export function molecularColorIsElementPalette(color: Node, representation: Node): boolean {
  if (!['ball_and_stick', 'spacefill', 'line'].includes(String(representation.params?.type)))
    return false;
  if (color.custom?.dnaforge_element_color_layer === true) return true;
  const selector = color.params?.selector;
  const selectors = Array.isArray(selector) ? selector : [selector];
  return (
    selectors.length > 0 &&
    selectors.every((s) => {
      if (!s || typeof s !== 'object') return false;
      const symbol = (s as Record<string, unknown>).type_symbol;
      return typeof symbol === 'string' && symbol.toUpperCase() !== 'C';
    })
  );
}
