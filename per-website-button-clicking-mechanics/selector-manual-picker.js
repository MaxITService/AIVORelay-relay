'use strict';

(() => {
  const shared = window.AivoRelaySelectorShared;
  if (!shared) {
    return;
  }

  const OFFER_COOLDOWN_MS = 15000;
  const TYPE_LABELS = {
    editor: 'editor',
    sendButton: 'send button',
    stopButton: 'stop button'
  };
  const TYPE_TITLES = {
    editor: 'Editor',
    sendButton: 'Send button',
    stopButton: 'Stop button'
  };
  const TYPE_SELECTOR_KEY = {
    editor: 'editors',
    sendButton: 'sendButtons',
    stopButton: 'stopButtons'
  };

  let activeSession = null;
  const lastOffers = {
    editor: 0,
    sendButton: 0,
    stopButton: 0
  };

  function getActiveSite() {
    return window.InjectionTargetsOnWebsite?.activeSite || 'Unknown';
  }

  function isSupportedSite(site) {
    return shared.SUPPORTED_SITES.includes(site);
  }

  function escapeCss(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    return String(value).replace(/"/g, '\\"');
  }

  function isUniqueSelector(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function deriveSelectorFromElement(element) {
    if (!element?.tagName) return null;
    const tag = element.tagName.toLowerCase();

    const id = element.getAttribute('id');
    if (id) {
      const candidate = `#${escapeCss(id)}`;
      if (isUniqueSelector(candidate)) return candidate;
    }

    const attrPriority = ['data-testid', 'aria-label', 'name', 'placeholder'];
    for (const attr of attrPriority) {
      const value = element.getAttribute(attr);
      if (!value) continue;
      const candidate = `${tag}[${attr}="${escapeCss(value)}"]`;
      if (isUniqueSelector(candidate)) return candidate;
    }

    const classes = Array.from(element.classList || [])
      .filter((className) => className && className.length > 1 && !className.startsWith('hc-'))
      .slice(0, 3);
    if (classes.length) {
      const candidate = `${tag}.${classes.map(escapeCss).join('.')}`;
      if (isUniqueSelector(candidate)) return candidate;
    }

    const segments = [];
    let node = element;
    for (let depth = 0; node?.tagName && depth < 4; depth += 1) {
      const parent = node.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      const index = siblings.indexOf(node) + 1;
      segments.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index})`);
      const candidate = segments.join(' > ');
      if (isUniqueSelector(candidate)) return candidate;
      node = parent;
    }

    return null;
  }

  function getPickerUiRoots() {
    return [
      document.getElementById('toastContainer'),
      document.getElementById('hc-floating-ui')
    ].filter(Boolean);
  }

  function isInPickerUiRoots(element, roots) {
    if (!(element instanceof Element)) return false;
    return roots.some((root) => root === element || root.contains(element));
  }

  function isVisibleElement(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function describeElement(element) {
    if (!(element instanceof Element)) return 'Unknown element';
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : '';
    const name = element.getAttribute('name');
    const aria = element.getAttribute('aria-label');
    const placeholder = element.getAttribute('placeholder');
    const text = (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 48);
    return [tag + id, aria && `aria="${aria}"`, placeholder && `placeholder="${placeholder}"`, name && `name="${name}"`, text && `"${text}"`]
      .filter(Boolean)
      .join(' ');
  }

  function normalizeElementList(elements) {
    const seen = new Set();
    const result = [];
    for (const element of elements) {
      if (!(element instanceof Element) || seen.has(element) || !isVisibleElement(element)) {
        continue;
      }
      seen.add(element);
      result.push(element);
    }
    return result;
  }

  function getEditorCandidates() {
    return normalizeElementList(
      Array.from(document.querySelectorAll([
        'textarea',
        '[contenteditable="true"]',
        '[role="textbox"]',
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])'
      ].join(',')))
    );
  }

  function getButtonCandidates(targetType) {
    const allButtons = normalizeElementList(
      Array.from(document.querySelectorAll('button, [role="button"], div[onclick], span[onclick]'))
    );
    if (targetType !== 'stopButton') {
      return allButtons;
    }

    const stopFirst = [];
    const fallback = [];
    for (const element of allButtons) {
      const haystack = [
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.innerText,
        element.textContent
      ].filter(Boolean).join(' ').toLowerCase();
      if (/(stop|cancel|abort|pause|interrupt)/.test(haystack)) {
        stopFirst.push(element);
      } else {
        fallback.push(element);
      }
    }
    return [...stopFirst, ...fallback];
  }

  function buildPickerCandidates(targetType, seedElement = null, roots = []) {
    const base = targetType === 'editor' ? getEditorCandidates() : getButtonCandidates(targetType);
    const candidates = [];
    if (seedElement instanceof Element) {
      candidates.push(seedElement);
    }
    for (const element of base) {
      if (!isInPickerUiRoots(element, roots)) {
        candidates.push(element);
      }
    }
    return normalizeElementList(candidates);
  }

  function clearHighlight(session = activeSession) {
    if (!session?.highlightedElement) return;
    const previous = session.highlightedElement;
    previous.style.outline = session.previousOutline || '';
    previous.style.outlineOffset = session.previousOutlineOffset || '';
    session.highlightedElement = null;
    session.previousOutline = '';
    session.previousOutlineOffset = '';
  }

  function highlightElement(session, element, color) {
    if (!session) return;
    if (session.highlightedElement === element) {
      if (element) {
        element.style.outline = `3px solid ${color}`;
        element.style.outlineOffset = '3px';
      }
      return;
    }

    clearHighlight(session);

    if (!(element instanceof Element)) return;
    session.highlightedElement = element;
    session.previousOutline = element.style.outline;
    session.previousOutlineOffset = element.style.outlineOffset;
    element.style.outline = `3px solid ${color}`;
    element.style.outlineOffset = '3px';
  }

  function getCandidateFromPoint(targetType, eventTarget, roots = []) {
    if (!(eventTarget instanceof Element) || isInPickerUiRoots(eventTarget, roots)) return null;

    if (targetType === 'editor') {
      return eventTarget.closest('textarea, [contenteditable="true"], [role="textbox"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])');
    }

    return eventTarget.closest('button, [role="button"], div[onclick], span[onclick]');
  }

  function teardownSession(session, options = {}) {
    if (!session) return;

    if (session.onPointerMove) {
      document.removeEventListener('pointermove', session.onPointerMove, true);
      session.onPointerMove = null;
    }
    if (session.onPickClick) {
      document.removeEventListener('click', session.onPickClick, true);
      session.onPickClick = null;
    }
    if (session.onKeyDown) {
      document.removeEventListener('keydown', session.onKeyDown, true);
      session.onKeyDown = null;
    }

    session.isPicking = false;
    if (!options.keepHighlight) {
      clearHighlight(session);
    }
    session.active = false;

    if (activeSession === session) {
      activeSession = null;
    }
  }

  function selectCandidateIndex(session, desiredIndex, announce = false) {
    if (!session?.active) return false;
    const list = Array.isArray(session.candidates) ? session.candidates : [];
    if (!list.length) {
      showToast('No candidates available. Try Pick.', 'warning', 2500);
      return false;
    }

    const len = list.length;
    let index = Number.isFinite(desiredIndex) ? desiredIndex : 0;
    for (let attempt = 0; attempt < len; attempt += 1) {
      const normalized = ((index % len) + len) % len;
      const element = list[normalized];
      if (element && element.isConnected && isVisibleElement(element) && !isInPickerUiRoots(element, session.roots)) {
        session.index = normalized;
        session.selectedEl = element;
        highlightElement(session, element, '#4CAF50');
        try {
          element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        } catch {
          // Ignore scroll failures.
        }
        if (announce) {
          showToast(`${TYPE_TITLES[session.targetType]} candidate ${normalized + 1}/${len}: ${describeElement(element)}`, 'info', 1800);
        }
        return true;
      }
      index += 1;
    }

    showToast('All candidates look unavailable right now. Try Pick.', 'warning', 2500);
    return false;
  }

  function stepCandidate(session, direction) {
    if (!session?.active) return;
    selectCandidateIndex(session, (session.index || 0) + direction, true);
  }

  function stopPickMode(session, options = {}) {
    if (!session?.isPicking) return;

    if (session.onPointerMove) {
      document.removeEventListener('pointermove', session.onPointerMove, true);
      session.onPointerMove = null;
    }
    if (session.onPickClick) {
      document.removeEventListener('click', session.onPickClick, true);
      session.onPickClick = null;
    }
    if (session.onKeyDown) {
      document.removeEventListener('keydown', session.onKeyDown, true);
      session.onKeyDown = null;
    }

    session.isPicking = false;
    if (!options.keepHighlight) {
      clearHighlight(session);
    }
  }

  function startPickMode(session) {
    if (!session?.active) return;
    if (session.isPicking) {
      showToast('Pick mode already active. Hover to preview, click to choose, then press Save for This Site when ready.', 'info', 2200);
      return;
    }

    session.isPicking = true;
    showToast(`Pick mode for ${TYPE_TITLES[session.targetType]}: hover previews purple, click chooses, Save for This Site stores it.`, 'info', 2600);

    session.onPointerMove = (event) => {
      if (!session.active || !session.isPicking) return;
      const candidate = getCandidateFromPoint(session.targetType, event.target, session.roots);
      if (!candidate) {
        clearHighlight(session);
        return;
      }
      highlightElement(session, candidate, '#7a5cc8');
    };

    session.onPickClick = (event) => {
      if (!session.active || !session.isPicking) return;
      if (isInPickerUiRoots(event.target, session.roots)) {
        return;
      }

      const picked = getCandidateFromPoint(session.targetType, event.target, session.roots);
      if (!picked) {
        showToast('Could not pick that. Try clicking directly on the target control.', 'warning', 2500);
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      stopPickMode(session, { keepHighlight: false });
      session.candidates = buildPickerCandidates(session.targetType, picked, session.roots);
      const pickedIndex = session.candidates.indexOf(picked);
      selectCandidateIndex(session, pickedIndex >= 0 ? pickedIndex : 0, true);
      showToast('Picked. Review it, then press Save for This Site when ready.', 'success', 2200);
    };

    session.onKeyDown = (event) => {
      if (event.key !== 'Escape' || !session.isPicking) return;
      event.preventDefault();
      stopPickMode(session);
      if (session.selectedEl) {
        highlightElement(session, session.selectedEl, '#4CAF50');
      }
      showToast('Pick mode cancelled. The helper is still open so you can keep reviewing candidates.', 'info', 2400);
    };

    document.addEventListener('pointermove', session.onPointerMove, true);
    document.addEventListener('click', session.onPickClick, true);
    document.addEventListener('keydown', session.onKeyDown, true);
  }

  async function savePickedSelector(targetType, element) {
    const site = getActiveSite();
    if (!isSupportedSite(site)) {
      return { ok: false, reason: 'unsupportedSite' };
    }

    const selector = deriveSelectorFromElement(element);
    if (!selector) {
      return { ok: false, reason: 'selectorNotDerived' };
    }

    const { selectorSettings } = await chrome.storage.local.get({
      selectorSettings: shared.DEFAULT_SELECTOR_SETTINGS
    });
    const normalized = shared.normalizeSelectorSettings(selectorSettings);
    const selectorKey = TYPE_SELECTOR_KEY[targetType];
    if (!selectorKey) {
      return { ok: false, reason: 'unknownType' };
    }

    const existingSite = normalized.customSelectors[site] || shared.normalizeSiteSelectors({});
    const updatedSite = {
      ...existingSite,
      [selectorKey]: shared.mergeSelectorLists([selector], existingSite[selectorKey])
    };

    await chrome.storage.local.set({
      selectorSettings: {
        ...normalized,
        customSelectors: {
          ...normalized.customSelectors,
          [site]: updatedSite
        }
      }
    });

    return { ok: true, selector, site };
  }

  async function saveSessionSelection(session) {
    if (!session?.active) return false;
    stopPickMode(session, { keepHighlight: true });

    const element = session.selectedEl;
    if (!element) {
      showToast('Nothing selected yet. Use Back / Forward or Pick first.', 'warning', 2500);
      return false;
    }

    const result = await savePickedSelector(session.targetType, element);
    if (result.ok) {
      teardownSession(session);
      showToast(`Saved ${TYPE_LABELS[session.targetType]} selector for ${result.site}. Resend the message to use it.`, 'success', {
        duration: 5000,
        tooltip: result.selector
      });
      return true;
    }

    showToast(`Could not save the ${TYPE_LABELS[session.targetType]} selector automatically. Try the Settings tab.`, 'error', 5000);
    return false;
  }

  function start(targetType) {
    if (!TYPE_LABELS[targetType] || typeof showToast !== 'function') return false;

    if (activeSession) {
      teardownSession(activeSession);
    }

    const roots = getPickerUiRoots();
    const candidates = buildPickerCandidates(targetType, null, roots);
    if (!candidates.length) {
      showToast(`No ${TYPE_LABELS[targetType]} candidates were found on this page.`, 'warning', 3000);
      return false;
    }

    const session = {
      active: true,
      targetType,
      roots,
      candidates,
      index: 0,
      selectedEl: null,
      highlightedElement: null,
      previousOutline: '',
      previousOutlineOffset: '',
      isPicking: false,
      onPointerMove: null,
      onPickClick: null,
      onKeyDown: null
    };

    activeSession = session;
    selectCandidateIndex(session, 0, false);

    const tooltip = [
      `Target mode: ${TYPE_TITLES[targetType]}`,
      `- Back / Forward: review nearby candidates with a green outline.`,
      `- Pick Element: hover previews in purple, click to choose, but nothing is saved yet.`,
      `- Save for This Site: stores the current selection for this site.`,
      `- Esc: leaves pick mode without closing the helper.`
    ].join('\n');

    showToast(`Manual selector helper: ${TYPE_TITLES[targetType]}. Review candidates, pick an element on the page, then save it for this site.`, 'info', {
      duration: 0,
      tooltip,
      customButtons: [
        {
          text: 'Back',
          title: 'Previous candidate',
          onClick: () => {
            stepCandidate(session, -1);
            return false;
          }
        },
        {
          text: 'Pick Element',
          title: 'Hover preview, click to choose an element, keep helper open',
          onClick: () => {
            startPickMode(session);
            return false;
          }
        },
        {
          text: 'Save for This Site',
          title: 'Store the selected selector for this site',
          className: 'toast-action-primary',
          onClick: async () => saveSessionSelection(session)
        },
        {
          text: 'Forward',
          title: 'Next candidate',
          onClick: () => {
            stepCandidate(session, 1);
            return false;
          }
        },
        {
          text: 'Dismiss',
          title: 'Close this helper without saving',
          className: 'toast-action-secondary',
          onClick: () => true
        }
      ],
      onDismiss: () => {
        if (activeSession === session) {
          teardownSession(session);
        }
      }
    });

    return true;
  }

  function stop() {
    if (activeSession) {
      teardownSession(activeSession);
    }
  }

  function offer(targetType) {
    if (!TYPE_LABELS[targetType] || typeof showToast !== 'function') {
      return false;
    }

    const now = Date.now();
    if (now - lastOffers[targetType] < OFFER_COOLDOWN_MS) {
      return false;
    }
    lastOffers[targetType] = now;

    showToast(
      `AivoRelay could not find the ${TYPE_LABELS[targetType]}. You can open the selector helper and save it manually for this site.`,
      'info',
      {
        duration: 0,
        tooltip: `Target mode: ${TYPE_TITLES[targetType]}\nOpen the helper to review candidates, pick an element on the page, and save only when you are sure.`,
        customButtons: [
          {
            text: 'Open helper',
            title: `Open manual helper for ${TYPE_LABELS[targetType]}`,
            onClick: () => {
              start(targetType);
              return true;
            }
          },
          {
            text: 'Later',
            title: 'Dismiss this helper',
            onClick: () => true
          }
        ]
      }
    );

    return true;
  }

  window.AivoRelayManualPicker = {
    offer,
    start,
    stop
  };
})();
