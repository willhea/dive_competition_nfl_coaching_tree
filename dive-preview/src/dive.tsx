import { useEffect, useMemo, useRef, useState } from "react";
import { useSQLQuery } from "@motherduck/react-sql-query";

// NFL coaching tree — 2D/3D relationship graph + coach detail panel + leaderboard.
// The graph is a self-contained <canvas> renderer (hand-rolled 3D force layout +
// perspective projection) so the Dive uses only React — no three.js / react-force-graph,
// which the MotherDuck Dive runtime doesn't allow. Faces and stats come straight from
// the MotherDuck nfl_coaching_tree database.

const NFL = "#013369";
const RED = "#D50A0A";
const MUTED = "#6a6a6a";
const GRAPH_H = 620;
const DRAWER_W = 340;
const ALL = "__ALL__";
const REPO_URL = "https://github.com/willhea/dive_competition_nfl_coaching_tree";

type Coach = {
  name: string; image_b64: string | null; is_roster: boolean; is_nfl_hc: boolean;
  hc_wins: number | null; hc_losses: number | null; hc_ties: number | null; super_bowl_rings: number | null;
};
type Edge = { coach: string; served_under: string; first_year: number; last_year: number };
type Stint = { coach: string; team: string; start_year: number; end_year: number; role: string; is_head_coach: boolean };
type GNode = { id: string; img: string | null; roster: boolean; deg: number; isHC: boolean };

const winPct = (c: Coach) =>
  c.hc_wins != null && (c.hc_wins + (c.hc_losses ?? 0)) > 0
    ? (c.hc_wins / (c.hc_wins + (c.hc_losses ?? 0))).toFixed(3).replace(/^0/, "")
    : null;
const yrs = (a: number, b: number) => (b >= 9999 ? `${a}–present` : a === b ? `${a}` : `${a}–${b}`);
// distinct, readable on both the dark 3D and light 2D backgrounds
const LINEAGE_PALETTE = ["#ff7f0e", "#1f9e89", "#e4b400", "#2e7fd0", "#9b5de5", "#e36bae", "#d6336c", "#3bb273"];
const LINEAGE_OTHER = "#8a8a8a";
const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
const overlayBtn = (render: "3d" | "2d"): React.CSSProperties => ({
  fontSize: 12, padding: "4px 8px", borderRadius: 6, cursor: "pointer", lineHeight: 1,
  border: render === "3d" ? "1px solid rgba(255,255,255,0.35)" : "1px solid #ccc",
  background: render === "3d" ? "rgba(20,28,52,0.7)" : "rgba(255,255,255,0.9)",
  color: render === "3d" ? "#e6ecff" : "#333",
});

