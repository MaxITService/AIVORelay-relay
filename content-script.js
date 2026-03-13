'use strict';

const STATUS_PREFIX = "[hc-status]";
let messageInFlight = false;

const UI_DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 38243,
  path: "/messages",
  autoSend: true
};

const FLOATING_UI_ID = "hc-floating-ui";
const MAX_FLOATING_MESSAGES = 8;
const FLOATING_POSITION_KEY = "floatingUiPositions";
const FLOATING_POSITION_MARGIN = 12;
const DRAG_THRESHOLD_PX = 4;
const ATTACHMENT_PREVIEW_LIMIT = 6;

const attachmentPreviewCache = new Map();

let floatingState = {
  settings: { ...UI_DEFAULT_SETTINGS },
  status: null,
  messages: [],
  boundTabIds: [],
  boundTabInfos: {},
  tabAutoSendOverrides: {}
};

let floatingEls = null;
let floatingSaveTimer = null;
let currentTabId = null;
let floatingPositionKey = "";
let floatingPositionsCache = {};
let dragState = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "START_MANUAL_PICK") {
    Promise.resolve(window.AivoRelayManualPicker?.start?.(message.target))
      .then((started) => sendResponse?.({ ok: Boolean(started) }))
      .catch((err) => sendResponse?.({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (message?.type !== "NEW_MESSAGE") return false;
  void handleIncomingMessage(message);
  return false;
});

async function handleIncomingMessage(message) {
  const payload = normalizeIncomingPayload(message);
  const text = payload.text;
  const hasAttachments = payload.attachments.length > 0;
  if ((!text && !hasAttachments) || isStatusText(text)) return;

  const site = window.InjectionTargetsOnWebsite?.activeSite || "Unknown";
  if (payload.status === "error") {
    notifyAttachmentBundleFailed(payload.errors);
    reportStatus("bundle_failed", {
      site,
      detail: summarizeAttachmentErrors(payload.errors),
      messageId: payload.id
    });
    return;
  }

  if (messageInFlight) {
    notifyBusyDrop();
    reportStatus("dropped_busy", {
      site,
      detail: "in_flight",
      messageId: payload.id
    });
    return;
  }

  messageInFlight = true;
  try {
    if (!isSupportedSite(site)) {
      reportStatus("unsupported_site", { site, messageId: payload.id });
      return;
    }

    const autoSend = await getAutoSendSetting();
    const result = await dispatchToSite(site, payload, autoSend);
    handleResult(result, {
      site,
      autoSend,
      messageId: payload.id,
      messagePreview: text
    });
  } finally {
    messageInFlight = false;
  }
}

function normalizeIncomingText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function normalizeIncomingPayload(message) {
  const payload = message?.payload && typeof message.payload === "object" ? message.payload : message;
  const text = normalizeIncomingText(payload?.text ?? payload?.message ?? payload?.body ?? payload?.content ?? "");
  const raw = payload?.raw && typeof payload.raw === "object" ? payload.raw : null;
  const attachments = normalizeIncomingAttachments(payload?.attachments);
  const status = typeof payload?.status === "string" ? payload.status : "ok";
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const id = payload?.id != null ? String(payload.id) : null;
  const ts = Number.isFinite(Number(payload?.ts)) ? Number(payload.ts) : null;
  if (id && attachments.length) {
    hydrateAttachmentBlobUrls(id, attachments);
  }
  return { id, ts, text, raw, attachments, status, errors };
}

function normalizeIncomingAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item, index) => normalizeIncomingAttachment(item, index)).filter(Boolean);
}

function normalizeIncomingAttachment(item, index) {
  if (!item || typeof item !== "object") return null;
  const bytes = extractAttachmentBytes(item.bytes);
  const blobUrl = typeof item.blobUrl === "string" ? item.blobUrl : null;
  const attId = item.attId != null ? String(item.attId) : `att-${index}`;
  const filename = typeof item.filename === "string" ? item.filename : "attachment";
  const mime = typeof item.mime === "string" ? item.mime : "";
  const size = Number.isFinite(Number(item.size)) ? Number(item.size) : null;
  const kind = item.kind === "image" ? "image" : "file";
  const sha256 = typeof item.sha256 === "string" ? item.sha256 : null;

  return {
    attId,
    filename,
    mime,
    size,
    kind,
    bytes,
    blobUrl,
    sha256
  };
}

function extractAttachmentBytes(bytes) {
  if (!bytes) return null;
  if (bytes instanceof ArrayBuffer) return bytes;
  if (ArrayBuffer.isView(bytes)) return bytes.buffer;
  if (Array.isArray(bytes)) return new Uint8Array(bytes).buffer;
  return null;
}

