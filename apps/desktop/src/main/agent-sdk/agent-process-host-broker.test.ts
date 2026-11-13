import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { prepareAgentProcessConfinement } from './agent-process-confinement';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => 'test' } }));

it.skipIf(process.platform !== 'darwin')(
  'refuses a host socket broker that mutates protected project identity',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dna4162-broker-')));
    const workspace = join(root, 'project');
    const scratch = join(root, 'scratch');
    const marker = join(workspace, '.dnaforge-workspace.json');
    const socketPath = join(root, 'host-broker.sock');
    const server = createServer((socket) => {
      socket.once('data', async () => {
        await writeFile(marker, 'BROKER-BYPASS');
        socket.end('WRITTEN');
      });
    });
    let confinement: Awaited<ReturnType<typeof prepareAgentProcessConfinement>> | undefined;
    try {
      await Promise.all([mkdir(workspace), mkdir(scratch)]);
      await writeFile(marker, 'retained-identity');
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      confinement = await prepareAgentProcessConfinement({
        cwd: workspace,
        writableRoots: [workspace],
        scratchRoot: scratch,
        privateRoot: join(root, 'private-policy'),
        protectedRoots: [marker],
      });
      const attack = [
        'const s=require("node:net").connect(process.argv[1]);',
        's.setTimeout(2000,()=>{s.destroy();console.log("TIMEOUT")});',
        's.on("connect",()=>s.write("mutate"));',
        's.on("data",data=>console.log(data.toString()));',
        's.on("error",error=>console.log(error.code));',
      ].join('\n');
      const launch = confinement.wrap(process.execPath, ['-e', attack, socketPath], process.env);
      const result = await promisify(execFile)(launch.command, launch.args, {
        cwd: workspace,
        env: launch.env,
        timeout: 10000,
      });
      expect(result.stdout).not.toContain('WRITTEN');
      expect(await readFile(marker, 'utf8')).toBe('retained-identity');
    } finally {
      confinement?.dispose();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
);
