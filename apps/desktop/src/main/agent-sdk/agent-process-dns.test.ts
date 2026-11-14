import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { prepareAgentProcessConfinement } from './agent-process-confinement';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => 'test' } }));

it.skipIf(process.platform !== 'darwin')(
  'resolves native chat provider hosts inside the agent sandbox',
  async () => {
    const hosts = ['api.anthropic.com', 'api.openai.com'];
    await Promise.all(hosts.map((host) => lookup(host)));
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dna-native-chat-dns-')));
    const workspace = join(root, 'project');
    const scratch = join(root, 'scratch');
    let confinement: Awaited<ReturnType<typeof prepareAgentProcessConfinement>> | undefined;
    try {
      await Promise.all([mkdir(workspace), mkdir(scratch)]);
      confinement = await prepareAgentProcessConfinement({
        cwd: workspace,
        writableRoots: [workspace],
        scratchRoot: scratch,
        privateRoot: join(root, 'private-policy'),
        protectedRoots: [],
      });
      const code = `Promise.all(${JSON.stringify(hosts)}.map(async host => { try { await require('node:dns/promises').lookup(host); return { host, resolved: true }; } catch (error) { return { host, error: error.code }; } })).then(result => console.log(JSON.stringify(result)))`;
      const launch = confinement.wrap(process.execPath, ['-e', code], process.env);
      const result = await promisify(execFile)(launch.command, launch.args, {
        cwd: workspace,
        env: launch.env,
        timeout: 10000,
      });
      expect(JSON.parse(result.stdout)).toEqual(hosts.map((host) => ({ host, resolved: true })));
    } finally {
      confinement?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }
);
