import { FormEvent, useEffect, useState } from "react";
import {
  createCase,
  getCase,
  getCaseEvents,
  getMe,
  getToken,
  listCases,
  login,
  logout,
  performAction,
  UnauthorizedError,
  type StaffUser
} from "./api";
import type { CaseEvent, CaseRecord, Channel, GlassCandidate, GlassType } from "./types";

type Screen = "queue" | "new" | "detail";

const humanize = (value: string) =>
  value.toLowerCase().replaceAll("_", " ").replace(/(^|\s)\S/g, c => c.toUpperCase());

export function App() {
  const [staff, setStaff] = useState<StaffUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [screen, setScreen] = useState<Screen>("queue");
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [selected, setSelected] = useState<CaseRecord | null>(null);
  const [events, setEvents] = useState<CaseEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const handleUnauthorized = () => {
    setStaff(null);
    setScreen("queue");
  };

  const loadError = (error: unknown) => {
    if (error instanceof UnauthorizedError) {
      handleUnauthorized();
      return;
    }
    setMessage(error instanceof Error ? error.message : "Could not load cases.");
  };

  useEffect(() => {
    if (!getToken()) {
      setAuthChecked(true);
      setLoading(false);
      return;
    }
    getMe()
      .then(({ staff }) => setStaff(staff))
      .catch(() => setStaff(null))
      .finally(() => setAuthChecked(true));
  }, []);

  const refreshQueue = async () => {
    setLoading(true);
    setMessage("");
    try {
      setCases(await listCases());
    } catch (error) {
      loadError(error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (staff) void refreshQueue();
  }, [staff]);

  const openCase = async (id: string) => {
    setLoading(true);
    setMessage("");
    try {
      const [detail, activity] = await Promise.all([getCase(id), getCaseEvents(id)]);
      setSelected(detail);
      setEvents([...activity].sort((a, b) => b.sequence - a.sequence));
      setScreen("detail");
    } catch (error) {
      loadError(error);
    } finally {
      setLoading(false);
    }
  };

  const signOut = () => {
    logout();
    setStaff(null);
    setCases([]);
    setSelected(null);
    setScreen("queue");
  };

  if (!authChecked) {
    return (
      <Shell staff={null} onSignOut={signOut}>
        <div className="card">Loading…</div>
      </Shell>
    );
  }

  if (!staff) {
    return (
      <Shell staff={null} onSignOut={signOut}>
        <LoginScreen onSignedIn={s => setStaff(s)} />
      </Shell>
    );
  }

  if (screen === "new") {
    return (
      <Shell staff={staff} onSignOut={signOut}>
        <NewCase
          onCancel={() => setScreen("queue")}
          onCreated={async c => {
            await refreshQueue();
            await openCase(c.id);
          }}
        />
      </Shell>
    );
  }

  if (screen === "detail" && selected) {
    return (
      <Shell staff={staff} onSignOut={signOut}>
        <CaseDetail
          item={selected}
          events={events}
          onBack={() => setScreen("queue")}
          onRefresh={() => openCase(selected.id)}
          loading={loading}
        />
      </Shell>
    );
  }

  return (
    <Shell staff={staff} onSignOut={signOut}>
      <section className="page-head">
        <div>
          <p className="eyebrow">R&R Operations</p>
          <h1>Case Queue</h1>
          <p className="muted">One operational truth across Direct, Auction, and Insurance.</p>
        </div>
        <button className="primary" onClick={() => setScreen("new")}>+ New Case</button>
      </section>

      {message && <div className="alert">{message}</div>}
      {loading ? (
        <div className="card">Loading cases…</div>
      ) : cases.length === 0 ? (
        <div className="empty card">
          <h2>No cases yet.</h2>
          <p>Create the first case to start the operational record.</p>
          <button className="primary" onClick={() => setScreen("new")}>Create first case</button>
        </div>
      ) : (
        <div className="case-list">
          {cases.map(c => (
            <article className="case-card" key={c.id}>
              <div>
                <strong>{c.reference}</strong>
                <span className="channel">{c.channel}</span>
              </div>
              <div className="vehicle">{c.vehicle.year} {c.vehicle.make} {c.vehicle.model}</div>
              <div>{humanize(c.glass_request.glass_type)}</div>
              <div>
                <span className="state">{humanize(c.current_state)}</span>
                <small>{c.current_state}</small>
              </div>
              <button onClick={() => void openCase(c.id)}>Open</button>
            </article>
          ))}
        </div>
      )}
    </Shell>
  );
}

function Shell({
  children,
  staff,
  onSignOut
}: {
  children: React.ReactNode;
  staff: StaffUser | null;
  onSignOut: () => void;
}) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">R&R</div>
        <span>Case Operations</span>
        {staff && (
          <span className="staff-line">
            {staff.name} · {staff.email}
            <button className="link" onClick={onSignOut}>Sign out</button>
          </span>
        )}
      </header>
      <main>{children}</main>
    </div>
  );
}

