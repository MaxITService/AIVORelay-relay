'use strict';

const DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 63155,
  path: "/messages",
  pollMinutes: 1, // Reduced frequency - long-poll handles real-time delivery
  timeoutMs: 3000, // Legacy timeout for non-long-poll requests
  autoSend: true,
  maxStoredMessages: 50,
  singleTabBindingMode: true
};

const DEFAULT_PASSWORD = "fklejqwhfiu342lhk3";

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
