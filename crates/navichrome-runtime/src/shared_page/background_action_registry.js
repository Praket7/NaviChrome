(() => {
  const store = globalThis.__navichromeSnapshots;
  const nodes = store && store[__TOKEN__];
  const node = nodes && nodes[__INDEX__];
  if (!node || !node.isConnected) {
    return { ok: false, dispatched: false, reason: 'stale_reference' };
  }
  return (__ACTION__).call(node, __INDEX__, __ACTION_NAME__, __EXPECTED__, __NEXT__, __KEY__, __OUTCOME__, __LABEL__, __AUTHORITY__);
})()
