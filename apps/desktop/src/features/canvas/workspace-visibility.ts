import { usePresentationEligibility } from '../../presentation/PresentationSurface';

export function useWorkspaceVisibility(): boolean {
  return usePresentationEligibility('presentation');
}
