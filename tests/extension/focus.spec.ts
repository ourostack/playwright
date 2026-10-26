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

import { test, expect, extensionId, readExtensionToken } from './extension-fixtures';

import type { BrowserContext, Page } from 'playwright';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { BrowserWithExtension } from './extension-fixtures';
import type { StartClient } from '../mcp/fixtures';

// The user keeps working in their own tab while a client drives other tabs of
// the same browser. Nothing the client does may take that tab away.

async function openUserTab(browserContext: BrowserContext, server: { PREFIX: string, setContent: (path: string, content: string, mimeType: string) => void }): Promise<Page> {
  server.setContent('/user', '<title>User</title><body><input id=note></body>', 'text/html');
  // Use the window's blank tab, which is already the active one.
  const page = browserContext.pages().find(p => p.url() === 'about:blank') ?? await browserContext.newPage();
  await page.goto(server.PREFIX + '/user');
  return page;
}

async function activeTabTitles(browserContext: BrowserContext): Promise<string[]> {
  const sw = browserContext.serviceWorkers().find(w => w.url().includes(extensionId))!;
  return await sw.evaluate(async () => {
    const chrome = (globalThis as any).chrome;
    const tabs = await chrome.tabs.query({ active: true });
    return tabs.map((t: any) => t.title);
  });
}

async function connectInBackground(browserWithExtension: BrowserWithExtension, startClient: StartClient, token: string, args: string[] = []): Promise<Client> {
  const { client } = await startClient({
    args: ['--extension', ...args],
    env: {
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: token,
      PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir,
    },
  });
  return client;
}

test(`connecting with a token keeps the user's tab active`, async ({ browserWithExtension, startClient, server }) => {
  const browserContext = await browserWithExtension.launch();
  const token = await readExtensionToken(browserContext);
  await openUserTab(browserContext, server);

  const client = await connectInBackground(browserWithExtension, startClient, token);
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({ snapshot: expect.stringContaining('Hello, world!') });

  await expect.poll(() => activeTabTitles(browserContext)).toEqual(['User']);
});

test(`browser_tabs new and select keep the user's tab active`, async ({ browserWithExtension, startClient, server }) => {
  server.setContent('/second', '<title>Second</title><body>Second page</body>', 'text/html');
  const browserContext = await browserWithExtension.launch();
  const token = await readExtensionToken(browserContext);
  await openUserTab(browserContext, server);
  const client = await connectInBackground(browserWithExtension, startClient, token);
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  expect(await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'new', url: server.PREFIX + '/second' },
  })).toHaveResponse({ snapshot: expect.stringContaining('Second page') });
  expect(await activeTabTitles(browserContext)).toEqual(['User']);

  expect(await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'select', index: 0 },
  })).toHaveResponse({ result: expect.stringContaining('(current) [Title]') });
  expect(await activeTabTitles(browserContext)).toEqual(['User']);

  expect(await client.callTool({
    name: 'browser_run_code_unsafe',
    arguments: { code: `async page => { await page.bringToFront(); return 'done'; }` },
  })).toHaveResponse({ result: expect.stringContaining('done') });
  expect(await activeTabTitles(browserContext)).toEqual(['User']);
});

test(`browser_start_recording keeps the user's tab active`, async ({ browserWithExtension, startClient, server }) => {
  const browserContext = await browserWithExtension.launch();
  const token = await readExtensionToken(browserContext);
  await openUserTab(browserContext, server);
  const client = await connectInBackground(browserWithExtension, startClient, token, ['--caps=devtools']);
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  expect(await client.callTool({
    name: 'browser_start_recording',
    arguments: {},
  })).toHaveResponse({ result: expect.stringContaining('Recording started') });
  expect(await activeTabTitles(browserContext)).toEqual(['User']);
  await client.callTool({ name: 'browser_stop_recording', arguments: {} });
});

// The browser here is also driven by the test's own Playwright connection, which
// emulates focus in every tab, so this guards the behavior end to end rather
// than isolating the relay's focus emulation.
test(`client can click and type in its tab while the user's tab is active`, async ({ browserWithExtension, startClient, server }) => {
  server.setContent('/form', `<title>Form</title>
    <input id=field aria-label=Field>
    <button onclick="this.textContent = 'Clicked'">Press</button>
    <div id=editor contenteditable aria-label=Editor></div>`, 'text/html');
  const browserContext = await browserWithExtension.launch();
  const token = await readExtensionToken(browserContext);
  await openUserTab(browserContext, server);
  const client = await connectInBackground(browserWithExtension, startClient, token);
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/form' } });

  await client.callTool({ name: 'browser_click', arguments: { element: 'Press button', target: 'button' } });
  await client.callTool({ name: 'browser_type', arguments: { element: 'Field', target: '#field', text: 'typed', slowly: true } });
  await client.callTool({ name: 'browser_type', arguments: { element: 'Editor', target: '#editor', text: 'edited', slowly: true } });
  expect(await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: `() => [document.querySelector('button').textContent, field.value, editor.textContent].join('|')` },
  })).toHaveResponse({ result: expect.stringContaining('Clicked|typed|edited') });
  expect(await client.callTool({
    name: 'browser_take_screenshot',
    arguments: {},
  })).toHaveResponse({
    result: expect.stringContaining('Screenshot of viewport'),
    code: expect.stringContaining('await page.screenshot'),
  });
  expect(await activeTabTitles(browserContext)).toEqual(['User']);
});
