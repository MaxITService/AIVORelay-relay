'use strict';

async function processPerplexityIncomingMessage(payload, options = {}) {
  const text = typeof payload === "string" ? payload : (payload.text || "");
  const attachments = payload.attachments || [];
  const editorElement = await window.ButtonsClickingShared.findEditor();

  if (!editorElement) {
    logConCgp("[perplexity] Editor not found.");
    return { status: "editor_not_found" };
  }

  let attachmentResult = null;
  if (attachments.length) {
    attachmentResult = await attachFilesToPerplexity(editorElement, attachments);
    if (attachmentResult.status !== "attached") {
      logConCgp("[perplexity] Attachment failed:", attachmentResult.reason);
    }
  }

  const inserted = insertTextIntoPerplexityEditor(editorElement, text);
  if (!inserted && (!attachments.length || attachmentResult.status !== "attached")) {
    return { status: "insert_failed", attachments: attachmentResult };
  }

  if (!options.autoSend) {
    return { status: "pasted", attachments: attachmentResult };
  }

  // Perplexity might need a moment to process attachments
  const hasAttachments = attachmentResult?.status === "attached";
  const maxAttempts = hasAttachments ? 100 : 25;
  const interval = hasAttachments ? 300 : 200;

  const sendResult = await window.ButtonsClickingShared.performAutoSend({
    interval,
    maxAttempts,
    isEnabled: isPerplexityButtonEnabled,
    preClickValidation: () => {
      const hasContent = perplexityEditorHasContent(text, editorElement);
      return hasContent || hasAttachments;
    }
  });

  // If auto-send was blocked because AI is still typing, report as "pasted" with reason
  if (sendResult.status === "busy") {
    return { status: "pasted", reason: "stop_visible", attachments: attachmentResult };
  }

  return { ...sendResult, attachments: attachmentResult };
}

/**
 * Attaches files by simulating a Paste event.
 * Perplexity responds well to direct paste into the textarea.
 */
async function attachFilesToPerplexity(editor, attachments) {
  const files = [];
  for (const attachment of attachments) {
    try {
      const file = await buildAttachmentFile(attachment);
      if (file) files.push(file);
    } catch (err) {
      logConCgp("[perplexity] Failed to build file object:", err);
    }
  }

  if (!files.length) {
    return { status: "failed", reason: "no_valid_files" };
  }

  try {
    const dataTransfer = new DataTransfer();
    for (const file of files) {
      dataTransfer.items.add(file);
    }

    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: dataTransfer,
      bubbles: true,
      cancelable: true
    });

    editor.focus();
    editor.dispatchEvent(pasteEvent);
    logConCgp(`[perplexity] Dispatched paste event with ${files.length} files.`);
    return { status: "attached", count: files.length };
  } catch (err) {
    logConCgp("[perplexity] Paste simulation failed:", err);
    return { status: "failed", reason: "paste_error" };
  }
}

async function buildAttachmentFile(attachment) {
  const name = attachment.filename || "attachment";
  const type = attachment.mime || "image/png";

  if (attachment.bytes) {
    const blob = new Blob([attachment.bytes], { type });
    return new File([blob], name, { type });
  }

  if (attachment.blobUrl) {
    const response = await fetch(attachment.blobUrl);
    if (!response.ok) throw new Error("fetch_failed");
    const blob = await response.blob();
    return new File([blob], name, { type: blob.type || type });
  }

  return null;
}

function insertTextIntoPerplexityEditor(editorElement, textToInsert) {
  try {
    const text = String(textToInsert || "");
    if (!text) return true;

    editorElement.setAttribute("data-hc-target", "true");
    editorElement.setAttribute("data-hc-text", text);

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("per-website-button-clicking-mechanics/perplexity-injector.js");
    script.onload = () => script.remove();
    script.onerror = () => {
      logConCgp("[perplexity] Failed to load injector script.");
      script.remove();
    };
    (document.head || document.documentElement).appendChild(script);

    if (window.MaxExtensionUtils && typeof window.MaxExtensionUtils.moveCursorToEnd === "function") {
      setTimeout(() => window.MaxExtensionUtils.moveCursorToEnd(editorElement), 50);
    }

    return true;
  } catch (error) {
    logConCgp("[perplexity] Error during text insertion:", error);
    return false;
  }
}

function isPerplexityButtonEnabled(button) {
  if (!button) return false;
  const ariaDisabled = button.getAttribute("aria-disabled");
  const dataDisabled = button.getAttribute("data-disabled");
  if (button.disabled || ariaDisabled === "true" || dataDisabled === "true") {
    return false;
  }
  const styleOpacity = window.getComputedStyle(button).opacity;
  if (styleOpacity && Number(styleOpacity) < 0.2) {
    return false;
  }
  return true;
}

function perplexityEditorHasContent(expectedText, editorElement) {
  try {
    if (!editorElement) return false;
    const currentText = editorElement.innerText || editorElement.textContent || editorElement.value || "";
    const normalizedCurrent = currentText.replace(/\s+/g, "").toLowerCase();

    if (expectedText) {
      const normalizedExpected = expectedText.replace(/\s+/g, "").toLowerCase();
      const probe = normalizedExpected.slice(0, 30);
      if (probe && normalizedCurrent.includes(probe)) {
        return true;
      }
    }

    return normalizedCurrent.length > 0;
  } catch (error) {
    logConCgp("[perplexity] Error while verifying editor content:", error);
    return true;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

window.processPerplexityIncomingMessage = processPerplexityIncomingMessage;
