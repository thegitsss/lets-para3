# Paralegal Home browser evidence

> This index records the earlier Home iteration. The subsequent Linear desktop replacement has separate [implementation and current verification](PARALEGAL_LINEAR_IMPLEMENTATION.md); screenshots under `paralegal-home/linear-desktop` reflect that replacement.

Verified locally on September 8, 2026 with Node **24.18.0**, npm **11.16.0**, the repository's installed Playwright, and the existing `playwright.paralegal-support.config.js` harness. The harness creates an isolated MongoMemoryServer and synthetic paralegal session at `127.0.0.1:5052`. Browser route fixtures use synthetic records and matching `auth/me` / `users/me` identity. Identity replacement is simulated within that isolated browser context; no real account switch or production access occurred.

## Results

| Coverage | Actual result |
|---|---|
| Unmodified historical `v2-home.spec.js` baseline, Chromium | **15/15 passed** before implementation (1.8 minutes). |
| New `home-redesign.spec.js`, 21 scenarios × Chromium/Firefox/WebKit | Full run **61/63 passed** (3.2 minutes). It exposed a WebKit availability-dialog reopen race and the final disabled-Assistant-button treatment required its corresponding assertion update. |
| Final focused availability reopen, Assistant states, and complete shell continuity, all three browsers | **9/9 passed** after the corrections (1.1 minutes). This includes both previously failing Home scenarios on every browser. |
| Final committed-route transition check, all three browsers | **3/3 passed** (41.6 seconds). Outgoing Home stays white while Browse is delayed; the destination's stored dark theme resumes only when Browse commits. Returning Home is white even while its expired dashboard source is still loading. The new Home suite now contains **22 scenarios**. |
| Migrated historical Home tests + Foundation + global tools, Chromium | **35/36 passed** (1.7 minutes): Home **15/15**, global tools **12/12**, Foundation **8/9**. The remaining Foundation assertion required the former absence of a focus outline; it was replaced with a stronger check for one **2px approved navy** shell focus outline. The full continuity scenario then passed on all three browsers in the final focused run. |

There are no unresolved failures in this Home browser coverage. This statement combines the full runs and the explicitly listed final focused reruns; it does not describe a single subsequent full-suite run.

Existing Home tests remain 15 tests, with no skips or deletions. Their obsolete layout selectors and inconsistent synthetic identities were migrated. Confidential revision content is now checked only after entering the authorized Matter workspace; the original file response association, revision focus, missing-date handling, and upload chooser checks remain. The shell continuity test now forces height on the actual rendered route and asserts a real 420px restored scroll position, instead of allowing a zero-scroll result.

## State and interaction coverage

The new suite covers required states A–L: recommendations without work; invitation decision and its existing Work acceptance flow; application movement and pre-hiring requests; funded work; authoritative deadlines and deterministic ties; honest latest-file/update metadata and unread awareness; profile/payout gates; quiet empty states; partial failure, slow independent sources and retry; access loss, expired sessions and late responses after synthetic identity replacement.

It also checks recommendation preview/deep links, invitation acceptance without inventing a hire, history based on server-projected dollar totals, no confidential Matter/file/message prefetch, no Home message read acknowledgements, availability duplicate suppression and recoverable input, immediate dialog reopening from confirmed state, cross-tab availability reconciliation, focused-dialog preservation during ordinary refresh and explicit retry, stored theme preservation, pending/committed navigation surface continuity, and persistent shell nodes.

## Rendered verification

- **375, 768, 1440, 1920, and 320px** were checked in Chromium, Firefox and WebKit with long content. All 15 measurements had no document or workspace horizontal overflow.
- Home, shell, region, row and form effective surfaces were pure white. Text samples used approved navy or white on navy; rendered minimum measured text contrast was **14.764:1**. Cornflower remains the approved `#6495ED` token; navy `#0B2947` is used for readable operational text and filled actions.
- The browser verified a **loaded Sarabun font face** and the computed `Sarabun, sans-serif` operational family. The existing LPC wordmark retains its approved serif role.
- Axe ran WCAG A/AA tags through **`wcag22aa`**, including the installed target-size checks, across all required widths and open Assistant states. Those checks passed. Keyboard tests cover visible focus, native dialog operation/return focus, and preventing focus on background application controls. Native modal tabbing may legitimately reach browser chrome.
- Additional checks cover 200% root text scaling at 375px, reduced motion, and preserving browser/OS forced-color adjustment. Assistant was inspected at 1440 and 768px, including disabled white/navy and enabled navy/white send-button treatments; the draft was never sent.

Automated checks and the stated keyboard/visual inspection do **not** claim a manual screen-reader certification, a production-browser run, or release readiness.

## Durable artifacts

All artifacts contain synthetic fixture content. The final directory retains all three browser engines' viewport PNGs and computed-style/contrast JSON:

- [Desktop, 1440px](design-previews/paralegal-home/final/chromium-home-1440.png)
- [Mobile, 375px](design-previews/paralegal-home/final/chromium-home-375.png)
- [Tablet, 768px](design-previews/paralegal-home/final/chromium-home-768.png)
- [Large desktop, 1920px](design-previews/paralegal-home/final/chromium-home-1920.png)
- [320px reflow](design-previews/paralegal-home/final/chromium-home-320.png)
- [Recommendations without active work](design-previews/paralegal-home/final/chromium-opportunities-1280.png)
- [Quiet empty state](design-previews/paralegal-home/final/chromium-quiet-1280.png)
- [Assistant on desktop](design-previews/paralegal-home/final/chromium-home-assistant-1440.png)
- [Assistant on tablet](design-previews/paralegal-home/final/chromium-home-assistant-768.png)
- [Rendered desktop measurements](design-previews/paralegal-home/final/chromium-rendered-home-1440.json)
- [State/source contract](PARALEGAL_HOME_STATE_CONTRACT.md)
- [Inspected references and applied principles](PARALEGAL_HOME_REFERENCES.md)

## Reproduction

From `backend`, prepend `PATH=/Users/samanthasider/.nvm/versions/node/v24.18.0/bin:$PATH` to these commands:

```sh
node_modules/.bin/playwright test -c playwright.paralegal-support.config.js v2-home.spec.js --project=chromium --fail-on-flaky-tests
node_modules/.bin/playwright test -c playwright.paralegal-support.config.js home-redesign.spec.js --fail-on-flaky-tests
node_modules/.bin/playwright test -c playwright.paralegal-support.config.js v2-home.spec.js v2-foundation.spec.js v2-global-tools.spec.js --project=chromium --fail-on-flaky-tests
node_modules/.bin/playwright test -c playwright.paralegal-support.config.js home-redesign.spec.js v2-foundation.spec.js --grep 'availability mutation|stored theme|V2 navigation changes' --fail-on-flaky-tests
node_modules/.bin/playwright test -c playwright.paralegal-support.config.js home-redesign.spec.js --grep 'committed Home' --fail-on-flaky-tests
```

The first baseline attempt hit sandbox `listen EPERM` before tests ran. The listed results used the approved localhost listener permission; no source changes were made to bypass the sandbox failure.