function hydrateAttachmentBlobUrls(messageId, attachments) {
  for (const attachment of attachments) {
    if (!attachment?.bytes || attachment.blobUrl || attachment.kind !== "image") continue;
    const key = `${messageId}:${attachment.attId || attachment.filename}`;
    const cachedUrl = attachmentPreviewCache.get(key);
    if (cachedUrl) {
      attachment.blobUrl = cachedUrl;
      continue;
    }
    const mime = attachment.mime || "application/octet-stream";
    try {
      const blob = new Blob([attachment.bytes], { type: mime });
      const url = URL.createObjectURL(blob);
      attachmentPreviewCache.set(key, url);
      attachment.blobUrl = url;
    } catch {
      // Ignore blob URL creation failures.
    }
  }
}

function isStatusText(text) {
  return text.trim().startsWith(STATUS_PREFIX);
}

function isSupportedSite(site) {
  return site === "ChatGPT" || site === "Perplexity" || site === "Gemini" || site === "Claude" || site === "Grok" || site === "AIStudio";
}

async function getAutoSendSetting() {
  const stored = await chrome.storage.local.get({
    settings: { autoSend: true },
    tabAutoSendOverrides: {}
  });
  const globalDefault = stored.settings?.autoSend !== false;

  // Check for per-tab override
  const tabId = await getCurrentTabId();
  if (Number.isInteger(tabId)) {
    const overrides = stored.tabAutoSendOverrides || {};
    const tabOverride = overrides[tabId];
    if (tabOverride !== undefined && tabOverride !== null) {
      return tabOverride;
    }
  }

  return globalDefault;
}

async function dispatchToSite(site, payload, autoSend) {
  if (site === "ChatGPT" && typeof window.processChatGPTIncomingMessage === "function") {
    return await window.processChatGPTIncomingMessage(payload, { autoSend });
  }
  if (site === "Perplexity" && typeof window.processPerplexityIncomingMessage === "function") {
    return await window.processPerplexityIncomingMessage(payload, { autoSend });
  }
  if (site === "Gemini" && typeof window.processGeminiIncomingMessage === "function") {
    return await window.processGeminiIncomingMessage(payload, { autoSend });
  }
  if (site === "Claude" && typeof window.processClaudeIncomingMessage === "function") {
    return await window.processClaudeIncomingMessage(payload, { autoSend });
  }
  if (site === "Grok" && typeof window.processGrokIncomingMessage === "function") {
    return await window.processGrokIncomingMessage(payload, { autoSend });
  }
  if (site === "AIStudio" && typeof window.processAIStudioIncomingMessage === "function") {
    return await window.processAIStudioIncomingMessage(payload, { autoSend });
  }
  return { status: "unsupported_site" };
}

function handleResult(result, context) {
  const site = context.site || "Unknown";
  const status = result?.status || "unknown";
  const reason = result?.reason ? String(result.reason) : "";
  const messageId = context.messageId || null;
  if (result?.attachments) {
    handleAttachmentResult(result.attachments, { site, messageId });
  }

  if (status === "busy") {
    notifyBusyDrop();
    reportStatus("dropped_busy", { site, detail: reason || "busy", messageId });
    return;
  }

  if (status === "editor_not_found") {
    notifyEditorMissing();
    reportStatus("editor_not_found", { site, messageId });
    return;
  }

  if (status === "send_not_found" || status === "send_disabled" || status === "validation_failed") {
    notifySendMissing();
    reportStatus("send_not_found", { site, detail: reason || status, messageId });
    return;
  }

  if (status === "sent") {
    reportStatus("sent", { site, messageId, messagePreview: context.messagePreview });
    return;
  }

  if (status === "pasted") {
    if (reason === "stop_visible") {
      notifyPastedButBusy();
    }
    reportStatus("pasted", { site, messageId, messagePreview: context.messagePreview, detail: reason || undefined });
    return;
  }

  if (status === "insert_failed") {
    reportStatus("insert_failed", { site, messageId });
    return;
  }

  if (status === "unsupported_site") {
    reportStatus("unsupported_site", { site, messageId });
    return;
  }

  reportStatus("unknown", { site, detail: status, messageId });
}

function handleAttachmentResult(attachmentResult, context) {
  if (!attachmentResult || typeof attachmentResult !== "object") return;
  const site = context.site || "Unknown";
  const messageId = context.messageId || null;
  const status = attachmentResult.status;
  const reason = attachmentResult.reason ? String(attachmentResult.reason) : "";

  if (status === "unsupported") {
    notifyAttachmentUnsupported(site);
    reportStatus("attachment_unsupported", { site, detail: reason || "unsupported", messageId });
    return;
  }

  if (status === "failed") {
    notifyAttachmentUploadFailed(reason);
    reportStatus("attachment_failed", { site, detail: reason || "failed", messageId });
  }
}

