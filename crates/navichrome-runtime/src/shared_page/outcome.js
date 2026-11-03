function(q, index) {
  if (q.kind === 'navigation') return false;
  const saved = this?.items?.[index];
  const defaultRole = n => n.getAttribute('role') || ({A:'link',BUTTON:'button',INPUT:'input',TEXTAREA:'textbox',SELECT:'combobox',SUMMARY:'button'}[n.tagName] || 'control');
  const identityMatches = (n, s) => n.tagName.toLowerCase() === s.tag && defaultRole(n) === s.role
    && this.name(n) === s.name && (!s.raw_value || this.raw(n) === s.raw_value)
    && (n.tagName !== 'A' || n.href === s.href);
  // A framework re-render can replace the node captured by the snapshot while
  // keeping the same control. Resolve that replacement instead of reporting a
  // false negative on a detached node.
  const reacquire = () => {
    if (!saved || saved.source_frame !== 'main') return null;
    const candidates = Array.from(document.querySelectorAll('a[href],button,input,textarea,select,summary,[contenteditable]:not([contenteditable="false"]),[role]'))
      .filter(n => identityMatches(n, saved));
    return candidates.length === 1 ? candidates[0] : null;
  };
  let e;
  if (q.selector) {
    const es = [...document.querySelectorAll(q.selector)];
    if (es.length !== 1) return false;
    e = es[0];
  } else {
    e = this?.nodes?.[index];
    if (!e || !e.isConnected) e = reacquire();
  }
  if (!e || !e.isConnected) return false;
  const s = getComputedStyle(e), b = e.getBoundingClientRect();
  const visible = b.width>0 && b.height>0 && s.visibility==='visible' && s.display!=='none';
  const trustedText = e.hasAttribute('data-requires-trusted') && (e instanceof HTMLTextAreaElement || e instanceof HTMLInputElement && ['text','search','email','url','tel'].includes(e.type));
  const trusted = e.closest('[data-requires-trusted]');
  if (e.querySelector('[data-masked],[data-requires-trusted],input[type=password],input[type=file],input[type=hidden]') || e.closest('[data-masked],[hidden],[inert]') || trusted && (trusted!==e || !trustedText) || (e instanceof HTMLInputElement && ['password','hidden','file'].includes(e.type))) return false;
  const nearestFlag = attr => {
    for (let n = e, depth = 0; n && depth < 8; n = n.parentElement || n.getRootNode()?.host, depth++) {
      if (n.getAttribute?.(attr) === 'true') return true;
    }
    return false;
  };
  if (q.kind === 'focused') return visible && document.activeElement === e;
  if (q.kind === 'visible') return visible;
  if (q.kind === 'text') return visible && (e.innerText || '').replace(/\s+/g,' ').trim() === q.text.replace(/\s+/g,' ').trim();
  if (q.kind === 'expanded') return visible && nearestFlag('aria-expanded');
  if (q.kind === 'selected') return visible && (nearestFlag('aria-selected') || nearestFlag('aria-checked'));
  return false;
}
