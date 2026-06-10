# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""Prototype: build an NFL coaching tree from Wikipedia.

For each coach (by Wikipedia title) pull:
  - the lead/primary image URL  (pageimages, original)
  - the `pastcoaching` infobox field, parsed into per-stint rows
    (coach, team, start_year, end_year, role, is_head_coach)

Then expand stints to per-year rows and self-join assistant-years to
head-coach-years on (team, year) to derive the "served under" edges.

Run: uv run extract.py
"""
from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, asdict

import httpx

API = "https://en.wikipedia.org/w/api.php"

# Prototype seed: 5 current coaches + the head coaches they served directly
# under (so the join has someone to point at). The real run discovers these
# by recursion.
SEED = [
    "Sean McVay",
    "Andy Reid",
    "Mike Shanahan",
    "Matt LaFleur",
    "Dan Quinn (American football)",  # bare "Dan Quinn" is a disambiguation page
    # head coaches the above served under (gives edges a target):
    "Jon Gruden",
    "Jay Gruden",
    "Mike Holmgren",
    "Kyle Shanahan",
    "Gary Kubiak",
]


@dataclass
class Stint:
    coach: str
    team: str
    start_year: int
    end_year: int
    role: str
    is_head_coach: bool


def fetch_pages(titles: list[str]) -> dict:
    """One batched API call: lead image + raw wikitext for each title."""
    out: dict[str, dict] = {}
    with httpx.Client(timeout=30, headers={"User-Agent": "nfl-coaching-tree/0.1 (prototype)"}) as c:
        # pageimages and revisions in a single query, batched by 20 titles
        for i in range(0, len(titles), 20):
            chunk = titles[i : i + 20]
            r = c.get(
                API,
                params={
                    "action": "query",
                    "prop": "pageimages|revisions",
                    "piprop": "original",
                    "rvprop": "content",
                    "rvslots": "main",
                    "titles": "|".join(chunk),
                    "format": "json",
                    "formatversion": "2",
                },
            )
            r.raise_for_status()
            for page in r.json().get("query", {}).get("pages", []):
                title = page.get("title")
                image = (page.get("original") or {}).get("source")
                content = None
                revs = page.get("revisions")
                if revs:
                    content = revs[0]["slots"]["main"]["content"]
                out[title] = {"image": image, "wikitext": content}
    return out


def _years(span: str) -> tuple[int, int] | None:
    """Parse a {{nfly|...}} span or a bare year/range into (start, end).

    `present`/open-ended ranges get end_year = 9999.
    """
    nums = [int(n) for n in re.findall(r"\b(19|20)\d{2}\b", span)]
    # the regex above captures the century group; redo properly:
    nums = [int(n) for n in re.findall(r"\b((?:19|20)\d{2})\b", span)]
    if not nums:
        return None
    start = nums[0]
    if "present" in span.lower():
        return start, 9999
    end = nums[1] if len(nums) > 1 else start
    return start, end


def _first_team_link(text: str) -> str | None:
    m = re.search(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]", text)
    return m.group(1).strip() if m else None


def _strip_templates(text: str) -> str:
    """Remove wiki templates, handling nesting (e.g. {{ubl|... {{nfly}} ...}})."""
    prev = None
    while prev != text:  # repeatedly remove innermost (brace-free) templates
        prev = text
        text = re.sub(r"\{\{[^{}]*\}\}", "", text)
    return text


def _clean_role(text: str, team: str | None) -> str:
    """Turn a raw pastcoaching line into a clean role string."""
    if team:
        text = re.sub(r"\[\[[^\]]*\]\]", "", text)  # drop the team link
    text = _strip_templates(text)
    text = re.sub(r"\[\[[^\]|]*\|([^\]]*)\]\]", r"\1", text)  # other links -> label
    text = re.sub(r"\[\[|\]\]", "", text)
    text = re.sub(r"<[^>]+>", " ", text)  # <br />
    text = re.sub(r"\b(?:19|20)\d{2}\b", " ", text)  # leaked year tokens
    text = text.replace("present", " ")
    text = re.sub(r"[*()|:;=–—-]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _is_college(team: str) -> bool:
    return team.strip().lower().endswith("football")  # college links: "BYU Cougars football"


HEAD_COACH_RE = re.compile(r"head coach", re.I)


def parse_pastcoaching(coach: str, wikitext: str) -> list[Stint]:
    """Parse the `pastcoaching` infobox field into stint rows.

    Handles both shapes seen in the data:
      * [[Team]] (span)<br />Role                       -> one stint
      * [[Team]] (span) ... ** Role (sub-span) ...       -> one stint per sub-role
    """
    m = re.search(r"\|\s*pastcoaching\s*=(.*?)\n\|\s*\w", wikitext, re.S | re.I)
    if not m:
        return []
    block = m.group(1)
    stints: list[Stint] = []
    current_team: str | None = None
    current_span: tuple[int, int] | None = None

    for raw in block.splitlines():
        line = raw.strip()
        if not line:
            continue
        is_sub = line.startswith("**")
        line_team = _first_team_link(line)

        if not is_sub and line_team:
            current_team = line_team
            current_span = _years(line)

        role = _clean_role(line, line_team)
        if not role:
            continue  # a pure team header line with sub-roles to follow

        span = _years(line) or current_span
        team = current_team
        if not (team and span) or _is_college(team):
            continue
        stints.append(
            Stint(
                coach=coach,
                team=team,
                start_year=span[0],
                end_year=span[1],
                role=role,
                is_head_coach=bool(HEAD_COACH_RE.search(role)),
            )
        )
    return stints


def expand_years(stints: list[Stint]):
    """Per-(coach, team, year, role) rows; cap open-ended at 2025."""
    for s in stints:
        end = min(s.end_year, 2025)
        for yr in range(s.start_year, end + 1):
            yield {
                "coach": s.coach,
                "team": s.team,
                "year": yr,
                "role": s.role,
                "is_head_coach": s.is_head_coach,
            }


def derive_edges(year_rows: list[dict]) -> list[dict]:
    """served_under: non-HC coach in (team, year) -> the HC of that (team, year)."""
    hc_by = {}
    for r in year_rows:
        if r["is_head_coach"]:
            hc_by.setdefault((r["team"], r["year"]), set()).add(r["coach"])
    edges = {}
    for r in year_rows:
        if r["is_head_coach"]:
            continue
        for hc in hc_by.get((r["team"], r["year"]), ()):
            if hc == r["coach"]:
                continue
            key = (r["coach"], hc, r["team"])
            edges.setdefault(key, set()).add(r["year"])
    return [
        {"coach": c, "served_under": hc, "team": t, "years": sorted(yrs)}
        for (c, hc, t), yrs in sorted(edges.items())
    ]


def main() -> None:
    pages = fetch_pages(SEED)
    all_stints: list[Stint] = []
    nodes = []
    for title in SEED:
        info = pages.get(title)
        if not info or not info.get("wikitext"):
            print(f"  !! no wikitext for {title}", file=sys.stderr)
            continue
        stints = parse_pastcoaching(title, info["wikitext"])
        all_stints.extend(stints)
        nodes.append({"coach": title, "image": info.get("image"), "stints": len(stints)})

    year_rows = list(expand_years(all_stints))
    edges = derive_edges(year_rows)

    print("\n=== NODES (coach + lead image) ===")
    for n in nodes:
        print(f"  {n['coach']:<18} stints={n['stints']:<3} {n['image']}")

    print("\n=== STINTS (sample) ===")
    for s in all_stints[:25]:
        print(f"  {s.coach:<16} {s.team:<26} {s.start_year}-{s.end_year:<5} {'[HC] ' if s.is_head_coach else ''}{s.role}")

    print("\n=== EDGES (served under) ===")
    for e in edges:
        yrs = e["years"]
        span = f"{yrs[0]}-{yrs[-1]}" if len(yrs) > 1 else f"{yrs[0]}"
        print(f"  {e['coach']:<16} -> {e['served_under']:<16} @ {e['team']} ({span})")

    with open("graph.json", "w") as f:
        json.dump({"nodes": nodes, "stints": [asdict(s) for s in all_stints], "edges": edges}, f, indent=2)
    print(f"\nWrote graph.json  ({len(nodes)} nodes, {len(all_stints)} stints, {len(edges)} edges)")


if __name__ == "__main__":
    main()
