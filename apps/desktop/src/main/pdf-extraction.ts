import { app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { arch, platform } from 'node:process';
import { extname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import openDataLoaderRuntimeManifest from '../../resources/opendataloader-runtime.json';
import { handleGroup } from '../shared/ipc-contract';
import { pdfContract } from '../shared/ipc/pdf.contract';
import {
  type PdfPointBoundingBox,
  type StructuredPdfElement,
  type StructuredPdfElementKind,
  type StructuredPdfExtractionRequest,
  type StructuredPdfExtractionResult,
  type StructuredPdfParserIdentity,
} from '../shared/pdf-extraction';
import { HARD_CAP_BYTES, OversizedFileError } from '../shared/oversized-guard';
import { assertSafePath } from './ipc/path-allowlist';

const execFileAsync = promisify(execFile);
const MAX_PARSER_JSON_BYTES = 64 * 1024 * 1024;
const PARSER_TIMEOUT_MS = 60_000;

export const OPEN_DATA_LOADER_PARSER_IDENTITY: StructuredPdfParserIdentity = Object.freeze({
  name: openDataLoaderRuntimeManifest.parser.name,
  version: openDataLoaderRuntimeManifest.parser.version,
  mode: openDataLoaderRuntimeManifest.parser.mode,
  configuration: openDataLoaderRuntimeManifest.parser.configuration,
});

const OPEN_DATA_LOADER_CONTRACT_MARKER = openDataLoaderRuntimeManifest.parser.contractMarker;

type JsonRecord = Record<string, unknown>;
type ParserExecutionOptions = Readonly<{
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
}>;
type ParserExecutor = (
  executable: string,
  arguments_: readonly string[],
  options: ParserExecutionOptions
) => Promise<unknown>;

export type OpenDataLoaderRuntime = Readonly<{ javaPath: string; jarPath: string }>;

export type StructuredPdfExtractionProvider = Readonly<{
  identity: StructuredPdfParserIdentity;
  extract: (request: StructuredPdfExtractionRequest) => Promise<StructuredPdfExtractionResult>;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredInteger(record: JsonRecord, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`OpenDataLoader output has an invalid ${key}.`);
  }
  return value as number;
}

function boundingBox(record: JsonRecord): PdfPointBoundingBox {
  const value = record['bounding box'];
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  ) {
    throw new Error('OpenDataLoader output has an invalid bounding box.');
  }
  const [left, bottom, right, top] = value;
  if (left < 0 || bottom < 0 || right < left || top < bottom) {
    throw new Error('OpenDataLoader output has a reversed or negative bounding box.');
  }
  return [left, bottom, right, top];
}

function childRecords(record: JsonRecord, key: string): JsonRecord[] {
  const value = record[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`OpenDataLoader output has an invalid ${key} collection.`);
  }
  return value;
}

function descendantText(record: JsonRecord): string {
  const own = record.content;
  if (typeof own === 'string' && own.trim()) return own.trim();
  return ['kids', 'list items', 'rows', 'cells']
    .flatMap((key) => childRecords(record, key))
    .map(descendantText)
    .filter(Boolean)
    .join(' ');
}

function tableText(record: JsonRecord): string {
  const rows = childRecords(record, 'rows');
  if (rows.length === 0) return descendantText(record);
  const rendered = rows.map((row) =>
    childRecords(row, 'cells')
      .map((cell) => descendantText(cell).replace(/\|/gu, '\\|'))
      .join(' | ')
  );
  return rendered.join('\n');
}

function textKind(type: unknown): StructuredPdfElementKind | null {
  if (type === 'heading' || type === 'paragraph' || type === 'caption') return type;
  if (type === 'list item') return 'list-item';
  if (type === 'table') return 'table';
  return null;
}

type PendingElement = Omit<StructuredPdfElement, 'blockId'>;

function collectElements(record: JsonRecord, output: PendingElement[]): void {
  const kind = textKind(record.type);
  if (kind) {
    const text = (kind === 'table' ? tableText(record) : descendantText(record)).trim();
    if (text) {
      output.push({
        page: requiredInteger(record, 'page number'),
        kind,
        text,
        boundingBox: boundingBox(record),
      });
    }
    return;
  }
  for (const key of ['kids', 'list items']) {
    for (const child of childRecords(record, key)) collectElements(child, output);
  }
}

function normalizedRequestedPages(
  pages: number[],
  pageCount: number,
  clampTrailingPages: boolean
): number[] {
  const requested = [...new Set(pages)].sort((left, right) => left - right);
  const integers = requested.every((page) => Number.isSafeInteger(page) && page >= 1);
  const valid = requested.filter((page) => page <= pageCount);
  if (
    requested.length === 0 ||
    !integers ||
    valid.length === 0 ||
    (!clampTrailingPages && valid.length !== requested.length)
  ) {
    throw new Error(`Requested PDF pages must be between 1 and ${pageCount}.`);
  }
  return valid;
}

