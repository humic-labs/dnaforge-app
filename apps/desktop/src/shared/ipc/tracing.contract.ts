import { defineGroup, invoke } from './contract';

export const tracingContract = defineGroup('tracing', {
  profilerStart: invoke<
    [
      opts?: {
        samplingIntervalUs?: number;
      },
    ],
    { ok: boolean; error?: string }
  >(),
  profilerStop: invoke<
    [],
    {
      ok: boolean;
      filePath?: string;
      durationMs?: number;
      error?: string;
    }
  >(),
  profilerIsActive: invoke<[], { active: boolean }>(),
});
