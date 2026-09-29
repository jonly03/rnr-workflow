import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createCase,
  decodeVin,
  getCase,
  getCaseEvents,
  getHealth,
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

type Screen = "queue" | "new" | "detail";

const humanize = (value: string) =>
  value.toLowerCase().replaceAll("_", " ").replace(/(^|\s)\S/g, c => c.toUpperCase());

const formatCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const vehicleName = (c: CaseRecord) => `${c.vehicle.year} ${c.vehicle.make} ${c.vehicle.model}`;

/** Sort key for "Vehicle A–Z": make, model, then year. */
const vehicleSortKey = (c: CaseRecord) =>
  `${c.vehicle.make} ${c.vehicle.model} ${c.vehicle.year}`.toLowerCase();

type QueueSort = "newest" | "price-desc" | "price-asc" | "vehicle";

const QUEUE_SORTS: { id: QueueSort; label: string }[] = [
  { id: "newest", label: "Newest first" },
  { id: "price-desc", label: "Sell price: high to low" },
  { id: "price-asc", label: "Sell price: low to high" },
  { id: "vehicle", label: "Vehicle A–Z" }
];

export interface QueueFilters {
  search: string;
  channel: "ALL" | Channel;
  glass: "ALL" | GlassType;
  status: string;
}

/** Filter queue cases by search text, channel, glass type, and status. Exported for tests. */
export function filterQueueCases(cases: CaseRecord[], filters: QueueFilters): CaseRecord[] {
  const q = filters.search.trim().toLowerCase();
  return cases.filter(c => {
    if (filters.channel !== "ALL" && c.channel !== filters.channel) return false;
    if (filters.glass !== "ALL" && c.glass_request.glass_type !== filters.glass) return false;
    if (filters.status !== "ALL" && c.current_state !== filters.status) return false;
    if (q) {
      const haystack = `${c.reference} ${c.vehicle.vin} ${vehicleName(c)}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

/** Sort queue cases. Unpriced cases sink to the bottom for price sorts. Exported for tests. */
export function sortQueueCases(cases: CaseRecord[], sortBy: QueueSort): CaseRecord[] {
  const sorted = [...cases];
  switch (sortBy) {
    case "price-desc":
      sorted.sort(
        (a, b) =>
          (b.price_calculation?.sell_price_cents ?? -1) -
          (a.price_calculation?.sell_price_cents ?? -1)
      );
      break;
    case "price-asc":
      sorted.sort(
        (a, b) =>
          (a.price_calculation?.sell_price_cents ?? Number.MAX_SAFE_INTEGER) -
          (b.price_calculation?.sell_price_cents ?? Number.MAX_SAFE_INTEGER)
      );
      break;
    case "vehicle":
      sorted.sort((a, b) => vehicleSortKey(a).localeCompare(vehicleSortKey(b)));
      break;
    default:
      sorted.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
  }
  return sorted;
}

const CHANNEL_OPTIONS: { id: "ALL" | Channel; label: string }[] = [
  { id: "ALL", label: "All" },
  { id: "DIRECT", label: "Direct" },
  { id: "AUCTION", label: "Auction" },
  { id: "INSURANCE", label: "Insurance" }
];

const GLASS_OPTIONS: { id: "ALL" | GlassType; label: string }[] = [
  { id: "ALL", label: "All" },
  { id: "WINDSHIELD", label: "Windshield" },
  { id: "BACK_GLASS", label: "Back Glass" },
  { id: "DOOR_GLASS", label: "Door Glass" },
  { id: "QUARTER_GLASS", label: "Quarter Glass" },
  { id: "VENT_GLASS", label: "Vent Glass" }
];

export function FilterPills<T extends string>({
  label,
  options,
  value,
  onChange
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="filter-group" role="group" aria-label={label}>
      <span className="filter-label">{label}</span>
      <div className="pills">
        {options.map(o => (
          <button
            key={o.id}
            type="button"
            className={"pill" + (value === o.id ? " active" : "")}
            aria-pressed={value === o.id}
            onClick={() => onChange(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function App() {
  const [staff, setStaff] = useState<StaffUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [screen, setScreen] = useState<Screen>("queue");
  const [newCaseOrigin, setNewCaseOrigin] = useState<
    { screen: "queue" } | { screen: "detail"; caseId: string; reference: string }
  >({ screen: "queue" });
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [selected, setSelected] = useState<CaseRecord | null>(null);
  const [events, setEvents] = useState<CaseEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  // Case Queue toolbar: search, pill filters, and sorting.
  const [search, setSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState<"ALL" | Channel>("ALL");
  const [glassFilter, setGlassFilter] = useState<"ALL" | GlassType>("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [sortBy, setSortBy] = useState<QueueSort>("newest");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [caseEvents, setCaseEvents] = useState<Record<string, CaseEvent[]>>({});

  /** Refresh one expanded card's detail + events without flashing the queue loader. */
  const refreshExpandedCase = async (id: string) => {
    try {
      const [detail, activity] = await Promise.all([getCase(id), getCaseEvents(id)]);
      setCases(prev => prev.map(x => (x.id === id ? detail : x)));
      setCaseEvents(prev => ({ ...prev, [id]: activity }));
    } catch (error) {
      loadError(error);
    }
  };

  const toggleExpanded = (id: string) => {
    const willExpand = !expandedIds.has(id);
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Pull fresh detail + events so the editable part card always acts on current data.
    if (willExpand) void refreshExpandedCase(id);
  };

  const statusOptions = useMemo(
    () => [...new Set(cases.map(c => c.current_state))].sort(),
    [cases]
  );

  const visibleCases = useMemo(
    () =>
      sortQueueCases(
        filterQueueCases(cases, {
          search,
          channel: channelFilter,
          glass: glassFilter,
          status: statusFilter
        }),
        sortBy
      ),
    [cases, search, channelFilter, glassFilter, statusFilter, sortBy]
  );

  /** Bulk expand/collapse of whatever the queue is currently showing (respects filters). */
  const allVisibleExpanded =
    visibleCases.length > 0 && visibleCases.every(c => expandedIds.has(c.id));
  const toggleExpandAll = () => {
    const ids = visibleCases.map(c => c.id);
    if (allVisibleExpanded) {
      setExpandedIds(prev => {
        const next = new Set(prev);
        ids.forEach(id => next.delete(id));
        return next;
      });
    } else {
      setExpandedIds(prev => {
        const next = new Set(prev);
        ids.forEach(id => next.add(id));
        return next;
      });
      // Same freshness guarantee as expanding one card at a time.
      visibleCases.forEach(c => { void refreshExpandedCase(c.id); });
    }
  };

  const filtersActive =
    search.trim() !== "" ||
    channelFilter !== "ALL" ||
    glassFilter !== "ALL" ||
    statusFilter !== "ALL";

  const clearFilters = () => {
    setSearch("");
    setChannelFilter("ALL");
    setGlassFilter("ALL");
    setStatusFilter("ALL");
  };

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
      <Shell
        staff={staff}
        onSignOut={signOut}
        crumbs={[
          { label: "Case queue", onClick: () => setScreen("queue") },
          ...(newCaseOrigin.screen === "detail"
            ? [{
                label: newCaseOrigin.reference,
                onClick: () => { void openCase(newCaseOrigin.caseId); }
              }]
            : []),
          { label: "New case" }
        ]}
      >
        <NewCase
          onCancel={() => {
            if (newCaseOrigin.screen === "detail") void openCase(newCaseOrigin.caseId);
            else setScreen("queue");
          }}
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
      <Shell
        staff={staff}
        onSignOut={signOut}
        crumbs={[
          { label: "Case queue", onClick: () => setScreen("queue") },
          { label: selected.reference }
        ]}
      >
        <CaseDetail
          item={selected}
          events={events}
          onRefresh={() => openCase(selected.id)}
          onNewCase={() => {
            setNewCaseOrigin({ screen: "detail", caseId: selected.id, reference: selected.reference });
            setScreen("new");
          }}
          loading={loading}
          staffEmail={staff.email}
        />
      </Shell>
    );
  }

  return (
    <Shell staff={staff} onSignOut={signOut} crumbs={[{ label: "Case queue" }]}>
      <section className="page-head">
        <div>
          <p className="eyebrow">R&R Operations</p>
          <h1>Case Queue</h1>
          <p className="muted">One operational truth across Direct, Auction, and Insurance.</p>
        </div>
      </section>

      {message && <div className="alert">{message}</div>}
      {loading ? (
        <div className="card">Loading cases…</div>
      ) : (
        <div className="queue-layout">
          <aside className="queue-sidebar" aria-label="Case filters">
            <button type="button" className="primary sidebar-new" onClick={() => { setNewCaseOrigin({ screen: "queue" }); setScreen("new"); }}>+ New Case</button>
            <div className="queue-toolbar">
              <div className="toolbar-section">
                <input
                  className="queue-search"
                  type="search"
                  placeholder="Search reference, VIN, vehicle…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  aria-label="Search cases"
                />
                <div className="filter-group">
                  <label className="filter-label" htmlFor="queue-sort">Sort</label>
                  <select
                    id="queue-sort"
                    value={sortBy}
                    onChange={e => setSortBy(e.target.value as QueueSort)}
                  >
                    {QUEUE_SORTS.map(s => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </select>
                </div>
                <div className="toolbar-selects" aria-label="Case filters">
                  <label>
                    <span className="filter-label">Channel</span>
                    <select
                      value={channelFilter}
                      onChange={e => setChannelFilter(e.target.value as "ALL" | Channel)}
                      aria-label="Channel filter"
                    >
                      {CHANNEL_OPTIONS.map(o => (
                        <option key={o.id} value={o.id}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="filter-label">Glass</span>
                    <select
                      value={glassFilter}
                      onChange={e => setGlassFilter(e.target.value as "ALL" | GlassType)}
                      aria-label="Glass filter"
                    >
                      {GLASS_OPTIONS.map(o => (
                        <option key={o.id} value={o.id}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="filter-label">Status</span>
                    <select
                      value={statusFilter}
                      onChange={e => setStatusFilter(e.target.value)}
                      aria-label="Status filter"
                    >
                      <option value="ALL">All</option>
                      {statusOptions.map(s => (
                        <option key={s} value={s}>{humanize(s)}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
              <div className="toolbar-section toolbar-pills">
                <FilterPills
                  label="Channel"
                  options={CHANNEL_OPTIONS}
                  value={channelFilter}
                  onChange={setChannelFilter}
                />
                <FilterPills
                  label="Glass"
                  options={GLASS_OPTIONS}
                  value={glassFilter}
                  onChange={setGlassFilter}
                />
                <FilterPills
                  label="Status"
                  options={[
                    { id: "ALL", label: "All" },
                    ...statusOptions.map(s => ({ id: s, label: humanize(s) }))
                  ]}
                  value={statusFilter}
                  onChange={setStatusFilter}
                />
              </div>
            </div>
          </aside>
          <div className="queue-main">
            {cases.length === 0 ? (
              <div className="empty card">
                <h2>No cases yet.</h2>
                <p>Create the first case to start the operational record.</p>
                <button className="primary" onClick={() => setScreen("new")}>Create first case</button>
              </div>
            ) : (
              <>
            <div className="queue-list-head">
              {visibleCases.length > 0 && (
                <div className="queue-bulk">
                  <button type="button" className="link" onClick={toggleExpandAll}>
                    {allVisibleExpanded ? "Collapse all" : "Expand all"}
                  </button>
                </div>
              )}
              <p className="muted queue-count">
              {visibleCases.length} of {cases.length} {cases.length === 1 ? "case" : "cases"}
              {filtersActive && (
                <> — <button type="button" className="link" onClick={clearFilters}>Clear filters</button></>
              )}
            </p>
            </div>
            {visibleCases.length === 0 ? (
              <div className="empty card">
                <h2>No cases match.</h2>
                <p>Try a different search or clear the filters.</p>
                <button className="primary" onClick={clearFilters}>Clear filters</button>
              </div>
            ) : (
              <div className="case-list">
                {visibleCases.map(c => {
                  const expanded = expandedIds.has(c.id);
                  return (
                    <article className={"case-card" + (expanded ? " expanded" : "")} key={c.id}>
                      <div className="case-card-head">
                        <div>
                          <strong>{c.reference}</strong>
                          <span className="channel">{c.channel}</span>
                        </div>
                        <div className="vehicle">{vehicleName(c)}</div>
                        <div>{humanize(c.glass_request.glass_type)}</div>
                        <div className="sell-price">
                          {c.price_calculation ? (
                            <strong>{formatCents(c.price_calculation.sell_price_cents)}</strong>
                          ) : (
                            <span className="muted">Not priced</span>
                          )}
                        </div>
                        <div>
                          <small>{c.current_state}</small>
                        </div>
                        <div className="case-card-actions">
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label={expanded ? `Collapse ${c.reference}` : `Expand ${c.reference}`}
                            aria-expanded={expanded}
                            onClick={() => toggleExpanded(c.id)}
                          >
                            {expanded ? "«" : "»"}
                          </button>
                          {expanded && (
                            <button onClick={() => void openCase(c.id)}>Open</button>
                          )}
                        </div>
                      </div>
                      {expanded && (
                        <div className="case-card-body">
                          <PricingSummary item={c} />
                          <SourcingSummary
                            item={c}
                            events={caseEvents[c.id] ?? []}
                            onRefresh={() => refreshExpandedCase(c.id)}
                          />
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
              </>
            )}
          </div>
        </div>
      )}
    </Shell>
  );
}

export interface Crumb {
  label: string;
  onClick?: () => void;
}

function Shell({
  children,
  staff,
  onSignOut,
  crumbs = []
}: {
  children: React.ReactNode;
  staff: StaffUser | null;
  onSignOut: () => void;
  crumbs?: Crumb[];
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [catalog, setCatalog] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = () => setMenuOpen(false);
  const handleSignOut = () => {
    closeMenu();
    onSignOut();
  };
  // Live-mode indicator: which glass catalog the API is sourcing from.
  // "mygrant-web" = live MyGrant ($1 per VIN lookup); anything else = mock.
  useEffect(() => {
    let cancelled = false;
    getHealth().then(health => {
      if (!cancelled && health) setCatalog(health.glass_catalog);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-wrap">
          <div className="brand">R&R</div>
          <span className="brand-title">Case Operations</span>
          {catalog && (
            <span
              className={`catalog-badge ${catalog === "mygrant-web" ? "live" : "mock"}`}
              title={
                catalog === "mygrant-web"
                  ? "Live MyGrant sourcing: each VIN lookup costs $1"
                  : "Mock catalog: no live sourcing, no charges"
              }
            >
              {catalog === "mygrant-web" ? "LIVE · MyGrant" : "Mock catalog"}
            </span>
          )}
        </div>
        {crumbs.length > 0 && (
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={i} className="crumb">
                {i > 0 && <span className="crumb-sep" aria-hidden="true">/</span>}
                {c.onClick ? (
                  <button type="button" className="link" onClick={c.onClick}>{c.label}</button>
                ) : (
                  <span aria-current="page">{c.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        {staff && (
          <div className="topbar-right">
            <span className="staff-line">
              {staff.name} · {staff.email}
              <button className="link" onClick={onSignOut}>Sign out</button>
            </span>
            <div className="menu-wrap" ref={menuRef}>
              <button
                type="button"
                className="menu-btn"
                aria-label="Account menu"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(o => !o)}
              >
                ☰
              </button>
              {menuOpen && (
                <div className="user-menu" role="menu">
                  <p className="user-menu-id">
                    <strong>{staff.name}</strong>
                    <span className="muted">{staff.email}</span>
                  </p>
                  <button type="button" className="link" role="menuitem" onClick={handleSignOut}>
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
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

  // Photo OCR state: a VIN read from an uploaded photo, awaiting confirmation.
  const [ocrScanning, setOcrScanning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrVin, setOcrVin] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scanTimerRef = useRef<number | null>(null);

  // Simulated scan progress: eases toward 90% while the request is in
  // flight, then snaps to 100% when it resolves. The OCR engine doesn't
  // report real progress, so this reflects elapsed time, not engine state.
  const startScanProgress = () => {
    setOcrProgress(0);
    const startedAt = Date.now();
    scanTimerRef.current = window.setInterval(() => {
      setOcrProgress(scanProgressForElapsed((Date.now() - startedAt) / 1000));
    }, 200);
  };

  const stopScanProgress = () => {
    if (scanTimerRef.current !== null) {
      window.clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
  };

  const handlePhotoSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    setOcrVin(null);
    setOcrScanning(true);
    startScanProgress();
    try {
      const result = await ocrVinPhoto(file);
      setOcrProgress(100);
      setOcrVin(result.vin);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read VIN from photo.");
    } finally {
      stopScanProgress();
      setOcrScanning(false);
      // Let the bar settle at 100% (or freeze on error) before hiding it.
      window.setTimeout(() => setOcrProgress(0), 800);
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
          <div className="vin-input-methods">
            <button
              type="button"
              className="input-method"
              onClick={() => fileInputRef.current?.click()}
              disabled={ocrScanning}
              title="Upload a photo of the VIN"
              aria-label="Upload a photo of the VIN"
            >
              <span className="input-method-icon" aria-hidden="true">
                {ocrScanning ? "…" : "📷"}
              </span>
              <span>{ocrScanning ? `Scanning ${ocrProgress}%` : "Scan"}</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={handlePhotoSelected}
            />
          </div>
          <input
            id="vin-input"
            value={vinInput}
            onChange={e => setVinInput(e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/gi, ""))}
            placeholder="17-character VIN"
            maxLength={17}
            style={{ textTransform: "uppercase", width: "100%" }}
            autoFocus
          />
          <button className="primary vin-decode-btn" type="submit" disabled={decoding || vinInput.trim().length !== 17}>
            {decoding ? "Decoding…" : "Decode VIN"}
          </button>
          {ocrScanning && (
            <div className="alert scan-progress" role="status" aria-live="polite">
              <div className="scan-progress-fill" style={{ width: `${ocrProgress}%` }} />
              <span className="scan-progress-text">
                Reading VIN from photo… Scanning {ocrProgress}%
              </span>
            </div>
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
            Type, paste, or tap 📷 to scan the 17-character VIN. Vehicle details are decoded automatically.
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

/** Case detail cards, reorderable by staff. The order is remembered per
 *  staff member in localStorage so each person sees their preferred layout.
 *  The "Staff action required" alert is separate: it pins itself above the
 *  cards only while the case waits on staff, then disappears. */
export const CASE_CARDS = ["vehicle", "pricing", "sourcing", "activity"] as const;
export type CaseCardId = (typeof CASE_CARDS)[number];
export const DEFAULT_CARD_ORDER: CaseCardId[] = ["vehicle", "pricing", "sourcing", "activity"];

/** Case states where the workflow is blocked waiting on a person. */
const STAFF_ACTION_STATES = [
  "VIN_LOOKUP_REQUIRED",
  "HUMAN_GLASS_REVIEW_REQUIRED",
  "GLASS_NOT_IDENTIFIED",
  "NO_ELIGIBLE_INVENTORY",
  "PROFIT_REVIEW_REQUIRED"
] as const;

/** True when the case needs staff — the warning alert shows only then. */
export function isStaffActionRequired(state: string): boolean {
  return (STAFF_ACTION_STATES as readonly string[]).includes(state);
}

export function cardOrderKey(staffEmail: string) {
  return `rnr:card-order:${staffEmail}`;
}

/** Simulated VIN-scan progress for elapsed seconds: eases toward 90%.
 * The OCR engine doesn't report real progress, so the bar reflects
 * elapsed time and snaps to 100% when the request resolves. */
export function scanProgressForElapsed(elapsedSec: number): number {
  return Math.min(90, Math.round(90 * (1 - Math.exp(-elapsedSec / 8))));
}

export function loadCardOrder(staffEmail: string): CaseCardId[] {
  try {
    const raw = localStorage.getItem(cardOrderKey(staffEmail));
    if (raw) {
      const saved = JSON.parse(raw) as string[];
      const isCard = (id: string): id is CaseCardId =>
        (CASE_CARDS as readonly string[]).includes(id);
      const valid = saved.filter(isCard);
      // Append any new cards staff hasn't positioned yet, drop unknown ids.
      const missing = DEFAULT_CARD_ORDER.filter(id => !valid.includes(id));
      if (valid.length > 0) return [...valid, ...missing];
    }
  } catch {
    /* corrupted storage -> fall through to default */
  }
  return [...DEFAULT_CARD_ORDER];
}

function useCardOrder(staffEmail: string) {
  const [order, setOrder] = useState<CaseCardId[]>(() => loadCardOrder(staffEmail));
  const save = useCallback((next: CaseCardId[]) => {
    setOrder(next);
    try {
      localStorage.setItem(cardOrderKey(staffEmail), JSON.stringify(next));
    } catch {
      /* storage unavailable -> order still applies for this session */
    }
  }, [staffEmail]);
  return [order, save] as const;
}

/** Single-column list of case cards with pointer-based drag handles.
 *  Works with mouse and touch (touch-action: none on the handle). */
function SortableCardList({
  order,
  onReorder,
  renderCard
}: {
  order: CaseCardId[];
  onReorder: (next: CaseCardId[]) => void;
  renderCard: (id: CaseCardId) => React.ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: CaseCardId; pointerId: number } | null>(null);
  const [draggingId, setDraggingId] = useState<CaseCardId | null>(null);

  const indexFromY = (y: number): number => {
    const el = listRef.current;
    if (!el) return 0;
    const cards = Array.from(el.querySelectorAll<HTMLElement>("[data-card-id]"));
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return cards.length;
  };

  const beginDrag = (id: CaseCardId) => (e: React.PointerEvent<HTMLElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id, pointerId: e.pointerId };
    setDraggingId(id);
    e.preventDefault();
  };

  const moveDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const from = order.indexOf(d.id);
    if (from === -1) return;
    let to = indexFromY(e.clientY);
    if (to > from) to -= 1; // the dragged card still occupies its slot
    if (to < 0 || to === from) return;
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, d.id);
    onReorder(next);
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    setDraggingId(null);
  };

  return (
    <div
      ref={listRef}
      className="sortable-cards"
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {order.map(id => (
        <div
          key={id}
          data-card-id={id}
          className={"sortable-card" + (draggingId === id ? " is-dragging" : "")}
        >
          <span
            className="drag-handle"
            role="button"
            tabIndex={0}
            aria-label="Drag to reorder this card"
            onPointerDown={beginDrag(id)}
            onClick={e => e.preventDefault()}
          >
            ⠿
          </span>
          {renderCard(id)}
        </div>
      ))}
    </div>
  );
}

function CaseDetail({
  item,
  events,
  onRefresh,
  onNewCase,
  loading,
  staffEmail
}: {
  item: CaseRecord;
  events: CaseEvent[];
  onRefresh: () => Promise<void>;
  onNewCase: () => void;
  loading: boolean;
  staffEmail: string;
}) {
  const [order, setOrder] = useCardOrder(staffEmail);

  const renderCard = (id: CaseCardId) => {
    switch (id) {
      case "vehicle":
        return (
          <section className="card">
            <h2>Vehicle / Service</h2>
            <dl>
              <dt>Vehicle</dt><dd>{item.vehicle.year} {item.vehicle.make} {item.vehicle.model}</dd>
              <dt>VIN</dt><dd><code>{item.vehicle.vin}</code></dd>
              <dt>Glass type</dt><dd>{humanize(item.glass_request.glass_type)}</dd>
              <dt>Created</dt><dd>{new Date(item.created_at).toLocaleString()}</dd>
            </dl>
          </section>
        );
      case "pricing":
        return <PricingSummary item={item} />;
      case "sourcing":
        return <SourcingSummary item={item} events={events} onRefresh={onRefresh} />;
      case "activity":
        return <ActivityTimeline events={events} loading={loading} />;
    }
  };

  return (
    <>
      <section className="page-head">
        <div>
          <p className="eyebrow" data-testid="case-channel">{item.channel}</p>
          <h1>{item.reference}</h1>
          <div className="state-line">
            <code>{item.current_state}</code>
          </div>
        </div>
        <button className="primary" onClick={onNewCase}>+ New Case</button>
      </section>

      {isStaffActionRequired(item.current_state) && (
        <StaffActionAlert item={item} onRefresh={onRefresh} />
      )}
      <SortableCardList order={order} onReorder={setOrder} renderCard={renderCard} />
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
/** Body of the staff-action alert. Rendered only while the case waits on
 *  staff; once the action is taken the case moves on and the alert goes away. */
function StaffActionBody({
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
      body = null;
  }

  if (!body) return null;
  return (
    <>
      {error && <div className="alert">{error}</div>}
      {body}
    </>
  );
}

/** Warning alert pinned above the detail cards while staff action is needed. */
function StaffActionAlert({
  item,
  onRefresh
}: {
  item: CaseRecord;
  onRefresh: () => Promise<void>;
}) {
  return (
    <section className="card alert-card" role="alert" aria-label="Staff action required">
      <h2><span aria-hidden="true">⚠</span> Staff action required</h2>
      <StaffActionBody item={item} onRefresh={onRefresh} />
    </section>
  );
}

function eventText(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
}

function eventMoney(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "number" ? `$${(v / 100).toFixed(2)}` : undefined;
}

/** Plain-English summary of one workflow event — the auditor/staff trail. */
export function describeEvent(e: CaseEvent): string {
  const p = e.payload ?? {};
  const plural = (n: string | undefined, one: string, many: string) =>
    n ? `${n} ${n === "1" ? one : many}` : undefined;
  switch (e.event_type) {
    case "CASE_CREATED": {
      const channel = eventText(p, "channel");
      return channel ? `Case opened in the ${humanize(channel)} channel.` : "Case opened.";
    }
    case "START_VIN_LOOKUP":
      return "VIN lookup started to pin down the exact glass part.";
    case "VIN_RESULT_RETURNED": {
      const n = plural(eventText(p, "candidate_count"), "candidate", "candidates");
      const charged = p.charged === true ? " (charged)" : p.charged === false ? " (no charge)" : "";
      return `VIN decoded${n ? ` — ${n}` : ""}${charged}.`;
    }
    case "USE_SAVED_VIN_RESULT":
      return "Reused a saved VIN result — no new lookup charge.";
    case "VIN_LOOKUP_FAILED": {
      const err = eventText(p, "error");
      return `VIN lookup failed${err ? `: ${err}` : "."}`;
    }
    case "VIN_NEEDED":
      return "A VIN is needed before identification can continue.";
    case "YMM_RESULTS_RETURNED": {
      const n = plural(eventText(p, "candidate_count"), "candidate part", "candidate parts");
      return n ? `Catalog search returned ${n}.` : "Catalog search completed.";
    }
    case "YMM_SEARCH_FAILED":
      return "Catalog search failed.";
    case "EVALUATE_GLASS_MATCHES":
      return "Evaluating catalog matches against the vehicle.";
    case "GLASS_RESOLVED": {
      const part = eventText(p, "part_number");
      const method = eventText(p, "method");
      const n = plural(eventText(p, "candidate_count"), "candidate", "candidates");
      if (part)
        return `Glass identified${method ? ` by ${method === "VIN" ? "VIN decode" : "catalog search"}` : ""}: ${part}.`;
      if (n) return `Glass narrowed to ${n}.`;
      return "Glass identification resolved.";
    }
    case "NO_VALID_GLASS":
      return "No valid glass found for this vehicle.";
    case "HUMAN_REVIEW_NEEDED":
      return "The catalog returned several candidates — staff need to pick the right part.";
    case "HUMAN_GLASS_SELECTED": {
      const part = eventText(p, "part_number");
      return part ? `Staff picked part ${part}.` : "Staff picked the glass part.";
    }
    case "HUMAN_CANNOT_IDENTIFY":
      return "Staff marked the glass as unidentifiable from the data available.";
    case "GLASS_CANDIDATE_OVERRIDDEN": {
      const oldP = eventText(p, "old_part_number");
      const newP = eventText(p, "new_part_number");
      return oldP && newP
        ? `Staff changed the part from ${oldP} to ${newP}.`
        : "Staff overrode the selected part.";
    }
    case "START_SOURCING":
      return "Requesting supplier offers for the identified part.";
    case "EVALUATE_OFFERS":
      return "Evaluating supplier offers.";
    case "SUPPLIER_OFFERS_RETURNED": {
      const n = plural(eventText(p, "offer_count"), "supplier offer", "supplier offers");
      return n ? `${n} received.` : "Supplier offers received.";
    }
    case "ELIGIBLE_OFFER_SELECTED": {
      const name = eventText(p, "supplier_name");
      const price = eventMoney(p, "price_cents");
      const part = eventText(p, "part_number");
      return name && price
        ? `Selected ${name} at ${price}${part ? ` for part ${part}` : ""}.`
        : "A supplier offer was selected.";
    }
    case "NO_ELIGIBLE_OFFERS": {
      const reason = eventText(p, "reason");
      return reason ? `No eligible supplier offers — ${reason}` : "No supplier had eligible stock.";
    }
    case "SOURCING_FAILED": {
      const err = eventText(p, "error") ?? eventText(p, "reason");
      return `Supplier sourcing failed${err ? `: ${err}` : "."}`;
    }
    case "SUPPLIER_OFFER_OVERRIDDEN": {
      const oldS = eventText(p, "old_supplier_name");
      const newS = eventText(p, "new_supplier_name");
      const price = eventMoney(p, "new_price_cents");
      return oldS && newS
        ? `Staff switched supplier from ${oldS} to ${newS}${price ? ` at ${price}` : ""}.`
        : "Staff overrode the supplier choice.";
    }
    case "START_PRICING":
      return "Calculating the price from glass cost, labor, profit and tax.";
    case "STANDARD_PRICE_CALCULATED": {
      const price = eventMoney(p, "sell_price_cents");
      return price ? `Price calculated — sell price ${price}.` : "Price calculated.";
    }
    case "PRICE_APPROVED_BY_RNR": {
      const price = eventMoney(p, "sell_price_cents");
      return price ? `R&R approved the price at ${price}.` : "R&R approved the price.";
    }
    case "PRICE_REJECTED_BY_RNR": {
      const reason = eventText(p, "reason");
      return `R&R declined the price${reason ? `: ${reason}` : "."}`;
    }
    default:
      return `${humanize(e.event_type)}.`;
  }
}

/** Expandable plain-English trail of everything that happened on the case. */
function ActivityTimeline({ events, loading }: { events: CaseEvent[]; loading: boolean }) {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpenIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <section className="card timeline">
      <h2>Activity</h2>
      {loading ? (
        <p>Loading activity…</p>
      ) : events.length === 0 ? (
        <p>No activity recorded yet.</p>
      ) : (
        <ol className="timeline-list">
          {events.map(e => {
            const open = openIds.has(e.id);
            return (
              <li key={e.id} className="timeline-item">
                <button
                  type="button"
                  className="timeline-toggle"
                  aria-expanded={open}
                  onClick={() => toggle(e.id)}
                >
                  <span className="timeline-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
                  <span className="timeline-summary">{describeEvent(e)}</span>
                  <time className="timeline-time">{new Date(e.occurred_at).toLocaleString()}</time>
                </button>
                {open && (
                  <div className="timeline-details">
                    <dl>
                      <dt>Event</dt><dd><code>{e.event_type}</code></dd>
                      <dt>Step</dt><dd>#{e.sequence}</dd>
                      <dt>Actor</dt><dd>{e.actor_type === "SYSTEM" ? "System" : humanize(e.actor_type)}</dd>
                    </dl>
                    {Object.keys(e.payload ?? {}).length > 0 && (
                      <details>
                        <summary>Payload</summary>
                        <pre>{JSON.stringify(e.payload, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
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

/** True when the staff-override warning should show: an override happened
 *  and the current pick differs from the system's pick. If staff reverts
 *  back to the system's original choice, the warning is silenced. */
export function shouldShowOverrideWarning(
  systemSupplierName: string | null,
  selectedSupplierName: string | null,
  overrideCount: number
): boolean {
  return (
    overrideCount > 0 &&
    !!systemSupplierName &&
    !!selectedSupplierName &&
    selectedSupplierName !== systemSupplierName
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
  // The system's baseline is its most recent pick; staff overriding back to
  // that pick silences the warning.
  const systemPickEvents = events.filter(e => e.event_type === "ELIGIBLE_OFFER_SELECTED");
  const lastSystemPick = systemPickEvents[systemPickEvents.length - 1];
  const systemSupplierName = lastSystemPick
    ? String(lastSystemPick.payload.supplier_name)
    : null;
  const overrideWarning =
    lastOverride &&
    shouldShowOverrideWarning(systemSupplierName, selected?.supplier_name ?? null, overrideEvents.length)
      ? (
        <p className="override-note">
          Staff override: system selected <strong>{systemSupplierName}</strong>,
          {" "}staff chose <strong>{selected!.supplier_name}</strong>{" "}
          ({new Date(lastOverride.occurred_at).toLocaleString()})
        </p>
      )
      : null;

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
      {overrideWarning}
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
