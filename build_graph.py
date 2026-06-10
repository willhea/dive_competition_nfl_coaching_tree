# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""Build the coaching-tree graph from LLM-extracted stints.

STINTS below is the *LLM-extraction output* for the 5-coach prototype set
(NFL roles only, `is_head_coach` set explicitly so "assistant head coach"
is not miscounted). In production this list is produced by feeding each
coach's Wikipedia `pastcoaching` field to a model; here it was extracted
inline. The graph logic (expand-to-years + self-join) is identical to
what the real pipeline uses.

Run: uv run build_graph.py
"""
from __future__ import annotations

import json
from collections import defaultdict

import httpx

API = "https://en.wikipedia.org/w/api.php"

# Wikipedia article titles (for lead images) keyed by canonical coach name.
TITLES = {
    "Sean McVay": "Sean McVay",
    "Andy Reid": "Andy Reid",
    "Mike Shanahan": "Mike Shanahan",
    "Matt LaFleur": "Matt LaFleur",
    "Dan Quinn": "Dan Quinn (American football)",
    "Jon Gruden": "Jon Gruden",
    "Jay Gruden": "Jay Gruden",
    "Mike Holmgren": "Mike Holmgren",
    "Kyle Shanahan": "Kyle Shanahan",
    "Gary Kubiak": "Gary Kubiak",
}

# (coach, team, start, end, role, is_head_coach) -- NFL only. end=9999 => present.
STINTS = [
    ("Sean McVay", "Tampa Bay Buccaneers", 2008, 2008, "Offensive assistant", False),
    ("Sean McVay", "Washington Redskins", 2010, 2010, "Offensive assistant", False),
    ("Sean McVay", "Washington Redskins", 2011, 2013, "Tight ends coach", False),
    ("Sean McVay", "Washington Redskins", 2014, 2016, "Offensive coordinator", False),
    ("Sean McVay", "Los Angeles Rams", 2017, 9999, "Head coach", True),

    ("Andy Reid", "Green Bay Packers", 1992, 1996, "Assistant offensive line & tight ends coach", False),
    ("Andy Reid", "Green Bay Packers", 1997, 1998, "Quarterbacks coach & assistant head coach", False),
    ("Andy Reid", "Philadelphia Eagles", 1999, 2012, "Head coach", True),
    ("Andy Reid", "Kansas City Chiefs", 2013, 9999, "Head coach", True),

    ("Mike Shanahan", "Denver Broncos", 1984, 1984, "Wide receivers coach", False),
    ("Mike Shanahan", "Denver Broncos", 1985, 1987, "Offensive coordinator", False),
    ("Mike Shanahan", "Los Angeles Raiders", 1988, 1989, "Head coach", True),
    ("Mike Shanahan", "Denver Broncos", 1989, 1990, "Quarterbacks coach", False),
    ("Mike Shanahan", "Denver Broncos", 1991, 1991, "Offensive coordinator", False),
    ("Mike Shanahan", "San Francisco 49ers", 1992, 1993, "Offensive coordinator & quarterbacks coach", False),
    ("Mike Shanahan", "San Francisco 49ers", 1994, 1994, "Offensive coordinator", False),
    ("Mike Shanahan", "Denver Broncos", 1995, 2008, "Head coach", True),
    ("Mike Shanahan", "Washington Redskins", 2010, 2013, "Head coach", True),

    ("Matt LaFleur", "Houston Texans", 2008, 2009, "Offensive assistant", False),
    ("Matt LaFleur", "Washington Redskins", 2010, 2013, "Quarterbacks coach", False),
    ("Matt LaFleur", "Atlanta Falcons", 2015, 2016, "Quarterbacks coach", False),
    ("Matt LaFleur", "Los Angeles Rams", 2017, 2017, "Offensive coordinator", False),
    ("Matt LaFleur", "Tennessee Titans", 2018, 2018, "Offensive coordinator", False),
    ("Matt LaFleur", "Green Bay Packers", 2019, 9999, "Head coach", True),

    ("Dan Quinn", "San Francisco 49ers", 2001, 2002, "Defensive quality control coach", False),
    ("Dan Quinn", "San Francisco 49ers", 2003, 2004, "Defensive line coach", False),
    ("Dan Quinn", "Miami Dolphins", 2005, 2006, "Defensive line coach", False),
    ("Dan Quinn", "New York Jets", 2007, 2008, "Defensive line coach", False),
    ("Dan Quinn", "Seattle Seahawks", 2009, 2010, "Assistant head coach & defensive line coach", False),
    ("Dan Quinn", "Seattle Seahawks", 2013, 2014, "Defensive coordinator", False),
    ("Dan Quinn", "Atlanta Falcons", 2015, 2020, "Head coach", True),
    ("Dan Quinn", "Dallas Cowboys", 2021, 2023, "Defensive coordinator", False),
    ("Dan Quinn", "Washington Commanders", 2024, 9999, "Head coach", True),

    ("Jon Gruden", "San Francisco 49ers", 1990, 1990, "Offensive assistant", False),
    ("Jon Gruden", "Green Bay Packers", 1992, 1992, "Offensive assistant/quality control coach", False),
    ("Jon Gruden", "Green Bay Packers", 1993, 1994, "Wide receivers coach", False),
    ("Jon Gruden", "Philadelphia Eagles", 1995, 1997, "Offensive coordinator", False),
    ("Jon Gruden", "Oakland Raiders", 1998, 2001, "Head coach", True),
    ("Jon Gruden", "Tampa Bay Buccaneers", 2002, 2008, "Head coach", True),
    ("Jon Gruden", "Las Vegas Raiders", 2018, 2021, "Head coach", True),
    ("Jon Gruden", "New Orleans Saints", 2023, 2023, "Consultant", False),

    ("Jay Gruden", "Tampa Bay Buccaneers", 2002, 2008, "Offensive assistant", False),
    ("Jay Gruden", "Cincinnati Bengals", 2011, 2013, "Offensive coordinator", False),
    ("Jay Gruden", "Washington Redskins", 2014, 2019, "Head coach", True),
    ("Jay Gruden", "Jacksonville Jaguars", 2020, 2020, "Offensive coordinator", False),
    ("Jay Gruden", "Los Angeles Rams", 2022, 2022, "Consultant", False),

    ("Mike Holmgren", "San Francisco 49ers", 1986, 1988, "Quarterbacks coach", False),
    ("Mike Holmgren", "San Francisco 49ers", 1989, 1991, "Offensive coordinator & quarterbacks coach", False),
    ("Mike Holmgren", "Green Bay Packers", 1992, 1998, "Head coach", True),
    ("Mike Holmgren", "Seattle Seahawks", 1999, 2008, "Head coach", True),

    ("Kyle Shanahan", "Tampa Bay Buccaneers", 2004, 2005, "Offensive quality control coach", False),
    ("Kyle Shanahan", "Houston Texans", 2006, 2006, "Wide receivers coach", False),
    ("Kyle Shanahan", "Houston Texans", 2007, 2007, "Quarterbacks coach", False),
    ("Kyle Shanahan", "Houston Texans", 2008, 2009, "Offensive coordinator", False),
    ("Kyle Shanahan", "Washington Redskins", 2010, 2013, "Offensive coordinator", False),
    ("Kyle Shanahan", "Cleveland Browns", 2014, 2014, "Offensive coordinator", False),
    ("Kyle Shanahan", "Atlanta Falcons", 2015, 2016, "Offensive coordinator", False),
    ("Kyle Shanahan", "San Francisco 49ers", 2017, 9999, "Head coach", True),

    ("Gary Kubiak", "San Francisco 49ers", 1994, 1994, "Quarterbacks coach", False),
    ("Gary Kubiak", "Denver Broncos", 1995, 2002, "Offensive coordinator & quarterbacks coach", False),
    ("Gary Kubiak", "Denver Broncos", 2003, 2005, "Offensive coordinator", False),
    ("Gary Kubiak", "Houston Texans", 2006, 2013, "Head coach", True),
    ("Gary Kubiak", "Baltimore Ravens", 2014, 2014, "Offensive coordinator", False),
    ("Gary Kubiak", "Denver Broncos", 2015, 2016, "Head coach", True),
    ("Gary Kubiak", "Minnesota Vikings", 2019, 2019, "Assistant head coach & offensive advisor", False),
    ("Gary Kubiak", "Minnesota Vikings", 2020, 2020, "Assistant head coach & offensive coordinator", False),
]


def fetch_images(titles: dict[str, str]) -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    names = list(titles.values())
    with httpx.Client(timeout=30, headers={"User-Agent": "nfl-tree/0.1"}) as c:
        r = c.get(API, params={
            "action": "query", "prop": "pageimages", "piprop": "original",
            "titles": "|".join(names), "format": "json", "formatversion": "2", "redirects": "1",
        })
        r.raise_for_status()
        by_title = {p["title"]: (p.get("original") or {}).get("source") for p in r.json()["query"]["pages"]}
    for coach, title in titles.items():
        # resolve redirect: "(American football)" titles come back canonicalized
        out[coach] = by_title.get(title) or by_title.get(title.split(" (")[0])
    return out


def expand_years(stints):
    for coach, team, start, end, role, is_hc in stints:
        for yr in range(start, min(end, 2025) + 1):
            yield {"coach": coach, "team": team, "year": yr, "role": role, "is_head_coach": is_hc}


def derive_edges(year_rows):
    hc_by = defaultdict(set)
    for r in year_rows:
        if r["is_head_coach"]:
            hc_by[(r["team"], r["year"])].add(r["coach"])
    edges = defaultdict(set)
    for r in year_rows:
        if r["is_head_coach"]:
            continue
        for hc in hc_by[(r["team"], r["year"])]:
            if hc != r["coach"]:
                edges[(r["coach"], hc, r["team"])].add(r["year"])
    return [{"coach": c, "served_under": hc, "team": t, "years": sorted(y)}
            for (c, hc, t), y in sorted(edges.items())]


def main():
    images = fetch_images(TITLES)
    year_rows = list(expand_years(STINTS))
    edges = derive_edges(year_rows)
    nodes = [{"coach": c, "image": images.get(c)} for c in TITLES]

    print("=== NODES ===")
    for n in nodes:
        print(f"  {n['coach']:<16} {'IMG' if n['image'] else 'NO IMAGE':<8} {n['image'] or ''}")
    print(f"\n=== EDGES (served under) — {len(edges)} ===")
    for e in edges:
        y = e["years"]
        span = f"{y[0]}-{y[-1]}" if len(y) > 1 else f"{y[0]}"
        print(f"  {e['coach']:<15} -> {e['served_under']:<15} @ {e['team']} ({span})")

    graph = {
        "nodes": nodes,
        "stints": [dict(zip(("coach", "team", "start_year", "end_year", "role", "is_head_coach"), s)) for s in STINTS],
        "edges": edges,
    }
    with open("graph.json", "w") as f:
        json.dump(graph, f, indent=2)
    print(f"\nWrote graph.json ({len(nodes)} nodes, {len(STINTS)} stints, {len(edges)} edges)")


if __name__ == "__main__":
    main()