function reportStatus(status, payload = {}) {
  try {
    chrome.runtime.sendMessage({
      type: "REPORT_STATUS",
      payload: { status, ...payload }
    });
  } catch {
    // Ignore if service worker is not ready yet.
  }
}

function notifyBusyDrop() {
  if (typeof showToast === "function") {
    showToast("AI is still typing. Message dropped.", "info");
  }
}

function notifyPastedButBusy() {
  if (typeof showToast === "function") {
    showToast("Text inserted. Auto-send skipped (AI still typing).", "info");
  }
}

function notifyEditorMissing() {
  if (typeof showToast === "function") {
    showToast("Editor not found.", "error");
  }
}

function notifySendMissing() {
  if (typeof showToast === "function") {
    showToast("Send button not found.", "error");
  }
}

function notifyAttachmentUnsupported(site) {
  if (typeof showToast === "function") {
    const siteLabel = site && site !== "Unknown" ? ` on ${site}` : "";
    showToast(`Attachments not supported${siteLabel}.`, "info");
  }
}

function notifyAttachmentUploadFailed(reason) {
  if (typeof showToast === "function") {
    const detail = reason ? ` (${reason.replace(/_/g, " ")})` : "";
    showToast(`Attachment upload failed${detail}.`, "error");
  }
}

function notifyAttachmentBundleFailed(errors) {
  if (typeof showToast === "function") {
    const detail = summarizeAttachmentErrors(errors);
    const suffix = detail ? ` (${detail})` : "";
    showToast(`Attachment download failed${suffix}.`, "error");
  }
}

function summarizeAttachmentErrors(errors) {
  if (!Array.isArray(errors) || !errors.length) return "";
  const first = errors[0];
  const message = first?.message || first?.code || "failed";
  return String(message).replace(/_/g, " ");
}

function initFloatingUi() {
  if (window.top !== window) return;
  if (!document.body || document.getElementById(FLOATING_UI_ID)) return;

  injectFloatingStyles();
  floatingEls = buildFloatingUi();
  document.body.appendChild(floatingEls.root);

  floatingEls.toggleBtn.addEventListener("click", () => {
    setFloatingCollapsed(isFloatingExpanded());
  });

  floatingEls.collapseBtn.addEventListener("click", () => {
    setFloatingCollapsed(true);
  });

  floatingEls.bindToggleBtn.addEventListener("click", () => {
    void toggleBinding();
  });

  floatingEls.autoSendToggleBtn.addEventListener("click", () => {
    void toggleTabAutoSend();
  });

  if (floatingEls.singleTabModeInput) {
    floatingEls.singleTabModeInput.addEventListener("change", handleSingleTabModeChange);
  }
  if (floatingEls.clearMessagesBtn) {
    floatingEls.clearMessagesBtn.addEventListener("click", () => {
      void clearStoredMessages();
    });
  }

  floatingPositionKey = buildPositionKey();
  setupFloatingDrag();
  void applyStoredPosition();

  // Listener registration is idempotent (won't duplicate if already added)
  chrome.storage.onChanged.addListener(handleFloatingStorageChange);

  // Render immediately using cached state to avoid flashes of "default" state during resiliency restores
  renderFloatingUi();

  void refreshFloatingState();
}

function injectFloatingStyles() {
  // CSS is now loaded via manifest.json from floating-ui.css
}

