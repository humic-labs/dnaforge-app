import { parseMocloKitDefinition, type MocloKitDefinition } from './moclo-kit-definition';

export interface MocloKitTemplate {
  id: string;
  name: string;
  organism: string;
  addgene?: { kitId: string; url: string };
  lab?: string;
  definition: MocloKitDefinition;
}

interface RawTemplate {
  id?: unknown;
  organism?: unknown;
  addgene?: { kitId?: unknown; url?: unknown };
  lab?: unknown;
  kit?: unknown;
}

function text(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${context} must be a non-empty string.`);
  }
  return value.trim();
}

let cache: MocloKitTemplate[] | null = null;

export async function loadMocloKitTemplates(): Promise<MocloKitTemplate[]> {
  if (cache) return cache;
  const module =
    await import('../../resources/moclo-kit-templates/addgene-kit-architectures.json?raw');
  return parseMocloKitTemplates(module.default);
}

export function parseMocloKitTemplates(raw: string): MocloKitTemplate[] {
  const parsed: unknown = JSON.parse(raw);
  const list = (parsed as { templates?: unknown }).templates;
  if (!Array.isArray(list)) throw new Error('Kit template library must contain a templates array.');
  const templates = list.map((entry, index) => {
    const raw = entry as RawTemplate;
    const context = `template[${index}]`;
    const definition = parseMocloKitDefinition(
      JSON.stringify(raw.kit),
      `${context} (${typeof raw.id === 'string' ? raw.id : 'unnamed'})`
    );
    if (definition.members.length) {
      throw new Error(`${context} must not declare members; templates carry architecture only.`);
    }
    if (!definition.citations.length) {
      throw new Error(`${context} must cite the source of its architecture.`);
    }
    return {
      id: text(raw.id, `${context}.id`),
      name: definition.name,
      organism: text(raw.organism, `${context}.organism`),
      ...(raw.addgene
        ? {
            addgene: {
              kitId: text(raw.addgene.kitId, `${context}.addgene.kitId`),
              url: text(raw.addgene.url, `${context}.addgene.url`),
            },
          }
        : {}),
      ...(raw.lab === undefined ? {} : { lab: text(raw.lab, `${context}.lab`) }),
      definition,
    } satisfies MocloKitTemplate;
  });
  const ids = new Set<string>();
  for (const template of templates) {
    if (ids.has(template.id)) throw new Error(`Duplicate kit template id: ${template.id}.`);
    ids.add(template.id);
  }
  cache = templates;
  return templates;
}

export async function findMocloKitTemplate(id: string): Promise<MocloKitTemplate | undefined> {
  return (await loadMocloKitTemplates()).find((template) => template.id === id);
}
