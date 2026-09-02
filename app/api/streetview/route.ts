import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Serves the real Street View photograph of a solved location.
 *
 * The image is proxied rather than linked so the Maps key never reaches the
 * browser, and so a location with no coverage can be reported as 404 instead
 * of returning Google's grey "no imagery" placeholder.
 */
const KEY = () => process.env.GOOGLE_MAPS_API_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

type Meta = { status: string; location?: { lat: number; lng: number }; date?: string };

const bearing = (from: { lat: number; lng: number }, to: { lat: number; lon: number }) => {
  const φ1 = (from.lat * Math.PI) / 180;
  const φ2 = (to.lat * Math.PI) / 180;
  const Δλ = ((to.lon - from.lng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

export async function GET(request: Request) {
  const key = KEY();
  if (!key) return NextResponse.json({ error: "No Maps key configured." }, { status: 501 });

  const params = new URL(request.url).searchParams;
  const lat = Number(params.get("lat"));
  const lon = Number(params.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "bad coordinates" }, { status: 400 });
  }

  try {
    // Metadata is free, and tells us whether there is any imagery at all.
    const metaResponse = await fetch(
      `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lon}&radius=90&key=${key}`,
      { signal: AbortSignal.timeout(12_000) },
    );
    const meta = (await metaResponse.json()) as Meta;
    if (meta.status !== "OK" || !meta.location) {
      return NextResponse.json({ error: "no imagery here" }, { status: 404 });
    }

    // Point the camera from where the car stood back at the actual site.
    const heading = Math.round(bearing(meta.location, { lat, lon }));

    const image = await fetch(
      `https://maps.googleapis.com/maps/api/streetview?size=640x360&location=${lat},${lon}` +
      `&heading=${heading}&fov=85&pitch=6&radius=90&source=outdoor&return_error_code=true&key=${key}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!image.ok) return NextResponse.json({ error: "no imagery here" }, { status: 404 });

    return new NextResponse(await image.arrayBuffer(), {
      headers: {
        "Content-Type": image.headers.get("content-type") ?? "image/jpeg",
        // the ground does not move; cache hard to keep the bill down
        "Cache-Control": "public, max-age=86400, immutable",
        "X-StreetView-Date": meta.date ?? "",
      },
    });
  } catch {
    return NextResponse.json({ error: "street view unavailable" }, { status: 502 });
  }
}
