const NAME_PATTERN = /^([a-z][a-z0-9]*)\.([a-z][a-zA-Z0-9]*)(?:_v(0|[1-9][0-9]*))?$/;

export interface ParsedActionName {
  qualifiedName: string;
  domain: string;
  verb: string;
  version: number;
  raw: string;
}

export function parseActionName(name: string): ParsedActionName | null {
  if (typeof name !== 'string' || name.length === 0) return null;
  const match = NAME_PATTERN.exec(name);
  if (!match) return null;
  const [, domain, verb, versionStr] = match;
  if (versionStr === undefined) {
    return { qualifiedName: `${domain}.${verb}`, domain, verb, version: 1, raw: name };
  }
  const version = Number.parseInt(versionStr, 10);
  if (version < 2) return null;
  return {
    qualifiedName: `${domain}.${verb}`,
    domain,
    verb,
    version,
    raw: name,
  };
}

export function isValidActionName(name: string): boolean {
  return parseActionName(name) !== null;
}

export class InvalidActionNameError extends Error {
  readonly actionName: string;
  constructor(name: string) {
    super(
      `Invalid action name: ${JSON.stringify(name)}. ` +
        `Names must match domain.verb with optional _vN suffix (N >= 2). ` +
        `domain = [a-z][a-z0-9]*, verb = [a-z][a-zA-Z0-9]*. ` +
        `Examples: "sequence.findFeatures", "design.addRegion", "structure.selectResidues_v2".`
    );
    this.name = 'InvalidActionNameError';
    this.actionName = name;
  }
}

export function assertValidActionName(name: string): ParsedActionName {
  const parsed = parseActionName(name);
  if (!parsed) throw new InvalidActionNameError(name);
  return parsed;
}
