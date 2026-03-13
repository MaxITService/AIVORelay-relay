'use strict';

window.ButtonsClickingShared = {
  async findEditor() {
    if (window.AivoRelaySelectorManager?.findEditor) {
      return await window.AivoRelaySelectorManager.findEditor();
    }
    return findFirstVisible(getSelectors("editors"));
  },

  async findSendButton() {
    if (window.AivoRelaySelectorManager?.findSendButton) {
      return await window.AivoRelaySelectorManager.findSendButton();
    }
    return findFirstVisible(getSelectors("sendButtons"));
  },

  async findStopButton() {
    if (window.AivoRelaySelectorManager?.shouldIgnoreStopButton?.()) {
      return null;
    }
    const selectorHit = window.AivoRelaySelectorManager?.findStopButton
      ? await window.AivoRelaySelectorManager.findStopButton()
      : findFirstVisible(getSelectors("stopButtons"), { requireEnabled: true });
    if (selectorHit) return selectorHit;
    return findStopByText();
  },

  async performAutoSend(options = {}) {
    const {
      isEnabled = defaultIsEnabled,
      preClickValidation = () => true,
      clickAction = (btn) => window.MaxExtensionUtils.simulateClick(btn),
      interval = 150,
      maxAttempts = 20
    } = options;

    let sawButton = false;
    let sawDisabled = false;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const stopButton = await this.findStopButton();
      if (stopButton) {
        if (window.AivoRelayStopButtonDebug?.inspect) {
          window.AivoRelayStopButtonDebug.inspect().then((entries) => {
            logConCgp('[buttons] Auto-send blocked by stop button diagnostics:', entries);
          }).catch(() => {});
        }
        return { status: "busy", button: stopButton };
      }

      const sendButton = await this.findSendButton();
      if (sendButton) {
        sawButton = true;
        if (!isEnabled(sendButton)) {
          sawDisabled = true;
        } else if (preClickValidation(sendButton)) {
          clickAction(sendButton);
          return { status: "sent", button: sendButton };
        }
      }

      await sleep(interval);
    }

    if (sawButton && sawDisabled) {
      return { status: "send_not_found", reason: "disabled" };
    }
    if (sawButton) {
      return { status: "send_not_found", reason: "validation_failed" };
    }
    return { status: "send_not_found", reason: "missing" };
  }
};

function getSelectors(key) {
  const selectors = window.InjectionTargetsOnWebsite?.selectors?.[key];
  return Array.isArray(selectors) ? selectors : [];
}

function findFirstVisible(selectors, options = {}) {
  const requireEnabled = options?.requireEnabled === true;
  for (const selector of selectors) {
    if (!selector) continue;
    let nodes = [];
    try {
      nodes = document.querySelectorAll(selector);
    } catch (err) {
      logConCgp("[buttons] Invalid selector skipped:", selector, err?.message || err);
      continue;
    }
    for (const node of nodes) {
      if (!window.MaxExtensionUtils.isElementVisible(node)) {
        continue;
      }
      if (requireEnabled && !defaultIsEnabled(node)) {
        continue;
      }
      if (!requireEnabled || !looksLikeStopAction(node, selector)) {
        if (!requireEnabled) {
          return node;
        }
      } else {
        return node;
      }
    }
  }
  return null;
}

function findStopByText() {
  const candidates = document.querySelectorAll("button, [role=\"button\"]");
  for (const node of candidates) {
    if (!window.MaxExtensionUtils.isElementVisible(node)) continue;
    if (!defaultIsEnabled(node)) continue;
    const text = [
      node.getAttribute("aria-label"),
      node.getAttribute("title"),
      node.getAttribute("data-testid"),
      node.innerText
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (looksLikeStopAction(node) && text.includes("stop")) return node;
  }
  return null;
}

function looksLikeStopAction(node, selector = "") {
  const text = [
    node?.getAttribute?.("aria-label"),
    node?.getAttribute?.("title"),
    node?.getAttribute?.("data-testid"),
    node?.innerText,
    node?.textContent
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const selectorText = String(selector || "").toLowerCase();
  const hasStopSignal = ["stop", "cancel", "abort", "pause", "interrupt"].some((keyword) =>
    text.includes(keyword) || selectorText.includes(keyword)
  );
  const hasSendSignal = ["send", "submit", "reply", "ask", "run", "upload", "attach", "voice", "mic"].some((keyword) =>
    text.includes(keyword)
  );
  return hasStopSignal && !hasSendSignal;
}

function defaultIsEnabled(button) {
  if (!button) return false;
  if (button.disabled) return false;
  const ariaDisabled = button.getAttribute("aria-disabled");
  return ariaDisabled !== "true";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
