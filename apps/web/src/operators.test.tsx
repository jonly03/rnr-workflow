import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  App,
  AssignmentPanel,
  OperatorProfileForm,
  OperatorsScreen,
  ScheduleScreen,
  TechHome
} from "./App";
import type { StaffUser } from "./api";
import type { CaseRecord, Operator } from "./types";

type FetchHandler = (url: string, init?: RequestInit) => unknown;

function mockFetch(handler: FetchHandler) {
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const body = handler(String(input), init);
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const adminStaff: StaffUser = {
  id: "admin-1",
  email: "admin@example.com",
  name: "Admin",
  role: "admin"
};
const plainStaff: StaffUser = {
  id: "staff-1",
  email: "staff@example.com",
  name: "Staff",
  role: "staff"
};

function makeOperator(overrides: Partial<Operator> = {}): Operator {
  return {
    id: "tech-1",
    email: "tech.a@gmail.com",
    name: "Tech A",
    role: "tech",
    status: "PROFILE_PENDING",
    profile: {
      user_id: "tech-1",
      status: "PROFILE_PENDING",
      phone: "617-555-0100",
      home_base: "Boston, MA",
      service_area: "Greater Boston",
      claimed_qualifications: ["WINDSHIELD", "ADAS_CALIBRATION"],
      qualifications: [],
      availability: [{ day_of_week: 1, start: "08:00", end: "17:00" }],
      live_status: "AVAILABLE",
      location_sharing_consent: true,
      google_sub: "google-sub-a",
      created_at: "2026-10-21T00:00:00Z",
      updated_at: "2026-10-21T00:00:00Z"
    },
    created_at: "2026-10-21T00:00:00Z",
    ...overrides
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Login screen Google button (feature-detected)", () => {
  it("shows Continue with Google only when the API reports it enabled", async () => {
    mockFetch(url =>
      url.includes("/auth/google/config") ? { enabled: true } : []
    );
    render(<App />);
    const link = await screen.findByTestId("google-signin");
    expect(link).toHaveAttribute("href", expect.stringContaining("/auth/google/start"));
  });

  it("hides the Google button when Google sign-in is not configured", async () => {
    mockFetch(url =>
      url.includes("/auth/google/config") ? { enabled: false } : []
    );
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("google-signin")).not.toBeInTheDocument());
  });
});

describe("Operators screen", () => {
  it("lists techs with status + qualification tags, and verifies a pending tech", async () => {
    let operators = [makeOperator()];
    const fetchMock = mockFetch((url, init) => {
      if (url.endsWith("/operators") && (!init || init.method === undefined)) {
        return { operators, invites: [] };
      }
      if (url.includes("/verify")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.qualifications).toEqual(["WINDSHIELD", "ADAS_CALIBRATION"]);
        operators = [
          makeOperator({
            status: "ACTIVE",
            profile: {
              ...makeOperator().profile!,
              status: "ACTIVE",
              qualifications: ["WINDSHIELD", "ADAS_CALIBRATION"]
            }
          })
        ];
        return { operator: operators[0] };
      }
      return {};
    });

    render(<OperatorsScreen currentStaff={adminStaff} />);
    expect(await screen.findByText("Tech A")).toBeInTheDocument();
    expect(screen.getByText("Profile Pending")).toBeInTheDocument();
    expect(screen.getByText(/Claimed: Windshield, ADAS calibration/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /verify & activate/i }));
    await waitFor(() => expect(screen.getByText("Active")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/operators/tech-1/verify"),
      expect.objectContaining({ method: "POST" })
    );
    expect(screen.getByTestId("operator-card")).toHaveTextContent(/Verified:/);
    expect(screen.getByRole("button", { name: /deactivate/i })).toBeInTheDocument();
  });

  it("creates an invite and shows the one-time link; plain staff cannot manage", async () => {
    mockFetch((url, init) => {
      if (url.includes("/operators/invites") && init?.method === "POST") {
        return {
          invite: {
            id: "inv-1",
            email: "new@gmail.com",
            status: "INVITED",
            expires_at: "2026-10-28T00:00:00Z",
            created_at: "2026-10-21T00:00:00Z"
          },
          invite_path: "/invite/rninv_testcredential",
          credential: "rninv_testcredential"
        };
      }
      if (url.endsWith("/operators")) return { operators: [], invites: [] };
      return {};
    });

    render(<OperatorsScreen currentStaff={adminStaff} />);
    fireEvent.change(screen.getByLabelText(/gmail address/i), {
      target: { value: "new@gmail.com" }
    });
    fireEvent.click(screen.getByRole("button", { name: /create invite/i }));
    expect(await screen.findByDisplayValue(/\/invite\/rninv_testcredential/)).toBeInTheDocument();
  });

  it("hides management controls from plain staff", async () => {
    mockFetch(url => (url.endsWith("/operators") ? { operators: [makeOperator()], invites: [] } : {}));
    render(<OperatorsScreen currentStaff={plainStaff} />);
    expect(await screen.findByText("Tech A")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create invite/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /verify & activate/i })).not.toBeInTheDocument();
  });
});

