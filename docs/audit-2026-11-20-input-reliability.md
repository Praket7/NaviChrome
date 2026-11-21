# NaviChrome input reliability audit

## Findings

| Failure | Cause | Change |
| --- | --- | --- |
| A canvas typing continuation could replace already written text | Copy verification pressed Select All. Its success path skipped selection cleanup. The continuation accepted whatever had focus in the tab. | Canvas human typing now binds a collapsed caret in the focused editor, checks it before sending more keys, and defers document copy until after the last chunk. Explicit copy proof clears the selection on success and mismatch. |
| A malformed or reordered passage could pass proof | Three samples could occur anywhere in the document. The field named `exact_contains` only compared the first line. | Full normalized text must appear contiguously for canvas copy proof. Sample counts remain diagnostic. Proof establishes presence in the live editor, with no inference about server persistence. |
| A cross-site iframe control was missing from the snapshot | Root Chrome DevTools frame trees can omit out-of-process iframe targets. NaviChrome relied on that one tree even when asked to scan child frames. | The extension merges bounded, attached child-session trees into known parents. Clicks and frame text routes recheck loader and session identity before input. |
| A frame click could hit the wrong control or claim false success | The last point was measured before hover. An outcome already true before input could pass. Same-process outcomes relied on the execution context document. | Recheck the child hit target and frame-owner mapping after mouse move, evaluate selectors in the control's own document, and require a newly attained outcome. |
| A one-tab task left a tab open | Owned closure required an unrelated tab as a command anchor. | Allow the exact owned tab as the anchor. Chrome still checks the persisted owner, tab, document and window, then checks that the tab is gone. |

## Research and design choices

- Chrome's input protocol distinguishes key events, text insertion, and IME. Explicit human pacing keeps the ordered key events. The default continues to choose a faster verified route when the editor supports it. Chrome focus emulation remains separate from activating a tab or raising the window. [CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/) · [CDP Emulation](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setFocusEmulationEnabled)
- Playwright checks visibility, stability and whether the chosen point receives events. Its source also checks the enclosing frame chain. NaviChrome tests the visible portion of a child control and rechecks the point after hover. Unknown delivery requires observation before another action. [Playwright actionability](https://playwright.dev/docs/actionability) · [Playwright pointer implementation](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/dom.ts)
- BrowserGym standardizes browser actions and observations across benchmarks. WorkArena measures success against application state. NaviChrome's probes should record task success from an independent read alongside tool calls, commands, time and focus transitions. This lets verified progress be compared with successful transport acknowledgments. [BrowserGym](https://arxiv.org/abs/2412.05467) · [WorkArena](https://proceedings.mlr.press/v235/drouin24a.html) · [WebArena](https://arxiv.org/abs/2307.13854)

## Next qualification gates

1. Check real editor behavior on a disposable document in an authorized personal account. Include ordered multi-paragraph readback, user caret movement, concurrent autosave, and a close/reopen check.
2. Compare the same tasks against the pre-change build and competing tools. Report success rate, end-to-end time, model calls, browser commands, unknown deliveries, and visible focus transitions. Separate human pacing time from avoidable tool and browser time.
3. Expand beyond input once the above is stable. Prioritize application-owned acceptance for uploads and downloads, selector recovery through nested and shadow DOM, and background workflows on dynamic sites.

## Installed Chrome evidence

The native bridge and Hotload child were rebuilt and reloaded. The tests ran
against disposable loopback pages in installed Chrome without selecting a
Google account. The browser plugin separately read the canvas proxy after the
input tests.

| Probe | Observed result |
| --- | --- |
| Canvas continuation at 280 ms pacing | Two 49-character chunks in 13.82 s and 13.92 s. Exact readback preserved the prefix, newline, accents and em dash. Both chunks reported no window focus or tab activation change. |
| Canvas focus interference | Focus moved on the first keydown. Zero characters completed. Independent value predicates passed for both the untouched editor and the empty unrelated field. A continuation without a prior caret returned `not_dispatched`. |
| Same-process frame typing at 70 ms pacing | Same 10-character probe improved from 5.24 s to 1.52 s. Verified readback was 10 characters with the expected hash. This is one matched before/after pair. |
| Cross-site and nested frame typing | Exact 10-character readback in both, in 0.77 s and 0.71 s. |
| Frame clicks | Same-process, cross-site, and nested child clicks verified a new text outcome in 45 ms, 72 ms, and 100 ms. Preexisting evidence, hover displacement and a mismatched label each refused before pointer press. |
| Owned tab cleanup | Verified closure from a single-tab session. Final loopback discovery returned zero open probe tabs. |

An intermediate canvas run exhausted its browser-command budget after 34
characters. The runtime now budgets the guard reads for both initial and
continuation calls. Concurrent cold opens in one shared window also hit an
existing lease conflict. The explicit owned background window route recovered
the fixture without a duplicate tab. Cross-site nested discovery needed a
fresh snapshot after the child debugger attached. The installed Google Docs
canvas and saved-document state still require separate qualification.
