import { createHostedAgentConfirm } from './dialogs';
import { createHostedGenome } from './genome';
import { createHostedLims } from './lims';
import {
  createHostedReferenceAssets,
  hostedPreparedReferences,
} from './reference-genomes/hosted-reference-genomes';

export const hostedAgentConfirm = createHostedAgentConfirm();
export const hostedLims = createHostedLims();
export const hostedGenome = createHostedGenome(hostedPreparedReferences);
export const hostedReferenceAssets = createHostedReferenceAssets();
