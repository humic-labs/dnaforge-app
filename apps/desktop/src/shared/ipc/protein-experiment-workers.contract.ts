import type {
  ProteinExperimentBindRequest,
  ProteinExperimentPrepareRequest,
  ProteinExperimentReleaseRequest,
  ProteinExperimentWorkerLease,
  ReviewRoundRequest,
  ProteinExperimentWorkerRequest,
  ProteinExperimentWorkerResponse,
} from '../protein-experiment-workers';
import { defineGroup, invoke, event, send } from './contract';

export const proteinExperimentWorkersContract = defineGroup('proteinExperimentWorkers', {
  checkAdmission: invoke<[request: ReviewRoundRequest], void>().channel(
    'protein-experiment-workers:check-admission'
  ),
  requestApproval: invoke<[request: ReviewRoundRequest], void>().channel(
    'protein-experiment-workers:request-approval'
  ),
  prepare: invoke<
    [request: ProteinExperimentPrepareRequest],
    ProteinExperimentWorkerLease
  >().channel('protein-experiment-workers:prepare'),
  bind: invoke<[request: ProteinExperimentBindRequest], void>().channel(
    'protein-experiment-workers:bind'
  ),
  release: invoke<[request: ProteinExperimentReleaseRequest], void>().channel(
    'protein-experiment-workers:release'
  ),
  ready: invoke<[], void>().channel('protein-experiment-workers:ready'),
  respond: send<[response: ProteinExperimentWorkerResponse]>().channel(
    'protein-experiment-workers:response'
  ),
  onRequest: event<[payload: ProteinExperimentWorkerRequest]>().channel(
    'protein-experiment-workers:request'
  ),
});
