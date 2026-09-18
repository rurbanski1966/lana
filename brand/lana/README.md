# LANA brand assets

- `tokens.css` — exact hex values for the palette.
- `mark.svg` — square app icon / favicon (L in a purple badge).
- `LanaWordmark.tsx` — React component for the full "LANA" lockup, light/dark theme prop.
- `lockup.html` — plain HTML/CSS reference if the platform isn't React.

Load Manrope (weights 600/800) via Google Fonts:
`<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@600;800&display=swap" rel="stylesheet">`

Usage: `<LanaWordmark theme="light" />` in the app header/nav (light theme), `theme="dark"` on dark surfaces. Use `mark.svg` for the favicon and any square app-icon slot.

Applied on this site (2026-09-18): the sidebar/auth lockup in public/index.html
uses the mark.svg badge (fixed colors, not theme-adaptive) plus a "LANA"
wordmark built from public/css/app.css's --lana-accent token (the plain-HTML
pattern here, not the React component — this repo has no build step).
