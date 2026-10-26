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

// Tabs that clients opened (their own tabs, connect pages, popups), with the
// tab's lastAccessed at that time. Chrome sets lastAccessed when it creates a
// tab, even in the background, so a client tab looks recently used until the
// user really activates it, which moves lastAccessed forward.
const clientTabs = new Map<number, number>();

export function noteClientTab(tab: chrome.tabs.Tab): void {
  if (tab.id !== undefined)
    clientTabs.set(tab.id, tab.lastAccessed ?? 0);
}

export function isConnectPageUrl(url: string | undefined): boolean {
  return !!url && url.startsWith(chrome.runtime.getURL('connect.html'));
}

// A client tab (a connect page or a popup a client's page opened) came up as
// the active tab of its window. Give the window back to the tab the user was
// on; the client tab keeps working in the background.
export async function handBackFrom(clientTab: chrome.tabs.Tab): Promise<void> {
  try {
    const current = await chrome.tabs.get(clientTab.id!);
    noteClientTab(current);
    // lastAccessed needs Chrome 121; without it the user's tab is unknown.
    if (!current.active || current.lastAccessed === undefined)
      return;
    const allTabs = await chrome.tabs.query({});
    const openTabIds = new Set(allTabs.map(t => t.id));
    for (const tabId of clientTabs.keys()) {
      if (!openTabIds.has(tabId))
        clientTabs.delete(tabId);
    }
    const candidates = allTabs.filter(t => t.windowId === current.windowId && t.id !== current.id && !isConnectPageUrl(t.pendingUrl || t.url) && !isUntouchedClientTab(t));
    candidates.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    if (candidates[0]?.id === undefined)
      return;
    await chrome.tabs.update(candidates[0].id, { active: true });
    // Chrome may still move lastAccessed forward as the client tab finishes
    // becoming active; hiding it does not, so note it again now.
    noteClientTab(await chrome.tabs.get(current.id!));
  } catch (error: any) {
    debugLog('Failed to hand the window back to the user:', error.message);
  }
}

// A page in a client tab opened a tab (a target=_blank link or window.open).
// Chrome shows it in front; when the client opened it, give the window back.
// When the user is working in that client tab, the new tab is theirs.
export async function handBackFromPopup(popup: chrome.tabs.Tab, openerTabId: number): Promise<void> {
  const opener = await chrome.tabs.get(openerTabId).catch(() => undefined);
  if (!opener || !isUntouchedClientTab(opener))
    return;
  noteClientTab(popup);
  if (popup.active)
    await handBackFrom(popup);
}

function isUntouchedClientTab(tab: chrome.tabs.Tab): boolean {
  const lastAccessed = clientTabs.get(tab.id!);
  return lastAccessed !== undefined && (tab.lastAccessed ?? 0) <= lastAccessed;
}