function buildFloatingUi() {
  const root = document.createElement("div");
  root.id = FLOATING_UI_ID;
  root.dataset.collapsed = "true";
  root.dataset.bound = "false";
  root.dataset.connected = "false";
  root.dataset.autosend = "default";

  // SVG circular text for "SEND" label (around auto-send button)
  const sendCircularText = `
    <svg class="hc-circular-text" viewBox="0 0 48 48">
      <defs>
        <path id="send-circle" d="M 24,24 m -15,0 a 15,15 0 1,1 30,0 a 15,15 0 1,1 -30,0"/>
      </defs>
      <text>
        <textPath href="#send-circle" startOffset="25%" text-anchor="middle">AUTO</textPath>
      </text>
      <text>
        <textPath href="#send-circle" startOffset="75%" text-anchor="middle">SEND</textPath>
      </text>
    </svg>
  `;

  // SVG circular text for "BIND" label (around bind button)
  const bindCircularText = `
    <svg class="hc-circular-text" viewBox="0 0 48 48">
      <defs>
        <path id="bind-circle" d="M 24,24 m -15,0 a 15,15 0 1,1 30,0 a 15,15 0 1,1 -30,0"/>
      </defs>
      <text>
        <textPath href="#bind-circle" startOffset="25%" text-anchor="middle">BIND</textPath>
      </text>
      <text>
        <textPath href="#bind-circle" startOffset="75%" text-anchor="middle">BIND</textPath>
      </text>
    </svg>
  `;

  root.innerHTML = `
    <div class="hc-min hc-drag-handle">
      <button class="hc-toggle" type="button" aria-expanded="false" title="Open panel">A</button>
      <div class="hc-status-dots">
        <span class="hc-server-dot" title="Server: Checking..."></span>
      </div>
      <div class="hc-circular-btn hc-autosend-circular">
        ${sendCircularText}
        <button class="hc-autosend-toggle" type="button" aria-pressed="true" title="Toggle auto-send for this tab">
          <span class="hc-autosend-dot" title="Auto-send: On (using default)"></span>
        </button>
      </div>
      <div class="hc-circular-btn hc-bind-circular">
        ${bindCircularText}
        <button class="hc-bind-toggle" type="button" aria-pressed="false" title="Toggle bind for this tab">
          <span class="hc-dot" title="Page binding status"></span>
        </button>
      </div>
    </div>
    <div class="hc-panel" role="dialog" aria-label="AivoRelay panel">
      <div class="hc-panel-header hc-drag-handle">
        <div>
          <div class="hc-title-text">AivoRelay</div>
          <div class="hc-bind-text" id="hc-bind-text">No tab bound</div>
        </div>
        <button class="hc-collapse" type="button" title="Collapse">Close</button>
      </div>
      <div class="hc-section">
        <div class="hc-toggle-row">
          <label class="hc-toggle-switch" for="hc-single-tab-mode">
            <input id="hc-single-tab-mode" type="checkbox" />
            <span class="hc-switch"></span>
            <span class="hc-toggle-text">Single tab mode</span>
          </label>
          <span class="hc-toggle-hint">Auto-unbind others</span>
        </div>
      </div>
      <div class="hc-section">
        <div class="hc-messages-header">
          <span>Messages</span>
          <div class="hc-actions">
            <span class="hc-count" id="hc-message-count" title="Recent messages count">0</span>
            <button class="hc-clear-btn" id="hc-clear-messages" type="button">Clear</button>
          </div>
        </div>
        <div class="hc-messages-list" id="hc-messages"></div>
      </div>
    </div>
  `;

  return {
    root,
    minBar: root.querySelector(".hc-min"),
    panelHeader: root.querySelector(".hc-panel-header"),
    toggleBtn: root.querySelector(".hc-toggle"),
    serverDot: root.querySelector(".hc-server-dot"),
    autoSendToggleBtn: root.querySelector(".hc-autosend-toggle"),
    bindToggleBtn: root.querySelector(".hc-bind-toggle"),
    collapseBtn: root.querySelector(".hc-collapse"),
    bindTextEl: root.querySelector("#hc-bind-text"),
    singleTabModeInput: root.querySelector("#hc-single-tab-mode"),
    messageCountEl: root.querySelector("#hc-message-count"),
    clearMessagesBtn: root.querySelector("#hc-clear-messages"),
    messagesEl: root.querySelector("#hc-messages")
  };
}

function isFloatingExpanded() {
  return floatingEls?.root?.dataset.collapsed === "false";
}

