import type { FileActivationDelivery } from '../../shared/file-association-ipc';

export interface ProcessFileActivationDependencies {
  readonly openQuickLook: (delivery: FileActivationDelivery) => Promise<string | null>;
  readonly reportError: (message: string) => void;
}

export type ProcessFileActivationResult =
  | { readonly deliveryId: string; readonly outcome: 'opened-quick-look'; readonly tabId: string }
  | { readonly deliveryId: string; readonly outcome: 'rejected' };

function fileLabel(filePath: string): string {
  return filePath.split(/[\\/]/u).filter(Boolean).pop() ?? filePath;
}

export async function processFileActivation(
  delivery: FileActivationDelivery,
  dependencies: ProcessFileActivationDependencies
): Promise<ProcessFileActivationResult> {
  try {
    const tabId = await dependencies.openQuickLook(delivery);
    return tabId
      ? { deliveryId: delivery.deliveryId, outcome: 'opened-quick-look', tabId }
      : { deliveryId: delivery.deliveryId, outcome: 'rejected' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    dependencies.reportError(`Could not open “${fileLabel(delivery.path)}”: ${detail}`);
    return { deliveryId: delivery.deliveryId, outcome: 'rejected' };
  }
}
