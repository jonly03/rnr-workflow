import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  createCase,
  decodeVin,
  getCase,
  getCaseEvents,
  getMe,
  getToken,
  listCases,
  login,
  logout,
  ocrVinPhoto,
  performAction,
  UnauthorizedError,
  type DecodedVehicle,
  type StaffUser
} from "./api";
import type { CaseEvent, CaseRecord, Channel, GlassCandidate, GlassType } from "./types";
import { normalizeSpokenVin, validateSpokenVin } from "./vin-voice";
import { useVinVoice } from "./useVinVoice";

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

const GLASS_TYPE_OPTIONS: { value: GlassType; label: string }[] = [
  { value: "WINDSHIELD", label: "Windshield" },
  { value: "BACK_GLASS", label: "Back Glass" },
  { value: "DOOR_GLASS", label: "Door Glass" },
  { value: "QUARTER_GLASS", label: "Quarter Glass" },
  { value: "VENT_GLASS", label: "Vent Glass" }
];

function VinFirstCase({
  onCancel,
  onCreated,
  onManual
}: {
  onCancel: () => void;
  onCreated: (c: CaseRecord) => Promise<void>;
  onManual: () => void;
}) {
  const [vinInput, setVinInput] = useState("");
  const [decoding, setDecoding] = useState(false);
  const [decoded, setDecoded] = useState<DecodedVehicle | null>(null);
  const [glassType, setGlassType] = useState<GlassType>("WINDSHIELD");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Voice dictation state: a validated 17-char VIN awaiting confirmation.
  const [voiceCandidate, setVoiceCandidate] = useState<string | null>(null);
  const [correctionIndex, setCorrectionIndex] = useState<number | null>(null);
  const [correctionValue, setCorrectionValue] = useState("");

  const handleVoiceTranscript = useCallback((transcript: string) => {
    const candidate = normalizeSpokenVin(transcript);
    const result = validateSpokenVin(candidate);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setError("");
    setVoiceCandidate(result.vin);
    setCorrectionIndex(null);
  }, []);

  const voice = useVinVoice(handleVoiceTranscript);

  const applyCorrection = useCallback(
    (index: number, char: string) => {
      setVoiceCandidate(prev => {
        if (!prev) return prev;
        const next = prev.slice(0, index) + char + prev.slice(index + 1);
        const result = validateSpokenVin(next);
        setError(result.ok ? "" : result.reason);
        return next;
      });
    },
    []
  );

  const runDecode = async (vin: string) => {
    setError("");
    setDecoded(null);
    if (vin.trim().length !== 17) {
      setError("Enter a 17-character VIN.");
      return;
    }
    setDecoding(true);
    try {
      const result = await decodeVin(vin.trim());
      setDecoded(result.vehicle);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not decode VIN.");
    } finally {
      setDecoding(false);
    }
  };

  const handleDecode = (e: FormEvent) => {
    e.preventDefault();
    void runDecode(vinInput);
  };

  const useVoiceCandidate = () => {
    if (!voiceCandidate) return;
    const vin = voiceCandidate;
    setVoiceCandidate(null);
    setCorrectionIndex(null);
    setCorrectionValue("");
    setVinInput(vin);
    void runDecode(vin);
  };

  const discardVoiceCandidate = () => {
    setVoiceCandidate(null);
    setCorrectionIndex(null);
    setCorrectionValue("");
    setError("");
  };

  // Photo OCR state: a VIN read from an uploaded photo, awaiting confirmation.
  const [ocrScanning, setOcrScanning] = useState(false);
  const [ocrVin, setOcrVin] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handlePhotoSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    setOcrVin(null);
    setOcrScanning(true);
    try {
      const result = await ocrVinPhoto(file);
      setOcrVin(result.vin);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read VIN from photo.");
    } finally {
      setOcrScanning(false);
    }
  };

  const handleCreate = async () => {
    if (!decoded) return;
    setError("");
    setSaving(true);
    try {
      const c = await createCase({
        channel: "DIRECT",
        vehicle: {
          year: decoded.year,
          make: decoded.make,
          model: decoded.model,
          vin: decoded.vin
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
    <div className="form card">
      <div className="page-head">
        <div>
          <p className="eyebrow">Case Core</p>
          <h1>New Case</h1>
        </div>
      </div>

      {error && <div className="alert" role="alert">{error}</div>}

      {!decoded ? (
        <form onSubmit={handleDecode}>
          <label htmlFor="vin-input">VIN</label>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            {voice.supported && (
              <button
                type="button"
                className={"mic-btn" + (voice.status === "listening" ? " listening" : "")}
                onClick={() => (voice.status === "listening" ? voice.stop() : voice.start())}
                aria-label={voice.status === "listening" ? "Stop dictating VIN" : "Dictate VIN by voice"}
                title={voice.status === "listening" ? "Stop" : "Dictate the VIN"}
              >
                {voice.status === "listening" ? "⏹" : "🎤"}
              </button>
            )}
            <input
              id="vin-input"
              value={vinInput}
              onChange={e => setVinInput(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/gi, ""))}
              placeholder="17-character VIN"
              maxLength={17}
              style={{ textTransform: "uppercase", flex: 1 }}
              autoFocus
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={ocrScanning}
              title="Upload a photo of the VIN"
              aria-label="Upload a photo of the VIN"
            >
              {ocrScanning ? "…" : "📷"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: "none" }}
              onChange={handlePhotoSelected}
            />
            <button className="primary" type="submit" disabled={decoding || vinInput.trim().length !== 17}>
              {decoding ? "Decoding…" : "Decode"}
            </button>
          </div>
          {voice.status === "listening" && (
            <p className="muted interim" role="status">
              Listening… speak the VIN one character at a time.
              {voice.interim ? ` Heard so far: "${voice.interim}"` : ""}
            </p>
          )}
          {voice.error && <div className="alert" role="alert">{voice.error}</div>}
          {voiceCandidate && (
            <div className="card vin-confirm">
              <h3 style={{ margin: "0 0 0.25rem" }}>I heard this VIN — look it over</h3>
              <p className="muted" style={{ margin: "0 0 0.5rem" }}>
                Tap any character to fix it, then use the VIN below.
              </p>
              <div className="vin-groups" aria-label={`Dictated VIN ${voiceCandidate}`}>
                {[0, 3, 9].map(start => {
                  const end = start === 0 ? 3 : start === 3 ? 9 : 17;
                  return (
                    <span key={start} className="vin-group">
                      {voiceCandidate.slice(start, end).split("").map((c, i) => {
                        const index = start + i;
                        return (
                          <button
                            key={index}
                            type="button"
                            className={"vin-char" + (correctionIndex === index ? " selected" : "")}
                            onClick={() => {
                              setCorrectionIndex(index);
                              setCorrectionValue(voiceCandidate[index]);
                            }}
                            aria-label={`Character ${index + 1}: ${c}. Activate to correct.`}
                          >
                            {c}
                          </button>
                        );
                      })}
                    </span>
                  );
                })}
              </div>
              {correctionIndex !== null && (
                <div className="vin-correction">
                  <label>
                    Fix character {correctionIndex + 1}:
                    <input
                      value={correctionValue}
                      maxLength={1}
                      onChange={e => {
                        const v = e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, "");
                        setCorrectionValue(v);
                        if (v) applyCorrection(correctionIndex, v);
                      }}
                      style={{ textTransform: "uppercase", width: "3rem", marginLeft: "0.5rem" }}
                      autoFocus
                    />
                  </label>
                  <button type="button" onClick={() => setCorrectionIndex(null)} style={{ marginLeft: "0.5rem" }}>
                    Done
                  </button>
                </div>
              )}
              <div className="actions" style={{ marginTop: "1rem" }}>
                <button type="button" onClick={discardVoiceCandidate}>Discard</button>
                <button type="button" className="primary" onClick={useVoiceCandidate}>
                  Use this VIN
                </button>
              </div>
            </div>
          )}
          {ocrScanning && (
            <div className="alert" role="status">Reading VIN from photo…</div>
          )}
          {ocrVin && (
            <div className="card" style={{ marginTop: "0.75rem", padding: "0.75rem 1rem" }}>
              <p style={{ margin: "0 0 0.5rem" }}>
                Found VIN: <strong style={{ fontFamily: "ui-monospace, monospace" }}>{ocrVin}</strong>
              </p>
              <p className="muted" style={{ margin: "0 0 0.5rem" }}>
                Check it matches the photo before continuing.
              </p>
              <div className="actions">
                <button type="button" onClick={() => setOcrVin(null)}>Retake</button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => { setVinInput(ocrVin); setOcrVin(null); }}
                >
                  Use this VIN
                </button>
              </div>
            </div>
          )}
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            Paste, type, dictate, or tap 📷 to scan the 17-character VIN. Vehicle details are decoded automatically.
          </p>
        </form>
      ) : (
        <div>
          <div className="card" style={{ marginBottom: "1rem", padding: "1rem" }}>
            <h3 style={{ margin: "0 0 0.5rem" }}>
              {decoded.year} {decoded.make} {decoded.model}
            </h3>
            <p className="muted" style={{ margin: 0 }}>
              {decoded.trim ? `${decoded.trim} · ` : ""}
              {decoded.bodyClass ? `${decoded.bodyClass} · ` : ""}
              VIN {decoded.vin}
            </p>
            <button
              type="button"
              onClick={() => { setDecoded(null); setVinInput(""); }}
              style={{ marginTop: "0.5rem" }}
            >
              Use a different VIN
            </button>
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <p style={{ margin: "0 0 0.5rem", fontWeight: 600 }}>Which glass is damaged?</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {GLASS_TYPE_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setGlassType(opt.value)}
                  className={glassType === opt.value ? "primary" : ""}
                  aria-pressed={glassType === opt.value}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="actions">
            <button type="button" onClick={onCancel}>Cancel</button>
            <button className="primary" onClick={handleCreate} disabled={saving}>
              {saving ? "Creating Case…" : "Create Case"}
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: "1.5rem", borderTop: "1px solid #e5e7eb", paddingTop: "1rem" }}>
        <button type="button" className="link" onClick={onManual}>
          No VIN? Enter vehicle details manually →
        </button>
      </div>
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
  const [manual, setManual] = useState(false);
  if (manual) {
    return <ManualCaseForm onCancel={onCancel} onCreated={onCreated} onVinFirst={() => setManual(false)} />;
  }
  return <VinFirstCase onCancel={onCancel} onCreated={onCreated} onManual={() => setManual(true)} />;
}

