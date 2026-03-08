# AivoRelay Notes

## Current Behavior (Dec 2025)

- Service worker polls `/messages`, filters keepalive/status, forwards regular messages to the bound tab.
- Service worker now establishes a protocol-v3 session via `POST /session` before polling or fetching blobs, using an authenticated ephemeral P-256 ECDH handshake.
- Bundle messages can include attachments; the worker downloads `/blob/<attId>` and only forwards when all attachments succeed.
- Attachment downloads are retried with a pending bundle queue, and recent message IDs are deduped across restarts.
- Content script receives NEW_MESSAGE, inserts text, uploads attachments on ChatGPT, auto-sends when enabled.
- **Paste-first approach**: Text is always inserted into the editor first. Stop button detection only happens during auto-send. If AI is "still typing" (stop button visible), the message is pasted but auto-send is skipped, with a toast explaining: "Text inserted. Auto-send skipped (AI still typing)."
- Messages are dropped only when a prior message is still in flight.
- Supported sites: ChatGPT, Gemini, Perplexity, Claude, Grok, and AI Studio (all with attachment support).
- Perplexity insertion uses a main-world injector script for text and a "Paste Event" simulation for attachments.
- Auto-send toggle lives in the popup (default on, stored in chrome.storage.local).
- Status reports are POSTed to `/messages` with type `status` and prefix `[hc-status]` to avoid loops.
- No selector auto-detection or button injection container logic is used.

## Password Authentication

- The connector password is now a bootstrap secret for the session handshake, not the per-request transport key.
- Default password: `fklejqwhfiu342lhk3` (defined in `sw-config.js` and `popup.js`).
- Password is stored in `chrome.storage.sync` under key `connectorPassword` to sync across Chrome instances.
- The service worker derives an HMAC auth key from that password, authenticates the `/session` handshake, then uses HKDF-derived per-session AES-GCM and HMAC keys for later requests/responses.
- If the handshake fails, a user-friendly error is shown: "Authentication failed. Check that your password matches the AivoRelay app."
- Popup includes a password input field with show/hide toggle (eye icon).
- Password auto-saves on change with debounce (500ms delay).
- **Auto-Update Flow**: On first connection with the default password, the server generates a unique 64-char hex password and sends it in the response as `passwordUpdate`. The extension saves this immediately via `saveConnectorPassword()` and uses it for all future requests.
- Encrypted `/messages` and `/blob/<attId>` responses are decrypted in the service worker with Web Crypto AES-GCM using the derived per-session key.

## Popup

- Bind to tab, connection status, keepalive indicator, Auto-send toggle, port setting.
- Message list includes attachment thumbnails and retry buttons for failed deliveries.

## Toasts

- busy/drop, editor not found, send button not found, attachment failures, unsupported attachments.

## Server Integration

- Keepalive messages are sent every 15s by `test-server.ps1` and acked by the extension.
- Status messages are written back to the server via POST and filtered out from forwarding.
- Bundle attachments are fetched via `/blob/<attId>` with the active connector session and anti-replay headers.
- `test-server.ps1` shortcuts: test-image, test-file, test-csv, test-bundle.

## Files of Interest

- `sw.js`
- `sw-config.js`
- `sw-idb.js`
- `sw-utils.js`
- `sw-network.js`
- `sw-normalize.js`
- `sw-storage.js`
- `sw-attachments.js`
- `sw-messaging.js`
- `sw-polling.js`
- `sw-init.js`
- `content-script.js`
- `popup.js`
- `popup.html`
- `per-website-button-clicking-mechanics/buttons-clicking-shared.js`
- `per-website-button-clicking-mechanics/buttons-clicking-chatgpt.js`
- `per-website-button-clicking-mechanics/buttons-clicking-perplexity.js`
- `per-website-button-clicking-mechanics/perplexity-injector.js`
- `per-website-button-clicking-mechanics/utils.js`
- `per-website-button-clicking-mechanics/ocp_toast.js`
- `per-website-button-clicking-mechanics/ocp_toast.css`

## Behavior Notes

- If editor already has text, new message is appended.
- If auto-send is off, message is pasted only.
- No queueing: messages arriving while busy are dropped.
- ChatGPT auto-send waits longer (up to ~30s) when attachments are uploading.
- **ChatGPT File Upload**: Uses "Method 2 Pickerless" approach. It detects specific hidden file inputs (e.g., `#upload-photos`) or inputs exposed by the "Attach" menu and programmatically sets `input.files` via `DataTransfer`. This bypasses the OS file picker completely.
- **Perplexity/Gemini File Upload**: Uses the "Paste" method. It creates a `ClipboardEvent` of type `'paste'` containing the files in the `dataTransfer` property and dispatches it directly to the editor. This is highly reliable for reactive frameworks where inputs might be temporary or hidden in the Shadow DOM.
- **Server Path Robustness**: The extension standardizes on using `/messages`, and the reference server (`test-server.ps1`) now gracefully ignores trailing slashes to prevent 404 errors.

## Storage Architecture (Hybrid Approach)

MV3 service workers sleep after ~30s of inactivity, losing in-memory state. The extension uses a hybrid storage approach:

- **chrome.storage.local**: Messages metadata, settings, cursor, status. Has `onChanged` listener for automatic popup sync. Limited to ~5MB.
- **IndexedDB** (`sw-idb.js`): Attachment binary data (ArrayBuffer). Unlimited storage, native blob support. Orphaned blobs are cleaned up when messages are trimmed.

**Key details:**

- `maxStoredMessages` setting (default 5) controls how many messages are kept in storage.
- When messages are trimmed, `deleteBlobsForMessage()` removes associated blobs from IndexedDB.
- `trimMessageList()` is async because it performs IndexedDB cleanup.
- `getAttachmentData()` returns bytes as `Array<number>` for chrome.tabs.sendMessage compatibility (ArrayBuffer cannot be serialized across message passing).

## Message Reliability & Retry System

- **Lossless Delivery**: Uses a cursor-based tracking system. The extension tracks the last processed message ID. On crash or restart, it resumes polling from the stored cursor, ensuring no messages are skipped.
- **Long-Polling**: Uses a persistent connection (25s hold) for near real-time delivery with significantly reduced server load compared to short intervals.
- **Bundle Prioritization (LIFO)**: The pending bundle queue (`pendingBundles`) sorts items by creation time descending. **Newest messages are processed first**. This prevents old, stuck attachments (e.g., large files on slow networks) from blocking fresh, lightweight text messages.
- **Queue Trimming**: Explicitly keeps the _newest_ 200 bundles and drops the oldest to maintain the "freshness first" strategy.
- **Attachment Retries**: Failed attachments are retried up to 2 times with a 1.5s delay. Text content is delivered immediately; only attachments wait.
- **Manual Retry**: If all automatic attempts fail (e.g. 404 error), the message status becomes 'error', and a "Retry" button appears in the floating UI.
- **Thundering Herd**: Note that _retry jitter_ (randomness) is explicitly **disabled** in the current implementation; backoff is deterministic.
