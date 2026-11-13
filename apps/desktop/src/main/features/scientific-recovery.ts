import { acquireScientificRecoveryProfileOwner } from '../scientific-recovery-profile-owner';
import type { MainFeature } from './main-feature';

export const scientificRecoveryFeature: MainFeature = {
  id: 'scientific-recovery',
  prepareProfile: (profilePath) => {
    acquireScientificRecoveryProfileOwner(profilePath, 'application');
  },
};
