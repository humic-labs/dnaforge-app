import { z } from 'zod';

export const entityNavigationSchemes = ['dnaforge', 'dnaforge-beta', 'dnaforge-dev'] as const;
export type EntityNavigationScheme =
  | (typeof entityNavigationSchemes)[number]
  | `dnaforge-dev-${number}`;

export function isEntityNavigationScheme(value: string): value is EntityNavigationScheme {
  if (entityNavigationSchemes.some((scheme) => value === scheme)) return true;
  const match = /^dnaforge-dev-([1-9]\d{0,4})$/.exec(value);
  return Boolean(match && Number(match[1]) <= 65535);
}

const identity = z
  .string()
  .min(1)
  .max(1000)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );

export const entityNavigationTargetSchema = z
  .object({
    entityId: identity,
    projectId: identity.optional(),
    referenceId: identity.optional(),
  })
  .strict();

export type EntityNavigationTarget = z.infer<typeof entityNavigationTargetSchema>;

export function isEntityNavigationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return isEntityNavigationScheme(url.protocol.slice(0, -1)) && url.hostname === 'entity';
  } catch {
    return false;
  }
}

export function parseEntityNavigationUrl(value: string): EntityNavigationTarget | null {
  try {
    const url = new URL(value);
    if (
      !isEntityNavigationUrl(value) ||
      url.pathname !== '/open' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      return null;
    const values: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (key in values) return null;
      values[key] = value;
    }
    const result = entityNavigationTargetSchema.safeParse(values);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function entityNavigationUrl(
  target: EntityNavigationTarget,
  scheme: EntityNavigationScheme = 'dnaforge'
): string {
  const parsed = entityNavigationTargetSchema.parse(target);
  if (!isEntityNavigationScheme(scheme)) throw new Error('Unsupported entity navigation scheme.');
  const url = new URL(`${scheme}://entity/open`);
  for (const [key, value] of Object.entries(parsed))
    if (value !== undefined) url.searchParams.set(key, value);
  return url.href;
}

export function findEntityNavigationUrlInArgv(argv: readonly string[]): string | null {
  return argv.find((argument) => isEntityNavigationUrl(argument)) ?? null;
}

export function entityNavigationLink(
  target: EntityNavigationTarget,
  scheme: EntityNavigationScheme = 'dnaforge'
) {
  const externalUrl = entityNavigationUrl(target, scheme);
  return {
    target,
    externalUrl,
    shellCommand: `open '${externalUrl.replace(/'/g, "'\\''")}'`,
  };
}
