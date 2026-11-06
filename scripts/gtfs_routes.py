"""Собирает src/routes.json из справочника GTFS «Организатора перевозок».

    python scripts/gtfs_routes.py feed.zip

feed.zip: https://transport.orgp.spb.ru/Portal/transport/internalapi/gtfs/feed.zip
(сайт отвечает только российским адресам — скачать с компьютера в России).
Результат: {"route_id": ["номер", "bus|tram|trolley"], ...}
"""
import csv
import io
import json
import sys
import zipfile
from pathlib import Path

feed = sys.argv[1] if len(sys.argv) > 1 else "feed.zip"
with zipfile.ZipFile(feed) as z, z.open("routes.txt") as f:
    rows = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
    routes = {r["route_id"]: [r["route_short_name"], r["transport_type"]] for r in rows}

out = Path(__file__).resolve().parent.parent / "src" / "routes.json"
out.write_text(json.dumps(routes, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"{out}: {len(routes)} маршрутов, {out.stat().st_size} байт")
