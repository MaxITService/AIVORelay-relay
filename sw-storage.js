'use strict';

async function ensureDefaults() {
  const stored = await chrome.storage.local.get({
    settings: {},
    messages: [],
    status: STATUS_DEFAULT,
    connectorSession: CONNECTOR_SESSION_DEFAULT,
    cursor: null,
    boundTabId: null,
    boundTabInfo: null,
    boundTabIds: [],
    boundTabInfos: {},
    recentMessageIds: [],
    pendingBundles: {}
  });

  const mergedSettings = { ...DEFAULT_SETTINGS, ...stored.settings };
  const updates = {};

  if (!Array.isArray(stored.messages)) updates.messages = [];
  if (!stored.connectorSession || typeof stored.connectorSession !== "object" || Array.isArray(stored.connectorSession)) {
    updates.connectorSession = { ...CONNECTOR_SESSION_DEFAULT };
  } else {
    const mergedSession = { ...CONNECTOR_SESSION_DEFAULT, ...stored.connectorSession };
    if (JSON.stringify(mergedSession) !== JSON.stringify(stored.connectorSession)) {
      updates.connectorSession = mergedSession;
    }
  }
  if (!stored.status || typeof stored.status !== "object") {
    updates.status = STATUS_DEFAULT;
  } else {
    const mergedStatus = { ...STATUS_DEFAULT, ...stored.status };
    if (JSON.stringify(mergedStatus) !== JSON.stringify(stored.status)) {
      updates.status = mergedStatus;
    }
  }
  if (stored.cursor === undefined) updates.cursor = null;
  if (!Array.isArray(stored.recentMessageIds)) updates.recentMessageIds = [];
  if (!stored.pendingBundles || typeof stored.pendingBundles !== "object" || Array.isArray(stored.pendingBundles)) {
    updates.pendingBundles = {};
  }
  if (JSON.stringify(mergedSettings) !== JSON.stringify(stored.settings)) {
    updates.settings = mergedSettings;
  }

  // Migrate from old single-tab format to new multi-tab format
  if (Number.isInteger(stored.boundTabId) && !stored.boundTabIds?.length) {
    updates.boundTabIds = [stored.boundTabId];
    if (stored.boundTabInfo && stored.boundTabInfo.id === stored.boundTabId) {
      updates.boundTabInfos = { [stored.boundTabId]: stored.boundTabInfo };
    } else {
      try {
        const tab = await chrome.tabs.get(stored.boundTabId);
        updates.boundTabInfos = { [stored.boundTabId]: buildTabInfo(tab) };
      } catch {
        updates.boundTabIds = [];
        updates.boundTabInfos = {};
      }
    }
    updates.boundTabId = null;
    updates.boundTabInfo = null;
  }

  // Ensure array format
  if (!Array.isArray(stored.boundTabIds) && !updates.boundTabIds) {
    updates.boundTabIds = [];
  }
  if ((!stored.boundTabInfos || typeof stored.boundTabInfos !== "object" || Array.isArray(stored.boundTabInfos)) && !updates.boundTabInfos) {
    updates.boundTabInfos = {};
  }

  // Clean up legacy fields if present and new fields initialized
  if (stored.boundTabId !== undefined) {
    updates.boundTabId = null;
    updates.boundTabInfo = null;
  }

  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
  }

  // Validate bound tabs still exist
  const currentIds = updates.boundTabIds ?? stored.boundTabIds ?? [];
  const currentInfos = updates.boundTabInfos ?? stored.boundTabInfos ?? {};
  if (currentIds.length > 0) {
    const validIds = [];
    const validInfos = {};
    for (const tabId of currentIds) {
      try {
        const tab = await chrome.tabs.get(tabId);
        validIds.push(tabId);
        validInfos[tabId] = currentInfos[tabId] || buildTabInfo(tab);
      } catch {
        // Tab no longer exists
      }
    }
    if (validIds.length !== currentIds.length) {
      await chrome.storage.local.set({ boundTabIds: validIds, boundTabInfos: validInfos });
    }
  }
}

