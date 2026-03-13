'use strict';

window.MaxExtensionUtils = {
  simulateClick(element) {
    const event = new MouseEvent("click", {
      view: window,
      bubbles: true,
      cancelable: true,
      buttons: 1
    });
    element.dispatchEvent(event);
    logConCgp("[utils] simulateClick: Click event dispatched.", element);
  },

  moveCursorToEnd(contentEditableElement) {
    contentEditableElement.focus();
    if (typeof window.getSelection === "undefined" || typeof document.createRange === "undefined") {
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(contentEditableElement);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  },

  isElementVisible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (!rect || rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(element);
    if (!style) return false;
    if (style.display === "none" || style.visibility === "hidden") return false;
    const opacity = Number.parseFloat(style.opacity || "1");
    if (!Number.isNaN(opacity) && opacity === 0) return false;
    return true;
  }
};

class InjectionTargetsOnWebsite {
  constructor() {
    this.activeSite = this.identifyActiveWebsite();
    this.selectors = this.getDefaultSelectors(this.activeSite);
  }

  identifyActiveWebsite() {
    const currentHostname = window.location.hostname;
    if (currentHostname.includes("chat.openai.com") || currentHostname.includes("chatgpt.com")) {
      return "ChatGPT";
    }
    if (currentHostname.includes("perplexity.ai")) {
      return "Perplexity";
    }
    if (currentHostname.includes("gemini.google.com")) {
      return "Gemini";
    }
    if (currentHostname.includes("claude.ai")) {
      return "Claude";
    }
    if (currentHostname.includes("grok.com") || currentHostname.includes("x.com/i/grok")) {
      return "Grok";
    }
    if (currentHostname.includes("aistudio.google.com")) {
      return "AIStudio";
    }
    return "Unknown";
  }

  getDefaultSelectors(site) {
    const defaults = window.AivoRelaySelectorShared?.getDefaultSiteSelectors(site);
    return defaults || {
      containers: [],
      sendButtons: [],
      editors: [],
      stopButtons: [],
      threadRoot: '',
      buttonsContainerId: ''
    };
  }
}

window.InjectionTargetsOnWebsite = new InjectionTargetsOnWebsite();
