import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobProgressPanel, TechHome } from "./App";
import type { StaffUser } from "./api";
import type { CaseAsset, JobStepEvent, TechJob } from "./types";

type FetchHandler = (url: string, init?: RequestInit) => unknown;

function mockFetch(handler: FetchHandler) {
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const body = handler(String(input), init);
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const techStaff: StaffUser = {
  id: "tech-1",
  email: "tech.a@gmail.com",
  name: "Tech A",
  role: "tech"
};

const mine = {
  staff: techStaff,
  status: "ACTIVE",
  profile: null
};

function stepEvent(step: string, payload: Record<string, unknown> = {}): JobStepEvent {
  return {
    id: `evt-${step}`,
    job_id: "job-1",
    case_id: "case-1",
    step,
    actor_type: "TECH",
    actor_id: "tech-1",
    payload,
    occurred_at: "2026-10-26T14:05:00.000Z"
  };
}

function makeAsset(overrides: Partial<CaseAsset> = {}): CaseAsset {
  return {
    id: "asset-1",
    case_id: "case-1",
    job_id: "job-1",
    kind: "BEFORE_PHOTO",
    visibility: "TECH_VISIBLE",
    storage_driver: "mock",
    filename: "before.jpg",
    content_type: "image/jpeg",
    size_bytes: 4,
    status: "READY",
    uploaded_by_type: "TECH",
    uploaded_by_id: "tech-1",
    created_at: "2026-10-26T14:04:00.000Z",
    has_bytes: true,
    ...overrides
  };
}

function makeJob(overrides: Partial<TechJob> = {}): TechJob {
  return {
    job: {
      id: "job-1",
      case_id: "case-1",
      status: "ASSIGNED",
      assignment_mode: "DIRECT",
      assigned_tech_id: "tech-1",
      scheduled_start: "2026-10-26T14:00:00.000Z",
      scheduled_end: "2026-10-26T16:00:00.000Z",
      calendar_event_id: null,
      created_at: "2026-10-26T00:00:00Z",
      updated_at: "2026-10-26T00:00:00Z"
    },
    current_step: "PICKUP",
    steps: [],
    case: {
      id: "case-1",
      reference: "RRA-000101",
      channel: "DIRECT",
      current_state: "INSTALLATION_SCHEDULED",
      glass_type: "WINDSHIELD",
      vehicle: { year: 2020, make: "Honda", model: "Accord" }
    },
    client: {
      name: "Jamie Client",
      phone: "617-555-0100",
      service_address: "12 Main St, Boston, MA 02118"
    },
    assets: [],
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

describe("Tech job list (Slice B)", () => {
  it("renders the tech's jobs with the next step and opens the checklist", async () => {
    const job = makeJob();
    mockFetch(url => {
      if (url.endsWith("/tech/jobs")) return { jobs: [job] };
      if (url.endsWith("/tech/jobs/job-1")) return { job };
      return {};
    });
    render(<TechHome staff={techStaff} mine={mine} />);
    expect(await screen.findByText("RRA-000101")).toBeInTheDocument();
    expect(screen.getByText(/Next: Go pick up the order/)).toBeInTheDocument();
    expect(screen.getByText(/12 Main St, Boston, MA 02118/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /open job/i }));
    expect(await screen.findByTestId("job-checklist")).toBeInTheDocument();
    expect(screen.getByTestId("checklist-step-PICKUP")).toHaveTextContent(
      /Go pick up the order/
    );
    expect(screen.getByText("12 Main St, Boston, MA 02118")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "617-555-0100" })).toHaveAttribute(
      "href",
      "tel:617-555-0100"
    );
  });
});

