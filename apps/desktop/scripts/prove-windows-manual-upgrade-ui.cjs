const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const asar = require('@electron/asar');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class InstalledWindow {
  constructor(socket) {
    this.socket = socket; this.nextId = 1; this.pending = new Map();
    socket.addEventListener('message', event => {
      const response = JSON.parse(event.data);
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id); clearTimeout(request.timer);
      response.error ? request.reject(new Error(JSON.stringify(response.error))) : request.resolve(response.result);
    });
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Installed window connection closed')); }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Installed window connection timed out')); }, 30_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Installed window connection failed')); }, { once: true });
    });
    return new InstalledWindow(socket);
  }
  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Installed window command timed out: ${method}`)); }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async element(selector, text = null) {
    return this.evaluate(`(() => {
      const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(item => ${JSON.stringify(text)} === null || item.textContent.includes(${JSON.stringify(text)}));
      if (!element) return null;
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none', ariaHidden: element.getAttribute('aria-hidden'), x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
  }
  async waitVisible(selector, text = null) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const element = await this.element(selector, text);
      if (element?.visible) return element;
      await delay(250);
    }
    throw new Error(`Shipped UI control is not visible: ${selector} ${text || ''}`);
  }
  async click(selector, text = null, double = false) {
    await this.waitVisible(selector, text);
    await this.evaluate(`(() => { [...document.querySelectorAll(${JSON.stringify(selector)})].find(item => ${JSON.stringify(text)} === null || item.textContent.includes(${JSON.stringify(text)})).scrollIntoView({ block: 'nearest' }); })()`);
    const element = await this.waitVisible(selector, text);
    const viewport = await this.evaluate('({ width: innerWidth, height: innerHeight })');
    if (element.x < 0 || element.y < 0 || element.x >= viewport.width || element.y >= viewport.height) throw new Error('Control is outside the visible installed window');
    await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: element.x, y: element.y });
    for (let count = 1; count <= (double ? 2 : 1); count++) {
      await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: element.x, y: element.y, button: 'left', buttons: 1, clickCount: count });
      await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: element.x, y: element.y, button: 'left', buttons: 0, clickCount: count });
    }
  }
  async screenshot(filename) {
    const { data } = await this.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(filename, Buffer.from(data, 'base64'));
  }
  close() { this.socket.close(); }
}

async function main() {
  const [executable, profile, workspace, evidence, expectedVersion] = process.argv.slice(2);
  if (!process.env.GITHUB_ACTIONS || process.platform !== 'win32') throw new Error('Requires a disposable Windows Actions runner');
  fs.mkdirSync(evidence, { recursive: true }); fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, NODE_ENV: 'test', WAYPOINT_TEST: '1', WAYPOINT_UPDATER_DISABLE_AUTODOWNLOAD: '1', DNAFORGE_OFFLINE_ANNOTATION: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const port = 19310;
  const child = spawn(executable, [`--user-data-dir=${profile}`, `--workspace=${workspace}`, `--remote-debugging-port=${port}`, '--disable-gpu', '--no-sandbox'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(evidence, 'application.log'));
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let page;
  try {
    const deadline = Date.now() + 180_000;
    let target, version;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Installed app exited: ${child.exitCode}`);
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = targets.find(item => item.type === 'page' && item.url.startsWith('file:'));
        if (target) { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
      } catch {}
      await delay(250);
    }
    if (!target) throw new Error('Installed app window was not exposed');
    fs.writeFileSync(path.join(evidence, 'debugger-target.json'), JSON.stringify({ target, version }, null, 2));
    page = await InstalledWindow.connect(target.webSocketDebuggerUrl);
    await page.waitVisible('#root');
    fs.writeFileSync(path.join(evidence, 'initial-body.txt'), await page.evaluate('document.body.innerText'));
    await page.screenshot(path.join(evidence, 'initial.png'));
    const welcome = await page.evaluate(`(() => { const item = [...document.querySelectorAll('button,[role="button"]')].find(button => /get started|continue locally|skip for now|^continue$/i.test(button.innerText.trim()) && button.getBoundingClientRect().width > 0); return item?.innerText || null; })()`);
    if (welcome) { await page.click('button,[role="button"]', welcome); await delay(500); }
    await page.waitVisible('[data-testid="files-button"]');
    const sidebar = await page.element('[data-testid="files-sidebar"]');
    if (!sidebar?.visible || sidebar.ariaHidden === 'true') await page.click('[data-testid="files-button"]');
    await page.click('[data-testid="file-tree-item"]', 'manual-upgrade-sequence.fasta', true);
    await page.waitVisible('[data-testid="sequence-loaded"]');
    await page.screenshot(path.join(evidence, 'sequence-open.png'));
    const archive = path.join(path.dirname(executable), 'resources', 'app.asar');
    const appVersion = JSON.parse(asar.extractFile(archive, 'package.json')).version;
    if (appVersion !== expectedVersion) throw new Error(`Wrong running app payload: ${appVersion}`);
    const actualExecutable = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}').ExecutablePath`], { encoding: 'utf8' }).trim();
    if (actualExecutable.toLowerCase() !== path.resolve(executable).toLowerCase()) throw new Error('Wrong executable process');
    const receipt = { version: appVersion, pid: child.pid, actualExecutable, appAsarSha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), sequenceOpenedThroughFiles: true, file: 'manual-upgrade-sequence.fasta', shippedRenderer: await page.evaluate('typeof window.__test === "undefined"'), trustedMouseInput: true, normalQuit: false };
    const save = () => fs.writeFileSync(path.join(evidence, 'ui-receipt.json'), JSON.stringify(receipt, null, 2));
    save();
    await page.evaluate('window.close()').catch(error => { if (!/closed|context|target/i.test(error.message)) throw error; });
    page.close(); page = null;
    const exitDeadline = Date.now() + 90_000;
    while (child.exitCode === null && Date.now() < exitDeadline) await delay(250);
    if (child.exitCode !== 0) throw new Error(`Application did not quit successfully: ${child.exitCode}`);
    receipt.normalQuit = true; receipt.normalQuitExitCode = child.exitCode; save();
  } catch (error) {
    console.error('Packaged UI failure:', error.stack || error);
    if (page) {
      fs.writeFileSync(path.join(evidence, 'failure-body.txt'), await page.evaluate('document.body.innerText').catch(() => 'Unavailable'));
      await page.screenshot(path.join(evidence, 'failure.png')).catch(() => {});
    }
    throw error;
  } finally {
    page?.close();
    if (child.exitCode === null) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'pipe' }); }
      catch (error) { console.error('Owned-process cleanup:', error.message); }
    }
    log.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
