// Experiment: does the fork's extension hand the window back to the user's tab
// when a connect page with a token is opened through the browser's command
// line, both when its service worker is asleep and when it is awake?
//
// Usage: node connect-restore.mjs <playwright checkout> <browser executable> <out.json> [idle-seconds]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as lib from '../lib.mjs';

const [playwrightDir, executable, outFile, idleSeconds = '40'] = process.argv.slice(2);
const tmp = lib.makeTempDir('connect-restore');
const userDataDir = path.join(tmp, 'profile');
const pwExtension = path.join(tmp, 'playwright-extension');
fs.cpSync(path.join(playwrightDir, 'packages/extension/dist'), pwExtension, { recursive: true });
const { port, feed, url, server } = await lib.startServer(process.env.DESK_DIAG ? 47123 : 0);
const observer = lib.prepareObserverExtension(tmp, port);
const browser = await lib.launchTestBrowser({ executable, userDataDir, extensions: [pwExtension, observer], startUrl: url('/person'), noStartupWindow: true });
await lib.sleep(4000);
const token = await lib.readExtensionToken(browser.devtoolsPort);
const runs = [];

async function openConnect(label) {
  const u = new URL(`chrome-extension://${lib.playwrightExtensionId}/connect.html`);
  // No relay listens here; the page only needs to exist.
  u.searchParams.set('mcpRelayUrl', 'ws://127.0.0.1:9/extension/none');
  u.searchParams.set('client', JSON.stringify({ name: label }));
  u.searchParams.set('protocolVersion', '2');
  u.searchParams.set('token', token);
  const t = Date.now();
  spawn(executable, [`--user-data-dir=${userDataDir}`, u.toString()], { detached: true, stdio: 'ignore' }).unref();
  await lib.sleep(4000);
  const events = feed.observer.filter(o => o.t >= t && (o.kind === 'tabActivated' || o.kind === 'tabCreated'));
  const created = events.find(e => e.kind === 'tabCreated');
  const restored = events.find(e => e.kind === 'tabActivated' && created && e.tabId !== created.id);
  runs.push({ label, createdActive: created?.active, restoredAfterMs: restored && created ? restored.t - created.t : null, events: events.map(e => ({ dt: e.t - t, kind: e.kind, id: e.id ?? e.tabId, active: e.active })) });
  console.log(JSON.stringify(runs[runs.length - 1]));
}

console.log(`waiting ${idleSeconds}s so the extension's service worker goes idle`);
await lib.sleep(+idleSeconds * 1000);
await openConnect('cold service worker');
await openConnect('warm service worker');
await lib.sleep(+idleSeconds * 1000);
await openConnect('cold service worker again');
const diag = feed.observer.filter(o => o.kind === 'diag');
if (diag.length)
  console.log(JSON.stringify(diag));
lib.quitBrowser(browser.pid);
server.close();
fs.writeFileSync(outFile, JSON.stringify({ executable, playwrightDir, runs, diag }, null, 1));
process.exit(0);
