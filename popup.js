const DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 38243,
  path: "/messages",
  autoSend: true,
  singleTabBindingMode: true
};

const DEFAULT_PASSWORD = "befc3aa14cc05e56011865df1c49d16ef9100a53d9bfa02be8d4ffd386324f65";
const MIN_CONNECTOR_PASSWORD_LEN = 64;

const portInput = document.getElementById("port");
const autoSendInput = document.getElementById("auto-send");
const singleTabModeInput = document.getElementById("single-tab-mode");
const serverUrlEl = document.getElementById("server-url");
const statusEl = document.getElementById("status");
const messagesEl = document.getElementById("messages");
const countEl = document.getElementById("message-count");
const bindTabBtn = document.getElementById("bind-tab");
const unbindTabBtn = document.getElementById("unbind-tab");
const unbindAllBtn = document.getElementById("unbind-all");
const boundStatusEl = document.getElementById("bound-status");
const boundTabsListEl = document.getElementById("bound-tabs-list");
const keepaliveIndicatorEl = document.getElementById("keepalive-indicator");
const clearMessagesBtn = document.getElementById("clear-messages");
const passwordInput = document.getElementById("password");
const passwordToggleBtn = document.getElementById("password-toggle");
const passwordSavedEl = document.getElementById("password-saved");
const popupToastEl = document.getElementById("popup-toast");
const eyeIcon = document.getElementById("eye-icon");
const eyeOffIcon = document.getElementById("eye-off-icon");
const statusBannerEl = document.getElementById("status-banner");
const statusBannerTitleEl = document.getElementById("status-banner-title");
const statusBannerHintEl = document.getElementById("status-banner-hint");
const statusBannerIconEl = statusBannerEl?.querySelector(".status-banner-icon");
const extensionVersionEl = document.getElementById("extension-version");

let currentSettings = { ...DEFAULT_SETTINGS };
let currentBoundTabIds = [];
let currentBoundTabInfos = {};
let saveTimer = null;
let passwordSaveTimer = null;
let passwordInvalidToastTimer = null;
let refreshInterval = null;
let popupToastHideTimer = null;
const attachmentPreviewCache = new Map();

init();

async function init() {
  renderExtensionVersion();
  await loadState();
  await loadPassword();
  chrome.storage.onChanged.addListener(handleStorageChange);
  portInput.addEventListener("input", handlePortInput);
  autoSendInput.addEventListener("change", handleAutoSendChange);
  if (singleTabModeInput) {
    singleTabModeInput.addEventListener("change", handleSingleTabModeChange);
  }
  bindTabBtn.addEventListener("click", handleBindTab);
  if (clearMessagesBtn) {
    clearMessagesBtn.addEventListener("click", handleClearMessages);
  }
  if (unbindTabBtn) {
    unbindTabBtn.addEventListener("click", handleUnbindTab);
  }
  if (unbindAllBtn) {
    unbindAllBtn.addEventListener("click", handleUnbindAll);
  }
  if (passwordInput) {
    passwordInput.addEventListener("input", handlePasswordInput);
  }
  if (passwordToggleBtn) {
    passwordToggleBtn.addEventListener("click", handlePasswordToggle);
  }

  refreshInterval = setInterval(updateTimedUI, 1000);

  void requestConnect();
}

function renderExtensionVersion() {
  if (!extensionVersionEl) return;

  try {
    const version = chrome?.runtime?.getManifest?.()?.version;
    extensionVersionEl.textContent = version ? `v${version}` : "";
  } catch {
    extensionVersionEl.textContent = "";
  }
}

async function loadPassword() {
  try {
    const { connectorPassword } = await chrome.storage.sync.get({ connectorPassword: DEFAULT_PASSWORD });
    if (passwordInput) {
      passwordInput.value = connectorPassword || DEFAULT_PASSWORD;
      updatePasswordValidity(passwordInput.value);
    }
  } catch (err) {
    console.warn("Failed to load password", err);
    if (passwordInput) {
      passwordInput.value = DEFAULT_PASSWORD;
      updatePasswordValidity(passwordInput.value);
    }
  }
}

function isAllowedConnectorPassword(password) {
  return password.length >= MIN_CONNECTOR_PASSWORD_LEN;
}

