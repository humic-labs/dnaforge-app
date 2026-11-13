import type { EvalDescriptor } from '../descriptor/index.ts';
import type {
  ActionHandle,
  AuditSink,
  ProvenanceSink,
  ActionStore,
} from '../define-action-stub/types.ts';

export interface EvalEnvironment {
  resolveAction(actionName: string): ActionHandle<unknown, unknown> | undefined;
  store: ActionStore;
  audit: AuditSink;
  provenance: ProvenanceSink;
}

export interface EvalCaseResult {
  caseId: string;
  passed: boolean;
  reason?: string;
}

export interface EvalRunResult {
  descriptorId: string;
  kind: EvalDescriptor['kind'];
  passed: boolean;
  cases: EvalCaseResult[];
}
