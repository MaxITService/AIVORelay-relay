'use strict';

(() => {
  const DEFAULT_SITE_SELECTORS = Object.freeze({
    ChatGPT: Object.freeze({
      containers: Object.freeze([
        'form[data-type="unified-composer"] .\\[grid-area\\:footer\\]',
        'form[data-type="unified-composer"] > div.rounded-\\[28px\\]',
        'form[data-type="unified-composer"] > div:has(#prompt-textarea)',
        'form[data-type="unified-composer"]',
        'main.flex.flex-col.items-center'
      ]),
      sendButtons: Object.freeze([
        'button[aria-label="Send message"]',
        'button[data-testid="send-button"]',
        'button[type="submit"]',
        'button.send-button-class'
      ]),
      editors: Object.freeze([
        'div.ProseMirror#prompt-textarea[contenteditable="true"]',
        'div.ProseMirror[contenteditable="true"]',
        'div[contenteditable="true"].ProseMirror',
        'div.ProseMirror',
        'textarea'
      ]),
      threadRoot: '#thread',
      buttonsContainerId: 'chatgpt-custom-buttons-container',
      stopButtons: Object.freeze([
        'button[data-testid="stop-button"]',
        'button[aria-label="Stop generating"]'
      ])
    }),
    Perplexity: Object.freeze({
      containers: Object.freeze([
        'div.bg-raised.w-full.outline-none',
        'div.bg-raised…grid grid-cols-3',
        'div:has(#ask-input)[class*="grid"]',
        'div:has(#ask-input)[class*="composer"]'
      ]),
      sendButtons: Object.freeze([
        'button[data-testid="submit-button"][aria-label="Submit"]',
        'button[data-testid="submit-button"]',
        'button[type="button"][aria-label="Submit"]',
        'button[aria-label="Submit"]'
      ]),
      editors: Object.freeze([
        'div#ask-input[contenteditable="true"]',
        'div[contenteditable="true"][data-lexical-editor="true"]',
        'div[contenteditable="true"]'
      ]),
      threadRoot: 'div.relative.border-subtlest.ring-subtlest.divide-subtlest.bg-base',
      buttonsContainerId: 'perplexity-custom-buttons-container',
      stopButtons: Object.freeze([
        'button[aria-label="Stop"]',
        'button[data-testid="stop-button"]'
      ])
    }),
    Gemini: Object.freeze({
      containers: Object.freeze([
        'chat-window input-container',
        'input-container',
        'main'
      ]),
      sendButtons: Object.freeze([
        'button.send-button[aria-label="Send message"]',
        'button[aria-label="Send message"][aria-disabled="false"]'
      ]),
      editors: Object.freeze([
        'div.ql-editor[contenteditable="true"]',
        'rich-textarea div.ql-editor'
      ]),
      threadRoot: 'infinite-scroller[data-test-id="chat-history-container"]',
      buttonsContainerId: 'gemini-custom-buttons-container',
      stopButtons: Object.freeze([
        'button[aria-label="Stop response"]',
        'button[aria-label="Stop generating"]'
      ])
    }),
    Claude: Object.freeze({
      containers: Object.freeze([
        'div.flex.flex-col.bg-bg-000.rounded-2xl',
        'div.flex.flex-col.bg-bg-000.gap-1\\.5'
      ]),
      sendButtons: Object.freeze([
        'button[aria-label="Send message"][class*="Button_claude"]',
        'button[aria-label="Send message"].font-base-bold',
        'button[aria-label="Send message"][type="button"]',
        'button.bg-accent-main-000.text-oncolor-100',
        'button[type="button"].bg-accent-main-000',
        'button[type="button"][aria-label="Send message"]'
      ]),
      editors: Object.freeze([
        'div.ProseMirror[contenteditable="true"]'
      ]),
      threadRoot: 'div.flex-1.max-w-3xl.mx-auto:has([data-testid="user-message"])',
      buttonsContainerId: 'claude-custom-buttons-container',
      stopButtons: Object.freeze([
        'button[aria-label="Stop response"]',
        'button[aria-label*="stop response" i]',
        'button[type="button"][aria-label*="stop" i]'
      ])
    }),
    Grok: Object.freeze({
      containers: Object.freeze([
        'form.bottom-0.w-full.text-base.flex.flex-col.gap-2.items-center.justify-center.relative.z-10',
        'form.w-full.flex-col.items-center.justify-center',
        'form[method][class*="gap-2"][class*="flex-col"]'
      ]),
      sendButtons: Object.freeze([
        'button[type="submit"][aria-label="Submit"]:not([disabled])',
        'button[type="submit"][aria-label="Submit"]',
        'form.bottom-0.w-full.text-base.flex.flex-col.gap-2.items-center.justify-center.relative.z-10 button[type="submit"]',
        'form button[type="submit"].group',
        'form button[type="submit"]'
      ]),
      editors: Object.freeze([
        'div.tiptap.ProseMirror[contenteditable="true"]',
        'div.ProseMirror[contenteditable="true"]',
        'div[contenteditable="true"][translate="no"]',
        'textarea[aria-label="Ask Grok anything"]',
        'textarea.w-full.text-fg-primary[aria-label="Ask Grok anything"]',
        'textarea.w-full.text-fg-primary.px-2.leading-7',
        'textarea[dir="auto"][aria-label="Ask Grok anything"]',
        'form.chat-form textarea[aria-label="Ask Grok anything"]',
        'textarea.w-full.text-fg-primary.bg-transparent.focus\\:outline-none',
        'textarea.w-full.text-fg-primary',
        'div[contenteditable="true"]',
        'textarea'
      ]),
      threadRoot: '.w-full.h-full.overflow-y-auto.overflow-x-hidden.scrollbar-gutter-stable.flex.flex-col.items-center.px-gutter',
      buttonsContainerId: 'grok-custom-buttons-container',
      stopButtons: Object.freeze([
        'button[aria-label="Stop model response"]',
        'button:has(svg path[d^="M4 9.2"])'
      ])
    }),
    AIStudio: Object.freeze({
      containers: Object.freeze([
        'div.prompt-input-wrapper',
        'div.prompt-input-wrapper-container',
        'section.text-and-attachments-wrapper',
        'section.chunk-editor-main',
        'footer',
        'ms-chunk-editor-menu',
        'body > app-root > div > div > div.layout-wrapper > div > span > ms-prompt-switcher > ms-chunk-editor > section > footer'
      ]),
      sendButtons: Object.freeze([
        'ms-run-button button[type="submit"]',
        'button.run-button[type="submit"]',
        'button[aria-label="Run"][type="submit"]',
        'ms-run-button button',
        'button.run-button',
        'button[aria-label="Run"]',
        'button[type="submit"]',
        'footer > div.input-wrapper > div:nth-child(3) > run-button > button'
      ]),
      editors: Object.freeze([
        'textarea[aria-label="Type something or tab to choose an example prompt"]',
        'textarea[aria-label*="Type something"]',
        'ms-autosize-textarea textarea',
        'ms-autosize-textarea textarea.v3-font-body'
      ]),
      threadRoot: '',
      buttonsContainerId: 'aistudio-custom-buttons-container',
      stopButtons: Object.freeze([
        'button[aria-label="Stop generating"]',
        'button[aria-label="Cancel"]'
      ])
    })
  });

  const SITE_LABELS = Object.freeze({
    ChatGPT: 'ChatGPT',
    Perplexity: 'Perplexity',
    Gemini: 'Gemini',
    Claude: 'Claude',
    Grok: 'Grok',
    AIStudio: 'AI Studio'
  });

  const SELECTOR_FIELDS = Object.freeze([
    { key: 'containers', label: 'Container selectors' },
    { key: 'editors', label: 'Editor selectors' },
    { key: 'sendButtons', label: 'Send button selectors' },
    { key: 'stopButtons', label: 'Stop button selectors' },
    { key: 'threadRoot', label: 'Thread root selector' },
    { key: 'buttonsContainerId', label: 'Buttons container id' }
  ]);

  const SUPPORTED_SITES = Object.freeze(Object.keys(DEFAULT_SITE_SELECTORS));

  const DEFAULT_SELECTOR_SETTINGS = Object.freeze({
    heuristics: Object.freeze({
      editor: true,
      sendButton: true,
      stopButton: true,
      ignoreStopButton: false
    }),
    customSelectors: Object.freeze({})
  });

  function uniqueList(values) {
    return [...new Set(values)];
  }

  function normalizeSelectorList(value) {
    if (!Array.isArray(value)) return [];
    return uniqueList(
      value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean)
    );
  }

  function normalizeOptionalString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function normalizeSiteSelectors(value) {
    return {
      containers: normalizeSelectorList(value?.containers),
      editors: normalizeSelectorList(value?.editors),
      sendButtons: normalizeSelectorList(value?.sendButtons),
      stopButtons: normalizeSelectorList(value?.stopButtons),
      threadRoot: normalizeOptionalString(value?.threadRoot),
      buttonsContainerId: normalizeOptionalString(value?.buttonsContainerId)
    };
  }

  function normalizeSelectorSettings(value) {
    const heuristics = value?.heuristics && typeof value.heuristics === 'object' ? value.heuristics : {};
    const customSelectors = value?.customSelectors && typeof value.customSelectors === 'object'
      ? value.customSelectors
      : {};
    const normalizedCustomSelectors = {};

    for (const site of SUPPORTED_SITES) {
      if (customSelectors[site]) {
        normalizedCustomSelectors[site] = normalizeSiteSelectors(customSelectors[site]);
      }
    }

    return {
      heuristics: {
        editor: heuristics.editor !== false,
        sendButton: heuristics.sendButton !== false,
        stopButton: heuristics.stopButton !== false,
        ignoreStopButton: heuristics.ignoreStopButton === true
      },
      customSelectors: normalizedCustomSelectors
    };
  }

  function cloneSiteSelectors(value) {
    return {
      containers: [...(value?.containers || [])],
      editors: [...(value?.editors || [])],
      sendButtons: [...(value?.sendButtons || [])],
      stopButtons: [...(value?.stopButtons || [])],
      threadRoot: value?.threadRoot || '',
      buttonsContainerId: value?.buttonsContainerId || ''
    };
  }

  function getDefaultSiteSelectors(site) {
    return cloneSiteSelectors(DEFAULT_SITE_SELECTORS[site] || {});
  }

  function mergeSelectorLists(primary, fallback) {
    return uniqueList([...(primary || []), ...(fallback || [])]);
  }

  function getEffectiveSiteSelectors(site, settings) {
    const normalized = normalizeSelectorSettings(settings);
    const defaults = getDefaultSiteSelectors(site);
    const custom = cloneSiteSelectors(normalized.customSelectors[site]);

    return {
      containers: mergeSelectorLists(custom.containers, defaults.containers),
      editors: mergeSelectorLists(custom.editors, defaults.editors),
      sendButtons: mergeSelectorLists(custom.sendButtons, defaults.sendButtons),
      stopButtons: mergeSelectorLists(custom.stopButtons, defaults.stopButtons),
      threadRoot: custom.threadRoot || defaults.threadRoot || '',
      buttonsContainerId: custom.buttonsContainerId || defaults.buttonsContainerId || ''
    };
  }

  function selectorsToTextarea(value) {
    return Array.isArray(value) ? value.join('\n') : '';
  }

  function textareaToSelectors(value) {
    if (typeof value !== 'string') return [];
    return uniqueList(
      value
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    );
  }

  function siteSelectorsToJsonTextarea(value) {
    return JSON.stringify(normalizeSiteSelectors(value), null, 2);
  }

  function parseSiteSelectorsJson(value) {
    if (typeof value !== 'string' || !value.trim()) {
      return { ok: true, value: normalizeSiteSelectors({}) };
    }

    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: 'Selectors JSON must be an object.' };
      }
      return { ok: true, value: normalizeSiteSelectors(parsed) };
    } catch (err) {
      return { ok: false, error: err?.message || 'Invalid JSON.' };
    }
  }

  window.AivoRelaySelectorShared = {
    DEFAULT_SITE_SELECTORS,
    DEFAULT_SELECTOR_SETTINGS,
    SELECTOR_FIELDS,
    SITE_LABELS,
    SUPPORTED_SITES,
    getDefaultSiteSelectors,
    getEffectiveSiteSelectors,
    mergeSelectorLists,
    normalizeSelectorSettings,
    normalizeSiteSelectors,
    parseSiteSelectorsJson,
    siteSelectorsToJsonTextarea,
    selectorsToTextarea,
    textareaToSelectors
  };
})();
