function(index, action, expected, next, key, outcomeKind, expectedLabelArg) {
  const nodes = Array.isArray(this?.nodes) ? this.nodes : null;
  let e = nodes ? nodes[index] : this;
  let rebound = false;
  const refuse = reason => ({ ok: false, dispatched: false, reason });

  const tagOf = node => node && typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
  const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const expectedLabel = norm(expectedLabelArg).toLowerCase();
  const visible = node => {
    if (!node?.isConnected) return false;
    const rect = node.getBoundingClientRect(), style = node.ownerDocument.defaultView.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility === 'visible'
      && Number.parseFloat(style.opacity || '1') > 0 && !node.closest('[hidden],[inert]');
  };
  const accessibleName = node => {
    if (!node) return '';
    const labelled = (node.getAttribute?.('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => node.ownerDocument?.getElementById(id)?.innerText || '').join(' ').trim();
    return norm(labelled || node.getAttribute?.('aria-label') || node.innerText || node.textContent
      || (typeof node.value === 'string' ? node.value : '') || node.getAttribute?.('title')
      || node.getAttribute?.('placeholder') || '');
  };
  // The click names the words it intends to press. They must be on the target
  // or on a control that contains it; a mismatched name is a real objection.
  const labelMatches = (node, wanted) => {
    // Control-sized ancestry only: <body> contains the whole page, so walking
    // into it would match any words at all.
    for (let n = node, depth = 0; n && depth < 4 && n !== node.ownerDocument?.body && n !== node.ownerDocument?.documentElement; n = n.parentElement || n.getRootNode()?.host, depth++) {
      const name = accessibleName(n).toLowerCase();
      if (name && (name === wanted || name.includes(wanted))) return true;
    }
    return false;
  };
  // Picker widgets (Google Drive, Material menus) keep controls inside shadow
  // roots. A light-DOM query misses them and turns a re-render into a false
  // target_replaced refusal.
  const deepQueryAll = (root, selector) => {
    const out = [];
    const visit = node => {
      if (!node?.querySelectorAll || out.length > 4000) return;
      out.push(...node.querySelectorAll(selector));
      for (const el of node.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(root);
    return out;
  };
  const pathOf = node => {
    let current = node, parts = [], depth = 0;
    const root = node?.ownerDocument?.body;
    while (current && current !== root && depth < 5) {
      const tag = current.tagName ? current.tagName.toLowerCase() : '';
      const index = current.parentElement ? Array.prototype.indexOf.call(current.parentElement.children, current) : 0;
      parts.unshift(tag + ':' + index);
      current = current.parentElement;
      depth += 1;
    }
    return parts.join('>');
  };
  const identityOf = node => node?.__navichromeIdentity || {
    role: node?.getAttribute?.('role') || '',
    name: accessibleName(node),
    href: tagOf(node) === 'A' ? node.href : null,
    tag: tagOf(node).toLowerCase(),
    type: typeof node?.type === 'string' ? node.type : null,
    test_id: node?.getAttribute?.('data-testid') || node?.getAttribute?.('data-test') || node?.getAttribute?.('data-qa') || null,
    id: node?.id || null,
    path: pathOf(node),
    section: null,
  };
  const baseIdentityMatches = (node, identity) => {
    if (!node || !node.isConnected || node === e || !visible(node)) return false;
    if (identity.tag && tagOf(node).toLowerCase() !== identity.tag) return false;
    if ((node.getAttribute?.('role') || '') !== (identity.role || '')) return false;
    if (identity.type && node.type !== identity.type) return false;
    if (identity.href && node.href !== identity.href) return false;
    if (identity.test_id) {
      const testId = node.getAttribute?.('data-testid') || node.getAttribute?.('data-test') || node.getAttribute?.('data-qa');
      if (testId !== identity.test_id) return false;
    }
    if (identity.name && accessibleName(node) !== identity.name) return false;
    return true;
  };
  const reacquire = () => {
    // A replaced document detaches every node from it; fall back to the live
    // execution-context document so the new render can still be rebound.
    const doc = e?.ownerDocument?.documentElement ? e.ownerDocument
      : (typeof document !== 'undefined' ? document : null);
    if (!doc?.querySelectorAll) return null;
    const identity = identityOf(e);
    const selector = identity.role ? `[role="${CSS.escape(identity.role)}"]` : (identity.tag || '*');
    let candidates = deepQueryAll(doc, selector).filter(node => baseIdentityMatches(node, identity));
    if (candidates.length !== 1 && identity.name) {
      // A re-rendered control can lose an explicit role while keeping its name.
      candidates = deepQueryAll(doc, identity.tag || '*').filter(node => baseIdentityMatches(node, identity));
    }
    if (candidates.length > 1 && identity.id) {
      const byId = candidates.filter(node => node.id === identity.id);
      if (byId.length === 1) return byId[0];
    }
    if (candidates.length > 1 && identity.path) {
      const byPath = candidates.filter(node => pathOf(node) === identity.path);
      if (byPath.length === 1) return byPath[0];
    }
    if (candidates.length > 1 && identity.section) {
      const bySection = candidates.filter(node => {
        const section = node.closest('section,[data-section],article,nav,main');
        return section && (section.getAttribute('data-section') || section.getAttribute('aria-label') || section.tagName.toLowerCase()) === identity.section;
      });
      if (bySection.length === 1) return bySection[0];
    }
    return candidates.length === 1 ? candidates[0] : null;
  };
  if (!e?.isConnected) {
    const replacement = reacquire();
    if (!replacement) return refuse('target_replaced');
    if (nodes) nodes[index] = replacement;
    e = replacement;
    rebound = true;
  }
  // The node may belong to an out-of-process iframe whose document is not the
  // global `document`; only its own document has to be alive.
  if (!e?.isConnected || !e.ownerDocument?.documentElement) return refuse('target_replaced');

  const sensitive = () => e instanceof HTMLInputElement && !['text', 'search', 'email', 'url', 'tel', 'number', 'button', 'submit', 'reset', 'checkbox', 'radio', 'date', 'time', 'month', 'week', 'datetime-local'].includes(e.type)
    || e.closest('[data-masked],[data-requires-trusted]');
  if (sensitive()) return refuse('sensitive_or_trusted_target');
  if (e.matches(':disabled,[aria-disabled="true"],[inert]') || e.closest('[inert]')) return refuse('blocked');
  if (expectedLabel && !labelMatches(e, expectedLabel)) return refuse('label_not_under_pointer');
  const valueOf = () => {
    if (!e.isConnected || sensitive()) return undefined;
    return e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || e instanceof HTMLSelectElement
      ? e.value : e.isContentEditable ? e.textContent : undefined;
  };
  const before = valueOf();
  let dispatched = false;
  try {
    if (['fill', 'type', 'select'].includes(action)) {
      if (typeof next !== 'string') return refuse('value_required');
      if (e.readOnly || e.getAttribute('aria-readonly') === 'true') return refuse('not_editable');
      if (before !== (expected ?? '')) return refuse('same_field_conflict');
      if (action === 'select') {
        if (!(e instanceof HTMLSelectElement)) return refuse('not_select');
        if (![...e.options].some(o => o.value === next && !o.disabled && !o.parentElement?.disabled)) return refuse('option_missing');
        dispatched = true;
        e.value = next;
      } else {
        const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
          : e instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'number', 'date', 'time', 'month', 'week', 'datetime-local'].includes(e.type) ? HTMLInputElement.prototype : null;
        if (proto) {
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (!setter) return refuse('missing_value_setter');
          dispatched = true;
          setter.call(e, next);
        } else if (e.isContentEditable) {
          dispatched = true;
          e.textContent = next;
        } else return refuse('not_editable');
      }
      e.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: next }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      const after = valueOf();
      const verified = after !== undefined && after === next;
      return { ok: verified, verified, dispatched, before, after, transport: 'dom_value', trusted_input: false, rebound };
    }
    if (['click', 'double_click', 'context_click'].includes(action)) {
      const eventType = action === 'double_click' ? 'dblclick' : action === 'context_click' ? 'contextmenu' : 'click';
      let eventSeen = false;
      const mark = () => { eventSeen = true; };
      e.addEventListener(eventType, mark, { once: true });
      const label = e.closest('label');
      const labelControl = label instanceof HTMLLabelElement ? label.control : null;
      // A real pointer click focuses the control it lands on. DOM activation
      // does not, so do it explicitly for native focusable controls. This keeps
      // a focused postcondition truthful without changing which control acts.
      const focusTarget = e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || e instanceof HTMLSelectElement || e instanceof HTMLButtonElement
        ? e : labelControl instanceof HTMLElement ? labelControl : null;
      const focusedState = () => document.activeElement === e || e.contains(document.activeElement) || (focusTarget instanceof HTMLElement && document.activeElement === focusTarget);
      const focusedBefore = focusedState();
      const visiblePopups = () => Array.from(document.querySelectorAll('[role="listbox"],[role="menu"],[role="dialog"]'))
        .filter(node => visible(node) && node.querySelector('[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]'));
      const visibleOptions = () => Array.from(document.querySelectorAll('[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]'))
        .filter(visible);
      // A modal (Classroom's composer, a settings sheet) is a visible effect of
      // the click even though it exposes no options, so it is not part of the
      // expansion count. Track it separately and only when it appears.
      const dialogCount = () => Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).filter(visible).length;
      const dialogsBefore = dialogCount();
      const popupsBefore = visiblePopups().length;
      // Custom selects (Google Forms, Material menus) often portal their
      // options into a plain div with no listbox/menu role, or leave the
      // trigger without aria-expanded. A newly visible option set is the
      // observable expansion effect in those widgets, so count options too.
      const optionsBefore = visibleOptions().length;
      const expandedState = () => {
        if (e.isConnected) {
          if (e.getAttribute('aria-expanded') === 'true') return true;
          if (e.closest('[aria-expanded="true"]')) return true;
          const ids = [e, e.parentElement, e.closest('[role="combobox"],[role="listbox"],[role="button"]')]
            .filter(Boolean)
            .flatMap(node => (node.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean));
          if (ids.some(id => visible(e.ownerDocument.getElementById(id)))) return true;
        }
        // A portal menu can live outside the trigger. Count only popups that
        // actually expose options, and only treat a new one as this click's effect.
        if (visiblePopups().length > popupsBefore) return true;
        return visibleOptions().length > optionsBefore;
      };
      const optionName = accessibleName(e);
      // A Material-style select replaces the chosen option when its menu
      // closes: the clicked node detaches and the control's collapsed trigger
      // (which is itself often a role=option inside a *closed* listbox) starts
      // showing the new value. Excluding every listbox made selection succeed
      // while the receipt still reported an unverified outcome. Exclude only
      // popups that are actually open, and require the exact visible name once.
      const insideOpenPopup = node => {
        const popup = node.closest('[role="listbox"],[role="menu"],[role="dialog"]');
        if (!popup) return false;
        if (popup.getAttribute('aria-expanded') === 'true') return true;
        return !!popup.closest('[aria-expanded="true"]');
      };
      const selectionElsewhere = () => !!optionName && Array.from(document.querySelectorAll('[role="option"],[role="combobox"],[aria-haspopup="listbox"],[aria-haspopup="menu"]'))
        .filter(node => node !== e && node.isConnected && visible(node)
          && !insideOpenPopup(node)
          && accessibleName(node) === optionName).length === 1;
      const selectedState = () => {
        if (e.isConnected) {
          const role = e.getAttribute('role');
          if (['radio', 'checkbox', 'switch', 'menuitemradio', 'menuitemcheckbox'].includes(role)) {
            if (e.getAttribute('aria-checked') === 'true' || (e instanceof HTMLInputElement && e.checked)) return true;
          } else {
            if (e.getAttribute('aria-selected') === 'true' || e.getAttribute('aria-checked') === 'true') return true;
            if (e.closest('[aria-selected="true"],[aria-checked="true"]')) return true;
            const label = e.closest('label');
            if (label instanceof HTMLLabelElement && label.control && label.control.checked) return true;
          }
        }
        // A custom select often removes the chosen listbox option and updates a
        // separate trigger instead. The trigger showing the exact option name is
        // the durable postcondition for that control pattern.
        return selectionElsewhere();
      };
      const expandedBefore = expandedState(), selectedBefore = selectedState();
      let selectedSeen = selectedBefore;
      let observer = null;
      try {
        observer = new MutationObserver(() => {
          if (selectedState()) selectedSeen = true;
        });
        // The clicked option is often replaced when a menu closes, so watch
        // the document rather than only the node that received the click.
        observer.observe(e.ownerDocument.documentElement, {
          subtree: true, childList: true, attributes: true,
          attributeFilter: ['aria-selected', 'aria-checked', 'aria-expanded', 'class', 'data-selected'],
        });
      } catch (_) {}
      try {
        dispatched = true;
        if (action === 'context_click') e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, view: window }));
        else {
          try { focusTarget?.focus({ preventScroll: true }); } catch (_) {}
          e.click();
          if (action === 'double_click') {
            e.click();
            e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2, view: window }));
          }
        }
      } finally { e.removeEventListener(eventType, mark); }
      // React-style widgets apply the visible state after the click handler
      // returns. Read the postcondition for a bounded moment instead of
      // returning the pre-render state and reporting an open menu as unknown.
      return new Promise(resolve => {
        const started = Date.now();
        const wantsSelection = outcomeKind === 'selected';
        const wantsExpansion = outcomeKind === 'expanded';
        // An undeclared outcome only needs the event itself. Waiting the old
        // 900 ms generic-change budget made every dialog/button click feel
        // synchronous even though `ok` was already known. Declared selection
        // and expansion outcomes keep the bounded settle window.
        // An undeclared outcome never waits here: the runtime only polls for a
        // late dialog when the click produced no other observable change, so a
        // click that already has evidence stays fast.
        const budget = wantsSelection || wantsExpansion ? 2600 : 0;
        const finish = () => {
          if (selectedState()) selectedSeen = true;
          const expanded = expandedState(), selected = selectedSeen, focused = focusedState();
          const dialogOpened = dialogCount() > dialogsBefore;
          const changed = expanded !== expandedBefore || selected !== selectedBefore || focused !== focusedBefore;
          const elapsed = Date.now() - started;
          // A selection is only proven once the collapsed control (or the
          // option still in the list) shows the chosen name. A menu closing
          // first is not the postcondition; keep observing for it.
          const settled = wantsSelection ? selected : changed || dialogOpened;
          if (!settled && elapsed < budget) { setTimeout(finish, 40); return; }
          if (observer) observer.disconnect();
          resolve({ ok: eventSeen, dispatched, event_seen: eventSeen, rebound,
            expanded_after: expanded, selected_after: selected, focused_after: focused,
            expanded_before: expandedBefore, selected_before: selectedBefore, focused_before: focusedBefore,
            dialog_opened: dialogOpened, dialogs_before: dialogsBefore,
            transport: 'dom_activation', trusted_input: false });
        };
        setTimeout(finish, 40);
      });
    }
    // Synthetic key events do not perform browser default actions (Enter/Tab).
    // Route these through trusted key input instead of claiming an effect.
    return refuse(action === 'press' ? 'trusted_key_route_required' : 'unsupported_background_action');
  } catch (_) {
    return { ok: false, dispatched, reason: dispatched ? 'background_effect_uncertain' : 'background_preflight_failed', rebound };
  }
}
