import type {
  ComparisonSourceReadRequest,
  ComparisonSourceReadResult,
  ComparisonSourceWindowRequest,
  ComparisonSourceWindowResult,
} from '../comparison-source';
import { defineGroup, invoke } from './contract';

export const comparisonSourcesContract = defineGroup('comparisonSources', {
  read: invoke<[request: ComparisonSourceReadRequest], ComparisonSourceReadResult>(),
  readWindow: invoke<[request: ComparisonSourceWindowRequest], ComparisonSourceWindowResult>(),
});
