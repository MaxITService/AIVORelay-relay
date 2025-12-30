'use strict';

async function processClaudeIncomingMessage(payload, options = {}) {
    const text = typeof payload === "string" ? payload : (payload.text || "");
    const attachments = payload.attachments || [];
    const editorElement = window.ButtonsClickingShared.findEditor();

    if (!editorElement) {
        logConCgp("[claude] Editor not found.");
        return { status: "editor_not_found" };
    }

    let attachmentResult = null;
    if (attachments.length) {
        attachmentResult = await attachFilesToClaude(attachments);
        if (attachmentResult.status !== "attached") {
            logConCgp("[claude] Attachment failed:", attachmentResult.reason);
        }
    }

    const inserted = insertTextIntoClaudeEditor(editorElement, text);
    if (!inserted && (!attachments.length || attachmentResult?.status !== "attached")) {
        return { status: "insert_failed", attachments: attachmentResult };
    }

    if (!options.autoSend) {
        return { status: "pasted", attachments: attachmentResult };
    }

    // Claude needs time to process attachments
    const hasAttachments = attachmentResult?.status === "attached";
    const maxAttempts = hasAttachments ? 100 : 25;
    const interval = hasAttachments ? 300 : 200;

    const sendResult = await window.ButtonsClickingShared.performAutoSend({
        interval,
        maxAttempts,
        clickAction: (btn) => setTimeout(() => window.MaxExtensionUtils.simulateClick(btn), 200)
    });

    // If auto-send was blocked because AI is still typing, report as "pasted" with reason
    if (sendResult.status === "busy") {
        return { status: "pasted", reason: "stop_visible", attachments: attachmentResult };
    }

    return { ...sendResult, attachments: attachmentResult };
}

/**
 * Attaches files to Claude using the hidden file input.
 * Claude accepts images and many document types.
 */
async function attachFilesToClaude(attachments) {
    const fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) {
        return { status: "failed", reason: "input_not_found" };
    }

    const files = [];
    for (const attachment of attachments) {
        try {
            const file = await buildClaudeAttachmentFile(attachment);
            if (file) files.push(file);
        } catch (err) {
            logConCgp("[claude] Failed to build file object:", err);
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
        logConCgp(`[claude] Injected ${maxFiles} file(s) into file input.`);
        return { status: "attached", count: maxFiles };
    } catch (err) {
        logConCgp("[claude] File injection failed:", err);
        return { status: "failed", reason: "inject_error" };
    }
}

async function buildClaudeAttachmentFile(attachment) {
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

function insertTextIntoClaudeEditor(editorElement, textToInsert) {
    try {
        const text = String(textToInsert || "");
        if (!text) return true;

        editorElement.focus();

        // Check if it's a ProseMirror editor
        const isProseMirror = editorElement.classList.contains("ProseMirror");
        const paragraph = editorElement.querySelector("p");
        const isEmpty = !paragraph || paragraph.classList.contains("is-empty") ||
            paragraph.classList.contains("is-editor-empty") ||
            editorElement.textContent.trim() === "";

        if (isProseMirror) {
            if (isEmpty) {
                editorElement.innerHTML = "<p><br></p>";
            }

            // Set cursor at end
            const selection = window.getSelection();
            selection.removeAllRanges();
            const range = document.createRange();

            const paragraphs = editorElement.querySelectorAll("p");
            const lastParagraph = paragraphs.length > 0 ? paragraphs[paragraphs.length - 1] : editorElement;
            range.selectNodeContents(lastParagraph);
            range.collapse(false);
            selection.addRange(range);

            // Use execCommand for ProseMirror compatibility
            let inserted = false;
            try {
                inserted = document.execCommand("insertText", false, text);
            } catch {
                inserted = false;
            }

            if (!inserted) {
                const textNode = document.createTextNode(text);
                lastParagraph.appendChild(textNode);
            }

            editorElement.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
            // Standard contenteditable
            const targetElement = paragraph || editorElement;
            if (isEmpty) {
                targetElement.innerHTML = "";
            }
            const textNode = document.createTextNode(text);
            targetElement.appendChild(textNode);
            editorElement.dispatchEvent(new Event("input", { bubbles: true }));
        }

        if (window.MaxExtensionUtils?.moveCursorToEnd) {
            window.MaxExtensionUtils.moveCursorToEnd(editorElement);
        }

        return true;
    } catch (error) {
        logConCgp("[claude] Error during text insertion:", error);
        return false;
    }
}

window.processClaudeIncomingMessage = processClaudeIncomingMessage;

