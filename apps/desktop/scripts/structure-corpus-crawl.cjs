#!/usr/bin/env node

require('esbuild-register');

const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const {
  MG1655_STRUCTURE_PROBE_CONTROLS,
  classifyStructureCorpusSidecarProbe,
  collectStructureCorpusFromGenBank,
  evaluateStructureCorpusProbeControls,
} = require('../src/features/structure-drawer/api/structure-corpus.ts');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'test-results/structure-corpus');
const GENBANK_EXTS = new Set(['.gb', '.gbk', '.gbff', '.genbank']);
const RESOLUTION_CAPABILITIES = ['external-fetch:annotation', 'external-fetch:xref-resolution'];
const STRUCTURE_CAPABILITIES = ['external-fetch:structure'];

function resolveFromRepo(value) {
  if (path.isAbsolute(value)) return value;
  const cwdResolved = path.resolve(value);
  if (existsSync(cwdResolved)) return cwdResolved;
  return path.resolve(REPO_ROOT, value);
}

function usage() {
  console.log(`Usage: pnpm --filter @waypoint/desktop structure:crawl [options] [files...]

Options:
  --out <dir>              Output directory (default: test-results/structure-corpus)
  --include-wp-assets      Also scan ../wp-assets or WP_ASSETS_DIR
  --probe-sidecar          Probe /external/uniprot/by-sequence and /external/alphafold/validate
  --probe-structure-bytes  Also fetch /external/structure/bytes for resolved AlphaFold hits
  --sidecar-url <url>      Sidecar URL for --probe-sidecar (default: VITE_API_URL or http://localhost:8001)
  --session-token <token>  X-DNAForge-Session token (default: DNAFORGE_MCP_SESSION_TOKEN)
  --match <regex>          Restrict sidecar probes to labels matching this regex
  --limit <n>              Limit sidecar probes to first n CDS features
  --success-target <n>     Continue probing until n AlphaFold structure-byte loads succeed
  --require-mg1655-controls
                           Fail if arsC/hdfR/rbsR/mioC sidecar controls do not resolve
  --require-all-probed-structures
                           Fail if any probed feature lacks a resolved AlphaFold hit or structure bytes
  --help                   Show this help
`);
}