function LoginScreen({ onSignedIn }: { onSignedIn: (s: StaffUser) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [signingIn, setSigningIn] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSigningIn(true);
    try {
      onSignedIn(await login(email.trim(), password));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <form className="form card" onSubmit={submit}>
      <div className="page-head">
        <div>
          <p className="eyebrow">R&R Operations</p>
          <h1>Sign in</h1>
          <p className="muted">Staff access only.</p>
        </div>
      </div>

      {error && <div className="alert" role="alert">{error}</div>}

      <label>
        Email
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={e => setEmail(e.target.value)}
        />
      </label>

      <label>
        Password
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={e => setPassword(e.target.value)}
        />
      </label>

      <div className="actions">
        <button className="primary" disabled={signingIn}>
          {signingIn ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </form>
  );
}

function NewCase({
  onCancel,
  onCreated
}: {
  onCancel: () => void;
  onCreated: (c: CaseRecord) => Promise<void>;
}) {
  const [channel, setChannel] = useState<Channel>("DIRECT");
  const [year, setYear] = useState("2018");
  const [make, setMake] = useState("Jeep");
  const [model, setModel] = useState("Wrangler");
  const [vin, setVin] = useState("1C4HJXEG3JW224862");
  const [glassType, setGlassType] = useState<GlassType>("WINDSHIELD");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");

    if (!year || !make.trim() || !model.trim() || !vin.trim()) {
      setError("Year, Make, Model, and VIN are required.");
      return;
    }

    setSaving(true);
    try {
      const c = await createCase({
        channel,
        vehicle: {
          year: Number(year),
          make: make.trim(),
          model: model.trim(),
          vin: vin.trim()
        },
        glass_request: { glass_type: glassType }
      });
      await onCreated(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create case.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form card" onSubmit={submit}>
      <div className="page-head">
        <div>
          <p className="eyebrow">Case Core</p>
          <h1>New Case</h1>
        </div>
      </div>

      {error && <div className="alert" role="alert">{error}</div>}

      <label>
        Channel
        <select value={channel} onChange={e => setChannel(e.target.value as Channel)}>
          <option value="DIRECT">Direct</option>
          <option value="AUCTION">Auction</option>
          <option value="INSURANCE">Insurance</option>
        </select>
      </label>

      <div className="grid">
        <label>Year<input value={year} onChange={e => setYear(e.target.value)} inputMode="numeric" /></label>
        <label>Make<input value={make} onChange={e => setMake(e.target.value)} /></label>
        <label>Model<input value={model} onChange={e => setModel(e.target.value)} /></label>
      </div>

      <label>VIN<input value={vin} onChange={e => setVin(e.target.value)} /></label>

      <label>
        Requested glass type
        <select value={glassType} onChange={e => setGlassType(e.target.value as GlassType)}>
          <option value="WINDSHIELD">Windshield</option>
          <option value="BACK_GLASS">Back Glass</option>
          <option value="DOOR_GLASS">Door Glass</option>
          <option value="QUARTER_GLASS">Quarter Glass</option>
          <option value="VENT_GLASS">Vent Glass</option>
        </select>
      </label>

      <div className="actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={saving}>{saving ? "Creating Case…" : "Create Case"}</button>
      </div>
    </form>
  );
}

function CaseDetail({
  item,
  events,
  onBack,
  onRefresh,
  loading
}: {
  item: CaseRecord;
  events: CaseEvent[];
  onBack: () => void;
  onRefresh: () => Promise<void>;
  loading: boolean;
}) {
  return (
    <>
      <button className="back" onClick={onBack}>← Case Queue</button>
      <section className="page-head">
        <div>
          <p className="eyebrow" data-testid="case-channel">{item.channel}</p>
          <h1>{item.reference}</h1>
          <div className="state-line">
            <span className="state">{humanize(item.current_state)}</span>
            <code>{item.current_state}</code>
          </div>
        </div>
      </section>

      <div className="detail-grid">
        <section className="card">
          <h2>Vehicle / Service</h2>
          <dl>
            <dt>Vehicle</dt><dd>{item.vehicle.year} {item.vehicle.make} {item.vehicle.model}</dd>
            <dt>VIN</dt><dd><code>{item.vehicle.vin}</code></dd>
            <dt>Glass type</dt><dd>{humanize(item.glass_request.glass_type)}</dd>
            <dt>Created</dt><dd>{new Date(item.created_at).toLocaleString()}</dd>
          </dl>
        </section>

        <IdentificationWorkspace item={item} onRefresh={onRefresh} />
      </div>

      <IdentificationSummary item={item} />

      <section className="card timeline">
        <h2>Activity</h2>
        {loading ? <p>Loading activity…</p> : events.length === 0 ? (
          <p>No activity recorded yet.</p>
        ) : (
          <ol>
            {events.map(e => (
              <li key={e.id}>
                <strong>{e.event_type}</strong>
                <span>{new Date(e.occurred_at).toLocaleString()}</span>
                <small>#{e.sequence} · {e.actor_type}</small>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

/** The staff workspace for the current workflow step. Phase 2 fills the
 *  glass-identification steps; other steps show the standby message until
 *  their business contracts land. */
function IdentificationWorkspace({
  item,
  onRefresh
}: {
  item: CaseRecord;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedPart, setSelectedPart] = useState("");

  const run = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    setError("");
    try {
      await performAction(item.id, action, extra);
      setSelectedPart("");
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  };

  const ident = item.glass_identification;
  const candidates: GlassCandidate[] = ident?.candidates ?? [];

  let body: React.ReactNode;
  switch (item.current_state) {
    case "VIN_LOOKUP_REQUIRED":
      body = (
        <>
          <p>
            The catalog could not pin down the exact part. A VIN decode can
            resolve it — the mock catalog stands in here, so nothing is charged.
          </p>
          <div className="workspace-actions">
            <button className="primary" disabled={busy} onClick={() => run("request_vin_lookup")}>
              {busy ? "Looking up…" : "Run VIN lookup"}
            </button>
          </div>
          <small>Successful VIN results are cached and reused — never repurchased.</small>
        </>
      );
      break;
    case "HUMAN_GLASS_REVIEW_REQUIRED":
      body = (
        <>
          <p>
            The catalog returned {candidates.length} candidates and a VIN lookup
            is not eligible for this glass type. Pick the correct part:
          </p>
          <div className="candidates">
            {candidates.map(c => (
              <label key={c.part_number} className="candidate">
                <input
                  type="radio"
                  name="candidate"
                  value={c.part_number}
                  checked={selectedPart === c.part_number}
                  onChange={() => setSelectedPart(c.part_number)}
                />
                <div>
                  <strong><code>{c.part_number}</code></strong>
                  <div>{c.description}</div>
                  {c.features.length > 0 && <small>Features: {c.features.join(", ")}</small>}
                </div>
              </label>
            ))}
          </div>
          <div className="workspace-actions">
            <button
              className="primary"
              disabled={busy || !selectedPart}
              onClick={() => run("select_glass_candidate", { part_number: selectedPart })}
            >
              {busy ? "Saving…" : "Select this glass"}
            </button>
            <button disabled={busy} onClick={() => run("mark_glass_unidentifiable")}>
              Can't identify
            </button>
          </div>
        </>
      );
      break;
    case "GLASS_NOT_IDENTIFIED":
      body = (
        <>
          <p>No valid glass could be identified from the current vehicle data.</p>
          <div className="workspace-actions">
            <button className="primary" disabled={busy} onClick={() => run("retry_identification")}>
              {busy ? "Retrying…" : "Retry identification"}
            </button>
          </div>
        </>
      );
      break;
    default:
      body = (
        <>
          <p>No staff action required at this step.</p>
          <small>Workflow actions will appear here when their business contracts are implemented.</small>
        </>
      );
  }

  return (
    <section className="card">
      <h2>Current action</h2>
      {error && <div className="alert">{error}</div>}
      {body}
    </section>
  );
}

function IdentificationSummary({ item }: { item: CaseRecord }) {
  const ident = item.glass_identification;
  if (!ident) return null;
  const selected = ident.selected_candidate;
  return (
    <section className="card" style={{ marginBottom: 18 }}>
      <h2>Glass identification</h2>
      <dl>
        <dt>Method</dt>
        <dd>{ident.method === "YMM" ? "YMM catalog search" : "VIN decode"}</dd>
        <dt>Status</dt><dd>{humanize(ident.status)}</dd>
        {selected && (
          <>
            <dt>Selected part</dt>
            <dd><code>{selected.part_number}</code> — {selected.description}</dd>
          </>
        )}
      </dl>
      {!selected && ident.candidates.length > 0 && (
        <>
          <h3>Candidates ({ident.candidates.length})</h3>
          <ul className="candidate-list">
            {ident.candidates.map(c => (
              <li key={c.part_number}>
                <code>{c.part_number}</code> — {c.description}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
