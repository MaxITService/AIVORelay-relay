'use strict';

async function processChatGPTIncomingMessage(customMessage, options = {}) {
  const payload = normalizeChatGPTPayload(customMessage);
  const text = payload.text;
  const attachments = payload.attachments;
  const editorArea = window.ButtonsClickingShared.findEditor();

  if (!editorArea) {
    logConCgp("[chatgpt] Editor not found.");
    return { status: "editor_not_found" };
  }

  let attachmentResult = null;
  if (attachments.length) {
    attachmentResult = await attachFilesToChatGPT(editorArea, attachments);
    if (attachmentResult.status !== "attached") {
      return { status: "insert_failed", reason: "attachment_failed", attachments: attachmentResult };
    }
  }

  const replace = isEditorEmpty(editorArea);
  const inserted = insertTextIntoChatGPTEditor(editorArea, text, replace);
  if (!inserted) {
    return { status: "insert_failed", attachments: attachmentResult };
  }

  if (!options.autoSend) {
    return { status: "pasted", attachments: attachmentResult };
  }

  const hasAttachments = attachmentResult?.status === "attached";
  const maxAttempts = hasAttachments ? 120 : 20;
  const interval = hasAttachments ? 250 : 150;

  const sendResult = await window.ButtonsClickingShared.performAutoSend({
    preClickValidation: () => editorHasContent(editorArea) || hasAttachments,
    clickAction: (btn) => window.MaxExtensionUtils.simulateClick(btn),
    maxAttempts,
    interval
  });

  // If auto-send was blocked because AI is still typing, report as "pasted" with reason
  if (sendResult.status === "busy") {
    return { status: "pasted", reason: "stop_visible", attachments: attachmentResult };
  }

  return { ...sendResult, attachments: attachmentResult };
}

function normalizeChatGPTPayload(customMessage) {
  if (customMessage && typeof customMessage === "object") {
    const text =
      customMessage.text ??
      customMessage.message ??
      customMessage.body ??
      customMessage.content ??
      "";
    const attachments = normalizeAttachmentList(customMessage.attachments);
    return { text: text == null ? "" : String(text), attachments };
  }
  return { text: customMessage == null ? "" : String(customMessage), attachments: [] };
}

function normalizeAttachmentList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => normalizeAttachment(item)).filter(Boolean);
}

function normalizeAttachment(item) {
  if (!item || typeof item !== "object") return null;
  const bytes = extractAttachmentBytes(item.bytes);
  const blobUrl = typeof item.blobUrl === "string" ? item.blobUrl : null;
  if (!bytes && !blobUrl) return null;

  return {
    attId: item.attId != null ? String(item.attId) : "",
    filename: typeof item.filename === "string" ? item.filename : "attachment",
    mime: typeof item.mime === "string" ? item.mime : "",
    size: Number.isFinite(Number(item.size)) ? Number(item.size) : null,
    kind: item.kind === "image" ? "image" : "file",
    bytes,
    blobUrl
  };
}

function extractAttachmentBytes(bytes) {
  if (!bytes) return null;
  if (bytes instanceof ArrayBuffer) return bytes;
  if (ArrayBuffer.isView(bytes)) return bytes.buffer;
  if (Array.isArray(bytes)) return new Uint8Array(bytes).buffer;
  return null;
}

