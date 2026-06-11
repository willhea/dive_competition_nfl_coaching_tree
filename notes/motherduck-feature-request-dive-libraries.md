# Feature request: third-party / custom libraries in MotherDuck Dives

**Status:** draft, for submission to MotherDuck (Slack, feedback form, or contest organizers)

## Summary

Let Dive authors use visualization libraries beyond the current built-in allowlist
(`react`, `@motherduck/react-sql-query`, `recharts`, `d3`, `lucide-react`) — either via an
expanded allowlist or by permitting pinned ESM imports from a trusted CDN (e.g. esm.sh /
jsDelivr) under the existing sandbox CSP.

## Problem we hit

We built an NFL coaching-tree Dive: a force-directed node-link graph with coach photos as
nodes, in 2D and 3D. The natural tools are `react-force-graph-2d` / `react-force-graph-3d`
(which wrap `d3-force` + canvas, and `three.js` for 3D). The local Vite preview renders this
perfectly, because the preview is a normal Vite app that can install any npm package.

The production Dive runtime, however, only resolves the fixed allowlist. `react-force-graph`
and `three` aren't on it, so the exact component we iterated on and approved **cannot be
published as-is** — it would fail at runtime on the unresolved imports. We only discovered this
at publish time, after the visualization was done.

This is a sharp edge: the preview is presented as "what you preview is what gets saved," but the
preview can import libraries the runtime can't, so a Dive can be fully built and look finished
yet be unpublishable.

## What we had to do instead

Rewrite the entire graph renderer from scratch as a single `<canvas>` using only React: a
hand-rolled 3D force simulation and perspective projection, custom orbit/pan/zoom, depth
sorting, and click hit-testing — reimplementing what `react-force-graph` provides out of the
box. It works, but it cost a large rewrite and we lost the option of true WebGL 3D (no `three`).

## Proposed solutions (any one would help)

1. **Expand the allowlist** to include common, well-maintained viz libraries —
   `react-force-graph-2d/3d`, `three`, `d3-force-3d`, `visx`, `react-flow`, `cytoscape`. Even
   just `three` + `react-force-graph` would have covered our case and likely many network/3D
   Dives.
2. **Allow pinned ESM imports from a vetted CDN** (esm.sh, jsDelivr) with an integrity hash and
   a version pin, resolved at save time and frozen. Keeps the sandbox/CSP model; gives authors
   the full ecosystem without MotherDuck curating every library.
3. **At minimum: fail fast in the preview.** Have the local preview enforce the same import
   allowlist as the runtime (lint or a resolver shim that errors on disallowed imports), so an
   unpublishable Dive is caught on the first import, not at publish time.

## Why it matters

Dives are pitched as the place rich, interactive data apps live. Network graphs, 3D scenes, and
maps are exactly the visuals that benefit most from interactivity — and exactly the ones that
need libraries beyond Recharts. Supporting them (or at least surfacing the constraint early)
would remove a meaningful cliff between "looks done in preview" and "can actually ship."

## Our example

Open-source repo: https://github.com/willhea/dive_competition_nfl_coaching_tree
(see `dive-preview/src/dive.tsx` — the canvas reimplementation, and git history for the
`react-force-graph` version we had to replace).