export default function CoachingTree() {
  const coachesQ = useSQLQuery<Coach[]>(`SELECT name, image_b64, is_roster, is_nfl_hc, hc_wins, hc_losses, hc_ties, super_bowl_rings FROM nfl_coaching_tree.coaches`);
  const edgesQ = useSQLQuery<Edge[]>(`SELECT coach, served_under, first_year, last_year FROM nfl_coaching_tree.edges`);
  const stintsQ = useSQLQuery<Stint[]>(`SELECT coach, team, start_year, end_year, role, is_head_coach FROM nfl_coaching_tree.stints`);
  const coaches = (coachesQ.data ?? []) as Coach[];
  const edges = (edgesQ.data ?? []) as Edge[];
  const stints = (stintsQ.data ?? []) as Stint[];
  const loading = coachesQ.isLoading || edgesQ.isLoading || stintsQ.isLoading;

  const [render, setRender] = useState<"3d" | "2d">("3d");
  const [colorBy, setColorBy] = useState<"lineage" | "role">("lineage");
  const [tab, setTab] = useState<"explore" | "leaderboard" | "methodology">("explore");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [depth, setDepth] = useState<1 | 2>(1);

  const byName = useMemo(() => new Map(coaches.map((c) => [c.name, c])), [coaches]);

  // career stints per coach (sorted)
  const careerOf = useMemo(() => {
    const m = new Map<string, Stint[]>();
    for (const s of stints) (m.get(s.coach) ?? m.set(s.coach, []).get(s.coach)!).push(s);
    for (const arr of m.values()) arr.sort((a, b) => a.start_year - b.start_year);
    return m;
  }, [stints]);

  // NFL head coaches per the authoritative "List of <team> head coaches" data
  // (not college HCs — e.g. Jim Leonhard's Wisconsin stint doesn't count).
  const hcSet = useMemo(() => new Set(coaches.filter((c) => c.is_nfl_hc).map((c) => c.name)), [coaches]);

  // mentor -> protégés and coach -> mentors
  const protegesOf = useMemo(() => {
    const m = new Map<string, Edge[]>();
    for (const e of edges) (m.get(e.served_under) ?? m.set(e.served_under, []).get(e.served_under)!).push(e);
    return m;
  }, [edges]);
  const mentorsOf = useMemo(() => {
    const m = new Map<string, Edge[]>();
    for (const e of edges) (m.get(e.coach) ?? m.set(e.coach, []).get(e.coach)!).push(e);
    return m;
  }, [edges]);

  const treeSize = useMemo(() => {
    const cache = new Map<string, number>();
    const dfs = (id: string, seen: Set<string>): Set<string> => {
      for (const e of protegesOf.get(id) ?? []) if (!seen.has(e.coach)) { seen.add(e.coach); dfs(e.coach, seen); }
      return seen;
    };
    return (id: string) => {
      if (!cache.has(id)) cache.set(id, dfs(id, new Set()).size);
      return cache.get(id)!;
    };
  }, [protegesOf]);

  const graph = useMemo(() => {
    const deg = new Map<string, number>();
    for (const e of edges) deg.set(e.served_under, (deg.get(e.served_under) ?? 0) + 1);
    const nodes: GNode[] = coaches.map((c) => ({
      id: c.name, img: c.image_b64, roster: !!c.is_roster, deg: deg.get(c.name) ?? 0, isHC: hcSet.has(c.name),
    }));
    const ids = new Set(nodes.map((n) => n.id));
    const links = edges.filter((e) => ids.has(e.coach) && ids.has(e.served_under))
      .map((e) => ({ source: e.served_under, target: e.coach }));
    return { nodes, links };
  }, [coaches, edges, hcSet]);

  // Lineage roots: collapse the tangled mentor DAG into a single-parent forest by
  // giving each coach their *primary* mentor (the HC they served under for the most
  // years; ties → earliest, then name). Walking that chain up yields one founding
  // root per coach — the canonical way NFL coaching trees are drawn.
  const lineage = useMemo(() => {
    const parent = new Map<string, string>();
    for (const [coach, ms] of mentorsOf) {
      const best = [...ms].sort((a, b) =>
        (b.last_year - b.first_year) - (a.last_year - a.first_year) ||
        a.first_year - b.first_year || a.served_under.localeCompare(b.served_under))[0];
      if (best) parent.set(coach, best.served_under);
    }
    const rootOf = (c: string) => { const seen = new Set<string>(); let x = c; while (parent.get(x) && !seen.has(x)) { seen.add(x); x = parent.get(x)!; } return x; };
    const root = new Map<string, string>();
    const size = new Map<string, number>();
    for (const c of coaches) { const r = rootOf(c.name); root.set(c.name, r); size.set(r, (size.get(r) ?? 0) + 1); }
    // give a distinct color to the largest trees (≥3 descendants → size ≥4, incl. root)
    const ranked = [...size.entries()].filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1]);
    const color = new Map<string, string>();
    const legend: { root: string; color: string; n: number }[] = [];
    ranked.forEach(([r, n], i) => { if (i < LINEAGE_PALETTE.length) { color.set(r, LINEAGE_PALETTE[i]); legend.push({ root: r, color: LINEAGE_PALETTE[i], n: n - 1 }); } });
    const colorOf = (id: string) => color.get(root.get(id) ?? "") ?? LINEAGE_OTHER;
    const rootName = (id: string) => root.get(id) ?? id;
    return { colorOf, rootName, legend };
  }, [coaches, mentorsOf]);

  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) => (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b);
    for (const l of graph.links) { add(l.source as string, l.target as string); add(l.target as string, l.source as string); }
    return m;
  }, [graph.links]);

  // Decode the base64 face thumbnails into Image objects once; the canvas renderer
  // draws whatever is loaded each frame, so faces just pop in as they decode.
  const imgCache = useRef(new Map<string, HTMLImageElement>());
  useEffect(() => {
    for (const n of graph.nodes) {
      if (!n.img || imgCache.current.has(n.id)) continue;
      const im = new Image(); im.src = n.img; imgCache.current.set(n.id, im);
    }
  }, [graph.nodes]);

  const view = useMemo(() => {
    let ids: Set<string>;
    if (focusId) {
      ids = new Set([focusId]); let frontier = [focusId];
      for (let h = 0; h < depth; h++) {
        const next: string[] = [];
        for (const id of frontier) for (const nb of adj.get(id) ?? []) if (!ids.has(nb)) { ids.add(nb); next.push(nb); }
        frontier = next;
      }
    } else ids = new Set(graph.nodes.map((n) => n.id));
    return {
      nodes: graph.nodes.filter((n) => ids.has(n.id)).map((n) => ({ ...n })),
      links: graph.links.filter((l) => ids.has(l.source as string) && ids.has(l.target as string)).map((l) => ({ ...l })),
    };
  }, [focusId, depth, graph, adj]);

  const goTo = (id: string) => { setRotate(false); if (id !== focusId) { setHistory((h) => [...h, focusId ?? ALL]); setFocusId(id); } };
  const back = () => setHistory((h) => { if (!h.length) return h; const p = h[h.length - 1]; setFocusId(p === ALL ? null : p); return h.slice(0, -1); });
  const showAll = () => { setFocusId(null); setHistory([]); setRotate(true); };

  const hostRef = useRef<HTMLDivElement>(null);
  const [graphW, setGraphW] = useState(900);
  const [graphH, setGraphH] = useState(GRAPH_H);
  const [isFs, setIsFs] = useState(false);   // native fullscreen
  const [cssFs, setCssFs] = useState(false); // CSS-overlay fallback (works inside the Dive iframe)
  const [resetSignal, setResetSignal] = useState(0); // bump to re-frame the canvas graph
  const [rotate, setRotate] = useState(true);        // 3D auto-rotate; stops on first interaction
  // graph fills whatever width the (full-width, drawer-aware) host gives it
  useEffect(() => {
    const el = hostRef.current; if (!el) return;
    const measure = () => { setGraphW(Math.max(320, el.clientWidth)); setGraphH(Math.max(320, el.clientHeight)); };
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, [tab, focusId, render]);

  // fullscreen the graph container; the overlay buttons live inside it so they stay reachable.
  // Prefer the native Fullscreen API, but fall back to a CSS fixed-overlay when it's blocked
  // (e.g. the Dive renders us in an iframe without fullscreen permission).
  const fsActive = isFs || cssFs;
  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  useEffect(() => {
    if (!cssFs) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCssFs(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cssFs]);
  const toggleFs = () => {
    const el = hostRef.current; if (!el) return;
    if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
    if (cssFs) { setCssFs(false); return; }
    const req = el.requestFullscreen?.();
    if (req?.catch) req.catch(() => setCssFs(true));   // blocked → CSS overlay
    else if (!el.requestFullscreen) setCssFs(true);    // unsupported → CSS overlay
  };

  const crumb = focusId ? `${focusId}'s network · ${depth === 1 ? "direct" : "2 steps"}` : `All ${graph.nodes.length} coaches`;

  // leaderboard: most protégés
  const leaders = useMemo(() => {
    return coaches.map((c) => {
      const protges = protegesOf.get(c.name) ?? [];
      const denom = (c.hc_wins ?? 0) + (c.hc_losses ?? 0);
      return {
        name: c.name, n: protges.length,
        hcs: protges.filter((e) => hcSet.has(e.coach)).length,
        wp: winPct(c), wpNum: c.hc_wins != null && denom > 0 ? c.hc_wins / denom : null,
        rings: c.super_bowl_rings ?? 0, tree: treeSize(c.name),
      };
    }).filter((r) => r.n > 0);
  }, [coaches, protegesOf, hcSet, treeSize]);

  const jumpFromTab = (id: string) => { setTab("explore"); goTo(id); };

  return (
    <div className="mx-auto my-6 px-6" style={{ maxWidth: 1180, width: "100%", color: "#231f20", fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 className="text-3xl font-bold" style={{ color: NFL }}>NFL Coaching Tree</h1>
      <p className="mt-1 text-sm" style={{ color: MUTED }}>
        Who trained under whom — arrows point from a head coach to a protégé. {graph.nodes.length} coaches, {graph.links.length} relationships.
      </p>

      {/* tabs */}
      <div className="flex gap-1 mt-4" style={{ borderBottom: "2px solid #e5e5e5" }}>
        {([["explore", "Explore"], ["leaderboard", "Leaderboard"], ["methodology", "Methodology"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className="px-4 py-2 text-sm font-medium"
            style={{ background: "transparent", color: tab === k ? NFL : MUTED, borderBottom: tab === k ? `2px solid ${NFL}` : "2px solid transparent", marginBottom: -2 }}>{label}</button>
        ))}
      </div>

      {tab === "explore" && (
        <>
          <div className="flex flex-wrap items-center gap-2 mt-3 text-sm">
            <div className="flex rounded overflow-hidden" style={{ border: "1px solid #ccc" }}>
              {(["3d", "2d"] as const).map((m) => (
                <button key={m} onClick={() => { setRender(m); if (m === "3d") setRotate(true); }} className="px-3 py-1"
                  style={{ background: render === m ? NFL : "#fff", color: render === m ? "#fff" : "#333" }}>{m.toUpperCase()}</button>
              ))}
            </div>
            <div className="flex rounded overflow-hidden" style={{ border: "1px solid #ccc" }}>
              {(["lineage", "role"] as const).map((m) => (
                <button key={m} onClick={() => setColorBy(m)} className="px-3 py-1"
                  style={{ background: colorBy === m ? NFL : "#fff", color: colorBy === m ? "#fff" : "#333" }}>{m === "lineage" ? "Lineage" : "Current Role"}</button>
              ))}
            </div>
            <button onClick={back} disabled={!history.length} className="px-3 py-1 rounded" style={{ border: "1px solid #ccc", background: "#fff", opacity: history.length ? 1 : 0.4 }}>← Back</button>
            <button onClick={showAll} disabled={!focusId} className="px-3 py-1 rounded" style={{ border: "1px solid #ccc", background: "#fff", opacity: focusId ? 1 : 0.4 }}>⌂ Show all</button>
            <select value={focusId ?? ""} onChange={(e) => (e.target.value ? goTo(e.target.value) : showAll())} className="px-2 py-1 rounded" style={{ border: "1px solid #ccc" }}>
              <option value="">Jump to a coach…</option>
              {[...graph.nodes].sort((a, b) => b.deg - a.deg || a.id.localeCompare(b.id)).map((n) => (
                <option key={n.id} value={n.id}>{n.id}{n.deg ? ` (${n.deg})` : ""}</option>
              ))}
            </select>
            {focusId && (
              <div className="flex items-center gap-1 ml-1">
                <span style={{ color: MUTED }}>depth</span>
                {([1, 2] as const).map((d) => (
                  <button key={d} onClick={() => setDepth(d)} className="px-2 py-1 rounded" style={{ border: "1px solid #ccc", background: depth === d ? NFL : "#fff", color: depth === d ? "#fff" : "#333" }}>{d}</button>
                ))}
              </div>
            )}
          </div>
          <div className="mt-2 text-sm font-medium" style={{ color: NFL }}>{crumb}</div>

          {colorBy === "lineage" && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs" style={{ color: MUTED }}>
              <span style={{ fontWeight: 700 }}>Founding trees:</span>
              {lineage.legend.map((g) => (
                <span key={g.root} onClick={() => goTo(g.root)} className="flex items-center gap-1" style={{ cursor: "pointer" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = NFL)} onMouseLeave={(e) => (e.currentTarget.style.color = "")}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: g.color, display: "inline-block" }} />
                  {g.root} <span style={{ opacity: 0.7 }}>({g.n})</span>
                </span>
              ))}
              <span className="flex items-center gap-1">
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: LINEAGE_OTHER, display: "inline-block" }} />
                other / unrooted
              </span>
            </div>
          )}

          <div className="flex gap-4 mt-2" style={{ alignItems: "flex-start" }}>
            {/* graph fills all width left by the drawer */}
            <div ref={hostRef} style={{
              border: "1px solid #eee", overflow: "hidden", background: render === "3d" ? "#0b1020" : "#fafafa",
              ...(cssFs
                ? { position: "fixed", inset: 0, zIndex: 9999, width: "100vw", height: "100vh", borderRadius: 0 }
                : { position: "relative", flex: 1, minWidth: 0, borderRadius: isFs ? 0 : 8, height: isFs ? "100%" : GRAPH_H }),
            }}>
              <div style={{ position: "absolute", top: 8, right: 8, zIndex: 5, display: "flex", gap: 6 }}>
                {render === "3d" && (
                  <button onClick={() => setRotate((r) => !r)} title={rotate ? "Stop rotation" : "Auto-rotate"}
                    style={{ ...overlayBtn(render), background: rotate ? NFL : "rgba(20,28,52,0.7)", color: "#fff" }}>↻ Rotate</button>
                )}
                <button onClick={() => setResetSignal((s) => s + 1)} title="Reset view" style={overlayBtn(render)}>⟲ Reset</button>
                <button onClick={toggleFs} title={fsActive ? "Exit full screen" : "Full screen"} style={overlayBtn(render)}>{fsActive ? "✕ Exit" : "⛶ Full screen"}</button>
              </div>
              {loading ? (
                <p className="p-8" style={{ color: MUTED }}>Loading data…</p>
              ) : (
                <GraphCanvas nodes={view.nodes} links={view.links} mode={render} colorBy={colorBy}
                  focusId={focusId} colorOf={lineage.colorOf} width={graphW} height={graphH}
                  imagesRef={imgCache} onNodeClick={goTo} resetSignal={resetSignal}
                  autoRotate={rotate} onInteract={() => setRotate(false)} />
              )}
            </div>

            {/* detail drawer: only present (and only costs width) when a coach is focused */}
            {focusId && byName.get(focusId) && (
              <div style={{ width: DRAWER_W, flex: "0 0 auto", border: "1px solid #eee", borderRadius: 8, height: GRAPH_H, overflowY: "auto", padding: 14, background: "#fff", position: "relative" }}>
                <button onClick={() => setFocusId(null)} title="Close" aria-label="Close"
                  style={{ position: "absolute", right: 8, top: 8, border: "none", background: "transparent", color: MUTED, fontSize: 18, lineHeight: 1, cursor: "pointer" }}>✕</button>
                <CoachCard c={byName.get(focusId)!} career={careerOf.get(focusId) ?? []} mentors={mentorsOf.get(focusId) ?? []} proteges={protegesOf.get(focusId) ?? []} hcSet={hcSet} tree={treeSize(focusId)} go={goTo} />
              </div>
            )}
          </div>

          <p className="text-xs mt-3" style={{ color: MUTED }}>
            Click any face to focus it (a detail card opens on the right) · <b>← Back</b> / <b>⌂ Show all</b> to return · bigger nodes = more protégés.
            Ring color: in <b>Lineage</b> mode each coach is tinted by their founding tree (traced through their longest-tenure mentor); in <b>Current Role</b> mode a navy ring marks a current 2026 coach.
            Win% is NFL head-coaching regular season; rings count Super Bowls won as a coach (incl. as an assistant). Source: Wikipedia.
            {" · "}
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer" style={{ color: "#0000EE", textDecoration: "underline" }}>Code &amp; methodology on GitHub</a>
          </p>
        </>
      )}

      {tab === "leaderboard" && <Leaderboard leaders={leaders} go={jumpFromTab} />}

      {tab === "methodology" && <Methodology nodes={graph.nodes.length} links={graph.links.length} />}
    </div>
  );
}

