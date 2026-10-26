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

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { test as base, expect } from '../mcp/fixtures';
import { kTargetClosedErrorMessage } from '../config/errors';
import { chromiumSwitches } from '../../packages/playwright-core/src/server/chromium/chromiumSwitches';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { BrowserContext, Page } from 'playwright';
import type { StartClient } from '../mcp/fixtures';

export type BrowserWithExtension = {
  userDataDir: string;
  // 'unmanaged': the test's own connection does not emulate focus in the
  // pages. Use it to check what the relay itself does to hidden tabs.
  launch: (mode?: 'disable-extension' | 'unmanaged') => Promise<BrowserContext>;
};

export type CliResult = {
  output: string;
  error: string;
};

export type TestFixtures = {
  browserWithExtension: BrowserWithExtension,
  pathToExtension: string,
  startExtensionClient: (env?: Record<string, string>) => Promise<{ browserContext: BrowserContext, client: Client }>,
  cli: (args: string[], options?: { env?: Record<string, string> }) => Promise<CliResult>;
};

export const extensionId = 'mmlmfjhmonkocbjadbfplnigmagldckm';

export const test = base.extend<TestFixtures>({
  pathToExtension: async ({}, use, testInfo) => {
    const extensionDir = testInfo.outputPath('extension');
    const srcDir = path.resolve(__dirname, '../../packages/extension/dist');
    await fs.cp(srcDir, extensionDir, { recursive: true });
    await use(extensionDir);
  },

  browserWithExtension: async ({ mcpBrowser, pathToExtension }, use, testInfo) => {
    // The flags no longer work in Chrome since
    // https://chromium.googlesource.com/chromium/src/+/290ed8046692651ce76088914750cb659b65fb17%5E%21/chrome/browser/extensions/extension_service.cc?pli=1#
    test.skip('chromium' !== mcpBrowser, '--load-extension is not supported for official builds of Chromium');

    let browser: BackgroundBrowser | undefined;
    const userDataDir = testInfo.outputPath('extension-user-data-dir');
    // --load-extension does not populate Default/Extensions/<id>; create the folder
    // so the relay's extension-installed check recognizes the test profile.
    await fs.mkdir(path.join(userDataDir, 'Default', 'Extensions', extensionId), { recursive: true });
    await use({
      userDataDir,
      launch: async (mode?: 'disable-extension' | 'unmanaged') => {
        browser = await launchInBackground(userDataDir, mode === 'disable-extension' ? [] : [
          `--disable-extensions-except=${pathToExtension}`,
          `--load-extension=${pathToExtension}`,
        ], { noDefaults: mode === 'unmanaged' });
        const browserContext = browser.context;

        // MV3 service workers start lazily; wait for the extension's
        // background to be ready so tests can reach `chrome.*` via it.
        if (mode !== 'disable-extension' && !browserContext.serviceWorkers().length)
          await browserContext.waitForEvent('serviceworker');

        return browserContext;
      }
    });
    await browser?.close();

    // Free up disk space.
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  },

  startExtensionClient: async ({ browserWithExtension, startClient }, use) => {
    await use(async (env?: Record<string, string>) => {
      const browserContext = await browserWithExtension.launch();
      const client = await startWithExtensionFlag(browserWithExtension, startClient, env);
      return { browserContext, client };
    });
  },

  cli: async ({ mcpBrowser }, use, testInfo) => {
    await use(async (args, options) => {
      return await runCli(args, { mcpBrowser, testInfo, env: options?.env });
    });

    // Cleanup sessions
    await runCli(['close-all'], { mcpBrowser, testInfo }).catch(() => {});

    const daemonDir = path.join(testInfo.outputDir, 'daemon');
    await fs.rm(daemonDir, { recursive: true, force: true }).catch(() => {});
  },
});

export { expect };

