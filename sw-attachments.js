'use strict';

const attachmentCache = new Map();

function shouldAttemptBundle(entry) {
  if (!entry) return false;
  const lastAttemptAt = Number(entry.lastAttemptAt) || 0;
  if (!lastAttemptAt) return true;
  return Date.now() - lastAttemptAt >= ATTACHMENT_RETRY_DELAY_MS;
}

function ensurePendingBundle(message, existing) {
  if (existing) {
    return {
      ...existing,
      text: message.text,
      ts: message.ts,
      attachments: message.attachments,
      type: message.type
    };
  }

  return {
    id: message.id,
    ts: message.ts,
    text: message.text,
    type: message.type,
    attachments: message.attachments,
    attempts: {},
    errors: [],
    createdAt: Date.now(),
    lastAttemptAt: 0
  };
}

async function resolveBundle(entry, settings) {
  const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
  if (!attachments.length) {
    return {
      status: "error",
      errors: [{ attId: null, message: "No attachments provided", code: "NO_ATTACHMENTS" }],
      attempts: entry.attempts || {}
    };
  }

  const attempts = { ...(entry.attempts || {}) };
  const errors = [];
  const results = [];

  await runWithConcurrency(attachments, ATTACHMENT_CONCURRENCY, async (attachment) => {
    const attId = attachment.attId;
    const priorAttempt = Number(attempts[attId] || 0);
    const outcome = await downloadAttachment(entry.id, attachment, priorAttempt, settings);
    if (outcome.didAttempt) {
      attempts[attId] = priorAttempt + 1;
    } else if (!Number.isFinite(attempts[attId])) {
      attempts[attId] = priorAttempt;
    }

    if (!outcome.ok) {
      errors.push({
        attId,
        message: outcome.error.message,
        code: outcome.error.code,
        retryable: outcome.error.retryable
      });
      return;
    }

    results.push({
      attId,
      kind: attachment.kind,
      filename: attachment.filename,
      mime: attachment.mime,
      size: attachment.size,
      bytes: outcome.data,
      sha256: outcome.sha256 || null
    });
  });

  if (!errors.length) {
    return { status: "ok", attachments: results, errors: [], attempts };
  }

  const hasRetryable = errors.some((error) => error.retryable);
  if (hasRetryable) {
    return { status: "retry", attachments: [], errors, attempts };
  }

  return { status: "error", attachments: [], errors, attempts };
}