async function attachFilesToChatGPT(editorArea, attachments) {
  const files = [];
  for (const attachment of attachments) {
    try {
      const file = await buildAttachmentFile(attachment);
      if (file) files.push(file);
    } catch (err) {
      return { status: "failed", reason: err?.message || "file_unavailable" };
    }
  }

  if (!files.length) {
    return { status: "failed", reason: "no_files" };
  }

  const input = await findChatGPTFileInput(editorArea, attachments);
  if (!input) {
    return { status: "failed", reason: "input_not_found" };
  }

  if (!input.multiple && files.length > 1) {
    return { status: "failed", reason: "multiple_not_supported" };
  }

  try {
    const dataTransfer = new DataTransfer();
    const maxFiles = input.multiple ? files.length : 1;
    for (let i = 0; i < maxFiles; i += 1) {
      dataTransfer.items.add(files[i]);
    }
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (err) {
    return { status: "failed", reason: err?.message || "attach_failed" };
  }

  return { status: "attached", count: files.length };
}

async function buildAttachmentFile(attachment) {
  const name = attachment.filename || "attachment";
  const type = attachment.mime || guessMimeType(name);

  if (attachment.bytes) {
    const blob = new Blob([attachment.bytes], { type });
    return new File([blob], name, { type: blob.type || type });
  }

  if (attachment.blobUrl) {
    const response = await fetch(attachment.blobUrl);
    if (!response.ok) {
      throw new Error(`fetch_failed_${response.status}`);
    }
    const blob = await response.blob();
    return new File([blob], name, { type: blob.type || type });
  }

  throw new Error("unsupported_attachment");
}

function guessMimeType(filename) {
  const extension = (filename.split(".").pop() || "").toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  if (extension === "svg") return "image/svg+xml";
  if (extension === "txt") return "text/plain";
  if (extension === "csv") return "text/csv";
  return "application/octet-stream";
}

async function findChatGPTFileInput(editorArea, attachments) {
  // Method 2 (Pickerless): Prioritize finding existing hidden inputs
  const knownIds = ["upload-photos", "upload-camera", "file-input"];
  for (const id of knownIds) {
    const input = document.getElementById(id);
    if (input && !input.disabled && inputAcceptsAttachments(input, attachments)) {
      return input;
    }
  }

  // Search common roots for any suitable existing input
  const roots = [document];
  if (editorArea) {
    const form = editorArea.closest("form");
    if (form) roots.unshift(form);
  }

  for (const root of roots) {
    const input = selectFileInput(root, attachments);
    if (input) return input;
  }

  // If no input found, try opening the "Attach" menu to reveal lazy-mounted inputs
  const attachButton = findChatGPTAttachButton();
  if (attachButton) {
    if (!document.querySelector('div[role="menu"], div[role="dialog"]')) {
      window.MaxExtensionUtils.simulateClick(attachButton);
      await new Promise((r) => setTimeout(r, 300));
    }

    // Look for specific menu items ("Images", "Documents")
    const menuItems = findAttachMenuItems();
    const targetItem = determineBestMenuItem(menuItems, attachments);

    if (targetItem) {
      // Check if the menu item itself wraps the input
      const hiddenInput = targetItem.node.querySelector('input[type="file"]');
      if (hiddenInput && !hiddenInput.disabled) {
        return hiddenInput;
      }
      // Or if checking it again globally works
      const inputAfterMenu = await waitForFileInput(roots, attachments, 2);
      if (inputAfterMenu) return inputAfterMenu;
    }

    // Fallback wait
    return await waitForFileInput(roots, attachments);
  }

  return null;
}

function findAttachMenuItems() {
  const items = Array.from(
    document.querySelectorAll('div[role="menuitem"], button[role="menuitem"], li[role="menuitem"]')
  );
  return items.map((node) => ({
    node,
    text: (node.textContent || "").trim().toLowerCase()
  }));
}

function inputAcceptsAttachments(input, attachments) {
  return attachments.every((att) => inputAcceptsAttachment(input, att));
}

function determineBestMenuItem(items, attachments) {
  const isAllImages = attachments.every((a) => a.kind === "image");

  if (isAllImages) {
    const imgItem = items.find((i) => i.text.includes("image") || i.text.includes("photo"));
    if (imgItem) return imgItem;
  }

  const docItem = items.find((i) => i.text.includes("document") || i.text.includes("file"));
  if (docItem) return docItem;

  return null;
}

function selectFileInput(root, attachments) {
  const inputs = Array.from(root.querySelectorAll('input[type="file"]'));
  const enabled = inputs.filter((input) => input.isConnected && !input.disabled);
  if (!enabled.length) return null;

  const acceptsAll = enabled.filter((input) =>
    attachments.every((att) => inputAcceptsAttachment(input, att))
  );
  if (acceptsAll.length) return acceptsAll[0];

  const imagesOnly = attachments.every((att) => att.kind === "image");
  if (imagesOnly) {
    const imageInputs = enabled.filter(isImageFileInput);
    if (imageInputs.length) return imageInputs[0];
  }

  return enabled[0];
}

function inputAcceptsAttachment(input, attachment) {
  const accept = (input.getAttribute("accept") || "").toLowerCase();
  if (!accept) return true;
  const tokens = accept.split(",").map((item) => item.trim()).filter(Boolean);
  if (!tokens.length) return true;

  const filename = (attachment.filename || "").toLowerCase();
  const extension = filename.includes(".") ? `.${filename.split(".").pop()}` : "";
  const mime = (attachment.mime || "").toLowerCase();

  return tokens.some((token) => {
    if (token === "*/*") return true;
    if (token.endsWith("/*") && mime && mime.startsWith(token.replace("/*", "/"))) return true;
    if (mime && token === mime) return true;
    if (extension && token.startsWith(".") && token === extension) return true;
    if (token === "image/*" && attachment.kind === "image") return true;
    return false;
  });
}

function isImageFileInput(input) {
  const accept = (input.getAttribute("accept") || "").toLowerCase();
  if (!accept) return false;
  return (
    accept.includes("image") ||
    accept.includes(".png") ||
    accept.includes(".jpg") ||
    accept.includes(".jpeg") ||
    accept.includes(".webp") ||
    accept.includes(".gif")
  );
}

function findChatGPTAttachButton() {
  const candidates = document.querySelectorAll('button, [role="button"]');
  for (const node of candidates) {
    if (!window.MaxExtensionUtils.isElementVisible(node)) continue;
    const label = [
      node.getAttribute("aria-label"),
      node.getAttribute("title"),
      node.textContent
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (
      label.includes("add photos") ||
      label.includes("add files") ||
      label.includes("attach") ||
      label.includes("upload")
    ) {
      return node;
    }
  }
  return null;
}

async function waitForFileInput(roots, attachments, maxAttempts = 8) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const root of roots) {
      const input = selectFileInput(root, attachments);
      if (input) return input;
    }
  }
  return null;
}