export const testWithOldExtensionVersion = test.extend({
  pathToExtension: async ({ pathToExtension }, use) => {
    const manifestPath = path.join(pathToExtension, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.version = '0.0.1';
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await use(pathToExtension);
  },
});

function cliEnv() {
  return {
    PWTEST_SERVER_REGISTRY: test.info().outputPath('registry'),
    PWTEST_DAEMON_SESSION_DIR: test.info().outputPath('daemon'),
    // Short path because macOS caps unix socket paths at 104 chars; the
    // long `project.outputDir` path overflows and causes EADDRINUSE.
    PWTEST_SOCKETS_DIR: path.join(os.tmpdir(), 'pwmcp-sock', String(test.info().parallelIndex)),
  };
}

async function runCli(
  args: string[],
  options: { mcpBrowser?: string, testInfo: any, env?: Record<string, string> },
): Promise<CliResult> {
  const stepTitle = `cli ${args.join(' ')}`;

  return await test.step(stepTitle, async () => {
    const testInfo = options.testInfo;

    // Path to the terminal CLI
    const cliPath = require.resolve('../../packages/playwright-core/lib/tools/cli-client/cli.js');

    return new Promise<CliResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const childProcess = spawn(process.execPath, [cliPath, ...args], {
        cwd: testInfo.outputPath(),
        env: {
          ...process.env,
          ...cliEnv(),
          PLAYWRIGHT_MCP_BROWSER: options.mcpBrowser,
          PLAYWRIGHT_MCP_HEADLESS: 'false',
          ...options.env,
        },
        detached: true,
      });

      childProcess.stdout?.on('data', data => {
        stdout += data.toString();
      });

      childProcess.stderr?.on('data', data => {
        if (process.env.PWMCP_DEBUG)
          process.stderr.write(data);
        stderr += data.toString();
      });

      childProcess.on('close', async code => {
        await testInfo.attach(stepTitle, { body: stdout, contentType: 'text/plain' });
        resolve({
          output: stdout.trim(),
          error: stderr.trim(),
        });
      });

      childProcess.on('error', reject);
    });
  });
}

type BackgroundBrowser = { context: BrowserContext, close: () => Promise<void> };

// Browsers still running when the test worker exits, for example after a timeout.
const runningBrowserPids = new Set<number>();
process.on('exit', () => {
  for (const pid of runningBrowserPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
    }
  }
});

