import type { ComparisonSourceReadRequest, ComparisonSourceReadResult } from '../comparison-source';
import { defineGroup, invoke } from './contract';

export const comparisonSourcesContract = defineGroup('comparisonSources', {
  read: invoke<[request: ComparisonSourceReadRequest], ComparisonSourceReadResult>(),
});
