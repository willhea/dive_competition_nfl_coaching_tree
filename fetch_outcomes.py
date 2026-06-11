# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""Fetch each node coach's Wikipedia infobox (for HC win/loss record + Super Bowls).

Outputs outcomes_raw.json {name: infobox_wikitext}. Records only exist for coaches
who were head coaches; others extract to null. Deterministic; Haiku does the parse.
"""
from __future__ import annotations

import json
import time

import httpx

API = "https://en.wikipedia.org/w/api.php"


def infobox(wikitext: str) -> str | None:
    i = wikitext.find("{{Infobox")
    if i < 0:
        return None
    depth = 0
    for j in range(i, len(wikitext) - 1):
        if wikitext[j:j+2] == "{{":
            depth += 1
        elif wikitext[j:j+2] == "}}":
            depth -= 1
            if depth == 0:
                return wikitext[i:j+2]
    return wikitext[i:i+4000]


def main() -> None:
    names = [n["name"] for n in json.load(open("graph_full.json"))["nodes"]]
    out: dict[str, str] = {}
    with httpx.Client(timeout=40, headers={"User-Agent": "nfl-coaching-tree/0.2"}) as c:
        for k in range(0, len(names), 20):
            chunk = names[k:k+20]
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
                t = norm.get(req, req); t = redir.get(t, t); resolved[t] = req
            for page in data.get("pages", []):
                name = resolved.get(page.get("title"), page.get("title"))
                if name not in names or not page.get("revisions"):
                    continue
                ib = infobox(page["revisions"][0]["slots"]["main"]["content"])
                if ib:
                    out[name] = ib
            time.sleep(0.3)
    json.dump(out, open("outcomes_raw.json", "w"), indent=2)
    print(f"infoboxes fetched: {len(out)}/{len(names)}")


if __name__ == "__main__":
    main()
