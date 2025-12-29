# AivoRelay

A Chrome extension that bridges external applications with AI chat interfaces (ChatGPT, Perplexity). Send text and files from any local application directly into your AI conversations.

## Features

- **Text Messages**: Send text from external apps directly into ChatGPT or Perplexity
- **File Attachments**: Upload images and files programmatically (ChatGPT only)
- **Auto-Send**: Optionally auto-submit messages after pasting
- **Auto-Open Tab**: Server can specify which AI chat to open automatically
- **Connection Status**: Real-time keepalive monitoring
- **Message History**: View recent messages with binding status (Bound/Unbound indicator)

## How It Works

1. **Your Application** runs a local HTTP server (default `http://127.0.0.1:63155`)
2. **The Extension** polls your server for new messages
3. **Messages** are automatically pasted into the bound AI chat tab
4. **Status Reports** are sent back to your server (sent, dropped, errors)

## Quick Start

### 1. Install the Extension

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this folder

### 2. Run the Test Server

```powershell
./test-server.ps1
```

### 3. Bind to a Tab

1. Open ChatGPT or Perplexity in a browser tab
2. Click the extension icon
3. Click "Bind to this tab"

### 4. Send Messages

Type in the test server console, or send HTTP requests:

```bash
# Send a text message
curl -X POST http://127.0.0.1:63155/messages \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello AI!"}'
```

## Server Protocol

See [`messaging-contract.md`](messaging-contract.md) for the full HTTP protocol specification.

### Basic Endpoints

| Method | Path                       | Description               |
| ------ | -------------------------- | ------------------------- |
| GET    | `/messages?since=<cursor>` | Poll for new messages     |
| POST   | `/messages`                | Receive status reports    |
| GET    | `/blob/<attId>`            | Download attachment files |

### Response Format with Auto-Open

The server can include a `config` object to control extension behavior:

```json
{
  "cursor": 1735084000123,
  "messages": [
    {
      "id": "unique_id",
      "ts": 1735084000123,
      "type": "text",
      "text": "Hello ChatGPT!"
    }
  ],
  "config": {
    "autoOpenTabUrl": "https://chatgpt.com/"
  }
}
```

When `autoOpenTabUrl` is provided and no tab is bound, the extension automatically opens a new tab with the specified URL and binds to it.

### Message Types

For file attachments, use `type: "bundle"` with an `attachments` array.

## Test Server Shortcuts

The included PowerShell test server supports quick commands:

| Command       | Description            |
| ------------- | ---------------------- |
| `test-image`  | Send demo-image.png    |
| `test-file`   | Send demo-file.txt     |
| `test-csv`    | Send demo-data.csv     |
| `test-bundle` | Send image + text file |
| `exit`        | Stop the server        |

## Settings

Click the extension popup to configure:

- **Port**: Server port (default 63155)
- **Auto-send**: Automatically click send after pasting

## Supported Sites

- ChatGPT (chat.openai.com, chatgpt.com) - Full support with attachments
- Perplexity (perplexity.ai) - Text only

## Architecture

```
┌─────────────────┐     HTTP      ┌─────────────────┐
│  Your Server    │◄────────────►│   Extension     │
│  (port 63155)   │   polling    │  Service Worker │
└─────────────────┘               └────────┬────────┘
                                           │
                                           │ chrome.tabs.sendMessage
                                           ▼
                                  ┌─────────────────┐
                                  │  Content Script │
                                  │  (ChatGPT tab)  │
                                  └─────────────────┘
```

## Storage

Messages and settings are persisted in `chrome.storage.local`. Attachment binaries are stored in IndexedDB for unlimited storage capacity. The extension keeps the last 5 messages by default.

## License

MIT
