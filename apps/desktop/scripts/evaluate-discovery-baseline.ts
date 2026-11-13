import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildHostedCodexToolCatalog } from '../src/main/hosted-codex/dynamic-tool-catalog';
import { HOSTED_CODEX_RESERVED_TOOLS } from '@waypoint/hosted-ai-contract';
import { discoverHostedTools } from '../src/main/hosted-codex/hosted-tool-discovery';
import { matchScore } from '../src/features/ai/tools/skill-relevance';

const root = new URL('./fixtures/jev-discovery/', import.meta.url);
const candidates = JSON.parse(readFileSync(new URL('candidates.json', root), 'utf8'));
const queries = JSON.parse(readFileSync(new URL('queries.json', root), 'utf8'));
const catalog = buildHostedCodexToolCatalog({
  allowEffects: ['read-only', 'mutating', 'ui-bound', 'external-submit'],
  omitNames: HOSTED_CODEX_RESERVED_TOOLS,
});
const live = discoverHostedTools(catalog, { query: '', limit: 8 });
const all = [];
let offset: number | null = 0;
while (offset !== null) {
  const page = discoverHostedTools(catalog, { query: '', offset, limit: 8 });
  all.push(...page.tools.map(({ name, description }) => ({ id: name, name, description })));
  offset = page.nextOffset;
}
if (JSON.stringify(all) !== JSON.stringify(candidates.tools))
  throw Error('Frozen tool catalog drifted');
const rows = [];
for (const surface of ['tools', 'skills'] as const) {
  for (const query of queries[surface]) {
    const started = performance.now();
    const ids =
      surface === 'tools'
        ? discoverHostedTools(catalog, { query: query.query, limit: 4 }).tools.map((t) => t.name)
        : candidates.skills
            .map((skill: { id: string; name: string; description: string }) => ({
              id: skill.id,
              name: skill.name,
              score: matchScore(
                {
                  ...skill,
                  source: { publisher: 'K-Dense AI', packName: 'Scientific Agent Skills' },
                },
                query.query
              ),
            }))
            .filter((s: { score: number }) => s.score > 0)
            .sort(
              (
                a: { score: number; name: string; id: string },
                b: { score: number; name: string; id: string }
              ) => b.score - a.score || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
            )
            .slice(0, 8)
            .map((s: { id: string }) => s.id);
    rows.push({ surface, ...query, ids, latencyMs: performance.now() - started });
  }
}
const output = process.argv.at(-1);
if (!output?.endsWith('.json')) throw Error('An OUTPUT.json path is required');
writeFileSync(
  output,
  JSON.stringify({ method: 'current lexical functions', rows }, null, 2) + '\n'
);
console.log(
  `Wrote ${rows.length} lexical results to ${output}; ${live.total} eligible tools. Fixture: ${fileURLToPath(root)}`
);
