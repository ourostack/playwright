// Experiment: which ways of starting the test browser and of opening a URL in
// an already running browser bring it forward on macOS?
//
// Usage: node open-methods.mjs <browser executable> <out.json> [methods]
// methods: comma list of spawn-exe, open-g, open-g-new-window (default: spawn-exe)

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as lib from '../lib.mjs';

const [executable, outFile, methodList = 'spawn-exe', launchMode = 'no-startup-window'] = process.argv.slice(2);
const tmp = lib.makeTempDir('open-methods');
const userDataDir = path.join(tmp, 'profile');
const { port, feed, url, server } = await lib.startServer();
const observer = lib.prepareObserverExtension(tmp, port);
const sampler = lib.startSampler(lib.compileSampler(tmp), 50);
const phases = [];
const mark = name => { phases.push({ name, t: Date.now() }); console.log(name); };

mark('launch');
const browser = await lib.launchTestBrowser({ executable, userDataDir, extensions: [observer], startUrl: url('/person'), noStartupWindow: launchMode === 'no-startup-window' });
sampler.watch([browser.pid]);
await lib.sleep(6000);
mark('launched');

for (const method of methodList.split(',')) {
  mark(`open:${method}`);
  const target = url('/agent?name=probe&n=' + phases.length);
  if (method === 'spawn-exe') {
    // What the relay does today.
    spawn(executable, [`--user-data-dir=${userDataDir}`, target], { detached: true, stdio: 'ignore' }).unref();
  } else if (method === 'open-g') {
    execFileSync('/usr/bin/open', ['-g', '-a', browser.app, target]);
  }
  await lib.sleep(5000);
  mark(`after:${method}`);
}

sampler.stop();
lib.quitBrowser(browser.pid);
server.close();
const front = sampler.lines.filter(l => l.kind === 'activate' || l.kind === 'space' || (l.kind === 'sample' && l.frontWatched));
fs.writeFileSync(outFile, JSON.stringify({ executable, browserPid: browser.pid, phases, activations: sampler.lines.filter(l => l.kind === 'activate' || l.kind === 'space'), samples: sampler.lines.filter(l => l.kind === 'sample').map(l => ({ t: l.t, front: l.front.pid, top: l.topWindowPid, idx: l.watchedWindowIndex, space: l.space })), watchedFrontSamples: front.filter(l => l.kind === 'sample').length, observer: feed.observer.filter(o => o.kind !== 'tick'), person: feed.person.map(p => ({ t: p.t, hasFocus: p.hasFocus, visibility: p.visibility, events: p.events })), tmp }, null, 1));
console.log('wrote', outFile);
process.exit(0);