function parseArgs(argv) {
  const opts = {
    outDir: DEFAULT_OUT_DIR,
    includeWpAssets: false,
    probeSidecar: false,
    probeStructureBytes: false,
    sidecarUrl: process.env.VITE_API_URL || 'http://localhost:8001',
    sessionToken: process.env.DNAFORGE_MCP_SESSION_TOKEN || '',
    match: null,
    limit: Number.POSITIVE_INFINITY,
    successTarget: null,
    requireMg1655Controls: false,
    requireAllProbedStructures: false,
    files: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--out') {
      const out = argv[++i];
      opts.outDir = path.isAbsolute(out) ? out : path.resolve(REPO_ROOT, out);
    } else if (arg === '--include-wp-assets') {
      opts.includeWpAssets = true;
    } else if (arg === '--probe-sidecar') {
      opts.probeSidecar = true;
    } else if (arg === '--probe-structure-bytes') {
      opts.probeSidecar = true;
      opts.probeStructureBytes = true;
    } else if (arg === '--sidecar-url') {
      opts.sidecarUrl = argv[++i];
    } else if (arg === '--session-token') {
      opts.sessionToken = argv[++i];
    } else if (arg === '--match') {
      opts.match = new RegExp(argv[++i]);
    } else if (arg === '--limit') {
      opts.limit = Number.parseInt(argv[++i], 10);
    } else if (arg === '--success-target') {
      opts.successTarget = Number.parseInt(argv[++i], 10);
    } else if (arg === '--require-mg1655-controls') {
      opts.requireMg1655Controls = true;
    } else if (arg === '--require-all-probed-structures') {
      opts.requireAllProbedStructures = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      opts.files.push(resolveFromRepo(arg));
    }
  }

  if (opts.probeSidecar && !opts.sessionToken) {
    throw new Error(
      '--probe-sidecar requires --session-token or DNAFORGE_MCP_SESSION_TOKEN in the environment'
    );
  }
  return opts;
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        stack.push(full);
      } else if (GENBANK_EXTS.has(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function defaultFiles(includeWpAssets) {
  const roots = [
    path.join(REPO_ROOT, 'test-fixtures/sequences'),
    path.join(REPO_ROOT, 'test-fixtures/genomes'),
  ];
  if (includeWpAssets) {
    roots.push(
      process.env.WP_ASSETS_DIR ||
        process.env.WP_ASSETS_PATH ||
        process.env.VITE_WP_ASSETS_PATH ||
        path.resolve(REPO_ROOT, '../wp-assets')
    );
  }
  return roots.flatMap(walkFiles);
}

function md5(value) {
  return createHash('md5').update(value).digest('hex').toUpperCase();
}

function compactFeature(feature) {
  const derivation = feature.derivation;
  return {
    sourcePath: feature.sourcePath,
    sequenceName: feature.sequenceName,
    featureIndex: feature.featureIndex,
    label: feature.label,
    start: feature.start,
    end: feature.end,
    direction: feature.direction,
    classifications: feature.classifications,
    hints: {
      dbXrefCount: feature.hints.dbXrefs?.length ?? 0,
      proteinId: feature.hints.proteinId,
      locusTag: feature.hints.locusTag,
      geneName: feature.hints.geneName,
      taxonId: feature.hints.taxonId,
    },
    protein: derivation
      ? {
          source: derivation.source,
          length: derivation.protein.length,
          md5: md5(derivation.protein),
          rawMd5: md5(derivation.rawProtein),
          preview: derivation.protein.slice(0, 24),
          rawPreview: derivation.rawProtein.slice(0, 24),
          startCodon: derivation.startCodon,
          initiatorNormalized: derivation.initiatorNormalized,
        }
      : null,
  };
}

function mergeSummary(reports, parseFailures) {
  const summary = {
    generatedAt: new Date().toISOString(),
    fileCount: reports.length + parseFailures.length,
    parsedFileCount: reports.length,
    parseFailureCount: parseFailures.length,
    cdsCount: 0,
    withQualifierTranslation: 0,
    withDbXref: 0,
    withProteinId: 0,
    withLocusTag: 0,
    withGene: 0,
    derivedProteinCount: 0,
    initiatorNormalizedCount: 0,
    internalStopCount: 0,
  };
  for (const report of reports) {
    for (const key of [
      'cdsCount',
      'withQualifierTranslation',
      'withDbXref',
      'withProteinId',
      'withLocusTag',
      'withGene',
      'derivedProteinCount',
      'initiatorNormalizedCount',
      'internalStopCount',
    ]) {
      summary[key] += report.summary[key];
    }
  }
  return summary;
}

async function postSidecar(url, sessionToken, body, grantedCapabilities = RESOLUTION_CAPABILITIES) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-DNAForge-Session': sessionToken,
    },
    body: JSON.stringify({
      granted_capabilities: grantedCapabilities,
      ...body,
    }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { ok: response.ok, status: response.status, json };
}

function normalizeProtein(value) {
  const normalized = String(value ?? '')
    .replace(/\s+/g, '')
    .toUpperCase();
  return normalized.endsWith('*') ? normalized.slice(0, -1) : normalized;
}

function strictSequenceOverlap(queryProtein, hitSequence) {
  const query = normalizeProtein(queryProtein);
  const hit = normalizeProtein(hitSequence);
  if (!query || !hit) return null;
  const accepted = [];
  for (const querySegment of stopFreeProteinSegments(query)) {
    for (const hitSegment of stopFreeProteinSegments(hit)) {
      const queryContainsHit = querySegment.includes(hitSegment);
      const hitContainsQuery = hitSegment.includes(querySegment);
      if (!queryContainsHit && !hitContainsQuery) continue;
      const overlapLength = Math.min(querySegment.length, hitSegment.length);
      if (overlapLength < 30) continue;
      const queryCoverage = overlapLength / querySegment.length;
      const hitCoverage = overlapLength / hitSegment.length;
      if (Math.min(queryCoverage, hitCoverage) < 0.7) continue;
      accepted.push({ overlapLength, queryCoverage, hitCoverage });
    }
  }
  accepted.sort((a, b) => {
    if (b.hitCoverage !== a.hitCoverage) return b.hitCoverage - a.hitCoverage;
    if (b.queryCoverage !== a.queryCoverage) return b.queryCoverage - a.queryCoverage;
    return b.overlapLength - a.overlapLength;
  });
  return accepted[0] ?? null;
}

function stopFreeProteinSegments(sequence) {
  return sequence
    .split('*')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 30);
}

