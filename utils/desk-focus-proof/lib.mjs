// Shared pieces of the Desk focus proof: the local page server, the macOS focus
// sampler, the labeled test browser and the observer extension feed.
// macOS only.

import { spawn, execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const proofDir = path.dirname(fileURLToPath(import.meta.url));
export const TITLE = 'Desk focus test';

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `desk-focus-test-${label}-`));
}

// ─── Page server ───────────────────────────────────────────────────────────

const personPage = `<!doctype html><html><head><meta charset="utf-8"><title>${TITLE} — person tab (keep me active)</title>
<style>body{font:16px system-ui;margin:24px;background:#fff8e1}h1{color:#b26a00}#log{font:12px ui-monospace,monospace;white-space:pre}</style></head>
<body><h1>${TITLE}: the person's tab</h1>
<p>This is a throwaway test browser. This tab must stay the active tab while agents work in their own tab groups.</p>
<input id="note" placeholder="the person types here" size="40" autofocus>
<div id="log"></div>
<script>
const events = [];
function rec(kind) { events.push({ t: Date.now(), kind, hasFocus: document.hasFocus(), visibility: document.visibilityState }); }
for (const k of ['focus', 'blur']) window.addEventListener(k, () => rec('window-' + k));
document.addEventListener('visibilitychange', () => rec('visibilitychange'));
let last = '';
setInterval(() => {
  const s = document.hasFocus() + ' ' + document.visibilityState;
  if (s !== last) { last = s; rec('sample-change'); }
}, 50);
setInterval(() => {
  const batch = events.splice(0);
  fetch('/report', { method: 'POST', body: JSON.stringify({ page: 'person', t: Date.now(), hasFocus: document.hasFocus(), visibility: document.visibilityState, activeElement: document.activeElement && document.activeElement.id, events: batch }) }).catch(() => {});
  document.getElementById('log').textContent = new Date().toISOString() + '  hasFocus=' + document.hasFocus() + '  visibility=' + document.visibilityState;
}, 200);
rec('load');
</script></body></html>`;

function agentPage(name, n) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${TITLE} — agent ${name} page ${n}</title>
<style>body{font:16px system-ui;margin:24px;background:#e8f4ff}h1{color:#0b5cad}#editor{border:1px solid #888;min-height:40px;padding:6px;background:#fff}#stats{font:12px ui-monospace,monospace;white-space:pre}</style></head>
<body><h1>${TITLE}: agent ${name}, page ${n}</h1>
<p>Agent pages live in hidden tabs. Everything below must still work.</p>
<label>Text field <input id="field" aria-label="Text field"></label>
<button id="go" onclick="clicks++;document.getElementById('clicked').textContent='Clicked ' + clicks">Press me</button>
<span id="clicked">Not clicked</span>
<p>Rich editor:</p><div id="editor" contenteditable="true" aria-label="Rich editor"></div>
<p id="focusinfo">focus events: none</p>
<div id="stats"></div>
<script>
let clicks = 0, ticks = 0, frames = 0, focusEvents = [], keydowns = 0;
const t0 = Date.now();
setInterval(() => ticks++, 100);
(function raf() { frames++; requestAnimationFrame(raf); })();
for (const id of ['field', 'editor']) {
  const el = document.getElementById(id);
  el.addEventListener('focus', () => { focusEvents.push(id + ':focus'); document.getElementById('focusinfo').textContent = 'focus events: ' + focusEvents.join(', '); });
  el.addEventListener('keydown', () => keydowns++);
}
window.deskState = () => ({
  name: ${JSON.stringify(name)}, page: ${n}, hasFocus: document.hasFocus(), visibility: document.visibilityState,
  activeElement: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
  field: document.getElementById('field').value, editor: document.getElementById('editor').innerText,
  clicks, keydowns, focusEvents: focusEvents.slice(),
  secondsAlive: (Date.now() - t0) / 1000, intervalTicks: ticks, expectedTicks: Math.floor((Date.now() - t0) / 100), animationFrames: frames,
});
setInterval(() => {
  document.getElementById('stats').textContent = JSON.stringify(window.deskState(), null, 1);
  fetch('/report', { method: 'POST', body: JSON.stringify({ page: 'agent', t: Date.now(), state: window.deskState() }) }).catch(() => {});
}, 250);
</script></body></html>`;
}

export async function startServer(fixedPort = 0) {
  const feed = { person: [], agent: [], observer: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          data.receivedAt = Date.now();
          if (url.pathname === '/observe')
            feed.observer.push(data);
          else if (url.pathname === '/report')
            (data.page === 'person' ? feed.person : feed.agent).push(data);
        } catch {}
        res.end('ok');
      });
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/person')
      return res.end(personPage);
    if (url.pathname === '/agent')
      return res.end(agentPage(url.searchParams.get('name') || '?', +(url.searchParams.get('n') || 1)));
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise(r => server.listen(fixedPort, '127.0.0.1', r));
  const port = server.address().port;
  return { server, port, feed, url: p => `http://127.0.0.1:${port}${p}` };
}

