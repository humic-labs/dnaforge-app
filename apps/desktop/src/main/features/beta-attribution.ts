import { handleBetaAttributionUrl, isBetaAttributionUrl } from '../beta-attribution';
import type { MainFeature } from './main-feature';

export const betaAttributionFeature: MainFeature = {
  id: 'beta-attribution',
  protocolRoutes: [
    {
      matches: isBetaAttributionUrl,
      open: (url, context) => void handleBetaAttributionUrl(url, context.getMainWindow()),
    },
  ],
};