// Starts headed Chromium without taking focus on the machine that runs the
// tests (ourostack fork only). There is no startup window, whose first show
// activates the browser; one window is opened in the background over CDP. On
// macOS the app starts through Launch Services in the background, because an
// app started as a plain child process activates itself once it has launched.
// The browser runs outside Playwright's launcher, so the relay reaches it
// through the browser singleton, as it would reach the user's own browser.
// With `noDefaults`, the test's own connection does not emulate focus.
async function launchInBackground(userDataDir: string, extraArgs: string[], options: { noDefaults?: boolean }): Promise<BackgroundBrowser> {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  await fs.rm(portFile, { force: true });
  const executable = chromium.executablePath();
  const args = [
    // Like the upstream 'unmanaged' mode, keep the popup blocker on without Playwright's defaults.
    ...chromiumSwitches().filter(arg => arg !== '--disable-extensions' && !(options.noDefaults && arg === '--disable-popup-blocking')),
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-startup-window',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ...extraArgs,
  ];
  const appBundle = process.platform === 'darwin' ? executable.match(/^(.*?\.app)\/Contents\/MacOS\//)?.[1] : undefined;
  let started = false;
  if (appBundle) {
    // -g: leave the app in the background; -n: a new instance even if one is running.
    const env = Object.entries(process.env).filter(([, value]) => value !== undefined && !value.includes('\n')).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
    const opener = spawn('open', ['-g', '-n', ...env, '-a', appBundle, '--args', ...args], { stdio: 'ignore' });
    const exited = new Promise<boolean>(resolve => opener.once('exit', code => resolve(code === 0)));
    const timedOut = new Promise<boolean>(resolve => setTimeout(() => resolve(false), 15000));
    started = await Promise.race([exited, timedOut]);
    if (!started)
      opener.kill();
  }
  if (!started)
    spawn(executable, args, { stdio: 'ignore' });
  let port: string | undefined;
  for (let i = 0; i < 300 && !port; i++) {
    port = await fs.readFile(portFile, 'utf8').then(text => text.split('\n')[0], () => undefined);
    if (!port)
      await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!port)
    throw new Error('Browser did not start');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: options.noDefaults });
  const cdp = await browser.newBrowserCDPSession();
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo') as { processInfo: { type: string, id: number }[] };
  const pid = processInfo.find(p => p.type === 'browser')?.id;
  if (pid)
    runningBrowserPids.add(pid);
  await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true });
  await expect.poll(() => browser.contexts()[0].pages().length).toBeGreaterThan(0);
  return {
    context: browser.contexts()[0],
    close: async () => {
      await cdp.send('Browser.close').catch(() => {});
      await browser.close().catch(() => {});
      for (let i = 0; pid && i < 100 && isAlive(pid); i++)
        await new Promise(resolve => setTimeout(resolve, 100));
      if (pid && isAlive(pid))
        process.kill(pid, 'SIGKILL');
      if (pid)
        runningBrowserPids.delete(pid);
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function startWithExtensionFlag(browserWithExtension: BrowserWithExtension, startClient: StartClient, env?: Record<string, string>): Promise<Client> {
  const { client } = await startClient({
    args: [`--extension`],
    env: {
      ...env,
      PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir,
    },
  });
  return client;
}

export async function readExtensionToken(browserContext: BrowserContext): Promise<string> {
  // Open the status page in a background tab, so the tab the test treats as the user's stays active.
  const sw = browserContext.serviceWorkers().find(w => w.url().includes(extensionId))!;
  await sw.evaluate(url => (globalThis as any).chrome.tabs.create({ url, active: false }), `chrome-extension://${extensionId}/status.html`);
  let page: Page | undefined;
  await expect.poll(() => page = browserContext.pages().find(p => p.url().includes('/status.html'))).toBeTruthy();
  // Poll on a timer: a hidden tab may get no animation frames.
  const token = await (await page!.waitForFunction(() => document.querySelector('.auth-token-code')?.textContent, undefined, { polling: 100 })).jsonValue();
  await page!.close();
  const [, value] = token?.split('=') || [];
  return value;
}

export async function connectWithToken(browserContext: BrowserContext, startClient: StartClient, userDataDir: string): Promise<{ client: Client, stderr: () => string }> {
  const token = await readExtensionToken(browserContext);
  const { client, stderr } = await startClient({
    args: ['--extension'],
    env: {
      DEBUG: 'pw:mcp:backend',
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: token,
      PWTEST_EXTENSION_USER_DATA_DIR: userDataDir,
    },
  });
  return { client, stderr };
}

// The connect page closes itself once a different tab is selected, which races
// with the click — the request reaches the background while the page is being
// torn down. Swallow the resulting "Target closed" error.
export async function clickAllowAndSelect(connectPage: Page, tabTitle: RegExp | string): Promise<void> {
  await connectPage.locator('.tab-item', { hasText: tabTitle }).getByRole('button', { name: 'Allow & select' }).click().catch(e => {
    if (!e?.message?.includes(kTargetClosedErrorMessage))
      throw e;
  });
}

export async function connectAndNavigate(
  browserContext: BrowserContext,
  client: Client,
  url: string,
): Promise<Awaited<ReturnType<Client['callTool']>>> {
  const confirmationPagePromise = browserContext.waitForEvent('page', page =>
    page.url().startsWith(`chrome-extension://${extensionId}/connect.html`)
  );
  const navigatePromise = client.callTool({ name: 'browser_navigate', arguments: { url } });
  const selectorPage = await confirmationPagePromise;
  await clickAllowAndSelect(selectorPage, 'Welcome');
  return await navigatePromise;
}
