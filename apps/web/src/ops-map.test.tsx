import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpsMapScreen } from "./App";
import { OpsMap, type OpsMapMarker } from "./OpsMap";
import type { OpsMapView } from "./types";

/**
 * Leaflet is replaced by a recording stub: jsdom has no layout engine
 * for a real map, and what these tests need to prove is the DATA —
 * which pins get created, at which coordinates — plus the side list.
 */
const leafletCalls = vi.hoisted(() => ({
  maps: 0,
  tileUrls: [] as string[],
  markers: [] as { latlng: [number, number]; icon: unknown }[],
  fitted: 0
}));

vi.mock("leaflet", () => {
  const layerGroup = () => {
    const layer: Record<string, unknown> = { clearLayers: vi.fn() };
    layer.addTo = vi.fn(() => layer);
    return layer;
  };
  return {
    default: {
      map: vi.fn(() => {
        leafletCalls.maps += 1;
        const map: Record<string, unknown> = {};
        map.setView = vi.fn(() => map);
        map.remove = vi.fn();
        map.fitBounds = vi.fn(() => {
          leafletCalls.fitted += 1;
        });
        return map;
      }),
      tileLayer: vi.fn((url: string) => {
        leafletCalls.tileUrls.push(url);
        return { addTo: vi.fn() };
      }),
      layerGroup: vi.fn(layerGroup),
      marker: vi.fn((latlng: [number, number], opts: { icon: unknown }) => {
        const marker: Record<string, unknown> = {};
        marker.bindPopup = vi.fn(() => marker);
        marker.addTo = vi.fn(() => marker);
        leafletCalls.markers.push({ latlng, icon: opts.icon });
        return marker;
      }),
      divIcon: vi.fn((opts: unknown) => opts),
      latLngBounds: vi.fn((points: unknown) => ({
        points,
        pad: vi.fn(() => ({}))
      }))
    }
  };
});

type FetchHandler = (url: string, init?: RequestInit) => unknown;

function mockFetch(handler: FetchHandler) {
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const body = handler(String(input), init);
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const view: OpsMapView = {
  date: "2026-10-26",
  jobs: [
    {
      job_id: "job-1",
      case_id: "case-1",
      reference: "RRA-000101",
      channel: "DIRECT",
      case_state: "INSTALLATION_IN_PROGRESS",
      job_status: "IN_PROGRESS",
      glass_type: "WINDSHIELD",
      tech_id: "tech-1",
      tech_name: "Tech A",
      scheduled_start: "2026-10-26T14:00:00.000Z",
      scheduled_end: "2026-10-26T16:00:00.000Z",
      service_address: "118 Terrace St, Boston, MA 02120",
      service_lat: 42.3601,
      service_lon: -71.0589,
      current_step: "EN_ROUTE",
      current_step_label: "Head to the client"
    },
    {
      job_id: "job-2",
      case_id: "case-2",
      reference: "RRA-000102",
      channel: "DIRECT",
      case_state: "INSTALLATION_SCHEDULED",
      job_status: "ASSIGNED",
      glass_type: "DOOR_GLASS",
      tech_id: "tech-1",
      tech_name: "Tech A",
      scheduled_start: "2026-10-26T17:00:00.000Z",
      scheduled_end: "2026-10-26T19:00:00.000Z",
      service_address: null,
      service_lat: null,
      service_lon: null,
      current_step: "PICKUP",
      current_step_label: "Go pick up the order"
    },
    {
      job_id: "job-3",
      case_id: "case-3",
      reference: "RRA-000103",
      channel: "DIRECT",
      case_state: "INSTALLATION_IN_PROGRESS",
      job_status: "IN_PROGRESS",
      glass_type: "BACK_GLASS",
      tech_id: "tech-2",
      tech_name: "Tech B",
      scheduled_start: "2026-10-26T15:00:00.000Z",
      scheduled_end: "2026-10-26T17:00:00.000Z",
      service_address: "5 Oak Ave, Cambridge, MA 02139",
      service_lat: 42.3736,
      service_lon: -71.1097,
      current_step: "PREP_STARTED",
      current_step_label: "Start prep"
    }
  ],
  techs: [
    {
      tech_id: "tech-1",
      tech_name: "Tech A",
      job_id: "job-1",
      reference: "RRA-000101",
      lat: 42.373611,
      lon: -71.109722,
      accuracy_m: 12,
      recorded_at: "2026-10-26T14:20:00.000Z",
      age_seconds: 30
    }
  ]
};

beforeEach(() => {
  leafletCalls.maps = 0;
  leafletCalls.tileUrls = [];
  leafletCalls.markers = [];
  leafletCalls.fitted = 0;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OpsMap (Leaflet wrapper)", () => {
  it("creates an OSM map and one marker per pin, at the pin's coordinates", () => {
    const markers: OpsMapMarker[] = [
      { id: "job-1", kind: "job", lat: 42.3601, lon: -71.0589, label: "site", initial: "⌂" },
      { id: "tech-1", kind: "tech", lat: 42.373611, lon: -71.109722, label: "tech", initial: "T" }
    ];
    render(<OpsMap markers={markers} />);
    expect(screen.getByTestId("ops-map")).toBeInTheDocument();
    expect(leafletCalls.maps).toBe(1);
    expect(leafletCalls.tileUrls[0]).toContain("tile.openstreetmap.org");
    expect(leafletCalls.markers.map(m => m.latlng)).toEqual([
      [42.3601, -71.0589],
      [42.373611, -71.109722]
    ]);
    expect(leafletCalls.fitted).toBeGreaterThanOrEqual(1);
  });
});

describe("OpsMapScreen (Slice C)", () => {
  it("lists today's jobs with pins, steps, and signal age — and honest gaps", async () => {
    mockFetch(url => (url.includes("/ops-map") ? view : {}));
    render(<OpsMapScreen onOpenCase={() => undefined} />);

    const rows = await screen.findAllByTestId("ops-job-row");
    expect(rows).toHaveLength(3);

    // Job 1: address, current step, fresh signal.
    expect(rows[0]).toHaveTextContent("RRA-000101");
    expect(rows[0]).toHaveTextContent("Tech A");
    expect(rows[0]).toHaveTextContent(/Now: Head to the client/);
    expect(rows[0]).toHaveTextContent("118 Terrace St, Boston, MA 02120");
    expect(rows[0]).toHaveTextContent(/Signal just now/);

    // Job 2: no coordinates on file — listed, explained, no pin.
    expect(rows[1]).toHaveTextContent("RRA-000102");
    expect(rows[1]).toHaveTextContent(/No location on file/);

    // Job 3: in progress but the tech has never reported — no signal.
    expect(rows[2]).toHaveTextContent("RRA-000103");
    expect(rows[2]).toHaveTextContent(/No signal yet/);

    // Pins: two job sites + one tech position. Job 2 contributes none.
    const pinCoords = leafletCalls.markers.map(m => m.latlng);
    expect(pinCoords).toContainEqual([42.3601, -71.0589]);
    expect(pinCoords).toContainEqual([42.3736, -71.1097]);
    expect(pinCoords).toContainEqual([42.373611, -71.109722]);
    expect(leafletCalls.markers).toHaveLength(3);
  });

  it("shows the empty state for a day with no jobs", async () => {
    mockFetch(url =>
      url.includes("/ops-map") ? { date: "2026-10-26", jobs: [], techs: [] } : {}
    );
    render(<OpsMapScreen onOpenCase={() => undefined} />);
    expect(
      await screen.findByText(/No jobs scheduled for this day yet/)
    ).toBeInTheDocument();
    expect(leafletCalls.markers).toHaveLength(0);
  });
});
