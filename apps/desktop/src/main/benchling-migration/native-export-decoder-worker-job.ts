import {
  decodeBenchlingNativeExport,
  type DecodedLocalNativeExportEvidence,
  type DecodeLocalBenchlingNativeExportInput,
  type NativeExportDecodeProgressListener,
} from './native-export-decoder';

export const NATIVE_EXPORT_DECODER_WORKER_JOB_SCHEMA =
  'dnaforge.benchling.native-export-decoder-worker-job.v1' as const;
export const NATIVE_EXPORT_DECODER_WORKER_RESULT_SCHEMA =
  'dnaforge.benchling.native-export-decoder-worker-result.v1' as const;

export type NativeExportDecoderWorkerJob = Readonly<{
  schema: typeof NATIVE_EXPORT_DECODER_WORKER_JOB_SCHEMA;
  input: DecodeLocalBenchlingNativeExportInput;
}>;

export type NativeExportDecoderWorkerResult = Readonly<{
  schema: typeof NATIVE_EXPORT_DECODER_WORKER_RESULT_SCHEMA;
  decoded: DecodedLocalNativeExportEvidence;
}>;

export async function runNativeExportDecoderWorkerJob(
  job: NativeExportDecoderWorkerJob,
  onProgress?: NativeExportDecodeProgressListener
): Promise<NativeExportDecoderWorkerResult> {
  if (job.schema !== NATIVE_EXPORT_DECODER_WORKER_JOB_SCHEMA) {
    throw new Error('Native export decoder worker received an unsupported job schema.');
  }
  return {
    schema: NATIVE_EXPORT_DECODER_WORKER_RESULT_SCHEMA,
    decoded: await decodeBenchlingNativeExport(job.input, onProgress),
  };
}
