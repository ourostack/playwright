// Test-only observer for the Desk focus proof. The harness writes config.js
// next to this file with the port of its local server before the browser starts.
importScripts('config.js');

const endpoint = `http://127.0.0.1:${self.DESK_FOCUS_TEST_PORT}/observe`;
let last = '';
let seq = 0;

function post(kind, data) {
  fetch(endpoint, { method: 'POST', body: JSON.stringify({ t: Date.now(), seq: ++seq, kind, ...data }) }).catch(() => {});
}

async function snapshot() {
  const windows = await chrome.windows.getAll({ populate: true });
  const groups = await chrome.tabGroups.query({});
  return {
    windows: windows.map(w => ({
      id: w.id,
      focused: w.focused,
      state: w.state,
      activeTab: w.tabs.find(t => t.active)?.id,
      activeTitle: w.tabs.find(t => t.active)?.title,
      tabs: w.tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active, groupId: t.groupId })),
    })),
    groups: groups.map(g => ({ id: g.id, title: g.title, color: g.color, windowId: g.windowId })),
  };
}

async function poll() {
  try {
    const s = await snapshot();
    const key = JSON.stringify(s.windows.map(w => [w.id, w.focused, w.activeTab, w.tabs.map(t => [t.id, t.url, t.groupId])]).concat(s.groups.map(g => [g.id, g.title])));
    if (key !== last) {
      last = key;
      post('state', s);
    } else {
      post('tick', { windows: s.windows.map(w => ({ id: w.id, focused: w.focused, activeTab: w.activeTab })) });
    }
  } catch (e) {
    post('error', { message: String(e) });
  }
}

chrome.tabs.onActivated.addListener(info => post('tabActivated', info));
chrome.windows.onFocusChanged.addListener(windowId => post('windowFocusChanged', { windowId }));
chrome.tabs.onCreated.addListener(tab => post('tabCreated', { id: tab.id, active: tab.active, windowId: tab.windowId, url: tab.pendingUrl || tab.url }));
setInterval(poll, 100);
poll();
