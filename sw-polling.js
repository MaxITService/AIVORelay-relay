'use strict';

let pollInFlight = false;
let longPollActive = false;
let consecutiveErrors = 0;
let longPollGeneration = 0;
let longPollAbortController = null;

/**
 * Sleep helper for delays between polls
 * @param {number} ms - milliseconds to sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Long-polling loop - maintains persistent connection with server
 * Replaces interval-based polling with immediate message delivery
 */
async function longPollLoop() {
  if (longPollActive) {
    console.log("[aivo-relay] Long-poll loop already active, skipping");
    return;
  }

  const loopGeneration = ++longPollGeneration;
  longPollActive = true;
  console.log("[aivo-relay] Starting long-poll loop");

  try {
    const initialSettings = await getSettings();
    if (loopGeneration !== longPollGeneration) {
      return;
    }
    if (initialSettings.connectorEnabled === false) {
      await setConnectorDisabledState();
      return;
    }

    while (longPollActive && loopGeneration === longPollGeneration) {
      try {
        const loopSettings = await getSettings();
        if (loopGeneration !== longPollGeneration || !longPollActive) {
          break;
        }
        if (loopSettings.connectorEnabled === false) {
          await setConnectorDisabledState();
          stopLongPollLoop();
          break;
        }

        const controller = new AbortController();
        longPollAbortController = controller;
        try {
          await pollOnceWithWait(LONG_POLL_WAIT_SECONDS, { signal: controller.signal });
        } finally {
          if (longPollAbortController === controller) {
            longPollAbortController = null;
          }
        }
        consecutiveErrors = 0;

        if (loopGeneration !== longPollGeneration || !longPollActive) {
          break;
        }

        // Small delay to prevent CPU spin between polls
        await sleep(RECONNECT_DELAY_MS);

      } catch (err) {
        if (err?.name === "AbortError" && loopGeneration !== longPollGeneration) {
          break;
        }

        consecutiveErrors++;
        const backoff = Math.min(
          ERROR_BACKOFF_BASE_MS * Math.pow(2, consecutiveErrors - 1),
          ERROR_BACKOFF_MAX_MS
        );
        console.warn(`[aivo-relay] Long-poll error (attempt ${consecutiveErrors}), retry in ${backoff}ms:`, err?.message || err);

        // Show badge if persistent errors
        if (consecutiveErrors >= 3) {
          chrome.action.setBadgeText({ text: "!" });
          chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" }); // Amber for connectivity issues
          chrome.action.setTitle({ title: `AivoRelay: Connection issues (${consecutiveErrors} failed attempts)\n${err?.message || err}` });
        }

        await sleep(backoff);
      }
    }
  } finally {
    if (loopGeneration === longPollGeneration) {
      longPollActive = false;
      longPollAbortController = null;
    }
    console.log("[aivo-relay] Long-poll loop stopped");
  }
}

/**
 * Stop the long-poll loop (e.g., for settings changes)
 */
function stopLongPollLoop() {
  longPollActive = false;
  longPollGeneration += 1;
  if (longPollAbortController) {
    longPollAbortController.abort();
    longPollAbortController = null;
  }
}

/**
 * Restart the long-poll loop
 */
function restartLongPollLoop() {
  stopLongPollLoop();
  void longPollLoop();
}

/**
 * Poll with long-poll wait parameter
 * @param {number} waitSeconds - How long server should hold connection
 */
