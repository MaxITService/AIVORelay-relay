'use strict';

async function processAIStudioIncomingMessage(payload, options = {}) {
    const text = typeof payload === "string" ? payload : (payload.text || "");
    const attachments = payload.attachments || [];
    const editorElement = await window.ButtonsClickingShared.findEditor();

    if (!editorElement) {
        logConCgp("[aistudio] Editor not found.");
        return { status: "editor_not_found" };
    }

    let attachmentResult = null;
    if (attachments.length) {
        attachmentResult = await attachFilesToAIStudio(editorElement, attachments);
        if (attachmentResult.status !== "attached") {
            logConCgp("[aistudio] Attachment failed:", attachmentResult.reason);
        }
    }

    const inserted = insertTextIntoAIStudioEditor(editorElement, text);
    if (!inserted && (!attachments.length || attachmentResult?.status !== "attached")) {
        return { status: "insert_failed", attachments: attachmentResult };
    }

    if (!options.autoSend) {
        return { status: "pasted", attachments: attachmentResult };
    }

    // AI Studio needs time to process attachments
    const hasAttachments = attachmentResult?.status === "attached";
    const maxAttempts = hasAttachments ? 100 : 10;
    const interval = hasAttachments ? 300 : 200;

    await new Promise(r => setTimeout(r, 100));

    const sendResult = await window.ButtonsClickingShared.performAutoSend({
        interval,
        maxAttempts,
        clickAction: (btn) => window.MaxExtensionUtils.simulateClick(btn)
    });

    // If auto-send was blocked because AI is still typing, report as "pasted" with reason
    if (sendResult.status === "busy") {
        return { status: "pasted", reason: "stop_visible", attachments: attachmentResult };
    }

    return { ...sendResult, attachments: attachmentResult };
}

/**
 * Attaches files to AI Studio by simulating a Paste event.
 * AI Studio has no file input but responds to paste events on the textarea.
 */
async function attachFilesToAIStudio(editor, attachments) {
    const files = [];
    for (const attachment of attachments) {
        try {
            const file = await buildAIStudioAttachmentFile(attachment);
            if (file) files.push(file);
        } catch (err) {
            logConCgp("[aistudio] Failed to build file object:", err);
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
        logConCgp(`[aistudio] Dispatched paste event with ${files.length} files.`);
        return { status: "attached", count: files.length };
    } catch (err) {
        logConCgp("[aistudio] Paste simulation failed:", err);
        return { status: "failed", reason: "paste_error" };
    }
}

async function buildAIStudioAttachmentFile(attachment) {
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

function insertTextIntoAIStudioEditor(editorElement, textToInsert) {
    try {
        const text = String(textToInsert || "");
        if (!text) return true;

        // AI Studio uses a textarea
        editorElement.value = editorElement.value + text;

        // Dispatch events for Angular binding
        const events = ["input", "change"];
        events.forEach(eventType => {
            const event = new Event(eventType, { bubbles: true });
            editorElement.dispatchEvent(event);
        });

        // Move cursor to end
        editorElement.setSelectionRange(editorElement.value.length, editorElement.value.length);

        return true;
    } catch (error) {
        logConCgp("[aistudio] Error during text insertion:", error);
        return false;
    }
}

window.processAIStudioIncomingMessage = processAIStudioIncomingMessage;

