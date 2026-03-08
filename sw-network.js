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
    const verify = await chrome.storage.sync.get("connectorPassword");
    if (verify.connectorPassword === password) {
      console.log("[aivo-relay] Password saved and verified");
      await clearConnectorSession();
      return true;
    }
    console.error("[aivo-relay] Password save verification failed");
    return false;
  } catch (err) {
    console.error("[aivo-relay] Failed to save password:", err?.message || err);
    return false;
  }
}

async function buildAuthHeaders(existingHeaders = {}, passwordOverride = null) {
  const password = passwordOverride || await getConnectorPassword();
  return {
    ...existingHeaders,
    "Authorization": `Bearer ${password}`
  };
}

function getBaseUrl(settings) {
  const host = (settings.host || DEFAULT_SETTINGS.host).trim();
  const port = Number(settings.port) || DEFAULT_SETTINGS.port;
  return `http://${host}:${port}`;
}

function buildRequestUrl(settings, cursor, waitSeconds = 0) {
  const base = getBaseUrl(settings);
  const path = (settings.path || DEFAULT_SETTINGS.path).trim();
  const url = new URL(path.startsWith("/") ? path : `/${path}`, base);

  if (cursor !== null && cursor !== undefined && cursor !== "") {
    url.searchParams.set("since", String(cursor));
  }
  if (waitSeconds > 0) {
    url.searchParams.set("wait", String(waitSeconds));
  }

  return url;
}

function buildSessionUrl(settings) {
  return new URL(CONNECTOR_SESSION_PATH, `${getBaseUrl(settings)}/`);
}

function isConnectorSessionValid(session, settings) {
  if (!session || typeof session !== "object") return false;
  if (!session.id || typeof session.id !== "string") return false;
  if (session.protocolVersion !== CONNECTOR_PROTOCOL_VERSION) return false;
  if ((session.host || "").toLowerCase() !== (settings.host || DEFAULT_SETTINGS.host).trim().toLowerCase()) {
    return false;
  }
  if (Number(session.port) !== (Number(settings.port) || DEFAULT_SETTINGS.port)) return false;
  if (!Number.isFinite(Number(session.nextClientSequence)) || Number(session.nextClientSequence) < 1) {
    return false;
  }
  if (!Number.isFinite(Number(session.nextServerSequence)) || Number(session.nextServerSequence) < 1) {
    return false;
  }
  if (!Number.isFinite(Number(session.expiresAt)) || Number(session.expiresAt) <= Date.now()) {
    return false;
  }
  return true;
}

function parseRequiredPositiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Missing or invalid ${label}`);
  }
  return parsed;
}

async function createConnectorSession(settings, timeoutMs, passwordOverride = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = await buildAuthHeaders({
      [CONNECTOR_SESSION_HEADER_NAMES.protocolVersion]: String(CONNECTOR_PROTOCOL_VERSION)
    }, passwordOverride);

    const response = await fetch(buildSessionUrl(settings), {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`Session handshake failed: HTTP ${response.status}${bodyText ? `: ${bodyText}` : ""}`);
    }

    const body = await response.json();
    if (!body || Number(body.protocolVersion) !== CONNECTOR_PROTOCOL_VERSION) {
      throw new Error("Session handshake returned an unsupported protocol version");
    }

    const serverSequenceHeader = response.headers.get(CONNECTOR_SESSION_HEADER_NAMES.serverSequence);
    const serverSequence = serverSequenceHeader
      ? parseRequiredPositiveInt(serverSequenceHeader, "server sequence")
      : parseRequiredPositiveInt(body.nextServerSequence, "server sequence");
    const expiresHeader = response.headers.get(CONNECTOR_SESSION_HEADER_NAMES.sessionExpiresAt);
    const expiresAt = expiresHeader
      ? parseRequiredPositiveInt(expiresHeader, "session expiry")
      : parseRequiredPositiveInt(body.expiresAt, "session expiry");
    const responseSessionId = response.headers.get(CONNECTOR_SESSION_HEADER_NAMES.sessionId);
    const sessionId = String(responseSessionId || body.sessionId || "").trim();
    if (!sessionId) {
      throw new Error("Session handshake did not return a session id");
    }

    const session = {
      id: sessionId,
      host: (settings.host || DEFAULT_SETTINGS.host).trim(),
      port: Number(settings.port) || DEFAULT_SETTINGS.port,
      nextClientSequence: parseRequiredPositiveInt(body.nextClientSequence, "next client sequence"),
      nextServerSequence: serverSequence + 1,
      expiresAt,
      protocolVersion: CONNECTOR_PROTOCOL_VERSION
    };

    await saveConnectorSession(session);
    return session;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getUsableConnectorSession(settings, timeoutMs, options = {}) {
  if (options.refreshSession) {
    await clearConnectorSession();
  }

  const storedSession = await getConnectorSession();
  if (isConnectorSessionValid(storedSession, settings)) {
    return storedSession;
  }

  await clearConnectorSession();
  return createConnectorSession(settings, timeoutMs, options.passwordOverride || null);
}

async function decryptConnectorPayload(payloadText, password) {
  if (!payloadText || !password || !globalThis.crypto?.subtle) return null;

  let cipherBytes;
  try {
    const raw = atob(payloadText.trim());
    cipherBytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      cipherBytes[i] = raw.charCodeAt(i);
    }
  } catch {
    return null;
  }

  if (cipherBytes.length <= 12) return null;

  const encoder = new TextEncoder();
  const contextBytes = encoder.encode(CONNECTOR_ENC_KEY_CONTEXT);
  const passwordBytes = encoder.encode(password);
  const keyMaterial = new Uint8Array(contextBytes.length + passwordBytes.length);
  keyMaterial.set(contextBytes, 0);
  keyMaterial.set(passwordBytes, contextBytes.length);

  try {
    const keyHash = await crypto.subtle.digest("SHA-256", keyMaterial);
    const aesKey = await crypto.subtle.importKey(
      "raw",
      keyHash,
      { name: "AES-GCM" },
      false,
      ["decrypt"]
    );
    const iv = cipherBytes.slice(0, 12);
    const data = cipherBytes.slice(12);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, data);
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

async function readConnectorResponseText(response, passwordOverride = null) {
  const bodyText = await response.text();
  if (!bodyText || parseMaybeJson(bodyText) !== null) {
    return bodyText;
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/plain")) {
    return bodyText;
  }

  const password = passwordOverride || await getConnectorPassword();
  const decrypted = await decryptConnectorPayload(bodyText, password);
  if (decrypted) {
    return decrypted;
  }

  throw new Error("Failed to decrypt connector payload");
}

async function validateConnectorResponseSession(response, session) {
  const responseSessionId = String(response.headers.get(CONNECTOR_SESSION_HEADER_NAMES.sessionId) || "").trim();
  const responseSequence = parseRequiredPositiveInt(
    response.headers.get(CONNECTOR_SESSION_HEADER_NAMES.serverSequence),
    "response sequence"
  );
  const responseExpiresAt = parseRequiredPositiveInt(
    response.headers.get(CONNECTOR_SESSION_HEADER_NAMES.sessionExpiresAt),
    "session expiry"
  );

  if (responseSessionId !== session.id) {
    throw new Error("Connector response session id mismatch");
  }
  if (responseSequence !== Number(session.nextServerSequence)) {
    throw new Error("Connector response sequence mismatch");
  }

  const nextSession = {
    ...session,
    nextClientSequence: Number(session.nextClientSequence) + 1,
    nextServerSequence: responseSequence + 1,
    expiresAt: responseExpiresAt
  };
  await saveConnectorSession(nextSession);
  return nextSession;
}

async function connectorFetch(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const settings = options.settings || await getSettings();
  const useSession = options.useSession !== false;
  const {
    settings: _settings,
    passwordOverride,
    refreshSession,
    useSession: _useSession,
    headers: optionHeaders,
    ...requestInit
  } = options;
  let session = null;

  try {
    const headers = { ...(optionHeaders || {}) };
    if (useSession) {
      session = await getUsableConnectorSession(settings, timeoutMs, {
        passwordOverride: passwordOverride || null,
        refreshSession: refreshSession === true
      });
      headers[CONNECTOR_SESSION_HEADER_NAMES.protocolVersion] = String(CONNECTOR_PROTOCOL_VERSION);
      headers[CONNECTOR_SESSION_HEADER_NAMES.sessionId] = session.id;
      headers[CONNECTOR_SESSION_HEADER_NAMES.sequence] = String(session.nextClientSequence);
      headers[CONNECTOR_SESSION_HEADER_NAMES.timestamp] = String(Date.now());
    }

    const authHeaders = await buildAuthHeaders(headers, passwordOverride || null);
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      ...requestInit,
      headers: authHeaders
    });

    if (!response.ok) {
      if (useSession) {
        await clearConnectorSession();
      }
      return response;
    }

    if (useSession) {
      await validateConnectorResponseSession(response, session);
    }

    return response;
  } catch (err) {
    if (useSession) {
      await clearConnectorSession();
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  return connectorFetch(url, timeoutMs, options);
}

async function postJsonWithTimeout(url, payload, timeoutMs, options = {}) {
  return connectorFetch(url, timeoutMs, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: JSON.stringify(payload),
    settings: options.settings,
    passwordOverride: options.passwordOverride || null,
    refreshSession: options.refreshSession === true,
    useSession: options.useSession !== false
  });
}

/**
 * Send password acknowledgement to server after saving a new password.
 * This completes the two-phase commit for password update.
 * Must use the NEW password for authentication.
 * @param {object} settings - Connection settings (host, port, path)
 * @param {string} newPassword - The new password to use for auth and acknowledge
 * @param {number} timeoutMs - Request timeout
 */
async function sendPasswordAck(settings, newPassword, timeoutMs = 3000) {
  const url = buildRequestUrl(settings, null);

  try {
    const response = await postJsonWithTimeout(
      url,
      { type: "password_ack" },
      timeoutMs,
      {
        settings,
        passwordOverride: newPassword,
        refreshSession: true
      }
    );

    if (response.ok) {
      console.log("[aivo-relay] Password acknowledgement sent successfully");
      return true;
    }

    console.error("[aivo-relay] Password ack failed:", response.status);
    await clearConnectorSession();
    return false;
  } catch (err) {
    console.error("[aivo-relay] Failed to send password ack:", err?.message || err);
    await clearConnectorSession();
    return false;
  }
}
