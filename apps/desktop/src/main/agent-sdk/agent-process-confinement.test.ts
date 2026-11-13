import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareAgentProcessConfinement } from './agent-process-confinement';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => 'test' } }));

const exec = promisify(execFile);
const retainedRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    retainedRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe.skipIf(process.platform !== 'darwin')('agent process project authority', () => {
  it.each(['default', 'bypassPermissions', ':danger-full-access'])(
    'confines native file writes, shell and child processes even with %s inner permissions',
    async (permissions) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'dna4162-agent-')));
      retainedRoots.push(root);
      const workspace = join(root, 'managed-workspaces', 'owner', 'repo');
      const scratch = join(root, 'scratch');
      const privateRoot = join(root, 'private-policy');
      const sibling = join(root, 'managed-workspaces', 'sibling', 'repo');
      const marker = join(workspace, '.dnaforge-workspace.json');
      const git = join(workspace, '.git');
      const config = join(git, 'config');
      const database = join(root, 'application.sqlite');
      const siblingFile = join(sibling, 'retained.txt');
      await Promise.all([
        mkdir(git, { recursive: true }),
        mkdir(scratch),
        mkdir(sibling, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(marker, 'retained-identity'),
        writeFile(config, 'retained-git'),
        writeFile(database, 'retained-database'),
        writeFile(siblingFile, 'retained-sibling'),
        symlink(marker, join(workspace, 'identity-alias')),
      ]);
      const confinement = await prepareAgentProcessConfinement({
        cwd: workspace,
        writableRoots: [workspace],
        scratchRoot: scratch,
        privateRoot,
        protectedRoots: [marker, git, database],
      });
      try {
        const childCode =
          'try { require("node:fs").writeFileSync(process.argv[1], "CHILD-BYPASS"); process.exit(2); } catch(e) { process.exit(["EPERM", "EACCES"].includes(e.code) ? 0 : 3); }';
        const shellCode = 'printf SHELL-BYPASS > "$DNA4162_MARKER"';
        const attack = [
          'const fs = require("node:fs");',
          'const cp = require("node:child_process");',
          'const path = require("node:path");',
          'const targets = JSON.parse(process.env.DNA4162_TARGETS);',
          'fs.writeFileSync("experiment.txt", "permitted-content");',
          'fs.writeFileSync(path.join(process.env.TMPDIR, "result.txt"), "permitted-scratch");',
          'const denied = targets.map(target => { try { fs.writeFileSync(target, "BYPASS"); return false; } catch (e) { return ["EPERM", "EACCES"].includes(e.code); } });',
          `const child = cp.spawnSync(process.execPath, ["-e", ${JSON.stringify(childCode)}, targets[0]], {encoding:"utf8"});`,
          `const shell = cp.spawnSync("/bin/sh", ["-c", ${JSON.stringify(shellCode)}], {encoding:"utf8"});`,
          'const operations = [() => fs.chmodSync(process.cwd(), 0o700), () => fs.renameSync(targets[0], targets[0]+".moved"), () => fs.linkSync(targets[0], "marker-hardlink"), () => fs.unlinkSync(targets[0]), () => fs.renameSync(path.dirname(targets[1]), path.join(process.cwd(), "moved-git"))];',
          'const structural = operations.map(operation => {try {operation(); return false;} catch(e) {return ["EPERM", "EACCES"].includes(e.code);}});',
          'console.log(JSON.stringify({denied, structural, child:child.status, shell:shell.status, home:process.env.CODEX_HOME, permissions:process.env.DNA4162_PERMISSIONS}));',
        ].join('\n');
        const env = {
          ...process.env,
          CODEX_HOME: join(root, 'provider-home'),
          TMPDIR: scratch,
          DNA4162_PERMISSIONS: permissions,
          DNA4162_MARKER: marker,
          DNA4162_TARGETS: JSON.stringify([
            marker,
            config,
            database,
            siblingFile,
            join(workspace, 'identity-alias'),
            join(root, 'managed-workspaces', 'forged-project'),
          ]),
        };
        const legacy =
          permissions === 'bypassPermissions'
            ? confinement.executable(process.execPath, env)
            : null;
        const launch = legacy
          ? { command: legacy.path, args: ['-e', attack], env: legacy.env }
          : confinement.wrap(process.execPath, ['-e', attack], env);
        const result = await exec(launch.command, launch.args, {
          cwd: workspace,
          env: launch.env,
          timeout: 10000,
        });
        expect(JSON.parse(result.stdout)).toEqual({
          denied: [true, true, true, true, true, true],
          structural: [true, true, true, true, true],
          child: 0,
          shell: expect.any(Number),
          home: join(root, 'provider-home'),
          permissions,
        });
        expect(JSON.parse(result.stdout).shell).not.toBe(0);
        expect(await readFile(join(workspace, 'experiment.txt'), 'utf8')).toBe('permitted-content');
        expect(await readFile(join(scratch, 'result.txt'), 'utf8')).toBe('permitted-scratch');
        expect(await readFile(marker, 'utf8')).toBe('retained-identity');
        expect(await readFile(config, 'utf8')).toBe('retained-git');
        expect(await readFile(database, 'utf8')).toBe('retained-database');
        expect(await readFile(siblingFile, 'utf8')).toBe('retained-sibling');
        if (permissions === 'default') {
          const child = confinement.spawn({
            command: 'node',
            args: ['-e', 'process.stdout.write("SDK_READY")'],
            cwd: workspace,
            env,
            signal: new AbortController().signal,
          });
          let stdout = '';
          child.stdout.on('data', (chunk) => {
            stdout += String(chunk);
          });
          await new Promise<void>((resolve, reject) => {
            child.on('error', reject);
            child.on('close', (code) =>
              code === 0 ? resolve() : reject(new Error(`SDK callback exited ${code}`))
            );
          });
          expect(stdout).toBe('SDK_READY');
        }
      } finally {
        confinement.dispose();
      }
    }
  );
});

it('refuses an unqualified platform or unavailable verified sandbox before launching a process', async () => {
  const input = {
    cwd: tmpdir(),
    scratchRoot: join(tmpdir(), 'dna4162-unavailable-scratch'),
    privateRoot: join(tmpdir(), 'dna4162-policy'),
    protectedRoots: [],
    resolveExecutable: async () => {
      throw new Error('verified sandbox unavailable');
    },
  };
  await expect(prepareAgentProcessConfinement({ ...input, platform: 'win32' })).rejects.toThrow();
  await expect(prepareAgentProcessConfinement({ ...input, platform: 'darwin' })).rejects.toThrow(
    'verified sandbox unavailable'
  );
});
