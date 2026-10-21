import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  assignTech,
  createCase,
  createIntakeQuoteLink,
  createQuoteLink,
  createTrackingLink,
  deactivateOperator,
  declinePublicQuote,
  decodeVin,
  getAssignment,
  getCase,
  getCaseEvents,
  getGoogleConfig,
  getHealth,
  getMe,
  getMyOperator,
  getPublicIntakeStatus,
  getPublicQuote,
  getPublicTracking,
  getSchedule,
  getToken,
  googleStartUrl,
  inviteOperator,
  listCases,
  listOperators,
  login,
  logout,
  ocrVinPhoto,
  performAction,
  proposeAssignment,
  reactivateOperator,
  revokeInvite,
  setToken,
  signPublicQuote,
  startIdentification,
  submitPublicIntake,
  subscribeStaffEvents,
  UnauthorizedError,
  updateMyProfile,
  updateOperatorProfile,
  verifyOperator,
  type DecodedVehicle,
  type MyOperator,
  type PublicIntakeStatus,
  type PublicQuoteView,
  type PublicTrackingView,
  type StaffEventsStatus,
  type StaffUser
} from "./api";
import type {
  AvailabilityWindow,
  CaseEvent,
  CaseRecord,
  Channel,
  GlassCandidate,
  GlassType,
  Operator,
  OperatorInviteView,
  ScheduleBoardEntry,
  SchedulerProposal
} from "./types";

