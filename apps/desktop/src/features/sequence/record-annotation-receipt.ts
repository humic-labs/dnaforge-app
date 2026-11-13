import {
  customFetch,
  getImportRecordedAnnotationOperationOperationsAnnotationImportRecordedPostUrl,
  type AnnotationSubjectInput,
  type importRecordedAnnotationOperationOperationsAnnotationImportRecordedPostResponse,
} from '@waypoint/api-client';
import { platform } from '../../platform';
import { serviceManager } from '../../services/service-manager';

const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const INPUT_REVISION = /^annotation-input-v1:sha256:([a-f0-9]{64})$/;

interface RuntimeSelection {
  readonly status: string;
  readonly scopeId: string | null;
  readonly ownerInstanceId: string | null;
}

interface ReceiptCandidate {
  subject: AnnotationSubjectInput;
  receipt: unknown;
}

export interface RecordedReceiptDependencies {
  runtime: () => RuntimeSelection;
  pick: () => Promise<string | string[] | null>;
  read: (path: string, maxBytes: number) => Promise<Uint8Array>;
  submit: (
    candidate: ReceiptCandidate
  ) => Promise<importRecordedAnnotationOperationOperationsAnnotationImportRecordedPostResponse>;
}

export function recordedReceiptDependencies(
  runtime: () => RuntimeSelection
): RecordedReceiptDependencies {
  return {
    runtime,
    pick: () =>
      platform().dialog.open({
        multiple: false,
        title: 'Record a completed annotation run',
        filters: [{ name: 'Annotation run receipt', extensions: ['json'] }],
      }),
    read: (path, maxBytes) => platform().fs.readFileBounded(path, maxBytes),
    submit: (candidate) => {
      serviceManager.bindGeneratedClient();
      return customFetch<importRecordedAnnotationOperationOperationsAnnotationImportRecordedPostResponse>(
        getImportRecordedAnnotationOperationOperationsAnnotationImportRecordedPostUrl(),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(candidate),
        }
      );
    },
  };
}

export async function recordSelectedAnnotationReceipt(
  dependencies: RecordedReceiptDependencies
): Promise<{ status: 'canceled' } | { status: 'recorded'; operationId: string }> {
  const selectedRuntime = dependencies.runtime();
  if (
    selectedRuntime.status !== 'connected' ||
    !selectedRuntime.scopeId ||
    !selectedRuntime.ownerInstanceId
  )
    throw new Error('Connect to a Jobs runtime before recording a completed run.');

  const selected = await dependencies.pick();
  const path = Array.isArray(selected) ? selected[0] : selected;
  if (!path) return { status: 'canceled' };
  const bytes = await dependencies.read(path, MAX_RECEIPT_BYTES);
  if (bytes.byteLength > MAX_RECEIPT_BYTES)
    throw new Error('The run receipt exceeds the 16 MiB import limit.');
  let receipt: unknown;
  try {
    receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('The selected file is not a valid JSON run receipt.');
  }
  if (!isObject(receipt) || !isObject(receipt.input) || typeof receipt.input.revision !== 'string')
    throw new Error(
      'Select a run receipt. Ordinary result files can be imported from Annotations.'
    );
  const revision = INPUT_REVISION.exec(receipt.input.revision)?.[1];
  if (!revision) throw new Error('The run receipt has an unsupported input revision.');
  requireSameRuntime(dependencies.runtime(), selectedRuntime, false);
  const response = await dependencies.submit({
    subject: {
      scope_id: selectedRuntime.scopeId,
      subject_id: `recorded-input:${revision}`,
    },
    receipt,
  });
  requireSameRuntime(dependencies.runtime(), selectedRuntime, true);
  const payload: unknown = response.data;
  if (
    response.status !== 200 ||
    !isObject(payload) ||
    typeof payload.id !== 'string' ||
    payload.id.length === 0 ||
    payload.origin !== 'recorded' ||
    payload.state !== 'succeeded' ||
    !isObject(payload.subject) ||
    payload.subject.scope_id !== selectedRuntime.scopeId ||
    payload.subject.subject_id !== `recorded-input:${revision}`
  )
    throw new Error('The runtime did not confirm the recorded run. Check Jobs before retrying.');
  return { status: 'recorded', operationId: payload.id };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireSameRuntime(
  current: RuntimeSelection,
  selected: RuntimeSelection,
  submitted: boolean
): void {
  if (
    current.status === 'connected' &&
    current.scopeId === selected.scopeId &&
    current.ownerInstanceId === selected.ownerInstanceId
  )
    return;
  throw new Error(
    submitted
      ? 'The Jobs runtime changed after submission. The run may be recorded; check Jobs before retrying.'
      : 'The Jobs runtime changed while selecting the receipt. Select the file again.'
  );
}