async function setupAlarm() {
  const settings = await getSettings();
  if (settings.connectorEnabled === false) {
    await chrome.alarms.clear("poll-messages");
    return;
  }
  const minutes = sanitizePollMinutes(settings.pollMinutes);
  chrome.alarms.create("poll-messages", { periodInMinutes: minutes });
}

function sanitizePollMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return DEFAULT_SETTINGS.pollMinutes;
  return Math.max(0.1, minutes);
}

function buildTabInfo(tab) {
  if (!tab) return null;
  return {
    id: tab.id ?? null,
    title: typeof tab.title === "string" ? tab.title : "",
    url: typeof tab.url === "string" ? tab.url : ""
  };
}

async function bindTabById(tabId, options = {}) {
  const forceReplace = options.forceReplace ?? false;

  if (!Number.isInteger(tabId)) {
    return null;
  }

  const settings = await getSettings();
  const singleMode = settings.singleTabBindingMode !== false;

  let info = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    info = buildTabInfo(tab);
  } catch {
    info = { id: tabId, title: "", url: "" };
  }

  const stored = await chrome.storage.local.get({ boundTabIds: [], boundTabInfos: {} });
  let boundTabIds = Array.isArray(stored.boundTabIds) ? [...stored.boundTabIds] : [];
  let boundTabInfos = stored.boundTabInfos && typeof stored.boundTabInfos === "object" ? { ...stored.boundTabInfos } : {};

  // If already bound, just update info
  if (boundTabIds.includes(tabId)) {
    boundTabInfos[tabId] = info;
    await chrome.storage.local.set({ boundTabIds, boundTabInfos });
    return info;
  }

  // In single mode or forceReplace, clear other bindings
  if (singleMode || forceReplace) {
    boundTabIds = [tabId];
    boundTabInfos = { [tabId]: info };
  } else {
    boundTabIds.push(tabId);
    boundTabInfos[tabId] = info;
  }

  await chrome.storage.local.set({ boundTabIds, boundTabInfos });
  return info;
}

async function unbindTabById(tabId) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  const stored = await chrome.storage.local.get({ boundTabIds: [], boundTabInfos: {} });
  let boundTabIds = Array.isArray(stored.boundTabIds) ? [...stored.boundTabIds] : [];
  let boundTabInfos = stored.boundTabInfos && typeof stored.boundTabInfos === "object" ? { ...stored.boundTabInfos } : {};

  const idx = boundTabIds.indexOf(tabId);
  if (idx === -1) return;

  boundTabIds.splice(idx, 1);
  delete boundTabInfos[tabId];

  await chrome.storage.local.set({ boundTabIds, boundTabInfos });
}

async function unbindAllTabs() {
  await chrome.storage.local.set({ boundTabIds: [], boundTabInfos: {} });
}

