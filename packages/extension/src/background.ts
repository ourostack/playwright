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

import { debugLog } from './relayConnection';
import { PendingConnections } from './pendingConnection';
import { ConnectedTabGroup, cleanupStalePlaywrightGroups, isNonDebuggableUrl, ungroupTabs, uniqueGroupStyle } from './connectedTabGroup';

type PageMessage = {
  type: 'connectionRequested';
  mcpRelayUrl: string;
  // The client brought a token, so the page needs no user input.
  withToken?: boolean;
} | {
  type: 'getTabs';
} | {
  type: 'connectToTab';
  // Picked in the connect page; absent on the token-bypass path where no tab
  // selection happens.
  tab?: chrome.tabs.Tab;
  clientName?: string;
} | {
  type: 'getConnectionStatus';
} | {
  type: 'disconnect';
  connectionId: number;
} | {
  type: 'keepalive';
};

class PlaywrightExtension {
  private _connections = new Map<number, ConnectedTabGroup>();
  private _lastConnectionId = 0;
  private _pendingConnections = new PendingConnections();
  // Connect pages seen by this service worker; they belong to clients, not to the user.
  private _connectPageTabIds = new Set<number>();
  // Service worker restarts lose all connection state, so any existing
  // Playwright groups are stale. Connections wait on this before reconciling.
  private _cleanupPromise: Promise<void>;

  constructor() {
    chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
    chrome.action.onClicked.addListener(this._onActionClicked.bind(this));
    chrome.tabs.onCreated.addListener(this._onTabCreated.bind(this));
    this._cleanupPromise = cleanupStalePlaywrightGroups();
  }

  // Promise-based message handling is not supported in Chrome: https://issues.chromium.org/issues/40753031
  private _onMessage(message: PageMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) {
    switch (message.type) {
      case 'connectionRequested': {
        const selectorTabId = sender.tab!.id!;
        if (message.withToken)
          void this._handBackWindow(sender.tab!);
        this._releaseConnectPage(selectorTabId).then(() => {
          this._pendingConnections.create(selectorTabId, message.mcpRelayUrl);
          sendResponse({ success: true });
        });
        return true;
      }
      case 'getTabs':
        this._getTabs(sender.tab?.id).then(
            tabs => sendResponse({ success: true, tabs, currentTabId: sender.tab?.id }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'connectToTab': {
        // Token-bypass (no specific pick) falls back to the connect page itself
        // so `ConnectedTabGroup` always has a concrete tab to start from. Both
        // sender.tab and UI-supplied tabs come from chrome.tabs.query / runtime
        // message sender, where `id` is always defined.
        const selectedTab = (message.tab ?? sender.tab!) as chrome.tabs.Tab & { id: number };
        this._connectTab(sender.tab!.id!, selectedTab, message.clientName, !!message.tab).then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true; // Return true to indicate that the response will be sent asynchronously
      }
      case 'getConnectionStatus':
        sendResponse({
          connections: [...this._connections].map(([id, group]) => ({
            id,
            clientName: group.clientName,
            connectedTabIds: group.connectedTabIds(),
          })),
        });
        return false;
      case 'disconnect':
        this._connections.get(message.connectionId)?.close('User disconnected');
        sendResponse({ success: true });
        return false;
      case 'keepalive':
        // Connect page pings us every ~20s so receiving this message resets
        // the MV3 service worker idle timer and keeps the relay WebSocket alive.
        return false;
    }
  }

  private async _connectTab(selectorTabId: number, tab: chrome.tabs.Tab & { id: number }, clientName: string | undefined, pickedByUser: boolean): Promise<void> {
    try {
      await this._cleanupPromise;
      this._releaseTab(selectorTabId);
      if (tab.id !== selectorTabId && this._connectedTabIds().has(tab.id))
        throw new Error('This tab is already connected to another client');

      const connection = await this._pendingConnections.take(selectorTabId);
      if (!connection)
        throw new Error('Pending client connection closed');

      const id = ++this._lastConnectionId;
      const taken = [...this._connections.values()].map(group => group.groupStyle);
      const group = new ConnectedTabGroup(connection, tab, clientName, uniqueGroupStyle(clientName, taken), tabId => this._pendingConnections.has(tabId));
      group.onclose = () => this._connections.delete(id);
      this._connections.set(id, group);

      // Show the tab only when the user picked it in the connect page. A client
      // connecting with a token works in the background and never takes over
      // the tab or window the user is looking at.
      if (pickedByUser)
        await chrome.tabs.update(tab.id, { active: true }).catch(() => {});

      if (tab.id !== selectorTabId)
        await chrome.tabs.remove(selectorTabId).catch(() => {});
    } catch (error: any) {
      debugLog(`Failed to connect tab ${tab.id}:`, error.message);
      throw error;
    }
  }

  // Chrome may create the connect page inside the active client's group.
  private async _releaseConnectPage(tabId: number): Promise<void> {
    this._releaseTab(tabId);
    await ungroupTabs([tabId]);
  }

  private _releaseTab(tabId: number): void {
    for (const group of this._connections.values())
      group.releaseTab(tabId);
  }

  private async _getTabs(selectorTabId: number | undefined): Promise<chrome.tabs.Tab[]> {
    const tabs = await chrome.tabs.query({});
    const connectedTabIds = this._connectedTabIds();
    return tabs.filter(tab => !isNonDebuggableUrl(tab.url) && (tab.id === selectorTabId || !connectedTabIds.has(tab.id!)));
  }

  private _connectedTabIds(): Set<number> {
    return new Set([...this._connections.values()].flatMap(group => group.connectedTabIds()));
  }

  // The relay opens the connect page through the browser's command line, which
  // always opens it as the active tab. When the client brings a token, no user
  // input is needed, so hand the window straight back to the tab the user was
  // on; the connect page keeps working in the background. This runs as soon as
  // the tab is created and again when the page reports in, in case the
  // service worker was not running in time to see the tab being created.
  private async _onTabCreated(tab: chrome.tabs.Tab): Promise<void> {
    const url = tab.pendingUrl || tab.url;
    if (tab.id === undefined || !isConnectPageUrl(url))
      return;
    this._connectPageTabIds.add(tab.id);
    if (new URL(url!).searchParams.has('token'))
      await this._handBackWindow(tab);
  }

  private async _handBackWindow(connectPage: chrome.tabs.Tab): Promise<void> {
    try {
      this._connectPageTabIds.add(connectPage.id!);
      const current = await chrome.tabs.get(connectPage.id!);
      if (!current.active)
        return;
      const previous = await this._mostRecentUserTab(current.windowId);
      if (previous !== undefined)
        await chrome.tabs.update(previous, { active: true });
    } catch (error: any) {
      debugLog('Failed to restore the active tab:', error.message);
    }
  }

  private _isAgentTab(tabId: number): boolean {
    return this._connectPageTabIds.has(tabId) || this._connectedTabIds().has(tabId);
  }

  // The tab the user was on before the connect page took over the window.
  private async _mostRecentUserTab(windowId: number): Promise<number | undefined> {
    const tabs = await chrome.tabs.query({ windowId });
    const candidates = tabs.filter(t => t.id !== undefined && !this._isAgentTab(t.id) && !isConnectPageUrl(t.pendingUrl || t.url));
    candidates.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    return candidates[0]?.id;
  }

  private async _onActionClicked(): Promise<void> {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('status.html'),
      active: true
    });
  }
}

function isConnectPageUrl(url: string | undefined): boolean {
  return !!url && url.startsWith(chrome.runtime.getURL('connect.html'));
}

new PlaywrightExtension();
