function(target, deltaX, deltaY, point) {
  const invalid = reason => ({ status: 'not_dispatched', reason_code: reason, dispatch_may_have_occurred: false });
  if (!Number.isInteger(deltaX) || !Number.isInteger(deltaY)
    || (deltaX === 0) === (deltaY === 0) || Math.abs(deltaX) > 1200 || Math.abs(deltaY) > 1200) {
    return invalid('invalid_wheel_delta');
  }
  const doc = target?.ownerDocument || document;
  const view = doc.defaultView;
  if (!view || doc !== document) return invalid('target_document_changed');
  if (target && !(target instanceof Element)) {
    const wanted = String(target.name || '').replace(/\s+/g, ' ').trim();
    const candidates = target.id
      ? [doc.getElementById(target.id)].filter(Boolean)
      : [...doc.querySelectorAll(target.href ? 'a[href]' : (target.tag || '*'))];
    const matches = candidates.filter(element => element.isConnected
      && (!target.tag || element.tagName.toLowerCase() === target.tag.toLowerCase())
      && (!target.role || element.getAttribute('role') === target.role)
      && (!target.href || element.href === target.href)
      && (!wanted || String(element.getAttribute('aria-label') || element.innerText || element.value || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim() === wanted));
    if (matches.length !== 1) return invalid(matches.length ? 'scroll_target_ambiguous' : 'stale_scroll_target');
    target = matches[0];
  }
  if (!target) {
    const x = point?.x ?? view.innerWidth / 2, y = point?.y ?? view.innerHeight / 2;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) {
      return invalid('scroll_point_outside_viewport');
    }
    target = doc.elementFromPoint(x, y);
    if (!target) return invalid('scroll_point_has_no_target');
  }
  if (!target.isConnected || target.ownerDocument !== doc) return invalid('stale_scroll_target');
  if (['iframe', 'frame'].includes(target.localName)) return invalid('frame_scroll_requires_fresh_frame_reference');
  const axis = deltaX ? 'x' : 'y', delta = deltaX || deltaY;
  const root = doc.scrollingElement;
  const metric = (element, dimension) => dimension === 'x'
    ? { offset: element === root ? view.scrollX : element.scrollLeft, max: element.scrollWidth - element.clientWidth }
    : { offset: element === root ? view.scrollY : element.scrollTop, max: element.scrollHeight - element.clientHeight };
  const candidates = [];
  for (let element = target; element && element.nodeType === 1; element = element.parentElement || element.getRootNode()?.host) {
    const style = view.getComputedStyle(element);
    const overflow = axis === 'x' ? style.overflowX : style.overflowY;
    const size = metric(element, axis);
    if ((element === root || /^(auto|scroll|hidden|overlay)$/.test(overflow)) && size.max > 1) candidates.push(element);
  }
  if (root && !candidates.includes(root) && metric(root, axis).max > 1) candidates.push(root);
  if (!candidates.length) return invalid('no_scrollable_target');
  const canMove = element => {
    const { offset, max } = metric(element, axis);
    return delta > 0 ? offset < max - 1 : offset > 1;
  };
  const scroller = candidates.find(canMove) || candidates[0];
  const read = element => metric(element, axis).offset;
  const before = read(scroller);
  const rootBefore = { x: view.scrollX, y: view.scrollY };
  const identity = element => ({
    id: element.id || '',
    class_name: typeof element.className === 'string' ? element.className.trim().slice(0, 120) : '',
    tag: element.tagName?.toLowerCase() || '',
    role: element.getAttribute?.('role') || '',
    name: (element.getAttribute?.('aria-label') || element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
  });
  let attempted = false;
  try {
    attempted = true;
    scroller.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
  } catch (_) {
    return { status: 'unknown', reason_code: 'scroll_dispatch_unknown', dispatch_may_have_occurred: attempted, target: identity(target), scroller: identity(scroller) };
  }
  const after = read(scroller), actualDelta = after - before;
  const rootAfter = { x: view.scrollX, y: view.scrollY };
  const movedInDirection = Math.sign(actualDelta) === Math.sign(delta) && Math.abs(actualDelta) > 0;
  return {
    status: movedInDirection ? 'verified' : 'inconclusive',
    reason_code: movedInDirection ? null : 'scroll_offset_unchanged',
    dispatch_acknowledged: true,
    dispatch_may_have_occurred: true,
    target: identity(target),
    scroller: { ...identity(scroller), kind: scroller === root ? 'root' : 'nested', axis, before, after, max: metric(scroller, axis).max },
    delta: { x: axis === 'x' ? actualDelta : 0, y: axis === 'y' ? actualDelta : 0 },
    root: { before: rootBefore, after: rootAfter },
  };
}
