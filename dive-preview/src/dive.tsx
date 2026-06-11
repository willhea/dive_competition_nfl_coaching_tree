import { useEffect, useMemo, useRef, useState } from "react";
import { useSQLQuery } from "@motherduck/react-sql-query";
import ForceGraph2D from "react-force-graph-2d";
import ForceGraph3D from "react-force-graph-3d";
import * as THREE from "three";

// NFL coaching tree — 2D/3D relationship graph + coach detail panel + leaderboard.
// Faces and stats come straight from the MotherDuck nfl_coaching_tree database.

const NFL = "#013369";
const RED = "#D50A0A";
const MUTED = "#6a6a6a";
const GRAPH_H = 620;
const DRAWER_W = 340;
const ALL = "__ALL__";

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

  const imgCache = useRef(new Map<string, HTMLImageElement>());
  const texCache = useRef(new Map<string, THREE.Texture>());
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!graph.nodes.length) return;
    let done = 0;
    const withImg = graph.nodes.filter((n) => n.img);
    if (!withImg.length) { setReady(true); return; }
    const finish = () => { if (++done >= withImg.length) setReady(true); };
    for (const n of withImg) {
      const im = new Image(); im.crossOrigin = "anonymous"; im.onload = finish; im.onerror = finish; im.src = n.img!;
      imgCache.current.set(n.id, im);
    }
    const t = setTimeout(() => setReady(true), 2500);
    return () => clearTimeout(t);
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

  const goTo = (id: string) => { if (id !== focusId) { setHistory((h) => [...h, focusId ?? ALL]); setFocusId(id); } };
  const back = () => setHistory((h) => { if (!h.length) return h; const p = h[h.length - 1]; setFocusId(p === ALL ? null : p); return h.slice(0, -1); });
  const showAll = () => { setFocusId(null); setHistory([]); };

  const radius = (n: GNode) => 4 + Math.min(n.deg, 14) * 1.1;

  const draw2D = (node: any, ctx: CanvasRenderingContext2D, scale: number) => {
    const r = radius(node); const im = imgCache.current.get(node.id);
    ctx.save(); ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    if (im && im.complete && im.naturalWidth) {
      ctx.clip(); ctx.drawImage(im, node.x - r, node.y - r, r * 2, r * 2); ctx.restore();
      ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.lineWidth = node.id === focusId ? 3 : colorBy === "lineage" ? 2 : node.roster ? 1.6 : 0.8;
      ctx.strokeStyle = node.id === focusId ? RED : colorBy === "lineage" ? lineage.colorOf(node.id) : node.roster ? NFL : "#bbb"; ctx.stroke();
    } else { ctx.fillStyle = node.id === focusId ? RED : colorBy === "lineage" ? lineage.colorOf(node.id) : node.roster ? NFL : "#c9c9c9"; ctx.fill(); ctx.restore(); }
    if (scale > 2.4 || node.deg >= 5 || node.id === focusId) {
      ctx.font = `${node.deg >= 5 || node.id === focusId ? 700 : 400} ${Math.max(3, 9 / Math.sqrt(scale))}px sans-serif`;
      ctx.fillStyle = "#222"; ctx.textAlign = "center";
      ctx.fillText(node.id, node.x, node.y + r + 8 / Math.sqrt(scale));
    }
  };

  const circleTexture = (node: any): THREE.Texture | null => {
    const ring = node.id === focusId ? RED : colorBy === "lineage" ? lineage.colorOf(node.id) : node.roster ? "#3b7dd8" : "#888";
    const key = `${node.id}|${ring}`; // re-bake when the ring color (focus / lineage) changes
    if (texCache.current.has(key)) return texCache.current.get(key)!;
    const im = imgCache.current.get(node.id);
    if (!im || !im.complete || !im.naturalWidth) return null;
    const S = 128; const cv = document.createElement("canvas"); cv.width = cv.height = S;
    const ctx = cv.getContext("2d")!;
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 2, 0, 2 * Math.PI); ctx.clip();
    ctx.drawImage(im, 0, 0, S, S);
    ctx.lineWidth = colorBy === "lineage" ? 8 : 6; ctx.strokeStyle = ring;
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 4, 0, 2 * Math.PI); ctx.stroke();
    const tex = new THREE.CanvasTexture(cv); texCache.current.set(key, tex); return tex;
  };
  const node3D = (node: any) => {
    const r = radius(node); const tex = circleTexture(node);
    if (tex) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex })); s.scale.set(r * 1.7, r * 1.7, 1); return s; }
    const fallback = node.id === focusId ? RED : colorBy === "lineage" ? lineage.colorOf(node.id) : node.roster ? NFL : "#c9c9c9";
    return new THREE.Mesh(new THREE.SphereGeometry(r * 0.7, 12, 12),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(fallback) }));
  };

  // links are tinted by the protégé's (target's) lineage. 3D needs a higher alpha
  // and its own opacity left ungated (linkOpacity is removed below), or the colors
  // wash out to grey on the dark background.
  const linkColorFn = (l: any) => {
    const t = typeof l.target === "object" ? l.target.id : l.target;
    if (colorBy !== "lineage") return render === "3d" ? "rgba(220,228,245,0.5)" : "#cfcfcf";
    return hexA(lineage.colorOf(t), render === "3d" ? 0.85 : 0.6);
  };

  const fg2d = useRef<any>(null); const fg3d = useRef<any>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [graphW, setGraphW] = useState(900);
  // zoomToFit frames the whole bounding box, which leaves the dense core small
  // (scattered low-degree nodes inflate the box). Fit, then push in past the fit so
  // the graph fills the window; the user can still zoom/pan out.
  const fitView = () => setTimeout(() => {
    try {
      if (render === "3d") {
        const fg = fg3d.current; if (!fg) return;
        fg.zoomToFit(500, focusId ? 40 : 16);
        const f = focusId ? 0.82 : 0.6; // move camera toward center => zoom in
        setTimeout(() => { const c = fg.cameraPosition(); fg.cameraPosition({ x: c.x * f, y: c.y * f, z: c.z * f }, undefined, 500); }, 560);
      } else {
        const fg = fg2d.current; if (!fg) return;
        fg.zoomToFit(500, focusId ? 50 : 22);
        setTimeout(() => { try { fg.zoom(fg.zoom() * (focusId ? 1.25 : 1.7), 500); } catch {} }, 560);
      }
    } catch {}
  }, 60);
  // graph fills whatever width the (full-width, drawer-aware) host gives it
  useEffect(() => {
    const el = hostRef.current; if (!el) return;
    const measure = () => setGraphW(Math.max(320, el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, [tab, focusId, render]);
  useEffect(() => { fitView(); }, [graphW]); // refit when the canvas resizes

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
                <button key={m} onClick={() => setRender(m)} className="px-3 py-1"
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
            <div ref={hostRef} style={{ flex: 1, minWidth: 0, border: "1px solid #eee", borderRadius: 8, overflow: "hidden", background: render === "3d" ? "#0b1020" : "#fafafa", height: GRAPH_H }}>
              {loading || !ready ? (
                <p className="p-8" style={{ color: MUTED }}>{loading ? "Loading data…" : "Loading faces…"}</p>
              ) : render === "3d" ? (
                <ForceGraph3D ref={fg3d} graphData={view} width={graphW} height={GRAPH_H} backgroundColor="#0b1020"
                  nodeThreeObject={node3D} linkColor={linkColorFn} linkWidth={colorBy === "lineage" ? 1.6 : 0.5} linkDirectionalArrowLength={3} linkDirectionalArrowRelPos={1}
                  onEngineStop={fitView} onNodeClick={(n: any) => goTo(n.id)} />
              ) : (
                <ForceGraph2D ref={fg2d} graphData={view} width={graphW} height={GRAPH_H} nodeCanvasObject={draw2D}
                  nodePointerAreaPaint={(n: any, c, ctx) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(n.x, n.y, radius(n), 0, 2 * Math.PI); ctx.fill(); }}
                  linkColor={linkColorFn} linkWidth={colorBy === "lineage" ? 1.2 : 0.6} linkDirectionalArrowLength={3} linkDirectionalArrowRelPos={1} cooldownTicks={120} d3VelocityDecay={0.3}
                  onEngineStop={fitView} onNodeClick={(n: any) => goTo(n.id)} />
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
          </p>
        </>
      )}

      {tab === "leaderboard" && <Leaderboard leaders={leaders} go={jumpFromTab} />}

      {tab === "methodology" && <Methodology nodes={graph.nodes.length} links={graph.links.length} />}
    </div>
  );
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
    </div>
  );
}
