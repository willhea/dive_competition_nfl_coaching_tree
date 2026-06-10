import { useEffect, useMemo, useRef, useState } from "react";
import { useSQLQuery } from "@motherduck/react-sql-query";
import ForceGraph2D from "react-force-graph-2d";
import ForceGraph3D from "react-force-graph-3d";
import * as THREE from "three";

// NFL coaching tree — 3D/2D relationship graph with ego-focus navigation.
// Nodes = coaches; face thumbnails are served as base64 straight from the
// MotherDuck `coaches` table (no external image hosting). A link points
// mentor -> protégé.

const NFL = "#013369";
const MUTED = "#6a6a6a";
const WIDTH = 820;
const HEIGHT = 640;
const ALL = "__ALL__";

type Coach = { name: string; image_b64: string | null; is_roster: boolean };
type Edge = { coach: string; served_under: string };
type GNode = { id: string; img: string | null; roster: boolean; deg: number };

export default function CoachingTree() {
  const coachesQ = useSQLQuery<Coach[]>(`SELECT name, image_b64, is_roster FROM nfl_coaching_tree.coaches`);
  const edgesQ = useSQLQuery<Edge[]>(`SELECT coach, served_under FROM nfl_coaching_tree.edges`);
  const coaches = (coachesQ.data ?? []) as Coach[];
  const edges = (edgesQ.data ?? []) as Edge[];
  const loading = coachesQ.isLoading || edgesQ.isLoading;

  const [render, setRender] = useState<"3d" | "2d">("3d");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [depth, setDepth] = useState<1 | 2>(1);

  const graph = useMemo(() => {
    const deg = new Map<string, number>();
    for (const e of edges) deg.set(e.served_under, (deg.get(e.served_under) ?? 0) + 1);
    const nodes: GNode[] = coaches.map((c) => ({
      id: c.name, img: c.image_b64, roster: !!c.is_roster, deg: deg.get(c.name) ?? 0,
    }));
    const ids = new Set(nodes.map((n) => n.id));
    const links = edges.filter((e) => ids.has(e.coach) && ids.has(e.served_under))
      .map((e) => ({ source: e.served_under, target: e.coach }));
    return { nodes, links };
  }, [coaches, edges]);

  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) => (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b);
    for (const l of graph.links) { add(l.source, l.target); add(l.target, l.source); }
    return m;
  }, [graph.links]);

  // preload images so both renderers reliably show faces
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
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.onload = finish; im.onerror = finish;
      im.src = n.img!;
      imgCache.current.set(n.id, im);
    }
    const t = setTimeout(() => setReady(true), 2500); // don't block forever
    return () => clearTimeout(t);
  }, [graph.nodes]);

  // visible subgraph
  const view = useMemo(() => {
    let ids: Set<string>;
    if (focusId) {
      ids = new Set([focusId]);
      let frontier = [focusId];
      for (let h = 0; h < depth; h++) {
        const next: string[] = [];
        for (const id of frontier) for (const nb of adj.get(id) ?? []) if (!ids.has(nb)) { ids.add(nb); next.push(nb); }
        frontier = next;
      }
    } else {
      ids = new Set(graph.nodes.map((n) => n.id));
    }
    return {
      nodes: graph.nodes.filter((n) => ids.has(n.id)).map((n) => ({ ...n })),
      links: graph.links.filter((l) => ids.has(l.source as string) && ids.has(l.target as string)).map((l) => ({ ...l })),
    };
  }, [focusId, depth, graph, adj]);

  // navigation
  const goTo = (id: string) => {
    if (id === focusId) return;
    setHistory((h) => [...h, focusId ?? ALL]);
    setFocusId(id);
  };
  const back = () => setHistory((h) => {
    if (!h.length) return h;
    const prev = h[h.length - 1];
    setFocusId(prev === ALL ? null : prev);
    return h.slice(0, -1);
  });
  const showAll = () => { setFocusId(null); setHistory([]); };

  const radius = (n: GNode) => 4 + Math.min(n.deg, 14) * 1.1;

  const draw2D = (node: any, ctx: CanvasRenderingContext2D, scale: number) => {
    const r = radius(node);
    const im = imgCache.current.get(node.id);
    ctx.save();
    ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    if (im && im.complete && im.naturalWidth) {
      ctx.clip(); ctx.drawImage(im, node.x - r, node.y - r, r * 2, r * 2); ctx.restore();
      ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.lineWidth = node.id === focusId ? 3 : node.roster ? 1.6 : 0.8;
      ctx.strokeStyle = node.id === focusId ? "#D50A0A" : node.roster ? NFL : "#bbb"; ctx.stroke();
    } else {
      ctx.fillStyle = node.id === focusId ? "#D50A0A" : node.roster ? NFL : "#c9c9c9"; ctx.fill(); ctx.restore();
    }
    if (scale > 2.4 || node.deg >= 5 || node.id === focusId) {
      ctx.font = `${node.deg >= 5 || node.id === focusId ? 700 : 400} ${Math.max(3, 9 / Math.sqrt(scale))}px sans-serif`;
      ctx.fillStyle = "#222"; ctx.textAlign = "center";
      ctx.fillText(node.id, node.x, node.y + r + 8 / Math.sqrt(scale));
    }
  };

  // circular texture for 3D sprites (built from preloaded image)
  const circleTexture = (node: any): THREE.Texture | null => {
    if (texCache.current.has(node.id)) return texCache.current.get(node.id)!;
    const im = imgCache.current.get(node.id);
    if (!im || !im.complete || !im.naturalWidth) return null;
    const S = 128;
    const cv = document.createElement("canvas"); cv.width = cv.height = S;
    const ctx = cv.getContext("2d")!;
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 2, 0, 2 * Math.PI); ctx.closePath(); ctx.clip();
    ctx.drawImage(im, 0, 0, S, S);
    ctx.lineWidth = 6; ctx.strokeStyle = node.id === focusId ? "#D50A0A" : node.roster ? "#3b7dd8" : "#888";
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 3, 0, 2 * Math.PI); ctx.stroke();
    const tex = new THREE.CanvasTexture(cv);
    texCache.current.set(node.id, tex);
    return tex;
  };

  const node3D = (node: any) => {
    const r = radius(node);
    const tex = circleTexture(node);
    if (tex) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
      s.scale.set(r * 1.7, r * 1.7, 1); return s;
    }
    const m = new THREE.Mesh(new THREE.SphereGeometry(r * 0.7, 12, 12),
      new THREE.MeshLambertMaterial({ color: node.id === focusId ? 0xd50a0a : node.roster ? NFL : 0xc9c9c9 }));
    return m;
  };

  const fg2d = useRef<any>(null);
  const fg3d = useRef<any>(null);
  const fitView = () => {
    setTimeout(() => {
      try { (render === "3d" ? fg3d : fg2d).current?.zoomToFit(500, focusId ? 60 : 30); } catch {}
    }, 60);
  };

  const crumb = focusId
    ? `${focusId}'s network · ${depth === 1 ? "direct" : "2 steps"}`
    : `All ${graph.nodes.length} coaches`;

  return (
    <div className="mx-auto my-6 px-6" style={{ maxWidth: WIDTH + 40, color: "#231f20", fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 className="text-3xl font-bold" style={{ color: NFL }}>NFL Coaching Tree</h1>
      <p className="mt-1 text-sm" style={{ color: MUTED }}>
        Who trained under whom — arrows point from a head coach to a protégé. {graph.nodes.length} coaches, {graph.links.length} relationships.
      </p>

      {/* controls */}
      <div className="flex flex-wrap items-center gap-2 mt-4 text-sm">
        <div className="flex rounded overflow-hidden" style={{ border: "1px solid #ccc" }}>
          {(["3d", "2d"] as const).map((m) => (
            <button key={m} onClick={() => setRender(m)} className="px-3 py-1"
              style={{ background: render === m ? NFL : "#fff", color: render === m ? "#fff" : "#333" }}>
              {m.toUpperCase()}
            </button>
          ))}
        </div>

        <button onClick={back} disabled={!history.length}
          className="px-3 py-1 rounded" style={{ border: "1px solid #ccc", background: "#fff", opacity: history.length ? 1 : 0.4 }}>
          ← Back
        </button>
        <button onClick={showAll} disabled={!focusId}
          className="px-3 py-1 rounded" style={{ border: "1px solid #ccc", background: "#fff", opacity: focusId ? 1 : 0.4 }}>
          ⌂ Show all
        </button>

        <select value={focusId ?? ""} onChange={(e) => (e.target.value ? goTo(e.target.value) : showAll())}
          className="px-2 py-1 rounded" style={{ border: "1px solid #ccc" }}>
          <option value="">Jump to a coach…</option>
          {[...graph.nodes].sort((a, b) => b.deg - a.deg || a.id.localeCompare(b.id)).map((n) => (
            <option key={n.id} value={n.id}>{n.id}{n.deg ? ` (${n.deg})` : ""}</option>
          ))}
        </select>

        {focusId && (
          <div className="flex items-center gap-1 ml-1">
            <span style={{ color: MUTED }}>depth</span>
            {([1, 2] as const).map((d) => (
              <button key={d} onClick={() => setDepth(d)} className="px-2 py-1 rounded"
                style={{ border: "1px solid #ccc", background: depth === d ? NFL : "#fff", color: depth === d ? "#fff" : "#333" }}>{d}</button>
            ))}
          </div>
        )}
        <span className="ml-auto" style={{ color: MUTED }}>{view.nodes.length} shown</span>
      </div>

      <div className="mt-2 text-sm font-medium" style={{ color: NFL }}>{crumb}</div>

      {/* graph */}
      <div style={{ marginTop: 8, border: "1px solid #eee", borderRadius: 8, overflow: "hidden", background: render === "3d" ? "#0b1020" : "#fafafa", width: WIDTH, height: HEIGHT }}>
        {loading || !ready ? (
          <p className="p-8" style={{ color: MUTED }}>{loading ? "Loading data…" : "Loading faces…"}</p>
        ) : render === "3d" ? (
          <ForceGraph3D ref={fg3d} graphData={view} width={WIDTH} height={HEIGHT} backgroundColor="#0b1020"
            nodeThreeObject={node3D} linkColor={() => "rgba(255,255,255,0.22)"}
            linkDirectionalArrowLength={3} linkDirectionalArrowRelPos={1} linkOpacity={0.35}
            onEngineStop={fitView} onNodeClick={(n: any) => goTo(n.id)} />
        ) : (
          <ForceGraph2D ref={fg2d} graphData={view} width={WIDTH} height={HEIGHT}
            nodeCanvasObject={draw2D}
            nodePointerAreaPaint={(n: any, c, ctx) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(n.x, n.y, radius(n), 0, 2 * Math.PI); ctx.fill(); }}
            linkColor={() => "#cfcfcf"} linkDirectionalArrowLength={3} linkDirectionalArrowRelPos={1}
            cooldownTicks={120} d3VelocityDecay={0.3} onEngineStop={fitView} onNodeClick={(n: any) => goTo(n.id)} />
        )}
      </div>

      <p className="text-xs mt-3" style={{ color: MUTED }}>
        Click any face to focus it · <b>← Back</b> / <b>⌂ Show all</b> to return · drag to {render === "3d" ? "orbit" : "pan"}, scroll to zoom.
        Bigger nodes = more protégés. Navy ring = current 2026 coach, red = focused. Source: Wikipedia.
      </p>
    </div>
  );
}
