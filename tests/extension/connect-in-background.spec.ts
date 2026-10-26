/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test, expect, extensionId, readExtensionToken, clickAllowAndSelect, startWithExtensionFlag } from './extension-fixtures';

import type { BrowserContext } from 'playwright';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { BrowserWithExtension } from './extension-fixtures';
import type { StartClient } from '../mcp/fixtures';
import type { TestServer } from '../config/testserver';

// A client that connects with a token works in the background: the user's
// tab stays active. A tab the user picks in the connect page is shown.

function serviceWorker(browserContext: BrowserContext) {
  return browserContext.serviceWorkers().find(w => w.url().includes(extensionId))!;
}

async function activeTabs(browserContext: BrowserContext): Promise<string[]> {
  return await serviceWorker(browserContext).evaluate(async () => {
    const chrome = (globalThis as any).chrome;
    const tabs = await chrome.tabs.query({ active: true });
    return tabs.map((t: any) => t.url.includes('/connect.html') ? 'connect page' : t.title);
  });
}

async function launchWithUserTab(browserWithExtension: BrowserWithExtension, server: TestServer) {
  server.setContent('/user', '<title>User</title><body>User page</body>', 'text/html');
  const browserContext = await browserWithExtension.launch();
  const token = await readExtensionToken(browserContext);
  // The window's own tab is the active one; the user works there.
  await browserContext.pages()[0].goto(server.PREFIX + '/user');
  return { browserContext, token };
}

async function startWithToken(browserWithExtension: BrowserWithExtension, startClient: StartClient, token: string): Promise<Client> {
  const { client } = await startClient({
    args: ['--extension'],
    env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: token, PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir },
  });
  return client;
}

test(`connecting with a token keeps the user's tab active`, async ({ browserWithExtension, startClient, server }) => {
  const { browserContext, token } = await launchWithUserTab(browserWithExtension, server);
  const client = await startWithToken(browserWithExtension, startClient, token);

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({ snapshot: expect.stringContaining('Hello, world!') });
  await expect.poll(() => activeTabs(browserContext)).toEqual(['User']);
});

test(`connecting with a token returns to the user's tab even when another client uses it`, async ({ browserWithExtension, startClient, server }) => {
  const { browserContext, token } = await launchWithUserTab(browserWithExtension, server);

  // The user picks their own tab for the first client and keeps working in it.
  const first = await startWithExtensionFlag(browserWithExtension, startClient);
  const connectPagePromise = browserContext.waitForEvent('page', page => page.url().startsWith(`chrome-extension://${extensionId}/connect.html`));
  const firstNavigate = first.callTool({ name: 'browser_snapshot', arguments: {} });
  await clickAllowAndSelect(await connectPagePromise, 'User');
  await firstNavigate;
  await expect.poll(() => activeTabs(browserContext)).toEqual(['User']);

  const second = await startWithToken(browserWithExtension, startClient, token);
  await second.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  await expect.poll(() => activeTabs(browserContext)).toEqual(['User']);
});

test(`a tab picked in another window is shown with its window`, async ({ browserWithExtension, startClient, server }) => {
  server.setContent('/other', '<title>Other</title><body>Other page</body>', 'text/html');
  const { browserContext } = await launchWithUserTab(browserWithExtension, server);
  const otherWindowId = await serviceWorker(browserContext).evaluate(async url => {
    const chrome = (globalThis as any).chrome;
    const window = await chrome.windows.create({ url, focused: false });
    return window.id;
  }, server.PREFIX + '/other');
  await expect.poll(() => browserContext.pages().some(p => p.url().endsWith('/other'))).toBe(true);

  const client = await startWithExtensionFlag(browserWithExtension, startClient);
  const connectPagePromise = browserContext.waitForEvent('page', page => page.url().startsWith(`chrome-extension://${extensionId}/connect.html`));
  const snapshot = client.callTool({ name: 'browser_snapshot', arguments: {} });
  await clickAllowAndSelect(await connectPagePromise, 'Other');
  await snapshot;

  await expect.poll(() => serviceWorker(browserContext).evaluate(async () => {
    const chrome = (globalThis as any).chrome;
    const window = await chrome.windows.getLastFocused({ populate: true });
    return { id: window.id, active: window.tabs.find((t: any) => t.active)?.title };
  })).toEqual({ id: otherWindowId, active: 'Other' });
});

test(`a wrong token brings the connect page to front`, async ({ browserWithExtension, startClient, server }) => {
  const { browserContext } = await launchWithUserTab(browserWithExtension, server);
  const client = await startWithToken(browserWithExtension, startClient, 'wrong-token');
  const connectPagePromise = browserContext.waitForEvent('page', page => page.url().startsWith(`chrome-extension://${extensionId}/connect.html`));
  client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } }).catch(() => {});

  const connectPage = await connectPagePromise;
  await expect(connectPage.locator('.status-banner')).toContainText('Invalid token provided.');
  await expect.poll(() => activeTabs(browserContext)).toEqual(['connect page']);
});

test(`a tab opened by the client's page goes to the background`, async ({ browserWithExtension, startClient, server }) => {
  server.setContent('/links', `<title>Links</title><a href="/second" target="_blank">Second</a>`, 'text/html');
  server.setContent('/second', '<title>Second</title><body>Second page</body>', 'text/html');
  server.setContent('/third', '<title>Third</title><body>Third page</body>', 'text/html');
  const { browserContext, token } = await launchWithUserTab(browserWithExtension, server);
  const client = await startWithToken(browserWithExtension, startClient, token);
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/links' } });
  await expect.poll(() => activeTabs(browserContext)).toEqual(['User']);

  // Playwright evaluates with a user gesture, so Chrome treats these like clicks.
  await client.callTool({ name: 'browser_evaluate', arguments: { function: `() => document.querySelector('a').click()` } });
  await expect.poll(() => browserContext.pages().some(p => p.url().endsWith('/second'))).toBe(true);
  await expect.poll(() => activeTabs(browserContext)).toEqual(['User']);

  await client.callTool({ name: 'browser_evaluate', arguments: { function: `() => { window.open('/third'); }` } });
  await expect.poll(() => browserContext.pages().some(p => p.url().endsWith('/third'))).toBe(true);
  await expect.poll(() => activeTabs(browserContext)).toEqual(['User']);

  // Chrome names the user's active tab as the opener of these tabs; the
  // client still gets them.
  await expect.poll(async () => {
    const response = await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
    return (response as any).content?.[0]?.text ?? '';
  }).toMatch(/\[Second\][\s\S]*\[Third\]|\[Third\][\s\S]*\[Second\]/);
});
