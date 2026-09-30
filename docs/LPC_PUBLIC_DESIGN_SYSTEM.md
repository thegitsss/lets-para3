# Let’s-ParaConnect public design system

This file records the visual roles consolidated in Phase 8. It applies to the 17 public surfaces in the public-page audit. It does not govern authenticated product screens or change application behavior.

## Brand and typography

- Cormorant Garamond is the display and wordmark face. Sarabun is the body, form, label, navigation, and button face.
- Navy (`#1a2230`) is the public primary-action color. Gold (`#b4975a`) is an accent, focus color, and restrained text-link color; it is not a competing primary action.
- Utility display headings use `--lpc-display-utility`. Authentication display headings use `--lpc-display-auth`.
- The homepage may use `--lpc-display-marketing` and page-owned editorial scales. Its mixed display treatments, oversized story headings, and transparent hero header are intentional exceptions.
- Public control labels and buttons use sentence case. Product names retain “Let’s-ParaConnect”; prose uses curly apostrophes, en dashes for ranges or relationships, and ellipses only for an in-progress state.

## Layout tokens

| Role | Token | Value |
| --- | --- | --- |
| Compact mobile gutter | `--lpc-gutter-compact` | 20px |
| Mobile gutter | `--lpc-gutter-mobile` | 20px |
| Tablet gutter | `--lpc-gutter-tablet` | 32px |
| Desktop gutter | `--lpc-gutter-desktop` | 52px |
| Wide desktop gutter | `--lpc-gutter-wide` | 68px |
| Reading width | `--lpc-content-reading` | 900px |
| Text width | `--lpc-content-text` | 980px |
| Standard content | `--lpc-content-standard` | 1200px |
| Wide content/chrome | `--lpc-content-wide` | 1440px |

`--lpc-page-gutter` fluidly resolves between the compact and wide values. Narrow page families may use the named reading or text widths; they should not invent a new full-page gutter.

## Public action roles

Every styled public action maps to `data-public-action`.

| Role | Use | Geometry |
| --- | --- | --- |
| `primary` | One leading action in a decision group | Navy; 48px minimum; pill for marketing, 8px control radius for auth/forms |
| `secondary` | Alternative or cancel action | Bordered/quiet; same height and shape family as its primary |
| `text` | Low-emphasis navigation or inline action | No filled surface; at least a 44px mobile clickable height |
| `icon` | Menu, filter, close, or visibility control | At least 44×44px |
| `pagination` | Previous/next or page selection | At least 44×44px; pill treatment |
| `destructive` | Irreversible public action, if introduced | Muted red; never reuse primary navy or accent gold |

Selected controls use `aria-selected="true"` or `aria-pressed="true"`; loading controls use `aria-busy="true"`; disabled controls use the native `disabled` attribute where possible. Focus uses the LPC gold ring. Hover/active states deepen navy or add a restrained cloud surface without changing the control’s role.

Header CTAs are the documented compact desktop exception at 40px. They become at least 44px on mobile. Interface demonstrations inside the homepage workflow are narrative artwork, not public navigation actions, and retain their page-owned product UI geometry.

## Shared chrome

- Public headers use a 72px desktop and 66px mobile frame with the same 44px mobile menu control.
- The homepage keeps its transparent-on-hero surface, but its structure, dimensions, and mobile menu geometry match utility pages.
- Public footers use the shared navy directory treatment. Footer links, accordion summaries, and the Accessibility control provide 44px mobile targets.
- The Accessibility control is a single text-and-icon action with a 44px minimum target on every public page; page-local footer themes are not allowed.
