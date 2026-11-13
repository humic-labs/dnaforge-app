import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import type { WebContents } from 'electron';

import { sendRendererIpc } from '../shared/ipc-contract';
import type { RemoteSshAuthPromptV1 } from '../shared/remote-genomics-ipc';

const PROMPT_TIMEOUT_MS = 120_000;
const MAX_PROMPT_BYTES = 8_192;
const MAX_ANSWER_LENGTH = 4_096;

interface PromptWaiter {
  readonly ownerId: number;
  readonly owner: WebContents;
  readonly requestId: string;
  readonly socket: Socket;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PromptSession {
  readonly owner: WebContents;
  readonly root: string;
  readonly server: Server;
  readonly token: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly sockets: Set<Socket>;
  readonly onDestroyed: () => void;
  readonly onCancel: () => void;
  cancelled: boolean;
}

const ASKPASS_SCRIPT = `const net = require('node:net');
const socket = net.createConnection(process.env.DNAFORGE_ASKPASS_SOCKET);
const prompt = process.argv[2] || '';
let response = '';
const deadline = setTimeout(() => process.exit(1), 120000);
socket.on('connect', () => socket.write(JSON.stringify({ token: process.env.DNAFORGE_ASKPASS_TOKEN, prompt }) + '\\n'));
socket.on('data', (chunk) => {
  response += chunk.toString('utf8');
  if (response.length > 16384) process.exit(1);
  const newline = response.indexOf('\\n');
  if (newline < 0) return;
  try {
    const value = JSON.parse(response.slice(0, newline));
    if (typeof value.answer !== 'string') process.exit(1);
    clearTimeout(deadline);
    process.stdout.write(value.answer + '\\n', () => process.exit(0));
  } catch { process.exit(1); }
});
socket.on('error', () => process.exit(1));
socket.on('end', () => process.exit(1));
`;

function promptKind(text: string): RemoteSshAuthPromptV1['kind'] {
  return /are you sure you want to continue connecting|\(yes\/no(?:\/\[fingerprint\])?\)/iu.test(
    text
  )
    ? 'host-trust'
    : 'secret';
}

export class RemoteSshPromptBroker {
  private readonly sessions = new Map<string, PromptSession>();
  private readonly prompts = new Map<string, PromptWaiter>();

