import { z } from 'zod';
import definition from '../capability-policy.json';

const capabilityName = z
  .string()
  .min(1)
  .refine((value) => value === value.trim() && value !== '*');
const policy = z
  .object({
    schemaVersion: z.literal(1),
    wildcardCapability: z.literal('*'),
    implications: z.record(capabilityName, z.array(capabilityName)),
  })
  .strict()
  .parse(definition);
const implications = new Map(Object.entries(policy.implications));

export const WILDCARD_CAPABILITY = policy.wildcardCapability;

export function expandCapabilities(provided: readonly string[]): Set<string> {
  const expanded = new Set(provided);
  const pending = [...provided];
  while (pending.length > 0) {
    const capability = pending.pop();
    if (capability === undefined) continue;
    for (const implied of implications.get(capability) ?? []) {
      if (expanded.has(implied)) continue;
      expanded.add(implied);
      pending.push(implied);
    }
  }
  return expanded;
}

export function missingRequiredCapabilities(
  provided: readonly string[],
  required: readonly string[]
): string[] {
  if (provided.includes(WILDCARD_CAPABILITY)) return [];
  const expanded = expandCapabilities(provided);
  return required.filter((capability) => !expanded.has(capability));
}

export function hasRequiredCapabilities(
  provided: readonly string[],
  required: readonly string[]
): boolean {
  return missingRequiredCapabilities(provided, required).length === 0;
}
