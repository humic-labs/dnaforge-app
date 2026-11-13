import { execFileSync } from 'child_process';

export const GENOME_RUNTIME_CAPABILITY = 'genome.pysam-htslib.v1' as const;

type ExecFile = typeof execFileSync;

interface GenomeRuntimeReceipt {
  readonly schema: 'dnaforge.genome-runtime-capability.v1';
  readonly capability: typeof GENOME_RUNTIME_CAPABILITY;
  readonly pysamVersion: string;
  readonly coverageEngineIdentity: string;
}

interface GenomeRuntimeUnavailableReceipt {
  readonly schema: 'dnaforge.genome-runtime-unavailable.v1';
  readonly capability: typeof GENOME_RUNTIME_CAPABILITY;
  readonly reason: 'unsupported-on-target';
  readonly target: string;
}

export type PackagedGenomeRuntimeReceipt = GenomeRuntimeReceipt | GenomeRuntimeUnavailableReceipt;

interface GenomeRuntimeProbeOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

interface GenomeRuntimeRequirementInput {
  readonly isPackaged: boolean;
  readonly platform?: NodeJS.Platform;
  readonly nodeEnv?: string;
  readonly waypointTest?: string;
  readonly allowIncompleteE2eRuntime?: string;
  readonly packagedRuntimeReceipt?: PackagedGenomeRuntimeReceipt;
}

const COVERAGE_ENGINE_IDENTITY = /^dna-coverage:schema-[1-9][0-9]*:sha256-[0-9a-f]{64}$/;

export function shouldRequireGenomeRuntime(input: GenomeRuntimeRequirementInput): boolean {
  if (!input.isPackaged && input.platform === 'win32') return false;
  if (
    input.isPackaged &&
    input.packagedRuntimeReceipt?.schema === 'dnaforge.genome-runtime-unavailable.v1'
  ) {
    return false;
  }
  const explicitE2eHarness =
    !input.isPackaged && (input.nodeEnv === 'test' || input.waypointTest === '1');
  return !(explicitE2eHarness && input.allowIncompleteE2eRuntime === '1');
}

function isGenomeRuntimeReceipt(receipt: unknown): receipt is GenomeRuntimeReceipt {
  if (typeof receipt !== 'object' || receipt === null) return false;
  const candidate = receipt as Record<string, unknown>;
  return (
    candidate.schema === 'dnaforge.genome-runtime-capability.v1' &&
    candidate.capability === GENOME_RUNTIME_CAPABILITY &&
    typeof candidate.pysamVersion === 'string' &&
    Boolean(candidate.pysamVersion.trim()) &&
    typeof candidate.coverageEngineIdentity === 'string' &&
    COVERAGE_ENGINE_IDENTITY.test(candidate.coverageEngineIdentity)
  );
}

function isGenomeRuntimeUnavailableReceipt(
  receipt: unknown
): receipt is GenomeRuntimeUnavailableReceipt {
  if (typeof receipt !== 'object' || receipt === null) return false;
  const candidate = receipt as Record<string, unknown>;
  return (
    candidate.schema === 'dnaforge.genome-runtime-unavailable.v1' &&
    candidate.capability === GENOME_RUNTIME_CAPABILITY &&
    candidate.reason === 'unsupported-on-target' &&
    typeof candidate.target === 'string' &&
    Boolean(candidate.target.trim())
  );
}

function failureText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = (error as Error & { stderr?: Buffer | string }).stderr;
  const detail = stderr ? String(stderr).trim() : error.message;
  return detail || error.message;
}

export function assertDevGenomeRuntime(
  python: string,
  options: GenomeRuntimeProbeOptions = {},
  execFile: ExecFile = execFileSync
): GenomeRuntimeReceipt {
  try {
    const stdout = execFile(
      python,
      [
        '-B',
        '-c',
        'import json; from src.runtime_capabilities import genome_runtime_receipt; print(json.dumps(genome_runtime_receipt()))',
      ],
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env, PYTHONDONTWRITEBYTECODE: '1' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      }
    );
    const receipt = JSON.parse(stdout) as Partial<GenomeRuntimeReceipt>;
    if (
      receipt.schema !== 'dnaforge.genome-runtime-capability.v1' ||
      receipt.capability !== GENOME_RUNTIME_CAPABILITY ||
      typeof receipt.pysamVersion !== 'string' ||
      !receipt.pysamVersion.trim() ||
      typeof receipt.coverageEngineIdentity !== 'string' ||
      !COVERAGE_ENGINE_IDENTITY.test(receipt.coverageEngineIdentity)
    ) {
      throw new Error(`invalid capability receipt: ${stdout.trim()}`);
    }
    return receipt as GenomeRuntimeReceipt;
  } catch (error) {
    throw new Error(
      `[Sidecar] Required BAM/CRAM runtime is unavailable in the exact Python environment ` +
        `selected for this app:\n  ${python}\n` +
        `DNAForge will not start with a sidecar that cannot render BAM/CRAM tracks.\n` +
        `Set up the sidecar and its helpers from the repository root, then relaunch:\n` +
        `  (cd apps/api && uv sync --frozen --extra dev)\n` +
        `  pnpm --dir apps/desktop helpers:build\n` +
        `Underlying capability failure: ${failureText(error)}`
    );
  }
}

export function assertPackagedGenomeRuntime(
  executable: string,
  options: GenomeRuntimeProbeOptions = {},
  execFile: ExecFile = execFileSync
): PackagedGenomeRuntimeReceipt {
  try {
    const stdout = execFile(executable, ['--verify-genome-runtime'], {
      env: { ...process.env, ...options.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
    const receipt: unknown = JSON.parse(stdout);
    if (!isGenomeRuntimeReceipt(receipt) && !isGenomeRuntimeUnavailableReceipt(receipt)) {
      throw new Error(`invalid capability receipt: ${stdout.trim()}`);
    }
    return receipt;
  } catch (error) {
    throw new Error(
      `[Sidecar] This DNAForge build does not contain a working BAM/CRAM runtime. ` +
        `The app will not open because BAM/CRAM tracks would be unreliable.\n` +
        `Reinstall a complete DNAForge build.\n` +
        `Sidecar: ${executable}\n` +
        `Underlying capability failure: ${failureText(error)}`
    );
  }
}