async function pollOnceWithWait(waitSeconds = 0, options = {}) {
  if (pollInFlight) return;
  pollInFlight = true;

  const signal = options?.signal || null;
  const rethrowErrors = options?.rethrowErrors !== false;
  let timeoutMs = waitSeconds > 0 ? LONG_POLL_TIMEOUT_MS : DEFAULT_SETTINGS.timeoutMs;

  try {
    const settings = await getSettings();
    if (settings.connectorEnabled === false) {
      await setConnectorDisabledState();
      return;
    }
    timeoutMs = waitSeconds > 0 ? LONG_POLL_TIMEOUT_MS : Number(settings.timeoutMs) || DEFAULT_SETTINGS.timeoutMs;

    const stored = await chrome.storage.local.get({
      cursor: null,
      messages: [],
      status: STATUS_DEFAULT,
      pendingBundles: {},
      recentMessageIds: [],
      boundTabIds: []
    });
    const boundTabIds = Array.isArray(stored.boundTabIds) ? stored.boundTabIds : [];

    let messageList = Array.isArray(stored.messages) ? [...stored.messages] : [];
    let pendingBundles = normalizePendingBundles(stored.pendingBundles);
    let dedupeSet = new Set(Array.isArray(stored.recentMessageIds) ? stored.recentMessageIds : []);

    // Build URL with wait parameter for long-polling
    const fetchResult = await fetchTextWithTimeout(
      buildRequestUrl(settings, stored.cursor, waitSeconds),
      timeoutMs,
      { signal }
    );
    const response = fetchResult.response;

    if (!response.ok) {
      if (response.status === 401) {
        chrome.action.setBadgeText({ text: "!" });
        chrome.action.setBadgeBackgroundColor({ color: "#b42318" });
        chrome.action.setTitle({ title: "AivoRelay: Authentication failed\nCheck that your password matches the AivoRelay app." });
        throw new Error("Authentication failed. Check that your password matches the AivoRelay app.");
      }
      const bodyText = fetchResult.bodyText;
      throw new Error(`HTTP ${response.status}: ${bodyText || "No response body"}`);
    }

    // Clear badge and reset title on successful connection
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setTitle({ title: "AivoRelay: Connected" });

    const bodyText = fetchResult.bodyText;
    const parsed = parseMaybeJson(bodyText);
    const parsedResponse = parseMessageResponse(parsed, bodyText);
    const incomingMessages = normalizeIncomingMessages(parsedResponse.messages);

    const keepalives = incomingMessages.filter(isKeepaliveMessage);
    const regularMessages = incomingMessages.filter(
      (msg) => !isKeepaliveMessage(msg) && !isStatusMessage(msg)
    );

    // Handle password update from server (two-phase commit)
    if (parsedResponse.passwordUpdate) {
      console.log("[aivo-relay] Server sent password update, saving...");
      const saved = await saveConnectorPassword(parsedResponse.passwordUpdate);
      if (saved) {
        console.log("[aivo-relay] Password saved successfully, sending acknowledgement...");
        const ackSent = await sendPasswordAck(settings, parsedResponse.passwordUpdate, timeoutMs);
        if (ackSent) {
          console.log("[aivo-relay] Password update complete (two-phase commit successful)");
        } else {
          console.warn("[aivo-relay] Password ack failed - server may still accept old password on next poll");
        }
      } else {
        console.error("[aivo-relay] CRITICAL: Failed to save new password. Extension may lose access on next request.");
      }
    }

    if (keepalives.length > 0) {
      void sendAck(settings);
    }

    const serverConfig = parsedResponse.config || null;
    const wasBound = boundTabIds.length > 0;

    for (const msg of regularMessages) {
      if (isDuplicateMessage(msg, dedupeSet, pendingBundles)) continue;

      if (msg.type === "bundle" && msg.attachments.length) {
        pendingBundles[msg.id] = ensurePendingBundle(msg, pendingBundles[msg.id]);
        messageList = upsertMessageList(messageList, buildStoredMessage(msg, {
          status: "pending",
          errors: [],
          wasBound
        }));
        continue;
      }

      const storedMessage = buildStoredMessage(msg, { status: "ok", errors: [], wasBound });
      const delivery = await deliverToBoundTabs(
        boundTabIds,
        buildForwardPayload(msg, [], "ok"),
        serverConfig,
        settings
      );
      messageList = applyDeliveryStatus(messageList, msg.id, delivery);
      messageList = upsertMessageList(messageList, storedMessage);
      dedupeSet.add(msg.id);
    }

    const bundleOutcome = await processPendingBundles(
      pendingBundles,
      settings,
      boundTabIds,
      messageList,
      dedupeSet,
      serverConfig
    );
    pendingBundles = bundleOutcome.pendingBundles;
    messageList = bundleOutcome.messageList;
    dedupeSet = bundleOutcome.dedupeSet;

    const nextCursor = resolveCursor(parsedResponse.cursor, parsed, incomingMessages, stored.cursor);
    const { status: prevStatus } = stored;

    await chrome.storage.local.set({
      cursor: nextCursor,
      messages: await trimMessageList(messageList),
      pendingBundles: trimPendingBundles(pendingBundles),
      recentMessageIds: trimDedupeList(dedupeSet),
      status: {
        ...prevStatus,
        lastPollAt: Date.now(),
        lastSuccessAt: Date.now(),
        lastError: null,
        connected: true,
        lastKeepaliveAt: keepalives.length ? Date.now() : prevStatus.lastKeepaliveAt
      }
    });
  } catch (err) {
    const abortedByCaller = err?.name === "AbortError" && signal?.aborted;
    if (!abortedByCaller) {
      const errorMessage =
        err?.name === "AbortError"
          ? `Request timed out after ${timeoutMs}ms`
          : err?.message || String(err);
      const { status: previousStatus } = await chrome.storage.local.get({
        status: STATUS_DEFAULT
      });
      await chrome.storage.local.set({
        status: {
          lastPollAt: Date.now(),
          lastSuccessAt: previousStatus?.lastSuccessAt ?? null,
          lastError: errorMessage,
          connected: false
        }
      });
    }
    if (rethrowErrors) {
      throw err;
    }
  } finally {
    pollInFlight = false;
  }
}