// ── Self-contained canvas graph (no three.js / react-force-graph) ───────────────
// Hand-rolled 3D force layout + perspective projection, drawn to one <canvas>.
// Only depends on React, so it runs in the MotherDuck Dive runtime. 2D mode flattens
// z to a plane and uses an orthographic pan/zoom camera; 3D mode orbits.
type Pos = { x: number; y: number; z: number; vx: number; vy: number; vz: number };
const REP = 4200, SPRING = 0.05, L0 = 34, CENTER = 0.025, DAMP = 0.86, A_MIN = 0.02;
const nodeWorldR = (deg: number) => 1.6 + Math.min(deg, 14) * 0.5;

function GraphCanvas({ nodes, links, mode, colorBy, focusId, colorOf, width, height, imagesRef, onNodeClick, resetSignal, autoRotate, onInteract }: {
  nodes: GNode[]; links: { source: string; target: string }[];
  mode: "3d" | "2d"; colorBy: "lineage" | "role"; focusId: string | null;
  colorOf: (id: string) => string; width: number; height: number;
  imagesRef: React.MutableRefObject<Map<string, HTMLImageElement>>;
  onNodeClick: (id: string) => void; resetSignal: number;
  autoRotate: boolean; onInteract: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const posRef = useRef<Map<string, Pos>>(new Map());
  const cam = useRef({ yaw: 0.5, pitch: -0.28, dist: 800, zoom: 1, panx: 0, pany: 0 });
  const alphaRef = useRef(1);
  const projRef = useRef<{ id: string; sx: number; sy: number; r: number }[]>([]);
  const drag = useRef({ active: false, moved: false, x: 0, y: 0 });

  // keep latest props in refs so the single rAF loop never goes stale
  const R = { nodes, links, mode, colorBy, focusId, colorOf, width, height, imagesRef, onNodeClick, autoRotate, onInteract };
  const ref = useRef(R); ref.current = R;

  const stepSim = () => {
    const { nodes: ns, links: ls, mode: md } = ref.current;
    const P = posRef.current, a = alphaRef.current, planar = md === "2d";
    for (let i = 0; i < ns.length; i++) {
      const pi = P.get(ns[i].id); if (!pi) continue;
      for (let j = i + 1; j < ns.length; j++) {
        const pj = P.get(ns[j].id); if (!pj) continue;
        const dx = pi.x - pj.x, dy = pi.y - pj.y, dz = planar ? 0 : pi.z - pj.z;
        const d2 = dx * dx + dy * dy + dz * dz + 0.01;
        const f = (REP * a) / d2, inv = 1 / Math.sqrt(d2);
        const fx = f * dx * inv, fy = f * dy * inv, fz = f * dz * inv;
        pi.vx += fx; pi.vy += fy; pi.vz += fz; pj.vx -= fx; pj.vy -= fy; pj.vz -= fz;
      }
    }
    for (const l of ls) {
      const p = P.get(l.source), q = P.get(l.target); if (!p || !q) continue;
      const dx = q.x - p.x, dy = q.y - p.y, dz = planar ? 0 : q.z - p.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.001;
      const f = (SPRING * a * (d - L0)) / d, fx = f * dx, fy = f * dy, fz = f * dz;
      p.vx += fx; p.vy += fy; p.vz += fz; q.vx -= fx; q.vy -= fy; q.vz -= fz;
    }
    for (const n of ns) {
      const p = P.get(n.id); if (!p) continue;
      p.vx += -CENTER * a * p.x; p.vy += -CENTER * a * p.y; if (!planar) p.vz += -CENTER * a * p.z;
      p.vx *= DAMP; p.vy *= DAMP; p.vz *= DAMP;
      p.x += p.vx; p.y += p.vy;
      if (planar) { p.z = 0; p.vz = 0; } else p.z += p.vz;
    }
    alphaRef.current = a > A_MIN ? a * 0.985 : a;
  };

  const project = (p: Pos) => {
    const { width: w, height: h, mode: md } = ref.current;
    if (md === "2d") {
      const z = cam.current.zoom;
      return { sx: w / 2 + p.x * z + cam.current.panx, sy: h / 2 + p.y * z + cam.current.pany, scale: z, depth: 0 };
    }
    const { yaw, pitch, dist } = cam.current;
    const cyaw = Math.cos(yaw), syaw = Math.sin(yaw);
    const x = p.x * cyaw + p.z * syaw, zr = -p.x * syaw + p.z * cyaw;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const y2 = p.y * cp - zr * sp, z2 = p.y * sp + zr * cp;
    const viewZ = Math.max(1, dist - z2);
    const F = Math.min(w, h) * 0.9, k = F / viewZ;
    return { sx: w / 2 + x * k, sy: h / 2 - y2 * k, scale: k, depth: z2 };
  };

  const fit = (resetAngles: boolean) => {
    const ps = [...posRef.current.values()]; if (!ps.length) return;
    const { width: w, height: h, mode: md } = ref.current;
    if (md === "2d") {
      let maxR = 1; for (const p of ps) maxR = Math.max(maxR, Math.hypot(p.x, p.y));
      cam.current.zoom = (Math.min(w, h) / 2 * 0.92) / maxR; cam.current.panx = 0; cam.current.pany = 0;
    } else {
      let maxR = 1; for (const p of ps) maxR = Math.max(maxR, Math.hypot(p.x, p.y, p.z));
      if (resetAngles) { cam.current.yaw = 0.5; cam.current.pitch = -0.28; }
      const F = Math.min(w, h) * 0.9, target = Math.min(w, h) / 2 * 0.84;
      cam.current.dist = Math.max(maxR * 1.7, (maxR * F) / target);
    }
  };

  // rebuild layout when the node set or mode changes; warm up so it appears settled
  const nodeKey = nodes.map((n) => n.id).join("|") + "|" + mode;
  useEffect(() => {
    const P = new Map<string, Pos>(); const n = nodes.length || 1, RAD = 240;
    nodes.forEach((nd, i) => {
      const ang = i * 2.399963, t = (i + 0.5) / n, rr = RAD * Math.cbrt(t), yy = 1 - 2 * t;
      const ring = Math.sqrt(Math.max(0, 1 - yy * yy));
      P.set(nd.id, { x: rr * Math.cos(ang) * ring, y: rr * yy, z: mode === "2d" ? 0 : rr * Math.sin(ang) * ring, vx: 0, vy: 0, vz: 0 });
    });
    posRef.current = P; alphaRef.current = 1;
    for (let t = 0; t < 280; t++) stepSim();
    fit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeKey]);

  useEffect(() => { fit(true); /* Reset button */ }, [resetSignal]);
  useEffect(() => { fit(false); /* container resize */ }, [width, height]);

  // single render/animation loop
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const cv = canvasRef.current;
      if (cv) {
        const { width: w, height: h, mode: md, colorBy: cb, focusId: fid, colorOf: cof, nodes: ns, links: ls, imagesRef: imgs } = ref.current;
        if (alphaRef.current > A_MIN) { stepSim(); stepSim(); }
        if (md === "3d" && ref.current.autoRotate && !drag.current.active) cam.current.yaw += 0.0012; // gentle drift; off after first interaction
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
        const ctx = cv.getContext("2d");
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          const dark = md === "3d";
          ctx.fillStyle = dark ? "#0b1020" : "#fafafa"; ctx.fillRect(0, 0, w, h);
          const proj = new Map<string, { sx: number; sy: number; scale: number; depth: number }>();
          let zmin = Infinity, zmax = -Infinity;
          for (const nd of ns) { const p = posRef.current.get(nd.id); if (!p) continue; const pr = project(p); proj.set(nd.id, pr); if (pr.depth < zmin) zmin = pr.depth; if (pr.depth > zmax) zmax = pr.depth; }
          const zspan = Math.max(1, zmax - zmin);
          const rById = new Map<string, number>();
          for (const nd of ns) { const pr = proj.get(nd.id); if (pr) rById.set(nd.id, Math.max(3, nodeWorldR(nd.deg) * pr.scale)); }
          // links: mentor (source) -> protégé (target), with a small arrowhead at the protégé
          for (const l of ls) {
            const a = proj.get(l.source), b = proj.get(l.target); if (!a || !b) continue;
            const col = cb === "lineage" ? hexA(cof(l.target), dark ? 0.8 : 0.55) : dark ? "rgba(220,228,245,0.4)" : "#cfcfcf";
            ctx.strokeStyle = col; ctx.lineWidth = cb === "lineage" ? 1.1 : 0.7;
            ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
            const dx = b.sx - a.sx, dy = b.sy - a.sy, len = Math.hypot(dx, dy) || 1;
            const ux = dx / len, uy = dy / len, tr = (rById.get(l.target) ?? 4) + 1, ah = 4.5;
            const tx = b.sx - ux * tr, ty = b.sy - uy * tr;
            ctx.fillStyle = col; ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(tx - ux * ah - uy * ah * 0.55, ty - uy * ah + ux * ah * 0.55);
            ctx.lineTo(tx - ux * ah + uy * ah * 0.55, ty - uy * ah - ux * ah * 0.55);
            ctx.closePath(); ctx.fill();
          }
          // nodes back-to-front
          const order = ns.filter((nd) => proj.has(nd.id)).sort((p, q) => proj.get(p.id)!.depth - proj.get(q.id)!.depth);
          projRef.current = [];
          for (const nd of order) {
            const pr = proj.get(nd.id)!; const r = Math.max(3, nodeWorldR(nd.deg) * pr.scale);
            const fade = dark ? 0.55 + 0.45 * ((pr.depth - zmin) / zspan) : 1;
            const ring = nd.id === fid ? RED : cb === "lineage" ? cof(nd.id) : nd.roster ? (dark ? "#3b7dd8" : NFL) : dark ? "#888" : "#bbb";
            const im = imgs.current.get(nd.id);
            ctx.globalAlpha = fade;
            if (im && im.complete && im.naturalWidth) {
              ctx.save(); ctx.beginPath(); ctx.arc(pr.sx, pr.sy, r, 0, 2 * Math.PI); ctx.clip();
              ctx.drawImage(im, pr.sx - r, pr.sy - r, r * 2, r * 2); ctx.restore();
              ctx.beginPath(); ctx.arc(pr.sx, pr.sy, r, 0, 2 * Math.PI);
              ctx.lineWidth = nd.id === fid ? 3 : cb === "lineage" ? 2 : 1.4; ctx.strokeStyle = ring; ctx.stroke();
            } else {
              ctx.beginPath(); ctx.arc(pr.sx, pr.sy, r, 0, 2 * Math.PI); ctx.fillStyle = ring; ctx.fill();
            }
            ctx.globalAlpha = 1;
            projRef.current.push({ id: nd.id, sx: pr.sx, sy: pr.sy, r });
            if (nd.deg >= 5 || nd.id === fid) {
              ctx.fillStyle = dark ? "rgba(232,238,255,0.92)" : "#222";
              ctx.font = `${nd.id === fid ? 700 : 600} 11px ui-sans-serif, system-ui`; ctx.textAlign = "center";
              ctx.fillText(nd.id, pr.sx, pr.sy + r + 11);
            }
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // interaction: orbit / pan / zoom / click
  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return;
    const down = (e: PointerEvent) => { drag.current = { active: true, moved: false, x: e.clientX, y: e.clientY }; ref.current.onInteract(); };
    const move = (e: PointerEvent) => {
      if (!drag.current.active) return;
      const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true;
      drag.current.x = e.clientX; drag.current.y = e.clientY;
      if (ref.current.mode === "3d") {
        cam.current.yaw += dx * 0.008;
        cam.current.pitch = Math.max(-1.45, Math.min(1.45, cam.current.pitch + dy * 0.008));
      } else { cam.current.panx += dx; cam.current.pany += dy; }
    };
    const up = (e: PointerEvent) => {
      if (drag.current.active && !drag.current.moved) {
        const rect = cv.getBoundingClientRect(), mx = e.clientX - rect.left, my = e.clientY - rect.top;
        let best: string | null = null, bd = 1e9;
        for (const q of projRef.current) { const d = Math.hypot(q.sx - mx, q.sy - my); if (d <= q.r + 5 && d < bd) { bd = d; best = q.id; } }
        if (best) ref.current.onNodeClick(best);
      }
      drag.current.active = false;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault(); ref.current.onInteract();
      if (ref.current.mode === "3d") cam.current.dist = Math.max(60, Math.min(6000, cam.current.dist * (1 + e.deltaY * 0.0012)));
      else cam.current.zoom = Math.max(0.05, Math.min(20, cam.current.zoom * (1 - e.deltaY * 0.0012)));
    };
    cv.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    cv.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cv.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      cv.removeEventListener("wheel", wheel);
    };
  }, []);

  return <canvas ref={canvasRef} style={{ width, height, display: "block", cursor: "grab", touchAction: "none" }} />;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div><div style={{ fontSize: 20, fontWeight: 700, color: NFL }}>{value}</div><div style={{ fontSize: 11, color: MUTED }}>{label}</div></div>;
}

