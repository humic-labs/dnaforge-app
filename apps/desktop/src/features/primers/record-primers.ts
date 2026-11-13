import { primerServices } from './primer-services';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import { createPrimerRecorder } from './record-primers-owner';
export * from './record-primers-owner';
const owner = createPrimerRecorder({ primerServices, withRendererWorkspaceMutation });
export const { recordPrimers } = owner;