function updatePasswordValidity(password) {
  if (!passwordInput) return false;

  const isValid = isAllowedConnectorPassword(password);
  passwordInput.classList.toggle("invalid", !isValid);
  passwordInput.title = isValid
    ? ""
    : `Password must be at least ${MIN_CONNECTOR_PASSWORD_LEN} characters long.`;
  return isValid;
}

function handlePasswordInput() {
  if (passwordSaveTimer) clearTimeout(passwordSaveTimer);
  if (passwordInvalidToastTimer) clearTimeout(passwordInvalidToastTimer);
  const password = (passwordInput.value || "").trim();
  if (!updatePasswordValidity(password)) {
    if (password) {
      passwordInvalidToastTimer = setTimeout(() => {
        showPopupToast(`Password not saved. Password must be at least ${MIN_CONNECTOR_PASSWORD_LEN} symbols.`);
      }, 500);
    }
    return;
  }

  hidePopupToast();
  passwordSaveTimer = setTimeout(async () => {
    try {
      await chrome.storage.sync.set({ connectorPassword: password });
      await chrome.storage.local.remove("connectorSession");
      showPasswordSaved();
      // Trigger a reconnect with new password
      try {
        await chrome.runtime.sendMessage({ type: "POLL_NOW" });
      } catch {
        // Ignore background startup timing.
      }
    } catch (err) {
      console.error("Failed to save password", err);
    }
  }, 500);
}

function showPasswordSaved() {
  if (!passwordSavedEl) return;
  passwordSavedEl.classList.add("visible");
  setTimeout(() => {
    passwordSavedEl.classList.remove("visible");
  }, 2000);
}

function showPopupToast(message) {
  if (!popupToastEl) return;
  popupToastEl.textContent = message;
  popupToastEl.classList.add("visible");
  if (popupToastHideTimer) clearTimeout(popupToastHideTimer);
  popupToastHideTimer = setTimeout(() => {
    popupToastEl.classList.remove("visible");
  }, 2600);
}

function hidePopupToast() {
  if (!popupToastEl) return;
  if (popupToastHideTimer) {
    clearTimeout(popupToastHideTimer);
    popupToastHideTimer = null;
  }
  popupToastEl.classList.remove("visible");
}

function handlePasswordToggle() {
  if (!passwordInput || !eyeIcon || !eyeOffIcon) return;

  if (passwordInput.type === "password") {
    passwordInput.type = "text";
    eyeIcon.style.display = "none";
    eyeOffIcon.style.display = "block";
  } else {
    passwordInput.type = "password";
    eyeIcon.style.display = "block";
    eyeOffIcon.style.display = "none";
  }
}

async function loadState() {
  const { settings, messages, status, boundTabIds, boundTabInfos } = await chrome.storage.local.get({
    settings: DEFAULT_SETTINGS,
    messages: [],
    status: {
      lastPollAt: null,
      lastSuccessAt: null,
      lastError: null,
      connected: false,
      lastKeepaliveAt: null
    },
    boundTabIds: [],
    boundTabInfos: {}
  });

  currentSettings = { ...DEFAULT_SETTINGS, ...settings };
  currentBoundTabIds = Array.isArray(boundTabIds) ? boundTabIds : [];
  currentBoundTabInfos = boundTabInfos && typeof boundTabInfos === "object" ? boundTabInfos : {};
  renderSettings();
  renderStatus(status);
  renderMessages(messages);
  renderBoundStatus(currentBoundTabIds, currentBoundTabInfos);
  updateKeepaliveIndicator(status.lastKeepaliveAt);
  updateStatusBanner(status, currentBoundTabIds);
}