type Screen = "queue" | "new" | "detail" | "quote" | "operators" | "schedule";

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
  const [authError, setAuthError] = useState("");

  // A load error (e.g. a transient "Load failed" when the queue fetch hits
  // a network blip) belongs to the screen where it happened. Clear it on
  // navigation so a stale banner never follows the user to another screen.
  useEffect(() => {
    setMessage("");
  }, [screen]);

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
    if (willExpand) {
      // Expanding a live-arrived case acknowledges it: clear the "New" flag.
      setFreshCaseIds(prev => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      void refreshExpandedCase(id);
    }
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

  // Google Sign-In returns through the URL fragment: #session=<jwt> on
  // success, #auth_error=<message> on failure (the JWT never reaches a
  // server log this way). Consume it once, then scrub the fragment.
  // Declared before the session boot effect below so the token is in
  // storage by the time it reads.
  useEffect(() => {
    if (typeof window === "undefined" || !window.location.hash) return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const session = params.get("session");
    const error = params.get("auth_error");
    if (session) setToken(session);
    if (error) setAuthError(error);
    if (session || error) {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search
      );
    }
  }, []);

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
      applyLoadedCases(await listCases(), false);
    } catch (error) {
      loadError(error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (staff) void refreshQueue();
  }, [staff]);

  const [liveStatus, setLiveStatus] = useState<StaffEventsStatus | "off">("off");
  const [freshCaseIds, setFreshCaseIds] = useState<Set<string>>(new Set());
  const reloadTimer = useRef<number | undefined>(undefined);
  // Ids from the most recent queue load. A case that shows up in a
  // socket-triggered reload but was not in the previous load arrived
  // live — flag it New even if its first event raced the subscription.
  const knownCaseIds = useRef<Set<string> | null>(null);

  const applyLoadedCases = (loaded: CaseRecord[], flagNew: boolean) => {
    if (flagNew && knownCaseIds.current) {
      const known = knownCaseIds.current;
      const arrived = loaded.filter(c => !known.has(c.id)).map(c => c.id);
      if (arrived.length) {
        setFreshCaseIds(prev => new Set([...prev, ...arrived]));
      }
    }
    knownCaseIds.current = new Set(loaded.map(c => c.id));
    setCases(loaded);
  };

  const reloadCasesQuiet = async () => {
    try {
      applyLoadedCases(await listCases(), true);
    } catch {
      // Keep the last good list; the next event or a manual refresh retries.
    }
  };

  // Live queue (Nelly, 2026-10-20): when a client submits an intake —
  // or anything else appends a case event — the socket pushes a
  // notification and the queue refetches itself. No manual refresh.
  // Brand-new intakes are flagged "New" until staff expand them.
  useEffect(() => {
    if (!staff) {
      setLiveStatus("off");
      return;
    }
    const scheduleReload = () => {
      if (reloadTimer.current !== undefined) return;
      reloadTimer.current = window.setTimeout(() => {
        reloadTimer.current = undefined;
        void reloadCasesQuiet();
      }, 250);
    };
    const unsubscribe = subscribeStaffEvents({
      onEvent: (message) => {
        if (
          message.type === "case_event" &&
          message.event_type === "CLIENT_INTAKE_SUBMITTED" &&
          message.case_id
        ) {
          const caseId = message.case_id;
          setFreshCaseIds(prev => new Set(prev).add(caseId));
        }
        scheduleReload();
      },
      onStatus: setLiveStatus
    });
    return () => {
      unsubscribe();
      if (reloadTimer.current !== undefined) {
        window.clearTimeout(reloadTimer.current);
        reloadTimer.current = undefined;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /** Refresh the selected case's detail + events without changing screen.
   *  Used by the client invoice view so the customer stays on the receipt
   *  after signing instead of being dropped into the staff detail view. */
  const refreshSelected = async (id: string) => {
    try {
      const [detail, activity] = await Promise.all([getCase(id), getCaseEvents(id)]);
      setSelected(detail);
      setEvents([...activity].sort((a, b) => b.sequence - a.sequence));
    } catch (error) {
      loadError(error);
    }
  };

  const signOut = () => {
    logout();
    setStaff(null);
    setCases([]);
    setSelected(null);
    setScreen("queue");
  };

  // Customer-facing public pages live outside the staff app entirely:
  // /quote/<token> (sign = approve), /track/<token> (job tracking), and
  // /intake (the QR front door — the customer creates the case).
  // They are gated by the token (or, for intake, by rate limit +
  // validation), never by a staff session.
  const publicRoute = useMemo(() => {
    if (typeof window === "undefined") return null;
    if (window.location.pathname === "/intake") {
      return { kind: "intake" as const, token: "" };
    }
    const invite = window.location.pathname.match(/^\/invite\/([A-Za-z0-9_-]+)$/);
    if (invite) {
      return { kind: "invite" as const, token: invite[1] };
    }
    const m = window.location.pathname.match(/^\/(quote|track)\/([A-Za-z0-9_-]+)$/);
    return m ? { kind: m[1] as "quote" | "track", token: m[2] } : null;
  }, []);

  if (publicRoute?.kind === "quote") {
    return <PublicQuotePage token={publicRoute.token} />;
  }
  if (publicRoute?.kind === "track") {
    return <PublicTrackingPage token={publicRoute.token} />;
  }
  if (publicRoute?.kind === "intake") {
    return <PublicIntakePage />;
  }
  if (publicRoute?.kind === "invite") {
    return <InviteAcceptPage credential={publicRoute.token} authError={authError} />;
  }

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
        <LoginScreen onSignedIn={s => setStaff(s)} authError={authError} />
      </Shell>
    );
  }

  // Techs land on their own surface, never the staff queue (the API
  // refuses tech tokens on case routes anyway; this keeps the UI honest).
  if (staff.role === "tech") {
    return (
      <Shell staff={staff} onSignOut={signOut}>
        <TechGate staff={staff} />
      </Shell>
    );
  }

  if (screen === "operators") {
    return (
      <Shell
        staff={staff}
        onSignOut={signOut}
        crumbs={[
          { label: "Case queue", onClick: () => setScreen("queue") },
          { label: "Operators" }
        ]}
      >
        <OperatorsScreen currentStaff={staff} />
      </Shell>
    );
  }

  if (screen === "schedule") {
    return (
      <Shell
        staff={staff}
        onSignOut={signOut}
        crumbs={[
          { label: "Case queue", onClick: () => setScreen("queue") },
          { label: "Schedule" }
        ]}
      >
        <ScheduleScreen onOpenCase={id => { void openCase(id); }} />
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
          onOpenClientView={() => setScreen("quote")}
          loading={loading}
          staffEmail={staff.email}
        />
      </Shell>
    );
  }

  if (screen === "quote" && selected) {
    return (
      <Shell
        staff={staff}
        onSignOut={signOut}
        crumbs={[
          { label: "Case queue", onClick: () => setScreen("queue") },
          { label: selected.reference, onClick: () => { void openCase(selected.id); } },
          { label: "Client quote" }
        ]}
      >
        <ClientQuoteView
          item={selected}
          onRefresh={() => refreshSelected(selected.id)}
          onBack={() => { void openCase(selected.id); }}
        />
      </Shell>
    );
  }

  return (
    <Shell staff={staff} onSignOut={signOut} crumbs={[{ label: "Case queue" }]}>
      <section className="page-head">
        <div>
          <p className="eyebrow">R&R Operations</p>
          <CatalogBadge />
          <h1>Case Queue</h1>
          <p className="muted">One operational truth across Direct, Auction, and Insurance.</p>
          {liveStatus !== "off" && (
            <p className={`live-pill ${liveStatus}`} data-testid="queue-live-status">
              {liveStatus === "live"
                ? "● Live — new cases appear automatically"
                : "○ Reconnecting…"}
            </p>
          )}
        </div>
      </section>

      {message && <div className="alert">{message}</div>}
      {loading ? (
        <div className="card">Loading cases…</div>
      ) : (
        <div className="queue-layout">
          <aside className="queue-sidebar" aria-label="Case filters">
            <button type="button" className="primary sidebar-new" onClick={() => { setNewCaseOrigin({ screen: "queue" }); setScreen("new"); }}>+ New Case</button>
            <div className="sidebar-nav">
              <button type="button" className="secondary" onClick={() => setScreen("schedule")}>Schedule board</button>
              <button type="button" className="secondary" onClick={() => setScreen("operators")}>Operators</button>
            </div>
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
                  const fresh = freshCaseIds.has(c.id);
                  return (
                    <article className={"case-card" + (expanded ? " expanded" : "") + (fresh ? " fresh" : "")} key={c.id}>
                      <div className="case-card-head">
                        <div>
                          <strong>{c.reference}</strong>
                          <span className="channel">{c.channel}</span>
                          {c.client_intake && (
                            <span className="client-badge" data-testid="client-intake-badge">
                              Client QR
                            </span>
                          )}
                          {fresh && (
                            <span className="new-badge" data-testid="new-case-badge">
                              New
                            </span>
                          )}
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
                          {c.client_intake && (
                            <p className="client-contact">
                              <strong>Client-submitted:</strong>{" "}
                              {c.client_intake.customer_name ?? "Customer"}
                              {c.client_intake.customer_phone
                                ? ` · ${c.client_intake.customer_phone}`
                                : ""}
                              {c.client_intake.note ? ` — “${c.client_intake.note}”` : ""}
                            </p>
                          )}
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

/** Glass catalog mode from the API health check ("mygrant-web" vs "mock").
 * Shared by the catalog badge and any copy that differs between live and
 * mock mode — e.g. the VIN lookup card must say $1 in live mode. */
function useCatalogMode(): string | null {
  const [catalog, setCatalog] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getHealth().then(health => {
      if (!cancelled && health) setCatalog(health.glass_catalog ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return catalog;
}

/**
 * Glass catalog mode badge: live MyGrant ($1/VIN lookup) vs mock catalog.
 * Fetches the API health once and renders nothing until it resolves.
 * Placed in the page head under the section eyebrow — never in the topbar,
 * so the header grid stays untouched.
 */
function CatalogBadge() {
  const catalog = useCatalogMode();
  if (!catalog) return null;
  return (
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
  );
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
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = () => setMenuOpen(false);
  const handleSignOut = () => {
    closeMenu();
    onSignOut();
  };
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

function LoginScreen({
  onSignedIn,
  authError = ""
}: {
  onSignedIn: (s: StaffUser) => void;
  authError?: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  // Google Sign-In appears only when the deployment has it configured
  // (feature-detected; inert otherwise — Slice A §7.1).
  const [googleEnabled, setGoogleEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getGoogleConfig().then(config => {
      if (!cancelled) setGoogleEnabled(config.enabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

      {authError && <div className="alert" role="alert">{authError}</div>}
      {error && <div className="alert" role="alert">{error}</div>}

      {googleEnabled && (
        <div className="actions">
          <a className="secondary" href={googleStartUrl()} data-testid="google-signin">
            Continue with Google
          </a>
        </div>
      )}

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

// ---------------------------------------------------------------------
// Operators (Slice A): techs management, onboarding, schedule board.
// ---------------------------------------------------------------------

export const QUALIFICATION_OPTIONS: { id: string; label: string }[] = [
  { id: "WINDSHIELD", label: "Windshield" },
  { id: "BACK_GLASS", label: "Back glass" },
  { id: "DOOR_GLASS", label: "Door glass" },
  { id: "QUARTER_GLASS", label: "Quarter glass" },
  { id: "VENT_GLASS", label: "Vent glass" },
  { id: "ADAS_CALIBRATION", label: "ADAS calibration" },
  { id: "MOBILE", label: "Mobile service" },
  { id: "IN_SHOP", label: "In-shop" }
];

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function qualificationLabel(id: string): string {
  return QUALIFICATION_OPTIONS.find(o => o.id === id)?.label ?? id;
}

export function QualificationCheckboxes({
  value,
  onChange,
  legend
}: {
  value: string[];
  onChange: (next: string[]) => void;
  legend: string;
}) {
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...value, id] : value.filter(v => v !== id));
  return (
    <fieldset className="qualifications">
      <legend>{legend}</legend>
      {QUALIFICATION_OPTIONS.map(o => (
        <label key={o.id} className="check">
          <input
            type="checkbox"
            checked={value.includes(o.id)}
            onChange={e => toggle(o.id, e.target.checked)}
          />{" "}
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

/** One recurring window per weekday: check the day, set start/end. */
export function AvailabilityEditor({
  value,
  onChange
}: {
  value: AvailabilityWindow[];
  onChange: (next: AvailabilityWindow[]) => void;
}) {
  const byDay = new Map(value.map(w => [w.day_of_week, w]));
  const setDay = (day: number, window: AvailabilityWindow | null) => {
    const rest = value.filter(w => w.day_of_week !== day);
    onChange(window ? [...rest, window].sort((a, b) => a.day_of_week - b.day_of_week) : rest);
  };
  return (
    <fieldset className="availability">
      <legend>Availability</legend>
      {WEEKDAY_LABELS.map((label, day) => {
        const window = byDay.get(day);
        return (
          <div key={day} className="availability-row">
            <label className="check">
              <input
                type="checkbox"
                aria-label={`${label} available`}
                checked={Boolean(window)}
                onChange={e =>
                  setDay(day, e.target.checked ? { day_of_week: day, start: "08:00", end: "17:00" } : null)
                }
              />{" "}
              {label}
            </label>
            {window && (
              <>
                <input
                  type="time"
                  aria-label={`${label} start`}
                  value={window.start}
                  onChange={e => setDay(day, { ...window, start: e.target.value })}
                />
                <span>–</span>
                <input
                  type="time"
                  aria-label={`${label} end`}
                  value={window.end}
                  onChange={e => setDay(day, { ...window, end: e.target.value })}
                />
              </>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

function OperatorCard({
  operator,
  canManage,
  onChanged
}: {
  operator: Operator;
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const profile = operator.profile;
  const [qualifications, setQualifications] = useState<string[]>(
    profile?.qualifications.length ? profile.qualifications : (profile?.claimed_qualifications ?? [])
  );
  const [availability, setAvailability] = useState<AvailabilityWindow[]>(profile?.availability ?? []);
  const [liveStatus, setLiveStatus] = useState<"AVAILABLE" | "OFF">(profile?.live_status ?? "AVAILABLE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card operator-card" data-testid="operator-card">
      <div className="case-card-head">
        <div>
          <strong>{operator.name}</strong> <span className="channel">{operator.email}</span>
        </div>
        <span className={`status-badge status-${operator.status.toLowerCase()}`}>{humanize(operator.status)}</span>
      </div>
      {profile?.phone && <p className="muted">{profile.phone}{profile.home_base ? ` · ${profile.home_base}` : ""}{profile.service_area ? ` · ${profile.service_area}` : ""}</p>}
      {profile && profile.claimed_qualifications.length > 0 && (
        <p className="muted">
          Claimed: {profile.claimed_qualifications.map(qualificationLabel).join(", ")}
        </p>
      )}
      {profile && profile.qualifications.length > 0 && (
        <p>
          Verified:{" "}
          {profile.qualifications.map(tag => (
            <span key={tag} className="tag">{qualificationLabel(tag)}</span>
          ))}
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {canManage && operator.status === "PROFILE_PENDING" && (
        <div className="operator-actions">
          <QualificationCheckboxes value={qualifications} onChange={setQualifications} legend="Verify qualifications" />
          <AvailabilityEditor value={availability} onChange={setAvailability} />
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => run(() => verifyOperator(operator.id, { qualifications, availability }))}
          >
            Verify & activate
          </button>
        </div>
      )}
      {canManage && operator.status === "ACTIVE" && (
        <div className="operator-actions">
          <QualificationCheckboxes value={qualifications} onChange={setQualifications} legend="Qualifications" />
          <AvailabilityEditor value={availability} onChange={setAvailability} />
          <label>
            Live status{" "}
            <select value={liveStatus} onChange={e => setLiveStatus(e.target.value as "AVAILABLE" | "OFF")}>
              <option value="AVAILABLE">Available</option>
              <option value="OFF">Off</option>
            </select>
          </label>
          <div className="row">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                run(() =>
                  updateOperatorProfile(operator.id, {
                    qualifications,
                    availability,
                    live_status: liveStatus
                  })
                )
              }
            >
              Save changes
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => run(() => deactivateOperator(operator.id))}
            >
              Deactivate
            </button>
          </div>
        </div>
      )}
      {canManage && operator.status === "DEACTIVATED" && (
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => run(() => reactivateOperator(operator.id))}
        >
          Reactivate
        </button>
      )}
    </article>
  );
}

export function OperatorsScreen({ currentStaff }: { currentStaff: StaffUser }) {
  const canManage = currentStaff.role === "admin" || currentStaff.role === "owner";
  const [operators, setOperators] = useState<Operator[]>([]);
  const [invites, setInvites] = useState<OperatorInviteView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await listOperators();
      setOperators(data.operators);
      setInvites(data.invites);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load operators.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sendInvite = async (e: FormEvent) => {
    e.preventDefault();
    setInviting(true);
    setError("");
    setInviteUrl(null);
    try {
      const result = await inviteOperator(inviteEmail.trim());
      setInviteUrl(`${window.location.origin}${result.invite_path}`);
      setInviteEmail("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the invite.");
    } finally {
      setInviting(false);
    }
  };

  return (
    <section>
      <div className="page-head">
        <div>
          <p className="eyebrow">R&R Operations</p>
          <h1>Operators</h1>
          <p className="muted">Technicians onboard by invite + Google sign-in. Only verified, active techs can be assigned work.</p>
        </div>
      </div>
      {error && <div className="alert" role="alert">{error}</div>}
      {canManage && (
        <form className="card" onSubmit={sendInvite}>
          <h2>Invite a technician</h2>
          <label>
            Gmail address
            <input
              type="email"
              required
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              placeholder="tech@gmail.com"
            />
          </label>
          <div className="actions">
            <button className="primary" disabled={inviting}>
              {inviting ? "Creating…" : "Create invite"}
            </button>
          </div>
          {inviteUrl && (
            <>
              <p className="muted">Send this link to the tech — it's shown once. They sign in with the invited Google account to claim it.</p>
              <CustomerLinkBox url={inviteUrl} />
            </>
          )}
        </form>
      )}
      {invites.length > 0 && (
        <div className="card">
          <h2>Pending invites</h2>
          {invites.map(invite => (
            <div key={invite.id} className="row">
              <span>{invite.email}</span>
              <span className="muted">expires {new Date(invite.expires_at).toLocaleDateString()}</span>
              {canManage && (
                <button
                  type="button"
                  className="link"
                  onClick={() => { void revokeInvite(invite.id).then(load); }}
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {loading ? (
        <div className="card">Loading operators…</div>
      ) : operators.length === 0 ? (
        <div className="card">
          <h2>No technicians yet.</h2>
          <p className="muted">Invite the first tech above — they'll appear here once they sign in.</p>
        </div>
      ) : (
        operators.map(operator => (
          <OperatorCard key={operator.id} operator={operator} canManage={canManage} onChanged={load} />
        ))
      )}
    </section>
  );
}

export function ScheduleScreen({ onOpenCase }: { onOpenCase: (id: string) => void }) {
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const [date, setDate] = useState(today);
  const [entries, setEntries] = useState<ScheduleBoardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const board = await getSchedule(date);
      setEntries(board.entries);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the schedule.");
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void load();
  }, [load]);

  const scheduled = entries.filter(e => e.scheduled_start);
  const unscheduled = entries.filter(e => !e.scheduled_start);
  const byTech = new Map<string, ScheduleBoardEntry[]>();
  for (const entry of scheduled) {
    const key = entry.tech_name ?? "Unassigned";
    byTech.set(key, [...(byTech.get(key) ?? []), entry]);
  }
  const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return (
    <section>
      <div className="page-head">
        <div>
          <p className="eyebrow">R&R Operations</p>
          <h1>Schedule board</h1>
          <p className="muted">Who is doing what, today. Assign techs from a case's Fulfillment card.</p>
        </div>
      </div>
      <label>
        Day{" "}
        <input type="date" value={date} onChange={e => setDate(e.target.value)} aria-label="Schedule day" />
      </label>
      {error && <div className="alert" role="alert">{error}</div>}
      {loading ? (
        <div className="card">Loading schedule…</div>
      ) : (
        <>
          {[...byTech.entries()].map(([tech, jobs]) => (
            <div className="card" key={tech} data-testid="schedule-tech-column">
              <h2>{tech}</h2>
              {jobs.map(entry => (
                <div key={entry.case_id} className="row">
                  <span>
                    {entry.scheduled_start ? formatTime(entry.scheduled_start) : ""}–
                    {entry.scheduled_end ? formatTime(entry.scheduled_end) : ""}
                  </span>
                  <button type="button" className="link" onClick={() => onOpenCase(entry.case_id)}>
                    {entry.reference}
                  </button>
                  <span>{entry.glass_type ? humanize(entry.glass_type) : ""}</span>
                  <span className="muted">{humanize(entry.current_state)}</span>
                </div>
              ))}
            </div>
          ))}
          {scheduled.length === 0 && (
            <div className="card"><p className="muted">No jobs scheduled for this day yet.</p></div>
          )}
          {unscheduled.length > 0 && (
            <div className="card" data-testid="schedule-unscheduled">
              <h2>Needs scheduling</h2>
              {unscheduled.map(entry => (
                <div key={entry.case_id} className="row">
                  <button type="button" className="link" onClick={() => onOpenCase(entry.case_id)}>
                    {entry.reference}
                  </button>
                  <span>{entry.glass_type ? humanize(entry.glass_type) : ""}</span>
                  <span className="muted">{humanize(entry.current_state)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Public invite landing: /invite/<credential> — the tech claims the
 *  invite by signing in with the invited Google account. */
export function InviteAcceptPage({
  credential,
  authError = ""
}: {
  credential: string;
  authError?: string;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    getGoogleConfig().then(config => {
      if (!cancelled) setEnabled(config.enabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div className="app-shell">
      <main>
        <div className="card" style={{ maxWidth: 520, margin: "48px auto" }}>
          <p className="eyebrow">R&R Finest Auto Glass</p>
          <h1>Join as a technician</h1>
          {authError && <div className="alert" role="alert">{authError}</div>}
          {enabled === null ? (
            <p className="muted">Loading…</p>
          ) : enabled ? (
            <>
              <p className="muted">
                Sign in with the Google account this invite was sent to. You'll
                finish your profile next, and R&R will verify your qualifications
                before your first job.
              </p>
              <div className="actions">
                <a className="primary" href={googleStartUrl(credential)} data-testid="invite-google-signin">
                  Continue with Google
                </a>
              </div>
            </>
          ) : (
            <p className="muted">
              Google sign-in isn't switched on for this deployment yet — ask R&R
              to finish the setup, then open this link again.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

/** Tech landing after Google sign-in: profile completion while pending,
 *  a plain "no jobs yet" home once active (the job view is Slice B). */
export function TechGate({ staff }: { staff: StaffUser }) {
  const [mine, setMine] = useState<MyOperator | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setMine(await getMyOperator());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your profile.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="card">
        <p className="error" role="alert">{error}</p>
      </div>
    );
  }
  if (!mine) return <div className="card">Loading…</div>;
  if (mine.status === "PROFILE_PENDING") {
    return <OperatorProfileForm mine={mine} onSaved={load} />;
  }
  if (mine.status === "DEACTIVATED") {
    return (
      <div className="card">
        <h1>Account not active</h1>
        <p className="muted">Your technician account has been deactivated. Please contact R&R.</p>
      </div>
    );
  }
  return <TechHome staff={staff} mine={mine} />;
}

export function TechHome({ staff, mine }: { staff: StaffUser; mine: MyOperator }) {
  const firstName = staff.name.trim().split(/\s+/)[0] ?? staff.name;
  return (
    <section className="card" data-testid="tech-home">
      <p className="eyebrow">Technician</p>
      <h1>Welcome, {firstName}</h1>
      <p className="muted">
        No jobs yet — your job view arrives with your first assignment. When R&R
        assigns you a job, it shows up here (and on your Google Calendar) with
        everything you need for the day.
      </p>
      {mine.profile && mine.profile.qualifications.length > 0 && (
        <p>
          Your verified work:{" "}
          {mine.profile.qualifications.map(tag => (
            <span key={tag} className="tag">{qualificationLabel(tag)}</span>
          ))}
        </p>
      )}
    </section>
  );
}

export function OperatorProfileForm({
  mine,
  onSaved
}: {
  mine: MyOperator;
  onSaved: () => Promise<void>;
}) {
  const profile = mine.profile;
  const [phone, setPhone] = useState(profile?.phone ?? "");
  const [homeBase, setHomeBase] = useState(profile?.home_base ?? "");
  const [serviceArea, setServiceArea] = useState(profile?.service_area ?? "");
  const [claimed, setClaimed] = useState<string[]>(profile?.claimed_qualifications ?? []);
  const [consent, setConsent] = useState(profile?.location_sharing_consent ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await updateMyProfile({
        phone: phone.trim(),
        home_base: homeBase.trim(),
        service_area: serviceArea.trim(),
        claimed_qualifications: claimed,
        location_sharing_consent: consent
      });
      setSaved(true);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your profile.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form card" onSubmit={submit} data-testid="operator-profile-form">
      <p className="eyebrow">Technician onboarding</p>
      <h1>Finish your profile</h1>
      <p className="muted">
        Tell R&R how to reach you and what work you're qualified for. Staff
        verify your qualifications before your first assignment.
      </p>
      {error && <div className="alert" role="alert">{error}</div>}
      {saved && <div className="alert" role="status">Profile saved — R&R will verify and activate your account.</div>}
      <label>
        Mobile phone
        <input type="tel" required value={phone} onChange={e => setPhone(e.target.value)} placeholder="617-555-0100" />
      </label>
      <label>
        Home base
        <input type="text" required value={homeBase} onChange={e => setHomeBase(e.target.value)} placeholder="City, ST" />
      </label>
      <label>
        Service area
        <input type="text" required value={serviceArea} onChange={e => setServiceArea(e.target.value)} placeholder="e.g. Greater Boston" />
      </label>
      <QualificationCheckboxes value={claimed} onChange={setClaimed} legend="Work you can do" />
      <label className="check">
        <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />{" "}
        I agree to share my location while a job is active (required for mobile jobs).
      </label>
      <div className="actions">
        <button className="primary" disabled={busy}>{busy ? "Saving…" : "Save profile"}</button>
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

/**
 * Starts identification for a freshly created case. POST /cases returns the
 * shell immediately (serverless-safe); this second, awaited-on-the-server
 * request runs the whole identification → sourcing → pricing chain inside
 * its own request lifecycle, so the platform cannot freeze it
 * mid-processing. Intentionally not awaited for UI purposes:
 * CaseCreationProgress streams the event log via polling independently.
 * A rejected start degrades to the progress screen's 3-minute timeout path.
 */
function kickOffIdentification(c: CaseRecord) {
  if (c.current_state !== "REQUEST_RECEIVED") return;
  startIdentification(c.id).catch(err => {
    console.error("Failed to start identification:", err);
  });
}

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
  // Set once POST /api/v1/cases returns the case shell; kickOffIdentification
  // starts the awaited processing request while CaseCreationProgress streams
  // its events.
  const [pendingCase, setPendingCase] = useState<CaseRecord | null>(null);

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
      kickOffIdentification(c);
      setPendingCase(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create case.");
    } finally {
      setSaving(false);
    }
  };

  if (pendingCase) {
    return <CaseCreationProgress caseRecord={pendingCase} onDone={() => onCreated(pendingCase)} />;
  }

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
  // Set once POST /api/v1/cases returns the case shell; kickOffIdentification
  // starts the awaited processing request while CaseCreationProgress streams
  // its events.
  const [pendingCase, setPendingCase] = useState<CaseRecord | null>(null);

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
      kickOffIdentification(c);
      setPendingCase(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create case.");
    } finally {
      setSaving(false);
    }
  };

  if (pendingCase) {
    return <CaseCreationProgress caseRecord={pendingCase} onDone={() => onCreated(pendingCase)} />;
  }

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
export const CASE_CARDS = ["vehicle", "pricing", "quote", "invoice", "fulfillment", "sourcing", "activity"] as const;
export type CaseCardId = (typeof CASE_CARDS)[number];
export const DEFAULT_CARD_ORDER: CaseCardId[] = ["vehicle", "pricing", "quote", "invoice", "fulfillment", "sourcing", "activity"];

/** Case states where the workflow is blocked waiting on a person. */
const STAFF_ACTION_STATES = [
  "VIN_LOOKUP_REQUIRED",
  "HUMAN_GLASS_REVIEW_REQUIRED",
  "GLASS_NOT_IDENTIFIED",
  "NO_ELIGIBLE_INVENTORY",
  "PROFIT_REVIEW_REQUIRED",
  // A failed run parks here; the alert offers the retry matching the failure.
  "SYSTEM_ATTENTION_REQUIRED"
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

/**
 * LOCKED (Nelly, 2026-10-19): the Quote card — the one carrying
 * "Generate Quote", the customer sign link, and the signature/SLA status —
 * always sits immediately after the Pricing card. Staff may reorder every
 * other card freely; this adjacency is not a preference and cannot be
 * dragged apart. Applied on load and on every reorder save, so saved
 * orders from before the lock migrate automatically.
 */
export function pinQuoteAfterPricing(order: CaseCardId[]): CaseCardId[] {
  if (!order.includes("quote") || !order.includes("pricing")) return [...order];
  const withoutQuote: CaseCardId[] = order.filter(id => id !== "quote");
  const pricingIndex = withoutQuote.indexOf("pricing");
  const next = [...withoutQuote];
  next.splice(pricingIndex + 1, 0, "quote");
  return next;
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
      if (valid.length > 0) return pinQuoteAfterPricing([...valid, ...missing]);
    }
  } catch {
    /* corrupted storage -> fall through to default */
  }
  return [...DEFAULT_CARD_ORDER];
}

function useCardOrder(staffEmail: string) {
  const [order, setOrder] = useState<CaseCardId[]>(() => loadCardOrder(staffEmail));
  const save = useCallback((next: CaseCardId[]) => {
    const pinned = pinQuoteAfterPricing(next);
    setOrder(pinned);
    try {
      localStorage.setItem(cardOrderKey(staffEmail), JSON.stringify(pinned));
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
  onOpenClientView,
  loading,
  staffEmail
}: {
  item: CaseRecord;
  events: CaseEvent[];
  onRefresh: () => Promise<void>;
  onNewCase: () => void;
  onOpenClientView: () => void;
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
      case "quote":
        return (
          <QuoteCard
            item={item}
            onRefresh={onRefresh}
            onOpenClientView={onOpenClientView}
          />
        );
      case "invoice":
        return <InvoiceCard item={item} onRefresh={onRefresh} />;
      case "fulfillment":
        return <FulfillmentCard item={item} onRefresh={onRefresh} />;
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
          {item.client_intake && (
            <p className="client-contact">
              <span className="client-badge" data-testid="client-intake-badge">Client QR</span>{" "}
              Submitted by {item.client_intake.customer_name ?? "the customer"}
              {item.client_intake.customer_phone
                ? ` · ${item.client_intake.customer_phone}`
                : ""}
              {item.client_intake.vin_ocr_suggestion
                ? ` · VIN photo reads: ${item.client_intake.vin_ocr_suggestion} (suggestion only)`
                : ""}
            </p>
          )}
        </div>
        <button className="primary" onClick={onNewCase}>+ New Case</button>
      </section>

      {isStaffActionRequired(item.current_state) && (
        <StaffActionAlert item={item} events={events} onRefresh={onRefresh} />
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
  events,
  onRefresh
}: {
  item: CaseRecord;
  events: CaseEvent[];
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedPart, setSelectedPart] = useState("");
  const catalogMode = useCatalogMode();
  const liveVin = catalogMode === "mygrant-web";

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
            resolve it — {liveVin
              ? "this runs a live VIN lookup against MyGrant for $1."
              : "the mock catalog stands in here, so nothing is charged."}
          </p>
          <div className="workspace-actions">
            <button className="primary" disabled={busy} onClick={() => run("request_vin_lookup")}>
              {busy ? "Looking up…" : liveVin ? "Run VIN lookup ($1)" : "Run VIN lookup"}
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
              <label
                key={c.part_number}
                className={`candidate${selectedPart === c.part_number ? " selected" : ""}`}
              >                <input
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
    case "SYSTEM_ATTENTION_REQUIRED": {
      // The workflow failed somewhere (sourcing, YMM, VIN, pricing…).
      // Offer the retry that matches the actual failure; anything else
      // just shows the error so staff can decide.
      const failure = [...events].reverse().find(e =>
        ["SOURCING_FAILED", "YMM_SEARCH_FAILED", "VIN_LOOKUP_FAILED", "PRICING_FAILED", "IDENTIFICATION_ERROR"].includes(e.event_type)
      );
      const failurePayload = (failure?.payload ?? {}) as Record<string, unknown>;
      const failureError = eventText(failurePayload, "error") ?? eventText(failurePayload, "reason");
      const failureSuffix = failureError ? `: ${failureError}` : ".";
      if (failure?.event_type === "SOURCING_FAILED") {
        body = (
          <>
            <p>
              Supplier sourcing failed{failureSuffix} Part-number searches
              are free, so retrying costs nothing.
            </p>
            <div className="workspace-actions">
              <button className="primary" disabled={busy} onClick={() => run("retry_sourcing")}>
                {busy ? "Retrying…" : "Retry sourcing"}
              </button>
            </div>
          </>
        );
      } else if (failure?.event_type === "YMM_SEARCH_FAILED") {
        body = (
          <>
            <p>
              The vehicle search failed{failureSuffix} Retrying re-runs
              identification — YMM searches are free.
            </p>
            <div className="workspace-actions">
              <button className="primary" disabled={busy} onClick={() => run("retry_identification")}>
                {busy ? "Retrying…" : "Retry identification"}
              </button>
            </div>
          </>
        );
      } else if (failure?.event_type === "VIN_LOOKUP_FAILED") {
        body = (
          <>
            <p>
              The VIN lookup failed{failureSuffix} {liveVin
                ? "Retrying runs another live VIN lookup for $1."
                : "The mock catalog stands in here, so nothing is charged."}
            </p>
            <div className="workspace-actions">
              <button className="primary" disabled={busy} onClick={() => run("request_vin_lookup")}>
                {busy ? "Looking up…" : liveVin ? "Retry VIN lookup ($1)" : "Retry VIN lookup"}
              </button>
            </div>
            <small>Successful VIN results are cached and reused — never repurchased.</small>
          </>
        );
      } else {
        body = (
          <>
            <p>
              The workflow hit a problem{failureSuffix} Take a look at the
              activity below before deciding what to do.
            </p>
          </>
        );
      }
      break;
    }
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
  events,
  onRefresh
}: {
  item: CaseRecord;
  events: CaseEvent[];
  onRefresh: () => Promise<void>;
}) {
  return (
    <section className="card alert-card" role="alert" aria-label="Staff action required">
      <h2><span aria-hidden="true">⚠</span> Staff action required</h2>
      <StaffActionBody item={item} events={events} onRefresh={onRefresh} />
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
    case "IDENTIFICATION_ERROR":
      return "Identification hit an unexpected error and needs staff attention.";
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
    case "QUOTE_GENERATED": {
      const v = eventText(p, "version");
      const total = eventText(p, "sell_price_cents");
      return `Quote${v ? ` v${v}` : ""} sent${total ? ` — total $${(Number(total) / 100).toFixed(2)}` : ""}.`;
    }
    case "QUOTE_SIGNED": {
      const signer = eventText(p, "signer_name");
      return signer ? `Quote signed by ${signer}.` : "Quote signed.";
    }
    case "QUOTE_DECLINED":
      return "Quote declined by the client.";
    case "QUOTE_EXPIRED":
      return "Quote expired before the client signed.";
    case "INVOICE_GENERATED": {
      const v = eventText(p, "version");
      const qv = eventText(p, "quote_version");
      const total = eventText(p, "sell_price_cents");
      return `Invoice${v ? ` v${v}` : ""} generated${qv ? ` from signed quote v${qv}` : ""}${total ? ` — total $${(Number(total) / 100).toFixed(2)}` : ""}.`;
    }
    case "PARTS_ORDERED":
      return "Parts ordered for this job.";
    case "INSTALLATION_SCHEDULED": {
      const at = eventText(p, "scheduled_at");
      return at
        ? `Installation scheduled for ${new Date(at).toLocaleString()}.`
        : "Installation scheduled.";
    }
    case "TECH_ASSIGNED": {
      const tech = eventText(p, "technician_name");
      const reason = eventText(p, "override_reason");
      return tech
        ? `Assigned to ${tech}${reason ? ` (scheduler override: ${reason})` : ""}.`
        : "A technician was assigned.";
    }
    case "TECH_REASSIGNED": {
      const tech = eventText(p, "technician_name");
      const reason = eventText(p, "override_reason");
      return tech
        ? `Reassigned to ${tech}${reason ? ` (scheduler override: ${reason})` : ""}.`
        : "The job was reassigned.";
    }
    case "TECH_DISPATCHED": {
      const tech = eventText(p, "technician_name");
      return tech ? `Technician dispatched: ${tech}.` : "Technician dispatched.";
    }
    case "SERVICE_STARTED":
      return "Service started.";
    case "SERVICE_COMPLETED":
      return "Service completed.";
    case "CASE_CLOSED":
      return "Case closed.";
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

/**
 * Events that end the automatic identification → sourcing → pricing run.
 * When one appears in the event stream, the progress view hands off to the
 * case detail screen. GLASS_IDENTIFIED is deliberately absent: sourcing
 * still runs automatically after it.
 */
const CREATION_TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  // STANDARD_PRICE_CALCULATED is the terminal event of the automatic run:
  // it transitions the case into the PRICE_APPROVED state.
  "STANDARD_PRICE_CALCULATED",
  "PRICING_EXCEPTION_DETECTED",
  "PRICE_APPROVED_BY_RNR",
  "PRICE_REJECTED_BY_RNR",
  "VIN_NEEDED",
  "HUMAN_REVIEW_NEEDED",
  "HUMAN_GLASS_REVIEW_REQUIRED",
  "HUMAN_CANNOT_IDENTIFY",
  "GLASS_NOT_IDENTIFIED",
  "NO_VALID_GLASS",
  "NO_ELIGIBLE_OFFERS",
  "YMM_SEARCH_FAILED",
  "VIN_LOOKUP_FAILED",
  "SOURCING_FAILED",
  "IDENTIFICATION_NOT_FOUND",
  "IDENTIFICATION_ERROR"
]);

/** Live "chain of thought" view shown while a new case's identification runs
 *  in the background. Intake summary on the left, the case's real activity
 *  log streaming on the right; hands off to the detail screen when the
 *  automatic run reaches a terminal event. */
function CaseCreationProgress({
  caseRecord,
  onDone
}: {
  caseRecord: CaseRecord;
  onDone: () => Promise<void>;
}) {
  const [events, setEvents] = useState<CaseEvent[]>([]);
  const [timedOut, setTimedOut] = useState(false);
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const startedAt = Date.now();
    const TIMEOUT_MS = 3 * 60 * 1000;
    const POLL_MS = 2000;

    const finish = () => {
      if (doneRef.current || cancelled) return;
      doneRef.current = true;
      void onDoneRef.current();
    };

    const poll = async () => {
      if (cancelled || doneRef.current) return;
      try {
        const evts = await getCaseEvents(caseRecord.id);
        if (cancelled || doneRef.current) return;
        setEvents(evts);
        if (evts.some(e => CREATION_TERMINAL_EVENTS.has(e.event_type))) {
          finish();
          return;
        }
      } catch {
        // Transient failure: keep polling until the timeout bounds the wait.
      }
      if (Date.now() - startedAt >= TIMEOUT_MS) {
        setTimedOut(true);
        return;
      }
      timer = window.setTimeout(poll, POLL_MS);
    };

    timer = window.setTimeout(poll, 750);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [caseRecord.id]);

  const v = caseRecord.vehicle;
  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">Case Core</p>
          <h1>Creating case…</h1>
          <p>Identification is running — watch it happen live.</p>
        </div>
      </div>
      <div className="creation-split">
        <section className="card">
          <h2>Intake</h2>
          <dl>
            <dt>Channel</dt><dd>{humanize(caseRecord.channel)}</dd>
            <dt>Vehicle</dt><dd>{v.year} {v.make} {v.model}</dd>
            <dt>VIN</dt><dd><code>{v.vin}</code></dd>
            <dt>Glass</dt><dd>{humanize(caseRecord.glass_request.glass_type)}</dd>
          </dl>
        </section>
        <ActivityTimeline events={events} loading={events.length === 0 && !timedOut} />
      </div>
      {timedOut && (
        <div className="alert" role="alert">
          Still working — this is taking longer than expected.{" "}
          <button type="button" className="link" onClick={() => void onDoneRef.current()}>
            Open the case anyway
          </button>
        </div>
      )}
    </div>
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

/** Channel-adapted noun for the commercial document. Labels only for now:
 *  Direct sees a "quote", Auction a "work request", Insurance an "estimate". */
function quoteNoun(channel: string): string {
  if (channel === "AUCTION") return "work request";
  if (channel === "INSURANCE") return "estimate";
  return "quote";
}

function titleNoun(noun: string): string {
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

/** Staff SLA view of the 72h quote validity: a countdown, or "Expired". */
function quoteSlaLabel(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "Expired";
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  if (h >= 48) return `SLA: expires in ${Math.floor(h / 24)}d ${h % 24}h`;
  if (h >= 1) return `SLA: expires in ${h}h ${m}m`;
  return `SLA: expires in ${m}m`;
}

/** Staff quote card: generate / re-quote, track signature (approval) and the
 *  72h SLA, open the client sign-off view. Full economics are staff-only. */
function QuoteCard({
  item,
  onRefresh,
  onOpenClientView
}: {
  item: CaseRecord;
  onRefresh: () => Promise<void>;
  onOpenClientView: () => void;
}) {
  const quote = item.quote;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signUrl, setSignUrl] = useState<string | null>(null);
  const [mintedForVersion, setMintedForVersion] = useState<number | null>(null);

  async function mintSignLink() {
    setBusy(true);
    setError(null);
    try {
      const link = await createQuoteLink(item.id);
      setSignUrl(`${window.location.origin}${link.path}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the customer link.");
    } finally {
      setBusy(false);
    }
  }

  // The customer link appears on its own: whenever a sent quote is on
  // screen without a link for THIS version, mint one — no button click.
  // A requote (new version) mints a fresh link the same way. Minting never
  // revokes earlier links, so a link already texted to the customer keeps
  // working and simply shows the newest quote.
  useEffect(() => {
    if (item.current_state === "QUOTE_SENT" && quote && mintedForVersion !== quote.version) {
      setMintedForVersion(quote.version);
      void mintSignLink();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.current_state, quote?.version]);
  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const noun = quoteNoun(item.channel);
  const Noun = titleNoun(noun);

  const quotableStates = [
    "PRICE_APPROVED",
    "QUOTE_SENT",
    "QUOTE_DECLINED",
    "QUOTE_EXPIRED",
    "QUOTE_APPROVED",
    "INVOICED",
    "CLOSED"
  ];
  if (!quote && !quotableStates.includes(item.current_state)) return null;

  async function run(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    try {
      await performAction(item.id, action, extra);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  const signed = quote?.status === "APPROVED" && quote.signature != null;
  const closed = item.current_state === "CLOSED";
  const canRequote =
    !!quote && ["QUOTE_SENT", "QUOTE_DECLINED", "QUOTE_EXPIRED"].includes(item.current_state);

  return (
    <section className="card" style={{ marginBottom: 18 }}>
      <h2>{Noun}</h2>
      {!quote ? (
        <>
          <p className="muted">No {noun} yet. Generate one from the approved price.</p>
          {error && <p className="error">{error}</p>}
          <button className="primary" disabled={busy} onClick={() => run("generate_quote")}>
            {busy ? "Generating…" : `Generate ${noun}`}
          </button>
        </>
      ) : (
        <>
          <dl>
            <dt>Version</dt><dd>v{quote.version}</dd>
            <dt>Total</dt><dd><strong>{fmt(quote.snapshot.sell_price_cents)}</strong></dd>
            <dt>Status</dt>
            <dd>
              {signed
                ? `Signed by ${quote.signature!.name} at ${new Date(quote.signature!.signed_at).toLocaleString()}`
                : quote.status === "DECLINED"
                  ? "Declined by client"
                  : quote.status === "EXPIRED" || item.current_state === "QUOTE_EXPIRED"
                    ? "Expired — re-quote to proceed"
                    : "Awaiting client signature"}
            </dd>
            <dt>Validity</dt>
            <dd>{signed ? "Signed — no expiry" : quoteSlaLabel(quote.expires_at)}</dd>
          </dl>
          {error && <p className="error">{error}</p>}
          {!closed && (
            <div className="row">
              {item.current_state === "QUOTE_SENT" && (
                <button className="secondary" onClick={onOpenClientView}>
                  Client sign-off view
                </button>
              )}
              {item.current_state === "QUOTE_SENT" && !signUrl && (
                <button className="secondary" disabled={busy} onClick={mintSignLink}>
                  {busy ? "Working…" : "Customer sign link"}
                </button>
              )}
              {canRequote && (
                <button className="secondary" disabled={busy} onClick={() => run("requote")}>
                  {busy ? "Working…" : `Re-quote (v${quote.version + 1})`}
                </button>
              )}
            </div>
          )}
          {signUrl && item.current_state === "QUOTE_SENT" && (
            <>
              <CustomerLinkBox url={signUrl} />
              <small>
                Send this link to the customer (text/WhatsApp). Signing approves the{" "}
                {noun} and creates the invoice. The link expires with the {noun}.
              </small>
            </>
          )}
          <small>Supplier costs and margins are staff-only; never shown to customers.</small>
        </>
      )}
    </section>
  );
}

/** Staff invoice card: generate from the signed quote, then close the case.
 *  The invoice records which quote version authorized it. */
function InvoiceCard({
  item,
  onRefresh
}: {
  item: CaseRecord;
  onRefresh: () => Promise<void>;
}) {
  const invoice = item.invoice;
  const quote = item.quote;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  const signedQuote = quote?.status === "APPROVED" && quote.signature != null;
  const relevantStates = [
    "QUOTE_APPROVED", "INVOICED", "PARTS_ORDERED", "INSTALLATION_SCHEDULED",
    "TECH_DISPATCHED", "INSTALLATION_IN_PROGRESS", "SERVICE_COMPLETED", "CLOSED"
  ];
  if (!invoice && !relevantStates.includes(item.current_state)) return null;

  async function run(action: string) {
    setBusy(true);
    setError(null);
    try {
      await performAction(item.id, action);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  const closed = item.current_state === "CLOSED";

  return (
    <section className="card" style={{ marginBottom: 18 }}>
      <h2>Invoice</h2>
      {!invoice ? (
        <>
          <p className="muted">
            {signedQuote
              ? `No invoice yet. Generate one from signed quote v${quote!.version}.`
              : "An invoice can be generated once the client signs the quote."}
          </p>
          {error && <p className="error">{error}</p>}
          <button
            className="primary"
            disabled={busy || !signedQuote}
            onClick={() => run("generate_invoice")}
          >
            {busy ? "Generating…" : "Generate invoice"}
          </button>
        </>
      ) : (
        <>
          <dl>
            <dt>Version</dt><dd>v{invoice.version}</dd>
            <dt>From</dt><dd>Signed quote v{invoice.actuals.quote_version}</dd>
            <dt>Glass cost</dt><dd>{fmt(invoice.actuals.glass_cost_cents)}</dd>
            <dt>Labor</dt><dd>{fmt(invoice.actuals.labor_cents)}</dd>
            <dt>Profit</dt><dd>{fmt(invoice.actuals.profit_cents)}</dd>
            <dt>Tax</dt><dd>{fmt(invoice.actuals.tax_cents)}</dd>
            <dt><strong>Total</strong></dt>
            <dd><strong>{fmt(invoice.actuals.sell_price_cents)}</strong></dd>
            <dt>Status</dt>
            <dd>{closed ? "Case closed" : "Issued"}</dd>
          </dl>
          {error && <p className="error">{error}</p>}
          {!closed && item.current_state === "INVOICED" && (
            <div className="row">
              <button className="secondary" disabled={busy} onClick={() => run("generate_invoice")}>
                {busy ? "Working…" : "Re-invoice"}
              </button>
            </div>
          )}
          {!closed && (
            <small>Closing happens in the Fulfillment card once the service is completed.</small>
          )}
          <small>Supplier costs and margins are staff-only; never shown to customers.</small>
        </>
      )}
    </section>
  );
}

/** Shows a minted customer link with a copy button. The raw token exists
 *  only in this URL — it is shown to staff once, at mint time. */
function CustomerLinkBox({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="row" style={{ marginTop: 8 }}>
      <input
        type="text"
        readOnly
        value={url}
        aria-label="Customer link"
        style={{ flex: 1, minWidth: 220 }}
        onFocus={e => e.target.select()}
      />
      <button
        type="button"
        className="secondary"
        onClick={() => {
          void navigator.clipboard?.writeText(url).then(() => setCopied(true));
        }}
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

const FULFILLMENT_FLOW: {
  state: string;
  action: string;
  label: string;
  doneLabel: string;
}[] = [
  { state: "INVOICED", action: "order_parts", label: "Order parts", doneLabel: "Parts ordered" },
  { state: "PARTS_ORDERED", action: "schedule_installation", label: "Schedule installation", doneLabel: "Installation scheduled" },
  { state: "INSTALLATION_SCHEDULED", action: "dispatch_technician", label: "Dispatch technician", doneLabel: "Technician dispatched" },
  { state: "TECH_DISPATCHED", action: "start_service", label: "Start service", doneLabel: "Service started" },
  { state: "INSTALLATION_IN_PROGRESS", action: "complete_service", label: "Complete service", doneLabel: "Service completed" }
];

const FULFILLMENT_STATES = [
  ...FULFILLMENT_FLOW.map(s => s.state),
  "SERVICE_COMPLETED",
  "CLOSED"
];

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Technician assignment (Slice A): pick a work window, let the scheduler
 * propose ranked qualified+available techs, then confirm — or override
 * with a reason, or reassign. Lives inside the Fulfillment card because
 * assignment is a fulfillment step (parts ordered → scheduled).
 */
export function AssignmentPanel({
  item,
  onRefresh
}: {
  item: CaseRecord;
  onRefresh: () => Promise<void>;
}) {
  const job = item.job ?? null;
  const [startLocal, setStartLocal] = useState("");
  const [endLocal, setEndLocal] = useState("");
  const [proposals, setProposals] = useState<SchedulerProposal | null>(null);
  const [activeTechs, setActiveTechs] = useState<Operator[]>([]);
  const [overrideTech, setOverrideTech] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (job?.scheduled_start) setStartLocal(toLocalInput(job.scheduled_start));
    if (job?.scheduled_end) setEndLocal(toLocalInput(job.scheduled_end));
    // Seed once per job window, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  useEffect(() => {
    listOperators()
      .then(data => setActiveTechs(data.operators.filter(o => o.status === "ACTIVE")))
      .catch(() => {
        // The override picker is a convenience; proposals still work.
      });
  }, []);

  const windowIso = () => ({
    start: new Date(startLocal).toISOString(),
    end: new Date(endLocal).toISOString()
  });

  async function findTechs() {
    setBusy(true);
    setError(null);
    try {
      const { start, end } = windowIso();
      const result = await proposeAssignment(item.id, start, end);
      setProposals(result.proposals);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load proposals.");
    } finally {
      setBusy(false);
    }
  }

  async function doAssign(techId: string, reason?: string) {
    setBusy(true);
    setError(null);
    try {
      const window = proposals?.window ?? windowIso();
      await assignTech(
        item.id,
        {
          tech_id: techId,
          scheduled_start: window.start,
          scheduled_end: window.end,
          ...(reason ? { override_reason: reason } : {})
        },
        job?.status === "ASSIGNED"
      );
      setProposals(null);
      setOverrideReason("");
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Assignment failed.");
    } finally {
      setBusy(false);
    }
  }

  const formatWindow = (start: string, end: string) =>
    `${new Date(start).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} – ${new Date(end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;

  return (
    <div className="assignment-panel" data-testid="assignment-panel">
      <h3>Technician assignment</h3>
      {job?.status === "ASSIGNED" && job.tech_name && (
        <p>
          Assigned to <strong>{job.tech_name}</strong>
          {job.scheduled_start && job.scheduled_end
            ? ` · ${formatWindow(job.scheduled_start, job.scheduled_end)}`
            : ""}
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <label>
          Start
          <input
            type="datetime-local"
            aria-label="Job start"
            value={startLocal}
            onChange={e => setStartLocal(e.target.value)}
          />
        </label>
        <label>
          End
          <input
            type="datetime-local"
            aria-label="Job end"
            value={endLocal}
            onChange={e => setEndLocal(e.target.value)}
          />
        </label>
        <button type="button" className="secondary" disabled={busy || !startLocal || !endLocal} onClick={findTechs}>
          Find techs
        </button>
      </div>
      {proposals && (
        <div className="proposals">
          <p className="muted">
            Needs: {proposals.requirement.required_tags.map(qualificationLabel).join(", ")} ·{" "}
            {formatWindow(proposals.window.start, proposals.window.end)}
          </p>
          {proposals.eligible.length === 0 ? (
            <p className="muted">No eligible techs for this window — adjust the window or use an override below.</p>
          ) : (
            proposals.eligible.map((candidate, index) => (
              <div key={candidate.tech_id} className="row" data-testid="proposal-row">
                <span>
                  {index + 1}. <strong>{candidate.name}</strong>{" "}
                  <span className="muted">
                    {candidate.free_at
                      ? `free since ${new Date(candidate.free_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                      : "free all day"}{" "}
                    · {candidate.jobs_that_day} job{candidate.jobs_that_day === 1 ? "" : "s"} that day
                  </span>
                </span>
                <button type="button" className="primary" disabled={busy} onClick={() => doAssign(candidate.tech_id)}>
                  {job?.status === "ASSIGNED" ? "Reassign" : "Assign"}
                </button>
              </div>
            ))
          )}
          {proposals.excluded.length > 0 && (
            <p className="muted">
              Not eligible:{" "}
              {proposals.excluded.map(e => `${e.name} (${e.reasons.join("; ")})`).join(" · ")}
            </p>
          )}
        </div>
      )}
      <div className="row">
        <label>
          Override tech
          <select value={overrideTech} onChange={e => setOverrideTech(e.target.value)} aria-label="Override tech">
            <option value="">Choose a tech…</option>
            {activeTechs.map(tech => (
              <option key={tech.id} value={tech.id}>{tech.name}</option>
            ))}
          </select>
        </label>
        <label>
          Override reason
          <input
            type="text"
            value={overrideReason}
            onChange={e => setOverrideReason(e.target.value)}
            placeholder="Why this tech, despite the scheduler?"
          />
        </label>
        <button
          type="button"
          className="secondary"
          disabled={busy || !overrideTech || !overrideReason.trim() || !startLocal || !endLocal}
          onClick={() => doAssign(overrideTech, overrideReason.trim())}
        >
          Assign with override
        </button>
      </div>
    </div>
  );
}

/** Staff fulfillment card: walks the job from invoiced to service-complete,
 *  one action at a time. Every step lands on the customer's tracking page.
 *  Also owns the final Close case and the customer tracking link. */
function FulfillmentCard({
  item,
  onRefresh
}: {
  item: CaseRecord;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduledAt, setScheduledAt] = useState("");
  const [technician, setTechnician] = useState("");
  const [trackingUrl, setTrackingUrl] = useState<string | null>(null);

  if (!FULFILLMENT_STATES.includes(item.current_state)) return null;

  const stepIndex = FULFILLMENT_FLOW.findIndex(s => s.state === item.current_state);
  const nextStep = stepIndex >= 0 ? FULFILLMENT_FLOW[stepIndex] : null;
  const canClose = item.current_state === "SERVICE_COMPLETED";
  const closed = item.current_state === "CLOSED";

  async function run(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    try {
      await performAction(item.id, action, extra);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function mintTracking() {
    setBusy(true);
    setError(null);
    try {
      const link = await createTrackingLink(item.id);
      setTrackingUrl(`${window.location.origin}${link.path}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the tracking link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ marginBottom: 18 }}>
      <h2>Fulfillment</h2>
      <ol style={{ margin: "8px 0", paddingLeft: 20 }}>
        {FULFILLMENT_FLOW.map((s, i) => {
          const done = closed || canClose || i < stepIndex || (stepIndex === -1);
          const current = i === stepIndex;
          return (
            <li key={s.action} style={{ opacity: done || current ? 1 : 0.55 }}>
              {done ? "✓ " : current ? "→ " : "• "}
              {s.doneLabel}
              {current ? " (next)" : ""}
            </li>
          );
        })}
        <li style={{ opacity: closed || canClose ? 1 : 0.55 }}>
          {closed ? "✓ " : canClose ? "→ " : "• "}Case closed{canClose ? " (next)" : ""}
        </li>
      </ol>
      {error && <p className="error">{error}</p>}
      {!closed && nextStep?.action === "schedule_installation" && (
        <label style={{ display: "block", marginBottom: 8 }}>
          Appointment
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={e => setScheduledAt(e.target.value)}
            style={{ display: "block", marginTop: 4 }}
          />
        </label>
      )}
      {!closed && nextStep?.action === "dispatch_technician" && !item.job?.assigned_tech_id && (
        <label style={{ display: "block", marginBottom: 8 }}>
          Technician name (shown to the customer)
          <input
            type="text"
            value={technician}
            onChange={e => setTechnician(e.target.value)}
            placeholder="e.g. Lou"
            style={{ display: "block", marginTop: 4 }}
          />
        </label>
      )}
      {!closed && nextStep?.action === "dispatch_technician" && item.job?.assigned_tech_id && (
        <p className="muted">
          Dispatching {item.job.tech_name ?? "the assigned tech"} — the customer sees their first name.
        </p>
      )}
      {!closed && (
        <div className="row">
          {nextStep && (
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                run(
                  nextStep.action,
                  nextStep.action === "schedule_installation"
                    ? { scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : "" }
                    : nextStep.action === "dispatch_technician"
                      ? { technician_name: technician }
                      : {}
                )
              }
            >
              {busy ? "Working…" : nextStep.label}
            </button>
          )}
          {canClose && (
            <button className="primary" disabled={busy} onClick={() => run("close_case")}>
              {busy ? "Closing…" : "Close case"}
            </button>
          )}
          <button className="secondary" disabled={busy} onClick={mintTracking}>
            Customer tracking link
          </button>
        </div>
      )}
      {trackingUrl && <CustomerLinkBox url={trackingUrl} />}
      {!closed &&
        ["PARTS_ORDERED", "INSTALLATION_SCHEDULED", "TECH_DISPATCHED"].includes(
          item.current_state
        ) && <AssignmentPanel item={item} onRefresh={onRefresh} />}
      <small>Each step updates the customer's tracking page immediately.</small>
    </section>
  );
}

/** Finger/stylus signature pad. Pointer Events cover touch, mouse, and pen;
 *  `touch-action: none` keeps the page from scrolling mid-stroke on phones. */
function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
  }, []);

  const point = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const emit = () => {
    const canvas = canvasRef.current;
    onChange(canvas ? canvas.toDataURL("image/png") : null);
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        data-testid="signature-pad"
        aria-label="Signature pad — sign with your finger or stylus"
        style={{
          width: "100%",
          height: 180,
          border: "2px dashed #9ca3af",
          borderRadius: 8,
          background: "#ffffff",
          touchAction: "none",
          cursor: "crosshair"
        }}
        onPointerDown={e => {
          const canvas = canvasRef.current;
          const ctx = canvas?.getContext("2d");
          if (!canvas || !ctx) return;
          drawing.current = true;
          canvas.setPointerCapture(e.pointerId);
          const p = point(e);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          // A dot for tap-only "signatures" so they still record ink.
          ctx.lineTo(p.x + 0.5, p.y + 0.5);
          ctx.stroke();
          e.preventDefault();
        }}
        onPointerMove={e => {
          if (!drawing.current) return;
          const ctx = canvasRef.current?.getContext("2d");
          if (!ctx) return;
          const p = point(e);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          e.preventDefault();
        }}
        onPointerUp={e => {
          if (!drawing.current) return;
          drawing.current = false;
          try { canvasRef.current?.releasePointerCapture(e.pointerId); } catch { /* noop */ }
          emit();
        }}
        onPointerCancel={() => { drawing.current = false; }}
      />
      <button
        type="button"
        className="secondary"
        style={{ marginTop: 8 }}
        onClick={() => {
          const canvas = canvasRef.current;
          const ctx = canvas?.getContext("2d");
          if (canvas && ctx) {
            const rect = canvas.getBoundingClientRect();
            ctx.clearRect(0, 0, rect.width, rect.height);
          }
          onChange(null);
        }}
      >
        Clear
      </button>
    </div>
  );
}

/** Client-facing quote: totals only (never supplier cost/margins), channel-
 *  adapted labels, a signature pad, and a typed name. Signing = approval.
 *  After signing it becomes a read-only receipt. Opened by staff on a
 *  phone/tablet and handed to the customer. */
function ClientQuoteView({
  item,
  onRefresh,
  onBack
}: {
  item: CaseRecord;
  onRefresh: () => Promise<void>;
  onBack: () => void;
}) {
  const quote = item.quote;
  const [name, setName] = useState("");
  const [sigUrl, setSigUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const noun = quoteNoun(item.channel);
  const Noun = titleNoun(noun);
  const signed = quote?.status === "APPROVED" && quote.signature != null;
  const expired =
    !!quote && (quote.status === "EXPIRED" || new Date(quote.expires_at).getTime() <= Date.now());

  async function sign() {
    if (!quote || !sigUrl) return;
    setBusy(true);
    setError(null);
    try {
      await performAction(item.id, "sign_quote", {
        name: name.trim(),
        signature_data_url: sigUrl,
        attribution: "client signature captured in-app"
      });
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Signing failed.");
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    if (!quote) return;
    setBusy(true);
    setError(null);
    try {
      await performAction(item.id, "decline_quote");
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decline failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!quote) {
    return (
      <section className="card">
        <h2>{Noun}</h2>
        <p className="muted">No {noun} has been prepared for this case yet.</p>
        <button className="secondary" onClick={onBack}>← Back to case</button>
      </section>
    );
  }

  return (
    <section className="card">
      <p className="eyebrow">R&R Finest Auto Glass — {noun}</p>
      <h1>{item.reference}</h1>
      <p className="muted">
        {quote.snapshot.vehicle.year} {quote.snapshot.vehicle.make} {quote.snapshot.vehicle.model} ·{" "}
        {quote.snapshot.glass_type.toLowerCase().replaceAll("_", " ")} replacement
      </p>
      <dl>
        <dt>Labor</dt><dd>{fmt(quote.snapshot.labor_cents)}</dd>
        <dt>Tax</dt><dd>{fmt(quote.snapshot.tax_cents)}</dd>
        <dt><strong>Total due</strong></dt>
        <dd><strong>{fmt(quote.snapshot.sell_price_cents)}</strong></dd>
      </dl>
      {!signed && !expired && (
        <p className="muted">
          This {noun} is valid until {new Date(quote.expires_at).toLocaleString()}.
        </p>
      )}

      {signed ? (
        <>
          <p className="muted">
            ✓ Signed by <strong>{quote.signature!.name}</strong> on{" "}
            {new Date(quote.signature!.signed_at).toLocaleString()}.
          </p>
          <p className="muted">Thank you — please hand the device back to our staff.</p>
          <button className="secondary" onClick={onBack}>← Back to case</button>
        </>
      ) : expired ? (
        <>
          <p className="error">
            This {noun} expired on {new Date(quote.expires_at).toLocaleString()}. Please
            ask our staff for a new one.
          </p>
          <button className="secondary" onClick={onBack}>← Back to case</button>
        </>
      ) : (
        <>
          <label>
            Printed name
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Type your full name"
              autoComplete="name"
              style={{ display: "block", width: "100%", marginTop: 4 }}
            />
          </label>
          <p className="muted" style={{ marginTop: 12 }}>Sign below with your finger or stylus:</p>
          <SignaturePad onChange={setSigUrl} />
          {error && <p className="error">{error}</p>}
          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="primary"
              disabled={busy || !name.trim() || !sigUrl}
              onClick={sign}
            >
              {busy ? "Signing…" : `Sign ${noun}`}
            </button>
            <button className="secondary" disabled={busy} onClick={decline}>
              Decline
            </button>
            <button className="secondary" disabled={busy} onClick={onBack}>
              Cancel
            </button>
          </div>
          <small>
            By signing you approve the work described above at the total shown.
          </small>
        </>
      )}
    </section>
  );
}

/** Countdown label for a quote deadline ("Valid for 41h 12m" / "Expired"). */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function validityLabel(expiresAt: string, now: number): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return "Expired";
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / (24 * 60));
  const h = Math.floor((totalMin % (24 * 60)) / 60);
  const m = totalMin % 60;
  if (d >= 1) return `Valid for ${d}d ${h}h`;
  if (h >= 1) return `Valid for ${h}h ${m}m`;
  return `Valid for ${m}m`;
}

/**
 * PUBLIC customer quote page (/quote/<token>): the customer opens the link
 * staff sent, reviews the totals, and signs — signing IS the approval.
 * Signing returns a tracking token and hands the customer their tracking
 * link. No staff session exists (or is needed) here.
 */
export function PublicQuotePage({ token }: { token: string }) {
  const [view, setView] = useState<PublicQuoteView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [sigUrl, setSigUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trackingToken, setTrackingToken] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);
  const now = useNow();
  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  useEffect(() => {
    let alive = true;
    getPublicQuote(token)
      .then(v => { if (alive) setView(v); })
      .catch(() => { if (alive) setLoadError("This link is invalid, expired, or has already been used."); });
    return () => { alive = false; };
  }, [token]);

  if (loadError) {
    return (
      <div className="public-wrap">
        <section className="card">
          <p className="eyebrow">R&R Finest Auto Glass</p>
          <h1>Link unavailable</h1>
          <p className="muted">{loadError}</p>
          <p className="muted">Please contact R&R Finest Auto Glass and ask for a new link.</p>
        </section>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="public-wrap">
        <section className="card">Loading…</section>
      </div>
    );
  }

  const noun = view.noun;
  const Noun = titleNoun(noun);
  const trackingUrl = trackingToken ? `${window.location.origin}/track/${trackingToken}` : null;

  async function sign() {
    if (!sigUrl) return;
    setBusy(true);
    setError(null);
    try {
      const res = await signPublicQuote(token, {
        name: name.trim(),
        signature_data_url: sigUrl
      });
      setTrackingToken(res.tracking_token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Signing failed.");
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    setError(null);
    try {
      await declinePublicQuote(token);
      setDeclined(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decline failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="public-wrap">
      <section className="card">
        <p className="eyebrow">R&R Finest Auto Glass — {noun}</p>
        <h1>{view.reference}</h1>
        <p className="muted">
          {view.vehicle.year} {view.vehicle.make} {view.vehicle.model} ·{" "}
          {view.glass_type.toLowerCase().replaceAll("_", " ")} replacement
        </p>
        <dl>
          <dt>Labor</dt><dd>{fmt(view.labor_cents)}</dd>
          <dt>Tax</dt><dd>{fmt(view.tax_cents)}</dd>
          <dt><strong>Total due</strong></dt>
          <dd><strong>{fmt(view.total_cents)}</strong></dd>
        </dl>

        {trackingToken ? (
          <>
            <p>✓ Thank you, {name.trim()} — your {noun} is approved and your invoice has been created.</p>
            <p className="muted">
              Follow your job here — parts ordering, scheduling, your technician, and
              completion will all appear on your tracking page:
            </p>
            {trackingUrl && <CustomerLinkBox url={trackingUrl} />}
            <p>
              <a href={trackingUrl ?? "#"}>Open my tracking page →</a>
            </p>
            <small>Save that link — it's how you'll follow the job to completion.</small>
          </>
        ) : declined || view.status === "DECLINED" ? (
          <>
            <p>You declined this {noun}. Nothing has been charged.</p>
            <p className="muted">If this was a mistake, contact R&R Finest Auto Glass and we'll send a new {noun}.</p>
          </>
        ) : view.status === "APPROVED" ? (
          <>
            <p>
              ✓ Signed by <strong>{view.signed_by}</strong> on{" "}
              {view.signed_at ? new Date(view.signed_at).toLocaleString() : ""}.
            </p>
            <p className="muted">Your job is underway — R&R will keep you posted.</p>
          </>
        ) : view.status === "EXPIRED" ? (
          <>
            <p className="error">
              This {noun} expired on {new Date(view.expires_at).toLocaleString()}.
            </p>
            <p className="muted">Please contact R&R Finest Auto Glass for a new {noun}.</p>
          </>
        ) : (
          <>
            <p className="muted">
              <strong>{validityLabel(view.expires_at, now)}</strong> — until{" "}
              {new Date(view.expires_at).toLocaleString()}.
            </p>
            <label>
              Printed name
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Type your full name"
                autoComplete="name"
                style={{ display: "block", width: "100%", marginTop: 4 }}
              />
            </label>
            <p className="muted" style={{ marginTop: 12 }}>Sign below with your finger or stylus:</p>
            <SignaturePad onChange={setSigUrl} />
            {error && <p className="error">{error}</p>}
            <div className="row" style={{ marginTop: 12 }}>
              <button
                className="primary"
                disabled={busy || !name.trim() || !sigUrl}
                onClick={sign}
              >
                {busy ? "Signing…" : `Sign & approve ${noun}`}
              </button>
              <button className="secondary" disabled={busy} onClick={decline}>
                Decline
              </button>
            </div>
            <small>
              By signing you approve the work described above at the total shown.
              Approving creates your invoice — you will get a tracking link for the job.
            </small>
          </>
        )}
      </section>
    </div>
  );
}

/**
 * PUBLIC tracking page (/track/<token>): the customer follows their job
 * from signed quote to closed — parts ordered, scheduled, technician
 * dispatched, service done. View-only; refreshes every 30 seconds.
 */
export function PublicTrackingPage({ token }: { token: string }) {
  const [view, setView] = useState<PublicTrackingView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  useEffect(() => {
    let alive = true;
    const load = () =>
      getPublicTracking(token)
        .then(v => { if (alive) setView(v); })
        .catch(() => { if (alive) setLoadError("This tracking link is invalid or has expired."); });
    void load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [token]);

  if (loadError) {
    return (
      <div className="public-wrap">
        <section className="card">
          <p className="eyebrow">R&R Finest Auto Glass</p>
          <h1>Link unavailable</h1>
          <p className="muted">{loadError}</p>
          <p className="muted">Please contact R&R Finest Auto Glass and ask for a new tracking link.</p>
        </section>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="public-wrap">
        <section className="card">Loading…</section>
      </div>
    );
  }

  const next = view.milestones.find(m => !m.done);

  return (
    <div className="public-wrap">
      <section className="card">
        <p className="eyebrow">R&R Finest Auto Glass — job tracking</p>
        <h1>{view.reference}</h1>
        {view.vehicle && (
          <p className="muted">
            {view.vehicle.year} {view.vehicle.make} {view.vehicle.model}
            {view.glass_type
              ? ` · ${view.glass_type.toLowerCase().replaceAll("_", " ")} replacement`
              : ""}
          </p>
        )}
        <p style={{ fontSize: 18 }}>
          <strong>{view.status}</strong>
        </p>
        <ol style={{ margin: "12px 0", paddingLeft: 20 }}>
          {view.milestones.map(m => (
            <li
              key={m.key}
              style={{
                opacity: m.done || m.key === next?.key ? 1 : 0.55,
                marginBottom: 6
              }}
            >
              {m.done ? "✓ " : m.key === next?.key ? "→ " : "• "}
              {m.label}
              {m.at && (
                <span className="muted"> — {new Date(m.at).toLocaleString()}</span>
              )}
              {m.detail && (
                <span className="muted">
                  {" "}({m.key === "scheduled"
                    ? new Date(m.detail).toLocaleString()
                    : m.detail})
                </span>
              )}
            </li>
          ))}
        </ol>
        {view.invoice && (
          <dl>
            <dt>Invoice</dt><dd>v{view.invoice.version} — from your approved quote</dd>
            {view.labor_cents != null && (<><dt>Labor</dt><dd>{fmt(view.labor_cents)}</dd></>)}
            {view.tax_cents != null && (<><dt>Tax</dt><dd>{fmt(view.tax_cents)}</dd></>)}
            {view.total_cents != null && (
              <><dt><strong>Total due</strong></dt><dd><strong>{fmt(view.total_cents)}</strong></dd></>
            )}
          </dl>
        )}
        {view.signed_by && (
          <small>
            Quote approved by {view.signed_by}
            {view.signed_at ? ` on ${new Date(view.signed_at).toLocaleString()}` : ""}.
            This page refreshes automatically.
          </small>
        )}
      </section>
    </div>
  );
}

const INTAKE_GLASS_OPTIONS: { id: GlassType; label: string }[] = [
  { id: "WINDSHIELD", label: "Windshield" },
  { id: "BACK_GLASS", label: "Back glass" },
  { id: "DOOR_GLASS", label: "Door glass" },
  { id: "QUARTER_GLASS", label: "Quarter glass" },
  { id: "VENT_GLASS", label: "Vent glass" }
];

/**
 * ISO 3779 VIN check — mirrors apps/api/src/vin-validation.ts so card 1
 * can gate its Continue button exactly the way the server gates the VIN.
 * The server stays the real gate; this is a UX pre-check only.
 */
const VIN_TRANSLITERATION: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9
};
const VIN_POSITION_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

function isValidVin(vin: string): boolean {
  const v = vin.trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = v[i];
    sum += (c >= "0" && c <= "9" ? Number(c) : VIN_TRANSLITERATION[c]) * VIN_POSITION_WEIGHTS[i];
  }
  const remainder = sum % 11;
  return v[8] === (remainder === 10 ? "X" : String(remainder));
}

const INTAKE_STATUS_POLL_MS = 4000;
const INTAKE_TERMINAL_PHASES = ["approved", "declined", "expired"];

/**
 * Live progress on the intake confirmation page: polls the client-safe
 * status projection behind the customer's status token and narrates
 * what's happening behind the scenes (identifying → pricing → quote).
 * The page is COMPLETE when the quote exists: it mints the sign link
 * itself and hands it over as a button — the customer never has to wait
 * for a text or a staff click. Signing is what books the job in (the
 * staff flow then starts at Order parts).
 */
function IntakeLiveStatus({ statusToken }: { statusToken: string }) {
  const [status, setStatus] = useState<PublicIntakeStatus | null>(null);
  const [signUrl, setSignUrl] = useState<string | null>(null);
  const mintingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      let terminal = false;
      try {
        const s = await getPublicIntakeStatus(statusToken);
        if (!cancelled && s && typeof s.phase === "string" && Array.isArray(s.steps)) {
          setStatus(s);
          terminal = INTAKE_TERMINAL_PHASES.includes(s.phase);
        }
      } catch {
        // A failed poll is never the customer's problem: keep waiting.
      }
      if (!cancelled && !terminal) {
        timer = window.setTimeout(poll, INTAKE_STATUS_POLL_MS);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [statusToken]);

  // Once the quote is ready, mint its sign link (once) and show it.
  useEffect(() => {
    if (status?.quote_ready && !signUrl && !mintingRef.current) {
      mintingRef.current = true;
      createIntakeQuoteLink(statusToken)
        .then(link => setSignUrl(`${window.location.origin}${link.path}`))
        .catch(() => {
          // Let a later poll retry the mint.
          mintingRef.current = false;
        });
    }
  }, [status?.quote_ready, signUrl, statusToken]);

  const steps: PublicIntakeStatus["steps"] = status?.steps ?? [
    { key: "received", label: "Request received", done: true },
    { key: "glass", label: "Identifying your glass", done: false },
    { key: "pricing", label: "Pricing your job", done: false },
    { key: "quote", label: "Quote ready to sign", done: false }
  ];

  return (
    <div className="intake-live">
      <h2>What&rsquo;s happening with your request</h2>
      {status?.headline && <p aria-live="polite">{status.headline}</p>}
      <ul className="intake-steps">
        {steps.map(s => (
          <li key={s.key} className={s.done ? "done" : "pending"}>
            <span aria-hidden="true">{s.done ? "✓" : "•"}</span> {s.label}
          </li>
        ))}
      </ul>
      {signUrl && status?.phase === "quote_ready" && (
        <>
          <p>
            <a className="primary intake-sign-btn" href={signUrl}>
              Review &amp; sign your quote
            </a>
          </p>
          <small>
            Signing approves your quote — that&rsquo;s what books your job
            in. No payment is due when you sign.
          </small>
        </>
      )}
      {status?.phase === "approved" && (
        <p>✓ Approved — thank you! We&rsquo;ll text you to schedule your service.</p>
      )}
    </div>
  );
}

/**
 * PUBLIC client intake page (/intake — the QR front door): the customer
 * creates the case themselves. No login, no prices (prices arrive later
 * with the quote). A step-by-step card flow — one card at a time, vehicle
 * first, contact last — and a single POST /public/intake from the final
 * card creates a DIRECT case flagged CLIENT_QR. The customer gets a case
 * reference plus one promise: we'll text a quote link to their mobile.
 */
export function PublicIntakePage() {
  const [step, setStep] = useState(1);
  const [glassType, setGlassType] = useState<GlassType | "">("");
  const [note, setNote] = useState("");
  const [vin, setVin] = useState("");
  const [showYmm, setShowYmm] = useState(false);
  const [year, setYear] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [vinPhoto, setVinPhoto] = useState<File | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    reference: string;
    message: string;
    statusToken: string | null;
  } | null>(null);

  const vinValue = vin.trim().toUpperCase();
  const ymmComplete = Boolean(year.trim() && make.trim() && model.trim());
  // An entered VIN stands alone (YMM hides beside it); with no VIN, the
  // "I don't have the VIN" expander's complete YMM is the vehicle ID.
  const vehicleReady = vinValue ? isValidVin(vinValue) : showYmm && ymmComplete;
  const glassLabel = INTAKE_GLASS_OPTIONS.find(o => o.id === glassType)?.label ?? "";
  const vehicleRecap = vinValue
    ? `VIN ····${vinValue.slice(-4)}`
    : ymmComplete
      ? `${year.trim()} ${make.trim()} ${model.trim()}`
      : "";
  const recap = [vehicleRecap, glassLabel].filter(Boolean).join(" · ");

  function goBack() {
    setError(null);
    setStep(s => Math.max(1, s - 1));
  }

  function goNext() {
    setError(null);
    setStep(s => Math.min(4, s + 1));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    // Cards 1-3 never submit: Enter/advance just moves to the next card
    // when that card's gate is met. The one API call fires from card 4.
    if (step < 4) {
      if (step === 1 && vehicleReady) goNext();
      if (step === 2 && glassType) goNext();
      if (step === 3) goNext();
      return;
    }
    setError(null);
    if (!glassType) {
      setError("Tell us which glass needs service.");
      return;
    }
    if (!vehicleReady) {
      setError("Add your VIN, or your vehicle's year, make and model.");
      return;
    }
    if (!name.trim()) {
      setError("We need your name.");
      return;
    }
    if (!phone.trim()) {
      setError("We need a mobile number to text your quote to.");
      return;
    }
    const form = new FormData();
    form.append("customer_name", name.trim());
    form.append("customer_phone", phone.trim());
    form.append("glass_type", glassType);
    if (note.trim()) form.append("note", note.trim());
    if (vinValue) {
      form.append("vin", vinValue);
    } else {
      if (year.trim()) form.append("year", year.trim());
      if (make.trim()) form.append("make", make.trim());
      if (model.trim()) form.append("model", model.trim());
    }
    if (vinPhoto) form.append("vin_photo", vinPhoto);
    for (const p of photos) form.append("photos", p);
    setBusy(true);
    try {
      const res = await submitPublicIntake(form);
      setConfirmation({
        reference: res.reference,
        message: res.message,
        statusToken: res.status_token ?? null
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong — please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (confirmation) {
    return (
      <div className="public-wrap">
        <section className="card intake-done">
          <p className="eyebrow">R&R Finest Auto Glass</p>
          <h1>✓ Request received</h1>
          <p>
            Your case reference is <strong className="intake-ref">{confirmation.reference}</strong>
          </p>
          <p className="muted">{confirmation.message}</p>
          <p className="muted">
            Save your reference — mention it if you call us. No payment is
            due now; you'll see your price in the quote we text you, and
            nothing moves forward until you approve it.
          </p>
          {confirmation.statusToken && (
            <IntakeLiveStatus statusToken={confirmation.statusToken} />
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="public-wrap">
      {step === 1 && (
        <div className="intake-hero">
          <p className="eyebrow">R&R Finest Auto Glass</p>
          <h1>How can we service your auto glass?</h1>
          <p>
            Tell us about your car and the glass it needs — we'll text you
            a quote link. No account, no payment due now.
          </p>
        </div>
      )}
      <form className="card intake-form" onSubmit={submit}>
        {step === 1 && (
          <>
            <h2>Your vehicle</h2>
            <label>
              VIN
              <input
                className="intake-vin"
                type="text"
                value={vin}
                onChange={e => setVin(e.target.value.toUpperCase())}
                placeholder="17 characters — on the dash by the windshield, or your registration"
                autoComplete="off"
                style={{ display: "block", width: "100%", marginTop: 4 }}
              />
            </label>
            <p className="muted">Your VIN is the fastest way to get your glass right.</p>
            {vinValue && !isValidVin(vinValue) && (
              <p className="muted">A VIN is 17 characters — letters and numbers, no I, O or Q.</p>
            )}
            <label className="intake-scan">
              <span className="intake-scan-btn">📷 Scan VIN (optional)</span>
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={e => setVinPhoto(e.target.files?.[0] ?? null)}
              />
              {vinPhoto && <span className="intake-scan-name">{vinPhoto.name}</span>}
            </label>
            {!vinValue && (
              <button
                type="button"
                className="intake-toggle"
                aria-expanded={showYmm}
                onClick={() => setShowYmm(v => !v)}
              >
                I don't have the VIN
              </button>
            )}
            {showYmm && !vinValue && (
              <div className="intake-ymm">
                <label>
                  Year
                  <input
                    type="text"
                    inputMode="numeric"
                    value={year}
                    onChange={e => setYear(e.target.value)}
                    placeholder="2020"
                    style={{ display: "block", width: "100%", marginTop: 4 }}
                  />
                </label>
                <label>
                  Make
                  <input
                    type="text"
                    value={make}
                    onChange={e => setMake(e.target.value)}
                    placeholder="Honda"
                    style={{ display: "block", width: "100%", marginTop: 4 }}
                  />
                </label>
                <label>
                  Model
                  <input
                    type="text"
                    value={model}
                    onChange={e => setModel(e.target.value)}
                    placeholder="Accord"
                    style={{ display: "block", width: "100%", marginTop: 4 }}
                  />
                </label>
              </div>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <h2>What glass needs service?</h2>
            <div className="intake-glass" role="radiogroup" aria-label="What glass needs service?">
              {INTAKE_GLASS_OPTIONS.map(o => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={glassType === o.id}
                  className={"intake-glass-btn" + (glassType === o.id ? " selected" : "")}
                  onClick={() => setGlassType(o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h2>What happened? (optional)</h2>
            <textarea
              aria-label="What happened? (optional)"
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="e.g. Rock hit the windshield on the highway — crack is spreading"
              rows={3}
              style={{ display: "block", width: "100%", marginTop: 4 }}
            />
            <label>
              Damage photos (optional, up to 6)
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={e => setPhotos(Array.from(e.target.files ?? []).slice(0, 6))}
                style={{ display: "block", marginTop: 4 }}
              />
            </label>
            <p className="muted">Photos help us identify the right glass before we quote.</p>
          </>
        )}

        {step === 4 && (
          <>
            <h2>How do we reach you?</h2>
            {recap && <p className="intake-recap">{recap}</p>}
            <label>
              Your name
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Your full name"
                autoComplete="name"
                style={{ display: "block", width: "100%", marginTop: 4 }}
              />
            </label>
            <label>
              Mobile phone
              <input
                type="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="(617) 555-0123 — we'll text your quote link here"
                autoComplete="tel"
                style={{ display: "block", width: "100%", marginTop: 4 }}
              />
            </label>
            <small>
              Sending this creates your service case with R&R Finest Auto
              Glass. We'll review it and text your quote — you approve it
              before any work (or charge) happens.
            </small>
          </>
        )}

        {error && <p className="error">{error}</p>}

        <div className="intake-nav">
          {step > 1 ? (
            <button type="button" className="intake-back" onClick={goBack}>
              ‹ Back
            </button>
          ) : (
            <span />
          )}
          {step === 1 && (
            <button type="button" className="primary intake-next" disabled={!vehicleReady} onClick={goNext}>
              Continue
            </button>
          )}
          {step === 2 && (
            <button type="button" className="primary intake-next" disabled={!glassType} onClick={goNext}>
              Continue
            </button>
          )}
          {step === 3 && (
            <button type="button" className="primary intake-next" onClick={goNext}>
              {note.trim() || photos.length > 0 ? "Continue" : "Skip"}
            </button>
          )}
          {step === 4 && (
            <button
              type="submit"
              className="primary intake-next"
              disabled={busy || !name.trim() || !phone.trim()}
            >
              {busy ? "Sending…" : "Send request"}
            </button>
          )}
        </div>

        <div className="intake-steps">
          <div className="intake-dots" aria-hidden="true">
            {[1, 2, 3, 4].map(n => (
              <span key={n} className={"intake-dot" + (n === step ? " active" : "")} />
            ))}
          </div>
          <span className="intake-step-text">Step {step} of 4</span>
        </div>
      </form>
    </div>
  );
}
