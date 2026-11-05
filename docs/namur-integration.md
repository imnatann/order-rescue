# Namur UI integration

Source: https://github.com/imnatann/namurui
Commit: 5c56e3466ba734c89d380671e72fec1c201df391
Integrated: 4 November 2026

The repository became publicly accessible during setup. Following its copy-file instructions, Button and Tool Call Card (both tagged Free/MIT by the upstream manifest) are vendored without changes in `src/components/namurui/`. Ember tokens and motion styles are in `src/styles/namurui/`; Inter files are in `public/fonts/`.

The dashboard uses these actual components, supports light and dark themes and consumes authenticated operational APIs. Other dashboard layout and tables are project-specific; no Pro components have been copied.

Domain persistence, authentication, agent planning and execution live under `src/server/`. The server-side LLM adapter performs real tool calling. Stock reservations, procurement drafts, receipts and shipments persist in SQLite. The local workspace is explicitly in simulation mode; supplier messages and payments are not submitted externally.

When updating Namur, compare upstream changes against this pinned commit and rebuild the project. See `THIRD_PARTY_NOTICES.md` for attribution.