async function searchGeneSequenceOverlap(feature, opts, rawDir, key) {
  const geneName = feature.hints?.geneName;
  if (!geneName || !/^[A-Za-z0-9_.-]+$/.test(geneName)) return null;
  const baseQuery = feature.hints?.taxonId
    ? `gene:${geneName} AND organism_id:${feature.hints.taxonId}`
    : `gene:${geneName}`;
  const allHits = [];
  let lastStatus = null;
  for (const reviewed of [true, false]) {
    const search = await postSidecar(
      `${opts.sidecarUrl.replace(/\/$/, '')}/external/uniprot/search`,
      opts.sessionToken,
      {
        query: `${baseQuery} AND reviewed:${reviewed ? 'true' : 'false'}`,
        size: 10,
        include_sequence: true,
      },
      ['external-fetch:annotation']
    );
    lastStatus = search.status;
    writeFileSync(
      path.join(rawDir, `${key}-gene-${reviewed ? 'reviewed' : 'unreviewed'}.json`),
      JSON.stringify(search, null, 2)
    );
    if (!search.ok) return { status: search.status, hit: null, overlap: null };
    if (Array.isArray(search.json?.hits)) allHits.push(...search.json.hits);
  }

  const accepted = allHits
    .map((hit, rank) => {
      const overlap = strictSequenceOverlap(feature.derivation.protein, hit.sequence);
      return overlap ? { hit, overlap, rank } : null;
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (b.overlap.hitCoverage !== a.overlap.hitCoverage) {
        return b.overlap.hitCoverage - a.overlap.hitCoverage;
      }
      if (b.overlap.queryCoverage !== a.overlap.queryCoverage) {
        return b.overlap.queryCoverage - a.overlap.queryCoverage;
      }
      if (!!a.hit.reviewed !== !!b.hit.reviewed) return a.hit.reviewed ? -1 : 1;
      return a.rank - b.rank;
    });
  const top = accepted[0] ?? null;
  return {
    status: lastStatus,
    hit: top?.hit ?? null,
    overlap: top?.overlap ?? null,
    hitCount: allHits.length,
  };
}

function alphaFoldBytesRequest(accession, afdbJson) {
  const latestVersion =
    typeof afdbJson?.latest_version === 'number' ? `V${afdbJson.latest_version}` : 'LATEST';
  const fragment = typeof afdbJson?.fragment === 'string' ? afdbJson.fragment : 'F1';
  const modelId =
    typeof afdbJson?.model_id === 'string'
      ? afdbJson.model_id
      : latestVersion === 'LATEST'
        ? undefined
        : `AF-${accession}-${fragment}-model_v${latestVersion.slice(1)}`;
  const externalId =
    typeof afdbJson?.provider_identity_key === 'string' && afdbJson.provider_identity_key
      ? afdbJson.provider_identity_key
      : modelId
        ? `AF:${accession}:${fragment}:${latestVersion}:MODEL:${modelId}`
        : `AF:${accession}:${fragment}:${latestVersion}`;
  return {
    provider: 'alphafold',
    external_id: externalId,
    accession,
    fragment,
    version: latestVersion,
    model_id: modelId,
    format: 'mmcif',
  };
}

async function probeFeature(feature, opts, rawDir) {
  if (!feature.derivation) return null;
  const key = `${String(feature.featureIndex).padStart(5, '0')}-${md5(
    `${feature.sourcePath}:${feature.label}:${feature.start}:${feature.end}`
  ).slice(0, 12)}`;
  const bySequence = await postSidecar(
    `${opts.sidecarUrl.replace(/\/$/, '')}/external/uniprot/by-sequence`,
    opts.sessionToken,
    { sequence: feature.derivation.protein, size: 10 }
  );
  writeFileSync(path.join(rawDir, `${key}-by-sequence.json`), JSON.stringify(bySequence, null, 2));

  const hit = bySequence.json?.hits?.[0];
  let resolutionMode = hit?.accession ? 'exact_sequence' : null;
  let geneSearch = null;
  let resolvedHit = hit ?? null;
  let sequenceOverlap = null;
  if (!resolvedHit?.accession) {
    geneSearch = await searchGeneSequenceOverlap(feature, opts, rawDir, key);
    if (geneSearch?.hit?.accession) {
      resolvedHit = geneSearch.hit;
      sequenceOverlap = geneSearch.overlap;
      resolutionMode = 'gene_sequence_overlap';
    }
  }
  let afdb = null;
  let structureBytes = null;
  if (bySequence.ok && resolvedHit?.accession) {
    afdb = await postSidecar(
      `${opts.sidecarUrl.replace(/\/$/, '')}/external/alphafold/validate`,
      opts.sessionToken,
      { accession: resolvedHit.accession }
    );
    writeFileSync(path.join(rawDir, `${key}-afdb.json`), JSON.stringify(afdb, null, 2));
    if (opts.probeStructureBytes && afdb.ok && afdb.json?.exists) {
      structureBytes = await postSidecar(
        `${opts.sidecarUrl.replace(/\/$/, '')}/external/structure/bytes`,
        opts.sessionToken,
        alphaFoldBytesRequest(resolvedHit.accession, afdb.json),
        STRUCTURE_CAPABILITIES
      );
      writeFileSync(
        path.join(rawDir, `${key}-structure-bytes.json`),
        JSON.stringify(
          {
            ok: structureBytes.ok,
            status: structureBytes.status,
            byteCount:
              typeof structureBytes.json?.raw === 'string'
                ? structureBytes.json.raw.length
                : JSON.stringify(structureBytes.json ?? '').length,
            json: structureBytes.ok ? undefined : structureBytes.json,
          },
          null,
          2
        )
      );
    }
  }

  return {
    sourcePath: feature.sourcePath,
    featureIndex: feature.featureIndex,
    label: feature.label,
    resolutionMode,
    bySequenceStatus: bySequence.status,
    geneSearchStatus: geneSearch?.status ?? null,
    uniprotHitCount: Array.isArray(bySequence.json?.hits) ? bySequence.json.hits.length : null,
    topAccession: resolvedHit?.accession ?? null,
    pdbIds: resolvedHit?.pdb_ids ?? [],
    afdbStatus: afdb?.status ?? null,
    afdbExists: afdb?.json?.exists ?? null,
    afdbMeanPlddt: afdb?.json?.mean_plddt ?? null,
    sequenceOverlap,
    structureBytesStatus: structureBytes?.status ?? null,
    structureBytesOk: structureBytes?.ok ?? null,
  };
}

