import { canonicalJson } from './canonical-json';
import { z } from 'zod';

export const providerReportedComputeRequestSchema = z
  .object({
    input: z.record(z.unknown()),
    model: z.string().min(1).max(256),
    version: z.string().min(1).max(256),
  })
  .strict();
export type ProviderReportedComputeRequest = z.infer<typeof providerReportedComputeRequestSchema>;

export interface FrozenComputeRequest {
  schemaVersion: 1;
  provider: string;
  toolId: string;
  settings: Record<string, unknown>;
  files: Record<string, string>;
}

export interface ComputeInputFileWitness {
  name: string;
  sha256: string;
  byteLength: number;
}

export function freezeComputeRequest(
  provider: string,
  toolId: string,
  settings: Record<string, unknown>,
  files: Record<string, string> = {}
): FrozenComputeRequest {
  if (!provider || provider.length > 128 || !toolId || toolId.length > 128)
    throw new Error('A prediction request needs a provider and tool.');
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw new Error('Prediction settings must be a JSON object.');
  if (!files || typeof files !== 'object' || Array.isArray(files))
    throw new Error('Prediction input files must be named UTF-8 text.');
  const entries = Object.entries(files);
  if (entries.length > 64) throw new Error('A prediction request exceeds 64 input files.');
  let totalBytes = 0;
  for (const [name, content] of entries) {
    if (!name || name.length > 200 || typeof content !== 'string' || content.length > 4_000_000)
      throw new Error('A prediction input file exceeds the supported name or text limit.');
    const bytes = new TextEncoder().encode(content);
    if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== content)
      throw new Error('A prediction input contains invalid Unicode text.');
    totalBytes += bytes.byteLength;
  }
  if (totalBytes > 64_000_000) throw new Error('Prediction input files exceed 64 MB.');
  const serialized = canonicalJson({ schemaVersion: 1, provider, toolId, settings, files });
  if (new TextEncoder().encode(serialized).byteLength > 256_000_000)
    throw new Error('The prediction request exceeds its retention limit.');
  return JSON.parse(serialized) as FrozenComputeRequest;
}