function handleStorageChange(changes, area) {
  if (area !== "local") return;

  let statusChanged = false;
  let boundChanged = false;

  if (changes.settings) {
    currentSettings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    renderSettings();
  }

  if (changes.status) {
    renderStatus(changes.status.newValue);
    updateKeepaliveIndicator(changes.status.newValue?.lastKeepaliveAt);
    statusChanged = true;
  }

  if (changes.messages) {
    renderMessages(changes.messages.newValue || []);
  }

  if (changes.boundTabIds) {
    currentBoundTabIds = Array.isArray(changes.boundTabIds.newValue) ? changes.boundTabIds.newValue : [];
    boundChanged = true;
  }

  if (changes.boundTabInfos) {
    currentBoundTabInfos = changes.boundTabInfos.newValue && typeof changes.boundTabInfos.newValue === "object"
      ? changes.boundTabInfos.newValue
      : {};
    boundChanged = true;
  }

  if (boundChanged) {
    renderBoundStatus(currentBoundTabIds, currentBoundTabInfos);
  }

  if (statusChanged || boundChanged) {
    chrome.storage.local.get("status").then(({ status }) => {
      updateStatusBanner(status, currentBoundTabIds);
    });
  }
}

async function handleBindTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  try {
    await chrome.runtime.sendMessage({ type: "BIND_TAB", tabId: tab.id });
  } catch (err) {
    console.error("Failed to bind tab", err);
  }
}

async function handleUnbindTab() {
  // Legacy: unbind all tabs (for single-tab mode compatibility)
  try {
    await chrome.runtime.sendMessage({ type: "UNBIND_TAB" });
  } catch (err) {
    console.error("Failed to unbind tab", err);
  }
}

async function handleUnbindAll() {
  try {
    await chrome.runtime.sendMessage({ type: "UNBIND_TAB" }); // No tabId = unbind all
  } catch (err) {
    console.error("Failed to unbind all tabs", err);
  }
}

async function handleUnbindSingleTab(tabId) {
  try {
    await chrome.runtime.sendMessage({ type: "UNBIND_TAB", tabId });
  } catch (err) {
    console.error("Failed to unbind tab", tabId, err);
  }
}

function handleSingleTabModeChange() {
  if (!singleTabModeInput) return;
  scheduleSave({ ...currentSettings, singleTabBindingMode: singleTabModeInput.checked });
}

async function handleClearMessages() {
  clearAttachmentPreviewCache();
  try {
    await chrome.storage.local.set({ messages: [] });
  } catch (err) {
    console.error("Failed to clear messages", err);
  }
}

function renderBoundStatus(boundTabIds, boundTabInfos) {
  const tabIds = Array.isArray(boundTabIds) ? boundTabIds : [];
  const tabInfos = boundTabInfos && typeof boundTabInfos === "object" ? boundTabInfos : {};

  // Update unbind buttons state
  if (unbindTabBtn) unbindTabBtn.disabled = tabIds.length === 0;
  if (unbindAllBtn) unbindAllBtn.disabled = tabIds.length === 0;

  // Update summary text
  if (tabIds.length === 0) {
    boundStatusEl.textContent = "No tabs bound";
    boundStatusEl.title = "";
  } else if (tabIds.length === 1) {
    const info = tabInfos[tabIds[0]];
    const label = info ? formatBoundTabLabel(info) : `Tab ${tabIds[0]}`;
    boundStatusEl.textContent = `Bound to: ${label}`;
    boundStatusEl.title = info?.url || "";
  } else {
    boundStatusEl.textContent = `Bound to ${tabIds.length} tabs`;
    boundStatusEl.title = "";
  }

  // Render list of bound tabs if element exists
  if (boundTabsListEl) {
    boundTabsListEl.innerHTML = "";

    if (tabIds.length === 0) {
      boundTabsListEl.style.display = "none";
      return;
    }

    boundTabsListEl.style.display = "block";

    for (const tabId of tabIds) {
      const info = tabInfos[tabId];
      const item = document.createElement("div");
      item.className = "bound-tab-item";

      const label = document.createElement("span");
      label.className = "bound-tab-label";
      label.textContent = info ? formatBoundTabLabel(info) : `Tab ${tabId}`;
      label.title = info?.url || "";

      const unbindBtn = document.createElement("button");
      unbindBtn.type = "button";
      unbindBtn.className = "btn-unbind-single";
      unbindBtn.textContent = "×";
      unbindBtn.title = "Unbind this tab";
      unbindBtn.addEventListener("click", () => handleUnbindSingleTab(tabId));

      item.append(label, unbindBtn);
      boundTabsListEl.appendChild(item);
    }
  }
}

