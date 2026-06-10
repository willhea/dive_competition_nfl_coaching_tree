# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""Derive the full coaching-tree graph.

Inputs (all already produced):
  stints_all.json      {coach: [{team,start_year,end_year,role,is_head_coach}]}
  hc_batches/out_*.json {team: [{coach,start_year,end_year}]}  (head-coach tenures)
  coaches_raw.json     {coach: {image,...}}  (roster coaches' lead images)
  roster.json          current HC/OC/DC per team (for explicit 2026 staff edges)

Edge rule: for each non-HC assistant stint-year, the head coach of that
franchise-year (from the HC tenure table) is who they "served under".
Franchise names are canonicalized so eras join (Redskins==Commanders, etc.).

Output: graph_full.json (+ prints summary). Image fetch for historical HCs
is a follow-up step.
"""
from __future__ import annotations

import glob
import json
from collections import defaultdict

CAP = 2026  # clamp open-ended (9999) spans to the current season

# Alias -> canonical franchise. Anything unmapped canonicalizes to itself.
ALIASES = {
    # Raiders
    "Oakland Raiders": "Raiders", "Los Angeles Raiders": "Raiders", "Las Vegas Raiders": "Raiders",
    # Rams
    "Cleveland Rams": "Rams", "Los Angeles Rams": "Rams", "St. Louis Rams": "Rams",
    # Chargers
    "San Diego Chargers": "Chargers", "Los Angeles Chargers": "Chargers",
    # Cardinals
    "Chicago Cardinals": "Cardinals", "St. Louis Cardinals": "Cardinals",
    "Phoenix Cardinals": "Cardinals", "Arizona Cardinals": "Cardinals",
    # Commanders / Washington
    "Boston Braves": "Commanders", "Boston Redskins": "Commanders", "Washington Redskins": "Commanders",
    "Washington Football Team": "Commanders", "Washington Commanders": "Commanders",
    # Titans / Oilers
    "Houston Oilers": "Titans", "Tennessee Oilers": "Titans", "Tennessee Titans": "Titans",
    # Colts
    "Baltimore Colts": "Colts", "Indianapolis Colts": "Colts",
    # Patriots
    "Boston Patriots": "Patriots", "New England Patriots": "Patriots",
}


def canon(team: str) -> str:
    return ALIASES.get(team.strip(), team.strip())


def main() -> None:
    stints = json.load(open("stints_all.json"))
    coaches_raw = json.load(open("coaches_raw.json"))
    roster = json.load(open("roster.json"))

    # ---- head-coach-by-(franchise, year) ----
    hc_by_year: dict[tuple[str, int], set[str]] = defaultdict(set)
    hc_rows = 0
    for f in glob.glob("hc_batches/out_*.json"):
        for team, rows in json.load(open(f)).items():
            fr = canon(team)
            for r in rows:
                hc_rows += 1
                end = min(int(r["end_year"]), CAP)
                for yr in range(int(r["start_year"]), end + 1):
                    hc_by_year[(fr, yr)].add(r["coach"].strip())

    # fallback: roster coaches' OWN head-coach stints are also HC-year sources,
    # so a failed list-page extraction (e.g. the Rams) doesn't drop edges.
    for coach, ss in stints.items():
        for s in ss:
            if s["is_head_coach"]:
                fr = canon(s["team"])
                end = min(int(s["end_year"]), CAP)
                for yr in range(int(s["start_year"]), end + 1):
                    hc_by_year[(fr, yr)].add(coach)

    # ---- expand assistant stints, join to HC of that franchise-year ----
    edges: dict[tuple[str, str], set[int]] = defaultdict(set)
    unmatched_team_years = 0
    for coach, ss in stints.items():
        for s in ss:
            if s["is_head_coach"]:
                continue
            fr = canon(s["team"])
            end = min(int(s["end_year"]), CAP)
            for yr in range(int(s["start_year"]), end + 1):
                hcs = hc_by_year.get((fr, yr))
                if not hcs:
                    unmatched_team_years += 1
                    continue
                for hc in hcs:
                    if hc != coach:
                        edges[(coach, hc)].add(yr)

    # ---- explicit current-staff edges (OC/DC -> HC, 2026) ----
    for t in roster["teams"]:
        hc = t.get("hc")
        if not hc:
            continue
        for slot in ("oc", "dc"):
            v = t.get(slot)
            if v and v[0] != hc[0]:
                edges[(v[0], hc[0])].add(2026)

    # ---- nodes: roster coaches + every edge endpoint ----
    edge_names = {a for a, _ in edges} | {b for _, b in edges}
    roster_names = set(stints) | edge_names
    nodes = []
    for name in sorted(roster_names):
        img = (coaches_raw.get(name) or {}).get("image")
        nodes.append({"name": name, "image": img, "is_roster": name in stints})

    edge_list = []
    for (c, hc), yrs in sorted(edges.items()):
        y = sorted(yrs)
        edge_list.append({"coach": c, "served_under": hc, "first_year": y[0], "last_year": y[-1]})

    graph = {"nodes": nodes, "edges": edge_list}
    json.dump(graph, open("graph_full.json", "w"), indent=2)

    roster_n = sum(1 for n in nodes if n["is_roster"])
    hist_n = len(nodes) - roster_n
    with_img = sum(1 for n in nodes if n["image"])
    # influence: protégé count
    deg = defaultdict(int)
    for e in edge_list:
        deg[e["served_under"]] += 1
    top = sorted(deg.items(), key=lambda x: -x[1])[:12]

    print(f"HC tenure rows: {hc_rows} | HC franchise-years: {len(hc_by_year)}")
    print(f"nodes: {len(nodes)} (roster {roster_n}, historical {hist_n}, with image {with_img})")
    print(f"edges: {len(edge_list)} | assistant team-years with no HC match: {unmatched_team_years}")
    print("\nTop coaching trees (most protégés in this set):")
    for name, n in top:
        print(f"  {n:3}  {name}")


if __name__ == "__main__":
    main()
