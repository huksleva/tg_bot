"""Собирает src/timetable.json — расписание прибытий на остановки из справочника GTFS.

    python scripts/gtfs_timetable.py feed.zip 2068 16644

Для каждой остановки и каждого маршрута через неё — минуты от полуночи по Москве,
отдельно для будней (wd) и выходных (we):
    {"2068": {"258": {"wd": [363, 371, ...], "we": [...]}}, ...}
Номера маршрутов берутся из routes.txt (route_short_name), вид транспорта — из stops.txt.
"""
import csv
import io
import json
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

feed, *stop_ids = sys.argv[1:] or ["feed.zip", "2068", "16644"]
stop_ids = set(stop_ids)

with zipfile.ZipFile(feed) as z:
    def rows(name):
        return csv.DictReader(io.TextIOWrapper(z.open(name), encoding="utf-8-sig"))

    daytype = {}
    for r in rows("calendar.txt"):
        if r["monday"] == "1" or r["friday"] == "1":
            daytype[r["service_id"]] = "wd"
        elif r["saturday"] == "1" or r["sunday"] == "1":
            daytype[r["service_id"]] = "we"
    route_name = {r["route_id"]: r["route_short_name"] for r in rows("routes.txt")}
    trip_info = {r["trip_id"]: (route_name[r["route_id"]], daytype.get(r["service_id"])) for r in rows("trips.txt")}

    table = defaultdict(lambda: defaultdict(lambda: {"wd": set(), "we": set()}))
    for r in rows("stop_times.txt"):
        if r["stop_id"] not in stop_ids:
            continue
        route, dt = trip_info.get(r["trip_id"], (None, None))
        if not route or not dt:
            continue
        h, m, _ = map(int, r["arrival_time"].split(":"))
        table[r["stop_id"]][route][dt].add((h * 60 + m) % (24 * 60))

out_data = {
    stop: {route: {dt: sorted(v) for dt, v in days.items()} for route, days in routes.items()}
    for stop, routes in table.items()
}
out = Path(__file__).resolve().parent.parent / "src" / "timetable.json"
out.write_text(json.dumps(out_data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
for stop, routes in out_data.items():
    print(stop, {r: {dt: len(v) for dt, v in d.items()} for r, d in routes.items()})
print(f"{out}: {out.stat().st_size} байт")