function setFloatingCollapsed(collapsed) {
  if (!floatingEls) return;
  const next = collapsed ? "true" : "false";
  floatingEls.root.dataset.collapsed = next;
  floatingEls.toggleBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

function buildPositionKey() {
  try {
    const url = new URL(window.location.href);
    return `${url.origin}${url.pathname}`;
  } catch {
    return window.location.href;
  }
}

function setupFloatingDrag() {
  if (!floatingEls) return;
  const handles = [floatingEls.minBar, floatingEls.panelHeader];
  for (const handle of handles) {
    if (!handle) continue;
    handle.addEventListener("pointerdown", handleDragStart);
  }
}

async function applyStoredPosition() {
  if (!floatingEls || !floatingPositionKey) return;
  const stored = await chrome.storage.local.get({ [FLOATING_POSITION_KEY]: {} });
  const map = normalizePositionsMap(stored[FLOATING_POSITION_KEY]);
  floatingPositionsCache = map;
  const saved = map[floatingPositionKey] || null;
  requestAnimationFrame(() => {
    const rect = floatingEls.root.getBoundingClientRect();
    const resolved = resolveFloatingPosition(saved, rect);
    setFloatingPosition(resolved);
  });
}

function normalizePositionsMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function resolveFloatingPosition(saved, rect) {
  const maxX = Math.max(0, window.innerWidth - rect.width - FLOATING_POSITION_MARGIN);
  const maxY = Math.max(0, window.innerHeight - rect.height - FLOATING_POSITION_MARGIN);
  const minX = Math.min(FLOATING_POSITION_MARGIN, maxX);
  const minY = Math.min(FLOATING_POSITION_MARGIN, maxY);

  let x = Number.isFinite(saved?.x) ? saved.x : maxX;
  let y = Number.isFinite(saved?.y) ? saved.y : maxY;

  x = clampValue(x, minX, maxX);
  y = clampValue(y, minY, maxY);

  return { x, y };
}

function clampValue(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function setFloatingPosition(position) {
  if (!floatingEls || !position) return;
  floatingEls.root.style.left = `${position.x}px`;
  floatingEls.root.style.top = `${position.y}px`;
  floatingEls.root.style.right = "auto";
  floatingEls.root.style.bottom = "auto";
}

function handleDragStart(event) {
  if (!floatingEls || event.button !== 0) return;
  if (event.target.closest("button, input, label, select, textarea, a")) return;

  const rect = floatingEls.root.getBoundingClientRect();
  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: rect.left,
    originY: rect.top,
    width: rect.width,
    height: rect.height,
    currentX: rect.left,
    currentY: rect.top,
    moved: false
  };

  floatingEls.root.setPointerCapture(event.pointerId);
  window.addEventListener("pointermove", handleDragMove);
  window.addEventListener("pointerup", handleDragEnd);
  window.addEventListener("pointercancel", handleDragEnd);
  event.preventDefault();
}

function handleDragMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const deltaX = event.clientX - dragState.startX;
  const deltaY = event.clientY - dragState.startY;
  if (!dragState.moved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX) return;

  dragState.moved = true;
  const nextX = dragState.originX + deltaX;
  const nextY = dragState.originY + deltaY;
  const maxX = Math.max(0, window.innerWidth - dragState.width - FLOATING_POSITION_MARGIN);
  const maxY = Math.max(0, window.innerHeight - dragState.height - FLOATING_POSITION_MARGIN);
  const minX = Math.min(FLOATING_POSITION_MARGIN, maxX);
  const minY = Math.min(FLOATING_POSITION_MARGIN, maxY);

  const clampedX = clampValue(nextX, minX, maxX);
  const clampedY = clampValue(nextY, minY, maxY);

  dragState.currentX = clampedX;
  dragState.currentY = clampedY;
  setFloatingPosition({ x: clampedX, y: clampedY });
}

function handleDragEnd(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  if (dragState.moved) {
    persistFloatingPosition({ x: dragState.currentX, y: dragState.currentY });
  }

  try {
    floatingEls?.root?.releasePointerCapture(event.pointerId);
  } catch {
    // Ignore release errors.
  }

  window.removeEventListener("pointermove", handleDragMove);
  window.removeEventListener("pointerup", handleDragEnd);
  window.removeEventListener("pointercancel", handleDragEnd);
  dragState = null;
}

function persistFloatingPosition(position) {
  if (!floatingPositionKey) return;
  floatingPositionsCache = normalizePositionsMap(floatingPositionsCache);
  floatingPositionsCache[floatingPositionKey] = position;
  chrome.storage.local.set({ [FLOATING_POSITION_KEY]: floatingPositionsCache });
}

async function refreshFloatingState() {
  const stored = await chrome.storage.local.get({
    settings: UI_DEFAULT_SETTINGS,
    status: null,
    messages: [],
    boundTabIds: [],
    boundTabInfos: {},
    tabAutoSendOverrides: {}
  });

  floatingState = {
    settings: { ...UI_DEFAULT_SETTINGS, ...stored.settings },
    status: stored.status || null,
    messages: Array.isArray(stored.messages) ? stored.messages : [],
    boundTabIds: Array.isArray(stored.boundTabIds) ? stored.boundTabIds : [],
    boundTabInfos: (stored.boundTabInfos && typeof stored.boundTabInfos === "object") ? stored.boundTabInfos : {},
    tabAutoSendOverrides: (stored.tabAutoSendOverrides && typeof stored.tabAutoSendOverrides === "object") ? stored.tabAutoSendOverrides : {}
  };

  currentTabId = await getCurrentTabId();
  renderFloatingUi();
}

