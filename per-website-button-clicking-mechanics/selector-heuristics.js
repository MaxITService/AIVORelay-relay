'use strict';

(() => {
  const shared = window.AivoRelaySelectorShared;
  if (!shared) {
    return;
  }

  let selectorSettingsCache = shared.normalizeSelectorSettings(shared.DEFAULT_SELECTOR_SETTINGS);
  let selectorSettingsLoaded = false;
  let selectorSettingsPromise = null;
  let storageListenerRegistered = false;
  let stopDebugWatchTimer = null;

  const EDITOR_HINTS = {
    ChatGPT: ['prompt', 'composer', 'message', 'chat'],
    Perplexity: ['ask', 'search', 'message'],
    Gemini: ['message', 'prompt', 'ask'],
    Claude: ['message', 'prompt'],
    Grok: ['ask', 'grok', 'message'],
    AIStudio: ['prompt', 'run', 'message']
  };

  const SEND_POSITIVE_KEYWORDS = ['send', 'submit', 'ask', 'run', 'go', 'arrow', 'reply'];
  const SEND_NEGATIVE_KEYWORDS = ['stop', 'cancel', 'attach', 'upload', 'image', 'photo', 'file', 'voice', 'mic'];
  const STOP_POSITIVE_KEYWORDS = ['stop', 'cancel', 'abort', 'pause'];
  const STOP_NEGATIVE_KEYWORDS = ['send', 'submit', 'attach', 'upload', 'voice', 'mic'];

  function logHeuristic(...args) {
    if (typeof logConCgp === 'function') {
      logConCgp('[selectors]', ...args);
    }
  }

  function isOurOverlayElement(element) {
    if (!element || typeof element.closest !== 'function') return false;
    return Boolean(
      element.closest('#hc-floating-ui') ||
      element.closest('.aivo-popup-root') ||
      element.closest('[data-aivorelay-popup="true"]')
    );
  }

  function isVisibleElement(element) {
    if (!element || isOurOverlayElement(element)) return false;
    if (window.MaxExtensionUtils?.isElementVisible) {
      return window.MaxExtensionUtils.isElementVisible(element);
    }
    const rect = element.getBoundingClientRect();
    if (!rect || rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(element);
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const opacity = Number.parseFloat(style.opacity || '1');
    return Number.isNaN(opacity) || opacity !== 0;
  }

  function isEditableElement(element) {
    if (!element || !isVisibleElement(element)) return false;
    if (element instanceof HTMLTextAreaElement) {
      return !element.disabled && !element.readOnly;
    }
    const role = element.getAttribute?.('role') || '';
    const contentEditable = element.isContentEditable || element.getAttribute?.('contenteditable') === 'true';
    if (!contentEditable && role !== 'textbox') {
      return false;
    }
    if (element.getAttribute?.('aria-disabled') === 'true') return false;
    return true;
  }

  function isButtonElement(element) {
    if (!element || !isVisibleElement(element)) return false;
    const tag = element.tagName?.toLowerCase?.() || '';
    if (tag === 'button') return true;
    const role = element.getAttribute?.('role') || '';
    return role === 'button' || Boolean(element.getAttribute?.('onclick'));
  }

  function isDisabledElement(element) {
    if (!element) return true;
    return Boolean(
      element.disabled
      || element.getAttribute?.('disabled') !== null
      || element.getAttribute?.('aria-disabled') === 'true'
    );
  }

  function getElementTextMeta(element) {
    const values = [
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
      element.getAttribute?.('placeholder'),
      element.getAttribute?.('data-testid'),
      element.getAttribute?.('name'),
      element.getAttribute?.('id'),
      element.textContent
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return values;
  }

  function describeElement(element) {
    if (!(element instanceof Element)) return 'Unknown element';
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : '';
    const testId = element.getAttribute('data-testid');
    const aria = element.getAttribute('aria-label');
    const text = (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 48);
    return [tag + id, testId && `data-testid="${testId}"`, aria && `aria="${aria}"`, text && `"${text}"`]
      .filter(Boolean)
      .join(' ');
  }

  function evaluateStopCandidate(element, details = {}) {
    const source = details.source || 'unknown';
    const selector = details.selector || '';
    const visible = isVisibleElement(element);
    const buttonLike = isButtonElement(element);
    const disabled = isDisabledElement(element);
    const textMeta = getElementTextMeta(element);
    const hasPositiveSignal = STOP_POSITIVE_KEYWORDS.some((keyword) => textMeta.includes(keyword));
    const hasNegativeSignal = STOP_NEGATIVE_KEYWORDS.some((keyword) => textMeta.includes(keyword));
    const selectorSignal = typeof selector === 'string' && /(stop|cancel|abort|pause|interrupt)/i.test(selector);
    const reasons = [];

    if (!visible) reasons.push('not_visible');
    if (!buttonLike) reasons.push('not_button_like');
    if (disabled) reasons.push('disabled');
    if (!hasPositiveSignal && !selectorSignal) reasons.push('no_stop_signal');
    if (hasNegativeSignal) reasons.push('send_like_text');

    return {
      element,
      source,
      selector,
      description: describeElement(element),
      textMeta,
      disabled,
      accepted: reasons.length === 0,
      reasons
    };
  }

  function scoreKeywordMatch(text, positiveKeywords, negativeKeywords) {
    let score = 0;
    for (const keyword of positiveKeywords) {
      if (text.includes(keyword)) {
        score += 14;
      }
    }
    for (const keyword of negativeKeywords) {
      if (text.includes(keyword)) {
        score -= 18;
      }
    }
    return score;
  }

  function collectShadowRoots(root, bucket) {
    const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const node of nodes) {
      if (node?.shadowRoot) {
        bucket.push(node.shadowRoot);
        collectShadowRoots(node.shadowRoot, bucket);
      }
    }
  }

  function collectRoots() {
    const roots = [document];
    collectShadowRoots(document, roots);
    return roots;
  }

  function querySelectorList(selectors, filterFn) {
    for (const selector of selectors || []) {
      if (!selector) continue;
      let nodes = [];
      try {
        nodes = document.querySelectorAll(selector);
      } catch (err) {
        logHeuristic('Invalid selector skipped', selector, err?.message || err);
        continue;
      }
      for (const node of nodes) {
        if (!filterFn || filterFn(node)) {
          return node;
        }
      }
    }
    return null;
  }

  function getActiveSite() {
    return window.InjectionTargetsOnWebsite?.activeSite || 'Unknown';
  }

  function registerStorageListener() {
    if (storageListenerRegistered || !chrome?.storage?.onChanged) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.selectorSettings) return;
      selectorSettingsCache = shared.normalizeSelectorSettings(changes.selectorSettings.newValue);
      selectorSettingsLoaded = true;
    });
    storageListenerRegistered = true;
  }

  async function ensureSelectorSettingsLoaded() {
    registerStorageListener();
    if (selectorSettingsLoaded) {
      return selectorSettingsCache;
    }
    if (!selectorSettingsPromise) {
      selectorSettingsPromise = chrome.storage.local
        .get({ selectorSettings: shared.DEFAULT_SELECTOR_SETTINGS })
        .then(({ selectorSettings }) => {
          selectorSettingsCache = shared.normalizeSelectorSettings(selectorSettings);
          selectorSettingsLoaded = true;
          return selectorSettingsCache;
        })
        .catch(() => {
          selectorSettingsLoaded = true;
          return selectorSettingsCache;
        });
    }
    return selectorSettingsPromise;
  }

  function collectEditableCandidates() {
    const roots = collectRoots();
    const seen = new Set();
    const candidates = [];

    for (const root of roots) {
      const nodes = root.querySelectorAll
        ? root.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')
        : [];
      for (const node of nodes) {
        if (seen.has(node) || !isEditableElement(node)) continue;
        seen.add(node);
        candidates.push(node);
      }
    }

    return candidates;
  }

  function collectButtonCandidates() {
    const roots = collectRoots();
    const seen = new Set();
    const candidates = [];

    for (const root of roots) {
      const nodes = root.querySelectorAll
        ? root.querySelectorAll('button, [role="button"], div[onclick], span[onclick]')
        : [];
      for (const node of nodes) {
        if (seen.has(node) || !isButtonElement(node)) continue;
        seen.add(node);
        candidates.push(node);
      }
    }

    return candidates;
  }

  function scoreEditorCandidate(element, site) {
    const rect = element.getBoundingClientRect();
    const textMeta = getElementTextMeta(element);
    const hintKeywords = EDITOR_HINTS[site] || ['message', 'prompt', 'ask'];
    let score = 0;

    score += Math.min(rect.width, 900) / 22;
    score += Math.min(rect.height, 240) / 14;
    score += Math.max(0, rect.bottom) / 65;

    if (element instanceof HTMLTextAreaElement) score += 18;
    if (element.isContentEditable || element.getAttribute?.('contenteditable') === 'true') score += 20;
    if (element.getAttribute?.('role') === 'textbox') score += 8;
    if (element.closest?.('form')) score += 8;
    if (element.closest?.('footer, main, section')) score += 4;
    if (element.id === 'prompt-textarea') score += 40;
    if (textMeta.includes('prosemirror')) score += 20;
    if (textMeta.includes('lexical')) score += 12;

    for (const keyword of hintKeywords) {
      if (textMeta.includes(keyword)) {
        score += 12;
      }
    }

    if (textMeta.includes('search')) score -= 8;
    if (textMeta.includes('upload')) score -= 12;
    if (element.closest?.('header, nav, aside')) score -= 18;

    return score;
  }

  function findEditorHeuristically(site) {
    const candidates = collectEditableCandidates();
    if (!candidates.length) return null;

    const best = candidates
      .map((element) => ({ element, score: scoreEditorCandidate(element, site) }))
      .sort((left, right) => right.score - left.score)[0];

    if (best?.score > 18) {
      logHeuristic('Editor heuristic matched', site, best.score, best.element);
      return best.element;
    }

    return null;
  }

  function getEditorAnchor(site, effectiveSelectors) {
    return querySelectorList(effectiveSelectors.editors, isEditableElement) || findEditorHeuristically(site);
  }

  function scoreButtonCandidate(element, mode, editorAnchor) {
    const rect = element.getBoundingClientRect();
    const textMeta = getElementTextMeta(element);
    const positive = mode === 'stop' ? STOP_POSITIVE_KEYWORDS : SEND_POSITIVE_KEYWORDS;
    const negative = mode === 'stop' ? STOP_NEGATIVE_KEYWORDS : SEND_NEGATIVE_KEYWORDS;
    let score = scoreKeywordMatch(textMeta, positive, negative);

    if (element.querySelector?.('svg')) score += 10;
    if (element.tagName?.toLowerCase?.() === 'button') score += 8;
    if (element.getAttribute?.('type') === 'submit') score += mode === 'send' ? 20 : -10;
    if (element.disabled || element.getAttribute?.('aria-disabled') === 'true') {
      score += mode === 'send' ? 6 : -4;
    }
    if (/^\d+$/.test((element.textContent || '').trim())) {
      score -= 20;
    }

    if (editorAnchor) {
      const editorRect = editorAnchor.getBoundingClientRect();
      const horizontalDelta = rect.left - editorRect.left;
      const verticalDelta = rect.top - editorRect.top;

      if (rect.top >= editorRect.top - 40 && rect.bottom <= editorRect.bottom + 140) score += 10;
      if (horizontalDelta >= -80) score += 6;
      if (verticalDelta >= -40) score += 4;
      if (element.closest?.('form') && editorAnchor.closest?.('form') && element.closest('form') === editorAnchor.closest('form')) {
        score += 18;
      }
    }

    return score;
  }

  function findButtonHeuristically(site, mode, effectiveSelectors) {
    const editorAnchor = getEditorAnchor(site, effectiveSelectors);
    const candidates = collectButtonCandidates();
    if (!candidates.length) return null;

    const best = candidates
      .map((element) => ({ element, score: scoreButtonCandidate(element, mode, editorAnchor) }))
      .sort((left, right) => right.score - left.score)[0];

    if (best?.score > 12) {
      logHeuristic(`${mode} heuristic matched`, site, best.score, best.element);
      return best.element;
    }

    return null;
  }

  function queryStopSelectorList(selectors) {
    const diagnostics = [];

    for (const selector of selectors || []) {
      if (!selector) continue;
      let nodes = [];
      try {
        nodes = document.querySelectorAll(selector);
      } catch (err) {
        diagnostics.push({
          element: null,
          source: 'selector-error',
          selector,
          description: 'Invalid selector',
          textMeta: '',
          disabled: false,
          accepted: false,
          reasons: ['invalid_selector', err?.message || 'query_failed']
        });
        logHeuristic('Invalid stop selector skipped', selector, err?.message || err);
        continue;
      }

      for (const node of nodes) {
        const result = evaluateStopCandidate(node, { source: 'selector', selector });
        diagnostics.push(result);
        if (result.accepted) {
          return { element: node, diagnostics };
        }
      }
    }

    return { element: null, diagnostics };
  }

  function inspectStopHeuristics(site, effectiveSelectors) {
    const editorAnchor = getEditorAnchor(site, effectiveSelectors);
    const diagnostics = collectButtonCandidates()
      .map((element) => {
        const evaluation = evaluateStopCandidate(element, { source: 'heuristic' });
        return {
          ...evaluation,
          score: scoreButtonCandidate(element, 'stop', editorAnchor)
        };
      })
      .sort((left, right) => (right.score || 0) - (left.score || 0))
      .slice(0, 12);

    const bestAccepted = diagnostics.find((entry) => entry.accepted && (entry.score || 0) > 12);
    return {
      element: bestAccepted?.element || null,
      diagnostics
    };
  }

  async function inspectStopButtons(siteOverride = null) {
    const site = siteOverride || getActiveSite();
    if (!shared.SUPPORTED_SITES.includes(site)) {
      return [];
    }

    const selectorSettings = await ensureSelectorSettingsLoaded();
    const effectiveSelectors = shared.getEffectiveSiteSelectors(site, selectorSettings);
    const direct = queryStopSelectorList(effectiveSelectors.stopButtons);
    const heuristic = selectorSettings.heuristics.stopButton
      ? inspectStopHeuristics(site, effectiveSelectors)
      : { element: null, diagnostics: [] };

    return [...direct.diagnostics, ...heuristic.diagnostics].map((entry, index) => ({
      index: index + 1,
      source: entry.source,
      selector: entry.selector || '',
      accepted: entry.accepted,
      disabled: entry.disabled,
      score: entry.score ?? null,
      reasons: Array.isArray(entry.reasons) ? entry.reasons.join(', ') : '',
      description: entry.description,
      textMeta: entry.textMeta
    }));
  }

  async function findElement(type) {
    const site = getActiveSite();
    if (!shared.SUPPORTED_SITES.includes(site)) {
      return null;
    }

    const selectorSettings = await ensureSelectorSettingsLoaded();
    const effectiveSelectors = shared.getEffectiveSiteSelectors(site, selectorSettings);

    if (type === 'editor') {
      const directEditor = querySelectorList(effectiveSelectors.editors, isEditableElement);
      if (directEditor) return directEditor;
      const heuristicEditor = selectorSettings.heuristics.editor ? findEditorHeuristically(site) : null;
      if (!heuristicEditor) {
        window.AivoRelayManualPicker?.offer?.('editor');
      }
      return heuristicEditor;
    }

    if (type === 'sendButton') {
      const directSend = querySelectorList(effectiveSelectors.sendButtons, isButtonElement);
      if (directSend) return directSend;
      const heuristicSend = selectorSettings.heuristics.sendButton
        ? findButtonHeuristically(site, 'send', effectiveSelectors)
        : null;
      if (!heuristicSend) {
        window.AivoRelayManualPicker?.offer?.('sendButton');
      }
      return heuristicSend;
    }

    if (type === 'stopButton') {
      const directStop = queryStopSelectorList(effectiveSelectors.stopButtons);
      if (directStop.element) {
        logHeuristic('Stop selector matched', site, directStop.diagnostics.find((entry) => entry.accepted)?.description || 'selector');
        return directStop.element;
      }
      const heuristicStop = selectorSettings.heuristics.stopButton
        ? inspectStopHeuristics(site, effectiveSelectors).element
        : null;
      if (heuristicStop) {
        logHeuristic('Stop heuristic matched', site, describeElement(heuristicStop));
      }
      return heuristicStop;
    }

    return null;
  }

  window.AivoRelaySelectorManager = {
    ensureSelectorSettingsLoaded,
    getCachedSelectorSettings() {
      return selectorSettingsCache;
    },
    shouldIgnoreStopButton() {
      return selectorSettingsCache?.heuristics?.ignoreStopButton === true;
    },
    async findEditor() {
      return await findElement('editor');
    },
    async findSendButton() {
      return await findElement('sendButton');
    },
    async findStopButton() {
      return await findElement('stopButton');
    },
    async inspectStopButtons(siteOverride) {
      return await inspectStopButtons(siteOverride);
    }
  };

  window.AivoRelayStopButtonDebug = {
    async inspect(siteOverride) {
      return await inspectStopButtons(siteOverride);
    },
    async log(siteOverride) {
      const entries = await inspectStopButtons(siteOverride);
      console.group('[aivo-relay] Stop button diagnostics');
      console.table(entries);
      console.groupEnd();
      return entries;
    },
    watch(intervalMs = 1000, siteOverride) {
      const delay = Math.max(250, Number(intervalMs) || 1000);
      if (stopDebugWatchTimer) {
        clearInterval(stopDebugWatchTimer);
      }
      stopDebugWatchTimer = setInterval(() => {
        void this.log(siteOverride);
      }, delay);
      return { ok: true, intervalMs: delay };
    },
    stop() {
      if (stopDebugWatchTimer) {
        clearInterval(stopDebugWatchTimer);
        stopDebugWatchTimer = null;
      }
      return { ok: true };
    }
  };
  window.inspectAivoRelayStopButtons = (...args) => window.AivoRelayStopButtonDebug.inspect(...args);
})();
