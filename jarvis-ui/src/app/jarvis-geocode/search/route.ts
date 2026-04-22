import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = (searchParams.get("q") || "").trim();
  const limit = Math.max(1, Math.min(5, Number(searchParams.get("limit") || "5")));

  if (!query) {
    return NextResponse.json({ items: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: String(limit),
    countrycodes: "us",
  });

  const response = await fetch(`${NOMINATIM_SEARCH_URL}?${params.toString()}`, {
    headers: {
      "User-Agent": "Jarvis Terrain Search/1.0",
      "Accept-Language": "en-US,en;q=0.9",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    return NextResponse.json(
      { detail: `Geocode lookup failed with status ${response.status}` },
      { status: response.status, headers: { "Cache-Control": "no-store" } }
    );
  }

  const items = await response.json();
  return NextResponse.json(
    { items: Array.isArray(items) ? items : [] },
    { headers: { "Cache-Control": "no-store" } }
  );
}
