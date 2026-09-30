# LPC browser and viewport support policy

This policy defines the browser and responsive-layout contract for the LPC production candidate. It is intentionally small enough to enforce and broad enough for modern legal-work users.

## Supported production browsers

LPC supports the current and previous stable major releases of:

- Chrome and Edge on vendor-supported Windows and macOS releases;
- Firefox on vendor-supported Windows and macOS releases;
- Safari on vendor-supported macOS releases;
- Safari on vendor-supported iOS/iPadOS releases; and
- Chrome on vendor-supported Android releases.

Internet Explorer, embedded in-app browsers, preview/beta browser releases, and operating systems outside their vendor security-support window are not supported. An unsupported browser must not be mistaken for an unsupported account or failed Matter operation; support guidance must preserve the user's work and provide a route to a supported browser.

## Automated engine contract

The accessibility and authenticated critical-role suites run against the Chromium, Firefox, and WebKit revisions pinned by the repository's exact Playwright lockfile. Playwright and its engine revisions are updated through the reviewed dependency process, so the test target cannot silently drift on a release machine.

WebKit is useful Safari-engine coverage, but it is not evidence for a real Safari, iOS, Edge, or Android release. Before launch, the release record must include manual smoke results on the current production versions of Chrome, Edge, Firefox, desktop Safari, iOS Safari, and Android Chrome. The previous-major support promise must be sampled on representative real or managed-cloud devices before a candidate is approved.

Security's shared account journeys run in all three automated engines. The additional `security-webauthn.chromium.spec.js` uses Chromium's CDP virtual authenticator and is selected only by that project; it is not a skipped Firefox or WebKit scenario. Real-device passkey registration, sign-in, cancellation, and removal remain required on supported browsers/devices. Passing virtual-authenticator cryptographic verification does not close that device gate.

## Responsive contract

Critical authenticated surfaces use one shared automated viewport matrix:

| Class | CSS viewport | Purpose |
| --- | ---: | --- |
| Mobile | 390 × 844 | Common modern phone portrait |
| Tablet | 768 × 1024 | Tablet portrait and the compact-navigation breakpoint |
| Laptop | 1366 × 768 | Common constrained desktop/laptop workspace |
| Wide desktop | 1920 × 1080 | Large desktop workspace and content-width behavior |

At every target, critical content and actions must remain operable without document-level horizontal overflow, unintended clipping, or hover-only access. Intentional local overflow, such as a labeled horizontal tab strip, must remain keyboard- and touch-operable.

The matrix is a regression contract, not a claim that layout only works at four widths. Manual launch validation must also cover continuous resizing, 320 CSS-pixel reflow, 200% and 400% zoom, landscape orientation, software-keyboard obstruction, safe areas, coarse pointer input, reduced motion, and keyboard-only operation.

## Release evidence

Automated results must identify the exact candidate and Playwright/browser revisions. Manual records must identify browser/OS/device, viewport or zoom, journey, result, tester, date, and any linked defect. A browser or viewport failure on a critical journey is a stop-ship defect unless the release owner records a narrower support decision before launch.