function handleFloatingStorageChange(changes, area) {
  if (area !== "local") return;

  if (changes.settings) {
    floatingState.settings = {
      ...UI_DEFAULT_SETTINGS,
      ...(changes.settings.newValue || {})
    };
  }

  if (changes.status) {
    floatingState.status = changes.status.newValue || null;
  }

  if (changes.messages) {
    floatingState.messages = Array.isArray(changes.messages.newValue)
      ? changes.messages.newValue
      : [];
  }

  if (changes.boundTabIds) {
    floatingState.boundTabIds = Array.isArray(changes.boundTabIds.newValue)
      ? changes.boundTabIds.newValue
      : [];
  }

  if (changes.boundTabInfos) {
    floatingState.boundTabInfos = (changes.boundTabInfos.newValue && typeof changes.boundTabInfos.newValue === "object")
      ? changes.boundTabInfos.newValue
      : {};
  }

  if (changes.tabAutoSendOverrides) {
    floatingState.tabAutoSendOverrides = (changes.tabAutoSendOverrides.newValue && typeof changes.tabAutoSendOverrides.newValue === "object")
      ? changes.tabAutoSendOverrides.newValue
      : {};
  }

  renderFloatingUi();
}

function renderFloatingUi() {
  if (!floatingEls) return;
  renderFloatingSettings();
  renderFloatingStatus();
  renderFloatingMessages();
  renderFloatingBinding();
  renderFloatingTabAutoSend();
}

function renderFloatingSettings() {
  const settings = floatingState.settings || UI_DEFAULT_SETTINGS;
  if (floatingEls.singleTabModeInput) {
    floatingEls.singleTabModeInput.checked = settings.singleTabBindingMode !== false;
  }
}

function renderFloatingStatus() {
  const status = floatingState.status;
  const serverDot = floatingEls.serverDot;

  if (!status) {
    floatingEls.root.dataset.connected = "false";
    if (serverDot) serverDot.title = "Server: Checking connection...";
    return;
  }

  if (status.lastError) {
    floatingEls.root.dataset.connected = "false";
    const lastSuccess = status.lastSuccessAt
      ? ` (Last OK: ${formatTime(status.lastSuccessAt)})`
      : "";
    if (serverDot) serverDot.title = `Server: Disconnected - ${status.lastError}${lastSuccess}`;
    return;
  }

  if (status.connected) {
    floatingEls.root.dataset.connected = "true";
    const lastCheck = status.lastPollAt ? formatTime(status.lastPollAt) : "Just now";
    if (serverDot) serverDot.title = `Server: Connected (Last check: ${lastCheck})`;
    return;
  }

  floatingEls.root.dataset.connected = "false";
  if (serverDot) serverDot.title = "Server: Waiting for connection...";
}

