'use strict';

const STATUS_PREFIX = "[hc-status]";
let messageInFlight = false;

const UI_DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 63155,
  path: "/messages",
  autoSend: true
};

const FLOATING_UI_ID = "hc-floating-ui";
const FLOATING_STYLE_ID = "hc-floating-ui-style";
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
  boundTabInfos: {}
};

let floatingEls = null;
let floatingSaveTimer = null;
let currentTabId = null;
let floatingPositionKey = "";
let floatingPositionsCache = {};
let dragState = null;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "NEW_MESSAGE") return;
  void handleIncomingMessage(message);
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

    if (window.ButtonsClickingShared?.findStopButton?.()) {
      notifyBusyDrop();
      reportStatus("dropped_busy", { site, detail: "stop_visible", messageId: payload.id });
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
  const { settings } = await chrome.storage.local.get({
    settings: { autoSend: true }
  });
  return settings?.autoSend !== false;
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
    reportStatus("pasted", { site, messageId, messagePreview: context.messagePreview });
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

  floatingEls.portInput.addEventListener("input", handlePortInputChange);
  floatingEls.autoSendInput.addEventListener("change", handleAutoSendChange);
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

  chrome.storage.onChanged.addListener(handleFloatingStorageChange);

  void refreshFloatingState();
}

