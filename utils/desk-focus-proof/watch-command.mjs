// Runs a command (for example Playwright's headed extension tests) while a
// labeled "person" app is in front, samples the frontmost app the whole time,
// and reports whether anything else came to the front. Test machines only.
//
// Usage: node watch-command.mjs --out <dir> --label <name> -- <command> [args...]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as lib from './lib.mjs';

const sep = process.argv.indexOf('--');
const opts = process.argv.slice(2, sep);
const command = process.argv.slice(sep + 1);
const opt = (name, fallback) => { const i = opts.indexOf(`--${name}`); return i === -1 ? fallback : opts[i + 1]; };
const outDir = path.resolve(opt('out', 'watch-command-out'));
const label = opt('label', 'command');
fs.mkdirSync(outDir, { recursive: true });
const tmp = lib.makeTempDir(label);

const personApp = await lib.startPersonApp(tmp);
const sampler = lib.startSampler(lib.compileSampler(tmp), 50);
const screens = [];
const shot = name => { const f = lib.screenshotScreen(path.join(outDir, name)); if (f) screens.push(name); };
await lib.sleep(1000);
shot('screen-1-before.png');
const tStart = Date.now();
const midShots = setInterval(() => shot(`screen-2-during-${Date.now() - tStart}ms.png`), 20000);
const code = await new Promise(resolve => {
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', c => resolve(c));
});
clearInterval(midShots);
const tEnd = Date.now();
shot('screen-3-after.png');
sampler.stop();
personApp.stop();

const samples = sampler.lines.filter(l => l.kind === 'sample' && l.t >= tStart && l.t <= tEnd);
const away = samples.filter(s => s.front?.pid !== personApp.pid);
const activations = sampler.lines.filter(l => l.kind === 'activate' && l.t >= tStart && l.t <= tEnd && l.app?.pid !== personApp.pid);
const awayApps = [...new Set(away.map(s => `${s.front?.name} (${s.front?.pid})`).concat(activations.map(a => `${a.app?.name} (${a.app?.pid})`)))];
const pass = away.length === 0 && activations.length === 0;
const result = { label, command: command.join(' '), exitCode: code, pass, personApp: { pid: personApp.pid, name: personApp.name }, samples: samples.length, samplesWithAnotherAppInFront: away.length, activationsOfOtherApps: activations, otherAppsInFront: awayApps, durationMs: tEnd - tStart, screenshots: screens };
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 1));
fs.writeFileSync(path.join(outDir, 'raw-sampler.jsonl'), sampler.lines.map(l => JSON.stringify(l)).join('\n'));
fs.writeFileSync(path.join(outDir, 'result.md'), [
  `# ${label}: ${pass ? 'PASS' : 'FAIL'}`,
  '',
  `- Command: \`${command.join(' ')}\` (exit code ${code})`,
  `- Person app in front: ${personApp.name} (pid ${personApp.pid})`,
  `- ${samples.length} focus samples over ${((tEnd - tStart) / 1000).toFixed(0)} s; ${away.length} had another app in front; ${activations.length} activations of other apps`,
  awayApps.length ? `- Apps that came to the front: ${awayApps.join(', ')}` : '- No other app came to the front.',
  '',
  ...screens.map(s => `- [${s}](${s})`),
  '',
].join('\n'));
console.log(pass ? 'PASS' : 'FAIL', JSON.stringify({ exitCode: code, away: away.length, awayApps }));
process.exit(0);
