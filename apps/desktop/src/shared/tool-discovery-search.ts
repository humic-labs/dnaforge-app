export interface DiscoverableToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}

const ignored = new Set(
  'a an and are as at be by can do for from how i in into is it me my of on or please that the this to use using want with would'.split(
    ' '
  )
);
function words(value: string): string[] {
  return [
    ...new Set(
      (
        value
          .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
          .toLowerCase()
          .match(/[\p{L}\p{N}]+/gu) ?? []
      )
        .filter((word) => !ignored.has(word))
        .map((word) => {
          const stem =
            word.length > 5 && word.endsWith('ing')
              ? word.slice(0, -3)
              : word.length > 4 && word.endsWith('ed')
                ? word.slice(0, -2)
                : word.length > 3 && word.endsWith('s') && !word.endsWith('ss')
                  ? word.slice(0, -1)
                  : word;
          return stem.length > 3 && stem.endsWith('e') ? stem.slice(0, -1) : stem;
        })
    ),
  ];
}

function schemaWords(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') return [];
  if (Array.isArray(schema)) return schema.flatMap(schemaWords);
  return Object.entries(schema).flatMap(([key, value]) => {
    if ((key === 'const' || key === 'description' || key === 'title') && typeof value === 'string')
      return words(value);
    if (key === 'enum' && Array.isArray(value))
      return value.flatMap((entry) => (typeof entry === 'string' ? words(entry) : []));
    if (key === 'properties' && value && typeof value === 'object')
      return [...Object.keys(value).flatMap(words), ...schemaWords(value)];
    return schemaWords(value);
  });
}

export function createToolDescriptorSearch<T extends DiscoverableToolDescriptor>(
  tools: readonly T[]
) {
  const nameOrder = (a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const indexed = tools.map((tool) => ({
    tool,
    name: new Set(words(tool.name)),
    description: new Set(words(tool.description)),
    schema: new Set(schemaWords(tool.inputSchema)),
  }));
  const frequencies = new Map<string, number>();
  for (const item of indexed)
    for (const word of new Set([...item.name, ...item.description, ...item.schema]))
      frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  const match = (set: ReadonlySet<string>, word: string) =>
    set.has(word) ||
    (word.length >= 4 &&
      [...set].some(
        (token) => token.length >= 4 && (token.startsWith(word) || word.startsWith(token))
      ));
  return {
    exact(query: string): T | null {
      return tools.find((tool) => tool.name.toLowerCase() === query.trim().toLowerCase()) ?? null;
    },
    search(query: string): T[] {
      if (!query.trim()) return [...tools].sort(nameOrder);
      const exact = tools.find((tool) => tool.name.toLowerCase() === query.trim().toLowerCase());
      if (exact) return [exact];
      const terms = words(query);
      if (!terms.length) return [];
      return indexed
        .map((item) => {
          let matched = 0,
            score = 0;
          for (const term of terms) {
            const name = match(item.name, term),
              schema = match(item.schema, term),
              description = match(item.description, term);
            if (!name && !schema && !description) continue;
            matched++;
            const weight = 1 + Math.log((tools.length + 1) / ((frequencies.get(term) ?? 0) + 1));
            score += weight * ((name ? 4 : 0) + (schema ? 2 : 0) + (description ? 1 : 0));
          }
          return { tool: item.tool, matched, score: score * (matched / terms.length) };
        })
        .filter((item) => item.matched >= Math.ceil(terms.length / 2))
        .sort((a, b) => b.score - a.score || nameOrder(a.tool, b.tool))
        .map((item) => item.tool);
    },
  };
}
