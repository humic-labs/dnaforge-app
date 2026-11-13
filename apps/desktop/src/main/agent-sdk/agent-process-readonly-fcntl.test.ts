import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { prepareAgentProcessConfinement } from './agent-process-confinement';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => 'test' } }));

it.skipIf(process.platform !== 'darwin')(
  'preserves read-only installations against extent-transfer file controls',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dna4162-fcntl-')));
    const workspace = join(root, 'project');
    const scratch = join(root, 'scratch');
    const runtime = join(root, 'runtime');
    const target = join(runtime, 'launcher');
    const payload = join(workspace, 'payload');
    let confinement: Awaited<ReturnType<typeof prepareAgentProcessConfinement>> | undefined;
    try {
      await Promise.all([mkdir(workspace), mkdir(scratch), mkdir(runtime)]);
      await Promise.all([
        writeFile(target, 'retained-installation'),
        writeFile(payload, 'UNAUTHORIZED-REPLACEMENT'),
      ]);
      const python = await realpath(
        (await promisify(execFile)('/usr/bin/which', ['python3'])).stdout.trim()
      );
      confinement = await prepareAgentProcessConfinement({
        cwd: workspace,
        writableRoots: [workspace],
        scratchRoot: scratch,
        privateRoot: join(root, 'private-policy'),
        protectedRoots: [],
        readOnlyRoots: [runtime],
      });
      const code = [
        'import ctypes,json,os,sys',
        'libc=ctypes.CDLL(None,use_errno=True)',
        'libc.fcntl.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_int]',
        'target=os.open(sys.argv[1],os.O_RDONLY)',
        'source=os.open(sys.argv[2],os.O_RDONLY)',
        'result=libc.fcntl(target,110,source)',
        'print(json.dumps({"result":result,"errno":ctypes.get_errno(),"actual":open(sys.argv[1]).read()}))',
      ].join('\n');
      const launch = confinement.wrap(python, ['-c', code, target, payload], {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
      });
      const result = await promisify(execFile)(launch.command, launch.args, {
        cwd: workspace,
        env: launch.env,
        timeout: 10000,
      });
      console.log(result.stdout.trim());
      expect(await readFile(target, 'utf8')).toBe('retained-installation');
      expect(JSON.parse(result.stdout)).toMatchObject({ result: -1, errno: 1 });
    } finally {
      confinement?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }
);
