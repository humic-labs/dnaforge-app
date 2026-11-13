// @vitest-environment node

import type { FileActivationDelivery } from '../../shared/file-association-ipc';
import { processFileActivation } from './process-file-activation';

const delivery: FileActivationDelivery = {
  deliveryId: 'file-activation-1',
  path: '/outside/design.gb',
  familyId: 'genbank',
};

describe(' activation controller', () => {
  it('opens every accepted activation through the shared Quick Look command', async () => {
    const openQuickLook = vi.fn(async () => 'tab-1');

    await expect(
      processFileActivation(delivery, { openQuickLook, reportError: vi.fn() })
    ).resolves.toEqual({
      deliveryId: delivery.deliveryId,
      outcome: 'opened-quick-look',
      tabId: 'tab-1',
    });
    expect(openQuickLook).toHaveBeenCalledWith(delivery);
  });

  it('does not claim success when the Quick Look command declines to open a tab', async () => {
    await expect(
      processFileActivation(delivery, {
        openQuickLook: vi.fn(async () => null),
        reportError: vi.fn(),
      })
    ).resolves.toEqual({ deliveryId: delivery.deliveryId, outcome: 'rejected' });
  });

  it('reports a thrown failure without importing or creating a workspace', async () => {
    const reportError = vi.fn();
    await expect(
      processFileActivation(delivery, {
        openQuickLook: vi.fn(async () => {
          throw new Error('disk full');
        }),
        reportError,
      })
    ).resolves.toEqual({ deliveryId: delivery.deliveryId, outcome: 'rejected' });
    expect(reportError).toHaveBeenCalledWith('Could not open “design.gb”: disk full');
  });
});
