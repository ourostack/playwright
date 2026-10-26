// Experiment: what works in a hidden (background) tab of a visible browser,
// and which DevTools protocol switches fix what does not.
//
// Usage: node hidden-tab.mjs <browser executable> <out.json>

import fs from 'node:fs';
import path from 'node:path';
import * as lib from '../lib.mjs';

const [executable, outFile] = process.argv.slice(2);
const tmp = lib.makeTempDir('hidden-tab');
const { url, server, feed } = await lib.startServer();
const browser = await lib.launchTestBrowser({ executable, userDataDir: path.join(tmp, 'profile'), extensions: [], startUrl: url('/person'), noStartupWindow: true });
const sampler = lib.startSampler(lib.compileSampler(tmp), 50);
sampler.watch([browser.pid]);
await lib.sleep(3000);
const c = await lib.cdp(browser.devtoolsPort);
const results = [];
c.on('Page.screencastFrame', (params, sessionId) => c.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {}));

const variants = [
  { name: 'baseline: nothing enabled', setup: [] },
  { name: 'Emulation.setFocusEmulationEnabled', setup: [['Emulation.setFocusEmulationEnabled', { enabled: true }]] },
  { name: 'Page.setWebLifecycleState active', setup: [['Page.setWebLifecycleState', { state: 'active' }]] },
  { name: 'Page.startScreencast', setup: [['Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 16, maxHeight: 16, everyNthFrame: 1 }]] },
  { name: 'focus emulation + screencast', setup: [['Emulation.setFocusEmulationEnabled', { enabled: true }], ['Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 16, maxHeight: 16, everyNthFrame: 1 }]] },
];

async function evalIn(sessionId, expression) {
  const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  return r.result.value;
}

for (const [i, v] of variants.entries()) {
  const { targetId } = await c.send('Target.createTarget', { url: url(`/agent?name=probe${i}&n=1`), background: true });
  const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
  // Ack screencast frames so Chrome keeps producing them.
  await c.send('Runtime.enable', {}, sessionId);
  await c.send('Page.enable', {}, sessionId);
  await lib.sleep(1500);
  for (const [method, params] of v.setup) {
    try { await c.send(method, params, sessionId); } catch (e) { results.push({ variant: v.name, setupError: `${method}: ${e.message}` }); }
  }
  const s0 = await evalIn(sessionId, 'window.deskState()');
  await lib.sleep(3000);
  const s1 = await evalIn(sessionId, 'window.deskState()');
  // Keyboard: focus the field, then send real key events.
  await evalIn(sessionId, `document.getElementById('field').focus()`);
  for (const ch of 'abc') {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) }, sessionId);
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) }, sessionId);
  }
  await c.send('Input.insertText', { text: '+inserted' }, sessionId);
  // Mouse click on the button.
  const box = await evalIn(sessionId, `(() => { const r = document.getElementById('go').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased'])
    await c.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId);
  // A two-frame requestAnimationFrame wait, like Playwright's "stable" check.
  const rafWait = await evalIn(sessionId, `new Promise(r => { const t = Date.now(); requestAnimationFrame(() => requestAnimationFrame(() => r(Date.now() - t))); setTimeout(() => r('timeout after 3000 ms'), 3000); })`);
  const shotStart = Date.now();
  let shotOk = true;
  try { await c.send('Page.captureScreenshot', { format: 'png' }, sessionId); } catch { shotOk = false; }
  const shotMs = Date.now() - shotStart;
  const s2 = await evalIn(sessionId, 'window.deskState()');
  results.push({
    variant: v.name,
    visibility: s1.visibility, hasFocus: s1.hasFocus,
    intervalTicksPerSecond: +((s1.intervalTicks - s0.intervalTicks) / 3).toFixed(1),
    animationFramesPerSecond: +((s1.animationFrames - s0.animationFrames) / 3).toFixed(1),
    rafWaitMs: rafWait,
    keyEventsReachedPage: s2.keydowns, fieldAfterKeys: s2.field,
    clickReachedPage: s2.clicks,
    focusEvents: s2.focusEvents,
    screenshotOk: shotOk, screenshotMs: shotMs,
  });
  console.log(JSON.stringify(results[results.length - 1]));
  await c.send('Target.closeTarget', { targetId });
}

const activations = sampler.lines.filter(l => l.kind === 'activate' && l.app?.pid === browser.pid);
sampler.stop();
c.close();
lib.quitBrowser(browser.pid);
server.close();
const personHidden = feed.person.filter(p => p.visibility !== 'visible').length;
fs.writeFileSync(outFile, JSON.stringify({ executable, results, browserActivations: activations.length, personHiddenReports: personHidden, personReports: feed.person.length }, null, 1));
console.log('browser activations', activations.length, 'person hidden reports', personHidden, 'of', feed.person.length);
process.exit(0);