/**
 * Legacy poll function - immediate response, no wait
 * Kept for backward compatibility and fallback scenarios
 */
async function pollOnce() {
  return pollOnceWithWait(0, { rethrowErrors: false });
}

async function processPendingBundles(pendingBundles, settings, boundTabIds, messageList, dedupeSet, serverConfig = null) {
  // Sort pending bundles by creation time DESCENDING (Newest First)
  // This ensures that fresh messages are prioritized over old stuck ones.
  const pendingIds = Object.keys(pendingBundles).sort((a, b) => {
    const timeA = pendingBundles[a]?.createdAt || 0;
    const timeB = pendingBundles[b]?.createdAt || 0;
    return timeB - timeA;
  });
  if (!pendingIds.length) {
    return { pendingBundles, messageList, dedupeSet };
  }

  const tabIds = Array.isArray(boundTabIds) ? boundTabIds : [];
  const wasBound = tabIds.length > 0;

  for (const id of pendingIds) {
    const entry = pendingBundles[id];
    if (!shouldAttemptBundle(entry)) continue;

    const result = await resolveBundle(entry, settings);
    const updatedEntry = {
      ...entry,
      attempts: result.attempts,
      errors: result.errors,
      lastAttemptAt: Date.now()
    };

    if (result.status === "ok") {
      const payloadAttachments = result.attachments.map((attachment) => ({
        attId: attachment.attId,
        filename: attachment.filename,
        mime: attachment.mime,
        size: attachment.size,
        kind: attachment.kind,
        bytes: attachment.bytes ? Array.from(new Uint8Array(attachment.bytes)) : null,
        sha256: attachment.sha256
      }));
      const payload = buildForwardPayload(entry, payloadAttachments, "ok");
      const delivery = await deliverToBoundTabs(tabIds, payload, serverConfig, settings);
      messageList = applyDeliveryStatus(messageList, entry.id, delivery);
      messageList = upsertMessageList(messageList, buildStoredMessage(entry, {
        status: "ok",
        errors: [],
        wasBound
      }));
      dedupeSet.add(entry.id);
      delete pendingBundles[id];
      continue;
    }

    if (result.status === "retry") {
      console.warn("[aivo-relay] Bundle retry scheduled", entry.id, result.errors);
      pendingBundles[id] = updatedEntry;
      messageList = upsertMessageList(messageList, buildStoredMessage(entry, {
        status: "pending",
        errors: result.errors,
        wasBound
      }));
      continue;
    }

    console.warn("[aivo-relay] Bundle failed", entry.id, result.errors);
    const payload = buildForwardPayload(entry, [], "error", result.errors);
    const delivery = await deliverToBoundTabs(tabIds, payload, serverConfig, settings);
    messageList = applyDeliveryStatus(messageList, entry.id, {
      ...delivery,
      overrideStatus: "bundle_error"
    });
    messageList = upsertMessageList(messageList, buildStoredMessage(entry, {
      status: "error",
      errors: result.errors,
      wasBound
    }));
    dedupeSet.add(entry.id);
    delete pendingBundles[id];
  }

  return { pendingBundles, messageList, dedupeSet };
}

function isDuplicateMessage(message, dedupeSet, pendingBundles) {
  if (!message?.id) return false;
  if (dedupeSet.has(message.id)) return true;
  if (pendingBundles && pendingBundles[message.id]) return true;
  return false;
}

