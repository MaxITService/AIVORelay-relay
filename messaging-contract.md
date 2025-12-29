# AivoRelay Messaging Protocol

This document defines the HTTP protocol for external applications to send messages and files to the AivoRelay browser extension.
Any HTTP server implementing this contract can control the extension.

## Overview

The extension continuously polls a local HTTP server (default `http://127.0.0.1:63155`) to retrieve new messages and command the browser.

### Base Configuration

- **Default Port**: `63155`
- **Default Path**: `/messages`
- **Protocol**: HTTP/1.1 (Keep-Alive recommended but not required)
- **Polling Interval**: ~100ms - 1s (adaptive)

### Authentication

The extension uses Bearer token authentication on all requests to prevent unauthorized access from malicious webpages.

- **Header**: `Authorization: Bearer {password}`
- **Default Password**: `fklejqwhfiu342lhk3`
- **Storage**: Password is stored in `chrome.storage.sync` (syncs across user's Chrome instances)
- **Configuration**: Users can change the password in the extension popup

**All requests** to the server (GET, POST) include this header. The server should validate the token and return `401 Unauthorized` if invalid.

---

## 1. Polling for Messages (GET)

The extension issues a `GET` request to retrieve new messages.

**Request:**

```http
GET /messages?since=<last_cursor> HTTP/1.1
Host: 127.0.0.1:63155
Authorization: Bearer fklejqwhfiu342lhk3
Cache-Control: no-store
```

**Query Parameters:**

- `since`: (Optional) The `ts` (timestamp) or `cursor` of the last received message. The server should return only messages newer than this.

**Response (JSON):**

```json
{
  "cursor": "1735084000123",
  "messages": [
    {
      "id": "msg_unique_id_1",
      "type": "text",
      "text": "Hello ChatGPT!",
      "ts": 1735084000123
    }
  ],
  "config": {
    "autoOpenTabUrl": "https://chatgpt.com"
  }
}
```

### Config Object

The `config` object provides server-controlled behavior settings.

| Field            | Type             | Description                                                     |
| :--------------- | :--------------- | :-------------------------------------------------------------- |
| `autoOpenTabUrl` | `string \| null` | URL to auto-open if no tab is bound. `null` or empty = disabled |

When `autoOpenTabUrl` is provided and the extension has no bound tab, it will:

1. Create a new browser tab with the specified URL
2. Wait for the tab to finish loading
3. Automatically bind to the new tab
4. Deliver the message to the newly created tab

### Message Objects

A **Message** object represents a command or text payload.

| Field         | Type     | Description                                        |
| :------------ | :------- | :------------------------------------------------- | ---------------------- | -------------- |
| `id`          | `string` | **Required.** Unique ID for deduplication.         |
| `ts`          | `number` | **Required.** Unix timestamp (ms). Used as cursor. |
| `text`        | `string` | The text content to insert into the AI editor.     |
| `type`        | `string` | `"text"`                                           | `"bundle"` (for files) | `"keepalive"`. |
| `attachments` | `array`  | (Optional) List of file objects (see Section 2).   |

---

## 2. Sending Files (Bundles)

To upload files, use `type: "bundle"`. The extension downloads the files from your server before acting.

**Bundle Message Example:**

```json
{
  "id": "msg_bundle_01",
  "ts": 1735084000500,
  "type": "bundle",
  "text": "Analyze this image",
  "attachments": [
    {
      "attId": "img_01",
      "kind": "image",
      "filename": "chart.png",
      "mime": "image/png",
      "size": 10240,
      "fetch": {
        "url": "http://127.0.0.1:63155/blob/img_01",
        "method": "GET",
        "headers": { "X-Token": "secret_one_time_token" },
        "expiresAt": 1735084300000
      }
    }
  ]
}
```

### Attachment Fields

- `attId`: Unique ID for the attachment.
- `kind`: `"image"` or `"file"`.
- `fetch`: Object describing how the extension should download the file (URL, headers).

**Important:** The extension **must** be able to download the file via the provided `fetch.url`. You must serve the file binary at that endpoint.

---

## 3. Server-Side File Serving (GET /blob/...)

If you send a bundle, you must implement the file download endpoint specified in your `fetch.url`.

**Request:**

```http
GET /blob/img_01 HTTP/1.1
X-Token: secret_one_time_token
```

**Response:**

- Returns the raw binary bytes of the file.
- `Content-Type`: Should match the file mime type.

---

## 4. Status Reporting (POST)

The extension reports execution status back to the server using `POST`.

**Request:**

```http
POST /messages HTTP/1.1
Authorization: Bearer fklejqwhfiu342lhk3
Content-Type: application/json

{
  "type": "status",
  "status": "sent",
  "site": "ChatGPT",
  "messageId": "msg_bundle_01",
  "text": "[hc-status] sent ChatGPT"
}
```

**Common Statuses:**

- `sent`: Successfully submitted to AI.
- `pasted`: Text inserted but not sent (e.g. auto-send off).
- `dropped_busy`: AI was busy (generating), message ignored.
- `editor_not_found`: Could not find input box.
- `bundle_failed`: Failed to download attachments from server.

---

## 5. Keepalive & Acknowledgement

The server should occasionally send a `keepalive` message to verify connection.
The extension responds with a `keepalive_ack`.

**Server sends (in GET response):**

```json
{
  "messages": [ { "type": "keepalive", "ts": 123... } ]
}
```

**Extension responds (POST):**

```json
{
  "type": "keepalive_ack",
  "ts": 123...
}
```

## Example Implementation Tips

- **Ignore Trailing Slashes**: The extension may request `/messages` or `/messages/`. Your server should handle both.
- **CORS**: Ensure your server sends `Access-Control-Allow-Origin: *` headers if you plan to support complex setups, though strictly local requests usually bypass this in extensions.
