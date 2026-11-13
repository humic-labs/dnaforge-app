// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { externalMcpClientEnvironment, repairNativeMcpConfig } from './external-mcp-config-files';
import { bindExternalAccessObservationSink } from './external-access-observation';
import {
  EXTERNAL_ACCESS_PROPERTY_KEYS,
  type ExternalAccessObservation,
} from '../shared/external-access-telemetry';
import { describe, expect, it } from 'vitest';
import {
  externalMcpRegistrationSnapshot,
  registerExternalMcpClients,
  refreshExternalMcpRegistration,
  runExternalMcpClientCommand,
} from './external-mcp-registration';

describe.runIf(process.env.DNAFORGE_NATIVE_MCP_PROOF === '1')(
  'installed vendor CLI configuration',
  () => {
    it.each(['claude', 'codex', 'grok'] as const)(
      '%s reads the automatic registration from its own user config',
      async (provider) => {
        const executable = execFileSync('/usr/bin/which', ['-a', provider], { encoding: 'utf8' })
          .trim()
          .split(/\r?\n/u)
          .find((path) => !path.includes('/node_modules/'));
        expect(executable, `${provider} must be installed for the native proof`).toBeTruthy();
        const home = await mkdtemp(join(tmpdir(), `dnaforge-native-${provider}-`));
        const observations: ExternalAccessObservation[] = [];
        const startedAt = Date.now();
        try {
          bindExternalAccessObservationSink((observation) => {
            observations.push(observation);
            return true;
          });
          for (const name of ['.claude', '.codex', '.grok']) await mkdir(join(home, name));
          await writeFile(
            join(home, '.grok', 'config.toml'),
            '[compat.claude]\nmcps = false\n[compat.cursor]\nmcps = false\n'
          );
          const environment = {
            ...process.env,
            WAYPOINT_TEST: '1',
            DNAFORGE_EXTERNAL_MCP_CONFIG_HOME: home,
          };
          const commands: { args: readonly string[]; ok: boolean; stdout: string }[] = [];
          const run = async (
            client: 'claude' | 'codex' | 'grok',
            path: string,
            args: readonly string[]
          ) => {
            const result = await runExternalMcpClientCommand(client, path, args, environment, home);
            commands.push({ args, ...result });
            return result;
          };
          const missing = async () => ({ cli: 'missing' as const, path: null });
          const installed = async () => ({ cli: 'installed' as const, path: executable! });
          const resourcesPath = join(home, 'DNAForge.app', 'Contents', 'Resources');
          const launcher = join(resourcesPath, 'cli', 'dnaforge');
          const options = {
            isPackaged: true,
            resourcesPath,
            run,
            registerDesktopClients: async () => [],
            repairCliConfig: (client, oldPath, newPath) =>
              repairNativeMcpConfig(client, oldPath, newPath, environment),
            detectClaudeCode: provider === 'claude' ? installed : missing,
            detectCodex: provider === 'codex' ? installed : missing,
            detectGrok: provider === 'grok' ? installed : missing,
          } satisfies Parameters<typeof registerExternalMcpClients>[0];
          const unrelated = await run(provider, executable!, [
            'mcp',
            'add',
            ...(provider === 'codex' ? [] : ['--scope', 'user']),
            'unrelated',
            '--',
            '/bin/echo',
            'example',
          ]);
          expect(unrelated.ok, unrelated.stdout).toBe(true);
          const results = await registerExternalMcpClients(options);
          const label = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok Build' }[provider];
          expect(
            results.find(({ client }) => client === label),
            JSON.stringify(commands)
          ).toEqual({
            client: label,
            status: 'registered',
          });
          const inspection = execFileSync(
            executable!,
            provider === 'grok'
              ? ['mcp', 'list', '--json']
              : ['mcp', 'get', 'dnaforge', ...(provider === 'codex' ? ['--json'] : [])],
            {
              env: externalMcpClientEnvironment(environment),
              cwd: home,
              encoding: 'utf8',
              timeout: 15_000,
              stdio: ['ignore', 'pipe', 'pipe'],
            }
          );
          expect(inspection).toContain(launcher);
          const repeated = await registerExternalMcpClients(options);
          expect(repeated.find(({ client }) => client === label)?.status).toBe('current');
          if (provider !== 'claude') {
            const path = join(home, `.${provider}`, 'config.toml');
            const previous = launcher.replace('DNAForge.app', 'DNAForge Old.app');
            const original = await readFile(path, 'utf8');
            const customized = original
              .replace(/^enabled = .*$/gmu, '')
              .replace(JSON.stringify(launcher), JSON.stringify(previous))
              .replace(
                'args = ["mcp"]',
                'args = ["mcp", "--workspace", "/tmp/project"]\nstartup_timeout_sec = 90\nenabled = false\nenv = { EXAMPLE = "preserved" }'
              );
            await writeFile(path, customized);
            const readable = await run(
              provider,
              executable!,
              provider === 'grok' ? ['mcp', 'list', '--json'] : ['mcp', 'get', 'dnaforge', '--json']
            );
            expect(readable.ok, readable.stdout).toBe(true);
            const repaired = await registerExternalMcpClients(options);
            expect(repaired.find(({ client }) => client === label)?.status).toBe('repaired');
            expect(await readFile(path, 'utf8')).toBe(
              customized.replace(JSON.stringify(previous), JSON.stringify(launcher))
            );
          } else {
            const path = join(home, '.claude', '.claude.json');
            const previous = launcher.replace('DNAForge.app', 'DNAForge Old.app');
            const original = JSON.parse(await readFile(path, 'utf8')) as {
              mcpServers: Record<string, Record<string, unknown>>;
            };
            const customized = {
              ...original,
              mcpServers: {
                ...original.mcpServers,
                dnaforge: {
                  ...original.mcpServers.dnaforge,
                  command: previous,
                  args: ['mcp', '--workspace', '/tmp/project'],
                  env: { EXAMPLE: 'preserved' },
                },
              },
            };
            await writeFile(path, `${JSON.stringify(customized, null, 2)}\n`);
            const readable = await run(provider, executable!, ['mcp', 'get', 'dnaforge']);
            expect(readable.ok, readable.stdout).toBe(true);
            const repaired = await registerExternalMcpClients(options);
            expect(repaired.find(({ client }) => client === label)?.status).toBe('repaired');
            expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
              ...customized,
              mcpServers: {
                ...customized.mcpServers,
                dnaforge: { ...customized.mcpServers.dnaforge, command: launcher },
              },
            });
          }
          const other = await run(
            provider,
            executable!,
            provider === 'grok'
              ? ['mcp', 'list', '--json']
              : ['mcp', 'get', 'unrelated', ...(provider === 'codex' ? ['--json'] : [])]
          );
          expect(other.ok, other.stdout).toBe(true);
          expect(other.stdout).toContain('/bin/echo');
          const observedClient = {
            claude: 'claude_code',
            codex: 'codex',
            grok: 'grok_build',
          }[provider];
          expect(
            observations
              .filter((observation) => observation.access_client === observedClient)
              .map((observation) => observation.access_result)
          ).toEqual(['registered', 'current', 'repaired']);
          expect(new Set(observations.map((observation) => observation.operation_id)).size).toBe(
            observations.length
          );
          for (const observation of observations) {
            expect(observation).toMatchObject({
              access_stage: 'registration',
              access_transport: 'configuration',
              access_authority: 'native_configuration',
              access_scope_class: 'not_observed',
              access_expiry_class: 'not_observed',
              access_execution: 'not_observed',
              access_usefulness: 'not_attested',
            });
            expect(observation.occurred_at_ms).toBeGreaterThanOrEqual(startedAt);
            expect(observation.occurred_at_ms).toBeLessThanOrEqual(Date.now());
          }
          const wire = JSON.stringify(observations);
          for (const privateValue of [home, launcher, executable!, '/tmp/project', 'EXAMPLE']) {
            expect(wire).not.toContain(privateValue);
          }
        } finally {
          bindExternalAccessObservationSink(null);
          await rm(home, { recursive: true, force: true });
        }
      },
      60_000
    );

    it.each(['claude', 'codex', 'grok'] as const)(
      '%s preserves unknown configuration and settles one explicit recovery after a missing CLI',
      async (provider) => {
        const executable = execFileSync('/usr/bin/which', ['-a', provider], { encoding: 'utf8' })
          .trim()
          .split(/\r?\n/u)
          .find((path) => !path.includes('/node_modules/'));
        expect(executable, `${provider} must be installed for the native proof`).toBeTruthy();
        const home = await mkdtemp(join(tmpdir(), `dnaforge-native-recovery-${provider}-`));
        const observations: ExternalAccessObservation[] = [];
        const commands: string[][] = [];
        const startedAt = Date.now();
        let releaseInspection!: () => void;
        let inspectionStarted!: () => void;
        const heldInspection = new Promise<void>((resolve) => {
          releaseInspection = resolve;
        });
        const started = new Promise<void>((resolve) => {
          inspectionStarted = resolve;
        });
        let holdInspection = false;
        let available = true;
        let recovery: ReturnType<typeof refreshExternalMcpRegistration> | null = null;
        try {
          bindExternalAccessObservationSink((observation) => {
            observations.push(observation);
            return true;
          });
          for (const name of ['.claude', '.codex', '.grok']) await mkdir(join(home, name));
          const environment = {
            ...process.env,
            WAYPOINT_TEST: '1',
            DNAFORGE_EXTERNAL_MCP_CONFIG_HOME: home,
          };
          const config = join(
            home,
            `.${provider}`,
            provider === 'claude' ? '.claude.json' : 'config.toml'
          );
          const emptyConfig =
            provider === 'claude'
              ? '{"mcpServers":{}}\n'
              : provider === 'grok'
                ? '[compat.claude]\nmcps = false\n[compat.cursor]\nmcps = false\n'
                : '# F27_NONFUNCTIONAL_EMPTY_CONFIG\n';
          await writeFile(config, emptyConfig);
          const resourcesPath = join(home, 'DNAForge.app', 'Contents', 'Resources');
          const launcher = join(resourcesPath, 'cli', 'dnaforge');
          const run = async (
            client: 'claude' | 'codex' | 'grok',
            path: string,
            args: readonly string[]
          ) => {
            commands.push([...args]);
            if (holdInspection) {
              holdInspection = false;
              inspectionStarted();
              await heldInspection;
            }
            return runExternalMcpClientCommand(client, path, args, environment, home);
          };
          const missing = async () => ({ cli: 'missing' as const, path: null });
          const detected = async () =>
            available
              ? { cli: 'installed' as const, path: executable! }
              : { cli: 'missing' as const, path: null };
          const options = {
            isPackaged: true,
            resourcesPath,
            run,
            registerDesktopClients: async () => [],
            repairCliConfig: (client, oldPath, newPath) =>
              repairNativeMcpConfig(client, oldPath, newPath, environment),
            detectClaudeCode: provider === 'claude' ? detected : missing,
            detectCodex: provider === 'codex' ? detected : missing,
            detectGrok: provider === 'grok' ? detected : missing,
          } satisfies Parameters<typeof registerExternalMcpClients>[0];
          const label = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok Build' }[provider];
          const accessClient = { claude: 'claude_code', codex: 'codex', grok: 'grok_build' }[
            provider
          ];
          const outcomes = () =>
            observations
              .filter((observation) => observation.access_client === accessClient)
              .map((observation) => observation.access_result);
          const foreign = await run(provider, executable!, [
            'mcp',
            'add',
            ...(provider === 'codex' ? [] : ['--scope', 'user']),
            'dnaforge',
            '--',
            '/bin/echo',
            'F27_NONFUNCTIONAL_FOREIGN_SERVER',
          ]);
          expect(foreign.ok, foreign.stdout).toBe(true);
          const foreignBytes = await readFile(config, 'utf8');
          const beforeConflict = commands.length;
          expect(
            (await registerExternalMcpClients(options)).find((row) => row.client === label)?.status
          ).toBe('name-conflict');
          expect(await readFile(config, 'utf8')).toBe(foreignBytes);
          expect(commands.slice(beforeConflict)).toHaveLength(1);
          expect(
            commands
              .slice(beforeConflict)
              .every((args) => !args.includes('add') && !args.includes('remove'))
          ).toBe(true);
          const malformed =
            provider === 'claude' ? '{F27_NONFUNCTIONAL_BAD_CONFIG' : '[mcp_servers.\n';
          await writeFile(config, malformed);
          const beforeMalformed = commands.length;
          expect(
            (await registerExternalMcpClients(options)).find((row) => row.client === label)?.status
          ).toBe('failed');
          expect(await readFile(config, 'utf8')).toBe(malformed);
          expect(commands.slice(beforeMalformed)).toHaveLength(1);
          expect(
            commands
              .slice(beforeMalformed)
              .every((args) => !args.includes('add') && !args.includes('remove'))
          ).toBe(true);
          await rm(config);
          await mkdir(config);
          const beforeUnreadable = commands.length;
          expect(
            (await registerExternalMcpClients(options)).find((row) => row.client === label)?.status
          ).toBe('failed');
          expect((await lstat(config)).isDirectory()).toBe(true);
          expect(await readdir(config)).toEqual([]);
          expect(commands.slice(beforeUnreadable)).toHaveLength(1);
          expect(
            commands
              .slice(beforeUnreadable)
              .every((args) => !args.includes('add') && !args.includes('remove'))
          ).toBe(true);
          await rm(config, { recursive: true });
          await writeFile(config, emptyConfig);
          available = false;
          const beforeMissing = commands.length;
          const absent = await refreshExternalMcpRegistration(options);
          expect(absent.state).toBe('complete');
          expect(absent.clients.find((row) => row.client === label)?.status).toBe('not-installed');
          expect(externalMcpRegistrationSnapshot()).toBe(absent);
          expect(commands).toHaveLength(beforeMissing);
          expect(await readFile(config, 'utf8')).toBe(emptyConfig);
          expect(outcomes()).toEqual(['name_conflict', 'failed', 'failed', 'not_installed']);
          available = true;
          holdInspection = true;
          let settled = false;
          recovery = refreshExternalMcpRegistration(options);
          void recovery.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            }
          );
          await Promise.race([
            started,
            recovery.then(() => {
              throw new Error('Recovery completed before its native inspection was held');
            }),
          ]);
          const joined = refreshExternalMcpRegistration(options);
          expect(joined).toBe(recovery);
          expect(settled).toBe(false);
          const whilePending = externalMcpRegistrationSnapshot();
          expect(whilePending).toBe(absent);
          expect(whilePending.state).toBe('complete');
          expect(whilePending.clients.find((row) => row.client === label)?.status).toBe(
            'not-installed'
          );
          expect(await readFile(config, 'utf8')).toBe(emptyConfig);
          expect(outcomes()).toEqual(['name_conflict', 'failed', 'failed', 'not_installed']);
          releaseInspection();
          const recovered = await recovery;
          expect(await joined).toBe(recovered);
          expect(externalMcpRegistrationSnapshot()).toBe(recovered);
          expect(recovered.state).toBe('complete');
          expect(recovered.clients.find((row) => row.client === label)?.status).toBe('registered');
          expect(commands.slice(beforeMissing).filter((args) => args.includes('add'))).toHaveLength(
            1
          );
          const readback = await run(
            provider,
            executable!,
            provider === 'grok'
              ? ['mcp', 'list', '--json']
              : ['mcp', 'get', 'dnaforge', ...(provider === 'codex' ? ['--json'] : [])]
          );
          expect(readback.ok, readback.stdout).toBe(true);
          expect(readback.stdout).toContain(launcher);
          expect(outcomes()).toEqual([
            'name_conflict',
            'failed',
            'failed',
            'not_installed',
            'registered',
          ]);
          expect(observations).toHaveLength(15);
          expect(new Set(observations.map((row) => row.operation_id)).size).toBe(
            observations.length
          );
          for (const row of observations) {
            expect(Object.keys(row).sort()).toEqual([...EXTERNAL_ACCESS_PROPERTY_KEYS].sort());
            expect(row).toMatchObject({
              access_authority: 'native_configuration',
              access_stage: 'registration',
              access_transport: 'configuration',
              access_scope_class: 'not_observed',
              access_expiry_class: 'not_observed',
              access_execution: 'not_observed',
              access_usefulness: 'not_attested',
            });
            expect(row.occurred_at_ms).toBeGreaterThanOrEqual(startedAt);
            expect(row.occurred_at_ms).toBeLessThanOrEqual(Date.now());
          }
          const wire = JSON.stringify(observations);
          for (const value of [
            home,
            config,
            launcher,
            executable!,
            '/bin/echo',
            'F27_NONFUNCTIONAL_FOREIGN_SERVER',
            'F27_NONFUNCTIONAL_BAD_CONFIG',
          ])
            expect(wire).not.toContain(value);
        } finally {
          releaseInspection();
          await recovery?.catch(() => undefined);
          bindExternalAccessObservationSink(null);
          await rm(home, { recursive: true, force: true });
        }
      },
      60_000
    );
  }
);
