'use strict';

async function handleReportStatus(payload = {}) {
  if (payload?.messageId) {
    await updateMessageDelivery(payload.messageId, payload.status, payload.detail || "");
  }
  await sendStatus(payload);
}

async function sendAck(settings) {
  try {
    const url = buildRequestUrl(settings, null);
    const timeoutMs = Number(settings.timeoutMs) || DEFAULT_SETTINGS.timeoutMs;
    await postJsonWithTimeout(url, { type: "keepalive_ack", ts: Date.now() }, timeoutMs);
  } catch (err) {
    console.warn("[aivo-relay] Failed to send ack", err);
  }
}

async function sendStatus(payload = {}) {
  const settings = await getSettings();
  const timeoutMs = Number(settings.timeoutMs) || DEFAULT_SETTINGS.timeoutMs;
  const url = buildRequestUrl(settings, null);
  const statusPayload = buildStatusPayload(payload);
  const response = await postJsonWithTimeout(url, statusPayload, timeoutMs);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.bodyText || "No response body"}`);
  }
}

function buildStatusPayload(payload) {
  const status = payload?.status ? String(payload.status) : "unknown";
  const site = payload?.site ? String(payload.site) : "Unknown";
  const detail = payload?.detail ? String(payload.detail) : "";
  const preview = payload?.messagePreview ? String(payload.messagePreview).trim() : "";
  const detailSuffix = detail ? ` - ${detail}` : "";
  const previewSuffix = preview ? ` | ${preview}` : "";

  return {
    type: "status",
    status,
    site,
    detail: detail || null,
    messagePreview: preview || null,
    messageId: payload?.messageId ?? null,
    ts: Date.now(),
    text: `${STATUS_PREFIX} ${status} ${site}${detailSuffix}${previewSuffix}`
  };
}
