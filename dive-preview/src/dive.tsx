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
const GRAPH_W = 520;
const HEIGHT = 560;
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

export default function CoachingTree() {
  const coachesQ = useSQLQuery<Coach[]>(`SELECT name, image_b64, is_roster, is_nfl_hc, hc_wins, hc_losses, hc_ties, super_bowl_rings FROM nfl_coaching_tree.coaches`);
  const edgesQ = useSQLQuery<Edge[]>(`SELECT coach, served_under, first_year, last_year FROM nfl_coaching_tree.edges`);
  const stintsQ = useSQLQuery<Stint[]>(`SELECT coach, team, start_year, end_year, role, is_head_coach FROM nfl_coaching_tree.stints`);
  const coaches = (coachesQ.data ?? []) as Coach[];
  const edges = (edgesQ.data ?? []) as Edge[];
  const stints = (stintsQ.data ?? []) as Stint[];
  const loading = coachesQ.isLoading || edgesQ.isLoading || stintsQ.isLoading;

  const [render, setRender] = useState<"3d" | "2d">("3d");
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
      ctx.lineWidth = node.id === focusId ? 3 : node.roster ? 1.6 : 0.8;
      ctx.strokeStyle = node.id === focusId ? RED : node.roster ? NFL : "#bbb"; ctx.stroke();
    } else { ctx.fillStyle = node.id === focusId ? RED : node.roster ? NFL : "#c9c9c9"; ctx.fill(); ctx.restore(); }
    if (scale > 2.4 || node.deg >= 5 || node.id === focusId) {
      ctx.font = `${node.deg >= 5 || node.id === focusId ? 700 : 400} ${Math.max(3, 9 / Math.sqrt(scale))}px sans-serif`;
      ctx.fillStyle = "#222"; ctx.textAlign = "center";
      ctx.fillText(node.id, node.x, node.y + r + 8 / Math.sqrt(scale));
    }
  };

  const circleTexture = (node: any): THREE.Texture | null => {
    if (texCache.current.has(node.id)) return texCache.current.get(node.id)!;
    const im = imgCache.current.get(node.id);
    if (!im || !im.complete || !im.naturalWidth) return null;
    const S = 128; const cv = document.createElement("canvas"); cv.width = cv.height = S;
    const ctx = cv.getContext("2d")!;
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 2, 0, 2 * Math.PI); ctx.clip();
    ctx.drawImage(im, 0, 0, S, S);
    ctx.lineWidth = 6; ctx.strokeStyle = node.id === focusId ? RED : node.roster ? "#3b7dd8" : "#888";
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 3, 0, 2 * Math.PI); ctx.stroke();
    const tex = new THREE.CanvasTexture(cv); texCache.current.set(node.id, tex); return tex;
  };
  const node3D = (node: any) => {
    const r = radius(node); const tex = circleTexture(node);
    if (tex) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex })); s.scale.set(r * 1.7, r * 1.7, 1); return s; }
    return new THREE.Mesh(new THREE.SphereGeometry(r * 0.7, 12, 12),
      new THREE.MeshLambertMaterial({ color: node.id === focusId ? 0xd50a0a : node.roster ? NFL : 0xc9c9c9 }));
  };

  const fg2d = useRef<any>(null); const fg3d = useRef<any>(null);
  const fitView = () => setTimeout(() => { try { (render === "3d" ? fg3d : fg2d).current?.zoomToFit(500, focusId ? 60 : 30); } catch {} }, 60);

  const crumb = focusId ? `${focusId}'s network · ${depth === 1 ? "direct" : "2 steps"}` : `All ${graph.nodes.length} coaches`;

  // leaderboard: most protégés
  const leaders = useMemo(() => {
    return coaches.map((c) => {
      const protges = protegesOf.get(c.name) ?? [];
      return {
        name: c.name, n: protges.length,
        hcs: protges.filter((e) => hcSet.has(e.coach)).length,
        wp: winPct(c), rings: c.super_bowl_rings ?? 0, tree: treeSize(c.name),
      };
    }).filter((r) => r.n > 0).sort((a, b) => b.n - a.n || b.tree - a.tree).slice(0, 15);
  }, [coaches, protegesOf, hcSet, treeSize]);

  return (
    <div className="mx-auto my-6 px-6" style={{ maxWidth: GRAPH_W + 360, color: "#231f20", fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 className="text-3xl font-bold" style={{ color: NFL }}>NFL Coaching Tree</h1>
      <p className="mt-1 text-sm" style={{ color: MUTED }}>
        Who trained under whom — arrows point from a head coach to a protégé. {graph.nodes.length} coaches, {graph.links.length} relationships.
      </p>

      <div className="flex flex-wrap items-center gap-2 mt-4 text-sm">
        <div className="flex rounded overflow-hidden" style={{ border: "1px solid #ccc" }}>
          {(["3d", "2d"] as const).map((m) => (
            <button key={m} onClick={() => setRender(m)} className="px-3 py-1"
              style={{ background: render === m ? NFL : "#fff", color: render === m ? "#fff" : "#333" }}>{m.toUpperCase()}</button>
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

      <div className="flex gap-4 mt-2" style={{ alignItems: "flex-start" }}>
        {/* graph */}
        <div style={{ border: "1px solid #eee", borderRadius: 8, overflow: "hidden", background: render === "3d" ? "#0b1020" : "#fafafa", width: GRAPH_W, height: HEIGHT, flex: "0 0 auto" }}>
          {loading || !ready ? (
            <p className="p-8" style={{ color: MUTED }}>{loading ? "Loading data…" : "Loading faces…"}</p>
          ) : render === "3d" ? (
            <ForceGraph3D ref={fg3d} graphData={view} width={GRAPH_W} height={HEIGHT} backgroundColor="#0b1020"
              nodeThreeObject={node3D} linkColor={() => "rgba(255,255,255,0.22)"} linkDirectionalArrowLength={3} linkDirectionalArrowRelPos={1} linkOpacity={0.35}
              onEngineStop={fitView} onNodeClick={(n: any) => goTo(n.id)} />
          ) : (
            <ForceGraph2D ref={fg2d} graphData={view} width={GRAPH_W} height={HEIGHT} nodeCanvasObject={draw2D}
              nodePointerAreaPaint={(n: any, c, ctx) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(n.x, n.y, radius(n), 0, 2 * Math.PI); ctx.fill(); }}
              linkColor={() => "#cfcfcf"} linkDirectionalArrowLength={3} linkDirectionalArrowRelPos={1} cooldownTicks={120} d3VelocityDecay={0.3}
              onEngineStop={fitView} onNodeClick={(n: any) => goTo(n.id)} />
          )}
        </div>

        {/* side panel: coach detail when focused, else leaderboard */}
        <div style={{ width: 320, flex: "0 0 auto", border: "1px solid #eee", borderRadius: 8, height: HEIGHT, overflowY: "auto", padding: 14, background: "#fff" }}>
          {focusId && byName.get(focusId)
            ? <CoachCard c={byName.get(focusId)!} career={careerOf.get(focusId) ?? []} mentors={mentorsOf.get(focusId) ?? []} proteges={protegesOf.get(focusId) ?? []} hcSet={hcSet} tree={treeSize(focusId)} go={goTo} />
            : <Leaderboard leaders={leaders} go={goTo} />}
        </div>
      </div>

      <p className="text-xs mt-3" style={{ color: MUTED }}>
        Click any face to focus it and see their card · <b>← Back</b> / <b>⌂ Show all</b> to return · bigger nodes = more protégés, navy ring = current 2026 coach.
        Win% is NFL head-coaching regular season; rings count Super Bowls won as a coach (incl. as an assistant). Source: Wikipedia.
      </p>
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

function Leaderboard({ leaders, go }: { leaders: { name: string; n: number; hcs: number; wp: string | null; rings: number; tree: number }[]; go: (id: string) => void }) {
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 700, color: NFL }}>Biggest coaching trees</div>
      <div style={{ fontSize: 11, color: MUTED, marginBottom: 8 }}>Ranked by direct protégés. Click a coach to open their tree. ★ = Super Bowl rings; →HC = protégés who became head coaches.</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: "2px 10px", fontSize: 12 }}>
        <div style={{ fontWeight: 700, color: MUTED }}>Coach</div>
        <div style={{ fontWeight: 700, color: MUTED, textAlign: "right" }}>prot.</div>
        <div style={{ fontWeight: 700, color: MUTED, textAlign: "right" }}>→HC</div>
        <div style={{ fontWeight: 700, color: MUTED, textAlign: "right" }}>win%</div>
        {leaders.map((r) => (
          <div key={r.name} style={{ display: "contents" }}>
            <div onClick={() => go(r.name)} style={{ cursor: "pointer" }} onMouseEnter={(e) => (e.currentTarget.style.color = NFL)} onMouseLeave={(e) => (e.currentTarget.style.color = "")}>
              {r.name}{r.rings ? <span title="Super Bowl rings"> {"★".repeat(Math.min(r.rings, 4))}</span> : ""}
            </div>
            <div style={{ textAlign: "right", fontWeight: 700 }}>{r.n}</div>
            <div style={{ textAlign: "right", color: MUTED }}>{r.hcs}</div>
            <div style={{ textAlign: "right", color: MUTED }}>{r.wp ?? "—"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