function CoachCard({ c, career, mentors, proteges, hcSet, tree, go }: {
  c: Coach; career: Stint[]; mentors: Edge[]; proteges: Edge[]; hcSet: Set<string>; tree: number; go: (id: string) => void;
}) {
  const cur = [...career].reverse().find((s) => s.end_year >= 9999) ?? career[career.length - 1];
  const wp = winPct(c);
  const hcProduced = proteges.filter((e) => hcSet.has(e.coach)).length;
  return (
    <div>
      <div className="flex items-center gap-3">
        {c.image_b64 ? <img src={c.image_b64} width={54} height={54} style={{ borderRadius: "50%", border: `2px solid ${NFL}` }} />
          : <div style={{ width: 54, height: 54, borderRadius: "50%", background: "#eee" }} />}
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{c.name}</div>
          {cur && <div style={{ fontSize: 12, color: MUTED }}>{cur.team} — {cur.role}</div>}
        </div>
      </div>

      <div className="flex gap-5 mt-3">
        {wp ? <Stat label="HC win%" value={wp} /> : <Stat label="role" value={c.is_roster ? "current" : "—"} />}
        {c.hc_wins != null && <Stat label="HC record" value={`${c.hc_wins}-${c.hc_losses}${c.hc_ties ? "-" + c.hc_ties : ""}`} />}
        {(c.super_bowl_rings ?? 0) > 0 && <Stat label="SB rings" value={`${c.super_bowl_rings}`} />}
      </div>
      <div className="flex gap-5 mt-3">
        <Stat label="protégés" value={`${proteges.length}`} />
        <Stat label="became HC" value={`${hcProduced}`} />
        <Stat label="tree size" value={`${tree}`} />
      </div>

      {mentors.length > 0 && <Section title="Served under">
        {mentors.sort((a, b) => a.first_year - b.first_year).map((e) => <Row key={e.served_under} name={e.served_under} sub={yrs(e.first_year, e.last_year)} hc={hcSet.has(e.served_under)} go={go} />)}
      </Section>}

      {proteges.length > 0 && <Section title={`Protégés (${proteges.length})`}>
        {proteges.sort((a, b) => b.last_year - a.last_year).map((e) => <Row key={e.coach} name={e.coach} sub={yrs(e.first_year, e.last_year)} hc={hcSet.has(e.coach)} go={go} />)}
      </Section>}

      <Section title="Career">
        {career.map((s, i) => (
          <div key={i} style={{ fontSize: 12, padding: "2px 0", display: "flex", gap: 8 }}>
            <span style={{ color: MUTED, minWidth: 78 }}>{yrs(s.start_year, s.end_year)}</span>
            <span>{s.team}<span style={{ color: MUTED }}> — {s.role}</span></span>
          </div>
        ))}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="mt-4"><div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: MUTED, letterSpacing: 0.5, marginBottom: 4 }}>{title}</div>{children}</div>;
}
function Row({ name, sub, hc, go }: { name: string; sub: string; hc: boolean; go: (id: string) => void }) {
  return (
    <div onClick={() => go(name)} style={{ fontSize: 13, padding: "3px 0", cursor: "pointer", display: "flex", justifyContent: "space-between" }}
      onMouseEnter={(e) => (e.currentTarget.style.color = NFL)} onMouseLeave={(e) => (e.currentTarget.style.color = "")}>
      <span>{name}{hc && <span style={{ fontSize: 9, color: NFL, border: `1px solid ${NFL}`, borderRadius: 3, padding: "0 3px", marginLeft: 5, verticalAlign: "middle" }}>HC</span>}</span>
      <span style={{ color: MUTED, fontSize: 11 }}>{sub}</span>
    </div>
  );
}