function formatBoundTabLabel(tab) {
  const title = typeof tab.title === "string" ? tab.title.trim() : "";
  const host = extractHostname(tab.url);
  if (host && title) return `${host} | ${title}`;
  if (host) return host;
  if (title) return title;
  if (tab.id != null) return `Tab ${tab.id}`;
  return "Bound tab";
}

function extractHostname(url) {
  if (!url || typeof url !== "string") return "";
  try {
    return new URL(url).hostname || "";
  } catch {
    return "";
  }
}

function updateTimedUI() {
  chrome.storage.local.get("status").then(({ status }) => {
    updateKeepaliveIndicator(status?.lastKeepaliveAt);
  });
}

function updateKeepaliveIndicator(lastKeepaliveAt) {
  if (!lastKeepaliveAt) {
    keepaliveIndicatorEl.classList.remove("active");
    keepaliveIndicatorEl.title = "No keepalive received";
    return;
  }

  const now = Date.now();
  const diff = now - lastKeepaliveAt;

  // Green if received in the last 30 seconds
  if (diff < 30000) {
    keepaliveIndicatorEl.classList.add("active");
    keepaliveIndicatorEl.title = `Last keepalive: ${formatTime(lastKeepaliveAt)}`;
  } else {
    keepaliveIndicatorEl.classList.remove("active");
    keepaliveIndicatorEl.title = `Keepalive stale - Last: ${formatTime(lastKeepaliveAt)}`;
  }
}

function handlePortInput() {
  const value = Number(portInput.value);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    portInput.classList.add("invalid");
    return;
  }

  portInput.classList.remove("invalid");
  scheduleSave({ ...currentSettings, port: value });
}

function handleAutoSendChange() {
  scheduleSave({ ...currentSettings, autoSend: autoSendInput.checked });
}

function scheduleSave(nextSettings) {
  currentSettings = nextSettings;
  renderSettings();

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await chrome.storage.local.set({ settings: currentSettings });
    try {
      chrome.runtime.sendMessage({ type: "POLL_NOW" });
    } catch {
      // Ignore background startup timing.
    }
  }, 300);
}

function renderSettings() {
  if (document.activeElement !== portInput) {
    portInput.value = currentSettings.port ?? DEFAULT_SETTINGS.port;
  }
  autoSendInput.checked = currentSettings.autoSend !== false;
  if (singleTabModeInput) {
    singleTabModeInput.checked = currentSettings.singleTabBindingMode !== false;
  }
  serverUrlEl.textContent = `http://${currentSettings.host}:${currentSettings.port}`;
}

function renderStatus(status) {
  if (!status) {
    statusEl.textContent = "Waiting for first check...";
    statusEl.classList.remove("error");
    return;
  }

  if (status.lastError) {
    const lastSuccess = status.lastSuccessAt
      ? ` Last success: ${formatTime(status.lastSuccessAt)}.`
      : "";
    statusEl.textContent = `Connection failed: ${status.lastError}.${lastSuccess}`;
    statusEl.classList.add("error");
    return;
  }

  if (status.connected) {
    const lastCheck = status.lastPollAt
      ? formatTime(status.lastPollAt)
      : "Just now";
    statusEl.textContent = `Connected - Last check: ${lastCheck}`;
    statusEl.classList.remove("error");
    return;
  }

  if (status.lastPollAt) {
    statusEl.textContent = `Last check: ${formatTime(status.lastPollAt)}`;
    statusEl.classList.remove("error");
    return;
  }

  statusEl.textContent = "Waiting for first check...";
  statusEl.classList.remove("error");
}

/**
 * Updates the prominent status banner based on connection and binding state
 */
