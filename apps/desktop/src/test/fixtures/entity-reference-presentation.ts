import { useLimsOverlayStore } from '../../features/lims/lims-overlay-store';

export { presentDocument } from '../../features/canvas/present-document';
export { observeRegistryPresentation } from '../../features/lims/lims-overlay-store';

export function resetRegistryPresentationForTest(): void {
  useLimsOverlayStore.setState({ active: false, registryRequest: null });
}

export function getRegistryPresentationForTest() {
  return useLimsOverlayStore.getState().registryRequest;
}
