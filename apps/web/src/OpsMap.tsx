import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * The map half of the staff daily ops view (Slice C, brief §3.4):
 * Leaflet + OpenStreetMap tiles (keyless). Pins are divIcons — styled
 * dots rendered by the app — so there are no marker-image assets for
 * the bundler to lose. The map fits its frame to the pins when the
 * SET of pins changes; routine position updates move pins without
 * yanking the view away from a staff member who is panning around.
 */

export interface OpsMapMarker {
  id: string;
  kind: "job" | "tech";
  lat: number;
  lon: number;
  /** Popup text (plain text — escaped before it becomes popup HTML). */
  label: string;
  /** Single glyph shown inside the pin dot. */
  initial: string;
}

/** Boston — R&R's home turf; the frame until the first pins arrive. */
const HOME_VIEW: [number, number] = [42.3601, -71.0589];

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function OpsMap({ markers }: { markers: OpsMapMarker[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const fittedForRef = useRef<string>("");

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current).setView(HOME_VIEW, 11);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      fittedForRef.current = "";
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    for (const marker of markers) {
      const icon = L.divIcon({
        className: "ops-pin-wrap",
        html: `<span class="ops-pin ops-pin-${marker.kind}">${escapeHtml(marker.initial)}</span>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      L.marker([marker.lat, marker.lon], { icon })
        .bindPopup(escapeHtml(marker.label))
        .addTo(layer);
    }
    const key = markers
      .map(m => m.id)
      .sort()
      .join(",");
    if (markers.length > 0 && key !== fittedForRef.current) {
      fittedForRef.current = key;
      const bounds = L.latLngBounds(
        markers.map(m => [m.lat, m.lon] as [number, number])
      );
      map.fitBounds(bounds.pad(0.25), { maxZoom: 14 });
    }
  }, [markers]);

  return (
    <div
      ref={containerRef}
      className="ops-map"
      data-testid="ops-map"
      role="img"
      aria-label="Map of today's job sites and technician positions"
    />
  );
}