function updateStatusBanner(status, boundTabIds) {
  if (!statusBannerEl) return;

  const isConnected = status?.connected && !status?.lastError;
  const tabIds = Array.isArray(boundTabIds) ? boundTabIds : [];
  const isBound = tabIds.length > 0;

  // SVG icons for different states
  const disconnectedIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"></circle>
    <line x1="12" y1="8" x2="12" y2="12"></line>
    <line x1="12" y1="16" x2="12.01" y2="16"></line>
  </svg>`;

  const warningIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
    <line x1="12" y1="9" x2="12" y2="13"></line>
    <line x1="12" y1="17" x2="12.01" y2="17"></line>
  </svg>`;

  const readyIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
    <polyline points="22 4 12 14.01 9 11.01"></polyline>
  </svg>`;

  statusBannerEl.classList.remove("disconnected", "connected-unbound", "ready");

  if (!isConnected) {
    // Disconnected state
    statusBannerEl.classList.add("disconnected");
    if (statusBannerIconEl) statusBannerIconEl.innerHTML = disconnectedIcon;
    if (statusBannerTitleEl) statusBannerTitleEl.textContent = "Disconnected";
    if (statusBannerHintEl) {
      if (status?.lastError?.includes("Authentication")) {
        statusBannerHintEl.textContent = "Check your connection password matches the AivoRelay app.";
      } else {
        statusBannerHintEl.textContent = "Make sure AivoRelay app is running on your computer.";
      }
    }
  } else if (!isBound) {
    // Connected but no tab bound
    statusBannerEl.classList.add("connected-unbound");
    if (statusBannerIconEl) statusBannerIconEl.innerHTML = warningIcon;
    if (statusBannerTitleEl) statusBannerTitleEl.textContent = "Connected - No Tab Bound";
    if (statusBannerHintEl) {
      statusBannerHintEl.textContent = "Bind a tab manually, or AivoRelay may auto-open one if configured.";
    }
  } else {
    // Fully ready
    statusBannerEl.classList.add("ready");
    if (statusBannerIconEl) statusBannerIconEl.innerHTML = readyIcon;
    if (statusBannerTitleEl) statusBannerTitleEl.textContent = tabIds.length > 1 ? `Ready (${tabIds.length} tabs)` : "Ready";
    if (statusBannerHintEl) {
      const tabWord = tabIds.length > 1 ? "bound tabs" : "the bound tab";
      statusBannerHintEl.textContent = `Messages from AivoRelay will be sent to ${tabWord} automatically.`;
    }
  }
}

async function requestConnect() {
  try {
    await chrome.runtime.sendMessage({ type: "POLL_NOW" });
  } catch {
    // Ignore background startup timing.
  }
}

function renderMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  countEl.textContent = String(list.length);
  messagesEl.textContent = "";
  if (clearMessagesBtn) clearMessagesBtn.disabled = list.length === 0;

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No messages yet.";
    messagesEl.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  const ordered = [...list].reverse();

  for (const message of ordered) {
    const card = document.createElement("div");
    card.className = "message";

    const time = document.createElement("div");
    time.className = "message-time";
    const timeText = Number.isFinite(message.ts)
      ? formatTime(message.ts)
      : "Just now";
    const boundLabel = message.wasBound === true ? "Bound" : message.wasBound === false ? "Unbound" : "";
    time.textContent = boundLabel ? `${timeText} · ${boundLabel}` : timeText;

    const statusLine = buildMessageStatusLine(message);
    const statusEl = document.createElement("div");
    statusEl.className = "message-status";
    statusEl.textContent = statusLine || "";
    if (!statusLine) {
      statusEl.style.display = "none";
    }
    const errorSummary = summarizeAttachmentErrors(message.errors);
    const deliveryDetail = message.deliveryDetail ? String(message.deliveryDetail) : "";
    if (errorSummary || deliveryDetail) {
      statusEl.title = [errorSummary, deliveryDetail].filter(Boolean).join(" | ");
    }

    const text = document.createElement("div");
    text.className = "message-text";
    text.textContent = formatMessageText(message);

    const attachmentsEl = buildAttachmentList(message);
    const actionsEl = buildMessageActions(message);

    card.append(time, statusEl, text);
    if (attachmentsEl) {
      card.appendChild(attachmentsEl);
    }
    if (actionsEl) {
      card.appendChild(actionsEl);
    }
    fragment.appendChild(card);
  }

  messagesEl.appendChild(fragment);
}

function buildMessageStatusLine(message) {
  if (!message) return "";
  const parts = [];
  if (message.status === "pending") {
    parts.push("Attachments pending");
  } else if (message.status === "error") {
    parts.push("Attachments failed");
  }

  if (message.deliveryStatus) {
    parts.push(`Delivery: ${humanizeStatusLabel(message.deliveryStatus)}`);
  }

  if (message.retryCount) {
    parts.push(`Retries: ${message.retryCount}`);
  }

  return parts.join(" | ");
}

function humanizeStatusLabel(value) {
  if (!value) return "";
  return String(value).replace(/_/g, " ");
}

function buildAttachmentList(message) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (!attachments.length) return null;

  const wrapper = document.createElement("div");
  wrapper.className = "attachments";

  const items = attachments.slice(0, 6);
  for (const attachment of items) {
    const chip = document.createElement("div");
    chip.className = "attachment";

    if (attachment.kind === "image") {
      const img = document.createElement("img");
      img.className = "attachment-thumb";
      img.alt = attachment.filename || "image";
      chip.appendChild(img);
      requestAttachmentPreview(message.id, attachment, img);
    } else {
      const icon = document.createElement("span");
      icon.className = "attachment-icon";
      icon.textContent = "FILE";
      const label = document.createElement("span");
      label.className = "attachment-label";
      label.textContent = formatAttachmentLabel(attachment);
      chip.append(icon, label);
    }

    wrapper.appendChild(chip);
  }

  if (attachments.length > items.length) {
    const more = document.createElement("div");
    more.className = "attachment-more";
    more.textContent = `+${attachments.length - items.length} more`;
    wrapper.appendChild(more);
  }

  return wrapper;
}

function formatAttachmentLabel(attachment) {
  const name = attachment?.filename ? String(attachment.filename) : "attachment";
  if (Number.isFinite(Number(attachment?.size))) {
    return `${name} (${formatBytes(attachment.size)})`;
  }
  return name;
}

function formatBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function summarizeAttachmentErrors(errors) {
  if (!Array.isArray(errors) || !errors.length) return "";
  const first = errors[0];
  const message = first?.message || first?.code || "failed";
  return String(message).replace(/_/g, " ");
}

function buildMessageActions(message) {
  if (!shouldShowRetry(message)) return null;
  const actions = document.createElement("div");
  actions.className = "message-actions";

  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "retry-btn";
  retryBtn.textContent = "Retry";
  retryBtn.addEventListener("click", () => {
    void requestRetryMessage(message.id);
  });

  actions.appendChild(retryBtn);
  return actions;
}

function shouldShowRetry(message) {
  if (!message) return false;
  if (message.status === "error") return true;
  const retryable = new Set([
    "send_not_found",
    "editor_not_found",
    "insert_failed",
    "dropped_busy",
    "send_failed",
    "attachment_failed",
    "bundle_error",
    "bundle_failed",
    "unbound"
  ]);
  return retryable.has(message.deliveryStatus);
}

async function requestRetryMessage(messageId) {
  if (!messageId) return;
  try {
    await chrome.runtime.sendMessage({ type: "RETRY_MESSAGE", id: messageId });
  } catch (err) {
    console.error("Failed to request retry", err);
  }
}

async function requestAttachmentPreview(messageId, attachment, imgEl) {
  if (!messageId || !attachment?.attId || !imgEl) return;
  const key = `${messageId}:${attachment.attId}`;
  const cachedUrl = attachmentPreviewCache.get(key);
  if (cachedUrl) {
    imgEl.src = cachedUrl;
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_ATTACHMENT_DATA",
      payload: { messageId, attId: attachment.attId }
    });
    if (!response?.ok || !response.payload?.bytes) return;
    const mime = response.payload.meta?.mime || attachment.mime || "application/octet-stream";
    const bytes = Array.isArray(response.payload.bytes)
      ? new Uint8Array(response.payload.bytes)
      : response.payload.bytes;
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    attachmentPreviewCache.set(key, url);
    imgEl.src = url;
  } catch (err) {
    console.warn("Failed to load attachment preview", err);
  }
}

function clearAttachmentPreviewCache() {
  for (const url of attachmentPreviewCache.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Ignore revoke errors.
    }
  }
  attachmentPreviewCache.clear();
}

function formatMessageText(message) {
  if (!message) return "";
  if (message.text) return String(message.text);
  if (message.raw) {
    return typeof message.raw === "string"
      ? message.raw
      : JSON.stringify(message.raw, null, 2);
  }
  return "";
}

function formatTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch {
    return "Just now";
  }
}