export function parseOpenDataLoaderJson(
  value: unknown,
  request: Pick<StructuredPdfExtractionRequest, 'pages' | 'maxCharacters' | 'clampTrailingPages'>
): StructuredPdfExtractionResult {
  if (!isRecord(value)) throw new Error('OpenDataLoader output root must be an object.');
  const pageCount = requiredInteger(value, 'number of pages');
  if (!Number.isSafeInteger(request.maxCharacters) || request.maxCharacters < 1) {
    throw new Error('PDF extraction maxCharacters must be a positive integer.');
  }
  const requestedPages = normalizedRequestedPages(
    request.pages,
    pageCount,
    request.clampTrailingPages === true
  );
  const requested = new Set(requestedPages);
  const pending: PendingElement[] = [];
  for (const child of childRecords(value, 'kids')) collectElements(child, pending);

  const pageOrdinals = new Map<number, number>();
  const admitted = new Map<number, StructuredPdfElement[]>();
  let remaining = request.maxCharacters;
  let truncated = false;
  for (const element of pending) {
    if (!requested.has(element.page)) continue;
    if (element.text.length > remaining) {
      truncated = true;
      break;
    }
    remaining -= element.text.length;
    const ordinal = (pageOrdinals.get(element.page) ?? 0) + 1;
    pageOrdinals.set(element.page, ordinal);
    const block: StructuredPdfElement = {
      ...element,
      blockId: `p${element.page}-b${ordinal}`,
    };
    admitted.set(element.page, [...(admitted.get(element.page) ?? []), block]);
  }

  return {
    parser: {
      ...OPEN_DATA_LOADER_PARSER_IDENTITY,
    },
    pageCount,
    pages: requestedPages.map((page) => ({ page, elements: admitted.get(page) ?? [] })),
    truncated,
  };
}

function targetKey(): string {
  const runtimePlatform = platform;
  const runtimeArch = arch;
  if (!['darwin', 'linux', 'win32'].includes(runtimePlatform)) {
    throw new Error(`OpenDataLoader is not packaged for platform ${runtimePlatform}.`);
  }
  if (!['arm64', 'x64'].includes(runtimeArch)) {
    throw new Error(`OpenDataLoader is not packaged for architecture ${runtimeArch}.`);
  }
  return `${runtimePlatform}-${runtimeArch}`;
}

export function developmentResourcesRoot(appPath: string): string {
  let candidate = appPath;
  for (let depth = 0; depth < 5; depth += 1) {
    const resources = join(candidate, 'resources');
    if (existsSync(join(resources, 'opendataloader-runtime.json'))) return resources;
    const parent = join(candidate, '..');
    if (parent === candidate) break;
    candidate = parent;
  }
  return join(appPath, 'resources');
}

export function resolveOpenDataLoaderRuntime(options?: {
  resourcesPath?: string;
  appPath?: string;
  environment?: NodeJS.ProcessEnv;
}): OpenDataLoaderRuntime {
  const environment = options?.environment ?? process.env;
  if (
    Boolean(environment.DNAFORGE_OPENDATALOADER_JAVA) !==
    Boolean(environment.DNAFORGE_OPENDATALOADER_JAR)
  ) {
    throw new Error(
      'OpenDataLoader development overrides require both a Java executable and a parser JAR.'
    );
  }
  if (environment.DNAFORGE_OPENDATALOADER_JAVA && environment.DNAFORGE_OPENDATALOADER_JAR) {
    return {
      javaPath: environment.DNAFORGE_OPENDATALOADER_JAVA,
      jarPath: environment.DNAFORGE_OPENDATALOADER_JAR,
    };
  }
  const resourcesRoot = app.isPackaged
    ? (options?.resourcesPath ?? process.resourcesPath)
    : options?.appPath
      ? join(options.appPath, 'resources')
      : developmentResourcesRoot(app.getAppPath());
  const root = join(resourcesRoot, 'binaries', 'opendataloader-pdf', targetKey());
  return {
    javaPath: join(root, 'runtime', 'bin', platform === 'win32' ? 'java.exe' : 'java'),
    jarPath: join(root, 'opendataloader-pdf-cli.jar'),
  };
}

async function assertRuntime(runtime: OpenDataLoaderRuntime): Promise<void> {
  try {
    await Promise.all([access(runtime.javaPath), access(runtime.jarPath)]);
  } catch {
    throw new Error(
      'DNAForge PDF parser runtime is missing. Reinstall DNAForge or run the parser runtime preparation step.'
    );
  }
}

function pageArgument(pages: number[]): string {
  return [...new Set(pages)].sort((left, right) => left - right).join(',');
}