type LeaderRow = { name: string; n: number; hcs: number; wp: string | null; wpNum: number | null; rings: number; tree: number };
type SortKey = "name" | "n" | "hcs" | "tree" | "wpNum" | "rings";

function Leaderboard({ leaders, go }: { leaders: LeaderRow[]; go: (id: string) => void }) {
  const [sortKey, setSortKey] = useState<SortKey>("n");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const clickSort = (k: SortKey) => {
    if (k === sortKey) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setDir(k === "name" ? "asc" : "desc"); }
  };
  const rows = useMemo(() => {
    const s = dir === "asc" ? 1 : -1;
    const val = (r: LeaderRow) => r[sortKey];
    return [...leaders].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;   // nulls always last
      if (bv == null) return -1;
      if (typeof av === "string") return (av as string).localeCompare(bv as string) * s;
      return ((av as number) - (bv as number)) * s || b.n - a.n;
    }).slice(0, 25);
  }, [leaders, sortKey, dir]);

  const cell = { padding: "6px 10px", borderBottom: "1px solid #f0f0f0", fontSize: 14 };
  const num = { ...cell, textAlign: "right" as const };
  const cols: { key: SortKey; label: string; align: "left" | "right" }[] = [
    { key: "name", label: "Coach", align: "left" },
    { key: "n", label: "Protégés", align: "right" },
    { key: "hcs", label: "→HC", align: "right" },
    { key: "tree", label: "Tree", align: "right" },
    { key: "wpNum", label: "HC win%", align: "right" },
    { key: "rings", label: "Rings", align: "right" },
  ];
  const Th = ({ k, label, align }: { k: SortKey; label: string; align: "left" | "right" }) => (
    <th onClick={() => clickSort(k)} title="Click to sort"
      style={{ fontWeight: 700, color: sortKey === k ? NFL : MUTED, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, padding: "6px 10px", borderBottom: "2px solid #e5e5e5", textAlign: align, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}>
      {label}{sortKey === k ? (dir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
  return (
    <div className="mt-4" style={{ maxWidth: 760 }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: NFL }}>Biggest coaching trees</div>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 10 }}>
        Coaches who produced protégés (assistants who served under them). Click a column to sort; click any coach to open their network on the Explore tab.
        <b> →HC</b> = protégés who became NFL head coaches · <b>tree</b> = total descendants, all generations · ★ = Super Bowls won. Top 25 shown.
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ width: 36, padding: "6px 10px", borderBottom: "2px solid #e5e5e5", textAlign: "right", color: MUTED, fontSize: 12 }}>#</th>
            {cols.map((c) => <Th key={c.key} k={c.key} label={c.label} align={c.align} />)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.name} onClick={() => go(r.name)} style={{ cursor: "pointer" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#f6f8fb")} onMouseLeave={(e) => (e.currentTarget.style.background = "")}>
              <td style={{ ...num, color: MUTED }}>{i + 1}</td>
              <td style={{ ...cell, fontWeight: 600, color: NFL }}>{r.name}</td>
              <td style={{ ...num, fontWeight: 700 }}>{r.n}</td>
              <td style={num}>{r.hcs}</td>
              <td style={{ ...num, color: MUTED }}>{r.tree}</td>
              <td style={num}>{r.wp ?? "—"}</td>
              <td style={{ ...num, color: r.rings ? "#b8860b" : MUTED }}>{r.rings ? "★".repeat(Math.min(r.rings, 4)) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Methodology({ nodes, links }: { nodes: number; links: number }) {
  const H = ({ children }: { children: React.ReactNode }) => <div style={{ fontSize: 15, fontWeight: 700, color: NFL, marginTop: 18, marginBottom: 4 }}>{children}</div>;
  const P = ({ children }: { children: React.ReactNode }) => <p style={{ fontSize: 14, lineHeight: 1.55, marginBottom: 6 }}>{children}</p>;
  return (
    <div className="mt-4" style={{ maxWidth: 760, color: "#231f20" }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: NFL }}>How this was built</div>
      <P>
        A <b>{nodes}-coach, {links}-relationship</b> graph of the 2026 NFL coaching staffs and the head coaches they trained under,
        assembled entirely from Wikipedia and served from a self-contained MotherDuck database.
      </P>

      <H>Data</H>
      <P>
        We start from the 32 current head coaches plus each team's offensive and defensive coordinators (some teams have none — the head coach calls plays).
        For every coach we fetch their Wikipedia "coaching career" history, and for all 32 franchises the full "List of head coaches" tables.
      </P>

      <H>Deriving who served under whom</H>
      <P>
        Each assistant stint is expanded to individual seasons and joined to whoever was head coach of that franchise that year.
        Franchises are canonicalized across relocations and renames (Oakland/LA/Las Vegas Raiders, Redskins→Commanders, Oilers→Titans, …) so the eras line up.
        That join produces the mentor→protégé edges; arrows in the graph point from a head coach to the people who worked under them.
      </P>

      <H>Founding trees (lineage coloring)</H>
      <P>
        The raw graph is a tangle — a coach often served under several head coaches. To draw clean trees we give each coach a single
        <i> primary</i> mentor (the head coach they spent the most seasons under) and trace that chain to its root. The six largest roots get distinct colors;
        everyone else is grey. This is why familiar trees emerge — Shanahan → McVay/LaFleur/McDaniel, Holmgren → Reid/Harbaugh, Parcells → Payton/Campbell.
      </P>

      <H>Records and parsing</H>
      <P>
        Win–loss records and Super Bowl rings come from each coach's infobox; win% is NFL head-coaching regular season only, so dual college/NFL coaches
        show their NFL figures. Messy wikitext (templates, multi-league careers) was parsed with a mix of deterministic fetching and LLM extraction.
      </P>

      <H>Hosting</H>
      <P>
        Faces are 96px thumbnails stored as base64 directly in the MotherDuck table and rendered as data-URIs, so the visualization needs no external image host.
        Everything you see is one React component reading three tables (coaches, edges, stints) live from MotherDuck.
      </P>

      <P style={{ color: MUTED, fontSize: 12, marginTop: 12 }}>
        Limitations: coverage is only as deep as Wikipedia's coaching histories, so some chains are shallow (a mentor may be attributed to the wrong founder when an
        earlier link is missing). Minor/short assistant stints can be incomplete. Source: Wikipedia, retrieved 2026.
      </P>
      <P>
        Open source — the full data pipeline and this component are on{" "}
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer" style={{ color: "#0000EE", textDecoration: "underline" }}>GitHub</a>.
      </P>
    </div>
  );
}
