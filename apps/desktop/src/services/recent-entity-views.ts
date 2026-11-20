import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';

const entityViewSchema = z.object({
  entityId: z.string().trim().min(1).max(1000),
  viewedAt: z.number().int().nonnegative(),
});
export type EntityView = z.infer<typeof entityViewSchema>;

function orderedViews(views: readonly EntityView[]): EntityView[] {
  return [...views]
    .sort((a, b) => b.viewedAt - a.viewedAt)
    .filter(
      (view, index, sorted) =>
        sorted.findIndex((entry) => entry.entityId === view.entityId) === index
    )
    .slice(0, 100);
}

interface EntityViewHistory {
  views: EntityView[];
  recordView: (entityId: string, viewedAt?: number) => void;
}

export const useEntityViewHistory = create<EntityViewHistory>()(
  persist(
    (set) => ({
      views: [],
      recordView: (entityId, viewedAt = Date.now()) => {
        const parsed = entityViewSchema.safeParse({ entityId, viewedAt });
        if (!parsed.success) return;
        set((state) => ({
          views: orderedViews([parsed.data, ...state.views]),
        }));
      },
    }),
    {
      name: 'dnaforge-entity-view-history',
      partialize: ({ views }) => ({ views }),
      merge: (persisted, current) => {
        const parsed = z.object({ views: z.array(entityViewSchema).max(100) }).safeParse(persisted);
        return { ...current, views: parsed.success ? orderedViews(parsed.data.views) : [] };
      },
    }
  )
);
