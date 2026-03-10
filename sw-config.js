'use strict';

const DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 38243,
  path: "/messages",
  pollMinutes: 1, // Reduced frequency - long-poll handles real-time delivery
  timeoutMs: 3000, // Legacy timeout for non-long-poll requests
  autoSend: true,
  maxStoredMessages: 50,
  singleTabBindingMode: true
};

const DEFAULT_PASSWORD = "befc3aa14cc05e56011865df1c49d16ef9100a53d9bfa02be8d4ffd386324f65";
const CONNECTOR_PROTOCOL_VERSION = 3;
const CONNECTOR_SESSION_PATH = "/session";
const CONNECTOR_PASSWORD_AUTH_CONTEXT = "AivoRelay Connector Protocol v3 password auth key";
const CONNECTOR_SESSION_ENC_CONTEXT = "AivoRelay Connector Protocol v3 session AES-256-GCM key";
const CONNECTOR_SESSION_MAC_CONTEXT = "AivoRelay Connector Protocol v3 session HMAC-SHA256 key";
const CONNECTOR_SESSION_HEADER_NAMES = {
  protocolVersion: "x-aivorelay-protocol-version",
  sessionId: "x-aivorelay-session-id",
  sequence: "x-aivorelay-sequence",
  timestamp: "x-aivorelay-timestamp",
  extensionId: "x-aivorelay-extension-id",
  serverSequence: "x-aivorelay-server-sequence",
  sessionExpiresAt: "x-aivorelay-session-expires-at",
  requestMac: "x-aivorelay-request-mac",
  responseMac: "x-aivorelay-response-mac",
  payloadEncrypted: "x-aivorelay-payload-encrypted"
};

const STATUS_DEFAULT = {
  lastPollAt: null,
  lastSuccessAt: null,
  lastError: null,
  connected: false,
  lastKeepaliveAt: null
};

// Long-polling configuration
const LONG_POLL_WAIT_SECONDS = 25;     // Server holds connection this long
const LONG_POLL_TIMEOUT_MS = 30000;    // Client timeout (server wait + buffer)
const RECONNECT_DELAY_MS = 500;        // Gap between long-poll cycles
const ERROR_BACKOFF_BASE_MS = 1000;    // Exponential backoff base
const ERROR_BACKOFF_MAX_MS = 30000;    // Max backoff on errors

const MAX_MESSAGES = 50;
const MAX_DEDUPED_IDS = 400;
const MAX_PENDING_BUNDLES = 200;
const STATUS_PREFIX = "[hc-status]";

const ATTACHMENT_RETRY_LIMIT = 2;
const ATTACHMENT_RETRY_DELAY_MS = 1500;
const ATTACHMENT_CONCURRENCY = 2;
const ATTACHMENT_CACHE_TTL_MS = 5 * 60 * 1000;
const ATTACHMENT_CACHE_MAX = 50;

const CONNECTOR_SESSION_DEFAULT = {
  id: null,
  host: null,
  port: null,
  nextClientSequence: 1,
  nextServerSequence: 1,
  expiresAt: 0,
  protocolVersion: CONNECTOR_PROTOCOL_VERSION,
  encKey: null,
  macKey: null,
  encryptionEnabled: true
};
