# NFL Coaching Tree

An interactive [MotherDuck Dive](https://motherduck.com/) mapping the NFL coaching tree — who
trained under whom — for every current (2026) head coach, offensive coordinator, and defensive
coordinator, traced back through the head coaches they served under. Built for MotherDuck's
[DiveMaxxing](https://motherduck.com/divemaxxing/) competition.

Nodes are coaches (with their Wikipedia photo); an edge points from a head coach to a coach who
served on his staff and later became a coordinator or head coach. The graph renders in 2D or 3D
with ego-focus navigation — click any coach to see their branch.

## How the data is built

Everything is derived from Wikipedia. The pipeline splits cleanly into a *deterministic* fetch
layer (plain HTTP, reproducible) and an *LLM extraction* layer (Haiku subagents parse the messy
wikitext into structured rows):

```
roster.json            current 32-team HC/OC/DC slate (HC/OC/DC cross-checked vs Wikipedia's current-staff lists)
fetch_wikitext.py      pull each coach's infobox `pastcoaching` field + lead image  (deterministic)
  -> Haiku subagents   parse pastcoaching -> stints (coach, team, years, role, is_head_coach)
fetch_hc_lists.py      pull all 32 "List of <team> head coaches" pages              (deterministic)
  -> Haiku subagents   parse -> head-coach tenures (team, coach, start_year, end_year)
build_full_graph.py    franchise-canonicalized year-join: each assistant-year -> the HC of that
                       franchise-year = a "served under" edge. Outputs graph_full.json.
```

The graph (173 coaches, 375 edges) loads into the MotherDuck database `nfl_coaching_tree`
(`coaches`, `edges`, `stints` tables). Face thumbnails are stored as base64 in the `coaches`
table so the Dive is fully self-contained — no external image hosting.

## Edge rule

For each non-head-coach stint year, the head coach of that franchise-year (from the HC-tenure
table) is who the coach "served under." Franchise names are canonicalized across eras
(Redskins ↔ Commanders, Oakland/LA/Las Vegas Raiders, etc.) so the join works regardless of the
team's name at the time.

## Known limitations

- Rosters are a 2026-season snapshot. Current head coaches, offensive, and defensive coordinators
  were cross-checked against Wikipedia's current-staff lists, but mid-season staff changes after
  capture aren't reflected.
- ~250 older assistant-years have no head-coach match (minor/obscure historical HCs); accepted.
- Edge year-spans collapse to first/last year, so two separate stints under one coach show as one
  merged span.
- Founding-tree (lineage) assignment follows each coach's longest-tenure mentor, so a chain can
  trace to the wrong founder when an earlier link is missing from Wikipedia's data.

## The Dive component

`dive-preview/` is a local Vite harness mirroring the MotherDuck Dive runtime (React +
`@motherduck/wasm-client`). `src/dive.tsx` is the entire Dive: a self-contained `<canvas>` graph
(a hand-rolled 3D force layout + perspective projection, with 2D and orbit/zoom controls), plus
the leaderboard and methodology tabs. It deliberately uses **only React** — no `three.js` or
`react-force-graph` — because the published MotherDuck Dive runtime resolves a fixed library set,
so the graph is drawn from scratch on a canvas (see
`notes/motherduck-feature-request-dive-libraries.md`). Run `npm install && npm run dev` in that
folder (needs `VITE_MOTHERDUCK_TOKEN` in `.env`).
