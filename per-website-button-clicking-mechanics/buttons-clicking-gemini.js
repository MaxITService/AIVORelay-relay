'use strict';

/**
 * Processes incoming messages for Google Gemini.
 * Supports both text and image attachments.
 */
async function processGeminiIncomingMessage(payload, options = {}) {
    const text = payload.text;
    const attachments = payload.attachments || [];
    const editorArea = window.ButtonsClickingShared.findEditor();

    if (!editorArea) {
        logConCgp("[gemini] Editor not found.");
        return { status: "editor_not_found" };
    }

    let attachmentResult = null;
    if (attachments.length) {
        attachmentResult = await attachFilesToGemini(editorArea, attachments);
        if (attachmentResult.status !== "attached") {
            // If critical failure, we stop. Note: Gemini is picky about types.
            logConCgp("[gemini] Attachment failed:", attachmentResult.reason);
        }
    }

    // Text insertion logic for Gemini (Quill-based)
    const inserted = insertTextIntoGeminiEditor(editorArea, text);
    if (!inserted && !attachments.length) {
        return { status: "insert_failed", attachments: attachmentResult };
    }

    if (!options.autoSend) {
        return { status: "pasted", attachments: attachmentResult };
    }

    // Gemini needs more time to process images before the send button enables.
    const hasAttachments = attachmentResult?.status === "attached";
    const maxAttempts = hasAttachments ? 100 : 20;
    const interval = hasAttachments ? 300 : 150;

    // Gemini specific auto-send
    const sendResult = await window.ButtonsClickingShared.performAutoSend({
        preClickValidation: (sendBtn) => {
            // Gemini disables the button via aria-disabled while processing or if empty
            return sendBtn && sendBtn.getAttribute('aria-disabled') !== 'true';
        },
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

/**
 * Attaches files by simulating a Paste event.
 * This avoids the file picker.
 */
async function attachFilesToGemini(editor, attachments) {
    const files = [];
    for (const attachment of attachments) {
        try {
            const file = await buildAttachmentFile(attachment);
            if (file) files.push(file);
        } catch (err) {
            logConCgp("[gemini] Failed to build file object:", err);
        }
    }

    if (!files.length) {
        return { status: "failed", reason: "no_valid_files" };
    }

    try {
        // We dispatch a paste event for the collection of files
        // Gemini handles DataTransfer in the paste event listener
        const dataTransfer = new DataTransfer();
        for (const file of files) {
            dataTransfer.items.add(file);
        }

        const pasteEvent = new ClipboardEvent('paste', {
            clipboardData: dataTransfer,
            bubbles: true,
            cancelable: true
        });

        editor.dispatchEvent(pasteEvent);
        logConCgp(`[gemini] Dispatched paste event with ${files.length} files.`);
        return { status: "attached", count: files.length };
    } catch (err) {
        logConCgp("[gemini] Paste simulation failed:", err);
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

function insertTextIntoGeminiEditor(editor, text) {
    if (!text) return true;
    try {
        editor.focus();

        // Clear existing placeholder/content if editor is effectively empty
        const isInitial = editor.classList.contains('ql-blank') || editor.innerHTML === '<p><br></p>';
        const currentText = isInitial ? '' : editor.innerText.trim();
        const newText = currentText ? `${currentText}\n${text}` : text;

        // Set innerHTML - Gemini (Quill) expects paragraphs
        editor.innerHTML = `<p>${newText.replace(/\n/g, '</p><p>')}</p>`;

        // Dispatch events to notify the framework
        editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));

        // Move cursor to the end
        window.MaxExtensionUtils.moveCursorToEnd(editor);
        return true;
    } catch (err) {
        logConCgp("[gemini] insertText failed:", err);
        return false;
    }
}

window.processGeminiIncomingMessage = processGeminiIncomingMessage;
