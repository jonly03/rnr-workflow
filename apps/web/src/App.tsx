import { FormEvent, useEffect, useState } from "react";
import { createCase, getCase, getCaseEvents, listCases } from "./api";
import type { CaseEvent, CaseRecord, Channel, GlassType } from "./types";

type Screen = "queue" | "new" | "detail";

const humanize = (value: string) =>
  value.toLowerCase().replaceAll("_", " ").replace(/(^|\s)\S/g, c => c.toUpperCase());

export function App() {
  const [screen, setScreen] = useState<Screen>("queue");
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [selected, setSelected] = useState<CaseRecord | null>(null);
  const [events, setEvents] = useState<CaseEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const refreshQueue = async () => {
    setLoading(true);
    setMessage("");
    try {
      setCases(await listCases());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load cases.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshQueue();
  }, []);

  const openCase = async (id: string) => {
    setLoading(true);
    setMessage("");
    try {
      const [detail, activity] = await Promise.all([getCase(id), getCaseEvents(id)]);
      setSelected(detail);
      setEvents([...activity].sort((a, b) => b.sequence - a.sequence));
      setScreen("detail");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load this case.");
    } finally {
      setLoading(false);
    }
  };

  if (screen === "new") {
    return (
      <Shell>
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
      <Shell>
        <CaseDetail
          item={selected}
          events={events}
          onBack={() => setScreen("queue")}
          loading={loading}
        />
      </Shell>
    );
  }

  return (
    <Shell>
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

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">R&R</div>
        <span>Case Operations</span>
      </header>
      <main>{children}</main>
    </div>
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
  loading
}: {
  item: CaseRecord;
  events: CaseEvent[];
  onBack: () => void;
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

        <section className="card">
          <h2>Current action</h2>
          <p>No staff action required at this step.</p>
          <small>Workflow actions will appear here when their business contracts are implemented.</small>
        </section>
      </div>

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