function classifyProbe(probe) {
  return {
    ...probe,
    classifications: classifyStructureCorpusSidecarProbe(probe),
  };
}

function hasLoadedStructureBytes(probe) {
  const classifications = probe.classifications ?? classifyStructureCorpusSidecarProbe(probe);
  return (
    classifications.includes('alphafold_match') &&
    classifications.includes('structure_bytes_loaded')
  );
}

function renderMarkdown(report) {
  const s = report.summary;
  const classificationCounts = new Map();
  for (const feature of report.features) {
    for (const classification of feature.classifications) {
      classificationCounts.set(classification, (classificationCounts.get(classification) ?? 0) + 1);
    }
  }
  const classificationRows = [...classificationCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `| ${name} | ${count} |`)
    .join('\n');
  const positiveControls = report.features
    .filter((feature) => /^(arsC|hdfR|rbsR|mioC)\b/.test(feature.label))
    .slice(0, 20)
    .map(
      (feature) =>
        `| ${feature.label} | ${feature.protein?.startCodon ?? ''} | ${
          feature.protein?.initiatorNormalized ? 'yes' : 'no'
        } | ${feature.protein?.md5 ?? ''} | ${feature.classifications.join(', ') || 'none'} |`
    )
    .join('\n');

  return `# Structure Corpus Crawl

Generated: ${s.generatedAt}

## Summary

| Metric | Count |
| --- | ---: |
| Files parsed | ${s.parsedFileCount} |
| Parse failures | ${s.parseFailureCount} |
| CDS features | ${s.cdsCount} |
| CDS with /translation | ${s.withQualifierTranslation} |
| CDS with /db_xref | ${s.withDbXref} |
| CDS with /protein_id | ${s.withProteinId} |
| CDS with /locus_tag | ${s.withLocusTag} |
| CDS with /gene | ${s.withGene} |
| Derived proteins | ${s.derivedProteinCount} |
| Initiator-normalized proteins | ${s.initiatorNormalizedCount} |
| Internal-stop proteins | ${s.internalStopCount} |

## Classifications

| Classification | Count |
| --- | ---: |
${classificationRows || '| none | 0 |'}

## Positive-Control Rows

| Label | Start codon | Initiator normalized | Protein MD5 | Classifications |
| --- | --- | --- | --- | --- |
${positiveControls || '| none found | | | | |'}

${renderSidecarProbeMarkdown(report)}
`;
}