function ManualCaseForm({
  onCancel,
  onCreated,
  onVinFirst
}: {
  onCancel: () => void;
  onCreated: (c: CaseRecord) => Promise<void>;
  onVinFirst: () => void;
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

      <div style={{ marginTop: "1.5rem", borderTop: "1px solid #e5e7eb", paddingTop: "1rem" }}>
        <button type="button" className="link" onClick={onVinFirst}>
          ← Have a VIN? Decode it automatically
        </button>
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

      <IdentificationSummary item={item} events={events} onRefresh={onRefresh} />

      <SourcingSummary item={item} events={events} onRefresh={onRefresh} />

      <PricingSummary item={item} />

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

/** Profit review: R&R sets the profit for low-cost glass (or accepts the
 *  proposed one) or declines the job. */
function ProfitReviewBody({
  item,
  run,
  busy
}: {
  item: CaseRecord;
  run: (action: string, extra?: Record<string, unknown>) => Promise<void>;
  busy: boolean;
}) {
  const [profitDollars, setProfitDollars] = useState("");
  const calc = item.price_calculation;
  if (!calc) return <p>No pricing data available.</p>;

  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const parsed = profitDollars.trim() === "" ? null : Math.round(Number(profitDollars) * 100);
  const profitValid = parsed === null || (Number.isInteger(parsed) && parsed >= 0);

  return (
    <>
      <p>
        The glass cost is below the standard pricing threshold, so the profit
        needs your judgment. The proposed breakdown:
      </p>
      <dl>
        <dt>Glass cost</dt><dd>{fmt(calc.glass_cost_cents)}</dd>
        <dt>Labor</dt><dd>{fmt(calc.labor_cents)}</dd>
        <dt>Proposed profit</dt><dd>{fmt(calc.profit_cents)}</dd>
        <dt>Tax (6.25% of glass)</dt><dd>{fmt(calc.tax_cents)}</dd>
        <dt><strong>Proposed sell price</strong></dt>
        <dd><strong>{fmt(calc.sell_price_cents)}</strong></dd>
      </dl>
      <label>
        Adjusted profit ($, optional):
        <input
          type="number"
          min="0"
          step="0.01"
          value={profitDollars}
          onChange={e => setProfitDollars(e.target.value)}
          placeholder={fmt(calc.profit_cents)}
        />
      </label>
      {!profitValid && <div className="alert">Profit must be a non-negative dollar amount.</div>}
      <div className="workspace-actions">
        <button
          className="primary"
          disabled={busy || !profitValid}
          onClick={() => run("approve_price", parsed === null ? {} : { profit_cents: parsed })}
        >
          {busy ? "Approving…" : "Approve price"}
        </button>
        <button disabled={busy} onClick={() => run("reject_price")}>
          Decline job
        </button>
      </div>
    </>
  );
}

/** The staff workspace for the current workflow step. Phase 2 fills the
 *  glass-identification steps; Phase 3 fills sourcing/pricing; other steps
 *  show the standby message until their business contracts land. */
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
    case "NO_ELIGIBLE_INVENTORY":
      body = (
        <>
          <p>
            No supplier had eligible stock for the identified part. Regional
            suppliers are excluded from automatic quoting.
          </p>
          <div className="workspace-actions">
            <button className="primary" disabled={busy} onClick={() => run("retry_sourcing")}>
              {busy ? "Retrying…" : "Retry sourcing"}
            </button>
          </div>
        </>
      );
      break;
    case "PROFIT_REVIEW_REQUIRED":
      body = <ProfitReviewBody item={item} run={run} busy={busy} />;
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

function IdentificationSummary({ item, events, onRefresh }: {
  item: CaseRecord;
  events: CaseEvent[];
  onRefresh: () => Promise<void>;
}) {
  const ident = item.glass_identification;
  const [overriding, setOverriding] = useState(false);
  const [partNumber, setPartNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!ident) return null;
  const selected = ident.selected_candidate;
  const candidates = ident.candidates;
  const overrideEvents = events.filter(e => e.event_type === "GLASS_CANDIDATE_OVERRIDDEN");
  const lastOverride = overrideEvents[overrideEvents.length - 1];

  async function submitOverride() {
    if (!partNumber) return;
    setBusy(true);
    setError(null);
    try {
      await performAction(item.id, "override_glass_candidate", { part_number: partNumber });
      setOverriding(false);
      setPartNumber("");
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Override failed.");
    } finally {
      setBusy(false);
    }
  }

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
      {lastOverride && (
        <p className="override-note">
          Staff override: system selected <code>{String(lastOverride.payload.old_part_number)}</code>,
          {" "}staff chose <code>{String(lastOverride.payload.new_part_number)}</code>{" "}
          ({new Date(lastOverride.occurred_at).toLocaleString()})
        </p>
      )}
      {!selected && candidates.length > 0 && (
        <>
          <h3>Candidates ({candidates.length})</h3>
          <ul className="candidate-list">
            {candidates.map(c => (
              <li key={c.part_number}>
                <code>{c.part_number}</code> — {c.description}
              </li>
            ))}
          </ul>
        </>
      )}
      {selected && candidates.length > 1 && !overriding && (
        <button className="secondary" onClick={() => { setOverriding(true); setPartNumber(""); }}>
          Override part…
        </button>
      )}
      {overriding && (
        <div className="override-form">
          <label>
            Replacement part
            <select value={partNumber} onChange={e => setPartNumber(e.target.value)}>
              <option value="">Choose a candidate…</option>
              {candidates
                .filter(c => c.part_number !== selected?.part_number)
                .map(c => (
                  <option key={c.part_number} value={c.part_number}>
                    {c.part_number} — {c.description}
                  </option>
                ))}
            </select>
          </label>
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button className="primary" disabled={busy || !partNumber} onClick={submitOverride}>
              {busy ? "Applying…" : "Apply override"}
            </button>
            <button className="secondary" disabled={busy} onClick={() => setOverriding(false)}>
              Cancel
            </button>
          </div>
          <small>Re-runs supplier sourcing and pricing for the new part.</small>
        </div>
      )}
    </section>
  );
}

function SourcingSummary({ item, events, onRefresh }: {
  item: CaseRecord;
  events: CaseEvent[];
  onRefresh: () => Promise<void>;
}) {
  const offers = item.supplier_offers ?? [];
  const [overriding, setOverriding] = useState(false);
  const [offerId, setOfferId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (offers.length === 0) return null;
  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const selected = offers.find(o => o.selected);
  const eligible = offers.filter(o => !o.selected && !o.excluded_reason);
  const overrideEvents = events.filter(e => e.event_type === "SUPPLIER_OFFER_OVERRIDDEN");
  const lastOverride = overrideEvents[overrideEvents.length - 1];

  async function submitOverride() {
    if (!offerId) return;
    setBusy(true);
    setError(null);
    try {
      await performAction(item.id, "override_supplier_offer", { offer_id: offerId });
      setOverriding(false);
      setOfferId("");
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Override failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ marginBottom: 18 }}>
      <h2>Supplier sourcing</h2>
      {selected && (
        <p>
          Selected: <strong>{selected.supplier_name}</strong> —{" "}
          <code>{selected.part_number}</code> at {fmt(selected.price_cents)}
          {selected.lead_time_days !== null && ` (${selected.lead_time_days}d lead)`}
        </p>
      )}
      {lastOverride && (
        <p className="override-note">
          Staff override: system selected <strong>{String(lastOverride.payload.old_supplier_name)}</strong>,
          {" "}staff chose <strong>{String(lastOverride.payload.new_supplier_name)}</strong>{" "}
          ({new Date(lastOverride.occurred_at).toLocaleString()})
        </p>
      )}
      <h3>Offers ({offers.length})</h3>
      <ul className="candidate-list">
        {offers.map(o => (
          <li key={o.id}>
            <strong>{o.supplier_name}</strong>{" "}
            <small>({o.supplier_type})</small> — {fmt(o.price_cents)}
            {o.available ? ` · ${o.quantity} in stock` : " · unavailable"}
            {o.selected && " ✓ selected"}
            {o.excluded_reason && (
              <div><small>Excluded: {o.excluded_reason}</small></div>
            )}
          </li>
        ))}
      </ul>
      {eligible.length > 0 && !overriding && (
        <button className="secondary" onClick={() => { setOverriding(true); setOfferId(""); }}>
          Override supplier…
        </button>
      )}
      {overriding && (
        <div className="override-form">
          <label>
            Replacement supplier
            <select value={offerId} onChange={e => setOfferId(e.target.value)}>
              <option value="">Choose an eligible offer…</option>
              {eligible.map(o => (
                <option key={o.id} value={o.id}>
                  {o.supplier_name} — {fmt(o.price_cents)}{o.lead_time_days !== null ? ` (${o.lead_time_days}d lead)` : ""}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button className="primary" disabled={busy || !offerId} onClick={submitOverride}>
              {busy ? "Applying…" : "Apply override"}
            </button>
            <button className="secondary" disabled={busy} onClick={() => setOverriding(false)}>
              Cancel
            </button>
          </div>
          <small>Re-runs pricing for the new supplier. Excluded offers can't be chosen.</small>
        </div>
      )}
    </section>
  );
}

function PricingSummary({ item }: { item: CaseRecord }) {
  const calc = item.price_calculation;
  if (!calc) return null;
  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  return (
    <section className="card" style={{ marginBottom: 18 }}>
      <h2>Pricing</h2>
      <dl>
        <dt>Glass cost</dt><dd>{fmt(calc.glass_cost_cents)}</dd>
        <dt>Labor</dt><dd>{fmt(calc.labor_cents)}</dd>
        <dt>Profit</dt><dd>{fmt(calc.profit_cents)}</dd>
        <dt>Tax (6.25% of glass)</dt><dd>{fmt(calc.tax_cents)}</dd>
        <dt><strong>Sell price</strong></dt>
        <dd><strong>{fmt(calc.sell_price_cents)}</strong></dd>
        <dt>Status</dt><dd>{humanize(calc.status)}</dd>
      </dl>
      <small>Supplier costs and margins are staff-only; never shown to customers.</small>
    </section>
  );
}