function renderFloatingMessages() {
  const list = Array.isArray(floatingState.messages) ? floatingState.messages : [];
  floatingEls.messageCountEl.textContent = String(list.length);
  floatingEls.messagesEl.textContent = "";
  if (floatingEls.clearMessagesBtn) {
    floatingEls.clearMessagesBtn.disabled = list.length === 0;
  }

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "hc-empty";
    empty.textContent = "No messages yet.";
    floatingEls.messagesEl.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  const ordered = [...list].slice(-MAX_FLOATING_MESSAGES).reverse();

  for (const message of ordered) {
    const card = document.createElement("div");
    card.className = "hc-message";

    const time = document.createElement("div");
    time.className = "hc-message-time";
    time.textContent = Number.isFinite(message.ts) ? formatTime(message.ts) : "Just now";

    const statusLine = buildMessageStatusLine(message);
    const statusEl = document.createElement("div");
    statusEl.className = "hc-message-status";
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
    text.className = "hc-message-text";
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

  floatingEls.messagesEl.appendChild(fragment);
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
  wrapper.className = "hc-attachments";

  const items = attachments.slice(0, ATTACHMENT_PREVIEW_LIMIT);
  for (const attachment of items) {
    const chip = document.createElement("div");
    chip.className = "hc-attachment";

    if (attachment.kind === "image") {
      const img = document.createElement("img");
      img.className = "hc-attachment-thumb";
      img.alt = attachment.filename || "image";
      chip.appendChild(img);
      requestAttachmentPreview(message.id, attachment, img);
    } else {
      const icon = document.createElement("span");
      icon.className = "hc-attachment-icon";
      icon.textContent = "FILE";
      const label = document.createElement("span");
      label.className = "hc-attachment-label";
      label.textContent = formatAttachmentLabel(attachment);
      chip.append(icon, label);
    }

    wrapper.appendChild(chip);
  }

  if (attachments.length > items.length) {
    const more = document.createElement("div");
    more.className = "hc-attachment-more";
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

function buildMessageActions(message) {
  const actions = document.createElement("div");
  actions.className = "hc-message-actions";

  const resendBtn = document.createElement("button");
  resendBtn.type = "button";
  resendBtn.className = "hc-retry-btn";
  resendBtn.textContent = "Resend";
  resendBtn.title = "Send this stored message again";
  resendBtn.addEventListener("click", () => {
    void requestResendMessage(message.id);
  });

  actions.appendChild(resendBtn);
  return actions;
}

async function requestResendMessage(messageId) {
  if (!messageId) return;
  try {
    await chrome.runtime.sendMessage({ type: "RESEND_MESSAGE", id: messageId });
  } catch (err) {
    console.warn("Failed to request resend", err);
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

function renderFloatingBinding() {
  const boundTabIds = floatingState.boundTabIds || [];
  const boundTabInfos = floatingState.boundTabInfos || {};
  const isBoundToCurrent = Number.isInteger(currentTabId) && boundTabIds.includes(currentTabId);

  floatingEls.root.dataset.bound = isBoundToCurrent ? "true" : "false";
  floatingEls.bindToggleBtn.setAttribute("aria-pressed", isBoundToCurrent ? "true" : "false");

  // Update binding dot tooltip
  const bindDot = floatingEls.bindToggleBtn.querySelector(".hc-dot");
  if (bindDot) {
    if (isBoundToCurrent) {
      bindDot.title = `Page bound${boundTabIds.length > 1 ? ` (${boundTabIds.length} total)` : ""}`;
    } else if (boundTabIds.length > 0) {
      bindDot.title = `${boundTabIds.length} other tab(s) bound - Click to bind this page`;
    } else {
      bindDot.title = "Click to bind this page";
    }
  }

  let label = "No tab bound";
  if (boundTabIds.length > 0) {
    if (isBoundToCurrent) {
      label = `Bound: This Tab${boundTabIds.length > 1 ? ` (+${boundTabIds.length - 1} more)` : ""}`;
    } else {
      label = `Bound to ${boundTabIds.length} tab${boundTabIds.length > 1 ? "s" : ""}`;
    }
  }

  floatingEls.bindTextEl.textContent = label;
  floatingEls.bindToggleBtn.title = isBoundToCurrent ? "Unbind this tab" : "Bind this tab";
}

function renderFloatingTabAutoSend() {
  const overrides = floatingState.tabAutoSendOverrides || {};
  const globalDefault = floatingState.settings?.autoSend !== false;
  const tabOverride = Number.isInteger(currentTabId) ? overrides[currentTabId] : undefined;
  const hasOverride = tabOverride !== undefined && tabOverride !== null;
  const effectiveValue = hasOverride ? tabOverride : globalDefault;

  // Set data attribute for CSS styling: "on", "off", or "default"
  let stateAttr;
  if (!hasOverride) {
    stateAttr = "default";
  } else {
    stateAttr = effectiveValue ? "on" : "off";
  }
  floatingEls.root.dataset.autosend = stateAttr;

  // Update button aria state
  floatingEls.autoSendToggleBtn.setAttribute("aria-pressed", effectiveValue ? "true" : "false");

  // Update dot tooltip
  const autoSendDot = floatingEls.autoSendToggleBtn.querySelector(".hc-autosend-dot");
  if (autoSendDot) {
    const statusText = effectiveValue ? "On" : "Off";
    const sourceText = hasOverride ? "tab override" : "using default";
    autoSendDot.title = `Auto-send: ${statusText} (${sourceText})`;
  }

  // Update button tooltip
  const nextStateHint = hasOverride
    ? "Click to reset to default"
    : `Click to ${globalDefault ? "disable" : "enable"} for this tab`;
  floatingEls.autoSendToggleBtn.title = `Auto-send: ${effectiveValue ? "On" : "Off"} - ${nextStateHint}`;
}

function handleSingleTabModeChange() {
  scheduleSettingsSave({ ...floatingState.settings, singleTabBindingMode: floatingEls.singleTabModeInput.checked });
}

function scheduleSettingsSave(nextSettings) {
  floatingState.settings = nextSettings;
  renderFloatingSettings();

  if (floatingSaveTimer) clearTimeout(floatingSaveTimer);
  floatingSaveTimer = setTimeout(async () => {
    await chrome.storage.local.set({ settings: floatingState.settings });
    try {
      await chrome.runtime.sendMessage({ type: "POLL_NOW" });
    } catch {
      // Ignore background startup timing.
    }
  }, 300);
}

async function clearStoredMessages() {
  floatingState.messages = [];
  renderFloatingMessages();
  clearAttachmentPreviewCache();
  try {
    await chrome.storage.local.set({ messages: [] });
  } catch (err) {
    console.warn("Failed to clear messages", err);
  }
}

async function toggleBinding() {
  try {
    await chrome.runtime.sendMessage({ type: "TOGGLE_BIND" });
  } catch (err) {
    console.warn("Failed to toggle bind", err);
  }
}

async function toggleTabAutoSend() {
  if (!Number.isInteger(currentTabId)) return;

  const overrides = floatingState.tabAutoSendOverrides || {};
  const currentOverride = overrides[currentTabId];
  const globalDefault = floatingState.settings?.autoSend !== false;

  // Cycle through states: default -> explicit on -> explicit off -> default
  // If no override (using default), set to opposite of default
  // If override exists, toggle it or clear to return to default
  let nextValue;
  if (currentOverride === undefined || currentOverride === null) {
    // Currently using default, set explicit opposite
    nextValue = !globalDefault;
  } else if (currentOverride === !globalDefault) {
    // Currently opposite of default, return to default (clear override)
    nextValue = null;
  } else {
    // Currently same as default but explicit, set to opposite
    nextValue = !currentOverride;
  }

  const newOverrides = { ...overrides };
  if (nextValue === null) {
    delete newOverrides[currentTabId];
  } else {
    newOverrides[currentTabId] = nextValue;
  }

  floatingState.tabAutoSendOverrides = newOverrides;
  renderFloatingTabAutoSend();

  try {
    await chrome.storage.local.set({ tabAutoSendOverrides: newOverrides });
  } catch (err) {
    console.warn("Failed to save tab auto-send override", err);
  }
}

async function getCurrentTabId() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_TAB_CONTEXT" });
    return Number.isInteger(response?.tabId) ? response.tabId : null;
  } catch {
    return null;
  }
}

function formatTabLabel(tab) {
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

/* =============================================================================
   Enhanced Resiliency & SPA Handling
   Ported/Adapted from One Click Prompts for robust persistence.
   ============================================================================= */

function startResiliencyMechanism() {
  if (window.top !== window) return;

  // 1. Initial Injection
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initFloatingUi();
      runAdaptiveResiliencyChecks();
    }, { once: true });
  } else {
    initFloatingUi();
    runAdaptiveResiliencyChecks();
  }

  // 2. Patch History API for SPA navigation detection
  patchHistoryMethods();

  // 3. Observer URL changes
  setupSpaUrlObserver();
}

function patchHistoryMethods() {
  const methods = ['pushState', 'replaceState'];
  methods.forEach(method => {
    try {
      const original = history[method];
      history[method] = function (...args) {
        const result = original.apply(this, args);
        // Slight delay to allow framework to enact changes
        setTimeout(checkAndRestoreFloatingUi, 100);
        return result;
      };
    } catch (e) {
      console.warn("[AivoRelay] History patch failed:", e);
    }
  });
}

function setupSpaUrlObserver() {
  let previousUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== previousUrl) {
      previousUrl = location.href;
      setTimeout(checkAndRestoreFloatingUi, 100);
    }
  });
  observer.observe(document, { subtree: true, childList: true });
}

