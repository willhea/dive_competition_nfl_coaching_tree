# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""Fetch each roster coach's Wikipedia lead image + raw `pastcoaching` field.

Deterministic step: no LLM. Output coaches_raw.json keyed by canonical name,
each {title, image, pastcoaching, found}. The pastcoaching blocks are handed
to Haiku subagents for structured extraction.

Run: uv run fetch_wikitext.py
"""
from __future__ import annotations

import json
import re
import time

import httpx

API = "https://en.wikipedia.org/w/api.php"


def unique_coaches(roster: dict) -> dict[str, str]:
    """canonical name -> wikipedia title, across HC/OC/DC of every team."""
    out: dict[str, str] = {}
    for t in roster["teams"]:
        for slot in ("hc", "oc", "dc"):
            v = t.get(slot)
            if v:
                name, title = v
                out.setdefault(name, title)
    return out


def extract_pastcoaching(wikitext: str) -> str | None:
    # field runs until the next "| <field> =" at infobox indentation
    m = re.search(r"\n\s*\|\s*pastcoaching\s*=(.*?)\n\s*\|\s*[a-z_]+\s*=", wikitext, re.S | re.I)
    return m.group(1).strip() if m else None


def main() -> None:
    roster = json.load(open("roster.json"))
    coaches = unique_coaches(roster)
    names = list(coaches)
    titles = [coaches[n] for n in names]
    title_to_name = {coaches[n]: n for n in names}

    raw: dict[str, dict] = {}
    with httpx.Client(timeout=40, headers={"User-Agent": "nfl-coaching-tree/0.2"}) as c:
        for i in range(0, len(titles), 20):
            chunk = titles[i : i + 20]
            r = c.get(API, params={
                "action": "query", "prop": "pageimages|revisions",
                "piprop": "original", "rvprop": "content", "rvslots": "main",
                "titles": "|".join(chunk), "format": "json", "formatversion": "2", "redirects": "1",
            })
            r.raise_for_status()
            data = r.json().get("query", {})
            # map any redirect normalization back to our requested titles
            redir = {x["from"]: x["to"] for x in data.get("redirects", [])}
            norm = {x["from"]: x["to"] for x in data.get("normalized", [])}
            resolved = {}
            for req in chunk:
                t = norm.get(req, req)
                t = redir.get(t, t)
                resolved[t] = req
            for page in data.get("pages", []):
                ptitle = page.get("title")
                req_title = resolved.get(ptitle, ptitle)
                name = title_to_name.get(req_title) or title_to_name.get(ptitle)
                if not name:
                    continue
                image = (page.get("original") or {}).get("source")
                content = None
                if page.get("revisions"):
                    content = page["revisions"][0]["slots"]["main"]["content"]
                past = extract_pastcoaching(content) if content else None
                missing = "missing" in page
                raw[name] = {
                    "title": req_title, "image": image,
                    "pastcoaching": past, "found": bool(content) and not missing,
                    "has_past": past is not None,
                }
            time.sleep(0.3)

    # report
    found = sum(1 for v in raw.values() if v["found"])
    with_past = sum(1 for v in raw.values() if v["has_past"])
    with_img = sum(1 for v in raw.values() if v["image"])
    missing = [n for n in names if n not in raw or not raw[n]["found"]]
    no_past = [n for n in names if raw.get(n, {}).get("found") and not raw[n]["has_past"]]

    json.dump(raw, open("coaches_raw.json", "w"), indent=2)
    print(f"coaches: {len(names)} | pages found: {found} | with pastcoaching: {with_past} | with image: {with_img}")
    print(f"\nNO WIKIPEDIA PAGE ({len(missing)}): {missing}")
    print(f"\nPAGE BUT NO pastcoaching FIELD ({len(no_past)}): {no_past}")


if __name__ == "__main__":
    main()