async function downloadAttachment(messageId, attachment, attemptCount, settings) {
  if (!attachment || !attachment.fetch || !attachment.fetch.url) {
    return {
      ok: false,
      didAttempt: false,
      error: buildAttachmentError("INVALID_FETCH", "Missing fetch url", false)
    };
  }

  const cached = await getCachedAttachment(messageId, attachment.attId);
  if (cached) {
    return { ok: true, didAttempt: false, data: cached.bytes, sha256: cached.sha256 };
  }

  if (attemptCount >= ATTACHMENT_RETRY_LIMIT) {
    return {
      ok: false,
      didAttempt: false,
      error: buildAttachmentError("RETRY_EXHAUSTED", "Retry limit reached", false)
    };
  }

  const now = Date.now();
  const expiresAt = Number(attachment.fetch.expiresAt);
  if (Number.isFinite(expiresAt) && now > expiresAt) {
    return {
      ok: false,
      didAttempt: false,
      error: buildAttachmentError("EXPIRED", "Attachment token expired", false)
    };
  }

  const method = (attachment.fetch.method || "GET").toUpperCase();
  const headers = normalizeHeaders(attachment.fetch.headers);

  try {
    const response = await fetchWithTimeout(attachment.fetch.url, settings.timeoutMs, {
      method,
      headers
    });

    if (!response.ok) {
      const code = `HTTP_${response.status}`;
      const retryable = isRetryableStatus(response.status);
      return {
        ok: false,
        didAttempt: true,
        error: buildAttachmentError(code, `HTTP ${response.status}`, retryable)
      };
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (attachment.mime && contentType && !contentType.includes(attachment.mime.toLowerCase())) {
      console.warn("[aivo-relay] Attachment mime mismatch", {
        attId: attachment.attId,
        expected: attachment.mime,
        received: contentType
      });
    }

    const data = await response.arrayBuffer();
    const sha256 = await computeSha256(data);
    await cacheAttachment(messageId, attachment, data, sha256);
    return { ok: true, didAttempt: true, data, sha256 };
  } catch (err) {
    const isTimeout = err?.name === "AbortError";
    const code = isTimeout ? "FETCH_TIMEOUT" : "FETCH_FAILED";
    return {
      ok: false,
      didAttempt: true,
      error: buildAttachmentError(code, err?.message || "Attachment fetch failed", true)
    };
  }
}

function buildAttachmentError(code, message, retryable) {
  return {
    code,
    message: message || code,
    retryable: Boolean(retryable)
  };
}

function isRetryableStatus(status) {
  if (status === 401 || status === 403 || status === 410) return false;
  return status === 408 || status === 429 || status >= 500;
}

async function cacheAttachment(messageId, attachment, bytes, sha256) {
  if (!messageId || !attachment?.attId) return;

  const key = buildAttachmentCacheKey(messageId, attachment.attId);
  const meta = {
    attId: attachment.attId,
    filename: attachment.filename,
    mime: attachment.mime,
    size: attachment.size,
    kind: attachment.kind
  };

  attachmentCache.set(key, {
    bytes,
    sha256,
    storedAt: Date.now(),
    meta
  });

  try {
    await storeBlob(messageId, attachment.attId, bytes);
  } catch (err) {
    console.warn("[aivo-relay] Failed to persist blob to IndexedDB", err);
  }

  pruneAttachmentCache();
}

async function getCachedAttachment(messageId, attId) {
  const key = buildAttachmentCacheKey(messageId, attId);
  const memEntry = attachmentCache.get(key);

  if (memEntry) {
    if (Date.now() - memEntry.storedAt > ATTACHMENT_CACHE_TTL_MS) {
      attachmentCache.delete(key);
    } else {
      return memEntry;
    }
  }

  try {
    const idbEntry = await getBlob(messageId, attId);
    if (idbEntry && idbEntry.bytes) {
      attachmentCache.set(key, {
        bytes: idbEntry.bytes,
        sha256: null,
        storedAt: idbEntry.storedAt || Date.now(),
        meta: null
      });
      return { bytes: idbEntry.bytes, sha256: null };
    }
  } catch (err) {
    console.warn("[aivo-relay] Failed to read blob from IndexedDB", err);
  }

  return null;
}

function pruneAttachmentCache() {
  const now = Date.now();
  for (const [key, entry] of attachmentCache.entries()) {
    if (now - entry.storedAt > ATTACHMENT_CACHE_TTL_MS) {
      attachmentCache.delete(key);
    }
  }
  if (attachmentCache.size <= ATTACHMENT_CACHE_MAX) return;
  const sorted = Array.from(attachmentCache.entries()).sort((a, b) => a[1].storedAt - b[1].storedAt);
  const excess = attachmentCache.size - ATTACHMENT_CACHE_MAX;
  for (let i = 0; i < excess; i += 1) {
    attachmentCache.delete(sorted[i][0]);
  }
}

function buildAttachmentCacheKey(messageId, attId) {
  return `${messageId}:${attId}`;
}

async function getAttachmentData(payload) {
  const messageId = payload?.messageId;
  const attId = payload?.attId;
  if (!messageId || !attId) {
    throw new Error("Missing attachment identifiers");
  }

  const cached = await getCachedAttachment(messageId, attId);
  if (cached && cached.bytes) {
    return {
      attId,
      bytes: Array.from(new Uint8Array(cached.bytes)),
      sha256: cached.sha256 || null,
      meta: cached.meta || null
    };
  }

  const stored = await chrome.storage.local.get({ messages: [] });
  const message = Array.isArray(stored.messages)
    ? stored.messages.find((msg) => msg.id === messageId)
    : null;
  const attachment = message?.attachments?.find((att) => att.attId === attId);
  if (!attachment) {
    throw new Error("Attachment not found");
  }

  const settings = await getSettings();
  const outcome = await downloadAttachment(messageId, attachment, 0, settings);
  if (!outcome.ok) {
    throw new Error(outcome.error?.message || "Attachment download failed");
  }

  return {
    attId,
    bytes: outcome.data ? Array.from(new Uint8Array(outcome.data)) : null,
    sha256: outcome.sha256,
    meta: {
      attId: attachment.attId,
      filename: attachment.filename,
      mime: attachment.mime,
      size: attachment.size,
      kind: attachment.kind
    }
  };
}
