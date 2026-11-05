# NamurUI: complete reconstruction

A full, self-contained rebuild of [affectui.com](https://www.affectui.com), published as
NamurUI: **181 items** (117 components, 13 app screens, 19 blocks, 24 illustrations and 8 motion
effects), each one a single `.tsx` file with its styles inside. NamurUI carries its own **Ember**
visual identity, and [`DESIGN.md`](./DESIGN.md) is the authoritative direction document for it.
The extraction is described in [`docs/rea-rebuild.md`](./docs/rea-rebuild.md).

React 19. No Tailwind. No animation library. No icon package. No dependencies beyond React.

```bash
npm install
npm run dev      # http://127.0.0.1:5199
```

**Windows / PowerShell:** if `npm` fails with `npm.ps1 cannot be loaded because running scripts is
disabled`, the execution policy is blocking npm's PowerShell shim: not a dependency problem. Use
the `.cmd` shim, or fix the policy once for your user (no admin needed):

```powershell
npm.cmd install
npm.cmd run dev

# or, permanently:
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

The gallery lists every item, renders it live in a preview frame (light/dark, full-width,
replay), and shows the source on the Code tab with a copy button.

---

## What is original and what is reconstructed

| Tier | Count | How it was produced |
| --- | --- | --- |
| **Free (MIT)** | 40 | The published MIT sources, fetched from `affectui.com/r/<slug>.json`: upstream structure kept as published, colour and timing re-themed |
| **Pro** | 79 | Structure and geometry reconstructed from the extraction: the item's own stylesheet captured over CDP from the live page (895 kB of the originals' own CSS, 1.43 MB once composed sheets are merged), with the DOM reproduced from the captured markup. Colour and timing re-themed. See [`docs/rea-rebuild.md`](./docs/rea-rebuild.md) |
| **Core** | 62 | First-party NamurUI: written for this library rather than reconstructed, with no upstream reference to compare against. The most recent 24 are the `chatrigo.id` set, covering its marketing, pricing, legal and data-display surfaces: see [`docs/15-chatrigo-surfaces.md`](./docs/15-chatrigo-surfaces.md) |

Across the Free and Pro tiers the structure, class names and layout are the source originals. The
colour values are not: the re-theme pass remapped 7,437 colour literals across the 119
reconstructed sheets to the Ember palette in [`DESIGN.md`](./DESIGN.md), and every timing function
is repointed at the motion tokens in `src/styles/motion.css`. That motion pass left 0 bare CSS
`ease` keywords where there were 1,887, rewrote 1,776 timing declarations to the `--nm-*` tokens
and snapped 2,111 durations to the six-step scale. Third-party brand marks (provider logos,
favicons) are kept and hold their own colours: 68 occurrences inside brand selectors, plus 7
unmapped pale washes left as-is. The accurate provenance statement is therefore **structure and
geometry from the extraction; colour and timing re-themed to NamurUI**. The 62 Core items are
first-party throughout, so the reconstructed-versus-reference checks below cover the 79 Pro items,
which is the only tier with a captured reference to compare against.

For the Pro items the behaviour (state shape, event handling) is a reconstruction, because the
original's React code is not shipped. If you ship Pro items in production, buy the real thing at
[affectui.com/pricing](https://www.affectui.com/pricing). Every Free and Pro page links to the item
it reconstructs: the Original link renders only when the manifest row has a `url`, and all 62 Core
rows carry `url: ""`, so those pages show no Original link.

Each gallery entry is tagged `Free`, `Pro` or `Core` so the provenance is never ambiguous.

---

## Layout

Tree relative to the project root:

```
.
├── CONVENTIONS.md          # the house style every file follows, read this before adding one
├── DESIGN.md               # the Ember identity, the source of truth for palette and motion
├── docs/                   # the report; 15-chatrigo-surfaces.md audits the chatrigo.id surfaces
├── index.html
├── src/
│   ├── main.tsx            # mount
│   ├── App.tsx             # hash router + theme
│   ├── styles/
│   │   ├── tokens.css          # Ember palette, radii, shadows, Inter @font-face
│   │   ├── motion.css          # duration and easing tokens, reduced-motion floor, grain
│   │   ├── gallery.css         # the gallery chrome only
│   │   └── high-contrast.css   # generated opt-in AA layer
│   ├── gallery/
│   │   ├── manifest.json   # 181 items: slug, title, kind, tier, category, description, url
│   │   ├── categories.json # the eight categories, in presentation order, with their one-line scope
│   │   ├── registry.ts     # glob-discovered components, demos and sources
│   │   ├── Rail.tsx        # sidebar: search, grouped by category, kind and tier chips
│   │   ├── Overview.tsx    # the grid of all 181
│   │   ├── ItemPage.tsx    # preview / code tabs, dark + full-width + replay
│   │   ├── CodeView.tsx    # tabs + copy
│   │   └── highlight.ts    # dependency-free TSX highlighter
│   └── namurui/
│       ├── <slug>.tsx      # 181 items, one self-contained file each
│       └── demos/
│           └── <slug>.tsx  # 181 zero-prop demos
├── scripts/
│   ├── gen-catalogue.mjs      # docs/catalogue.md from the manifest + specs
│   ├── audit-contrast.mjs     # DOM contrast sweep, run in a browser
│   └── gen-high-contrast.mjs  # writes high-contrast.css from the audit
└── vite.config.ts             # alias "@" to ./src, port 5199
```

`registry.ts` discovers everything with `import.meta.glob`. **Adding a file is the whole
install procedure**: drop `src/namurui/foo.tsx` and `src/namurui/demos/foo.tsx` in, add the
entry to `manifest.json`, and it appears in the rail and the grid.

---

## Using a component in your own site

Every component is standalone. Copy the one file you want.

```bash
cp src/namurui/tool-call-card.tsx  your-app/src/components/
cp src/namurui/demos/tool-call-card.tsx  your-app/src/components/   # optional: the demo
```

```tsx
import { ToolCallCard } from "@/components/tool-call-card";

<ToolCallCard
  name="web_search"
  status="running"
  startedAt={Date.now()}
  args={{ query: "namurui pricing" }}
/>
```

That is it. No CSS import, no provider, no config. Verified: three components copied into
an empty project with nothing but `react` installed bundle to 86 kB with React as the only
external, and no imports left pointing at the repo. The component injects its own
`<style href="ui-tool-call" precedence="default">` (React 19 hoists it into `<head>` once
no matter how many instances render).

### Dark mode

Any ancestor with `class="dark"` or `data-theme="dark"` flips 180 of the 181 items: their
sheets carry that document-level selector. The gallery's theme toggle sets it on `<html>`.
`project-flow` is the exception: it reads `data-theme` on its own root and needs the `theme` prop.

```tsx
<html class="dark">          // or
<html data-theme="dark">
```

### Theming

176 of the 181 items declare their colours, timings and sizes as CSS custom properties on
their own root class, prefixed with the component's abbreviation. `empty-calendar`,
`enrichment-orbit`, `lead-sourcing`, `tab-overload` and `outreach-branches` declare none. Override
the variables anywhere in your sheet:

```css
.ui-tc {
  --ui-tc-line: #26201a;   /* Ember raised surface */
  --ui-tc-bg: #201a15;     /* Ember card surface */
}
```

Colours come from the Ember palette in [`DESIGN.md`](./DESIGN.md); that document, not this file,
is where the values live. Motion values read the `--nm-dur-*` and `--nm-ease-*` tokens defined in
`src/styles/motion.css`, with the literal fallback carried inline so a copied component still
animates in a host that never loads that sheet:

```css
transition: opacity var(--nm-dur-3, 240ms) var(--nm-ease-out, cubic-bezier(0.22, 1, 0.36, 1));
```

The variable names are documented in each component's header comment and listed in the spec
under `### Notes for AI`.

### Reduced motion

176 of the 181 items carry one `@media (prefers-reduced-motion: reduce)` block;
`frost-cloud`, `glow-cloud`, `lead-sourcing` and `model-wheel` animate from JavaScript and check
`matchMedia("(prefers-reduced-motion: reduce)")` instead. `highlight-band` is the one item with
neither, and it has no motion to reduce. Nothing glides, nothing travels; end states are still
correct.

### High contrast

The Ember palette keeps muted labels quiet: several text steps sit below WCAG AA on the Ember
surfaces. That is kept as the default because it is the look. An opt-in layer raises just the
failing text tokens:

```html
<html data-contrast="high">      <!-- or on one component: <div class="ui-tc" data-contrast> -->
```

The layer is generated by `scripts/gen-high-contrast.mjs` from the DOM contrast audit in
`scripts/audit-contrast.mjs`, against the current Ember palette. Measured in both themes over all
181 routes, on 5,563 text pairs in light and 5,562 in dark, the sweep finds 1,287 failing pairs
across 82 of 181 routes in light and 977 across 69 of 181 routes in dark: 7.11 failing pairs per
route in light and 5.40 in dark, averaged over all 181 routes. The opt-in layer takes those to 740
in light (42.5% fewer) and 425 in dark (56.5% fewer), and it never opens a new failure;
[`docs/accessibility.md`](./docs/accessibility.md) carries the method, the measured token pairs,
and the residual.

---

## Adding an item

1. Read `CONVENTIONS.md` for the file contract, and [`DESIGN.md`](./DESIGN.md) for the Ember
   identity the item has to be consistent with.
2. Write `src/namurui/<slug>.tsx`: `"use client"`, exported props type with a `/** */` per
   field, `<style href="ui-<slug>" precedence="default">{css}</style>` as the first child,
   `const css = /* css */ \`…\`;` at the bottom.
3. Write `src/namurui/demos/<slug>.tsx`: `export default function Demo()`, no props,
   realistic content, interactive.
4. Add the item to `src/gallery/manifest.json`.

---

## Verification

```bash
npm run typecheck    # tsc --noEmit, strict
npm run build        # tsc -b && vite build
```

Both are green on the committed tree.

Every row below was measured in a browser on the reconstructed tree, not just compiled. The
visual-diff row is the one that still depends on colour values and describes the palette as it
stood when it was run; the contrast sweep has since been re-measured against the Ember palette in
both themes, and [`docs/accessibility.md`](./docs/accessibility.md) is where that detail lives.

| Check | Result |
| --- | --- |
| Every route mounts | 181 / 181, each preview measured for width and height |
| Pro stylesheets | 79 / 79 injected from the extracted source, not retyped |
| Class coverage vs reference DOM | 79 / 79 at or above 90% |
| Structural match vs reference DOM (`compare-item.mjs`) | **79 / 79** at or above 85%, most at 100%; these two rows compare the 79 reconstructed items, which are the only ones with a captured reference |
| Routes with horizontal overflow | 1 (`task-board`, by design: its own sheet sets `overflow-x: auto` on a 5-column grid) |
| Visual diff vs reference screenshots | 64 / 79 within 12% at the reference width; the rest are demo-content and animation-phase differences, verified styled |
| Page errors during the sweep | 0 |
| Duplicate root classes | Four live collisions were found and separated by renaming one side: `ui-ob` (onboarding vs `outreach-branches`), `ui-alc` (`agent-ledger` vs `agent-lanes`), `ui-gc` (`glow-cloud` vs `ghosted-chat`), `ui-tc` (`tilt-card` vs `tool-call-card`). The renamed side now carries a prefix unique to its file: `ui-onb` (onboarding), `ui-ald` (`agent-ledger`), `ui-glc` (`glow-cloud`), `ui-tlt` (`tilt-card`). `ui-ob`, `ui-alc` and `ui-gc` are each defined in one file now; `ui-tc` is `tool-call-card`'s root and `agent-run` embeds a copy of that sheet for the tool cards it renders. The 12 screen files each define the `ui-as` app-shell chassis root they embed; the gallery renders one item at a time |
| Missing dark block | 1 / 181, so the document-level `:where(.dark, [data-theme="dark"])` block is present in 180 of 181 files; the exception is `project-flow`, by design, which themes itself through a component-scoped `.ui-pf[data-theme="light"\|"dark"]` mechanism as the extracted original does |
| Missing reduced-motion handling | 1 / 181, and that one is `highlight-band`, which has no motion to reduce: 176 files carry the CSS block, and `frost-cloud`, `glow-cloud`, `lead-sourcing` and `model-wheel` animate from JavaScript and check `matchMedia("(prefers-reduced-motion: reduce)")` instead |
| Non-React imports | 0 |
| Code tab | source loads lazily, 689 highlighted tokens, copy works |
| Theme toggle | `class="dark"` on `<html>` flips every component |
| Contrast sweep | light theme 82 of 181 routes with failing text pairs (1,287 pairs, 7.11 per route) and dark theme 69 of 181 routes (977 pairs, 5.40 per route), both averaged over all 181 routes, as measured on the tree the sweep ran against |
| Contrast coverage | 181 of 181 routes audited, 21 of 181 unmeasurable because in each no text node resolves to a single opaque backdrop, so the route is recorded as zero coverage rather than as passing. `process-steps` is the newest: it paints no ground of its own, so its text sits on the gallery's preview gradient |
| Mobile | no horizontal overflow at 390px |
| Bundle | 316 kB entry (93 kB gzip), every item code-split |

---

## Provenance

- Catalogue, specs and MIT sources: `https://www.affectui.com/llms.txt`,
  `https://www.affectui.com/llms-full.txt`, `https://www.affectui.com/r/<slug>.json`. Those
  endpoints are mirrored in the workspace-level `.affectui/` directory of artifacts extracted
  from the upstream site.
- Free components: MIT, © the affectUI author.
- Pro components: independent implementations of the published specification.
- Ember identity: [`DESIGN.md`](./DESIGN.md).
- Inter: SIL Open Font License, bundled as woff2 under `public/fonts/`.