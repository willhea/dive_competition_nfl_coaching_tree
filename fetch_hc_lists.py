# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""Fetch the 'List of <team> head coaches' wikitext for all 32 franchises.

These articles cover the full franchise history (the Commanders page includes
the Redskins era, etc.), giving us head-coach tenures to resolve 'served under'
edges. Output hc_lists_raw.json {team: wikitext}. Deterministic; no LLM.
"""
from __future__ import annotations

import json
import time

import httpx

API = "https://en.wikipedia.org/w/api.php"

TEAMS = [
    "Buffalo Bills", "Miami Dolphins", "New England Patriots", "New York Jets",
    "Baltimore Ravens", "Cincinnati Bengals", "Cleveland Browns", "Pittsburgh Steelers",
    "Houston Texans", "Indianapolis Colts", "Jacksonville Jaguars", "Tennessee Titans",
    "Denver Broncos", "Kansas City Chiefs", "Las Vegas Raiders", "Los Angeles Chargers",
    "Dallas Cowboys", "New York Giants", "Philadelphia Eagles", "Washington Commanders",
    "Chicago Bears", "Detroit Lions", "Green Bay Packers", "Minnesota Vikings",
    "Atlanta Falcons", "Carolina Panthers", "New Orleans Saints", "Tampa Bay Buccaneers",
    "Arizona Cardinals", "Los Angeles Rams", "San Francisco 49ers", "Seattle Seahawks",
]


def main() -> None:
    titles = {f"List of {t} head coaches": t for t in TEAMS}
    out: dict[str, str] = {}
    with httpx.Client(timeout=40, headers={"User-Agent": "nfl-coaching-tree/0.2"}) as c:
        names = list(titles)
        for i in range(0, len(names), 10):
            chunk = names[i : i + 10]
            r = c.get(API, params={
                "action": "query", "prop": "revisions", "rvprop": "content", "rvslots": "main",
                "titles": "|".join(chunk), "format": "json", "formatversion": "2", "redirects": "1",
            })
            r.raise_for_status()
            data = r.json().get("query", {})
            redir = {x["from"]: x["to"] for x in data.get("redirects", [])}
            norm = {x["from"]: x["to"] for x in data.get("normalized", [])}
            resolved = {}
            for req in chunk:
                t = norm.get(req, req); t = redir.get(t, t)
                resolved[t] = req
            for page in data.get("pages", []):
                req_title = resolved.get(page.get("title"), page.get("title"))
                team = titles.get(req_title)
                if not team:
                    continue
                if page.get("revisions"):
                    out[team] = page["revisions"][0]["slots"]["main"]["content"]
            time.sleep(0.3)

    json.dump(out, open("hc_lists_raw.json", "w"), indent=2)
    missing = [t for t in TEAMS if t not in out]
    print(f"fetched HC-list pages: {len(out)}/32")
    if missing:
        print("MISSING:", missing)


if __name__ == "__main__":
    main()