function injectFloatingStyles() {
  if (document.getElementById(FLOATING_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = FLOATING_STYLE_ID;
  style.textContent = `
#${FLOATING_UI_ID} {
  --hc-bg: rgba(248, 243, 235, 0.88);
  --hc-border: rgba(214, 201, 182, 0.7);
  --hc-text: #211d17;
  --hc-muted: #6a5f51;
  --hc-accent: #187c6b;
  --hc-accent-soft: rgba(24, 124, 107, 0.18);
  --hc-shadow: 0 14px 30px rgba(33, 29, 23, 0.18);
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 2147483647;
  font-family: "Trebuchet MS", "Gill Sans", "Calibri", sans-serif;
  color: var(--hc-text);
  pointer-events: auto;
  display: inline-flex;
  align-items: flex-end;
}

#${FLOATING_UI_ID} * {
  box-sizing: border-box;
}

#${FLOATING_UI_ID} button {
  all: unset;
  cursor: pointer;
  font-family: inherit;
}

#${FLOATING_UI_ID} input {
  font-family: inherit;
}

#${FLOATING_UI_ID} .hc-min {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border-radius: 999px;
  background: var(--hc-bg);
  border: 1px solid var(--hc-border);
  box-shadow: var(--hc-shadow);
  backdrop-filter: blur(14px) saturate(160%);
  -webkit-backdrop-filter: blur(14px) saturate(160%);
}

#${FLOATING_UI_ID} .hc-drag-handle {
  cursor: grab;
  touch-action: none;
}

#${FLOATING_UI_ID} .hc-drag-handle:active {
  cursor: grabbing;
}

#${FLOATING_UI_ID} .hc-toggle {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.75);
  border: 1px solid rgba(255, 255, 255, 0.7);
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.3px;
  color: var(--hc-text);
}

#${FLOATING_UI_ID} .hc-bind-toggle {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.7);
}

#${FLOATING_UI_ID} .hc-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #9aa0a6;
  transition: background 200ms ease, box-shadow 200ms ease;
}

#${FLOATING_UI_ID}[data-bound="true"] .hc-dot {
  background: #2ecc71;
  box-shadow: 0 0 10px rgba(46, 204, 113, 0.7);
}

#${FLOATING_UI_ID} .hc-panel {
  width: 340px;
  max-height: 70vh;
  overflow: hidden;
  background: var(--hc-bg);
  border: 1px solid var(--hc-border);
  border-radius: 16px;
  box-shadow: var(--hc-shadow);
  backdrop-filter: blur(16px) saturate(160%);
  -webkit-backdrop-filter: blur(16px) saturate(160%);
  padding: 12px;
  position: absolute;
  right: 0;
  bottom: calc(100% + 10px);
  opacity: 1;
  transform: translateY(0);
  transition: opacity 160ms ease, transform 160ms ease, max-height 160ms ease;
}

#${FLOATING_UI_ID}[data-collapsed="true"] .hc-panel {
  opacity: 0;
  transform: translateY(8px);
  pointer-events: none;
  max-height: 0;
  padding: 0;
  border-color: transparent;
}

#${FLOATING_UI_ID} .hc-panel-header {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: flex-start;
}

#${FLOATING_UI_ID} .hc-title-text {
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.2px;
}

#${FLOATING_UI_ID} .hc-bind-text {
  margin-top: 4px;
  font-size: 11px;
  color: var(--hc-muted);
}

#${FLOATING_UI_ID} .hc-collapse {
  padding: 4px 8px;
  border-radius: 8px;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.8);
  color: var(--hc-text);
}

#${FLOATING_UI_ID} .hc-section {
  margin-top: 10px;
}

#${FLOATING_UI_ID} .hc-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
  color: var(--hc-muted);
  margin-top: 6px;
}

#${FLOATING_UI_ID} .hc-value {
  color: var(--hc-text);
  font-weight: 600;
  text-align: right;
  max-width: 65%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#${FLOATING_UI_ID} .hc-status.is-error {
  color: #b42318;
}

#${FLOATING_UI_ID} .hc-input-label {
  font-size: 11px;
  color: var(--hc-muted);
}

#${FLOATING_UI_ID} .hc-input {
  width: 100%;
  margin-top: 4px;
  padding: 7px 9px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.8);
  background: rgba(255, 255, 255, 0.9);
  font-size: 12px;
  color: var(--hc-text);
}

#${FLOATING_UI_ID} .hc-input.invalid {
  border-color: #b42318;
  box-shadow: 0 0 0 2px rgba(180, 35, 24, 0.2);
}

#${FLOATING_UI_ID} .hc-checkbox {
  margin-top: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--hc-muted);
}

#${FLOATING_UI_ID} .hc-checkbox input {
  width: 14px;
  height: 14px;
  accent-color: var(--hc-accent);
}

#${FLOATING_UI_ID} .hc-messages-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  color: var(--hc-muted);
}

#${FLOATING_UI_ID} .hc-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

#${FLOATING_UI_ID} .hc-count {
  min-width: 24px;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--hc-accent-soft);
  color: var(--hc-accent);
  font-weight: 700;
  font-size: 11px;
  text-align: center;
}

#${FLOATING_UI_ID} .hc-clear-btn {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  color: #b42318;
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(180, 35, 24, 0.35);
}

#${FLOATING_UI_ID} .hc-clear-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

#${FLOATING_UI_ID} .hc-messages-list {
  margin-top: 8px;
  max-height: 220px;
  overflow: auto;
  display: grid;
  gap: 6px;
  padding-right: 2px;
}

#${FLOATING_UI_ID} .hc-message {
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.7);
  background: rgba(255, 255, 255, 0.8);
  padding: 6px 8px;
}

#${FLOATING_UI_ID} .hc-message-time {
  font-size: 10px;
  color: var(--hc-muted);
  margin-bottom: 4px;
}

#${FLOATING_UI_ID} .hc-message-text {
  font-size: 11px;
  color: var(--hc-text);
  white-space: pre-wrap;
  word-break: break-word;
}

#${FLOATING_UI_ID} .hc-message-status {
  font-size: 10px;
  color: var(--hc-muted);
  margin-bottom: 4px;
}

#${FLOATING_UI_ID} .hc-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

#${FLOATING_UI_ID} .hc-attachment {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.7);
}

#${FLOATING_UI_ID} .hc-attachment-thumb {
  width: 36px;
  height: 36px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.7);
}

#${FLOATING_UI_ID} .hc-attachment-icon {
  font-size: 9px;
  font-weight: 700;
  color: var(--hc-accent);
  background: var(--hc-accent-soft);
  border-radius: 999px;
  padding: 2px 6px;
}

#${FLOATING_UI_ID} .hc-attachment-label {
  font-size: 10px;
  color: var(--hc-muted);
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#${FLOATING_UI_ID} .hc-attachment-more {
  font-size: 10px;
  color: var(--hc-muted);
  align-self: center;
}

#${FLOATING_UI_ID} .hc-message-actions {
  margin-top: 6px;
  display: flex;
  justify-content: flex-end;
}

#${FLOATING_UI_ID} .hc-retry-btn {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  color: #b42318;
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(180, 35, 24, 0.35);
}

#${FLOATING_UI_ID} .hc-retry-btn:hover {
  opacity: 0.9;
}

#${FLOATING_UI_ID} .hc-empty {
  font-size: 11px;
  color: var(--hc-muted);
  text-align: center;
  padding: 8px 0;
}
`;
  const target = document.head || document.documentElement;
  target.appendChild(style);
}

function buildFloatingUi() {
  const root = document.createElement("div");
  root.id = FLOATING_UI_ID;
  root.dataset.collapsed = "true";
  root.dataset.bound = "false";

  root.innerHTML = `
    <div class="hc-min hc-drag-handle">
      <button class="hc-toggle" type="button" aria-expanded="false" title="Open panel">HC</button>
      <button class="hc-bind-toggle" type="button" aria-pressed="false" title="Toggle bind for this tab">
        <span class="hc-dot"></span>
      </button>
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
        <div class="hc-row">
          <span class="hc-label">Server</span>
          <span class="hc-value" id="hc-server-url"></span>
        </div>
        <div class="hc-row">
          <span class="hc-label">Status</span>
          <span class="hc-value hc-status" id="hc-status"></span>
        </div>
      </div>
      <div class="hc-section">
        <label class="hc-input-label" for="hc-port">Port</label>
        <input id="hc-port" class="hc-input" type="number" min="1" max="65535" step="1" inputmode="numeric" />
        <label class="hc-checkbox">
          <input id="hc-auto-send" type="checkbox" />
          Auto-send
        </label>
        <label class="hc-checkbox">
          <input id="hc-single-tab-mode" type="checkbox" />
          Single tab mode
        </label>
      </div>
      <div class="hc-section">
        <div class="hc-messages-header">
          <span>Messages</span>
          <div class="hc-actions">
            <span class="hc-count" id="hc-message-count">0</span>
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
    bindToggleBtn: root.querySelector(".hc-bind-toggle"),
    collapseBtn: root.querySelector(".hc-collapse"),
    bindTextEl: root.querySelector("#hc-bind-text"),
    serverUrlEl: root.querySelector("#hc-server-url"),
    statusEl: root.querySelector("#hc-status"),
    portInput: root.querySelector("#hc-port"),
    autoSendInput: root.querySelector("#hc-auto-send"),
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
    boundTabInfos: {}
  });

  floatingState = {
    settings: { ...UI_DEFAULT_SETTINGS, ...stored.settings },
    status: stored.status || null,
    messages: Array.isArray(stored.messages) ? stored.messages : [],
    boundTabIds: Array.isArray(stored.boundTabIds) ? stored.boundTabIds : [],
    boundTabInfos: (stored.boundTabInfos && typeof stored.boundTabInfos === "object") ? stored.boundTabInfos : {}
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

  renderFloatingUi();
}

function renderFloatingUi() {
  if (!floatingEls) return;
  renderFloatingSettings();
  renderFloatingStatus();
  renderFloatingMessages();
  renderFloatingBinding();
}

function renderFloatingSettings() {
  const settings = floatingState.settings || UI_DEFAULT_SETTINGS;
  if (document.activeElement !== floatingEls.portInput) {
    floatingEls.portInput.value = settings.port ?? UI_DEFAULT_SETTINGS.port;
  }
  floatingEls.autoSendInput.checked = settings.autoSend !== false;
  if (floatingEls.singleTabModeInput) {
    floatingEls.singleTabModeInput.checked = settings.singleTabBindingMode !== false;
  }
  floatingEls.serverUrlEl.textContent = `http://${settings.host}:${settings.port}`;
}

function renderFloatingStatus() {
  const status = floatingState.status;
  if (!status) {
    floatingEls.statusEl.textContent = "Waiting for first check...";
    floatingEls.statusEl.classList.remove("is-error");
    return;
  }

  if (status.lastError) {
    const lastSuccess = status.lastSuccessAt
      ? ` Last success: ${formatTime(status.lastSuccessAt)}.`
      : "";
    floatingEls.statusEl.textContent = `Connection failed: ${status.lastError}.${lastSuccess}`;
    floatingEls.statusEl.classList.add("is-error");
    return;
  }

  if (status.connected) {
    const lastCheck = status.lastPollAt ? formatTime(status.lastPollAt) : "Just now";
    floatingEls.statusEl.textContent = `Connected - Last check: ${lastCheck}`;
    floatingEls.statusEl.classList.remove("is-error");
    return;
  }

  if (status.lastPollAt) {
    floatingEls.statusEl.textContent = `Last check: ${formatTime(status.lastPollAt)}`;
    floatingEls.statusEl.classList.remove("is-error");
    return;
  }

  floatingEls.statusEl.textContent = "Waiting for first check...";
  floatingEls.statusEl.classList.remove("is-error");
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
  if (!shouldShowRetry(message)) return null;
  const actions = document.createElement("div");
  actions.className = "hc-message-actions";

  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "hc-retry-btn";
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
    console.warn("Failed to request retry", err);
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

function handlePortInputChange() {
  const value = Number(floatingEls.portInput.value);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    floatingEls.portInput.classList.add("invalid");
    return;
  }

  floatingEls.portInput.classList.remove("invalid");
  scheduleSettingsSave({ ...floatingState.settings, port: value });
}

function handleAutoSendChange() {
  scheduleSettingsSave({ ...floatingState.settings, autoSend: floatingEls.autoSendInput.checked });
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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initFloatingUi, { once: true });
} else {
  initFloatingUi();
}
