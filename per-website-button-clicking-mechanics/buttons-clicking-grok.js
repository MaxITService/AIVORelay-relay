'use strict';

async function processGrokIncomingMessage(payload, options = {}) {
    const text = typeof payload === "string" ? payload : (payload.text || "");
    const attachments = payload.attachments || [];
    const editorElement = window.ButtonsClickingShared.findEditor();

    if (!editorElement) {
        logConCgp("[grok] Editor not found.");
        return { status: "editor_not_found" };
    }

    let attachmentResult = null;
    if (attachments.length) {
        attachmentResult = await attachFilesToGrok(attachments);
        if (attachmentResult.status !== "attached") {
            logConCgp("[grok] Attachment failed:", attachmentResult.reason);
        }
    }

    const inserted = await insertTextIntoGrokEditor(editorElement, text);
    if (!inserted && (!attachments.length || attachmentResult?.status !== "attached")) {
        return { status: "insert_failed", attachments: attachmentResult };
    }

    if (!options.autoSend) {
        return { status: "pasted", attachments: attachmentResult };
    }

    // Grok needs time to process attachments
    const hasAttachments = attachmentResult?.status === "attached";
    const maxAttempts = hasAttachments ? 100 : 25;
    const interval = hasAttachments ? 300 : 200;

    await new Promise(r => setTimeout(r, 100));

    const sendResult = await window.ButtonsClickingShared.performAutoSend({
        interval,
        maxAttempts,
        preClickValidation: () => {
            const isTextArea = editorElement.value !== undefined;
            const currentText = isTextArea ? editorElement.value.trim() : editorElement.innerText.trim();
            return currentText.length > 0 || hasAttachments;
        },
        clickAction: (btn) => window.MaxExtensionUtils.simulateClick(btn)
    });

    // If auto-send was blocked because AI is still typing, report as "pasted" with reason
    if (sendResult.status === "busy") {
        return { status: "pasted", reason: "stop_visible", attachments: attachmentResult };
    }

    return { ...sendResult, attachments: attachmentResult };
}

/**
 * Attaches files to Grok using the hidden file input.
 * Grok has a file input that accepts all file types.
 */
async function attachFilesToGrok(attachments) {
    const fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) {
        return { status: "failed", reason: "input_not_found" };
    }

    const files = [];
    for (const attachment of attachments) {
        try {
            const file = await buildGrokAttachmentFile(attachment);
            if (file) files.push(file);
        } catch (err) {
            logConCgp("[grok] Failed to build file object:", err);
        }
    }

    if (!files.length) {
        return { status: "failed", reason: "no_valid_files" };
    }

    try {
        const dataTransfer = new DataTransfer();
        const maxFiles = fileInput.multiple ? files.length : 1;
        for (let i = 0; i < maxFiles; i++) {
            dataTransfer.items.add(files[i]);
        }
        fileInput.files = dataTransfer.files;
        fileInput.dispatchEvent(new Event("input", { bubbles: true }));
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        logConCgp(`[grok] Injected ${maxFiles} file(s) into file input.`);
        return { status: "attached", count: maxFiles };
    } catch (err) {
        logConCgp("[grok] File injection failed:", err);
        return { status: "failed", reason: "inject_error" };
    }
}

async function buildGrokAttachmentFile(attachment) {
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

async function insertTextIntoGrokEditor(editorElement, textToInsert) {
    try {
        const text = String(textToInsert || "");
        if (!text) return true;

        const isTextArea = editorElement.value !== undefined;

        editorElement.focus();

        if (isTextArea) {
            editorElement.value = editorElement.value + text;
            editorElement.dispatchEvent(new Event("input", { bubbles: true }));
            editorElement.dispatchEvent(new Event("change", { bubbles: true }));
            editorElement.setSelectionRange(editorElement.value.length, editorElement.value.length);
        } else {
            editorElement.innerText = editorElement.innerText + text;
            editorElement.dispatchEvent(new Event("input", { bubbles: true }));
            if (window.MaxExtensionUtils?.moveCursorToEnd) {
                window.MaxExtensionUtils.moveCursorToEnd(editorElement);
            }
        }

        // Simulate keystroke for auto-resize
        await simulateGrokLastKeystroke(editorElement, text.slice(-1), isTextArea);

        return true;
    } catch (error) {
        logConCgp("[grok] Error during text insertion:", error);
        return false;
    }
}

async function simulateGrokLastKeystroke(editorElement, char, isTextArea) {
    const eventTypes = ["keydown", "input", "keyup"];
    for (const type of eventTypes) {
        let evt;
        if (type === "input") {
            evt = new InputEvent(type, {
                data: char,
                inputType: "insertText",
                bubbles: true,
                cancelable: true
            });
        } else {
            evt = new KeyboardEvent(type, {
                key: char,
                code: `Key${char.toUpperCase()}`,
                bubbles: true,
                cancelable: true
            });
        }
        editorElement.dispatchEvent(evt);
    }
    await new Promise(r => setTimeout(r, 50));
}

window.processGrokIncomingMessage = processGrokIncomingMessage;