function runAdaptiveResiliencyChecks() {
  // A. Long-lived DOM Observer
  // Disconnect old if exists (though in this scope it's fresh)
  const observer = new MutationObserver((mutations) => {
    let shouldCheck = false;
    for (const m of mutations) {
      if (m.removedNodes.length > 0) {
        shouldCheck = true;
        break;
      }
    }
    if (shouldCheck || !document.getElementById(FLOATING_UI_ID)) {
      checkAndRestoreFloatingUi();
    }
  });

  const startObserving = () => {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  };

  if (document.body) {
    startObserving();
  } else {
    document.addEventListener('DOMContentLoaded', startObserving, { once: true });
  }

  // B. Adaptive Polling (The "OCP" heartbeat)
  let checkCount = 0;
  const check = () => {
    checkAndRestoreFloatingUi();
    checkCount++;
    // Aggressive checks for first 15 seconds (30 * 500ms = 15s), then slower (5s)
    const delay = checkCount < 30 ? 500 : 5000;
    setTimeout(check, delay);
  };
  check();
}

function checkAndRestoreFloatingUi() {
  if (window.top !== window) return;

  const uiExists = !!document.getElementById(FLOATING_UI_ID);

  // If UI is missing, re-init
  if (!uiExists) {
    floatingEls = null; // Ensure fresh rebuild
    initFloatingUi();
  }
  // Safety check: if UI exists but we lost our internal references (floatingEls is null),
  // we must attach to it or rebuild it to respond to messages.
  else if (uiExists && !floatingEls) {
    // Nuke and rebuild to be safe and ensure all listeners are bound
    const el = document.getElementById(FLOATING_UI_ID);
    if (el) el.remove();
    initFloatingUi();
  }
}

// Start the engine
startResiliencyMechanism();