async function toggleBindForSender(sender) {
  const senderTabId = sender?.tab?.id;
  if (!Number.isInteger(senderTabId)) {
    throw new Error("No sender tab available for bind toggle");
  }

  const stored = await chrome.storage.local.get({ boundTabIds: [] });
  const boundTabIds = Array.isArray(stored.boundTabIds) ? stored.boundTabIds : [];

  if (boundTabIds.includes(senderTabId)) {
    await unbindTabById(senderTabId);
    return null;
  }

  return await bindTabById(senderTabId);
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get({
    settings: DEFAULT_SETTINGS
  });
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function setConnectorDisabledState() {
  await chrome.storage.local.set({
    status: {
      ...STATUS_DEFAULT,
      connected: false,
      lastError: null,
      lastKeepaliveAt: null
    }
  });
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setTitle({ title: "AivoRelay: Connector OFF" });
}

async function getConnectorSession() {
  const { connectorSession } = await chrome.storage.local.get({
    connectorSession: CONNECTOR_SESSION_DEFAULT
  });
  return { ...CONNECTOR_SESSION_DEFAULT, ...(connectorSession || {}) };
}

async function saveConnectorSession(session) {
  await chrome.storage.local.set({
    connectorSession: { ...CONNECTOR_SESSION_DEFAULT, ...(session || {}) }
  });
}

async function clearConnectorSession() {
  await chrome.storage.local.set({
    connectorSession: { ...CONNECTOR_SESSION_DEFAULT }
  });
}

function normalizePendingBundles(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function buildStoredMessage(message, overrides = {}) {
  return {
    id: message.id,
    ts: message.ts,
    type: message.type,
    text: message.text,
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    raw: message.raw,
    status: overrides.status ?? message.status ?? "ok",
    errors: overrides.errors ?? message.errors ?? [],
    deliveryStatus: overrides.deliveryStatus ?? message.deliveryStatus ?? null,
    deliveryDetail: overrides.deliveryDetail ?? message.deliveryDetail ?? null,
    deliveryUpdatedAt: overrides.deliveryUpdatedAt ?? message.deliveryUpdatedAt ?? null,
    retryCount: overrides.retryCount ?? message.retryCount ?? 0,
    createdAt: overrides.createdAt ?? message.createdAt ?? Date.now(),
    wasBound: overrides.wasBound ?? message.wasBound ?? null
  };
}

function upsertMessageList(list, update) {
  if (!Array.isArray(list)) return [update];
  const idx = list.findIndex((item) => item.id === update.id);
  if (idx === -1) {
    list.push(update);
    return list;
  }
  const existing = list[idx];
  list[idx] = {
    ...existing,
    ...update,
    attachments: update.attachments ?? existing.attachments ?? [],
    errors: update.errors ?? existing.errors ?? []
  };
  return list;
}

function applyDeliveryStatus(list, messageId, delivery) {
  if (!messageId) return list;
  const deliveryStatus = delivery.overrideStatus ?? (delivery.ok ? "queued" : delivery.reason);
  const deliveryDetail = delivery.detail || delivery.error || "";
  return upsertMessageList(list, {
    id: messageId,
    deliveryStatus,
    deliveryDetail: deliveryDetail || null,
    deliveryUpdatedAt: Date.now()
  });
}

async function updateMessageDelivery(messageId, status, detail) {
  const stored = await chrome.storage.local.get({ messages: [] });
  const list = Array.isArray(stored.messages) ? [...stored.messages] : [];
  const updated = applyDeliveryStatus(list, messageId, {
    ok: true,
    overrideStatus: status,
    detail: detail || ""
  });
  await chrome.storage.local.set({ messages: await trimMessageList(updated) });
}

async function trimMessageList(list) {
  if (!Array.isArray(list)) return [];
  const settings = await getSettings();
  const limit = Math.max(1, Number(settings.maxStoredMessages) || MAX_MESSAGES);
  if (list.length <= limit) return list;

  const removed = list.slice(0, list.length - limit);
  const kept = list.slice(-limit);

  for (const msg of removed) {
    if (msg.id) {
      try {
        await deleteBlobsForMessage(msg.id);
      } catch (err) {
        console.warn("[aivo-relay] Failed to cleanup blobs for message", msg.id, err);
      }
    }
  }

  return kept;
}

function trimPendingBundles(pendingBundles) {
  const entries = Object.values(pendingBundles || {});
  if (entries.length <= MAX_PENDING_BUNDLES) return pendingBundles;
  // Sort by creation time DESC (Newest First)
  const sorted = entries.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  // Keep the most recent N bundles
  const trimmed = sorted.slice(0, MAX_PENDING_BUNDLES);
  const next = {};
  for (const entry of trimmed) {
    next[entry.id] = entry;
  }
  return next;
}

function trimDedupeList(set) {
  const list = Array.from(set);
  if (list.length <= MAX_DEDUPED_IDS) return list;
  return list.slice(-MAX_DEDUPED_IDS);
}
