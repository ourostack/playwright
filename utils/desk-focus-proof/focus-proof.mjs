// Desk focus proof: two agents work through Playwright's MCP tool and its
// browser extension in a visible, labeled test browser while a "person" tab
// stays active. Passes only if the browser never comes forward, the active
// tab never changes, the Space never changes and every agent action works.
//
// macOS only. Usage:
//   node focus-proof.mjs --playwright <playwright checkout, built> --browser <browser executable> \
//        [--label after] [--out <dir>] [--rounds 2]
//
// The checkout must be built (`npm ci && npm run build`); the extension is
// taken from <checkout>/packages/extension/dist and the MCP server from
// <checkout>/packages/playwright-core/lib/entry/mcp.js.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as lib from './lib.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const playwrightDir = path.resolve(arg('playwright', ''));
const executable = arg('browser');
const label = arg('label', 'run');
// other-app: the person works in another app and the browser stays behind it.
// browser-front: the person works in the test browser's own tab.
const scenario = arg('scenario', 'other-app');
const rounds = +arg('rounds', '2');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve(arg('out', path.join(lib.proofDir, '..', 'evidence', `${label}-${stamp}`)));
if (!fs.existsSync(path.join(playwrightDir, 'packages/extension/dist/manifest.json')) || !executable) {
  console.error('usage: node focus-proof.mjs --playwright <built checkout> --browser <executable> [--label name] [--out dir]');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const requireFromPw = createRequire(path.join(playwrightDir, 'package.json'));
const { Client } = await import(pathToFileURL(requireFromPw.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(requireFromPw.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const tmp = lib.makeTempDir(label);
const userDataDir = path.join(tmp, 'profile');
const pwExtension = path.join(tmp, 'playwright-extension');
fs.cpSync(path.join(playwrightDir, 'packages/extension/dist'), pwExtension, { recursive: true });
const personApp = scenario === 'other-app' && process.env.DESK_FOCUS_PERSON_APP !== 'none' ? await lib.startPersonApp(tmp) : undefined;
let gitHead = '';
try { gitHead = execFileSync('git', ['-C', playwrightDir, 'log', '-1', '--format=%H %s'], { encoding: 'utf8' }).trim(); } catch {}

const { server, port, feed, url } = await lib.startServer();
const observerExtension = lib.prepareObserverExtension(tmp, port);
const sampler = lib.startSampler(lib.compileSampler(tmp), 50);
const lsappinfo = lib.startLsappinfoLoop(150);
const screens = [];
const shot = (name, fn) => { const f = fn(path.join(outDir, name)); if (f) screens.push(path.basename(f)); return f; };

shot('screen-1-before.png', lib.screenshotScreen);
log('starting test browser', executable);
const browser = await lib.launchTestBrowser({ executable, userDataDir, extensions: [pwExtension, observerExtension], startUrl: url('/person'), noStartupWindow: true });
sampler.watch([browser.pid]);
log('browser pid', browser.pid, 'devtools port', browser.devtoolsPort);

// Wait for the person tab and the observer to report.
let personTab, personWindow;
for (let i = 0; i < 1200 && !personTab; i++) {
  await lib.sleep(100);
  const state = [...feed.observer].reverse().find(o => o.kind === 'state');
  const isPerson = t => t.url?.endsWith('/person') || t.title?.startsWith('Desk focus test — person tab');
  const w = state?.windows.find(w => w.tabs.some(t => isPerson(t) && t.active));
  if (w) {
    personWindow = w.id;
    personTab = w.tabs.find(isPerson).id;
  }
  // The observer reports full state only on tab events, and its first report can
  // come before the tab has a URL. Once the person page itself reports, the
  // only window's active tab is the person tab.
  const tick = [...feed.observer].reverse().find(o => o.kind === 'tick');
  if (!personTab && i >= 50 && feed.person.length && tick?.windows.length === 1 && state?.windows.length === 1 && state.windows[0].tabs.length === 1) {
    personWindow = tick.windows[0].id;
    personTab = tick.windows[0].activeTab;
  }
}
function abort(message) {
  console.error(message);
  console.error('observer reports:', JSON.stringify(feed.observer.slice(-3)).slice(0, 2000));
  console.error('person reports:', feed.person.length);
  console.error('latest observer state:', JSON.stringify([...feed.observer].reverse().find(o => o.kind === 'state')));
  fs.writeFileSync(path.join(outDir, 'raw-observer.jsonl'), feed.observer.map(l => JSON.stringify(l)).join('\n'));
  fs.writeFileSync(path.join(outDir, 'raw-sampler.jsonl'), sampler.lines.map(l => JSON.stringify(l)).join('\n'));
  shot('screen-abort.png', lib.screenshotScreen);
  sampler.stop();
  void lsappinfo.stop();
  lib.quitBrowser(browser.pid);
  personApp?.stop();
  process.exit(1);
}
if (!personTab)
  abort('person tab never reported by the observer extension');
const token = await lib.readExtensionToken(browser.devtoolsPort).catch(e => abort(`could not read the Playwright extension token: ${e}`));
if (!token)
  abort('could not read the Playwright extension token');
await lib.sleep(1500);
if (scenario === 'browser-front')
  await lib.bringBrowserToFront(browser);
const personAppPid = scenario === 'browser-front' ? browser.pid : personApp?.pid;
const windowIds = lib.browserWindowIds(browser.pid);
log('person tab', personTab, 'window', personWindow, 'cg windows', windowIds);

// ─── Agents ────────────────────────────────────────────────────────────────

const actions = [];
const mcpEntry = path.join(playwrightDir, 'packages/playwright-core/lib/entry/mcp.js');

async function startAgent(name) {
  const agentDir = path.join(outDir, `agent-${name}`);
  fs.mkdirSync(agentDir, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry, '--extension', '--executable-path', executable, '--user-data-dir', userDataDir, '--caps=devtools', '--timeout-action=30000', '--image-responses=omit'],
    cwd: agentDir,
    env: { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', d => stderr += d.toString());
  const client = new Client({ name: `${lib.TITLE} agent ${name}`, version: '1.0.0' });
  await client.connect(transport);
  return { name, client, agentDir, stderr: () => stderr };
}

function textOf(result) {
  return (result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
}

async function call(agent, tool, args, check) {
  const entry = { agent: agent.name, tool, args, start: Date.now() };
  try {
    const result = await agent.client.callTool({ name: tool, arguments: args }, undefined, { timeout: 180000 });
    entry.text = textOf(result).slice(0, 4000);
    entry.ok = !result.isError;
    if (entry.ok && check) {
      const problem = check(entry.text);
      if (problem) {
        entry.ok = false;
        entry.error = problem;
      }
    }
    if (result.isError)
      entry.error = entry.text.slice(0, 800);
  } catch (e) {
    entry.ok = false;
    entry.error = String(e?.message || e);
  }
  entry.end = Date.now();
  actions.push(entry);
  log(agent.name, tool, entry.ok ? 'ok' : `FAILED: ${entry.error?.slice(0, 200)}`, `${entry.end - entry.start}ms`);
  return entry;
}

function stateCheck(expect) {
  return text => {
    const m = text.match(/\{[^]*"name"[^]*\}/);
    if (!m)
      return 'no page state in result';
    let s;
    try { s = JSON.parse(m[0]); } catch { return 'unparsable page state'; }
    for (const [k, v] of Object.entries(expect)) {
      const actual = s[k];
      const good = typeof v === 'function' ? v(actual) : actual === v;
      if (!good)
        return `page state ${k}=${JSON.stringify(actual)} does not match`;
    }
    return undefined;
  };
}

async function runAgent(agent, round) {
  const n = agent.name;
  const p1 = url(`/agent?name=${n}&n=1`);
  const p2 = url(`/agent?name=${n}&n=2`);
  if (round === 1) {
    await call(agent, 'browser_navigate', { url: p1 });
  } else {
    await call(agent, 'browser_tabs', { action: 'select', index: 0 });
    await call(agent, 'browser_navigate', { url: p1 });
  }
  await call(agent, 'browser_snapshot', {}, t => t.includes('Press me') ? undefined : 'snapshot misses the button');
  await call(agent, 'browser_click', { element: 'Press me button', target: '#go' });
  await call(agent, 'browser_type', { element: 'Text field', target: '#field', text: `hello from ${n}` });
  await call(agent, 'browser_type', { element: 'Rich editor', target: '#editor', text: `${n} typed this`, slowly: true });
  await call(agent, 'browser_evaluate', { function: '() => window.deskState()' }, stateCheck({
    clicks: 1, field: `hello from ${n}`, editor: v => typeof v === 'string' && v.includes(`${n} typed this`), keydowns: v => v >= 5,
  }));
  await call(agent, 'browser_take_screenshot', { filename: `agent-${n}-round${round}-page1.png` }, t => /png/.test(t) ? undefined : 'no screenshot file');
  if (round === 1)
    await call(agent, 'browser_tabs', { action: 'new', url: p2 });
  else
    await call(agent, 'browser_tabs', { action: 'select', index: 1 });
  await call(agent, 'browser_type', { element: 'Text field', target: '#field', text: `page two from ${n}`, slowly: true });
  await call(agent, 'browser_take_screenshot', { filename: `agent-${n}-round${round}-page2.png` }, t => /png/.test(t) ? undefined : 'no screenshot file');
  await call(agent, 'browser_tabs', { action: 'select', index: 0 });
  await call(agent, 'browser_evaluate', { function: '() => window.deskState()' }, stateCheck({ page: 1, field: `hello from ${n}` }));
  await call(agent, 'browser_tabs', { action: 'select', index: 1 });
  await call(agent, 'browser_evaluate', { function: '() => window.deskState()' }, stateCheck({ page: 2, field: v => typeof v === 'string' && v.endsWith(`page two from ${n}`) }));
  if (n === 'A') {
    await call(agent, 'browser_start_recording', {});
    await call(agent, 'browser_stop_recording', {});
  }
  await call(agent, 'browser_tabs', { action: 'list' }, t => t.includes(`agent ${n} page 2`) ? undefined : 'tab list misses page 2');
}

const tStart = Date.now();
log('measurement starts');
const agents = [];
let midShot;
try {
  const [a, b] = await Promise.all([
    startAgent('A'),
    lib.sleep(1500).then(() => startAgent('B')),
  ]);
  agents.push(a, b);
  for (let round = 1; round <= rounds; round++) {
    await Promise.all([runAgent(a, round), lib.sleep(700).then(() => runAgent(b, round))]);
    if (round === 1) {
      midShot = shot('screen-2-during.png', lib.screenshotScreen);
      for (const id of windowIds)
        shot(`test-window-${id}-during.png`, f => lib.screenshotWindow(id, f));
    }
  }
} catch (e) {
  actions.push({ agent: '-', tool: 'setup', ok: false, error: String(e?.stack || e), start: Date.now(), end: Date.now() });
  log('error', e);
}
const tEnd = Date.now();
log('measurement ends');
await lib.sleep(1000);
for (const id of lib.browserWindowIds(browser.pid))
  shot(`test-window-${id}-with-tab-groups.png`, f => lib.screenshotWindow(id, f));
shot('screen-3-after.png', lib.screenshotScreen);

const groupsSeen = [...feed.observer].reverse().find(o => o.kind === 'state')?.groups ?? [];
for (const agent of agents) {
  fs.writeFileSync(path.join(agent.agentDir, 'mcp-stderr.txt'), agent.stderr());
  await agent.client.close().catch(() => {});
}
await lib.sleep(1000);
sampler.stop();
await lsappinfo.stop();
lib.quitBrowser(browser.pid);
personApp?.stop();
server.close();

// ─── Verdict ───────────────────────────────────────────────────────────────

const inWindow = t => t >= tStart && t <= tEnd + 1000;
const bpid = browser.pid;
const samples = sampler.lines.filter(l => l.kind === 'sample' && inWindow(l.t));
const frontSamples = scenario === 'browser-front' ? [] : samples.filter(l => l.front?.pid === bpid);
const awaySamples = personAppPid ? samples.filter(l => l.front?.pid !== personAppPid) : [];
const raisedSamples = scenario === 'browser-front' || !lib.isMac ? [] : samples.filter(l => l.topWindowPid === bpid);
const activations = sampler.lines.filter(l => l.kind === 'activate' && inWindow(l.t));
const browserActivations = scenario === 'browser-front' ? [] : activations.filter(l => l.app?.pid === bpid);
const spaceEvents = sampler.lines.filter(l => l.kind === 'space' && inWindow(l.t));
// The active Space follows the display of the app in front, so the person
// switching apps across displays changes it too. Only a change that comes
// with the test browser in front counts against it.
const spaceChanges = [];
for (let i = 1; i < samples.length; i++) {
  if (samples[i].space !== samples[i - 1].space)
    spaceChanges.push({ t: samples[i].t, from: samples[i - 1].space, to: samples[i].space, front: samples[i].front?.name, frontPid: samples[i].front?.pid });
}
const browserSpaceChanges = spaceChanges.filter(c => c.frontPid === bpid).concat(spaceEvents.filter(e => samples.some(s => Math.abs(s.t - e.t) < 200 && s.front?.pid === bpid)));
const lsFront = lsappinfo.lines.filter(l => inWindow(l.t));
const lsBrowserFront = lsFront.filter(l => scenario === 'browser-front' ? l.pid !== bpid : l.pid === bpid);
const obs = feed.observer.filter(o => inWindow(o.t));
// Connecting opens the extension's connect page through the browser's command
// line. Report that phase separately from the agents' work.
const firstNavigations = ['A', 'B'].map(n => actions.find(a => a.agent === n && a.tool === 'browser_navigate')).filter(Boolean);
const tConnected = firstNavigations.length ? Math.max(...firstNavigations.map(a => a.end)) : tEnd;
const inWork = t => t > tConnected && t <= tEnd + 1000;
const inConnect = t => t >= tStart && t <= tConnected;
const tabActivations = obs.filter(o => o.kind === 'tabActivated' && o.windowId === personWindow && o.tabId !== personTab);
const otherWindowActivations = obs.filter(o => o.kind === 'tabActivated' && o.windowId !== personWindow);
const wrongPolls = obs.filter(o => (o.kind === 'tick' || o.kind === 'state') && o.windows.some(w => w.id === personWindow && w.activeTab !== personTab));
const allPolls = obs.filter(o => o.kind === 'tick' || o.kind === 'state');
const activeTabChanges = tabActivations;
const windowFocusEvents = obs.filter(o => o.kind === 'windowFocusChanged' && o.windowId !== -1);
const tabsCreatedActive = obs.filter(o => o.kind === 'tabCreated' && o.active);
const personReports = feed.person.filter(p => inWindow(p.t));
const personEvents = personReports.flatMap(p => p.events || []).filter(e => inWindow(e.t));
const personChangeEvents = personEvents.filter(e => e.kind === 'visibilitychange' || e.kind === 'window-blur');
const failedActions = actions.filter(a => !a.ok);
const windowsEverOpen = new Set(obs.filter(o => o.kind === 'state').flatMap(o => o.windows.map(w => w.id)));
// How long the person's tab was not the active tab, from activation events.
function hiddenSpans(filter) {
  const spans = [];
  let since;
  for (const o of obs.filter(o => o.kind === 'tabActivated' && o.windowId === personWindow)) {
    if (o.tabId !== personTab && since === undefined)
      since = o.t;
    else if (o.tabId === personTab && since !== undefined) {
      spans.push({ from: since, ms: o.t - since });
      since = undefined;
    }
  }
  if (since !== undefined)
    spans.push({ from: since, ms: tEnd - since, open: true });
  return spans.filter(s => filter(s.from));
}
const connectSpans = hiddenSpans(inConnect);
const workSpans = hiddenSpans(inWork);
const count = (xs, f) => xs.filter(x => f(x.t)).length;

const checks = [
  ...(personAppPid ? [{ name: `The person's app (${scenario === 'browser-front' ? 'the test browser' : personApp?.name}, pid ${personAppPid}) stayed the frontmost app`, required: true, pass: awaySamples.length === 0, detail: `${awaySamples.length} of ${samples.length} samples had another app in front${awaySamples.length ? ': ' + [...new Set(awaySamples.map(s => s.front?.name + ' ' + s.front?.pid))].join(', ') : ''}` }] : []),
  { name: 'Browser never became the frontmost app (focus samples and activation events)', required: true, pass: frontSamples.length === 0 && browserActivations.length === 0, detail: `${frontSamples.length} of ${samples.length} samples, ${browserActivations.length} activation events` },
  { name: scenario === 'browser-front' ? 'Browser stayed the frontmost app (lsappinfo front)' : 'Browser never became the frontmost app (lsappinfo front)', required: lib.isMac, pass: lsBrowserFront.length === 0, detail: `${lsBrowserFront.length} of ${lsFront.length} lsappinfo samples` },
  { name: 'Browser window never rose to the top of the screen', required: lib.isMac && scenario !== 'browser-front', pass: raisedSamples.length === 0, detail: `${raisedSamples.length} of ${samples.length} samples had a browser window on top` },
  { name: 'macOS Space never changed', required: lib.isMac, pass: spaceChanges.length === 0 && spaceEvents.length === 0, detail: `${browserSpaceChanges.length} Space changes while the test browser was in front; ${spaceChanges.length} Space changes in all (${spaceChanges.map(c => `${c.from}→${c.to} with ${c.front} in front`).join('; ') || 'none'})` },
  { name: "The person's tab stayed the active tab while agents connected", required: true, pass: count(tabActivations, inConnect) === 0 && count(wrongPolls, inConnect) === 0, detail: `${count(tabActivations, inConnect)} other tabs activated; ${count(wrongPolls, inConnect)} of ${count(allPolls, inConnect)} polls saw another active tab; person's tab not active for ${connectSpans.map(s => s.ms + ' ms').join(', ') || '0 ms'}` },
  { name: "The person's tab stayed the active tab while agents worked", required: true, pass: count(tabActivations, inWork) === 0 && count(wrongPolls, inWork) === 0, detail: `${count(tabActivations, inWork)} other tabs activated; ${count(wrongPolls, inWork)} of ${count(allPolls, inWork)} polls saw another active tab${workSpans.length ? '; not active for ' + workSpans.map(s => s.ms + ' ms' + (s.open ? ' (until the end)' : '')).join(', ') : ''}` },
  ...(scenario === 'browser-front' ? [{ name: "The person's page kept keyboard focus (document.hasFocus() and its text field focused in every report)", required: true, pass: personReports.length > 0 && personReports.every(p => p.hasFocus && p.activeElement === 'note'), detail: `${personReports.filter(p => !(p.hasFocus && p.activeElement === 'note')).length} of ${personReports.length} reports without focus` }] : []),
  { name: "The person's page never saw a visibility change or lost focus (its own events)", required: true, pass: personChangeEvents.length === 0, detail: `${personChangeEvents.length} visibilitychange or blur events; visibilityState stayed "${[...new Set(personReports.map(p => p.visibility))].join('", "')}" (hidden means macOS reports the test window as covered by other windows)` },
  { name: 'No agent tab or window opened in front', required: true, pass: tabsCreatedActive.length === 0 && otherWindowActivations.length === 0 && windowsEverOpen.size <= 1, detail: `${tabsCreatedActive.length} tabs created active (${tabsCreatedActive.map(t => (t.url || '').split('?')[0].replace(/^chrome-extension:\/\/[a-z]+\//, 'extension:')).join(', ')}), ${otherWindowActivations.length} activations in other windows, ${windowsEverOpen.size} windows seen` },
  { name: 'Every agent action succeeded', required: true, pass: failedActions.length === 0 && actions.length > 0, detail: `${actions.length - failedActions.length} of ${actions.length} actions succeeded` },
  { name: 'Browser never asked to focus one of its windows (information only: macOS refused the request)', required: false, pass: windowFocusEvents.length === 0, detail: `${windowFocusEvents.length} window focus events (Chrome's own; the frontmost-app checks show whether macOS honored them)` },
];
const pass = checks.filter(c => c.required).every(c => c.pass);

const result = {
  label, scenario, platform: process.platform, personAppPid, pass, playwrightDir, playwrightHead: gitHead, browserExecutable: executable, browserPid: bpid,
  startedAt: new Date(tStart).toISOString(), durationMs: tEnd - tStart,
  personTab, personWindow, groupsSeen, checks,
  failedActions, actions: actions.map(a => ({ agent: a.agent, tool: a.tool, args: a.args, ok: a.ok, ms: a.end - a.start, error: a.error })),
  evidence: {
    activationEvents: activations, spaceEvents, spaceChanges, frontSamples: frontSamples.slice(0, 50),
    connectedAt: new Date(tConnected).toISOString(), connectPhaseMs: tConnected - tStart, connectSpans, workSpans,
    activeTabChanges, windowFocusEvents, tabsCreatedActive, personEvents,
    samplerSampleCount: samples.length, lsappinfoSampleCount: lsFront.length,
    samplerIntervalMsMedian: median(samples.slice(1).map((s, i) => s.t - samples[i].t)),
  },
  screenshots: screens,
  agentScreenshots: agents.flatMap(a => fs.readdirSync(a.agentDir).filter(f => f.endsWith('.png')).map(f => path.join(path.basename(a.agentDir), f))),
  tempDir: tmp,
};
function median(xs) { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; }

fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 1));
fs.writeFileSync(path.join(outDir, 'raw-sampler.jsonl'), sampler.lines.map(l => JSON.stringify(l)).join('\n'));
fs.writeFileSync(path.join(outDir, 'raw-observer.jsonl'), feed.observer.map(l => JSON.stringify(l)).join('\n'));

const md = [
  `# Desk focus proof: ${label}`,
  '',
  `**Result: ${pass ? 'PASS' : 'FAIL'}**`,
  '',
  `- Playwright: \`${gitHead}\` (${playwrightDir})`,
  `- Browser: ${executable} (test instance, pid ${bpid}, temporary profile)`,
  `- Scenario: ${scenario === 'browser-front' ? "the person works in the test browser's own tab" : `the person works in another app (${personApp?.name ?? 'none started'})`}; platform ${process.platform}`,
  `- Run: ${result.startedAt}, ${(result.durationMs / 1000).toFixed(1)} s, ${rounds} rounds, two agents (A and B)`,
  `- Samples: ${samples.length} focus samples (median every ${result.evidence.samplerIntervalMsMedian} ms) and ${lsFront.length} \`lsappinfo front\` samples`,
  `- Tab groups seen: ${groupsSeen.map(g => `"${g.title}" (${g.color})`).join(', ') || 'none'}`,
  '',
  '| Check | Result | Detail |',
  '| --- | --- | --- |',
  ...checks.map(c => `| ${c.name} | ${c.pass ? 'pass' : (c.required ? '**fail**' : 'note')} | ${c.detail} |`),
  '',
  failedActions.length ? '## Failed actions\n\n' + failedActions.map(a => `- ${a.agent} \`${a.tool}\` ${JSON.stringify(a.args)}: ${String(a.error).split('\n')[0].slice(0, 300)}`).join('\n') + '\n' : '',
  '## Screenshots',
  '',
  ...screens.map(s => `- [${s}](${s})`),
  ...result.agentScreenshots.map(s => `- [${s}](${s}) (taken by the agent through the MCP tool)`),
  '',
].join('\n');
fs.writeFileSync(path.join(outDir, 'result.md'), md);
log(pass ? 'PASS' : 'FAIL', outDir);
for (const c of checks)
  log(c.pass ? 'pass' : (c.required ? 'FAIL' : 'note'), c.name, '-', c.detail);
process.exit(0);