async function deliverToBoundTabs(boundTabIds, payload, serverConfig = null, settings = null) {
  let tabIds = Array.isArray(boundTabIds) ? [...boundTabIds] : [];

  if (tabIds.length === 0 && serverConfig?.autoOpenTabUrl) {
    try {
      console.log("[aivo-relay] No bound tabs, auto-opening:", serverConfig.autoOpenTabUrl);
      const newTab = await chrome.tabs.create({
        url: serverConfig.autoOpenTabUrl,
        active: true
      });

      // Wait for tab to load before binding
      await waitForTabLoad(newTab.id);

      // Bind to the new tab
      await bindTabById(newTab.id);
      tabIds = [newTab.id];
      console.log("[aivo-relay] Auto-bound to new tab:", newTab.id);
    } catch (err) {
      console.warn("[aivo-relay] Failed to auto-open tab:", err);
      return { ok: false, reason: "auto_open_failed", error: err?.message || String(err) };
    }
  }

  if (tabIds.length === 0) {
    return { ok: false, reason: "unbound", detail: "No bound tabs" };
  }

  // Deliver to all bound tabs
  const results = [];
  for (const tabId of tabIds) {
    try {
      await sendMessageToTabWithRetries(tabId, {
        type: "NEW_MESSAGE",
        payload,
        text: payload?.text
      });
      results.push({ tabId, ok: true });
    } catch (err) {
      console.warn("[aivo-relay] Failed to send message to tab", tabId, err);
      results.push({ tabId, ok: false, error: err?.message || String(err) });
    }
  }

  // Return aggregate status - ok if at least one succeeded
  const anyOk = results.some(r => r.ok);
  const allOk = results.every(r => r.ok);
  const failedCount = results.filter(r => !r.ok).length;

  if (allOk) {
    return { ok: true, deliveredCount: results.length };
  }
  if (anyOk) {
    return { ok: true, deliveredCount: results.length - failedCount, partialFailure: true, failedCount };
  }
  return { ok: false, reason: "send_failed", error: "All deliveries failed", failedCount };
}

async function sendMessageToTabWithRetries(tabId, message, maxAttempts = 8, delayMs = 300) {
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return;
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts - 1) {
        break;
      }
      await sleep(delayMs);
    }
  }
  throw lastError || new Error("Failed to deliver message to tab");
}

/**
 * Wait for a tab to finish loading
 * @param {number} tabId - The tab ID to wait for
 * @param {number} timeoutMs - Maximum time to wait (default 10 seconds)
 * @returns {Promise<void>}
 */
async function waitForTabLoad(tabId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const checkTab = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") {
          resolve();
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          resolve(); // Resolve anyway after timeout
          return;
        }

        setTimeout(checkTab, 200);
      } catch (err) {
        reject(err);
      }
    };

    checkTab();
  });
}

function buildForwardPayload(message, attachments, status, errors = []) {
  return {
    id: message.id,
    ts: message.ts,
    text: message.text,
    attachments: attachments || [],
    status: status || "ok",
    errors: errors || []
  };
}

async function retryMessage(messageId) {
  if (!messageId) throw new Error("Missing messageId");
  const stored = await chrome.storage.local.get({
    messages: [],
    pendingBundles: {},
    boundTabIds: [],
    recentMessageIds: []
  });

  const boundTabIds = Array.isArray(stored.boundTabIds) ? stored.boundTabIds : [];
  const messageList = Array.isArray(stored.messages) ? [...stored.messages] : [];
  const target = messageList.find((msg) => msg.id === messageId);
  if (!target) throw new Error("Message not found");

  let pendingBundles = normalizePendingBundles(stored.pendingBundles);
  let dedupeSet = new Set(Array.isArray(stored.recentMessageIds) ? stored.recentMessageIds : []);

  if (target.type === "bundle" && Array.isArray(target.attachments) && target.attachments.length) {
    pendingBundles[messageId] = {
      id: target.id,
      ts: target.ts,
      text: target.text,
      type: target.type,
      attachments: target.attachments,
      attempts: {},
      errors: [],
      createdAt: target.createdAt || Date.now(),
      lastAttemptAt: 0
    };

    const updated = upsertMessageList(messageList, {
      id: target.id,
      status: "pending",
      errors: [],
      retryCount: (target.retryCount || 0) + 1
    });

    const settings = await getSettings();
    const outcome = await processPendingBundles(
      pendingBundles,
      settings,
      boundTabIds,
      updated,
      dedupeSet
    );

    await chrome.storage.local.set({
      messages: await trimMessageList(outcome.messageList),
      pendingBundles: trimPendingBundles(outcome.pendingBundles),
      recentMessageIds: trimDedupeList(outcome.dedupeSet)
    });
    return;
  }

  const payload = buildForwardPayload(target, [], "ok");
  const settings = await getSettings();
  const delivery = await deliverToBoundTabs(boundTabIds, payload, null, settings);
  const updated = applyDeliveryStatus(messageList, target.id, {
    ...delivery,
    overrideStatus: delivery.ok ? "queued" : delivery.reason
  });

  // Increment retry count for text messages too
  const withRetryCount = upsertMessageList(updated, {
    id: target.id,
    retryCount: (target.retryCount || 0) + 1
  });

  await chrome.storage.local.set({ messages: await trimMessageList(withRetryCount) });
}
