const DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 38243,
  path: "/messages",
  connectorEnabled: true,
  autoSend: true,
  singleTabBindingMode: true
};

const DEFAULT_PASSWORD = "befc3aa14cc05e56011865df1c49d16ef9100a53d9bfa02be8d4ffd386324f65";
const MIN_CONNECTOR_PASSWORD_LEN = 64;
const STATUS_DEFAULT = {
  lastPollAt: null,
  lastSuccessAt: null,
  lastError: null,
  connected: false,
  lastKeepaliveAt: null
};
const shared = window.AivoRelaySelectorShared;
const isTabView = new URLSearchParams(window.location.search).get("isTab") === "true";

const portInput = document.getElementById("port");
const autoSendInput = document.getElementById("auto-send");
const autoSendStateEl = document.getElementById("auto-send-state");
const connectorEnabledInput = document.getElementById("connector-enabled");
const connectorEnabledStateEl = document.getElementById("connector-enabled-state");
const singleTabModeInput = document.getElementById("single-tab-mode");
const singleTabStateEl = document.getElementById("single-tab-state");
const serverUrlEl = document.getElementById("server-url");
const statusEl = document.getElementById("status");
const fullMessagesEl = document.getElementById("messages-full");
const countEl = document.getElementById("message-count");
const bindTabBtn = document.getElementById("bind-tab");
const unbindTabBtn = document.getElementById("unbind-tab");
const unbindAllBtn = document.getElementById("unbind-all");
const boundStatusEl = document.getElementById("bound-status");
const boundTabsListEl = document.getElementById("bound-tabs-list");
const keepaliveIndicatorEl = document.getElementById("keepalive-indicator");
const clearMessagesFullBtn = document.getElementById("clear-messages-full");
const passwordInput = document.getElementById("password");
const copyPasswordBtn = document.getElementById("copy-password");
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
const extensionIdEl = document.getElementById("extension-id");
const copyExtensionIdBtn = document.getElementById("copy-extension-id");
const openInTabBtn = document.getElementById("open-in-tab");
const panelButtons = Array.from(document.querySelectorAll(".tab-button"));
const panelEls = Array.from(document.querySelectorAll(".panel"));
const siteTabsEl = document.getElementById("selector-site-tabs");
const saveSiteSelectorsBtn = document.getElementById("save-site-selectors");
const resetSiteSelectorsBtn = document.getElementById("reset-site-selectors");
const selectorJsonInput = document.getElementById("selector-json");
const selectorJsonDefaultsEl = document.getElementById("selector-json-defaults");
const heuristicEditorInput = document.getElementById("heuristic-editor");
const heuristicSendInput = document.getElementById("heuristic-send");
const heuristicStopInput = document.getElementById("heuristic-stop");
const ignoreStopInput = document.getElementById("ignore-stop");
const heuristicEditorStateEl = document.getElementById("heuristic-editor-state");
const heuristicSendStateEl = document.getElementById("heuristic-send-state");
const heuristicStopStateEl = document.getElementById("heuristic-stop-state");
const ignoreStopStateEl = document.getElementById("ignore-stop-state");
const pickEditorBtn = document.getElementById("pick-editor");
const pickSendBtn = document.getElementById("pick-send");
const pickStopBtn = document.getElementById("pick-stop");

let currentSettings = { ...DEFAULT_SETTINGS };
let currentSelectorSettings = shared?.normalizeSelectorSettings(shared.DEFAULT_SELECTOR_SETTINGS) || {
  heuristics: { editor: true, sendButton: true, stopButton: true, ignoreStopButton: false },
  customSelectors: {}
};
let currentSelectorSite = shared?.SUPPORTED_SITES?.[0] || "ChatGPT";
let currentStatus = { ...STATUS_DEFAULT };
let currentBoundTabIds = [];
let currentBoundTabInfos = {};
let saveTimer = null;
let passwordSaveTimer = null;
let passwordInvalidToastTimer = null;
let refreshInterval = null;
let popupToastHideTimer = null;
let resetSelectorsUndoTimer = null;
let pendingSelectorUndo = null;
const attachmentPreviewCache = new Map();

init();

