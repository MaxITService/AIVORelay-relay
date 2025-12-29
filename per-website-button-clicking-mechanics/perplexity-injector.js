'use strict';

(function () {
  try {
    const targetElement = document.querySelector("[data-hc-target=\"true\"]");
    if (!targetElement) return;

    const text = targetElement.getAttribute("data-hc-text") || "";
    targetElement.removeAttribute("data-hc-text");
    targetElement.removeAttribute("data-hc-target");

    if (!text) return;

    targetElement.focus();

    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(targetElement);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    let success = false;
    try {
      success = document.execCommand("insertText", false, text);
    } catch {
      success = false;
    }

    if (!success) {
      const currentVal = targetElement.textContent || "";
      targetElement.textContent = currentVal + text;
      targetElement.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text
      }));
      targetElement.dispatchEvent(new Event("change", { bubbles: true }));
    }
  } catch (e) {
    console.error("[aivo-relay] Main world insertion failed:", e);
  }
})();
