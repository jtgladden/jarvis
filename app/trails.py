import json
import math
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from app.schemas import TrailSearchItem, TrailSearchResponse

USGS_TRAILS_QUERY_URL = os.getenv(
    "USGS_TRAILS_QUERY_URL",
    "https://cartowfs.nationalmap.gov/arcgis/rest/services/transportation/MapServer/8/query",
)
OVERPASS_API_URL = os.getenv(
    "OVERPASS_API_URL", "https://overpass-api.de/api/interpreter"
)
USGS_TIMEOUT_SECONDS = int(os.getenv("USGS_TIMEOUT_SECONDS", "20"))
OVERPASS_TIMEOUT_SECONDS = int(os.getenv("OVERPASS_TIMEOUT_SECONDS", "25"))
MAX_TRAIL_SEARCH_SPAN_DEGREES = float(
    os.getenv("MAX_TRAIL_SEARCH_SPAN_DEGREES", "0.35")
)
MIN_TRAIL_SEGMENT_LENGTH_M = float(os.getenv("MIN_TRAIL_SEGMENT_LENGTH_M", "250"))
MAX_TRAIL_SEGMENT_LENGTH_M = float(os.getenv("MAX_TRAIL_SEGMENT_LENGTH_M", "32000"))


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _validate_bounds(
    min_lat: float, min_lon: float, max_lat: float, max_lon: float
) -> tuple[float, float, float, float]:
    if min_lat > max_lat:
        min_lat, max_lat = max_lat, min_lat
    if min_lon > max_lon:
        min_lon, max_lon = max_lon, min_lon

    min_lat = _clamp(min_lat, -90.0, 90.0)
    max_lat = _clamp(max_lat, -90.0, 90.0)
    min_lon = _clamp(min_lon, -180.0, 180.0)
    max_lon = _clamp(max_lon, -180.0, 180.0)

    if (max_lat - min_lat) > MAX_TRAIL_SEARCH_SPAN_DEGREES:
        raise ValueError(
            f"Trail search latitude span is too large. Keep it under {MAX_TRAIL_SEARCH_SPAN_DEGREES:.2f} degrees."
        )
    if (max_lon - min_lon) > MAX_TRAIL_SEARCH_SPAN_DEGREES:
        raise ValueError(
            f"Trail search longitude span is too large. Keep it under {MAX_TRAIL_SEARCH_SPAN_DEGREES:.2f} degrees."
        )

    return min_lat, min_lon, max_lat, max_lon


def _expanded_bounds(
    min_lat: float, min_lon: float, max_lat: float, max_lon: float
) -> tuple[float, float, float, float]:
    lat_padding = max(0.0025, (max_lat - min_lat) * 0.18)
    lon_padding = max(0.0025, (max_lon - min_lon) * 0.18)
    return (
        max(-90.0, min_lat - lat_padding),
        max(-180.0, min_lon - lon_padding),
        min(90.0, max_lat + lat_padding),
        min(180.0, max_lon + lon_padding),
    )


