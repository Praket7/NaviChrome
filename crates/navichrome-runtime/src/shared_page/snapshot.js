function(q) {
  const epochKey = Symbol.for('navichrome.interactionEpoch.v1');
  if (!window[epochKey]) {
    const state = {semantic: 0};
    Object.defineProperty(window, epochKey, {value: state, configurable: false});
    new MutationObserver(() => { state.semantic++; }).observe(document, {
      subtree: true, childList: true, attributes: true, characterData: true
    });
  }
  const epochState = window[epochKey];
  const interactionEpoch = () => {
    const active = document.activeElement;
    const focus = active ? JSON.stringify([
      active.tagName, active.id || '', active.getAttribute('name') || '',
      active.getAttribute('role') || '', active.getAttribute('aria-label') || ''
    ]) : '';
    let selection = '';
    if (active && typeof active.selectionStart === 'number') {
      selection = JSON.stringify([active.selectionStart, active.selectionEnd, active.selectionDirection || 'none']);
    } else {
      const current = window.getSelection?.();
      if (current) selection = JSON.stringify([
        current.anchorNode?.nodeType, current.anchorOffset,
        current.focusNode?.nodeType, current.focusOffset, current.isCollapsed
      ]);
    }
    const viewport = JSON.stringify([
      innerWidth, innerHeight, scrollX, scrollY,
      visualViewport?.width, visualViewport?.height,
      visualViewport?.offsetLeft, visualViewport?.offsetTop, visualViewport?.scale
    ]);
    return {semantic_revision: epochState.semantic, focus, selection, viewport};
  };
  // Scope selectors follow the composed tree: app shells (Google Drive, Docs
  // pickers) keep their menus and toolbars inside shadow roots, where a light
  // document query finds nothing and the failure surfaced as an opaque
  // "page evaluation omitted value". Say exactly what matched instead.
  const scopeSelector = q.selector || 'html';
  // Reach every element under `start`, composed tree included: app shells keep
  // menus, toolbars, and dialogs inside shadow roots, where a light query
  // finds nothing.
  const composedAll = (start, selector) => {
    const out = [];
    const visit = node => {
      for (const el of node.querySelectorAll(selector)) out.push(el);
      for (const el of node.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(start);
    return out;
  };
  const scopeMatches = selector => composedAll(document, selector);
  const roots = scopeMatches(scopeSelector);
  if (roots.length === 0) throw Error(`snapshot selector matched no element: ${scopeSelector}`);
  if (roots.length !== 1) throw Error(`snapshot selector matched ${roots.length} elements; narrow it: ${scopeSelector}`);
  let root = roots[0];
  if (q.goal?.within) {
    const {tag,id} = q.goal.within;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(tag) || typeof id !== 'string' || !id || id.length > 256) throw Error('invalid semantic ancestor scope');
    const candidates = Array.from(root.querySelectorAll(tag)).filter(e => e.id === id || e.getAttribute('data-id') === id);
    if (candidates.length !== 1) throw Error('semantic ancestor scope is not unique');
    root = candidates[0];
  }
  const nodes = [], items = [];
  const protectedSelector = '[data-masked],[data-requires-trusted],input[type="password"],input[type="file"],input[type="hidden"]';
  // Realm-independent DOM checks: a page can hand an element from another
  // document or execution world (embed editors do), where `instanceof` against
  // this world's constructors is false even though the node is a real input.
  const tagOf = e => e && typeof e.tagName === 'string' ? e.tagName.toUpperCase() : '';
  const isCredentialInput = e => tagOf(e) === 'INPUT' && e.type === 'password';
  const composedClosest = (e, selector) => {
    for (let n=e, depth=0; n && depth<16; n=n.parentElement || n.getRootNode()?.host, depth++) {
      if (n.matches?.(selector)) return n;
    }
    return null;
  };
  const trustedText = e => e?.hasAttribute('data-requires-trusted') && (tagOf(e) === 'TEXTAREA' || tagOf(e) === 'INPUT' && ['text','search','email','url','tel'].includes(e.type));
  const richEditor = e => !!e && e.nodeType === 1 && typeof e.getAttribute === 'function' && tagOf(e) !== 'INPUT' && tagOf(e) !== 'TEXTAREA' && e.getAttribute('aria-readonly') !== 'true' && e.getAttribute('contenteditable')?.toLowerCase() !== 'false' && (e.isContentEditable === true || e.getAttribute('role') === 'textbox');
  // The text a person wrote in a rich editor, without the editor's decoration.
  // Gmail keeps an inline "Tab to improve / Esc to dismiss" affordance inside
  // the editable element, so innerText reports text the user never typed; a
  // caller that read it back as the field's value then sent a stale expectation
  // on the next keystroke. Skip non-editable and hidden subtrees, and keep the
  // block line breaks innerText would have produced.
  const NL = String.fromCharCode(10), NBSP = String.fromCharCode(160);
  const BLOCK_TAGS = new Set(['DIV','P','LI','UL','OL','BLOCKQUOTE','PRE','H1','H2','H3','H4','H5','H6','TABLE','TR','SECTION','ARTICLE','HEADER','FOOTER','FIGURE','FIGCAPTION']);
  const richTextOf = e => {
    let out = '';
    const walk = node => {
      if (!node) return;
      if (node.nodeType === 3) { out += String(node.nodeValue || '').split(NBSP).join(' '); return; }
      if (node.nodeType !== 1) return;
      const tag = String(node.tagName || '').toUpperCase();
      if (tag === 'BR') { out += NL; return; }
      if (tag === 'SCRIPT' || tag === 'STYLE') return;
      if (node.getAttribute('contenteditable') === 'false' || node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('hidden')) return;
      const block = BLOCK_TAGS.has(tag);
      if (block && out && !out.endsWith(NL)) out += NL;
      for (const child of node.childNodes) walk(child);
      if (block && !out.endsWith(NL)) out += NL;
    };
    for (const child of e.childNodes) walk(child);
    while (out.endsWith(NL)) out = out.slice(0, -1);
    return out;
  };
  const editableText = e => { const text = richTextOf(e); return /^\s*$/.test(text) ? '' : text; };
  const readable = e => {
    if (!e || composedClosest(e, '[data-masked],input[type="file"],input[type="hidden"]') || e.querySelector(protectedSelector)) return false;
    const trusted = composedClosest(e, '[data-requires-trusted]');
    return !trusted || trusted === e && trustedText(e);
  };
  const presentation = (e, geometry) => {
    // Geometry is reused only within this synchronous collection pass. Retained
    // callers omit it, so action guards always read fresh layout.
    const s = e.ownerDocument.defaultView.getComputedStyle(e), b = geometry || e.getBoundingClientRect();
    const present = e.isConnected;
    const rendered = present && b.width > 0 && b.height > 0 && s.visibility === 'visible' && s.display !== 'none' && Number.parseFloat(s.opacity || '1') > 0 && !composedClosest(e, '[hidden],[inert],[aria-hidden="true"]');
    const view = e.ownerDocument.defaultView;
    const inViewport = rendered && b.right > 0 && b.bottom > 0 && b.left < view.innerWidth && b.top < view.innerHeight;
    // ARIA communicates state to assistive technology; it does not suppress
    // pointer events. Some apps (including Classroom's upload picker) leave
    // aria-disabled=true on a control that still opens its picker. Preserve
    // both signals so the caller can distinguish an actual native disable
    // from a possibly stale ARIA annotation.
    const nativeDisabled = e.matches(':disabled');
    const ariaDisabled = e.getAttribute('aria-disabled') === 'true';
    const disabled = nativeDisabled;
    const pointerEventsNone = s.pointerEvents === 'none';
    const actionability = !rendered ? 'not_rendered' : disabled ? 'disabled' : pointerEventsNone ? 'pointer_blocked' : inViewport ? 'candidate' : 'offscreen';
    return {present,rendered,in_viewport:!!inViewport,disabled,native_disabled:nativeDisabled,aria_disabled:ariaDisabled,pointer_events_none:pointerEventsNone,actionability};
  };
  const raw = e => isCredentialInput(e) ? null : /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) ? e.value : richEditor(e) ? editableText(e) : (e.innerText ?? '');
  const name = e => {
    const labelled = (e.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => { const label=e.getRootNode().getElementById?.(id) || e.ownerDocument.getElementById(id); return readable(label) ? label.innerText : ''; }).join(' ').trim();
    if (isCredentialInput(e)) {
      const labels = Array.from(e.labels || []).filter(label => !composedClosest(label, '[data-masked]')).map(label => label.innerText).join(' ').trim();
      return (labelled || e.getAttribute('aria-label') || labels || e.getAttribute('title') || '').replace(/\s+/g,' ').trim();
    }
    return (labelled || e.getAttribute('aria-label') || e.innerText || e.getAttribute('alt') || Array.from(e.labels || []).filter(readable).map(l => l.innerText).join(' ') || e.getAttribute('title') || '').replace(/\s+/g,' ').trim();
  };
  const datetimeOf = e => {
    if (e.getAttribute && e.getAttribute('datetime')) return e.getAttribute('datetime');
    const ancestor = e.closest('article,section,[data-section],li');
    if (ancestor) {
      const t = ancestor.querySelector('time[datetime]');
      if (t) return t.getAttribute('datetime');
      const meta = ancestor.querySelector('meta[itemprop="datePublished"][content],meta[property="article:published_time"][content]');
      if (meta) return meta.getAttribute('content');
      const d = ancestor.getAttribute('data-datetime') || ancestor.getAttribute('data-timestamp') || ancestor.getAttribute('data-date') || ancestor.getAttribute('data-published');
      if (d) return d;
    }
    const siblingTime = e.parentElement ? e.parentElement.querySelector('time[datetime]') : null;
    if (siblingTime) return siblingTime.getAttribute('datetime');
    return null;
  };
  const fileSizeOf = e => {
    const raw = e.getAttribute?.('data-file-size') || e.getAttribute?.('data-size');
    if (typeof raw !== 'string' || raw.length > 16 || !/^(0|[1-9]\d*)$/.test(raw)) return null;
    const size = Number(raw);
    return Number.isSafeInteger(size) ? size : null;
  };
  const freshnessTextOf = e => {
    const card = e.closest('article,li,[data-card],[role="article"]') || e.parentElement;
    if (!readable(card)) return null;
    const labelled = [...card.querySelectorAll('time,[data-testid*="time" i],[class*="time" i],[aria-label]')]
      .map(node => node.getAttribute('datetime') || node.getAttribute('aria-label') || node.innerText || node.textContent || '')
      .join(' ');
    const text = `${labelled} ${card.innerText || ''}`.replace(/\s+/g, ' ').trim();
    const match = text.match(/(?:^|[\s•·])((?:\d{1,3}\s*(?:m|min|minutes?|h|hr|hours?|d|days?|w|weeks?))(?:\s+ago)?)(?=$|[\s•·])/i);
    return match?.[1]?.trim() || null;
  };
  const sectionOf = e => {
    const s = e.closest('section,[data-section],article,nav,main');
    if (!s) return null;
    return s.getAttribute('data-section') || s.getAttribute('aria-label') || s.tagName.toLowerCase();
  };
  const semanticAncestor = e => {
    const a = e.closest('article,li,[role="article"],[data-card],section');
    if (!a) return null;
    return {tag: a.tagName.toLowerCase(), id: a.getAttribute('data-id') || a.getAttribute('id') || null};
  };
  const domPathFingerprint = e => {
    let cur = e, parts = [], depth = 0;
    while (cur && cur !== root && depth < 5) {
      const tag = cur.tagName ? cur.tagName.toLowerCase() : '';
      const idx = cur.parentElement ? Array.prototype.indexOf.call(cur.parentElement.children, cur) : 0;
      parts.unshift(tag+':'+idx);
      cur = cur.parentElement; depth++;
    }
    return parts.join('>');
  };
  const rectBucket = b => ({w: Math.round(b.width/50)*50, h: Math.round(b.height/50)*50, x: Math.round(b.left/100)*100, y: Math.round(b.top/100)*100});
  // "Visible" must mean the user can see it. Google Docs and Drive preload
  // their file picker offscreen (or aria-hidden) long before it is opened; a
  // box that merely has non-zero size made that dormant shell look like the
  // active modal, stole the modal-first scan budget, and leaked its text into
  // every snapshot of the document.
  const visibleNode = node => {
    if (!node?.isConnected) return false;
    if (composedClosest(node, '[aria-hidden="true"],[hidden],[inert]')) return false;
    const rect = node.getBoundingClientRect(), style = node.ownerDocument.defaultView.getComputedStyle(node);
    const view = node.ownerDocument.defaultView;
    const onScreen = rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < view.innerWidth && rect.top < view.innerHeight;
    return onScreen && style.display !== 'none' && style.visibility === 'visible' && Number.parseFloat(style.opacity || '1') > 0;
  };
  // A control inside a visible modal is the page the user is looking at. The
  // background behind it is inert for a person, and its controls are usually
  // far more numerous, so they must not push the dialog out of a bounded
  // response. Return the modal's controls first and label them.
  const modalScope = e => {
    const modal = composedClosest(e, '[role="dialog"],[aria-modal="true"]');
    return modal && visibleNode(modal) ? modal : null;
  };
  // Modal subtrees are scanned before the rest of the document. Collection is
  // byte-bounded and stops in DOM order, so a dialog appended at the end of the
  // page (Gmail's composer, Classroom's announcement editor) used to be cut off
  // by the header chrome that precedes it and looked invisible to every caller.
  // Sampling the dialog first, then skipping its nodes in the main pass, keeps
  // the response prefix equal to what the user is actually looking at.
  const visibleModalRoots = () => {
    const all = composedAll(root, '[role="dialog"],[aria-modal="true"]').filter(visibleNode);
    // Keep only the outermost visible dialog: a nested dialog is inside it and
    // would otherwise contribute the same controls twice.
    return all.filter(modal => !all.some(other => other !== modal && other.contains(modal))).slice(0, 3);
  };
  const visibleModalCount = () => {
    let count = 0;
    for (const modal of composedAll(root, '[role="dialog"],[aria-modal="true"]')) {
      if (visibleNode(modal)) count++;
    }
    return count;
  };
  // Expansion can live on the control or on its listbox host. Prefer the
  // nearest explicit ARIA state, then a controlled popup that is actually
  // visible. A collapsed menu and an open one must not look identical.
  const expandedOf = e => {
    const own = e.getAttribute('aria-expanded');
    if (own !== null) return own;
    const host = e.closest('[aria-expanded]');
    if (host) return host.getAttribute('aria-expanded');
    const ids = [e, e.parentElement, e.closest('[role="combobox"]')]
      .filter(Boolean)
      .flatMap(node => (node.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean));
    for (const id of ids) if (visibleNode(e.ownerDocument.getElementById(id))) return 'true';
    return null;
  };
  // aria-selected belongs to options and tabs; radios and checkboxes expose
  // their checked state through aria-checked or the native control. Google
  // Forms marks every rating option aria-selected=true, so preferring it for
  // radios falsely reports the whole group as selected.
  const selectedOf = (e, role) => {
    const native = e instanceof HTMLInputElement && (e.type === 'checkbox' || e.type === 'radio')
      ? (e.checked ? 'true' : 'false') : null;
    if (['radio', 'checkbox', 'switch', 'menuitemradio', 'menuitemcheckbox'].includes(role)) return e.getAttribute('aria-checked') ?? native;
    return e.getAttribute('aria-selected') ?? e.getAttribute('aria-checked') ?? native;
  };
  const selector = 'a[href],button,input,textarea,select,summary,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="button"],[role="link"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="tab"],[role="combobox"],[role="option"],[draggable="true"],[data-draggable="true"],[data-drop-target="true"],[aria-dropeffect]';
  let scanned = 0, truncated = false, bytes = 0, omitted_by_limit = 0, omitted_oversized = 0, early_stopped = false, goal_satisfied = false, goal_score = 0;
  let goal_exact_matches = 0, goal_exact_kept = 0;
  let truncation_reason = null;
  const goalQuery = q.goal?.query?.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g,' ').trim() || '';
  const goalTerms = new Set(goalQuery.split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 2));
  const goalRoles = Array.isArray(q.goal?.roles) ? new Set(q.goal.roles) : null;
  const maxScanNodes = Number.isSafeInteger(q.max_scan_nodes) ? Math.max(1, Math.min(65536, q.max_scan_nodes)) : 65536;
  const encoder = new TextEncoder();
  let shadow_roots_seen = 0, iframes_seen = 0, cross_origin_frames_unread = 0, same_origin_frames_read = 0, same_origin_frames_pending = 0, blank_frames_seen = 0;
  const modalRoots = visibleModalRoots();
  // A dialog that is present but offscreen or aria-hidden is dormant app shell,
  // not something the user can reach. Walk it once into a set so the main pass
  // can skip it without charging its nodes against the scan budget.
  const dormantCovered = new WeakSet();
  for (const modal of composedAll(root, '[role="dialog"],[aria-modal="true"]')) {
    if (visibleNode(modal)) continue;
    const dormantWalker = modal.ownerDocument.createTreeWalker(modal, NodeFilter.SHOW_ELEMENT);
    let dormantNode = modal;
    while (dormantNode) { dormantCovered.add(dormantNode); dormantNode = dormantWalker.nextNode(); }
  }
  const inDormantModal = node => {
    const dialog = composedClosest(node, '[role="dialog"],[aria-modal="true"]');
    return !!dialog && dormantCovered.has(dialog);
  };
  const modalCovered = new WeakSet();
  const scopes = modalRoots.map(modal => ({root: modal, frame:'main', kind:'light', depth:0, owner:null, modal:true}));
  scopes.push({root, frame:'main', kind:'light', depth:0, owner:null, modal:false});
  // A shadow root or iframe body reached from a modal is already covered; the
  // main pass must not enqueue it a second time.
  const enqueuedRoots = new Set(modalRoots);
  const enqueue = scope => {
    if (enqueuedRoots.has(scope.root)) return false;
    if (enqueuedRoots.size >= 64) {
      truncated = true;
      truncation_reason = truncation_reason || 'nested_scope_limit';
      return false;
    }
    enqueuedRoots.add(scope.root);
    scopes.push(scope);
    return true;
  };
  for (let scopeIndex = 0; scopeIndex < scopes.length; scopeIndex++) {
    const scope = scopes[scopeIndex], walker = scope.root.ownerDocument.createTreeWalker(scope.root, NodeFilter.SHOW_ELEMENT);
    let e = scope.root.nodeType === Node.ELEMENT_NODE ? scope.root : walker.nextNode();
    while (e) {
    if (!scope.modal && dormantCovered.has(e)) { e = walker.nextNode(); continue; }
    if (scanned >= maxScanNodes) { truncated = true; truncation_reason = 'scanned_nodes_exceeded'; break; }
    scanned++;
    if (scope.modal) modalCovered.add(e);
    else if (modalCovered.has(e)) { e = walker.nextNode(); continue; }
    if (e.shadowRoot) {
      shadow_roots_seen++;
      if (scope.depth < 16) enqueue({root:e.shadowRoot,frame:scope.frame,kind:'shadow',depth:scope.depth+1,owner:null,modal:scope.modal});
      else { truncated = true; truncation_reason = truncation_reason || 'nested_scope_limit'; }
    }
    if (e.tagName === 'IFRAME') {
      iframes_seen++;
      try {
        const doc = e.contentDocument;
        // A preloaded but offscreen frame is not reachable by a person and can
        // be far larger than the page itself. Scanning it first exhausted the
        // node budget before the visible document was read.
        const frameVisible = visibleNode(e);
        if (!frameVisible) {
          if (doc?.location.href === 'about:blank') blank_frames_seen++;
        } else if (!doc) {
          cross_origin_frames_unread++;
        } else if (!doc.body) {
          same_origin_frames_pending++;
        } else if (doc.location.href !== 'about:blank') {
          if (scope.depth < 16) {
            if (enqueue({root:doc.body,frame:scope.frame+'/iframe['+iframes_seen+']',kind:'same_origin_frame',depth:scope.depth+1,owner:e,modal:scope.modal})) same_origin_frames_read++;
          } else { truncated = true; truncation_reason = truncation_reason || 'nested_scope_limit'; }
        } else {
          const src = e.getAttribute('src');
          if (src && src !== 'about:blank' && new URL(src, location.href).origin === location.origin) same_origin_frames_pending++;
          else if (src && src !== 'about:blank') cross_origin_frames_unread++;
          else if (doc.body.children.length) {
            if (scope.depth < 16) {
              if (enqueue({root:doc.body,frame:scope.frame+'/iframe['+iframes_seen+']',kind:'same_origin_blank_frame',depth:scope.depth+1,owner:e,modal:scope.modal})) same_origin_frames_read++;
            } else { truncated = true; truncation_reason = truncation_reason || 'nested_scope_limit'; }
          } else blank_frames_seen++;
        }
      } catch (_) { cross_origin_frames_unread++; }
    }
    if (e.matches(selector) && (!q.href_hint || e.tagName === 'A' && e.href.includes(q.href_hint)) && readable(e)) {
      const role = e.getAttribute('role') || (richEditor(e) ? 'textbox' : ({A:'link',BUTTON:'button',INPUT:'input',TEXTAREA:'textbox',SELECT:'combobox',SUMMARY:'button'}[e.tagName] || 'control'));
      if (goalRoles && !goalRoles.has(role) || q.goal?.href_hint && !(e.tagName === 'A' && e.href.includes(q.goal.href_hint))) { e = walker.nextNode(); continue; }
      const b = e.getBoundingClientRect();
      const state = presentation(e, b);
      const frameRelay = !state.rendered
        && scope.kind === 'same_origin_blank_frame'
        && richEditor(e)
        && (!goalRoles || goalRoles.has('textbox'))
        && e.isContentEditable === true;
      if (!state.rendered && !frameRelay) { e = walker.nextNode(); continue; }
      if (items.length >= q.max_items && !q.goal) { omitted_by_limit++; truncated = true; truncation_reason = truncation_reason || 'max_items'; e = walker.nextNode(); continue; }
      const credential = isCredentialInput(e), value = raw(e), label = name(e);
      if (typeof value === 'string' && value.length > 16384 || label.length > 2000) { omitted_oversized++; truncated = true; truncation_reason = truncation_reason || 'oversized_value'; e = walker.nextNode(); continue; }
      const datetime = datetimeOf(e);
      const parsedTime = datetime && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(datetime) ? Date.parse(datetime) : NaN;
      const dateOnly = typeof datetime === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(datetime);
      // Date-only publication dates have no timezone; UTC-12 can extend 12 hours into the following UTC day.
      const freshnessUpperBound = dateOnly ? Date.UTC(Number(dateOnly[1]), Number(dateOnly[2])-1, Number(dateOnly[3])+1, 12)-1 : null;
      const exactInstant = typeof datetime === 'string' && /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(datetime);
      const rich = richEditor(e), editable = rich || e instanceof HTMLTextAreaElement || e instanceof HTMLInputElement && ['text','search','email','url','tel'].includes(e.type);
      // Canvas-backed editors (Google Docs and similar) paint their text, so the
      // editable element's DOM text does not track what the user types. Say so on
      // the item: the runtime must not demand a value precondition it cannot
      // observe, and the type path must verify against the document text instead.
      const paintsCanvas = node => { try { return !!node.querySelector && !!node.querySelector('canvas,[class*="canvas-tile"],[data-canvas-content]'); } catch (_) { return false; } };
      const canvasHost = rich && (() => { if (paintsCanvas(e)) return true; for (let p = e.parentElement, depth = 0; p && depth < 3; p = p.parentElement, depth += 1) if (paintsCanvas(p)) return true; return false; })();
      const valueReadable = !rich || !(scope.kind === 'same_origin_blank_frame' || canvasHost);
      const feedbackRegion = e.closest('[role="alert"],[role="status"],[role="log"],[aria-live]') !== null;
      const inModal = modalScope(e) !== null;
      const item = {reference:q.token+':'+items.length,tag:e.tagName.toLowerCase(),in_modal:inModal,id:e.id || null,size:fileSizeOf(e),role,name:label,text:label,raw_value:value,...state,feedback_region:feedbackRegion,editable_kind:rich?'rich_text':editable?'plain_text':null,credential_input:credential,requires_user_input:credential,multiline:rich||e.tagName==='TEXTAREA'||e.getAttribute('aria-multiline')==='true',control_type:typeof e.type==='string'?e.type:null,multiple:'multiple'in e?e.multiple===true:null,min:e.getAttribute('min'),max:e.getAttribute('max'),step:e.getAttribute('step'),hover_reveals:e.getAttribute('data-hover-reveals')==='true'||e.hasAttribute('data-hover-reveals'),draggable:e.draggable===true||e.getAttribute('data-draggable')==='true',drop_target:e.getAttribute('data-drop-target')==='true'||e.getAttribute('aria-dropeffect')==='move',widget_kind:e.getAttribute('data-widget-kind'),href:e.tagName === 'A' ? e.href : null,target:e.tagName === 'A' ? e.getAttribute('target') : null,rel:e.tagName === 'A' ? e.getAttribute('rel') : null,expanded:expandedOf(e),selected:selectedOf(e,role),controls_selector:e.getAttribute('aria-controls')?.split(/\s+/).filter(Boolean).map(id=>'#'+CSS.escape(id)).join(',') || null,datetime,test_id:e.getAttribute('data-testid') || e.getAttribute('data-test') || e.getAttribute('data-qa') || null,datetime_utc_ms:exactInstant && Number.isFinite(parsedTime)?parsedTime:null,datetime_precision:exactInstant?'instant':dateOnly?'date':null,freshness_upper_bound_ms:Number.isFinite(freshnessUpperBound)?freshnessUpperBound:null,section:sectionOf(e),semantic_ancestor:semanticAncestor(e),dom_path_fingerprint:domPathFingerprint(e),rect_bucket:rectBucket(b),bounds:scope.frame==='main'?{x:b.left+e.ownerDocument.defaultView.scrollX,y:b.top+e.ownerDocument.defaultView.scrollY,width:b.width,height:b.height}:null,source_frame:scope.frame,source_frame_revision:String(e.ownerDocument.defaultView.performance.timeOrigin),source_frame_url:String(e.ownerDocument.location.href).slice(0,512),source_kind:scope.kind,source_frame_owner:scope.owner?{tag:'iframe',id:scope.owner.id||null,class:typeof scope.owner.className==='string'?scope.owner.className||null:null,name:scope.owner.getAttribute('name')||null,src:(scope.owner.getAttribute('src')||'').slice(0,512)||null}:null,hidden_editor:!state.rendered,value_readable:valueReadable};
      // Remember the semantic signature on the retained node. Framework
      // rerenders replace the element between snapshot and action; the old node
      // still carries this identity, so the background action can rebind to the
      // one visible live control with the same role, name, and context.
      try {
        Object.defineProperty(e, '__navichromeIdentity', { configurable: true, value: {
          tag: item.tag, role: item.role, name: item.name, href: item.href,
          type: item.control_type, test_id: item.test_id, id: item.id,
          path: item.dom_path_fingerprint, section: item.section
        }});
      } catch (_) {}
      let exact_goal_match = false;
      let queryScore = 0;
      if (q.goal) {
        const normalize = text => text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g,' ').trim();
        const candidateText = normalize(label+' '+(typeof value === 'string' ? value : ''));
        const candidateTerms = new Set(candidateText.split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 2));
        const overlap = [...goalTerms].reduce((count, term) => count + (candidateTerms.has(term) ? 1 : 0), 0);
        queryScore = !goalQuery ? 0
          : normalize(label) === goalQuery || typeof value === 'string' && normalize(value) === goalQuery ? 100
          : candidateText.includes(goalQuery) ? 60
          : goalTerms.size ? Math.round(60 * overlap / goalTerms.size) : 0;
        const roleScore = (!goalRoles ? 0 : goalRoles.has(item.role) ? 40 : -1000) + (state.rendered ? 0 : -20);
        const hrefScore = !q.goal.href_hint ? 0 : item.href?.includes(q.goal.href_hint) ? 30 : -1000;
        if (roleScore < 0 || hrefScore < 0) { e = walker.nextNode(); continue; }
        exact_goal_match = normalize(label) === goalQuery || typeof value === 'string' && normalize(value) === goalQuery;
        if (exact_goal_match) goal_exact_matches++;
        item.goal_score = queryScore + roleScore + hrefScore;
        goal_score = Math.max(goal_score, item.goal_score);
        if (!goalQuery || queryScore === 100) goal_satisfied = true;
      }
      if ((q.href_hint || q.goal?.href_hint) && e.tagName === 'A') {
        const context = e.closest('article,li,[data-card]') || e.parentElement;
        item.context_text = readable(context) ? (context.innerText || '').replace(/\s+/g,' ').slice(0,320) : null;
        item.freshness_text = freshnessTextOf(e);
        item.freshness_observed_at_ms = item.freshness_text ? Date.now() : null;
        const group = e.closest('section,[role="feed"],[role="list"]');
        const heading = group?.querySelector('h1,h2,h3,[role="heading"]');
        item.group_heading = readable(heading) ? heading.innerText.replace(/\s+/g,' ').slice(0,120) : null;
      }
      if (trustedText(e)) item.requires_trusted_events = true;
      const size = encoder.encode(JSON.stringify(item)).length;
      if (q.goal) {
        // Keep the best-ranked candidates even when early DOM content fills the
        // item/byte budget. Scan remains bounded by maxScanNodes; omitted items
        // keep coverage partial so a ranked prefix is never treated as exhaustive.
        const byteBudget = q.max_bytes - q.max_text_chars * 6 - 2048;
        let projectedItems = items.length + 1;
        let projectedBytes = bytes + size;
        const evictions = [];
        const lowerRanked = items.map((candidate, index) => ({candidate, index, size:encoder.encode(JSON.stringify(candidate)).length}))
          .filter(entry => (entry.candidate.goal_score || 0) < (item.goal_score || 0))
          .sort((a,b)=>(a.candidate.goal_score||0)-(b.candidate.goal_score||0)||b.size-a.size||b.index-a.index);
        while ((projectedItems > q.max_items || projectedBytes > byteBudget) && lowerRanked.length) {
          const evicted = lowerRanked.shift();
          evictions.push(evicted);
          projectedItems--;
          projectedBytes -= evicted.size;
        }
        if (projectedItems <= q.max_items && projectedBytes <= byteBudget) {
          if (evictions.length) {
            omitted_by_limit += evictions.length;
            truncated = true;
            truncation_reason = truncation_reason || (items.length >= q.max_items ? 'max_items' : 'max_bytes');
          }
          for (const evicted of evictions.sort((a,b)=>b.index-a.index)) {
            bytes -= evicted.size;
            items.splice(evicted.index,1);
            nodes.splice(evicted.index,1);
          }
          items.push(item); nodes.push(e); bytes += size; if (exact_goal_match) goal_exact_kept++;
        } else {
          omitted_by_limit++; truncated = true;
          truncation_reason = truncation_reason || (projectedBytes > byteBudget ? 'max_bytes' : 'max_items');
        }
      } else {
        if (bytes + size > q.max_bytes - q.max_text_chars * 6 - 2048) {
          omitted_by_limit++; truncated = true; truncation_reason = truncation_reason || 'max_bytes';
          if (!q.goal) break;
          e = walker.nextNode(); continue;
        }
        bytes += size; nodes.push(e); items.push(item);
      }
      const exactTargetScore = (goalQuery ? 100 : 0) + (goalRoles ? 40 : 0) + (q.goal?.href_hint ? 30 : 0);
      // Exact semantic criteria reach the global score ceiling; viewport is actionability metadata, not a ranking bonus.
      if (q.goal && !q.goal.exhaustive && q.max_items === 1 && goal_score >= exactTargetScore) { early_stopped = true; truncated = true; truncation_reason = 'ranked_top_one'; break; }
    }
    e = walker.nextNode();
    }
    if (early_stopped || truncation_reason === 'scanned_nodes_exceeded' || truncation_reason === 'max_bytes' && !q.goal) break;
  }
  if (q.goal && items.length > 0) {
    // Ranked collection can evict every candidate except one; references must
    // always index the retained `nodes` array, including the single-item case,
    // or the runtime rejects the fresh reference as stale (index >= count).
    // Equal relevance is common for sibling story links. Prefer the fresher
    // bounded <time> signal before falling back to DOM order so a "latest"
    // goal does not rank an older article first merely because it appears first.
    const recencyMinutes = node => {
      const scope = node?.closest?.('article,li,[data-card]');
      const time = scope?.querySelector?.('time');
      const raw = (time?.getAttribute?.('datetime') || time?.textContent || '').trim();
      const relative = /^(\d+)\s*(m|h|d|w)\b/i.exec(raw);
      if (relative) {
        const unit = {m:1,h:60,d:1440,w:10080}[relative[2].toLowerCase()];
        return Number(relative[1]) * unit;
      }
      const instant = Date.parse(raw);
      return Number.isFinite(instant) ? Date.now() - instant : null;
    };
    const ranked = items.map((item,index)=>({item,node:nodes[index],index})).sort((a,b)=>(b.item.goal_score||0)-(a.item.goal_score||0)||((recencyMinutes(a.node) ?? Number.MAX_SAFE_INTEGER)-(recencyMinutes(b.node) ?? Number.MAX_SAFE_INTEGER))||a.index-b.index);
    items.splice(0,items.length,...ranked.map(entry=>entry.item));
    nodes.splice(0,nodes.length,...ranked.map(entry=>entry.node));
    for (let i=0;i<items.length;i++) items[i].reference=q.token+':'+i;
  }
  // Keep a modal's controls at the front of an unranked collection. The
  // response byte budget keeps a prefix, so without this a newly opened dialog
  // (always appended later in DOM order) was trimmed away and looked invisible.
  const modalCount = visibleModalCount();
  let modalFirst = false;
  const modalItems = items.reduce((count, item) => count + (item.in_modal === true ? 1 : 0), 0);
  if (!q.goal && modalItems > 0 && modalItems < items.length) {
    const order = items
      .map((item, index) => ({item, node: nodes[index], index}))
      .sort((a, b) => (b.item.in_modal === true) - (a.item.in_modal === true) || a.index - b.index);
    items.splice(0, items.length, ...order.map(entry => entry.item));
    nodes.splice(0, nodes.length, ...order.map(entry => entry.node));
    for (let i = 0; i < items.length; i++) items[i].reference = q.token + ':' + i;
    modalFirst = true;
  }
  let text='', textScanned=0, text_truncated=false;
  const maxTextNodes = q.max_text_chars > 0 ? (q.goal ? Math.min(maxScanNodes, 4096) : 65536) : 0;
  const textScopes = scopes.slice();
  if (q.goal && maxTextNodes) {
    for (const frame of root.querySelectorAll('iframe')) {
      try {
        const doc = frame.contentDocument;
        if (!visibleNode(frame)) continue;
        if (doc?.body && doc.location.href !== 'about:blank' && textScopes.length < 64 && !textScopes.some(scope => scope.root === doc.body)) {
          textScopes.push({root:doc.body,frame:'main/iframe[text]',kind:'same_origin_frame',depth:1});
        } else if (doc?.body && doc.location.href === 'about:blank' && doc.body.children.length && textScopes.length < 64 && !textScopes.some(scope => scope.root === doc.body)) {
          textScopes.push({root:doc.body,frame:'main/iframe[text]',kind:'same_origin_blank_frame',depth:1});
        }
      } catch (_) {}
    }
  }
  const visitedTextNodes = new Set();
  for (const scope of textScopes) {
    if (!maxTextNodes) break;
    const texts=scope.root.ownerDocument.createTreeWalker(scope.root,NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode=texts.nextNode())) {
      if (visitedTextNodes.has(textNode)) continue;
      visitedTextNodes.add(textNode);
      if (textScanned >= maxTextNodes) { text_truncated=true; break; }
      const p=textNode.parentElement;
      if (p && inDormantModal(p)) continue;
      textScanned++;
      if (p && !composedClosest(p,protectedSelector) && presentation(p).rendered) {
        const part=textNode.textContent.trim();
        if (part) {
          const separator=text?'\n':'';
          const remaining=q.max_text_chars+1-text.length;
          text+=separator+part.slice(0,Math.max(0,remaining-separator.length));
          if (separator.length+part.length>remaining || text.length>q.max_text_chars) { text_truncated=true; break; }
        }
      }
    }
    if (text_truncated) break;
  }
  // Exhaustive search controls how far we scan; it does not make a weakly
  // ranked candidate satisfy the requested semantic goal. Preserve the exact
  // query/role match result computed for each candidate above.
  const controls_complete = !truncated && omitted_by_limit === 0 && omitted_oversized === 0;
  const frames_complete = cross_origin_frames_unread === 0 && same_origin_frames_pending === 0;
  const text_requested = q.max_text_chars > 0;
  const text_complete = text_requested && !text_truncated && frames_complete;
  const complete = controls_complete && (!text_requested || text_complete) && frames_complete && !early_stopped;
  const incomplete_reasons = [];
  if (text_truncated) incomplete_reasons.push('text_truncated');
  if (early_stopped) incomplete_reasons.push(truncation_reason || 'targeted_early_stop');
  if (omitted_by_limit || truncation_reason === 'max_items' || truncation_reason === 'max_bytes') incomplete_reasons.push('item_or_byte_limit');
  if (omitted_oversized) incomplete_reasons.push('oversized_controls');
  if (truncation_reason === 'scanned_nodes_exceeded') incomplete_reasons.push('scanned_node_limit');
  if (truncation_reason === 'nested_scope_limit') incomplete_reasons.push('nested_scope_limit');
  if (cross_origin_frames_unread) incomplete_reasons.push('cross_origin_frames_unread');
  if (same_origin_frames_pending) incomplete_reasons.push('same_origin_frames_pending');
  const coverage = truncated || cross_origin_frames_unread || same_origin_frames_pending || text_truncated ? 'partial: '+(truncation_reason || (text_truncated ? 'text_truncated' : cross_origin_frames_unread ? 'cross_origin_frames_unread' : 'same_origin_frames_pending')) : (q.href_hint ? 'visible links matching href hint in reachable DOM and frames' : 'visible controls in light DOM, open shadow roots, and loaded same-origin frames in this scope');
  // An explicit first-party href scope intentionally excludes cross-origin
  // embed contents. Keep global coverage partial, but do not let an unrelated
  // unread embed invalidate a fully enumerated first-party link scope.
  const firstPartyHint = q.href_hint || q.goal?.href_hint;
  const first_party_complete = !!firstPartyHint && !truncated && !same_origin_frames_pending && items.every(item => { try { return new URL(item.href).origin === location.origin; } catch (_) { return false; } });
  // A goal-bearing scope covers the reachable DOM this runtime can act in.
  // Unread cross-origin frames are outside that scope: nothing can be resolved
  // or dispatched inside them, so an unrelated embed must not make every match
  // look ambiguous. They are reported as skipped, and remain a partial
  // coverage fact rather than a scope-completeness one.
  const scope_frames_complete = same_origin_frames_pending === 0;
  const cross_origin_frames_skipped = cross_origin_frames_unread;
  // A ranked goal scan still walks the reachable DOM when the response is
  // trimmed: lower-ranked candidates are omitted from the budget, not skipped
  // by the scan. If exactly one control carried the exact requested name and
  // that control survived retention, it is a unique target even though the
  // returned inventory is partial. Duplicate names keep the result unverified.
  const goal_exact_unique = !!q.goal && !!goalQuery && goal_exact_matches === 1 && goal_exact_kept === 1
    && !early_stopped && scope_frames_complete
    && truncation_reason !== 'scanned_nodes_exceeded' && truncation_reason !== 'nested_scope_limit';
  const scope_complete = firstPartyHint ? first_party_complete : q.goal ? (!truncated && !early_stopped && scope_frames_complete) || goal_exact_unique : complete;
  const target_uniqueness = scope_complete ? 'scope_complete' : 'unverified';
  for (const item of items) item.target_uniqueness = target_uniqueness;
  // Retained CDP object IDs die with the page's JS world or a replaced app
  // shell, which used to turn an ordinary Google Docs re-render into
  // stale_reference. Keep the nodes reachable from the page itself, keyed by
  // this snapshot's token, so the action path can re-materialize the exact
  // reference without a new snapshot. Only the four newest snapshots survive.
  try {
    const store = globalThis.__navichromeSnapshots || (globalThis.__navichromeSnapshots = Object.create(null));
    store[q.token] = nodes;
    const keys = Object.keys(store);
    for (const key of keys.slice(0, Math.max(0, keys.length - 4))) delete store[key];
  } catch (_) {}
  return {nodes,items,raw,name,presentation,visible:e=>presentation(e).rendered,public:{interaction_epoch:interactionEpoch(),url:location.href,title:document.title,ready_state:document.readyState,items,modal_count:modalCount,modal_items:modalItems,modal_first:modalFirst,text:text.slice(0,q.max_text_chars),text_requested,text_truncated,truncated:!complete,complete,global_complete:complete,completeness:{controls:controls_complete?'complete':'partial',text:text_complete?'complete':'partial',frames:frames_complete?'complete':'partial'},incomplete_reasons,goal_satisfied,goal_score:goal_satisfied?goal_score:null,goal_exact_matches,goal_exact_unique,scope_complete,coverage,coverage_scope:q.goal?'ranked_target':q.href_hint ? 'matching_first_party_links' : 'all_reachable_controls',first_party_complete,scanned_nodes:Math.min(scanned,maxScanNodes),scanned_text_nodes:textScanned,search_budget_exhausted:truncation_reason==='scanned_nodes_exceeded',omitted_by_limit,omitted_oversized,shadow_roots_seen,iframes_seen,same_origin_frames_read,same_origin_frames_pending,blank_frames_seen,cross_origin_frames_unread,cross_origin_frames_skipped,truncation_reason:truncation_reason || (text_truncated ? 'text_truncated' : cross_origin_frames_unread ? 'cross_origin_frames_unread' : same_origin_frames_pending ? 'same_origin_frames_pending' : null),total_candidates:items.length+omitted_by_limit}};
}