describe("Schedule board", () => {
  it("groups scheduled jobs by tech and lists the unscheduled worklist", async () => {
    mockFetch(url => {
      if (url.includes("/schedule")) {
        return {
          date: "2026-10-26",
          entries: [
            {
              job: { id: "job-1" },
              case_id: "case-1",
              reference: "RRA-000101",
              channel: "DIRECT",
              current_state: "INSTALLATION_SCHEDULED",
              glass_type: "WINDSHIELD",
              tech_id: "tech-1",
              tech_name: "Quinn Qualified",
              scheduled_start: "2026-10-26T14:00:00.000Z",
              scheduled_end: "2026-10-26T16:00:00.000Z"
            },
            {
              job: null,
              case_id: "case-2",
              reference: "RRA-000102",
              channel: "DIRECT",
              current_state: "PARTS_ORDERED",
              glass_type: "DOOR_GLASS",
              tech_id: null,
              tech_name: null,
              scheduled_start: null,
              scheduled_end: null
            }
          ]
        };
      }
      return {};
    });
    const onOpenCase = vi.fn();
    render(<ScheduleScreen onOpenCase={onOpenCase} />);
    expect(await screen.findByText("Quinn Qualified")).toBeInTheDocument();
    expect(screen.getByText("RRA-000101")).toBeInTheDocument();
    expect(screen.getByTestId("schedule-unscheduled")).toHaveTextContent("RRA-000102");
    fireEvent.click(screen.getByRole("button", { name: "RRA-000101" }));
    expect(onOpenCase).toHaveBeenCalledWith("case-1");
  });
});

describe("Tech surfaces", () => {
  it("TechHome shows the empty state when the tech has no jobs", async () => {
    mockFetch(url => (url.includes("/tech/jobs") ? { jobs: [] } : {}));
    render(
      <TechHome
        staff={{ id: "tech-1", email: "tech.a@gmail.com", name: "Tech A", role: "tech" }}
        mine={{
          staff: { id: "tech-1", email: "tech.a@gmail.com", name: "Tech A", role: "tech" },
          status: "ACTIVE",
          profile: { ...makeOperator().profile!, status: "ACTIVE", qualifications: ["WINDSHIELD"] }
        }}
      />
    );
    expect(await screen.findByText(/No jobs yet/)).toBeInTheDocument();
    expect(screen.getByText(/verified work/i)).toBeInTheDocument();
  });

  it("OperatorProfileForm submits claimed qualifications + consent", async () => {
    const bodies: Record<string, unknown>[] = [];
    mockFetch((url, init) => {
      if (url.includes("/operators/me/profile")) {
        bodies.push(JSON.parse(String(init?.body ?? "{}")));
        return { staff: {}, status: "PROFILE_PENDING", profile: {} };
      }
      return {};
    });
    const onSaved = vi.fn(async () => {});
    render(
      <OperatorProfileForm
        mine={{
          staff: { id: "tech-1", email: "tech.a@gmail.com", name: "Tech A", role: "tech" },
          status: "PROFILE_PENDING",
          profile: { ...makeOperator().profile!, location_sharing_consent: false }
        }}
        onSaved={onSaved}
      />
    );
    fireEvent.click(screen.getByLabelText(/share my location/i));
    fireEvent.click(screen.getByRole("button", { name: /save profile/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(bodies[0]).toMatchObject({
      phone: "617-555-0100",
      home_base: "Boston, MA",
      claimed_qualifications: ["WINDSHIELD", "ADAS_CALIBRATION"],
      location_sharing_consent: true
    });
  });
});

describe("Assignment panel", () => {
  const item = {
    id: "case-1",
    reference: "RRA-000101",
    channel: "DIRECT",
    current_state: "PARTS_ORDERED",
    customer_id: null,
    vehicle: { id: "v-1", year: 2020, make: "Honda", model: "Accord", vin: "1HGCV1F30LA000001" },
    glass_request: { id: "gr-1", glass_type: "WINDSHIELD" },
    glass_identification: null,
    supplier_offers: [],
    price_calculation: null,
    invoice: null,
    quote: null,
    job: null,
    created_at: "2026-10-21T00:00:00Z",
    updated_at: "2026-10-21T00:00:00Z"
  } as unknown as CaseRecord;

  it("finds ranked proposals and assigns the chosen tech", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    mockFetch((url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url, body });
      if (url.endsWith("/operators")) {
        return { operators: [makeOperator({ status: "ACTIVE" })], invites: [] };
      }
      if (url.includes("/assignment/propose")) {
        return {
          job: { id: "job-1", status: "UNASSIGNED" },
          proposals: {
            requirement: {
              glass_type: "WINDSHIELD",
              requires_adas: true,
              service_mode: null,
              required_tags: ["WINDSHIELD", "ADAS_CALIBRATION"]
            },
            window: { start: "2026-10-26T14:00:00.000Z", end: "2026-10-26T16:00:00.000Z" },
            eligible: [
              {
                tech_id: "tech-9",
                name: "Quinn Qualified",
                email: "q@gmail.com",
                free_at: null,
                jobs_that_day: 0,
                qualifications: ["WINDSHIELD", "ADAS_CALIBRATION"]
              }
            ],
            excluded: [
              { tech_id: "tech-2", name: "Door Dan", email: "d@gmail.com", reasons: ["missing qualification: WINDSHIELD"] }
            ]
          }
        };
      }
      if (url.includes("/assignment")) return { job: { id: "job-1", status: "ASSIGNED" }, case: item };
      return {};
    });

    const onRefresh = vi.fn(async () => {});
    render(<AssignmentPanel item={item} onRefresh={onRefresh} />);
    fireEvent.change(screen.getByLabelText(/job start/i), { target: { value: "2026-10-26T10:00" } });
    fireEvent.change(screen.getByLabelText(/job end/i), { target: { value: "2026-10-26T12:00" } });
    fireEvent.click(screen.getByRole("button", { name: /find techs/i }));

    expect(await screen.findByTestId("proposal-row")).toHaveTextContent("Quinn Qualified");
    expect(screen.getByText(/Not eligible: Door Dan/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^assign$/i }));
    await waitFor(() => {
      const assignCall = calls.find(c => /\/assignment$/.test(c.url));
      expect(assignCall?.body).toMatchObject({ tech_id: "tech-9" });
    });
    expect(onRefresh).toHaveBeenCalled();
  });
});