def _meters_between(
    left_lat: float, left_lon: float, right_lat: float, right_lon: float
) -> float:
    earth_radius_m = 6371000.0
    left_lat_rad = math.radians(left_lat)
    right_lat_rad = math.radians(right_lat)
    lat_delta = math.radians(right_lat - left_lat)
    lon_delta = math.radians(right_lon - left_lon)

    a = (
        math.sin(lat_delta / 2) ** 2
        + math.cos(left_lat_rad)
        * math.cos(right_lat_rad)
        * math.sin(lon_delta / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return earth_radius_m * c


def _polyline_length_m(points: list[dict[str, float]]) -> float | None:
    if len(points) < 2:
        return None

    total = 0.0
    for index in range(1, len(points)):
        previous = points[index - 1]
        current = points[index]
        total += _meters_between(
            previous["lat"],
            previous["lon"],
            current["lat"],
            current["lon"],
        )
    return round(total, 1)


def _distance_to_center_m(
    center_lat: float, center_lon: float, points: list[dict[str, float]]
) -> float | None:
    if not points:
        return None

    closest = min(
        _meters_between(center_lat, center_lon, point["lat"], point["lon"])
        for point in points
    )
    return round(closest, 1)


def _normalize_points(points: list[dict[str, float]]) -> list[dict[str, float]]:
    normalized: list[dict[str, float]] = []
    last: tuple[float, float] | None = None

    for point in points:
        latitude = point.get("lat")
        longitude = point.get("lon")
        if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
            continue
        if math.isnan(latitude) or math.isnan(longitude):
            continue

        candidate = (float(latitude), float(longitude))
        if last == candidate:
            continue
        normalized.append({"lat": candidate[0], "lon": candidate[1]})
        last = candidate

    return normalized


def _point_in_bounds(
    point: dict[str, float],
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
) -> bool:
    return (
        min_lat <= point["lat"] <= max_lat and min_lon <= point["lon"] <= max_lon
    )


def _clip_points_to_bounds(
    points: list[dict[str, float]],
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
) -> list[dict[str, float]]:
    if not points:
        return []

    clipped: list[dict[str, float]] = []
    previous_in_bounds = False

    for index, point in enumerate(points):
        in_bounds = _point_in_bounds(point, min_lat, min_lon, max_lat, max_lon)
        if in_bounds:
            if index > 0 and not previous_in_bounds:
                clipped.append(points[index - 1])
            clipped.append(point)
            if index + 1 < len(points):
                next_point = points[index + 1]
                if not _point_in_bounds(next_point, min_lat, min_lon, max_lat, max_lon):
                    clipped.append(next_point)
        previous_in_bounds = in_bounds

    return _normalize_points(clipped)


def _trail_score(item: TrailSearchItem, search_diagonal_m: float) -> float:
    score = 0.0

    if item.source == "usgs":
        score -= 12.0
    elif item.source == "osm_way":
        score += 6.0
    else:
        score += 12.0

    distance_m = item.distance_from_center_m or (search_diagonal_m * 2)
    score += min(distance_m / 300.0, 40.0)

    length_m = item.length_m or 0.0
    if length_m < MIN_TRAIL_SEGMENT_LENGTH_M:
        score += 100.0
    elif length_m <= 12000:
        score += abs(length_m - 5000.0) / 2500.0
    elif length_m <= MAX_TRAIL_SEGMENT_LENGTH_M:
        score += 5.0 + ((length_m - 12000.0) / 4000.0)
    else:
        score += 100.0

    if not item.ref and not item.operator and not item.network:
        score += 2.0

    if item.name.lower().startswith("unnamed "):
        score += 25.0

    return score


def _normalized_name_key(item: TrailSearchItem) -> str:
    return " ".join((item.name or "").lower().split())


def _finalize_items(
    items: list[TrailSearchItem],
    center_lat: float,
    center_lon: float,
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
    limit: int,
) -> TrailSearchResponse:
    expanded_min_lat, expanded_min_lon, expanded_max_lat, expanded_max_lon = _expanded_bounds(
        min_lat, min_lon, max_lat, max_lon
    )
    search_diagonal_m = _meters_between(min_lat, min_lon, max_lat, max_lon)
    filtered: list[TrailSearchItem] = []

    for item in items:
        clipped_points = _clip_points_to_bounds(
            [{"lat": point.latitude, "lon": point.longitude} for point in item.points],
            expanded_min_lat,
            expanded_min_lon,
            expanded_max_lat,
            expanded_max_lon,
        )
        if len(clipped_points) < 2:
            continue

        distance_from_center_m = _distance_to_center_m(center_lat, center_lon, clipped_points)
        length_m = _polyline_length_m(clipped_points)
        if distance_from_center_m is None or length_m is None:
            continue
        if length_m < MIN_TRAIL_SEGMENT_LENGTH_M or length_m > MAX_TRAIL_SEGMENT_LENGTH_M:
            continue
        if distance_from_center_m > max(2500.0, search_diagonal_m * 1.2):
            continue

        filtered.append(
            item.model_copy(
                update={
                    "distance_from_center_m": distance_from_center_m,
                    "length_m": length_m,
                    "points": [
                        {"latitude": point["lat"], "longitude": point["lon"]}
                        for point in clipped_points
                    ],
                }
            )
        )

    best_by_name: dict[str, TrailSearchItem] = {}
    for item in filtered:
        key = _normalized_name_key(item)
        existing = best_by_name.get(key)
        if existing is None or _trail_score(item, search_diagonal_m) < _trail_score(
            existing, search_diagonal_m
        ):
            best_by_name[key] = item

    deduped = list(best_by_name.values())
    deduped.sort(
        key=lambda item: (
            _trail_score(item, search_diagonal_m),
            item.distance_from_center_m or float("inf"),
            item.name.lower(),
        )
    )
    limited = deduped[: max(1, min(limit, 25))]
    provider = "usgs_national_map" if any(item.source == "usgs" for item in limited) else "openstreetmap_overpass"
    return TrailSearchResponse(provider=provider, count=len(limited), items=limited)


def _fetch_json(url: str, timeout_seconds: int) -> dict:
    request = Request(
        url,
        headers={"User-Agent": "Jarvis Trail Search/1.0"},
        method="GET",
    )
    with urlopen(request, timeout=timeout_seconds) as response:
        return json.loads(response.read().decode("utf-8"))


def _fetch_usgs_trails(
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
) -> list[TrailSearchItem]:
    where = "trailtype = 'Terra Trail'"
    params = urlencode(
        {
            "f": "geojson",
            "where": where,
            "geometry": f"{min_lon},{min_lat},{max_lon},{max_lat}",
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "returnGeometry": "true",
            "outFields": ",".join(
                [
                    "objectid",
                    "name",
                    "namealternate",
                    "trailnumber",
                    "trailnumberalternate",
                    "trailtype",
                    "lengthmiles",
                    "hikerpedestrian",
                    "primarytrailmaintainer",
                    "routetype",
                    "sourceoriginator",
                    "nationaltraildesignation",
                    "sourcefeatureid",
                    "permanentidentifier",
                ]
            ),
            "outSR": "4326",
            "resultRecordCount": "200",
        }
    )
    payload = _fetch_json(f"{USGS_TRAILS_QUERY_URL}?{params}", USGS_TIMEOUT_SECONDS)
    features = payload.get("features", [])
    items: list[TrailSearchItem] = []

    for feature in features:
        geometry = feature.get("geometry") or {}
        coordinates = geometry.get("coordinates") or []
        geometry_type = geometry.get("type")
        if geometry_type not in {"LineString", "MultiLineString"} or not isinstance(
            coordinates, list
        ):
            continue

        raw_points: list[dict[str, float]] = []
        if geometry_type == "LineString":
            raw_points.extend(
                [
                    {"lat": coordinate[1], "lon": coordinate[0]}
                    for coordinate in coordinates
                    if isinstance(coordinate, list)
                    and len(coordinate) >= 2
                    and isinstance(coordinate[0], (int, float))
                    and isinstance(coordinate[1], (int, float))
                ]
            )
        else:
            for segment in coordinates:
                if not isinstance(segment, list):
                    continue
                raw_points.extend(
                    [
                        {"lat": coordinate[1], "lon": coordinate[0]}
                        for coordinate in segment
                        if isinstance(coordinate, list)
                        and len(coordinate) >= 2
                        and isinstance(coordinate[0], (int, float))
                        and isinstance(coordinate[1], (int, float))
                    ]
                )

        points = _normalize_points(raw_points)
        if len(points) < 2:
            continue

        properties = feature.get("properties") or {}
        hiker_pedestrian = str(properties.get("hikerpedestrian") or "").upper()
        route_type = str(properties.get("routetype") or "")
        if hiker_pedestrian not in {"", "Y"}:
            continue
        if route_type and route_type not in {"Trail", "Road and Trail"}:
            continue

        trail_name = (
            properties.get("name")
            or properties.get("namealternate")
            or properties.get("trailnumber")
            or properties.get("trailnumberalternate")
            or "Unnamed USGS trail"
        )
        trail_ref = properties.get("trailnumber") or properties.get("trailnumberalternate")
        maintainer = properties.get("primarytrailmaintainer") or properties.get("sourceoriginator")
        permanent_identifier = properties.get("permanentidentifier") or properties.get("sourcefeatureid") or properties.get("objectid")

        items.append(
            TrailSearchItem(
                id=f"usgs-{permanent_identifier}",
                name=str(trail_name),
                source="usgs",
                trail_type="hiking",
                ref=str(trail_ref) if trail_ref else None,
                operator=str(maintainer) if maintainer else None,
                network=str(properties.get("nationaltraildesignation")) if properties.get("nationaltraildesignation") else None,
                length_m=(float(properties["lengthmiles"]) * 1609.344)
                if isinstance(properties.get("lengthmiles"), (int, float))
                else None,
                points=[
                    {"latitude": point["lat"], "longitude": point["lon"]}
                    for point in points
                ],
                osm_url=None,
            )
        )

    return items


def _build_overpass_query(min_lat: float, min_lon: float, max_lat: float, max_lon: float) -> str:
    return f"""
[out:json][timeout:{OVERPASS_TIMEOUT_SECONDS}];
(
  relation["type"="route"]["route"~"^(hiking|foot|walking)$"]({min_lat},{min_lon},{max_lat},{max_lon});
  way["highway"~"^(path|footway|track|steps)$"]["name"]({min_lat},{min_lon},{max_lat},{max_lon});
  way["highway"~"^(path|footway|track|steps)$"]["ref"]({min_lat},{min_lon},{max_lat},{max_lon});
);
out geom;
""".strip()


def _extract_overpass_geometry(element: dict) -> list[dict[str, float]]:
    geometry = element.get("geometry")
    if isinstance(geometry, list):
        return _normalize_points(
            [
                {"lat": point.get("lat"), "lon": point.get("lon")}
                for point in geometry
                if isinstance(point, dict)
            ]
        )

    if element.get("type") == "relation":
        points: list[dict[str, float]] = []
        for member in element.get("members", []):
            member_geometry = member.get("geometry")
            if member.get("type") != "way" or not isinstance(member_geometry, list):
                continue
            points.extend(
                _normalize_points(
                    [
                        {"lat": point.get("lat"), "lon": point.get("lon")}
                        for point in member_geometry
                        if isinstance(point, dict)
                    ]
                )
            )
        return _normalize_points(points)

    return []


def _is_walk_relevant_way(tags: dict) -> bool:
    highway = str(tags.get("highway") or "")
    if highway in {"path", "footway", "steps"}:
        return True
    if highway == "track":
        return any(
            str(tags.get(key) or "").lower() not in {"", "no", "private"}
            for key in ("foot", "access", "sac_scale", "trail_visibility")
        )
    return False


def _fetch_osm_trails(
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
) -> list[TrailSearchItem]:
    query = _build_overpass_query(min_lat, min_lon, max_lat, max_lon)
    request = Request(
        OVERPASS_API_URL,
        data=query.encode("utf-8"),
        headers={
            "Content-Type": "text/plain; charset=utf-8",
            "User-Agent": "Jarvis Trail Search/1.0",
        },
        method="POST",
    )
    with urlopen(request, timeout=OVERPASS_TIMEOUT_SECONDS + 5) as response:
        payload = json.loads(response.read().decode("utf-8"))

    items: list[TrailSearchItem] = []
    seen_keys: set[tuple[str, int]] = set()

    for element in payload.get("elements", []):
        element_type = element.get("type")
        element_id = element.get("id")
        if element_type not in {"relation", "way"} or not isinstance(element_id, int):
            continue
        key = (element_type, element_id)
        if key in seen_keys:
            continue
        seen_keys.add(key)

        tags = element.get("tags") or {}
        if element_type == "way" and not _is_walk_relevant_way(tags):
            continue

        points = _extract_overpass_geometry(element)
        if len(points) < 2:
            continue

        name = (
            tags.get("name")
            or tags.get("official_name")
            or tags.get("ref")
            or tags.get("alt_name")
            or f"Unnamed {'trail route' if element_type == 'relation' else 'trail'}"
        )
        items.append(
            TrailSearchItem(
                id=f"{element_type}-{element_id}",
                name=name,
                source="osm_relation" if element_type == "relation" else "osm_way",
                trail_type=tags.get("route") or tags.get("highway") or "hiking",
                ref=tags.get("ref"),
                operator=tags.get("operator"),
                network=tags.get("network"),
                points=[
                    {"latitude": point["lat"], "longitude": point["lon"]}
                    for point in points
                ],
                osm_url=f"https://www.openstreetmap.org/{element_type}/{element_id}",
            )
        )

    return items


def search_openstreetmap_trails(
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
    limit: int = 12,
) -> TrailSearchResponse:
    min_lat, min_lon, max_lat, max_lon = _validate_bounds(
        min_lat, min_lon, max_lat, max_lon
    )
    center_lat = (min_lat + max_lat) / 2
    center_lon = (min_lon + max_lon) / 2

    usgs_error: Exception | None = None
    try:
        usgs_items = _fetch_usgs_trails(min_lat, min_lon, max_lat, max_lon)
        usgs_response = _finalize_items(
            usgs_items,
            center_lat=center_lat,
            center_lon=center_lon,
            min_lat=min_lat,
            min_lon=min_lon,
            max_lat=max_lat,
            max_lon=max_lon,
            limit=limit,
        )
        if usgs_response.items:
            return usgs_response
    except Exception as exc:
        usgs_error = exc

    try:
        osm_items = _fetch_osm_trails(min_lat, min_lon, max_lat, max_lon)
        osm_response = _finalize_items(
            osm_items,
            center_lat=center_lat,
            center_lon=center_lon,
            min_lat=min_lat,
            min_lon=min_lon,
            max_lat=max_lat,
            max_lon=max_lon,
            limit=limit,
        )
        if osm_response.items or usgs_error is None:
            return osm_response
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore").strip()
        raise RuntimeError(
            f"Trail search failed with Overpass status {exc.code}. {detail or 'No error body returned.'}"
        ) from exc
    except URLError as exc:
        if usgs_error is not None:
            raise RuntimeError(
                f"USGS trail search failed ({usgs_error}) and OpenStreetMap trail data could not be reached ({exc.reason})."
            ) from exc
        raise RuntimeError(
            f"Trail search could not reach OpenStreetMap trail data. {exc.reason}"
        ) from exc

    if usgs_error is not None:
        raise RuntimeError(f"USGS trail search failed. {usgs_error}")

    return TrailSearchResponse(provider="usgs_national_map", count=0, items=[])