// ─── Focus sampler ─────────────────────────────────────────────────────────

export const isMac = process.platform === 'darwin';
export const isWin = process.platform === 'win32';

function powershell(script, args = [], options = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(proofDir, script), ...args], { encoding: 'utf8', ...options });
}

// Returns the command that starts the sampler: a compiled Swift program on
// macOS, a PowerShell script on Windows.
export function compileSampler(dir) {
  if (isWin)
    return { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(proofDir, 'focus-sampler-win.ps1')] };
  const out = path.join(dir, 'focus-sampler');
  execFileSync('swiftc', ['-O', path.join(proofDir, 'focus-sampler.swift'), '-o', out], { stdio: 'inherit' });
  return { command: out, args: [] };
}

export function startSampler(sampler, intervalMs = 50) {
  const proc = spawn(sampler.command, [...sampler.args, String(intervalMs)], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  readline.createInterface({ input: proc.stdout }).on('line', l => {
    try { lines.push(JSON.parse(l)); } catch {}
  });
  return {
    lines,
    watch(pids) { proc.stdin.write(`watch ${pids.join(',')}\n`); },
    stop() { proc.stdin.end(); if (isWin) proc.kill(); },
  };
}

// `lsappinfo front` cross-check (macOS only).
export async function lsappinfoFront() {
  const asn = await new Promise(r => execFile('/usr/bin/lsappinfo', ['front'], (e, so) => r((so || '').trim())));
  const info = await new Promise(r => execFile('/usr/bin/lsappinfo', ['info', '-only', 'pid', asn], (e, so) => r((so || '').trim())));
  const m = info.match(/"pid"=(\d+)/) || info.match(/pid\s*=\s*(\d+)/);
  return { t: Date.now(), asn, pid: m ? +m[1] : undefined };
}

export function startLsappinfoLoop(intervalMs = 150) {
  const lines = [];
  let stopped = !isMac;
  const done = (async () => {
    while (!stopped) {
      lines.push(await lsappinfoFront());
      await sleep(intervalMs);
    }
  })();
  return { lines, async stop() { stopped = true; await done; } };
}

// ─── Screens ───────────────────────────────────────────────────────────────

export function screenshotScreen(file) {
  try {
    if (isWin)
      powershell('win-helpers.ps1', ['screenshot', file], { timeout: 30000 });
    else
      execFileSync('/usr/sbin/screencapture', ['-x', '-t', 'png', file], { timeout: 20000 });
    return fs.existsSync(file) ? file : undefined;
  } catch (e) {
    return undefined;
  }
}

// Captures one window by its CoreGraphics id, even when other windows cover it (macOS).
export function screenshotWindow(windowId, file) {
  if (!isMac)
    return undefined;
  try {
    execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-l', String(windowId), '-t', 'png', file], { timeout: 20000 });
    return file;
  } catch (e) {
    return undefined;
  }
}

export function browserWindowIds(pid) {
  if (!isMac)
    return [];
  const script = `
import CoreGraphics
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list where (w[kCGWindowOwnerPID as String] as? Int) == ${pid} && (w[kCGWindowLayer as String] as? Int) == 0 {
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  if let h = b["Height"] as? Double, h > 200 { print(w[kCGWindowNumber as String] as? Int ?? 0) }
}`;
  try {
    return execFileSync('swift', ['-e', script], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

// ─── The person's other app ────────────────────────────────────────────────

// Starts a small labeled app and brings it to the front, standing in for the
// app the person is working in. Only used on test machines (CI runners).
export async function startPersonApp(dir) {
  if (isWin) {
    const child = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
    await sleep(2000);
    console.log('person app:', powershell('win-helpers.ps1', ['front', String(child.pid)]).trim());
    await sleep(500);
    return { pid: child.pid, name: 'notepad', stop: () => { try { process.kill(child.pid); } catch {} } };
  }
  const app = path.join(dir, 'Desk focus test person.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.ourostack.desk-focus-test-person</string>
<key>CFBundleName</key><string>Desk focus test person</string>
<key>CFBundleExecutable</key><string>person</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>`);
  execFileSync('swiftc', ['-O', path.join(proofDir, 'person-app.swift'), '-o', path.join(app, 'Contents', 'MacOS', 'person')], { stdio: 'inherit' });
  execFileSync('/usr/bin/open', ['-n', '-a', app]);
  let pid;
  for (let i = 0; i < 100 && !pid; i++) {
    await sleep(100);
    const out = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    const line = out.split('\n').find(l => l.includes(path.join(app, 'Contents', 'MacOS', 'person')));
    pid = line ? +line.trim().split(/\s+/)[0] : undefined;
  }
  await sleep(1000);
  return { pid, name: 'Desk focus test person', stop: () => { try { process.kill(pid); } catch {} } };
}

// Brings the test browser to the front, for the run where the person works
// in the browser itself. Only used on test machines (CI runners).
export async function bringBrowserToFront(browser) {
  if (isWin)
    console.log('browser:', powershell('win-helpers.ps1', ['front', String(browser.pid)]).trim());
  else
    execFileSync('/usr/bin/open', ['-a', browser.app]);
  await sleep(1000);
}

// ─── Test browser ──────────────────────────────────────────────────────────

export function prepareObserverExtension(dir, port) {
  const target = path.join(dir, 'observer-extension');
  fs.cpSync(path.join(proofDir, 'observer-extension'), target, { recursive: true });
  fs.writeFileSync(path.join(target, 'config.js'), `self.DESK_FOCUS_TEST_PORT = ${port};\n`);
  return target;
}

function appBundleOf(executable) {
  const i = executable.indexOf('.app/');
  return i === -1 ? undefined : executable.slice(0, i + 4);
}

// Starts the test browser without a startup window (its first window would be
// shown in front) and opens one window in the background over CDP. On macOS
// it goes through `open -g -n`, so Launch Services does not activate it.
export async function launchTestBrowser({ executable, userDataDir, extensions, startUrl, extraArgs = [], noStartupWindow = false }) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--password-store=basic',
    `--window-name=${TITLE}`,
    '--window-size=1100,760',
    '--window-position=60,60',
    ...(extensions.length ? [`--disable-extensions-except=${extensions.join(',')}`, `--load-extension=${extensions.join(',')}`] : []),
    ...extraArgs,
    ...(noStartupWindow ? ['--no-startup-window'] : [startUrl]),
  ];
  let pid;
  const app = appBundleOf(executable);
  if (isMac) {
    execFileSync('/usr/bin/open', ['-g', '-n', '-a', app, '--args', ...args]);
  } else {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore' });
    child.unref();
    pid = child.pid;
  }
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < 600 && !fs.existsSync(portFile); i++)
    await sleep(100);
  await sleep(200);
  const [port] = fs.readFileSync(portFile, 'utf8').split('\n');
  pid ??= findBrowserPid(userDataDir);
  if (noStartupWindow) {
    // A window created through the DevTools protocol with background: true is
    // shown without activating the browser.
    const c = await cdp(+port);
    await c.send('Target.createTarget', { url: startUrl, newWindow: true, background: true });
    c.close();
  }
  return { pid, devtoolsPort: +port, app, args };
}

export function findBrowserPid(userDataDir) {
  const out = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  for (const line of out.split('\n')) {
    if (line.includes(`--user-data-dir=${userDataDir}`) && !line.includes('--type=')) {
      const pid = +line.trim().split(/\s+/)[0];
      if (pid)
        return pid;
    }
  }
  return undefined;
}

export function quitBrowser(pid) {
  try { process.kill(pid, 'SIGTERM'); } catch {}
}

// Minimal CDP client over the browser's DevTools port, used only for setup
// (reading the extension token from a page opened in the background).
export async function cdp(port) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method)
      listeners.filter(l => l.method === m.method).forEach(l => l.fn(m.params, m.sessionId));
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
  return { send, on: (method, fn) => listeners.push({ method, fn }), close: () => ws.close() };
}

export const playwrightExtensionId = 'mmlmfjhmonkocbjadbfplnigmagldckm';

export async function readExtensionToken(devtoolsPort) {
  const c = await cdp(devtoolsPort);
  try {
    const { targetId } = await c.send('Target.createTarget', { url: `chrome-extension://${playwrightExtensionId}/status.html`, background: true });
    const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    let token;
    for (let i = 0; i < 100 && !token; i++) {
      await sleep(100);
      const r = await c.send('Runtime.evaluate', { expression: `localStorage.getItem('auth-token')`, returnByValue: true }, sessionId).catch(() => undefined);
      token = r?.result?.value;
    }
    await c.send('Target.closeTarget', { targetId });
    return token;
  } finally {
    c.close();
  }
}
