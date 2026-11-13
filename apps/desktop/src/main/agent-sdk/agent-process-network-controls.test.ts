import { execFile } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { prepareAgentProcessConfinement } from './agent-process-confinement';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => 'test' } }));

it.skipIf(process.platform !== 'darwin').each(['tcp', 'private', 'symlink', 'hardlink'] as const)(
  'preserves permitted networking without admitting a host broker through %s',
  async (kind) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dna4162-net-')));
    const workspace = join(root, 'project');
    const scratch = join(root, 'scratch');
    const marker = join(workspace, '.dnaforge-workspace.json');
    const socketPath = join(root, 'host.sock');
    const alias = join(scratch, 'alias.sock');
    const server = createServer((socket) => {
      socket.once('data', async () => {
        if (kind === 'tcp') socket.end('TCP_READY');
        else {
          await writeFile(marker, 'BROKER-BYPASS');
          socket.end('WRITTEN');
        }
      });
    });
    let confinement: Awaited<ReturnType<typeof prepareAgentProcessConfinement>> | undefined;
    try {
      await Promise.all([mkdir(workspace), mkdir(scratch)]);
      await writeFile(marker, 'retained-identity');
      if (kind !== 'private')
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          if (kind === 'tcp') server.listen(0, '127.0.0.1', resolve);
          else server.listen(socketPath, resolve);
        });
      confinement = await prepareAgentProcessConfinement({
        cwd: workspace,
        writableRoots: [workspace],
        scratchRoot: scratch,
        privateRoot: join(root, 'private-policy'),
        protectedRoots: [marker],
      });
      const address =
        kind === 'tcp'
          ? { host: '127.0.0.1', port: (server.address() as AddressInfo).port }
          : alias;
      const code =
        kind === 'private'
          ? `const net=require('node:net'); const path=${JSON.stringify(join(scratch, 'worker.sock'))}; const server=net.createServer(s=>s.end('PRIVATE_READY')); server.listen(path,()=>{const s=net.connect(path); s.on('data',d=>console.log(d.toString())); s.on('end',()=>server.close());});`
          : [
              'try {',
              ...(kind === 'tcp'
                ? []
                : [
                    `require('node:fs').${kind === 'symlink' ? 'symlinkSync' : 'linkSync'}(${JSON.stringify(socketPath)},${JSON.stringify(alias)});`,
                  ]),
              `const s=require('node:net').connect(${JSON.stringify(address)});`,
              's.setTimeout(2000,()=>{s.destroy();console.log("TIMEOUT")});',
              's.on("connect",()=>s.write("mutate"));',
              's.on("data",data=>console.log(data.toString()));',
              's.on("error",error=>console.log(error.code));',
              '} catch(error) { console.log(error.code); }',
            ].join('\n');
      const launch = confinement.wrap(process.execPath, ['-e', code], process.env);
      const result = await promisify(execFile)(launch.command, launch.args, {
        cwd: workspace,
        env: launch.env,
        timeout: 10000,
      });
      expect(await readFile(marker, 'utf8')).toBe('retained-identity');
      if (kind === 'tcp') expect(result.stdout).toContain('TCP_READY');
      else if (kind === 'private') expect(result.stdout).toContain('PRIVATE_READY');
      else expect(result.stdout).not.toContain('WRITTEN');
    } finally {
      confinement?.dispose();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
);
