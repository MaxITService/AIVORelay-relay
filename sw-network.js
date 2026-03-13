'use strict';

let connectorSessionRequestChain = Promise.resolve();

function runSerializedConnectorSessionRequest(work) {
  const next = connectorSessionRequestChain.catch(() => {}).then(work);
  connectorSessionRequestChain = next.catch(() => {});
  return next;
}

function runConnectorRequestTransaction(useSession, work) {
  if (!useSession) {
    return work();
  }
  return runSerializedConnectorSessionRequest(work);
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Get the connector password from chrome.storage.sync.
 * Falls back to default password if not set.
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
 * Save the connector password to chrome.storage.sync.
 * Called when server sends passwordUpdate in response.
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

function getRouteLabel(urlLike) {
  const url = typeof urlLike === "string" ? new URL(urlLike) : urlLike;
  return `${url.pathname}${url.search}`;
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
  if (!session.encKey || !session.macKey) return false;
  return true;
}

function parseRequiredPositiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Missing or invalid ${label}`);
  }
  return parsed;
}

function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < view.length; i += chunkSize) {
    binary += String.fromCharCode(...view.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const raw = atob(String(value || "").trim());
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

function concatBytes(...parts) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

function constantTimeEqualBytes(a, b) {
  const left = a instanceof Uint8Array ? a : new Uint8Array(a);
  const right = b instanceof Uint8Array ? b : new Uint8Array(b);
  let diff = left.length === right.length ? 0 : 1;
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}

async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

async function derivePasswordAuthKeyBytes(password) {
  const material = concatBytes(
    textEncoder.encode(CONNECTOR_PASSWORD_AUTH_CONTEXT),
    textEncoder.encode(password)
  );
  return sha256Bytes(material);
}

async function computeHmacBytes(keyBytes, payloadBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return new Uint8Array(signature);
}

async function deriveSessionKeyBytes(sharedSecretBytes, authKeyBytes, contextLabel, transcriptHashBytes) {
  const keyMaterial = await crypto.subtle.importKey("raw", sharedSecretBytes, "HKDF", false, ["deriveBits"]);
  const info = concatBytes(textEncoder.encode(contextLabel), transcriptHashBytes);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: authKeyBytes,
      info
    },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

function buildClientHelloPayload(timestamp, clientNonce, clientPublicKey) {
  return textEncoder.encode(
    `aivorelay-v3-client-hello\n${CONNECTOR_PROTOCOL_VERSION}\n${timestamp}\n${clientNonce}\n${clientPublicKey}\nsession`
  );
}

function buildServerHelloPayload(sessionId, expiresAt, encryptionEnabled, clientPublicKey, serverPublicKey, clientNonce, serverNonce) {
  return textEncoder.encode(
    `aivorelay-v3-server-hello\n${CONNECTOR_PROTOCOL_VERSION}\n${sessionId}\n${expiresAt}\n${encryptionEnabled ? 1 : 0}\n${clientNonce}\n${serverNonce}\n${clientPublicKey}\n${serverPublicKey}`
  );
}

async function buildHandshakeTranscriptHash(sessionId, clientPublicKeyBytes, serverPublicKeyBytes, clientNonceBytes, serverNonceBytes) {
  return sha256Bytes(
    concatBytes(
      textEncoder.encode("aivorelay-v3-transcript"),
      textEncoder.encode(sessionId),
      clientPublicKeyBytes,
      serverPublicKeyBytes,
      clientNonceBytes,
      serverNonceBytes
    )
  );
}

function hashBodyBase64(bodyBytes) {
  return sha256Bytes(bodyBytes).then(bytesToBase64);
}

async function buildRequestMacPayload(routeLabel, sequence, timestamp, bodyBytes) {
  const bodyHash = await hashBodyBase64(bodyBytes);
  return textEncoder.encode(
    `aivorelay-v3-request\n${routeLabel}\n${sequence}\n${timestamp}\n${bodyHash}`
  );
}

async function buildResponseMacPayload(routeLabel, status, serverSequence, expiresAt, encrypted, bodyBytes) {
  const bodyHash = await hashBodyBase64(bodyBytes);
  return textEncoder.encode(
    `aivorelay-v3-response\n${routeLabel}\n${status}\n${serverSequence}\n${expiresAt}\n${encrypted ? 1 : 0}\n${bodyHash}`
  );
}

async function importSessionAesKey(session) {
  return crypto.subtle.importKey(
    "raw",
    base64ToBytes(session.encKey),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
}

async function decryptAesGcmPayload(session, cipherBytes) {
  const bytes = cipherBytes instanceof Uint8Array ? cipherBytes : new Uint8Array(cipherBytes);
  if (bytes.length <= 12) {
    throw new Error("Encrypted connector payload is too short");
  }
  const aesKey = await importSessionAesKey(session);
  const iv = bytes.slice(0, 12);
  const data = bytes.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, data);
  return new Uint8Array(plaintext);
}

async function decodeEncryptedResponseBytes(response, session, rawBytes) {
  const encryptedFlag = response.headers.get(CONNECTOR_SESSION_HEADER_NAMES.payloadEncrypted) === "1";
  if (!encryptedFlag) {
    return rawBytes;
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  let cipherBytes = rawBytes;
  if (contentType.includes("text/plain")) {
    cipherBytes = base64ToBytes(textDecoder.decode(rawBytes).trim());
  }

  return decryptAesGcmPayload(session, cipherBytes);
}

async function createConnectorSession(settings, timeoutMs) {
  const password = await getConnectorPassword();
  const authKeyBytes = await derivePasswordAuthKeyBytes(password);
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const clientPublicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const clientPublicKey = bytesToBase64(clientPublicKeyBytes);
  const clientNonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const clientNonce = bytesToBase64(clientNonceBytes);
  const timestamp = Date.now();
  const clientProof = bytesToBase64(
    await computeHmacBytes(authKeyBytes, buildClientHelloPayload(timestamp, clientNonce, clientPublicKey))
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(buildSessionUrl(settings), {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        [CONNECTOR_SESSION_HEADER_NAMES.protocolVersion]: String(CONNECTOR_PROTOCOL_VERSION),
        [CONNECTOR_SESSION_HEADER_NAMES.extensionId]: chrome.runtime.id
      },
      body: JSON.stringify({
        clientPublicKey,
        clientNonce,
        timestamp,
        clientProof
      })
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`Session handshake failed: HTTP ${response.status}${bodyText ? `: ${bodyText}` : ""}`);
    }

    const body = await response.json();
    if (!body || Number(body.protocolVersion) !== CONNECTOR_PROTOCOL_VERSION) {
      throw new Error("Session handshake returned an unsupported protocol version");
    }

    const sessionId = String(response.headers.get(CONNECTOR_SESSION_HEADER_NAMES.sessionId) || body.sessionId || "").trim();
    if (!sessionId) {
      throw new Error("Session handshake did not return a session id");
    }

    const serverSequenceHeader = response.headers.get(CONNECTOR_SESSION_HEADER_NAMES.serverSequence);
    const serverSequence = serverSequenceHeader
      ? parseRequiredPositiveInt(serverSequenceHeader, "server sequence")
      : parseRequiredPositiveInt(body.nextServerSequence, "server sequence");
    const expiresHeader = response.headers.get(CONNECTOR_SESSION_HEADER_NAMES.sessionExpiresAt);
    const expiresAt = expiresHeader
      ? parseRequiredPositiveInt(expiresHeader, "session expiry")
      : parseRequiredPositiveInt(body.expiresAt, "session expiry");

    const serverPublicKey = String(body.serverPublicKey || "").trim();
    const serverNonce = String(body.serverNonce || "").trim();
    const serverProof = String(body.serverProof || "").trim();
    if (!serverPublicKey || !serverNonce || !serverProof) {
      throw new Error("Session handshake response is missing server key material");
    }

    const expectedServerProofPayload = buildServerHelloPayload(
      sessionId,
      expiresAt,
      Boolean(body.encryptionEnabled),
      clientPublicKey,
      serverPublicKey,
      clientNonce,
      serverNonce
    );
    const expectedServerProof = await computeHmacBytes(authKeyBytes, expectedServerProofPayload);
    if (!constantTimeEqualBytes(base64ToBytes(serverProof), expectedServerProof)) {
      throw new Error("Session handshake server proof is invalid");
    }

    const serverPublicKeyBytes = base64ToBytes(serverPublicKey);
    const serverNonceBytes = base64ToBytes(serverNonce);
    const importedServerPublicKey = await crypto.subtle.importKey(
      "raw",
      serverPublicKeyBytes,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );
    const sharedSecretBytes = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "ECDH", public: importedServerPublicKey },
        keyPair.privateKey,
        256
      )
    );
    const transcriptHash = await buildHandshakeTranscriptHash(
      sessionId,
      clientPublicKeyBytes,
      serverPublicKeyBytes,
      clientNonceBytes,
      serverNonceBytes
    );
    const encKey = await deriveSessionKeyBytes(
      sharedSecretBytes,
      authKeyBytes,
      CONNECTOR_SESSION_ENC_CONTEXT,
      transcriptHash
    );
    const macKey = await deriveSessionKeyBytes(
      sharedSecretBytes,
      authKeyBytes,
      CONNECTOR_SESSION_MAC_CONTEXT,
      transcriptHash
    );

    const session = {
      id: sessionId,
      host: (settings.host || DEFAULT_SETTINGS.host).trim(),
      port: Number(settings.port) || DEFAULT_SETTINGS.port,
      nextClientSequence: parseRequiredPositiveInt(body.nextClientSequence, "next client sequence"),
      nextServerSequence: serverSequence + 1,
      expiresAt,
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      encKey: bytesToBase64(encKey),
      macKey: bytesToBase64(macKey),
      encryptionEnabled: Boolean(body.encryptionEnabled)
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
  return createConnectorSession(settings, timeoutMs);
}

async function validateConnectorResponseSession(result, rawBytes) {
  const { response, session, routeLabel } = result;
  if (!session) {
    return null;
  }

  const responseSessionId = String(response.headers.get(CONNECTOR_SESSION_HEADER_NAMES.sessionId) || "").trim();
  const responseSequence = parseRequiredPositiveInt(
    response.headers.get(CONNECTOR_SESSION_HEADER_NAMES.serverSequence),
    "response sequence"
  );
  const responseExpiresAt = parseRequiredPositiveInt(
    response.headers.get(CONNECTOR_SESSION_HEADER_NAMES.sessionExpiresAt),
    "session expiry"
  );
  const responseMac = String(response.headers.get(CONNECTOR_SESSION_HEADER_NAMES.responseMac) || "").trim();
  const encrypted = response.headers.get(CONNECTOR_SESSION_HEADER_NAMES.payloadEncrypted) === "1";

  if (responseSessionId !== session.id) {
    console.warn("[aivo-relay] Connector response session mismatch", {
      routeLabel,
      expectedSessionId: session.id,
      receivedSessionId: responseSessionId || null
    });
    throw new Error("Connector response session id mismatch");
  }
  if (responseSequence !== Number(session.nextServerSequence)) {
    console.warn("[aivo-relay] Connector response sequence mismatch", {
      routeLabel,
      expectedSequence: Number(session.nextServerSequence),
      receivedSequence: responseSequence,
      sessionId: session.id
    });
    throw new Error("Connector response sequence mismatch");
  }
  if (!responseMac) {
    console.warn("[aivo-relay] Connector response missing mac", {
      routeLabel,
      sessionId: session.id,
      responseSequence
    });
    throw new Error("Connector response is missing response mac");
  }

  const macKeyBytes = base64ToBytes(session.macKey);
  const expectedPayload = await buildResponseMacPayload(
    routeLabel,
    response.status,
    responseSequence,
    responseExpiresAt,
    encrypted,
    rawBytes
  );
  const expectedMac = await computeHmacBytes(macKeyBytes, expectedPayload);
  if (!constantTimeEqualBytes(base64ToBytes(responseMac), expectedMac)) {
    console.warn("[aivo-relay] Connector response authentication failed", {
      routeLabel,
      sessionId: session.id,
      responseSequence,
      status: response.status
    });
    throw new Error("Connector response authentication failed");
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
  const settings = options.settings || await getSettings();
  const {
    settings: _settings,
    refreshSession,
    useSession,
    signal: optionSignal,
    headers: optionHeaders,
    body,
    ...requestInit
  } = options;
  const shouldUseSession = useSession !== false;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
  const requestSignal = optionSignal
    ? AbortSignal.any([optionSignal, timeoutController.signal])
    : timeoutController.signal;
  let session = null;

  try {
    const headers = { ...(optionHeaders || {}) };
    if (shouldUseSession) {
      session = await getUsableConnectorSession(settings, timeoutMs, {
        refreshSession: refreshSession === true
      });
      const routeLabel = getRouteLabel(url);
      const sequence = Number(session.nextClientSequence);
      const timestamp = Date.now();
      const bodyBytes = typeof body === "string" ? textEncoder.encode(body) : new Uint8Array(0);
      const requestMacPayload = await buildRequestMacPayload(routeLabel, sequence, timestamp, bodyBytes);
      const requestMac = await computeHmacBytes(base64ToBytes(session.macKey), requestMacPayload);
      headers[CONNECTOR_SESSION_HEADER_NAMES.protocolVersion] = String(CONNECTOR_PROTOCOL_VERSION);
      headers[CONNECTOR_SESSION_HEADER_NAMES.extensionId] = chrome.runtime.id;
      headers[CONNECTOR_SESSION_HEADER_NAMES.sessionId] = session.id;
      headers[CONNECTOR_SESSION_HEADER_NAMES.sequence] = String(sequence);
      headers[CONNECTOR_SESSION_HEADER_NAMES.timestamp] = String(timestamp);
      headers[CONNECTOR_SESSION_HEADER_NAMES.requestMac] = bytesToBase64(requestMac);
    }

    const response = await fetch(url, {
      cache: "no-store",
      signal: requestSignal,
      ...requestInit,
      headers,
      body
    });

    if (!response.ok && shouldUseSession) {
      console.warn("[aivo-relay] Connector request failed", {
        routeLabel: getRouteLabel(url),
        status: response.status,
        sessionId: session?.id || null,
        sequence: session ? Number(session.nextClientSequence) : null
      });
      await clearConnectorSession();
    }

    return {
      response,
      session,
      routeLabel: getRouteLabel(url)
    };
  } catch (err) {
    const abortedByCaller = err?.name === "AbortError" && optionSignal?.aborted && !timeoutController.signal.aborted;
    if (shouldUseSession && !abortedByCaller) {
      await clearConnectorSession();
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readConnectorResponseText(fetchResult) {
  try {
    const rawBuffer = await fetchResult.response.arrayBuffer();
    const rawBytes = new Uint8Array(rawBuffer);
    const validatedSession = await validateConnectorResponseSession(fetchResult, rawBytes);
    const effectiveSession = validatedSession || fetchResult.session;
    const decodedBytes = effectiveSession
      ? await decodeEncryptedResponseBytes(fetchResult.response, effectiveSession, rawBytes)
      : rawBytes;

    return textDecoder.decode(decodedBytes);
  } catch (err) {
    await clearConnectorSession();
    throw err;
  }
}

async function readConnectorResponseBytes(fetchResult) {
  try {
    const rawBuffer = await fetchResult.response.arrayBuffer();
    const rawBytes = new Uint8Array(rawBuffer);
    const validatedSession = await validateConnectorResponseSession(fetchResult, rawBytes);
    const effectiveSession = validatedSession || fetchResult.session;
    return effectiveSession
      ? decodeEncryptedResponseBytes(fetchResult.response, effectiveSession, rawBytes)
      : rawBytes;
  } catch (err) {
    await clearConnectorSession();
    throw err;
  }
}

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  return connectorFetch(url, timeoutMs, options);
}

async function fetchTextWithTimeout(url, timeoutMs, options = {}) {
  const shouldUseSession = options.useSession !== false;
  return runConnectorRequestTransaction(shouldUseSession, async () => {
    const fetchResult = await connectorFetch(url, timeoutMs, options);
    let bodyText = "";
    if (fetchResult.response.ok) {
      bodyText = await readConnectorResponseText(fetchResult);
    } else {
      bodyText = await fetchResult.response.text();
    }

    return {
      response: fetchResult.response,
      bodyText
    };
  });
}

async function fetchBytesWithTimeout(url, timeoutMs, options = {}) {
  const shouldUseSession = options.useSession !== false;
  return runConnectorRequestTransaction(shouldUseSession, async () => {
    const fetchResult = await connectorFetch(url, timeoutMs, options);
    let data;
    if (fetchResult.response.ok) {
      data = await readConnectorResponseBytes(fetchResult);
    } else {
      data = new Uint8Array(await fetchResult.response.arrayBuffer());
    }

    return {
      response: fetchResult.response,
      data
    };
  });
}

async function postJsonWithTimeout(url, payload, timeoutMs, options = {}) {
  const body = JSON.stringify(payload);
  const shouldUseSession = options.useSession !== false;
  return runConnectorRequestTransaction(shouldUseSession, async () => {
    const fetchResult = await connectorFetch(url, timeoutMs, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      body,
      settings: options.settings,
      refreshSession: options.refreshSession === true,
      useSession: shouldUseSession
    });

    let bodyText = "";
    if (fetchResult.response.ok) {
      bodyText = await readConnectorResponseText(fetchResult);
    } else {
      bodyText = await fetchResult.response.text();
    }

    return {
      ok: fetchResult.response.ok,
      status: fetchResult.response.status,
      bodyText
    };
  });
}

/**
 * Send password acknowledgement to server after saving a new password.
 * Uses the current authenticated session; if the server commits the new
 * password and clears sessions, the extension will create a fresh session on
 * the next request using the saved password.
 */
async function sendPasswordAck(settings, _newPassword, timeoutMs = 3000) {
  const url = buildRequestUrl(settings, null);

  try {
    const response = await postJsonWithTimeout(
      url,
      { type: "password_ack" },
      timeoutMs,
      { settings }
    );

    if (response.ok) {
      console.log("[aivo-relay] Password acknowledgement sent successfully");
      return true;
    }

    console.error("[aivo-relay] Password ack failed:", response.status, response.bodyText);
    await clearConnectorSession();
    return false;
  } catch (err) {
    console.error("[aivo-relay] Failed to send password ack:", err?.message || err);
    await clearConnectorSession();
    return false;
  }
}
