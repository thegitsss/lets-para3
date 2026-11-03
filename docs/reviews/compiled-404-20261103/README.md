# Compiled 404 recovery verification

Base: `744dd547ee715fd4062aca056b8fb69865309e89`, the deployed onboarding release.

Invalid URLs returned HTTP 500 because sending an absolute filename through a hidden `.lpc-build` directory hit Express dotfile handling. Two new GET/HEAD checks reproduced that failure before the fix. The handler now sends the same fixed `404.html` filename relative to its explicit, normalized frontend root. It preserves the approved document, no-store/noindex headers and non-HTML response for unknown mutations.

The production probe now follows the existing static-cache policy for legal pages: Terms and Privacy are public documents with `noindex, nofollow`, while the homepage remains indexable. Content hashes, release identity, CSP/security headers, health, discovery files and real 404 status remain enforced.

Validation: 20 focused not-found/cache/production-probe checks passed. The final directory-normalization adjustment passed the four not-found checks again. The existing page rendered through the compiled-directory handler at [1440](404-1440.png), [390](404-390.png) and [320](404-320.png); keyboard focus and the homepage recovery link worked at each width. No frontend file changed. Hosted checks and live verification are reported on the pull request.

The protected browser run exposed a Firefox test race when the photo popup closed before the click promise returned. The test now waits for the close event and accepts only the matching target-closed error while the opener remains open. All content, asset, responsive and actual-closure assertions remain. Thirty repeated Chromium/Firefox/WebKit popup checks passed; no product behavior changed.

LPC UX review — Baseline: the existing approved 404 document and page assets. Evidence: actual rendered recovery states and widths above, exact approved response bytes, real GET/HEAD status and usable homepage recovery. Exceptions: none; this change restores delivery of the existing page and makes no visual edits.
