import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { remoteSshConnectionHandoff } from './remote-ssh-connection-handoff';
import { buildRemoteExplorerHelperScript } from './remote-endpoint-explorer';
import {
  createFakeSshBoundary,
  fakeSshProcessHasExited,
  readFakeSshProcesses,
} from '../../../../e2e/electron/fixtures/fake-ssh-boundary';

import {
  buildRemoteSshArgs,
  buildRemoteRangeHelperScript,
  classifyRemoteSshFailure,
  materializeRemoteIndex,
  proveForwardedRange,
  terminateRemoteChild,
  validateRemoteAlignmentRequest,
  RemoteGenomicsSupervisor,
} from './remote-genomics-supervisor';

const cleanupRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('remote genomics SSH admission', () => {
  it('preserves external CRAM reference generations through the real helper admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-cram-reference-generation-'));
    cleanupRoots.push(root);
    const boundary = createFakeSshBoundary(root);
    vi.stubEnv('DNAFORGE_FAKE_SSH_LOG', boundary.logPath);
    vi.stubEnv('DNAFORGE_FAKE_SSH_BRIDGE', boundary.bridgePath);
    vi.stubEnv('DNAFORGE_FAKE_SSH_FAIL_MARKER', boundary.failureMarkerPath);
    const alignmentPath = join(root, 'sample.cram');
    const indexPath = `${alignmentPath}.crai`;
    const referencePath = join(root, 'reference.fa');
    const referenceIndexPath = `${referencePath}.fai`;
    for (const path of [alignmentPath, indexPath, referencePath, referenceIndexPath]) {
      await writeFile(path, Buffer.from([1, 2, 3, 4]));
    }
    const receipt = async (path: string) => {
      const details = await stat(path, { bigint: true });
      return {
        canonicalPath: await realpath(path),
        size: Number(details.size),
        mtimeNs: String(details.mtimeNs),
        ctimeNs: String(details.ctimeNs),
        device: String(details.dev),
        inode: String(details.ino),
      };
    };
    const generation = {
      contract: 'dnaforge-remote-source-generation.v1',
      alignment: await receipt(alignmentPath),
      index: await receipt(indexPath),
      reference: await receipt(referencePath),
      referenceIndex: await receipt(referenceIndexPath),
    };
    const capabilities = {
      contract: 'dnaforge-remote-tiles.v1',
      pid: process.pid,
      platform: 'Linux',
      geometry: { tilePx: 1024, baseBinBp: 1, levelFactor: 2 },
      generation,
      header: {
        format: 'cram',
        isCram: true,
        referenceRequired: true,
        references: [{ name: 'chr1', length: 10000, md5: null }],
        index: { state: 'present' },
      },
    };
    let capabilityRequests = 0;
    const token = 'a'.repeat(48);
    const server = createHttpServer((request, response) => {
      if (request.url !== '/v1/capabilities' || request.headers['x-dnaforge-session'] !== token) {
        response.writeHead(403).end();
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      capabilityRequests += 1;
      response.end(JSON.stringify(capabilities));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing capability server port.');
    const tileServerReceiptPath = join(root, 'connection.json');
    await writeFile(
      tileServerReceiptPath,
      JSON.stringify({ ...capabilities, port: address.port, sessionToken: token }),
      { mode: 0o600 }
    );
    const supervisor = new RemoteGenomicsSupervisor({ sshPath: boundary.executablePath });
    try {
      const materialization = await supervisor.connect({
        target: 'cluster-a',
        alignmentPath,
        indexPath,
        tileServerReceiptPath,
      });
      expect(materialization.generation).toMatchObject({
        reference: generation.reference,
        referenceIndex: generation.referenceIndex,
      });
      const readHeader = () =>
        fetch(`${materialization.tileBaseUrl}/tiles/alignment/header`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bamPath: materialization.bamUrl }),
        });
      const header = await readHeader();
      expect(header.status).toBe(200);
      expect(await header.json()).toEqual(capabilities.header);
      expect(capabilityRequests).toBe(2);
      capabilities.pid += 1;
      expect((await readHeader()).status).toBe(412);
      capabilities.pid -= 1;
      await appendFile(indexPath, Buffer.from([5]));
      expect((await readHeader()).status).toBe(412);
    } finally {
      await supervisor.stopAll();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('bounds forwarded calculations and drops canceled requests before they reach Linux', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-cluster-queue-'));
    cleanupRoots.push(root);
    const boundary = createFakeSshBoundary(root);
    vi.stubEnv('DNAFORGE_FAKE_SSH_LOG', boundary.logPath);
    vi.stubEnv('DNAFORGE_FAKE_SSH_BRIDGE', boundary.bridgePath);
    vi.stubEnv('DNAFORGE_FAKE_SSH_FAIL_MARKER', boundary.failureMarkerPath);
    const alignmentPath = join(root, 'sample.bam');
    const indexPath = `${alignmentPath}.bai`;
    for (const path of [alignmentPath, indexPath]) await writeFile(path, Buffer.from([1, 2, 3, 4]));
    const receipt = async (path: string) => {
      const details = await stat(path, { bigint: true });
      return {
        canonicalPath: await realpath(path),
        size: Number(details.size),
        mtimeNs: String(details.mtimeNs),
        ctimeNs: String(details.ctimeNs),
        device: String(details.dev),
        inode: String(details.ino),
      };
    };
    const capabilities = {
      contract: 'dnaforge-remote-tiles.v1',
      pid: process.pid,
      platform: 'Linux',
      geometry: { tilePx: 1024, baseBinBp: 1, levelFactor: 2 },
      generation: {
        contract: 'dnaforge-remote-source-generation.v1',
        alignment: await receipt(alignmentPath),
        index: await receipt(indexPath),
      },
    };
    const token = 'a'.repeat(48);
    const seen: string[] = [];
    const pending = new Set<import('node:http').ServerResponse>();
    let release = false;
    const finish = (response: import('node:http').ServerResponse) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ reads: [], count: 0 }));
    };
    const server = createHttpServer((request, response) => {
      if (request.headers['x-dnaforge-session'] !== token)
        return void response.writeHead(403).end();
      if (request.url === '/v1/capabilities')
        return void response.end(JSON.stringify(capabilities));
      seen.push(request.url!);
      if (release) finish(response);
      else pending.add(response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing calculation server port');
    const tileServerReceiptPath = join(root, 'connection.json');
    await writeFile(
      tileServerReceiptPath,
      JSON.stringify({ ...capabilities, port: address.port, sessionToken: token }),
      { mode: 0o600 }
    );
    const supervisor = new RemoteGenomicsSupervisor({ sshPath: boundary.executablePath });
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const work: Promise<unknown>[] = [];
    try {
      const materialization = await supervisor.connect({
        target: 'cluster-a',
        alignmentPath,
        indexPath,
        tileServerReceiptPath,
      });
      const send = (index: number) =>
        fetch(`${materialization.tileBaseUrl}/tiles/alignment/0/${index}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chrom: 'chr1',
            chromGlobalStart: 0,
          }),
          signal: controllers[index].signal,
        })
          .then(async (response) => ({ status: response.status, body: await response.json() }))
          .catch((error) => ({ canceled: error.name === 'AbortError' }));
      for (let index = 0; index < 4; index++) work.push(send(index));
      await expect.poll(() => seen.length).toBe(4);
      work.push(send(4), send(5));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(seen).toHaveLength(4);
      controllers[4].abort();
      await new Promise((resolve) => setTimeout(resolve, 150));
      release = true;
      for (const response of pending) finish(response);
      const results = await Promise.all(work);
      expect(results[4]).toEqual({ canceled: true });
      expect(results[5]).toMatchObject({ status: 200 });
      expect(seen).not.toContain('/tiles/alignment/0/4');
      expect(seen).toContain('/tiles/alignment/0/5');
    } finally {
      controllers.forEach((controller) => controller.abort());
      release = true;
      for (const response of pending) if (!response.writableEnded) finish(response);
      await Promise.allSettled(work);
      await supervisor.stopAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports a missing cluster process separately from a replaceable SSH helper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-cluster-unavailable-'));
    cleanupRoots.push(root);
    const boundary = createFakeSshBoundary(root);
    vi.stubEnv('DNAFORGE_FAKE_SSH_LOG', boundary.logPath);
    vi.stubEnv('DNAFORGE_FAKE_SSH_BRIDGE', boundary.bridgePath);
    vi.stubEnv('DNAFORGE_FAKE_SSH_FAIL_MARKER', boundary.failureMarkerPath);
    const alignmentPath = join(root, 'complete.bam');
    await writeFile(alignmentPath, Buffer.from([7, 8, 9, 10]));
    await writeFile(`${alignmentPath}.bai`, Buffer.from([1, 2]));
    const supervisor = new RemoteGenomicsSupervisor({ sshPath: boundary.executablePath });
    try {
      await expect(
        supervisor.connect({
          target: 'cluster-a',
          alignmentPath,
          tileServerReceiptPath: join(root, 'missing-private-receipt.json'),
        })
      ).rejects.toMatchObject({
        code: 'cluster-unavailable',
        message:
          'Cluster computation is unavailable. Restart the tile server in your compute allocation, then reconnect. Check its private connection receipt if it is already running.',
      });
    } finally {
      await supervisor.stopAll();
    }
  });

  it('retains an explicit tile server receipt without accepting relative receipt paths', () => {
    const request = {
      target: 'lab-hpc',
      alignmentPath: '/data/reads.bam',
      tileServerReceiptPath: '/home/researcher/.dnaforge-hpc/connection.json',
    };
    expect(validateRemoteAlignmentRequest(request)).toMatchObject(request);
    expect(() =>
      validateRemoteAlignmentRequest({ ...request, tileServerReceiptPath: '../connection.json' })
    ).toThrow('absolute');
  });

  it('does not inherit an outside shell’s configured forwards for its Unix-socket helper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-inherited-forward-'));
    cleanupRoots.push(root);
    const config = join(root, 'config');
    await writeFile(
      config,
      'Host lab-hpc\n  HostName 127.0.0.1\n  LocalForward 127.0.0.1:41001 127.0.0.1:8888\n'
    );
    const helper = buildRemoteSshArgs({
      localPort: 41_002,
      remotePort: 0,
      target: 'lab-hpc',
      control: { path: join(root, 'control'), master: true },
    });
    const { stdout } = await execFileAsync('ssh', ['-G', '-F', config, ...helper]);
    expect(stdout).not.toMatch(/^localforward /m);
    const legacy = buildRemoteSshArgs({ localPort: 41_002, remotePort: 52_002, target: 'lab-hpc' });
    const { stdout: explicit } = await execFileAsync('ssh', ['-G', '-F', config, ...legacy]);
    expect(explicit).toMatch(/^localforward \[127\.0\.0\.1\]:41002 /m);
  });

  it('uses configured SSH sharing without overriding the shared master lifetime', () => {
    const args = buildRemoteSshArgs({
      localPort: 41_001,
      remotePort: 0,
      target: 'lab-hpc',
      control: { path: '/tmp/user-ssh-sharing/control', master: true, systemShared: true },
    });
    expect(args).toContain('ControlMaster=auto');
    expect(args).not.toContain('ControlPersist=no');
    expect(args).not.toContain('ControlMaster=yes');
    expect(args[args.indexOf('-S') + 1]).toBe('/tmp/user-ssh-sharing/control');
    expect(args).not.toContain('-L');
  });

  it('keeps configured SSH sharing when an attachment borrows its browser connection', () => {
    const args = buildRemoteSshArgs({
      localPort: 41_001,
      remotePort: 0,
      target: 'lab-hpc',
      control: { path: '/tmp/user-ssh-sharing/control', master: false, systemShared: true },
    });
    expect(args).toContain('ControlMaster=auto');
    expect(args).not.toContain('ControlPersist=no');
    expect(args.slice(-4)).toEqual(['lab-hpc', 'python3', '-u', '-']);
  });

  it.each(['forward-silent-hpc', 'forward-denied-hpc'] as const)(
    'cleans the pending helper and its owned stdio channel for %s',
    async (target) => {
      const root = await mkdtemp(join(tmpdir(), 'dnaforge-forward-cleanup-'));
      cleanupRoots.push(root);
      const boundary = createFakeSshBoundary(root);
      vi.stubEnv('DNAFORGE_FAKE_SSH_LOG', boundary.logPath);
      vi.stubEnv('DNAFORGE_FAKE_SSH_BRIDGE', boundary.bridgePath);
      vi.stubEnv('DNAFORGE_FAKE_SSH_FAIL_MARKER', boundary.failureMarkerPath);
      const alignmentPath = join(root, 'fixture.bam');
      await writeFile(alignmentPath, Buffer.from([7, 8, 9, 10]));
      await writeFile(`${alignmentPath}.bai`, Buffer.from([1, 2]));
      const controller = new AbortController();
      const supervisor = new RemoteGenomicsSupervisor({ sshPath: boundary.executablePath });
      const opening = supervisor.connect({ target, alignmentPath }, controller.signal);
      const failure = opening.then(
        () => null,
        (error: unknown) => error
      );
      let controlPid = NaN;
      try {
        await expect
          .poll(
            () => {
              if (!existsSync(boundary.logPath)) return false;
              const lines = readFileSync(boundary.logPath, 'utf8').split(/\r?\n/u);
              const forwardLine = lines.findIndex((line) => line.includes(' -W '));
              if (forwardLine < 0) return false;
              controlPid = Number(
                /^DNAFORGE_FAKE_SSH_PID (\d+)$/u.exec(lines[forwardLine + 1])?.[1]
              );
              return controlPid > 1;
            },
            { timeout: 3_000 }
          )
          .toBe(true);
        const lines = readFileSync(boundary.logPath, 'utf8').split(/\r?\n/u);
        expect(controlPid).toBeGreaterThan(1);
        if (target === 'forward-silent-hpc') {
          expect(fakeSshProcessHasExited(controlPid)).toBe(false);
          controller.abort(new Error('fixture cancelled pending forward'));
          await expect
            .poll(() => fakeSshProcessHasExited(controlPid), { timeout: 1_000 })
            .toBe(true);
        }
        expect(await failure).toMatchObject({
          message: expect.stringContaining(
            target === 'forward-silent-hpc'
              ? 'fixture cancelled pending forward'
              : 'could not reach the remote file helper'
          ),
        });
        expect(lines.some((line) => / -O (forward|cancel) /u.test(line))).toBe(false);
        const commands = readFakeSshProcesses(boundary.logPath, target);
        expect(commands).toHaveLength(1);
        expect(fakeSshProcessHasExited(commands[0].pid)).toBe(true);
        const controlPath = commands[0].args.match(/ -S (\S+) /u)?.[1];
        if (!controlPath) throw new Error('The pending connection had no private control path.');
        expect(existsSync(dirname(controlPath))).toBe(false);
      } finally {
        controller.abort(new Error('fixture cancelled pending forward'));
        await opening.catch(() => undefined);
        await supervisor.stopAll();
      }
    }
  );

  it('starts the authenticated command before adding a forward to its reserved remote port', () => {
    const args = buildRemoteSshArgs({
      localPort: 41_001,
      remotePort: 0,
      target: 'lab-hpc',
      control: { path: '/tmp/dfs-ctrl-fixture/control', master: true },
    });
    expect(args).not.toContain('-L');
    expect(args).toContain('ControlMaster=yes');
    expect(args).toContain('ControlPersist=no');
    expect(args.slice(-4)).toEqual(['lab-hpc', 'python3', '-u', '-']);
  });

  it('never turns a data command into another interactive login, including a legacy explicit retry', () => {
    const args = buildRemoteSshArgs({
      localPort: 41001,
      remotePort: 0,
      target: 'lab-hpc',
      interactive: true,
    });
    expect(args).toContain('BatchMode=yes');
    expect(args).not.toContain('BatchMode=no');
  });

  it('identifies an occupied port without blaming the endpoint forwarding policy', () => {
    expect(classifyRemoteSshFailure('OSError: [Errno 98] Address already in use')).toEqual({
      code: 'tunnel-failed',
      message: 'A port needed by this SSH connection is already in use. Retry the connection.',
    });
  });

  it('cancels an unfinished private index transfer with the owning attachment', async () => {
    const controller = new AbortController();
    let transferSignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn<typeof fetch>((_url, options) => {
      transferSignal = options?.signal;
      return new Promise<Response>((_resolve, reject) => {
        transferSignal?.addEventListener(
          'abort',
          () => reject(new Error('fixture transfer aborted')),
          { once: true }
        );
      });
    });
    const transfer = materializeRemoteIndex({
      url: 'http://127.0.0.1:41000/index.bai',
      receipt: {
        canonicalPath: '/run/sample.bam.bai',
        size: 4,
        mtimeNs: '1',
        ctimeNs: '1',
        device: null,
        inode: null,
      },
      extension: '.bai',
      signal: controller.signal,
      fetchImpl,
    });
    const cancelled = expect(transfer).rejects.toThrow('could not cache the remote index');
    expect(fetchImpl).toHaveBeenCalledOnce();
    controller.abort();
    expect(transferSignal?.aborted).toBe(true);
    await cancelled;
  });

  it('reuses the tested connection without starting a detached SSH master', () => {
    const args = buildRemoteSshArgs({
      localPort: 41_001,
      remotePort: 52_002,
      target: 'lab-hpc',
      control: { path: '/tmp/dfs-ctrl-fixture/control', master: false },
    });
    expect(args).toContain('-S');
    expect(args[args.indexOf('-S') + 1]).toBe('/tmp/dfs-ctrl-fixture/control');
    expect(args).toContain('ControlMaster=no');
    expect(args).toContain('ControlPersist=no');
    expect(args.indexOf('-S')).toBeLessThan(args.indexOf('lab-hpc'));
  });

  it('refuses a fresh login if an app-managed host connection disappears', () => {
    const args = buildRemoteSshArgs({
      localPort: 41_001,
      remotePort: 0,
      target: 'lab-hpc',
      control: { path: '/tmp/df-host-fixture/control', master: false, existingOnly: true },
    });
    expect(args).toContain('ControlMaster=no');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ProxyCommand=false');
    expect(args).toContain('ProxyJump=none');
    expect(args).toContain('ForkAfterAuthentication=no');
  });

  it('keeps an explicit browse handoff in the validated connection request', () => {
    expect(
      validateRemoteAlignmentRequest({
        requestId: 'attach-request-1',
        allowInteractive: true,
        explorerSessionId: 'explorer-session-1',
        target: 'lab-hpc',
        alignmentPath: '/data/a.bam',
      })
    ).toMatchObject({ explorerSessionId: 'explorer-session-1' });
  });

  it.each([
    { explorerSessionId: 'explorer-1' },
    { explorerSessionId: 'explorer-1', requestId: 'request-1', allowInteractive: false },
    { explorerSessionId: '../control', requestId: 'request-1', allowInteractive: true },
  ])('rejects a non-explicit or malformed tested connection handoff %#', (handoff) => {
    expect(() =>
      validateRemoteAlignmentRequest({
        target: 'lab-hpc',
        alignmentPath: '/data/a.bam',
        ...handoff,
      })
    ).toThrow('explicit connection request');
  });

  it('releases the tested connection when the new SSH child cannot start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ssh-handoff-start-failure-'));
    cleanupRoots.push(root);
    const release = vi.fn(async () => undefined);
    remoteSshConnectionHandoff.offer('handoff-failure-1', {
      target: 'lab-hpc',
      controlPath: '/tmp/dfs-ctrl-fixture/control',
      release,
    });
    const supervisor = new RemoteGenomicsSupervisor({ sshPath: join(root, 'missing-ssh') });
    try {
      await expect(
        supervisor.connect({
          requestId: 'handoff-failure-1',
          target: 'lab-hpc',
          alignmentPath: '/data/a.bam',
        })
      ).rejects.toThrow('OpenSSH');
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      await supervisor.stopAll();
      await remoteSshConnectionHandoff.discard('handoff-failure-1');
    }
  });

  it('allocates local and remote loopback ports independently', () => {
    expect(
      buildRemoteSshArgs({
        localPort: 41_001,
        remotePort: 52_002,
        target: 'lab-hpc',
      })
    ).toContain('127.0.0.1:41001:127.0.0.1:52002');
  });

  it('reports a session that exited before its runtime listener attached synchronously', () => {
    const supervisor = new RemoteGenomicsSupervisor();
    let closed = false;
    supervisor.subscribeSession('already-gone', () => {
      closed = true;
    });
    expect(closed).toBe(true);
  });

  it.runIf(process.platform !== 'win32')(
    'terminates a stopped tunnel process instead of leaving its forwarded sockets pinned',
    async () => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          'process.once("SIGTERM",()=>process.exit(0));process.stdout.write("ready");setInterval(()=>{},1000)',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
      await once(child.stdout, 'data');
      try {
        child.kill('SIGSTOP');
        await expect
          .poll(async () => {
            const { stdout } = await execFileAsync('ps', ['-o', 'state=', '-p', String(child.pid)]);
            return stdout.trim().startsWith('T');
          })
          .toBe(true);

        const exit = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
        await terminateRemoteChild(child);

        const result = await Promise.race([
          exit,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Stopped tunnel process did not exit.')), 2_000)
          ),
        ]);
        expect(result.code === 0 || result.signal === 'SIGKILL').toBe(true);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGCONT');
          child.kill('SIGKILL');
        }
      }
    }
  );

  it('accepts a normal OpenSSH alias and absolute BAM/index paths', () => {
    expect(
      validateRemoteAlignmentRequest({
        target: 'lab-hpc',
        alignmentPath: '/project/run 42/tumor.bam',
        indexPath: '/project/run 42/tumor.bam.bai',
      })
    ).toEqual({
      target: 'lab-hpc',
      alignmentPath: '/project/run 42/tumor.bam',
      indexPath: '/project/run 42/tumor.bam.bai',
    });
  });

  it.each([
    [{ target: '-oProxyCommand=bad', alignmentPath: '/data/a.bam' }, 'SSH target'],
    [{ target: 'lab host', alignmentPath: '/data/a.bam' }, 'SSH target'],
    [{ target: 'lab', alignmentPath: 'relative/a.bam' }, 'absolute'],
    [{ target: 'lab', alignmentPath: '/data/a.sam' }, 'BAM'],
    [{ target: 'lab', alignmentPath: '/data/a.bam', indexPath: '../a.bai' }, 'absolute'],
    [{ target: 'lab', alignmentPath: '/data/a.bam', indexPath: '/data/a.idx' }, 'CRAI'],
    [{ target: 'lab', alignmentPath: '/data/a.bam', signalPath: '/data/signal.tdf' }, 'BigWig'],
  ])('rejects unsafe or unsupported request %# before spawning', (request, message) => {
    expect(() => validateRemoteAlignmentRequest(request)).toThrow(message);
  });

  it('classifies authentication and host-trust failures without returning the transcript', () => {
    expect(classifyRemoteSshFailure('Permission denied (publickey).')).toMatchObject({
      code: 'authentication-required',
    });
    expect(
      classifyRemoteSshFailure('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!')
    ).toMatchObject({ code: 'host-trust-failed' });
    expect(classifyRemoteSshFailure('python3: command not found')).toMatchObject({
      code: 'python-unavailable',
    });
    expect(classifyRemoteSshFailure('secret transcript content')).not.toHaveProperty(
      'message',
      expect.stringContaining('secret transcript content')
    );
  });

  it('does not classify debug authentication negotiations as a failed login', () => {
    expect(
      classifyRemoteSshFailure(
        'debug1: preferred authentication includes keyboard-interactive\npython3: command not found'
      )
    ).toMatchObject({ code: 'python-unavailable' });
  });

  it('keeps debug-only passphrase and authentication mentions as an unknown helper failure', () => {
    expect(
      classifyRemoteSshFailure(
        'debug1: read_passphrase implementation available\ndebug2: keyboard-interactive disabled'
      )
    ).toMatchObject({ code: 'helper-failed' });
  });
});

describe('disposable remote range helper', () => {
  it.each([
    { asset: 'alignment', truncate: false },
    { asset: 'alignment', truncate: true },
    { asset: 'index', truncate: false },
    { asset: 'signal', truncate: false },
  ] as const)(
    'rejects an in-place change to $asset (truncate=$truncate) before serving stale receipts',
    async ({ asset, truncate }) => {
      const root = await mkdtemp(join(tmpdir(), 'dnaforge-file-change-'));
      cleanupRoots.push(root);
      const paths = {
        alignment: join(root, 'sample.bam'),
        index: join(root, 'sample.bam.bai'),
        signal: join(root, 'sample.bigWig'),
      };
      await Promise.all(Object.values(paths).map((path) => writeFile(path, Buffer.alloc(64, 'A'))));
      const child = spawn('python3', ['-u', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.resume();
      child.stdin.end(
        buildRemoteRangeHelperScript({
          port: 0,
          alignmentPath: paths.alignment,
          indexPath: paths.index,
          signalPath: paths.signal,
          sourceHandle: 'file-change',
        })
      );
      try {
        const ready = await readReadyLine(child.stdout);
        const url = `http://127.0.0.1:${ready.port}${ready.paths[asset]}`;
        const first = await fetch(url, { headers: { Range: 'bytes=0-15' } });
        expect(await first.text()).toBe('A'.repeat(16));
        const before = await stat(paths[asset], { bigint: true });
        await writeFile(paths[asset], Buffer.alloc(truncate ? 8 : 64, 'B'));
        const after = await stat(paths[asset], { bigint: true });
        expect(after.ino).toBe(before.ino);
        const changed = await fetch(url, {
          headers: { Range: 'bytes=0-15', 'If-Match': first.headers.get('etag')! },
          signal: AbortSignal.timeout(1_000),
        });
        expect(changed.status).toBe(412);
        expect(await changed.text()).toMatch(/file changed/i);
        expect((await fetch(url, { method: 'HEAD' })).status).toBe(412);
        if (asset === 'index') {
          await expect(
            materializeRemoteIndex({
              url,
              receipt: {
                canonicalPath: paths.index,
                size: 64,
                mtimeNs: '1',
                ctimeNs: '1',
                device: null,
                inode: null,
              },
              extension: '.bai',
            })
          ).rejects.toMatchObject({ code: 'source-changed' });
        } else if (asset === 'alignment') {
          await expect(proveForwardedRange(url, fetch)).rejects.toMatchObject({
            code: 'source-changed',
          });
        }
      } finally {
        await terminateRemoteChild(child);
      }
    }
  );

  it('interrupts a multi-chunk response before sending bytes changed during the stream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-stream-file-change-'));
    cleanupRoots.push(root);
    const alignmentPath = join(root, 'sample.bam');
    const size = 2 * 1024 * 1024;
    await writeFile(alignmentPath, Buffer.alloc(size, 'A'));
    await writeFile(`${alignmentPath}.bai`, 'index');
    const child = spawn('python3', ['-u', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    child.stdin.end(
      buildRemoteRangeHelperScript({ port: 0, alignmentPath, sourceHandle: 'stream-change' })
    );
    try {
      const ready = await readReadyLine(child.stdout);
      const response = await fetch(`http://127.0.0.1:${ready.port}${ready.paths.alignment}`, {
        headers: { Range: `bytes=0-${size - 1}` },
        signal: AbortSignal.timeout(3_000),
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(first.value?.byteLength).toBeGreaterThan(0);
      const chunks = [Buffer.from(first.value!)];
      await writeFile(alignmentPath, Buffer.alloc(size, 'B'));
      let interrupted = false;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          chunks.push(Buffer.from(chunk.value));
        }
      } catch {
        interrupted = true;
      }
      expect(interrupted).toBe(true);
      expect(Buffer.concat(chunks).includes('B')).toBe(false);
      expect(Buffer.concat(chunks).byteLength).toBeLessThan(size);
    } finally {
      await terminateRemoteChild(child);
    }
  });

  it.each(['range', 'explorer'] as const)(
    'ends the %s helper when its SSH output pipe closes',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'dnaforge-ssh-pipe-close-'));
      cleanupRoots.push(root);
      const alignmentPath = join(root, 'fixture.bam');
      await writeFile(alignmentPath, Buffer.from([7, 8, 9, 10]));
      await writeFile(`${alignmentPath}.bai`, Buffer.from([1, 2]));
      const token = 'b'.repeat(48);
      const script =
        kind === 'range'
          ? buildRemoteRangeHelperScript({ port: 0, alignmentPath, sourceHandle: token })
          : buildRemoteExplorerHelperScript({ port: 0, token });
      const child = spawn('python3', ['-u', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.resume();
      child.stdin.end(script);
      try {
        await readReadyLine(
          child.stdout,
          kind === 'range' ? 'DNAFORGE_REMOTE_READY ' : 'DNAFORGE_REMOTE_EXPLORE_READY '
        );
        child.stdout.destroy();
        await expect.poll(() => child.exitCode !== null, { timeout: 1_500 }).toBe(true);
        expect(child.exitCode).toBe(0);
      } finally {
        await terminateRemoteChild(child);
      }
    }
  );

  it.each(['range', 'explorer'] as const)(
    'reserves and reports its actual remote port for the %s helper',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'dnaforge-auto-port-'));
      cleanupRoots.push(root);
      const alignmentPath = join(root, 'fixture.bam');
      const indexPath = `${alignmentPath}.bai`;
      await writeFile(alignmentPath, Buffer.from([7, 8, 9, 10]));
      await writeFile(indexPath, Buffer.from([1, 2]));
      const token = 'a'.repeat(48);
      const script =
        kind === 'range'
          ? buildRemoteRangeHelperScript({ port: 0, alignmentPath, indexPath, sourceHandle: token })
          : buildRemoteExplorerHelperScript({ port: 0, token });
      const child = spawn('python3', ['-u', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.resume();
      child.stdin.end(script);
      try {
        const ready = await readReadyLine(
          child.stdout,
          kind === 'range' ? 'DNAFORGE_REMOTE_READY ' : 'DNAFORGE_REMOTE_EXPLORE_READY '
        );
        expect(ready.port).toBeGreaterThan(0);
        expect(ready.port).toBeLessThanOrEqual(65_535);
        const route = kind === 'range' ? ready.paths.alignment : `/v1/${token}/health`;
        const response = await fetch(`http://127.0.0.1:${ready.port}${route}`, {
          headers: { Range: 'bytes=0-3' },
          signal: AbortSignal.timeout(2_000),
        });
        if (kind === 'range') {
          expect(response.status).toBe(206);
          expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([7, 8, 9, 10]);
        } else {
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ ready: true });
        }
      } finally {
        await terminateRemoteChild(child);
      }
    }
  );

  it('downloads an admitted index without imposing alignment cancellation pacing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-index-throughput-'));
    cleanupRoots.push(root);
    const alignmentPath = join(root, 'fixture.bam');
    const indexPath = `${alignmentPath}.bai`;
    const indexBytes = Buffer.alloc(4 * 1024 * 1024, 91);
    await writeFile(alignmentPath, Buffer.from([1, 2, 3, 4]));
    await writeFile(indexPath, indexBytes);
    const child = spawn('python3', ['-u', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    child.stdin.end(
      buildRemoteRangeHelperScript({
        port: 0,
        alignmentPath,
        indexPath,
        sourceHandle: 'index-throughput',
      })
    );
    try {
      const ready = await readReadyLine(child.stdout);
      const localized = await materializeRemoteIndex({
        url: `http://127.0.0.1:${ready.port}${ready.paths.index}`,
        receipt: {
          canonicalPath: indexPath,
          size: indexBytes.length,
          mtimeNs: '1',
          ctimeNs: '1',
          device: null,
          inode: null,
        },
        extension: '.bai',
        timeoutMs: 2_000,
      });
      cleanupRoots.push(localized.cacheRoot);
      expect(
        createHash('sha256')
          .update(await readFile(localized.path))
          .digest('hex')
      ).toBe(createHash('sha256').update(indexBytes).digest('hex'));
    } finally {
      await terminateRemoteChild(child);
    }
  });

  it('streams admitted alignment bytes as fast as a real TCP reader accepts them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-alignment-throughput-'));
    cleanupRoots.push(root);
    const alignmentPath = join(root, 'fixture.bam');
    const indexPath = `${alignmentPath}.bai`;
    const alignmentBytes = Buffer.alloc(32 * 1024 * 1024, 29);
    await writeFile(alignmentPath, alignmentBytes);
    await writeFile(indexPath, Buffer.from([91, 92, 93, 94]));
    const child = spawn('python3', ['-u', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    child.stdin.end(
      buildRemoteRangeHelperScript({
        port: 0,
        alignmentPath,
        indexPath,
        sourceHandle: 'alignment-throughput',
      })
    );
    try {
      const ready = await readReadyLine(child.stdout);
      const response = await fetch(`http://127.0.0.1:${ready.port}${ready.paths.alignment}`, {
        headers: { Range: `bytes=0-${alignmentBytes.length - 1}` },
        signal: AbortSignal.timeout(2_000),
      });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-length')).toBe(String(alignmentBytes.length));
      expect(response.headers.get('content-range')).toBe(
        `bytes 0-${alignmentBytes.length - 1}/${alignmentBytes.length}`
      );
      const received = Buffer.from(await response.arrayBuffer());
      expect(received.length).toBe(alignmentBytes.length);
      expect(createHash('sha256').update(received).digest('hex')).toBe(
        createHash('sha256').update(alignmentBytes).digest('hex')
      );
    } finally {
      await terminateRemoteChild(child);
    }
  });

  it('serves only the admitted files with correct HEAD and byte-range semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-remote-helper-'));
    cleanupRoots.push(root);
    const alignmentPath = join(root, 'fixture.bam');
    const indexPath = join(root, 'fixture.bam.bai');
    const alignmentBytes = Buffer.alloc(8 * 1024 * 1024);
    for (let index = 0; index < 64; index += 1) alignmentBytes[index] = index;
    await writeFile(alignmentPath, alignmentBytes);
    await writeFile(indexPath, Buffer.from([91, 92, 93, 94]));
    const port = await reservePort();
    const script = buildRemoteRangeHelperScript({
      port,
      alignmentPath,
      indexPath,
      sourceHandle: 'source-handle',
      telemetry: true,
    });
    const child = spawn('python3', ['-u', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end(script);
    try {
      const ready = await readReadyLine(child.stdout);
      expect(ready).toMatchObject({
        protocol: 'dnaforge-remote-range.v1',
        port,
        files: {
          alignment: { size: alignmentBytes.length },
          index: { size: 4 },
        },
      });

      const alignmentUrl = `http://127.0.0.1:${port}${ready.paths.alignment}`;
      const head = await fetch(alignmentUrl, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('accept-ranges')).toBe('bytes');
      expect(head.headers.get('content-length')).toBe(String(alignmentBytes.length));

      const range = await fetch(alignmentUrl, { headers: { Range: 'bytes=7-11' } });
      expect(range.status).toBe(206);
      expect(range.headers.get('content-range')).toBe(`bytes 7-11/${alignmentBytes.length}`);
      expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([7, 8, 9, 10, 11]);

      const { stdout: cancelledClientOutput } = await execFileAsync(
        'python3',
        [
          '-c',
          `import json, socket, sys
from urllib.parse import urlsplit
url = urlsplit(sys.argv[1])
configured = 32 * 1024
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
    client.settimeout(2)
    client.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, configured)
    actual = client.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF)
    client.connect((url.hostname, url.port))
    client.sendall(('GET ' + url.path + ' HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n').encode())
    received = b''
    while b'\\r\\n\\r\\n' not in received:
        received += client.recv(4096)
    headers, body = received.split(b'\\r\\n\\r\\n', 1)
    if not body:
        body = client.recv(1)
    status = int(headers.split(b' ', 2)[1])
    body_bytes = len(body)
print(json.dumps({'status': status, 'configuredReceiveBuffer': configured, 'actualReceiveBuffer': actual, 'firstBodyBytes': body_bytes, 'clientClosed': client.fileno() == -1}))
`,
          alignmentUrl,
        ],
        { timeout: 3_000 }
      );
      const cancelledClient = JSON.parse(cancelledClientOutput);
      expect(cancelledClient.status).toBe(200);
      expect(cancelledClient.configuredReceiveBuffer).toBe(32 * 1024);
      expect(cancelledClient.actualReceiveBuffer).toBeGreaterThan(0);
      expect(cancelledClient.actualReceiveBuffer).toBeLessThanOrEqual(64 * 1024);
      expect(cancelledClient.firstBodyBytes).toBeGreaterThan(0);
      expect(cancelledClient.firstBodyBytes).toBeLessThan(alignmentBytes.length);
      expect(cancelledClient.clientClosed).toBe(true);
      await expect
        .poll(() =>
          stderr
            .split(/\r?\n/u)
            .filter((line) => line.startsWith('DNAFORGE_REMOTE_RANGE '))
            .map((line) => JSON.parse(line.slice('DNAFORGE_REMOTE_RANGE '.length)))
            .find(
              (event) =>
                event.asset === 'alignment' && event.method === 'GET' && event.status === 200
            )
        )
        .toEqual(expect.objectContaining({ bytes: expect.any(Number) }));
      const cancelledEvent = stderr
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('DNAFORGE_REMOTE_RANGE '))
        .map((line) => JSON.parse(line.slice('DNAFORGE_REMOTE_RANGE '.length)))
        .find(
          (event) => event.asset === 'alignment' && event.method === 'GET' && event.status === 200
        );
      expect(cancelledEvent.bytes).toBeLessThanOrEqual(512 * 1024);
      console.info(
        'SSH helper cancellation observation',
        JSON.stringify({
          configuredReceiveBuffer: cancelledClient.configuredReceiveBuffer,
          actualReceiveBuffer: cancelledClient.actualReceiveBuffer,
          firstBodyBytes: cancelledClient.firstBodyBytes,
          clientClosed: cancelledClient.clientClosed,
          remoteWrittenBytes: cancelledEvent.bytes,
          serverCompleted: true,
        })
      );

      const localized = await materializeRemoteIndex({
        url: `http://127.0.0.1:${port}${ready.paths.index}`,
        receipt: {
          canonicalPath: indexPath,
          size: 4,
          mtimeNs: '1',
          ctimeNs: '1',
          device: null,
          inode: null,
        },
        extension: '.bai',
      });
      cleanupRoots.push(localized.cacheRoot);
      expect([...new Uint8Array(await readFile(localized.path))]).toEqual([91, 92, 93, 94]);
      if (process.platform !== 'win32') {
        expect((await stat(localized.path)).mode & 0o777).toBe(0o600);
      }

      const unadmitted = await fetch(`http://127.0.0.1:${port}/etc/passwd`);
      expect(unadmitted.status).toBe(404);
      await expect
        .poll(() =>
          stderr
            .split(/\r?\n/u)
            .filter((line) => line.startsWith('DNAFORGE_REMOTE_RANGE '))
            .map((line) => JSON.parse(line.slice('DNAFORGE_REMOTE_RANGE '.length)))
        )
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              asset: 'alignment',
              method: 'GET',
              status: 206,
              start: 7,
              end: 11,
              bytes: 5,
            }),
            expect.objectContaining({
              asset: 'index',
              method: 'GET',
              status: 200,
              bytes: 4,
            }),
          ])
        );
    } finally {
      child.kill('SIGTERM');
    }
  });

  it('serves a discovered nf-core BigWig sibling by byte range and ignores other paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-remote-signal-'));
    cleanupRoots.push(root);
    const bamDir = join(root, 'star_salmon');
    const signalDir = join(bamDir, 'bigwig');
    await mkdir(signalDir, { recursive: true });
    const alignmentPath = join(bamDir, 'N052611_untreated.markdup.sorted.bam');
    const indexPath = `${alignmentPath}.bai`;
    const signalPath = join(signalDir, 'N052611_untreated.bigWig');
    await writeFile(alignmentPath, Buffer.from([1, 2, 3, 4]));
    await writeFile(indexPath, Buffer.from([5]));
    const signalBytes = Buffer.from([9, 8, 7, 6, 5, 4]);
    await writeFile(signalPath, signalBytes);
    const port = await reservePort();
    const script = buildRemoteRangeHelperScript({
      port,
      alignmentPath,
      indexPath,
      sourceHandle: 'source-handle',
    });
    const child = spawn('python3', ['-u', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(script);
    try {
      const ready = await readReadyLine(child.stdout);
      expect(ready.paths.signal).toBe('/v1/source-handle/signal.bigWig');
      expect(
        ready.files.signal?.canonicalPath.endsWith('/star_salmon/bigwig/N052611_untreated.bigWig')
      ).toBe(true);
      expect(ready.files.signal?.size).toBe(signalBytes.length);
      const range = await fetch(`http://127.0.0.1:${port}${ready.paths.signal}`, {
        headers: { Range: 'bytes=1-3' },
      });
      expect(range.status).toBe(206);
      expect(range.headers.get('access-control-allow-origin')).toBe('*');
      expect(range.headers.get('access-control-expose-headers')).toContain('Content-Range');
      expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([8, 7, 6]);
      const preflight = await fetch(`http://127.0.0.1:${port}${ready.paths.signal}`, {
        method: 'OPTIONS',
        headers: { 'Access-Control-Request-Headers': 'Range' },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-headers')).toContain('Range');
      expect(
        (await fetch(`http://127.0.0.1:${port}/v1/source-handle/alignment.bam.bai`)).status
      ).toBe(200);
    } finally {
      child.kill('SIGTERM');
    }
  });

  it.each([
    ['bam', 'bai'],
    ['cram', 'crai'],
  ])(
    'rejects a missing explicit %s index instead of choosing its sibling',
    async (format, index) => {
      const root = await mkdtemp(join(tmpdir(), 'dnaforge-remote-explicit-index-'));
      cleanupRoots.push(root);
      const alignmentPath = join(root, `sample.${format}`);
      await writeFile(alignmentPath, Buffer.from([1, 2, 3, 4]));
      await writeFile(`${alignmentPath}.${index}`, Buffer.from([5]));
      const script = buildRemoteRangeHelperScript({
        port: 0,
        alignmentPath,
        indexPath: join(root, `missing.${index}`),
        sourceHandle: 'source-handle',
      });
      await expect(
        execFileAsync('python3', ['-u', '-c', script], { timeout: 2_000 })
      ).rejects.toMatchObject({
        code: 78,
        stdout:
          'DNAFORGE_REMOTE_ERROR ' +
          JSON.stringify({
            code: 'INDEX_NOT_FOUND',
            message: 'Remote alignment index was not found or is not readable.',
          }) +
          '\n',
      });
    }
  );

  it('serves a sibling CRAM instead of the BAM when the CRAM index exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-remote-cram-'));
    cleanupRoots.push(root);
    const alignmentPath = join(root, 'sample.bam');
    const indexPath = `${alignmentPath}.bai`;
    const cramPath = join(root, 'sample.cram');
    const craiPath = `${cramPath}.crai`;
    await writeFile(alignmentPath, Buffer.from([1, 2, 3, 4]));
    await writeFile(indexPath, Buffer.from([5]));
    const cramBytes = Buffer.from([9, 8, 7, 6, 5]);
    await writeFile(cramPath, cramBytes);
    await writeFile(craiPath, Buffer.from([4, 3]));
    const port = await reservePort();
    const child = spawn('python3', ['-u', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(
      buildRemoteRangeHelperScript({
        port,
        alignmentPath,
        indexPath,
        sourceHandle: 'source-handle',
      })
    );
    try {
      const ready = await readReadyLine(child.stdout);
      expect(ready.paths.alignment).toBe('/v1/source-handle/alignment.cram');
      expect(ready.paths.index).toBe('/v1/source-handle/alignment.cram.crai');
      expect(ready.files.alignment.canonicalPath.endsWith('/sample.cram')).toBe(true);
      expect(ready.files.index.size).toBe(2);
      const body = await fetch(`http://127.0.0.1:${port}${ready.paths.alignment}`);
      expect([...new Uint8Array(await body.arrayBuffer())]).toEqual([9, 8, 7, 6, 5]);
      expect((await fetch(`http://127.0.0.1:${port}/v1/source-handle/alignment.bam`)).status).toBe(
        404
      );
    } finally {
      child.kill('SIGTERM');
    }
  });
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a TCP port.');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

async function readReadyLine(
  stream: NodeJS.ReadableStream,
  prefix = 'DNAFORGE_REMOTE_READY '
): Promise<{
  protocol: string;
  port: number;
  paths: { alignment: string; index: string; signal?: string };
  files: {
    alignment: { canonicalPath: string; size: number };
    index: { canonicalPath: string; size: number };
    signal?: { canonicalPath: string; size: number };
  };
}> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for helper readiness.')),
      5_000
    );
    stream.on('data', (chunk) => {
      buffered += String(chunk);
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      if (!line.startsWith(prefix)) return;
      clearTimeout(timeout);
      resolve(JSON.parse(line.slice(prefix.length)));
    });
    stream.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
