'use strict';

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  await setupAlarm(); // Keep alarm as fallback/heartbeat
  const settings = await getSettings();
  if (settings.connectorEnabled === false) {
    await setConnectorDisabledState();
    return;
  }
  longPollLoop(); // Start long-poll loop (don't await - runs in background)
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
  await setupAlarm(); // Keep alarm as fallback/heartbeat
  const settings = await getSettings();
  if (settings.connectorEnabled === false) {
    await setConnectorDisabledState();
    return;
  }
  longPollLoop(); // Start long-poll loop
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "poll-messages") return;
  void getSettings().then((settings) => {
    if (settings.connectorEnabled === false) {
      stopLongPollLoop();
      void setConnectorDisabledState();
      return;
    }
    // Fallback: restart long-poll loop if it died
    if (!longPollActive) {
      console.log("[aivo-relay] Alarm triggered, restarting long-poll loop");
      longPollLoop();
    }
    // Also do a quick immediate poll as heartbeat
    void pollOnce();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    void clearConnectorSession();
    void setupAlarm();
    if (changes.settings.newValue?.connectorEnabled === false) {
      stopLongPollLoop();
      void setConnectorDisabledState();
    } else {
      restartLongPollLoop();
    }
    return;
  }
  if (area === "sync" && changes.connectorPassword) {
    void clearConnectorSession();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.title && !changeInfo.url) return;
  chrome.storage.local.get({ boundTabIds: [], boundTabInfos: {} }).then(({ boundTabIds, boundTabInfos }) => {
    if (!Array.isArray(boundTabIds) || !boundTabIds.includes(tabId)) return;
    const info = buildTabInfo(tab);
    const updatedInfos = { ...boundTabInfos, [tabId]: info };
    chrome.storage.local.set({ boundTabInfos: updatedInfos });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get({ boundTabIds: [], boundTabInfos: {} }).then(({ boundTabIds, boundTabInfos }) => {
    if (!Array.isArray(boundTabIds) || !boundTabIds.includes(tabId)) return;
    const updatedIds = boundTabIds.filter(id => id !== tabId);
    const updatedInfos = { ...boundTabInfos };
    delete updatedInfos[tabId];
    chrome.storage.local.set({ boundTabIds: updatedIds, boundTabInfos: updatedInfos });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "POLL_NOW") {
    getSettings()
      .then((settings) => {
        if (settings.connectorEnabled === false) {
          return setConnectorDisabledState().then(() => ({ ok: true, skipped: "disabled" }));
        }
        return pollOnce().then(() => ({ ok: true }));
      })
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "REPORT_STATUS") {
    handleReportStatus(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "BIND_TAB") {
    bindTabById(message.tabId)
      .then((info) => sendResponse({ ok: true, boundTabId: info?.id ?? null }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "UNBIND_TAB") {
    const tabIdToUnbind = message.tabId;
    const unbindPromise = Number.isInteger(tabIdToUnbind)
      ? unbindTabById(tabIdToUnbind)
      : unbindAllTabs();
    unbindPromise
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "TOGGLE_BIND") {
    toggleBindForSender(sender)
      .then((info) => sendResponse({ ok: true, boundTabId: info?.id ?? null }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "GET_TAB_CONTEXT") {
    sendResponse({ ok: true, tabId: sender?.tab?.id ?? null });
    return false;
  }
  if (message?.type === "RETRY_MESSAGE" || message?.type === "RESEND_MESSAGE") {
    retryMessage(message?.id || message?.messageId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "GET_ATTACHMENT_DATA") {
    getAttachmentData(message?.payload)
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});
