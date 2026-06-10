# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow", "duckdb>=1.1"]
# ///
"""Make 96px base64 face thumbnails and load them into MotherDuck.

The Dive renders faces from the `image_b64` column of `nfl_coaching_tree.coaches`
as `data:` URIs, so the visualization is fully self-contained — no external
image hosting (issue #1). Full-res originals (dive-preview/public/faces/, ~115MB,
gitignored) are downsized to ~3KB JPEGs -> ~0.45MB of base64 total.

Usage:
  uv run images_to_motherduck.py            # build faces_b64.json + faces.parquet
  MD_TOKEN=<rw-token> uv run images_to_motherduck.py --load   # also load into MotherDuck

Mint a token with the MotherDuck MCP `get_short_lived_token` (or use a RW access token).
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys

import duckdb
from PIL import Image

FACES_DIR = "dive-preview/public/faces"
MANIFEST = "dive-preview/src/faces.json"  # name -> /faces/file (from the download step)
SIZE = 96


def build() -> dict[str, str]:
    manifest = json.load(open(MANIFEST)) if os.path.exists(MANIFEST) else {}
    out: dict[str, str] = {}
    for name, web_path in manifest.items():
        fp = "dive-preview/public" + web_path
        if not os.path.exists(fp):
            continue
        im = Image.open(fp).convert("RGB")
        w, h = im.size
        s = min(w, h)  # square center-crop, then resize
        im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s)).resize((SIZE, SIZE))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=78)
        out[name] = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    json.dump(out, open("faces_b64.json", "w"))
    con = duckdb.connect()
    con.execute("CREATE TABLE f(name VARCHAR, image_b64 VARCHAR)")
    con.executemany("INSERT INTO f VALUES (?,?)", list(out.items()))
    con.execute("COPY f TO 'faces.parquet' (FORMAT parquet)")
    con.close()
    print(f"built {len(out)} thumbnails -> faces_b64.json + faces.parquet")
    return out


def load_to_motherduck() -> None:
    token = os.environ.get("MD_TOKEN")
    if not token:
        sys.exit("set MD_TOKEN (a read-write MotherDuck token) to --load")
    con = duckdb.connect(f"md:?motherduck_token={token}")
    con.execute("""
        CREATE OR REPLACE TABLE nfl_coaching_tree.coaches AS
        SELECT c.name, c.is_roster, f.image_b64
        FROM nfl_coaching_tree.coaches c
        LEFT JOIN read_parquet('faces.parquet') f USING (name)
    """)
    n, withimg = con.execute(
        "SELECT count(*), count(image_b64) FROM nfl_coaching_tree.coaches"
    ).fetchone()
    con.close()
    print(f"loaded into MotherDuck: {n} coaches, {withimg} with image_b64")


if __name__ == "__main__":
    build()
    if "--load" in sys.argv:
        load_to_motherduck()