function validateRequest(request: StructuredPdfExtractionRequest): void {
  if (
    request.pages.length === 0 ||
    !request.pages.every((page) => Number.isSafeInteger(page) && page >= 1)
  ) {
    throw new Error('Requested PDF pages must be positive integers.');
  }
  if (!Number.isSafeInteger(request.maxCharacters) || request.maxCharacters < 1) {
    throw new Error('PDF extraction maxCharacters must be a positive integer.');
  }
}

const executeParser: ParserExecutor = async (executable, arguments_, options) => {
  await execFileAsync(executable, [...arguments_], options);
};

function parserTimedOut(error: unknown): boolean {
  if (error instanceof Error && /timed out|ETIMEDOUT|SIGTERM/iu.test(error.message)) return true;
  if (!isRecord(error)) return false;
  return error.killed === true || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT';
}

export async function extractPdfWithOpenDataLoader(
  request: StructuredPdfExtractionRequest,
  options?: {
    runtime?: OpenDataLoaderRuntime;
    timeoutMs?: number;
    executeParser?: ParserExecutor;
  }
): Promise<StructuredPdfExtractionResult> {
  validateRequest(request);
  if (!isAbsolute(request.path) || extname(request.path).toLowerCase() !== '.pdf') {
    throw new Error('OpenDataLoader requires an absolute PDF path.');
  }
  const sourcePath = await assertSafePath(request.path, {
    requireAbsolute: true,
    errorPrefix: 'pdf:extractStructured',
  });
  if (extname(sourcePath).toLowerCase() !== '.pdf') {
    throw new Error('OpenDataLoader source must resolve to a PDF file.');
  }
  const source = await stat(sourcePath);
  if (!source.isFile()) throw new Error('OpenDataLoader source must be a regular PDF file.');
  if (source.size > HARD_CAP_BYTES) throw new OversizedFileError(source.size, request.path, true);

  const runtime = options?.runtime ?? resolveOpenDataLoaderRuntime();
  await assertRuntime(runtime);
  const outputDirectory = await mkdtemp(join(tmpdir(), 'dnaforge-opendataloader-'));
  try {
    await (options?.executeParser ?? executeParser)(
      runtime.javaPath,
      [
        '-Xms64m',
        '-Xmx1024m',
        '-XX:+ExitOnOutOfMemoryError',
        '-Djava.awt.headless=true',
        '-Dapple.awt.UIElement=true',
        '-jar',
        runtime.jarPath,
        sourcePath,
        '--output-dir',
        outputDirectory,
        '--format',
        'json',
        '--image-output',
        'off',
        '--reading-order',
        'xycut',
        '--table-method',
        'cluster',
        '--threads',
        '1',
        '--pages',
        pageArgument(request.pages),
        '--quiet',
      ],
      {
        timeout: options?.timeoutMs ?? PARSER_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }
    );
    const jsonFiles = (await readdir(outputDirectory)).filter((name) => name.endsWith('.json'));
    if (jsonFiles.length !== 1) {
      throw new Error(`OpenDataLoader produced ${jsonFiles.length} JSON documents; expected one.`);
    }
    const outputPath = join(outputDirectory, jsonFiles[0]);
    const outputStat = await stat(outputPath);
    if (outputStat.size > MAX_PARSER_JSON_BYTES) {
      throw new Error('OpenDataLoader JSON output exceeds the safe 64 MiB limit.');
    }
    const parsed = JSON.parse(await readFile(outputPath, 'utf8')) as unknown;
    return parseOpenDataLoaderJson(parsed, request);
  } catch (error) {
    if (parserTimedOut(error)) {
      throw new Error('OpenDataLoader PDF extraction timed out.');
    }
    throw error;
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

export const openDataLoaderPdfExtractionProvider: StructuredPdfExtractionProvider = Object.freeze({
  identity: OPEN_DATA_LOADER_PARSER_IDENTITY,
  extract: extractPdfWithOpenDataLoader,
});

function parserIdentitiesMatch(
  left: StructuredPdfParserIdentity,
  right: StructuredPdfParserIdentity
): boolean {
  return (
    left.name === right.name &&
    left.version === right.version &&
    left.mode === right.mode &&
    left.configuration === right.configuration
  );
}

export async function extractStructuredPdf(
  request: StructuredPdfExtractionRequest,
  options?: { provider?: StructuredPdfExtractionProvider }
): Promise<StructuredPdfExtractionResult> {
  const provider = options?.provider ?? openDataLoaderPdfExtractionProvider;
  const result = await provider.extract(request);
  if (!parserIdentitiesMatch(result.parser, provider.identity)) {
    throw new Error(
      `Structured PDF provider returned mismatched parser provenance. ${OPEN_DATA_LOADER_CONTRACT_MARKER}`
    );
  }
  return result;
}

export function registerPdfExtractionHandlers(): void {
  handleGroup(pdfContract, {
    extractStructured: async (_event, request) => extractStructuredPdf(request),
  });
}
