import type { RendererFeature } from '../../../feature-registry/renderer-feature';
import { InventoryPanel } from '../InventoryPanel';

export const inventoryRendererFeature: RendererFeature = {
  id: 'inventory',
  views: [
    {
      view: 'inventory',
      Component: InventoryPanel,
      placement: 'workspace',
      screenCategory: 'lims',
      activityButton: {
        label: 'Inventory',
        testId: 'inventory-button',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
          </svg>
        ),
      },
    },
  ],
};
