import { z } from 'zod';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const molecularPresentationPreferencesSchema = z
  .object({
    nucleotideDetail: z.enum(['simplified', 'atomic']),
    nucleotideBackbone: z.enum(['ribbon', 'authored']).optional(),
    cartoonScale: z.number().min(0.2).max(3),
    preservePolymerContext: z.boolean(),
    bindingSiteDetail: z.enum(['atomic', 'authored']).optional(),
    bindingSiteSurface: z.enum(['translucent', 'authored']).optional(),
    interfaceSurface: z.enum(['translucent', 'authored']).optional(),
    cameraTransitionMs: z.number().min(0).max(2000).optional(),
    comparisonPresentation: z.enum(['overlay', 'authored']).optional(),
  })
  .strict();

export type MolecularPresentationPreferences = z.infer<
  typeof molecularPresentationPreferencesSchema
>;
export const DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES: MolecularPresentationPreferences = {
  nucleotideDetail: 'simplified',
  nucleotideBackbone: 'ribbon',
  cartoonScale: 1,
  preservePolymerContext: true,
  bindingSiteDetail: 'atomic',
  bindingSiteSurface: 'translucent',
  interfaceSurface: 'translucent',
  cameraTransitionMs: 500,
  comparisonPresentation: 'authored',
};

export const useMolecularPresentationPreferences = create<{
  preferences: MolecularPresentationPreferences;
  update: (patch: Partial<MolecularPresentationPreferences>) => void;
}>()(
  persist(
    (set, get) => ({
      preferences: DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES,
      update: (patch) =>
        set({
          preferences: molecularPresentationPreferencesSchema.parse({
            ...get().preferences,
            ...patch,
          }),
        }),
    }),
    {
      name: 'dnaforge:molecular-presentation-preferences',
      version: 2,
      migrate: (saved) => {
        const parsed = molecularPresentationPreferencesSchema.safeParse(
          (saved as { preferences?: unknown } | undefined)?.preferences
        );
        return parsed.success
          ? { preferences: { ...parsed.data, comparisonPresentation: 'authored' } }
          : { preferences: DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES };
      },
      partialize: (state) => ({ preferences: state.preferences }),
      merge: (saved, current) => {
        const parsed = molecularPresentationPreferencesSchema.safeParse(
          (saved as { preferences?: unknown } | undefined)?.preferences
        );
        return parsed.success
          ? {
              ...current,
              preferences: { ...DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES, ...parsed.data },
            }
          : current;
      },
    }
  )
);