function isEditorEmpty(editorElement) {
  if (editorElement instanceof HTMLTextAreaElement) {
    return editorElement.value.trim() === "";
  }

  if (editorElement.isContentEditable || editorElement.getAttribute("contenteditable") === "true") {
    const text = (editorElement.textContent || "").trim();
    const hasPlaceholder = Boolean(editorElement.querySelector("p.placeholder"));
    return text.length === 0 || hasPlaceholder;
  }

  const fallbackText = editorElement.textContent || "";
  return fallbackText.trim() === "";
}

function editorHasContent(editorElement) {
  if (!editorElement) return false;
  if (editorElement instanceof HTMLTextAreaElement) {
    return editorElement.value.trim().length > 0;
  }
  return (editorElement.innerText || editorElement.textContent || "").trim().length > 0;
}

function insertTextIntoChatGPTEditor(editorElement, textToInsert, replace = false) {
  try {
    if (!textToInsert) return true;

    if (editorElement instanceof HTMLTextAreaElement) {
      const existing = replace ? "" : (editorElement.value || "");
      editorElement.focus();
      editorElement.value = existing + textToInsert;
      editorElement.dispatchEvent(new Event("input", { bubbles: true }));
      editorElement.dispatchEvent(new Event("change", { bubbles: true }));
      if (editorElement.setSelectionRange) {
        const end = editorElement.value.length;
        editorElement.setSelectionRange(end, end);
      }
      return true;
    }

    if (editorElement.isContentEditable || editorElement.getAttribute("contenteditable") === "true") {
      editorElement.focus();

      const looksEmpty = (editorElement.textContent || "").trim() === "" || editorElement.querySelector("p.placeholder");
      if (replace && looksEmpty) {
        editorElement.innerHTML = "<p><br></p>";
      }

      if (window.MaxExtensionUtils && typeof window.MaxExtensionUtils.moveCursorToEnd === "function") {
        window.MaxExtensionUtils.moveCursorToEnd(editorElement);
      } else {
        const range = document.createRange();
        range.selectNodeContents(editorElement);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }

      let inserted = false;
      try {
        inserted = document.execCommand("insertText", false, textToInsert);
      } catch {
        inserted = false;
      }

      if (!inserted) {
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          const textNode = document.createTextNode(textToInsert);
          range.insertNode(textNode);
          range.setStartAfter(textNode);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
        } else {
          editorElement.appendChild(document.createTextNode(textToInsert));
        }
      }

      editorElement.dispatchEvent(new Event("input", { bubbles: true }));
      if (window.MaxExtensionUtils && typeof window.MaxExtensionUtils.moveCursorToEnd === "function") {
        window.MaxExtensionUtils.moveCursorToEnd(editorElement);
      }
      return true;
    }

    const base = replace ? "" : (editorElement.textContent || "");
    editorElement.textContent = base + textToInsert;
    editorElement.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  } catch (err) {
    logConCgp("[chatgpt] insertText failed:", err);
    return false;
  }
}

window.processChatGPTIncomingMessage = processChatGPTIncomingMessage;
