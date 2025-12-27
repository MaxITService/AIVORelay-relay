'use strict';

const DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 63155,
  path: "/messages",
  pollMinutes: 0.1,
  timeoutMs: 3000,
  autoSend: true,
  maxStoredMessages: 5,
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

const MAX_MESSAGES = 5;
const MAX_DEDUPED_IDS = 400;
const MAX_PENDING_BUNDLES = 200;
const STATUS_PREFIX = "[hc-status]";

const ATTACHMENT_RETRY_LIMIT = 2;
const ATTACHMENT_RETRY_DELAY_MS = 1500;
const ATTACHMENT_CONCURRENCY = 2;
const ATTACHMENT_CACHE_TTL_MS = 5 * 60 * 1000;
const ATTACHMENT_CACHE_MAX = 50;
