# Finding File Input Methods in Modern AI Interfaces

This document outlines the investigation and findings regarding programmatic (pickerless) file uploads for Google Gemini, intended as a reference for future development.

## The Challenge

In modern web applications like Google Gemini, traditional `<input type="file">` elements are often:

1.  **Absent from the static DOM**: They are created dynamically upon user interaction and removed immediately after.
2.  **Shadow DOM protected**: Tucked away where simple `querySelectorAll` won't find them.
3.  **Bypassed by APIs**: Using the File System Access API or complex internal frameworks (Angular/Quill).

## Investigation Strategy for Gemini

### 1. Identifying the Editor

Gemini uses a **Quill-based editor**.

- **Selector**: `div.ql-editor` or `div[contenteditable="true"]`.
- The editor is the primary target for all input-related events.

### 2. Hunting for Hidden Inputs

A deep search (including Shadow DOM) for `input[type="file"]` returned **zero results**. This confirms the input is dynamic.

- **Trigger Buttons**: Look for buttons with unique attributes like `xapfileselectortrigger` or internal data-test-ids like `hidden-local-image-upload-button`. These are the "gatekeepers" that trigger the system file picker.

### 3. The "Pickerless" Solution: Event Simulation

Since we cannot easily hijack a dynamic input without a user gesture, the most robust method is to use **Event Injection**.

#### The Paste Method (Recommended)

Gemini's editor listens for standard clipboard events. We can simulate a user pasting an image:

```javascript
const editor = document.querySelector(".ql-editor");
const dataTransfer = new DataTransfer();
const file = new File([blob], "image.png", { type: "image/png" });
dataTransfer.items.add(file);

const pasteEvent = new ClipboardEvent("paste", {
  clipboardData: dataTransfer,
  bubbles: true,
  cancelable: true,
});

editor.dispatchEvent(pasteEvent);
```

**Why it works:**

- Bypasses the need for an `<input>` element entirely.
- Does not trigger the system file picker.
- Supports multiple files by adding more items to the `DataTransfer`.

#### The Drop Method (Alternative)

Gemini also handles `drop` events.

- Requires dispatching both `dragover` (to cancel the default behavior) and `drop`.
- In tests, `paste` proved more immediate and reliable for UI updates.

## Technical Nuances

### Image Processing Latency

Unlike text, Gemini performs server-side or heavy client-side processing of images once "attached."

- **Observation:** The "Send" button (`aria-label="Send message"`) remains `aria-disabled="true"` for several seconds after the `paste` event.
- **Implementation Note:** Any auto-send logic must poll for the `aria-disabled` state with a longer timeout (e.g., 10-30 seconds) compared to text-only messages.

### Text Insertion Structure

Because it's a Quill editor, inserting text via `innerText` can break the component.

- **Structure:** Gemini expects `<p>` tags inside the `.ql-editor`.
- **Method:** Manually updating `innerHTML` with paragraph wrappers and then dispatching `input` and `change` events is the most reliable way to ensure the site's state-management (Angular) detects the change.

---

_Created during the AivoRelay integration of Google Gemini support._
