import type {
  SequenceDataLayerCommand,
  SequenceDataLayerCommandResult,
} from '../sequence-data-layer';
import { defineGroup, invoke } from './contract';

export const sequenceDataLayersContract = defineGroup('sequenceDataLayers', {
  run: invoke<[request: SequenceDataLayerCommand], SequenceDataLayerCommandResult>(),
});