function renderSidecarProbeMarkdown(report) {
  if (!report.sidecarProbes) return '';
  const classifications = new Map();
  for (const probe of report.sidecarProbes) {
    for (const classification of probe.classifications ?? []) {
      classifications.set(classification, (classifications.get(classification) ?? 0) + 1);
    }
  }
  const rows = [...classifications.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `| ${name} | ${count} |`)
    .join('\n');
  const controls = report.sidecarControlEvaluation;
  const structureByteLoads = report.sidecarProbes.filter(hasLoadedStructureBytes).length;
  const failures = controls?.failures
    ?.map(
      (failure) =>
        `| ${failure.control} | ${failure.reason} | ${failure.expected ?? ''} | ${
          failure.actual ?? ''
        } | ${failure.label ?? ''} |`
    )
    .join('\n');

  return `## Sidecar Probes

Probed features: ${report.sidecarProbes.length}
AlphaFold structure-byte loads: ${structureByteLoads}

| Classification | Count |
| --- | ---: |
${rows || '| none | 0 |'}

${
  controls
    ? `## Sidecar Control Evaluation

Status: ${controls.ok ? 'pass' : 'fail'}

| Control | Reason | Expected | Actual | Label |
| --- | --- | --- | --- | --- |
${failures || '| none | | | | |'}
`
    : ''
}
`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const files = opts.files.length ? opts.files : defaultFiles(opts.includeWpAssets);
  mkdirSync(opts.outDir, { recursive: true });
  const rawDir = path.join(opts.outDir, 'raw');
  mkdirSync(rawDir, { recursive: true });

  const reports = [];
  const parseFailures = [];
  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf8');
      reports.push(
        collectStructureCorpusFromGenBank(content, {
          sourcePath: path.relative(REPO_ROOT, file),
        })
      );
    } catch (err) {
      parseFailures.push({
        sourcePath: path.relative(REPO_ROOT, file),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const features = reports.flatMap((report) => report.features.map(compactFeature));
  const output = {
    summary: mergeSummary(reports, parseFailures),
    parseFailures,
    sourceFiles: files.map((file) => path.relative(REPO_ROOT, file)),
    features,
  };

  if (opts.probeSidecar) {
    const probeInputs = reports
      .flatMap((report) => report.features)
      .filter((feature) => feature.derivation)
      .filter((feature) => (opts.match ? opts.match.test(feature.label) : true));
    output.sidecarProbes = [];
    const maxProbes = Number.isFinite(opts.limit) ? opts.limit : probeInputs.length;
    let structureLoadSuccesses = 0;
    for (const feature of probeInputs) {
      if (output.sidecarProbes.length >= maxProbes) break;
      const probe = classifyProbe(await probeFeature(feature, opts, rawDir));
      output.sidecarProbes.push(probe);
      if (hasLoadedStructureBytes(probe)) structureLoadSuccesses += 1;
      if (opts.successTarget !== null && structureLoadSuccesses >= opts.successTarget) break;
    }
    if (opts.successTarget !== null && structureLoadSuccesses < opts.successTarget) {
      console.error(
        `Structure corpus probe only loaded ${structureLoadSuccesses}/${opts.successTarget} requested structures`
      );
      process.exitCode = 1;
    }
    if (opts.requireMg1655Controls) {
      output.sidecarControlEvaluation = evaluateStructureCorpusProbeControls(
        output.sidecarProbes,
        MG1655_STRUCTURE_PROBE_CONTROLS
      );
    }
    if (opts.requireAllProbedStructures) {
      const failures = output.sidecarProbes.filter((probe) => {
        const classifications = probe.classifications ?? classifyStructureCorpusSidecarProbe(probe);
        return (
          classifications.includes('provider_error') ||
          classifications.includes('no_external_match') ||
          classifications.includes('no_alphafold_prediction') ||
          classifications.includes('structure_bytes_failed') ||
          (opts.probeStructureBytes && !classifications.includes('structure_bytes_loaded'))
        );
      });
      if (failures.length > 0) {
        console.error(
          `Structure corpus probe failed for ${failures.length}/${output.sidecarProbes.length} features`
        );
        for (const failure of failures.slice(0, 20)) {
          console.error(
            `- ${failure.label}: ${failure.classifications?.join(',')}; accession=${failure.topAccession}; bytes=${failure.structureBytesStatus}`
          );
        }
        process.exitCode = 1;
      }
    }
  }

  writeFileSync(path.join(opts.outDir, 'structure-corpus.json'), JSON.stringify(output, null, 2));
  writeFileSync(path.join(opts.outDir, 'structure-corpus.md'), renderMarkdown(output));
  console.log(`Wrote ${path.join(opts.outDir, 'structure-corpus.md')}`);
  console.log(
    `Parsed ${output.summary.parsedFileCount} files, ${output.summary.cdsCount} CDS, ` +
      `${output.summary.initiatorNormalizedCount} initiator-normalized proteins`
  );
  if (opts.requireMg1655Controls && !output.sidecarControlEvaluation?.ok) {
    console.error(
      `MG1655 sidecar controls failed: ${output.sidecarControlEvaluation.failures
        .map((failure) => `${failure.control}:${failure.reason}`)
        .join(', ')}`
    );
    process.exit(1);
  }
  if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
