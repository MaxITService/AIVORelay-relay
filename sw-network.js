'use strict';

/**
 * Get the connector password from chrome.storage.sync
 * Falls back to default password if not set
 */
async function getConnectorPassword() {
  try {
    const { connectorPassword } = await chrome.storage.sync.get({ connectorPassword: DEFAULT_PASSWORD });
    return connectorPassword || DEFAULT_PASSWORD;
  } catch {
    return DEFAULT_PASSWORD;
  }
}

/**
 * Save the connector password to chrome.storage.sync
 * Called when server sends passwordUpdate in response
 * @param {string} password - The new password to save
 */
async function saveConnectorPassword(password) {
  if (!password || typeof password !== "string") {
    console.warn("[aivo-relay] Attempted to save invalid password");
    return false;
  }
  try {
    await chrome.storage.sync.set({ connectorPassword: password });
    // Verify the save worked by reading it back
    const verify = await chrome.storage.sync.get("connectorPassword");
    if (verify.connectorPassword === password) {
      console.log("[aivo-relay] Password saved and verified");
      return true;
    }
    console.error("[aivo-relay] Password save verification failed");
    return false;
  } catch (err) {
    console.error("[aivo-relay] Failed to save password:", err?.message || err);
    return false;
  }
}

/**
 * Build authorization headers with Bearer token
 */
async function buildAuthHeaders(existingHeaders = {}) {
  const password = await getConnectorPassword();
  return {
    ...existingHeaders,
    "Authorization": `Bearer ${password}`
  };
}

function buildRequestUrl(settings, cursor) {
  const host = (settings.host || DEFAULT_SETTINGS.host).trim();
  const port = Number(settings.port) || DEFAULT_SETTINGS.port;
  const base = `http://${host}:${port}`;
  const path = (settings.path || DEFAULT_SETTINGS.path).trim();
  const url = new URL(path.startsWith("/") ? path : `/${path}`, base);

  if (cursor !== null && cursor !== undefined && cursor !== "") {
    url.searchParams.set("since", String(cursor));
  }

  return url;
}

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const authHeaders = await buildAuthHeaders(options.headers || {});

  try {
    return await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      ...options,
      headers: authHeaders
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function postJsonWithTimeout(url, payload, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const authHeaders = await buildAuthHeaders({ "Content-Type": "application/json" });

  try {
    return await fetch(url, {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: authHeaders,
      body: JSON.stringify(payload)
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Send password acknowledgement to server after saving a new password.
 * This completes the two-phase commit for password update.
 * Must use the NEW password for authentication (server accepts both during transition).
 * @param {object} settings - Connection settings (host, port, path)
 * @param {string} newPassword - The new password to use for auth and acknowledge
 * @param {number} timeoutMs - Request timeout
 */
async function sendPasswordAck(settings, newPassword, timeoutMs = 3000) {
  const host = (settings.host || DEFAULT_SETTINGS.host).trim();
  const port = Number(settings.port) || DEFAULT_SETTINGS.port;
  const path = (settings.path || DEFAULT_SETTINGS.path).trim();
  const url = `http://${host}:${port}${path.startsWith("/") ? path : `/${path}`}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${newPassword}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ type: "password_ack" })
    });

    if (response.ok) {
      console.log("[aivo-relay] Password acknowledgement sent successfully");
      return true;
    } else {
      console.error("[aivo-relay] Password ack failed:", response.status);
      return false;
    }
  } catch (err) {
    console.error("[aivo-relay] Failed to send password ack:", err?.message || err);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}
