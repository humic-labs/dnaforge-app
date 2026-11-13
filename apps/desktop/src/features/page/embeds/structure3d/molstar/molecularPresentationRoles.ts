import { z } from 'zod';
import { bindingRegionSchema } from './molecularBindingIntent';
import type { MolecularProfileNode as Node } from './nucleotidePresentationSettings';
import type { MolecularPresentationPreferences } from './molecularPresentationPreferences';
import { molecularRepresentationVisible } from './molecularDisplayGroups';

export const molecularPresentationRoleSchema = z.enum([
  'binding-site',
  'interface',
  'focus',
  'context',
]);
export type MolecularPresentationRole = z.infer<typeof molecularPresentationRoleSchema>;
export const molecularIdentitySchema = z.string().trim().min(1).max(80);

export function resolveMolecularPresentationRoles(
  root: Node,
  preferences: MolecularPresentationPreferences,
  exceptions: ReadonlySet<string>
): void {
  const visit = (node: Node): void => {
    if (node.custom?.is_hidden === true) return;
    const identity = node.custom?.dnaforge_molecular_identity;
    if (identity !== undefined) {
      const parsed = molecularIdentitySchema.safeParse(identity);
      if (!parsed.success || node.kind !== 'color') {
        const error = new Error(
          'A molecular identity must be a nonempty name of at most 80 characters on a scientific color layer.'
        );
        Object.assign(error, { code: 'MVS_INVALID_MOLECULAR_IDENTITY' });
        throw error;
      }
      node.custom!.dnaforge_molecular_identity = parsed.data.replace(/\s+/g, ' ');
    }
    const rawRole = node.custom?.dnaforge_presentation_role;
    if (rawRole !== undefined) {
      const parsed = molecularPresentationRoleSchema.safeParse(rawRole);
      if (!parsed.success || node.kind !== 'component') {
        const error = new Error(
          'A presentation role must be binding-site, interface, focus or context on an exact component.'
        );
        Object.assign(error, { code: 'MVS_INVALID_PRESENTATION_ROLE' });
        throw error;
      }
      const role = parsed.data;
      const representations = (node.children ?? []).filter(
        (n) => n.kind === 'representation' && molecularRepresentationVisible(n)
      );
      const generated = (type: string): Node => ({
        kind: 'representation',
        params: { type },
        custom: {
          dnaforge_presentation_generated: role,
          ...(representations[0]?.custom?.dnaforge_legend_label
            ? { dnaforge_legend_label: representations[0].custom.dnaforge_legend_label }
            : {}),
        },
        children: structuredClone(
          representations[0]?.children?.filter((n) =>
            ['color', 'color_from_uri', 'color_from_source'].includes(n.kind)
          ) ?? []
        ),
      });
      const detailPreferred =
        ['binding-site', 'interface'].includes(role) &&
        preferences.bindingSiteDetail === 'atomic' &&
        !exceptions.has('bindingSiteDetail');
      if (detailPreferred && !representations.some((n) => n.params?.type === 'ball_and_stick'))
        (node.children ??= []).push(generated('ball_and_stick'));
      if (
        role === 'interface' &&
        preferences.interfaceSurface === 'translucent' &&
        !exceptions.has('interfaceSurface')
      ) {
        const region = bindingRegionSchema.safeParse(node.custom?.dnaforge_binding_region);
        if (!region.success || !region.data.surfaceSide || !(node as Node & { ref?: string }).ref) {
          const error = new Error(
            'An interface surface requires explicit target and partner selectors and one surface side.'
          );
          Object.assign(error, { code: 'MVS_SURFACE_OWNERSHIP_REQUIRED' });
          throw error;
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
}
