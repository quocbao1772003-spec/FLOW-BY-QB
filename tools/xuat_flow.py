"""Export every flow of a local Flowboard (storage/flowboard.db + storage/media)
into flowboard-export.zip, ready for "Import" on the team server.
Read-only: the local database is opened in read-only mode."""
import json
import re
import sqlite3
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "storage" / "flowboard.db"
MEDIA = ROOT / "storage" / "media"
OUT = Path.home() / "Desktop" / "flowboard-export.zip"
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
LIMIT = 90 * 1024 * 1024


def main() -> int:
    if not DB.exists():
        print(f"Khong thay {DB}")
        return 1
    if not OUT.parent.exists():
        globals()["OUT"] = ROOT / "flowboard-export.zip"
    con = sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True)
    flows, wanted = [], set()
    for bid, name in con.execute("select id, name from board order by id"):
        nodes = []
        for nid, typ, x, y, w, h, data, status in con.execute(
            "select id, type, x, y, w, h, data, status from node where board_id=?", (bid,)
        ):
            d = json.loads(data or "{}")
            wanted.update(UUID.findall(json.dumps(d)))
            nodes.append({"id": nid, "type": typ, "x": x, "y": y, "w": w, "h": h,
                          "status": status, "data": d})
        if not nodes:
            continue
        edges = [
            {"source": s, "target": t, "kind": k, "source_variant_idx": v}
            for s, t, k, v in con.execute(
                "select source_id, target_id, kind, source_variant_idx from edge where board_id=?", (bid,)
            )
        ]
        flows.append({"name": name, "nodes": nodes, "edges": edges})
        print(f"  - {name}: {len(nodes)} node")
    if not flows:
        print("Khong co flow nao co noi dung.")
        return 1
    total, added, skipped = 0, 0, 0
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("flows.json", json.dumps(flows, ensure_ascii=False))
        for mid in sorted(wanted):
            files = list(MEDIA.glob(f"{mid}.*")) if MEDIA.exists() else []
            if not files:
                continue
            f = files[0]
            size = f.stat().st_size
            if total + size > LIMIT:
                skipped += 1
                continue
            z.write(f, f"media/{f.name}", compress_type=zipfile.ZIP_STORED)
            total += size
            added += 1
    print()
    print(f"Xong: {len(flows)} flow, {added} anh ({total // (1024 * 1024)} MB)")
    if skipped:
        print(f"CANH BAO: bo qua {skipped} anh vi vuot 90 MB. Bao admin de chia nho.")
    print(f"File: {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
