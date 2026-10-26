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

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { BrowserContext, Page } from 'playwright';
import type { StartClient } from '../mcp/fixtures';

export type BrowserWithExtension = {
  userDataDir: string;
  launch: (mode?: 'disable-extension') => Promise<BrowserContext>;
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
      launch: async (mode?: 'disable-extension') => {
        browser = await launchInBackground(userDataDir, mode === 'disable-extension' ? [] : [
          `--disable-extensions-except=${pathToExtension}`,
          `--load-extension=${pathToExtension}`,
        ]);
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

// Starts headed Chromium without taking focus on the machine running the tests:
// no startup window (whose first show activates the browser), then one window
// opened in the background over CDP. The browser runs as a plain process rather
// than under Playwright's launcher, so the relay can reach it through the
// browser singleton, as it would reach the user's own browser.
async function launchInBackground(userDataDir: string, extraArgs: string[]): Promise<BackgroundBrowser> {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  await fs.rm(portFile, { force: true });
  const browserProcess = spawn(chromium.executablePath(), [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--password-store=basic',
    '--no-startup-window',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ...extraArgs,
  ], { stdio: 'ignore' });
  const exited = new Promise<void>(resolve => browserProcess.once('exit', () => resolve()));
  let port: string | undefined;
  for (let i = 0; i < 300 && !port; i++) {
    port = await fs.readFile(portFile, 'utf8').then(text => text.split('\n')[0], () => undefined);
    if (!port)
      await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!port) {
    browserProcess.kill();
    throw new Error('Browser did not start');
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true });
  const context = browser.contexts()[0];
  return {
    context,
    close: async () => {
      await browser.close().catch(() => {});
      browserProcess.kill();
      await exited;
    },
  };
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
  // Open the status page in a background tab, like any other page the tests do not look at.
  const cdp = await browserContext.browser()!.newBrowserCDPSession();
  const pagePromise = browserContext.waitForEvent('page', page => page.url().includes('/status.html'));
  await cdp.send('Target.createTarget', { url: `chrome-extension://${extensionId}/status.html`, background: true });
  const page = await pagePromise;
  await cdp.detach();
  const token = await page.locator('.auth-token-code').textContent();
  await page.close();
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