  async prepare(
    requestId: string,
    owner: WebContents,
    onCancel: () => void = () => {}
  ): Promise<boolean> {
    if (process.platform === 'win32') return false;
    if (!/^[a-zA-Z0-9_-]{8,128}$/u.test(requestId) || this.sessions.has(requestId)) {
      throw new Error('The interactive SSH request ID is invalid or already in use.');
    }
    const root = await mkdtemp('/tmp/dfs-ssh-');
    await chmod(root, 0o700);
    const socketPath = join(root, 'ask.sock');
    const token = randomBytes(24).toString('hex');
    const scriptPath = join(root, 'askpass.cjs');
    const wrapperPath = join(root, 'askpass.sh');
    const server = createServer();
    const sockets = new Set<Socket>();
    try {
      await writeFile(scriptPath, ASKPASS_SCRIPT, { mode: 0o600 });
      await writeFile(
        wrapperPath,
        '#!/bin/sh\nexec "$DNAFORGE_ASKPASS_NODE" "$DNAFORGE_ASKPASS_SCRIPT" "$@"\n',
        { mode: 0o700 }
      );
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        this.acceptPrompt(socket, { requestId, owner, token });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      const onDestroyed = (): void => {
        onCancel();
        void this.finish(requestId);
      };
      owner.once('destroyed', onDestroyed);
      this.sessions.set(requestId, {
        owner,
        root,
        server,
        token,
        sockets,
        onDestroyed,
        onCancel,
        cancelled: false,
        environment: {
          SSH_ASKPASS: wrapperPath,
          SSH_ASKPASS_REQUIRE: 'force',
          DISPLAY: process.env.DISPLAY || ':0',
          DNAFORGE_ASKPASS_NODE: process.execPath,
          DNAFORGE_ASKPASS_SCRIPT: scriptPath,
          DNAFORGE_ASKPASS_SOCKET: socketPath,
          DNAFORGE_ASKPASS_TOKEN: token,
          ELECTRON_RUN_AS_NODE: '1',
        },
      });
      return true;
    } catch (error) {
      server.close();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  environmentFor(requestId: string | undefined): NodeJS.ProcessEnv | null {
    return requestId ? (this.sessions.get(requestId)?.environment ?? null) : null;
  }

  respond(promptId: string, answer: string | null, ownerId: number): boolean {
    const prompt = this.prompts.get(promptId);
    if (!prompt || prompt.ownerId !== ownerId) return false;
    if (
      answer !== null &&
      (typeof answer !== 'string' || answer.length > MAX_ANSWER_LENGTH || /[\r\n\0]/u.test(answer))
    ) {
      return false;
    }
    this.dismissPrompt(promptId, prompt);
    prompt.socket.end(JSON.stringify({ answer }) + '\n');
    const session = this.sessions.get(prompt.requestId);
    if (answer === null && session && !session.cancelled) {
      session.cancelled = true;
      session.onCancel();
      void this.finish(prompt.requestId).catch(() => undefined);
    }
    return true;
  }

  async finish(requestId: string): Promise<void> {
    const session = this.sessions.get(requestId);
    if (!session) return;
    this.sessions.delete(requestId);
    session.owner.off('destroyed', session.onDestroyed);
    for (const [id, prompt] of this.prompts) {
      if (prompt.requestId === requestId) this.respond(id, null, prompt.ownerId);
    }
    for (const socket of session.sockets) socket.destroy();
    await new Promise<void>((resolve) => session.server.close(() => resolve()));
    await rm(session.root, { recursive: true, force: true });
  }

  private acceptPrompt(
    socket: Socket,
    input: { readonly requestId: string; readonly owner: WebContents; readonly token: string }
  ): void {
    let received = '';
    socket.setEncoding('utf8');
    const fail = (): void => {
      socket.destroy();
    };
    socket.on('error', fail);
    socket.on('data', (chunk: string) => {
      received += chunk;
      if (Buffer.byteLength(received, 'utf8') > MAX_PROMPT_BYTES) {
        fail();
        return;
      }
      const newline = received.indexOf('\n');
      if (newline < 0) return;
      socket.removeAllListeners('data');
      let value: { token?: unknown; prompt?: unknown };
      try {
        value = JSON.parse(received.slice(0, newline)) as typeof value;
      } catch {
        fail();
        return;
      }
      if (
        value.token !== input.token ||
        typeof value.prompt !== 'string' ||
        !value.prompt ||
        input.owner.isDestroyed() ||
        !this.sessions.has(input.requestId)
      ) {
        fail();
        return;
      }
      const promptId = randomUUID();
      const timer = setTimeout(
        () => this.respond(promptId, null, input.owner.id),
        PROMPT_TIMEOUT_MS
      );
      this.prompts.set(promptId, {
        ownerId: input.owner.id,
        owner: input.owner,
        requestId: input.requestId,
        socket,
        timer,
      });
      sendRendererIpc(input.owner, 'remoteGenomics:authPrompt', {
        promptId,
        requestId: input.requestId,
        text: value.prompt.slice(0, 4_096),
        kind: promptKind(value.prompt),
      });
    });
    socket.on('close', () => {
      for (const [id, prompt] of this.prompts) {
        if (prompt.socket !== socket) continue;
        this.dismissPrompt(id, prompt);
      }
    });
  }

  private dismissPrompt(promptId: string, prompt: PromptWaiter): void {
    this.prompts.delete(promptId);
    clearTimeout(prompt.timer);
    if (!prompt.owner.isDestroyed()) {
      sendRendererIpc(prompt.owner, 'remoteGenomics:authPromptClosed', promptId);
    }
  }
}

export const remoteSshPromptBroker = new RemoteSshPromptBroker();
