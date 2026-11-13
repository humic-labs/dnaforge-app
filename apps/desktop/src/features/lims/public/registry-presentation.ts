import { useLimsOverlayStore } from '../lims-overlay-store';

export {
  presentRegistryEntity,
  navigateToRegistryEntity,
  type RegistryPresentationResult,
} from '../registry-presentation';

type RequestRegistryEntity = ReturnType<
  typeof useLimsOverlayStore.getState
>['requestRegistryEntity'];

export const requestRegistryEntity: RequestRegistryEntity = (...args) =>
  useLimsOverlayStore.getState().requestRegistryEntity(...args);
