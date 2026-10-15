# Paralegal Home: inspected product references and visual authority

Recorded 2026-09-08 for the existing `paralegal-v2.html#/home` implementation. This is a bounded reference review, not private-product testing. Public official documentation was read; the exact public product images below were downloaded and visually inspected. No authenticated Stripe, Linear, Mercury, or Ramp account was opened or changed. The browser-control tool reported no available browser. The Mercury public demo entry returned no inspectable interface through the web reader, so it is not counted as a tested demo.

## References actually inspected

### Stripe Dashboard

- Read [Web Dashboard](https://docs.stripe.com/dashboard/basics) and [Manage connected accounts](https://docs.stripe.com/connect/dashboard).
- Inspected the official [Connected accounts screenshot](https://b.stripecdn.com/docs-statics-srv/assets/review-accounts.1f1c378c540f9f0c42a58212c0eac3dd.png), published with [Review actionable accounts](https://docs.stripe.com/connect/dashboard/review-actionable-accounts). It shows status groups, a compact table, aligned numeric/date fields, quiet navigation, explicit sorting/filter controls, and row-level detail access.
- Applied principle: a record's identity, authoritative status, date, and available destination belong together. Use concise work/opportunity rows and restrained rules; reserve priority treatment for a documented action. Account restrictions in the documentation are capability-specific: LPC readiness copy likewise belongs beside the action it blocks.
- Not adopted: Stripe colors, colored status badges, charts, account metrics, layout dimensions, or Stripe business rules. Loading, errors, keyboard behavior, and private hover interactions were not tested.

### Linear

- Read [My issues](https://linear.app/docs/my-issues) and [Inbox](https://linear.app/docs/inbox).
- Inspected the official [My Issues screenshot](https://webassets.linear.app/images/ornj730p/production/70c22a56e776bfbffa920091b64a28845ca8eaeb-1864x842.png). The interface uses shallow navigation, compact grouped rows, aligned identifiers, plain issue titles, and distinct views for assignments and activity. The documentation describes curated priority categories that appear only when relevant.
- Applied principle: deterministic attention selection and an ordered work queue provide hierarchy without a hero. Separate unread activity from obligations. Compress inapplicable/empty supporting sections; retain obvious paths to full destination views.
- Not adopted: Linear's palette, dark surfaces, issue states, SLA rules, icons, or shortcut system. The screenshot is a static official product illustration, not evidence of live interaction behavior.

### Mercury

- Read [Using the Payments page](https://support.mercury.com/hc/en-us/articles/40585414546068-Using-the-Payments-page) and [June 2024 product updates](https://mercury.com/blog/june-2024-product-updates).
- Inspected extracted frames 100, 140, 165, 200, 220, and 299 of the official [Tasks product demonstration GIF](https://www.datocms-assets.com/115132/1745702780-2025_blog_product-updates-june-2024-3_16x9.gif). Frames 165, 200, and 220 show a pending approval beside the affected record, a consequence-specific confirmation dialog, and confirmed success feedback. This is a small historical product demonstration, not a current private account.
- Applied principle: place contextual actions beside the record, preserve existing confirmation flows, and distinguish a requested mutation from a confirmed outcome. Payments documentation explicitly separates pending approval, scheduled, and successfully sent records; LPC similarly preserves completion, release, payout processing, and funds-received distinctions. The updates article separates operational tasks from general notifications.
- Not adopted: Mercury's decorative surrounds, beige surfaces, fonts, financial policies, or its role/task model. The demonstration's success sequence does not establish failure or retry behavior.

### Ramp

- Read [How Ramp uses Ramp Bill Pay](https://ramp.com/blog/how-ramp-uses-ramp-bill-pay/) and [Funds interface update FAQ](https://support.ramp.com/simplifying-expense-management-with-funds-update-faq/).
- Inspected the official [Bill Pay saved views screenshot](https://cdn.sanity.io/images/6jz6vxxd/production/cbe56a308cc1ad1670a7e1e3b3d727d8335668d3-3000x1650.png) and [Payment release settings screenshot](https://cdn.sanity.io/images/6jz6vxxd/production/95db38b6f7359506bf0319ebc87509ce877d82ff-3000x1769.png). The table groups concrete conditions, aligns dates/amounts, and identifies selection with an underline. Approval settings expose the people/context relevant to the action.
- Applied principle: label the actual missing requirement or date; keep one main action in context and secondary options quiet. Group opportunities by their real meanings, with detail through supported flows. Selection can remain clear on white. Preserve approval and release as distinct outcomes.
- Not adopted: Ramp's yellow/green/status colors, AI features, accounting concepts, table tooling, or approval policies. No private Ramp interaction was tested.

## Translation into LPC's locked visual system

The common principle is operational hierarchy: one supported priority, compact records, contextual detail, legible statuses, and continuous navigation. It does not justify new confidential reads or inferred tasks. Local loading/unavailable/restricted/stale states and safe refresh behavior are LPC brief requirements, not behaviors claimed from these static references.

| Token or role | Confirmed implementation authority | Home use |
| --- | --- | --- |
| White `#FFFFFF` | Current user brief; existing `--v2-white` base token | All Home surfaces and open Home menus/dialogs/drawers, including selected/loading/error surfaces |
| Navy `#0B2947` | `frontend/assets/styles/paralegal-v2.css:15`; existing work/browse navy tokens agree | Operational text, links, meaningful selection/focus treatment, primary buttons |
| Cornflower `#6495ED` | Existing RGB `100,149,237` in `frontend/assets/scripts/homepage.js`; approved cornflower treatment recorded in `docs/LPC_PUBLIC_PAGES_10_PHASE_CHECKLIST.md` | Restrained nonessential accent; never sole status/selection information |
| Sarabun | `--v2-font-sans: "Sarabun", sans-serif` in base V2 CSS; bundled `fonts.css` faces | All operational Home text; preserve the existing fallback |
| Cormorant Garamond | Existing `.v2-brand` wordmark and `--v2-font-serif` | Existing wordmark only within Home; no new serif headings |

Calculated WCAG sRGB contrast against pure white: navy **14.7639:1**; cornflower **2.9729:1**. Cornflower therefore fails normal-text contrast, white-on-blue normal button text, and the 3:1 meaningful graphic/focus-boundary threshold. Use the approved navy in those roles. Browser acceptance must verify the computed colors actually match these tokens and remeasure the rendered combinations; these arithmetic checks alone are not rendered verification.

Bundled Sarabun has normal 200, 300 (an explicit alias to the existing ExtraLight file), 400, and 600 declarations. Prefer operational 400/600. Latin 400 is `DtVjJx26TKEr37c9aBVJn3YO5gg.woff2`; Latin 600 is `DtVmJx26TKEr37c9YMptilss6yLUrwA.woff2`. Browser acceptance must check loaded faces and failed font requests, not only the declared `font-family`.

## Cascade boundary identified before implementation

`paralegal-v2.html` loads `paralegal-v2-desk.css` after the base and Home sheets. That later sheet globally replaces the canvas with `#faf9f6`, navy with `#173b4c`, blue with `#35667d`, adds gold/green/cream treatments, and declares an oversized serif Home greeting. The older Home sheet also contains navy panels and gold tokens. Those aesthetic directions are explicitly superseded for Home by the current brief.

Implement the final Home layer after the desk sheet, scoped through the existing Home route marker. Include visible shell surfaces and Home-opened shared surfaces in that route scope. Preserve saved theme preferences and other destinations. Do not use forced-color adjustment to defeat operating-system accessibility colors. Verify route departure restores existing shared styling.

Reference images were used for analysis only and were not added to LPC's frontend or application bundle. Temporary inspection files are under `/private/tmp/lpc-home-product-references/`.