async function init() {
  if (isTabView) {
    document.documentElement.classList.add("tab-mode");
    document.body.classList.add("tab-mode");
    if (openInTabBtn) openInTabBtn.hidden = true;
  }

  renderExtensionVersion();
  renderExtensionIdentity();
  renderMainTabs();
  renderSiteTabs();
  await loadState();
  await loadPassword();
  chrome.storage.onChanged.addListener(handleStorageChange);
  portInput.addEventListener("input", handlePortInput);
  autoSendInput.addEventListener("change", handleAutoSendChange);
  connectorEnabledInput?.addEventListener("change", handleConnectorEnabledChange);
  if (singleTabModeInput) {
    singleTabModeInput.addEventListener("change", handleSingleTabModeChange);
  }
  bindTabBtn.addEventListener("click", handleBindTab);
  clearMessagesFullBtn?.addEventListener("click", handleClearMessages);
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
  copyPasswordBtn?.addEventListener("click", () => void handleCopyPassword());
  openInTabBtn?.addEventListener("click", handleOpenInTab);
  copyExtensionIdBtn?.addEventListener("click", () => void handleCopyExtensionId());
  saveSiteSelectorsBtn?.addEventListener("click", () => void handleSaveSiteSelectors());
  resetSiteSelectorsBtn?.addEventListener("click", () => void handleResetSiteSelectors());
  selectorJsonInput?.addEventListener("input", () => autoResizeTextarea(selectorJsonInput));
  heuristicEditorInput?.addEventListener("change", () => void updateSelectorSettings({
    ...currentSelectorSettings,
    heuristics: { ...currentSelectorSettings.heuristics, editor: heuristicEditorInput.checked }
  }, "Editor auto-find updated."));
  heuristicSendInput?.addEventListener("change", () => void updateSelectorSettings({
    ...currentSelectorSettings,
    heuristics: { ...currentSelectorSettings.heuristics, sendButton: heuristicSendInput.checked }
  }, "Send auto-find updated."));
  heuristicStopInput?.addEventListener("change", () => void updateSelectorSettings({
    ...currentSelectorSettings,
    heuristics: { ...currentSelectorSettings.heuristics, stopButton: heuristicStopInput.checked }
  }, "Stop auto-find updated."));
  ignoreStopInput?.addEventListener("change", () => void updateSelectorSettings({
    ...currentSelectorSettings,
    heuristics: { ...currentSelectorSettings.heuristics, ignoreStopButton: ignoreStopInput.checked }
  }, ignoreStopInput.checked ? "Stop button will now be ignored." : "Stop button checks restored."));
  pickEditorBtn?.addEventListener("click", () => void startManualPick("editor"));
  pickSendBtn?.addEventListener("click", () => void startManualPick("sendButton"));
  pickStopBtn?.addEventListener("click", () => void startManualPick("stopButton"));

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

function renderExtensionIdentity() {
  if (!extensionIdEl) return;

  try {
    const extensionId = chrome?.runtime?.id || "";
    extensionIdEl.textContent = extensionId ? `chrome-extension://${extensionId}` : "";
  } catch {
    extensionIdEl.textContent = "";
  }
}

async function handleCopyExtensionId() {
  const extensionOrigin = extensionIdEl?.textContent?.trim()
    || (chrome?.runtime?.id ? `chrome-extension://${chrome.runtime.id}` : "");
  if (!extensionOrigin) {
    showPopupToast("CORS origin is unavailable right now.");
    return;
  }

  try {
    await navigator.clipboard.writeText(extensionOrigin);
    showPopupToast("CORS origin copied. Paste it into AivoRelay exactly as shown.");
  } catch {
    showPopupToast("Could not copy the CORS origin. Copy it manually from Settings.");
  }
}

async function handleCopyPassword() {
  const password = (passwordInput?.value || "").trim();
  if (!password) {
    showPopupToast("Password is unavailable right now.");
    return;
  }

  try {
    await navigator.clipboard.writeText(password);
    showPopupToast("Connector password copied.");
  } catch {
    showPopupToast("Could not copy the password. Copy it manually from Settings.");
  }
}

function renderMainTabs() {
  panelButtons.forEach((button) => {
    button.addEventListener("click", () => setActivePanel(button.dataset.panel || "settings"));
  });
  const requestedPanel = new URLSearchParams(window.location.search).get("panel");
  const validPanels = new Set(panelButtons.map((button) => button.dataset.panel).filter(Boolean));
  const fallbackPanel = isTabView ? "settings" : "messages";
  setActivePanel(validPanels.has(requestedPanel) ? requestedPanel : fallbackPanel);
}

function setActivePanel(panelName) {
  panelButtons.forEach((button) => button.classList.toggle("active", button.dataset.panel === panelName));
  panelEls.forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${panelName}`));
  if (panelName === "selectors") {
    requestAnimationFrame(() => autoResizeTextarea(selectorJsonInput));
  }
}

function handleOpenInTab() {
  const activePanel = panelButtons.find((button) => button.classList.contains("active"))?.dataset.panel || "settings";
  chrome.tabs.create({
    url: `${chrome.runtime.getURL("popup.html")}?isTab=true&panel=${encodeURIComponent(activePanel)}`
  });
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
  const { settings, selectorSettings, messages, status, boundTabIds, boundTabInfos } = await chrome.storage.local.get({
    settings: DEFAULT_SETTINGS,
    selectorSettings: shared?.DEFAULT_SELECTOR_SETTINGS,
    messages: [],
    status: STATUS_DEFAULT,
    boundTabIds: [],
    boundTabInfos: {}
  });

  currentSettings = { ...DEFAULT_SETTINGS, ...settings };
  currentSelectorSettings = shared?.normalizeSelectorSettings(selectorSettings) || currentSelectorSettings;
  currentStatus = status && typeof status === "object" ? { ...STATUS_DEFAULT, ...status } : { ...STATUS_DEFAULT };
  currentBoundTabIds = Array.isArray(boundTabIds) ? boundTabIds : [];
  currentBoundTabInfos = boundTabInfos && typeof boundTabInfos === "object" ? boundTabInfos : {};
  renderSettings();
  renderSelectorSettings();
  renderStatus(currentStatus);
  renderMessages(messages);
  renderBoundStatus(currentBoundTabIds, currentBoundTabInfos);
  updateKeepaliveIndicator(currentStatus);
  updateStatusBanner(currentStatus, currentBoundTabIds);
}

function handleStorageChange(changes, area) {
  if (area !== "local") return;

  let statusChanged = false;
  let boundChanged = false;

  if (changes.settings) {
    currentSettings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    renderSettings();
    updateKeepaliveIndicator(currentStatus);
    updateStatusBanner(currentStatus, currentBoundTabIds);
    renderStatus(currentStatus);
  }

  if (changes.selectorSettings) {
    currentSelectorSettings = shared?.normalizeSelectorSettings(changes.selectorSettings.newValue) || currentSelectorSettings;
    renderSelectorSettings();
  }

  if (changes.status) {
    currentStatus = changes.status.newValue && typeof changes.status.newValue === "object"
      ? { ...STATUS_DEFAULT, ...changes.status.newValue }
      : { ...STATUS_DEFAULT };
    renderStatus(currentStatus);
    updateKeepaliveIndicator(currentStatus);
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
    updateStatusBanner(currentStatus, currentBoundTabIds);
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
  const connectorEnabled = currentSettings.connectorEnabled !== false;

  // Update unbind buttons state
  if (bindTabBtn) bindTabBtn.disabled = !connectorEnabled;
  if (unbindTabBtn) unbindTabBtn.disabled = !connectorEnabled || tabIds.length === 0;
  if (unbindAllBtn) unbindAllBtn.disabled = !connectorEnabled || tabIds.length === 0;

  if (!connectorEnabled) {
    boundStatusEl.textContent = "Connector OFF";
    boundStatusEl.title = "";
    if (boundTabsListEl) {
      boundTabsListEl.style.display = "none";
      boundTabsListEl.innerHTML = "";
    }
    return;
  }

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

    if (tabIds.length <= 1) {
      boundTabsListEl.style.display = "none";
      return;
    }

    boundTabsListEl.style.display = "grid";

    for (const tabId of tabIds) {
      const info = tabInfos[tabId];
      const item = document.createElement("div");
      item.className = "bound-item";

      const label = document.createElement("span");
      label.className = "bound-label";
      label.textContent = info ? formatBoundTabLabel(info) : `Tab ${tabId}`;
      label.title = info?.url || "";

      const unbindBtn = document.createElement("button");
      unbindBtn.type = "button";
      unbindBtn.className = "unbind-one";
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
  updateKeepaliveIndicator(currentStatus);
}

function updateKeepaliveIndicator(status) {
  if (!keepaliveIndicatorEl) return;

  keepaliveIndicatorEl.classList.remove("active", "error");

  if (currentSettings.connectorEnabled === false) {
    keepaliveIndicatorEl.title = "Connector OFF";
    return;
  }

  if (status?.lastError) {
    keepaliveIndicatorEl.classList.add("error");
    keepaliveIndicatorEl.title = `Connection failed: ${status.lastError}`;
    return;
  }

  const lastKeepaliveAt = status?.lastKeepaliveAt;
  if (!lastKeepaliveAt) {
    keepaliveIndicatorEl.classList.add("error");
    keepaliveIndicatorEl.title = "No keepalive received";
    return;
  }

  const now = Date.now();
  const diff = now - lastKeepaliveAt;

  if (diff < 30000) {
    keepaliveIndicatorEl.classList.add("active");
    keepaliveIndicatorEl.title = `Last keepalive: ${formatTime(lastKeepaliveAt)}`;
  } else {
    keepaliveIndicatorEl.classList.add("error");
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

function handleConnectorEnabledChange() {
  scheduleSave({ ...currentSettings, connectorEnabled: connectorEnabledInput.checked });
}

function scheduleSave(nextSettings) {
  currentSettings = nextSettings;
  renderSettings();

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await chrome.storage.local.set({ settings: currentSettings });
    if (currentSettings.connectorEnabled !== false) {
      try {
        chrome.runtime.sendMessage({ type: "POLL_NOW" });
      } catch {
        // Ignore background startup timing.
      }
    }
  }, 300);
}

function renderSettings() {
  if (document.activeElement !== portInput) {
    portInput.value = currentSettings.port ?? DEFAULT_SETTINGS.port;
  }
  if (connectorEnabledInput) {
    connectorEnabledInput.checked = currentSettings.connectorEnabled !== false;
    if (connectorEnabledStateEl) {
      connectorEnabledStateEl.textContent = connectorEnabledInput.checked ? "On" : "OFF";
    }
  }
  autoSendInput.checked = currentSettings.autoSend !== false;
  if (autoSendStateEl) {
    autoSendStateEl.textContent = autoSendInput.checked ? "On" : "Off";
  }
  if (singleTabModeInput) {
    singleTabModeInput.checked = currentSettings.singleTabBindingMode !== false;
    if (singleTabStateEl) {
      singleTabStateEl.textContent = singleTabModeInput.checked ? "On" : "Off";
    }
  }
  serverUrlEl.textContent = `http://${currentSettings.host}:${currentSettings.port}`;
}

function renderSelectorSettings() {
  if (!shared) return;
  heuristicEditorInput.checked = currentSelectorSettings.heuristics.editor !== false;
  heuristicSendInput.checked = currentSelectorSettings.heuristics.sendButton !== false;
  heuristicStopInput.checked = currentSelectorSettings.heuristics.stopButton !== false;
  if (ignoreStopInput) {
    ignoreStopInput.checked = currentSelectorSettings.heuristics.ignoreStopButton === true;
  }
  heuristicEditorStateEl.textContent = heuristicEditorInput.checked ? "On" : "Off";
  heuristicSendStateEl.textContent = heuristicSendInput.checked ? "On" : "Off";
  heuristicStopStateEl.textContent = heuristicStopInput.checked ? "On" : "Off";
  if (ignoreStopStateEl) {
    ignoreStopStateEl.textContent = ignoreStopInput?.checked ? "On" : "Off";
  }
  renderSiteTabs();
  renderSelectorEditors();
}

function renderSiteTabs() {
  if (!shared || !siteTabsEl) return;
  siteTabsEl.innerHTML = "";
  for (const site of shared.SUPPORTED_SITES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `site-tab ${site === currentSelectorSite ? "active" : ""}`;
    button.textContent = shared.SITE_LABELS[site] || site;
    button.title = `Edit selectors for ${shared.SITE_LABELS[site] || site}`;
    button.addEventListener("click", () => {
      currentSelectorSite = site;
      renderSiteTabs();
      renderSelectorEditors();
      renderResetSelectorsButton();
    });
    siteTabsEl.appendChild(button);
  }
}

function renderSelectorEditors() {
  if (!shared || !selectorJsonInput || !selectorJsonDefaultsEl) return;
  const hasCustomSelectors = Boolean(currentSelectorSettings.customSelectors[currentSelectorSite]);
  const custom = currentSelectorSettings.customSelectors[currentSelectorSite] || shared.normalizeSiteSelectors({});
  const defaults = shared.getDefaultSiteSelectors(currentSelectorSite);
  const shownSelectors = hasCustomSelectors ? custom : defaults;

  selectorJsonInput.value = shared.siteSelectorsToJsonTextarea(shownSelectors);
  selectorJsonInput.placeholder = "";
  selectorJsonDefaultsEl.textContent = "";
  selectorJsonDefaultsEl.hidden = true;
  requestAnimationFrame(() => autoResizeTextarea(selectorJsonInput));
  renderResetSelectorsButton();
}

function autoResizeTextarea(textarea) {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.max(textarea.scrollHeight, 116)}px`;
}

function renderResetSelectorsButton() {
  if (!resetSiteSelectorsBtn || !shared) return;

  const isUndoActive = pendingSelectorUndo?.site === currentSelectorSite;
  if (isUndoActive) {
    resetSiteSelectorsBtn.textContent = "Undo";
    resetSiteSelectorsBtn.title = "Restore the selectors that were just removed for this site.";
    return;
  }

  resetSiteSelectorsBtn.textContent = "Reset selectors for this site";
  resetSiteSelectorsBtn.title = "Remove only the custom selectors for the selected site and fall back to defaults again.";
}

function clearPendingSelectorUndo() {
  if (resetSelectorsUndoTimer) {
    clearTimeout(resetSelectorsUndoTimer);
    resetSelectorsUndoTimer = null;
  }
  pendingSelectorUndo = null;
  renderResetSelectorsButton();
}

async function updateSelectorSettings(nextSettings, successMessage = "") {
  if (!shared) return;
  currentSelectorSettings = shared.normalizeSelectorSettings(nextSettings);
  await chrome.storage.local.set({ selectorSettings: currentSelectorSettings });
  renderSelectorSettings();
  if (successMessage) showPopupToast(successMessage);
}

async function handleSaveSiteSelectors() {
  if (!shared || !selectorJsonInput) return;
  clearPendingSelectorUndo();
  const parsed = shared.parseSiteSelectorsJson(selectorJsonInput.value);
  if (!parsed.ok) {
    showPopupToast(`Selectors JSON is invalid: ${parsed.error}`);
    return;
  }
  await updateSelectorSettings({
    ...currentSelectorSettings,
    customSelectors: {
      ...currentSelectorSettings.customSelectors,
      [currentSelectorSite]: parsed.value
    }
  }, `${shared.SITE_LABELS[currentSelectorSite] || currentSelectorSite} selectors saved.`);
}

async function handleResetSiteSelectors() {
  if (!shared) return;
  if (pendingSelectorUndo?.site === currentSelectorSite) {
    const customSelectors = { ...currentSelectorSettings.customSelectors };
    if (pendingSelectorUndo.previousSelectors) {
      customSelectors[currentSelectorSite] = pendingSelectorUndo.previousSelectors;
    } else {
      delete customSelectors[currentSelectorSite];
    }
    clearPendingSelectorUndo();
    await updateSelectorSettings({
      ...currentSelectorSettings,
      customSelectors
    }, `${shared.SITE_LABELS[currentSelectorSite] || currentSelectorSite} selectors restored.`);
    return;
  }

  const previousSelectors = currentSelectorSettings.customSelectors[currentSelectorSite]
    ? shared.normalizeSiteSelectors(currentSelectorSettings.customSelectors[currentSelectorSite])
    : null;
  const customSelectors = { ...currentSelectorSettings.customSelectors };
  delete customSelectors[currentSelectorSite];
  await updateSelectorSettings({
    ...currentSelectorSettings,
    customSelectors
  }, `${shared.SITE_LABELS[currentSelectorSite] || currentSelectorSite} now uses built-in defaults. Undo is available for 5 seconds.`);

  pendingSelectorUndo = {
    site: currentSelectorSite,
    previousSelectors
  };
  renderResetSelectorsButton();
  resetSelectorsUndoTimer = setTimeout(() => {
    clearPendingSelectorUndo();
  }, 5000);
}

async function startManualPick(target) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    showPopupToast("No active tab found for manual pick.");
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "START_MANUAL_PICK", target });
    if (!response?.ok) {
      showPopupToast("Manual pick could not start on this tab. Open a supported AI page first.");
      return;
    }
    showPopupToast("Manual pick started on the active tab.");
  } catch {
    showPopupToast("Manual pick could not reach the page. Open ChatGPT, Claude, Gemini, Grok, AI Studio, or Perplexity first.");
  }
}

function renderStatus(status) {
  if (currentSettings.connectorEnabled === false) {
    statusEl.textContent = "Connector OFF";
    statusEl.classList.remove("error");
    return;
  }

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

  if (currentSettings.connectorEnabled === false) {
    statusBannerEl.classList.remove("off", "disconnected", "connected-unbound", "ready");
    statusBannerEl.classList.add("off");
    if (statusBannerIconEl) statusBannerIconEl.innerHTML = disconnectedIcon;
    if (statusBannerTitleEl) statusBannerTitleEl.textContent = "Connector OFF";
    if (statusBannerHintEl) {
      statusBannerHintEl.textContent = "Turn Connector enabled back on in Settings when you want this extension to reconnect.";
    }
    return;
  }

  const isConnected = status?.connected && !status?.lastError;
  const tabIds = Array.isArray(boundTabIds) ? boundTabIds : [];
  const isBound = tabIds.length > 0;

  statusBannerEl.classList.remove("off", "disconnected", "connected-unbound", "ready");

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
      statusBannerHintEl.textContent = "Bind a tab manually, or let AivoRelay auto-open a fresh target tab when its auto-open setting is enabled.";
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
  if (currentSettings.connectorEnabled === false) {
    return;
  }
  try {
    await chrome.runtime.sendMessage({ type: "POLL_NOW" });
  } catch {
    // Ignore background startup timing.
  }
}

function renderMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  countEl.textContent = String(list.length);
  [clearMessagesFullBtn].forEach((button) => {
    if (button) button.disabled = list.length === 0;
  });

  renderMessagesInto(fullMessagesEl, list, {
    limit: Infinity,
    emptyText: "No messages yet.",
    showPreviewHint: false
  });
}

function renderMessagesInto(container, messages, options = {}) {
  if (!container) return;

  const { limit = Infinity, emptyText = "No messages yet.", showPreviewHint = false } = options;
  container.textContent = "";

  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  const ordered = [...messages].reverse().slice(0, limit);

  for (const message of ordered) {
    const card = buildMessageCard(message);
    fragment.appendChild(card);
  }

  if (showPreviewHint) {
    const more = document.createElement("div");
    more.className = "empty";
    more.textContent = `Showing the latest ${ordered.length} messages here. Open Full History for everything.`;
    fragment.appendChild(more);
  }

  container.appendChild(fragment);
}

function buildMessageCard(message) {
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
  const statusLineEl = document.createElement("div");
  statusLineEl.className = "message-status";
  statusLineEl.textContent = statusLine || "";
  if (!statusLine) {
    statusLineEl.style.display = "none";
  }
  const errorSummary = summarizeAttachmentErrors(message.errors);
  const deliveryDetail = message.deliveryDetail ? String(message.deliveryDetail) : "";
  if (errorSummary || deliveryDetail) {
    statusLineEl.title = [errorSummary, deliveryDetail].filter(Boolean).join(" | ");
  }

  const text = document.createElement("div");
  text.className = "message-text";
  text.textContent = formatMessageText(message);

  const attachmentsEl = buildAttachmentList(message);
  const actionsEl = buildMessageActions(message);

  card.append(time, statusLineEl, text);
  if (attachmentsEl) {
    card.appendChild(attachmentsEl);
  }
  if (actionsEl) {
    card.appendChild(actionsEl);
  }

  return card;
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
  const actions = document.createElement("div");
  actions.className = "message-actions";

  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "retry-btn";
  retryBtn.textContent = "Resend";
  retryBtn.title = "Send this stored message again";
  retryBtn.addEventListener("click", () => {
    void requestRetryMessage(message.id);
  });

  actions.appendChild(retryBtn);
  return actions;
}

async function requestRetryMessage(messageId) {
  if (!messageId) return;
  try {
    await chrome.runtime.sendMessage({ type: "RESEND_MESSAGE", id: messageId });
    showPopupToast("Message queued for resend.");
  } catch (err) {
    console.error("Failed to request resend", err);
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