describe("Tech checklist (Slice B)", () => {
  it("advances the current step and re-renders from the server state", async () => {
    let job = makeJob();
    const bodies: Record<string, unknown>[] = [];
    mockFetch((url, init) => {
      if (url.endsWith("/tech/jobs")) return { jobs: [job] };
      if (url.includes("/steps") && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body ?? "{}")));
        job = makeJob({
          job: { ...job.job, status: "IN_PROGRESS" },
          current_step: "PICKED_UP",
          steps: [stepEvent("PICKUP")]
        });
        return { job };
      }
      if (url.endsWith("/tech/jobs/job-1")) return { job };
      return {};
    });
    render(<TechHome staff={techStaff} mine={mine} />);
    fireEvent.click(await screen.findByRole("button", { name: /open job/i }));
    fireEvent.click(await screen.findByRole("button", { name: /start pickup/i }));
    expect(bodies).toEqual([{ step: "PICKUP" }]);
    expect(
      await screen.findByRole("button", { name: /mark picked up/i })
    ).toBeInTheDocument();
    expect(screen.getByTestId("checklist-step-PICKUP")).toHaveTextContent(/✓/);
  });

  it("gates the before-photos step until a photo upload confirms", async () => {
    const priorSteps = ["PICKUP", "PICKED_UP", "EN_ROUTE", "ARRIVED", "CHECKED_IN"].map(
      s => stepEvent(s)
    );
    let job = makeJob({
      job: { ...makeJob().job, status: "IN_PROGRESS" },
      current_step: "BEFORE_PHOTOS",
      steps: priorSteps,
      assets: []
    });
    mockFetch((url, init) => {
      if (url.includes("/assets/upload-url") && init?.method === "POST") {
        return {
          asset: makeAsset({ status: "PENDING" }),
          upload: {
            url: "/api/v1/assets/asset-1/content?exp=1&sig=x",
            method: "PUT",
            headers: { "Content-Type": "image/jpeg" }
          }
        };
      }
      if (url.includes("/content") && init?.method === "PUT") return { ok: true };
      if (url.includes("/confirm") && init?.method === "POST") {
        return { asset: makeAsset() };
      }
      if (url.endsWith("/tech/jobs")) return { jobs: [job] };
      if (url.endsWith("/tech/jobs/job-1")) {
        // After the upload round-trip the job reload shows the photo.
        return { job };
      }
      return {};
    });
    render(<TechHome staff={techStaff} mine={mine} />);
    fireEvent.click(await screen.findByRole("button", { name: /open job/i }));

    const doneButton = await screen.findByRole("button", { name: /photos uploaded/i });
    expect(doneButton).toBeDisabled();
    expect(screen.getByText(/Upload at least one photo/)).toBeInTheDocument();

    job = { ...job, assets: [makeAsset()] };
    const input = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "before.jpg", {
      type: "image/jpeg"
    });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(doneButton).not.toBeDisabled());
    expect(screen.getByText("before.jpg")).toBeInTheDocument();
  });

  it("records the client check-in with the confirming client's name", async () => {
    const priorSteps = [
      "PICKUP", "PICKED_UP", "EN_ROUTE", "ARRIVED", "CHECKED_IN", "BEFORE_PHOTOS",
      "PREP_STARTED", "PREP_DONE", "INSTALL_STARTED", "INSTALL_DONE", "AFTER_PHOTOS"
    ].map(s => stepEvent(s));
    const job = makeJob({
      job: { ...makeJob().job, status: "IN_PROGRESS" },
      current_step: "CLIENT_CHECKIN",
      steps: priorSteps,
      assets: [makeAsset(), makeAsset({ id: "asset-2", kind: "AFTER_PHOTO", filename: "after.jpg" })]
    });
    const bodies: Record<string, unknown>[] = [];
    mockFetch((url, init) => {
      if (url.endsWith("/tech/jobs")) return { jobs: [job] };
      if (url.includes("/steps") && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body ?? "{}")));
        return {
          job: makeJob({
            ...job,
            current_step: "FINISHED",
            steps: [...priorSteps, stepEvent("CLIENT_CHECKIN", { client_name: "Jamie Client" })]
          })
        };
      }
      if (url.endsWith("/tech/jobs/job-1")) return { job };
      return {};
    });
    render(<TechHome staff={techStaff} mine={mine} />);
    fireEvent.click(await screen.findByRole("button", { name: /open job/i }));
    const record = await screen.findByRole("button", { name: /record check-in/i });
    expect(record).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/client's name/i), {
      target: { value: "Jamie Client" }
    });
    expect(record).not.toBeDisabled();
    fireEvent.click(record);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ step: "CLIENT_CHECKIN", client_name: "Jamie Client" });
  });
});

describe("Staff job progress panel (Slice B)", () => {
  it("shows checklist progress and downloadable files for the case", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    mockFetch(url => {
      if (url.includes("/cases/case-1/job")) {
        return {
          job: { ...makeJob().job, tech_name: "Tech A" },
          steps: [stepEvent("PICKUP"), stepEvent("PICKED_UP")],
          current_step: "EN_ROUTE",
          assets: [makeAsset()]
        };
      }
      if (url.includes("/download-url")) {
        return { asset: makeAsset(), url: "https://files.example/before.jpg" };
      }
      return {};
    });
    render(<JobProgressPanel caseId="case-1" />);
    expect(await screen.findByText(/2 of 13 steps done/)).toBeInTheDocument();
    expect(screen.getByText(/next: Head to the client/)).toBeInTheDocument();
    expect(screen.getByText(/before\.jpg/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        "https://files.example/before.jpg",
        "_blank",
        "noopener"
      )
    );
  });

  it("renders nothing for a case whose job has not started", async () => {
    mockFetch(url =>
      url.includes("/cases/case-1/job")
        ? { job: { ...makeJob().job, tech_name: "Tech A" }, steps: [], current_step: "PICKUP", assets: [] }
        : {}
    );
    const { container } = render(<JobProgressPanel caseId="case-1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
