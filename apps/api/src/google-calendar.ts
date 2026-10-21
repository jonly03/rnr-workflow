import type { GoogleOidcConfig } from "./google-auth.js";

/**
 * Google Calendar surface — brief §7.1.
 *
 * Case Core's DB is the scheduler; Google Calendar is only a surface.
 * When a job is assigned (and Google is configured AND the tech granted
 * offline access at sign-in), the assignment writes a job event onto the
 * tech's own calendar; reassignment removes the old event and writes a
 * new one. The seam exists so tests run against a mock and so a missing
 * configuration degrades to a logged no-op.
 *
 * LAW: a calendar failure must NEVER block or fail an assignment. Every
 * caller wraps these calls; providers also swallow their own errors and
 * report them via the return value / console, never by throwing into
 * the assignment path.
 */

export interface CalendarJobEvent {
  techId: string;
  techEmail: string;
  /** The tech's stored Google refresh credential; null = cannot write. */
  refreshCredential: string | null;
  summary: string;
  description: string;
  location: string | null;
  startIso: string;
  endIso: string;
}

export interface CalendarProvider {
  readonly name: string;
  /** Returns the created event id, or null when nothing was written. */
  createJobEvent(event: CalendarJobEvent): Promise<string | null>;
  /** Best-effort removal; resolves even when the event is already gone. */
  deleteJobEvent(input: {
    techId: string;
    refreshCredential: string | null;
    eventId: string;
  }): Promise<void>;
}

/** Default when Google is not configured: assignments proceed, nothing is written. */
export class NoopCalendarProvider implements CalendarProvider {
  readonly name = "noop-calendar";

  async createJobEvent(event: CalendarJobEvent): Promise<string | null> {
    console.log(
      `calendar: no provider configured; skipped job event for tech ${event.techId} (${event.summary})`
    );
    return null;
  }

  async deleteJobEvent(): Promise<void> {}
}

/** In-memory provider for tests: records every call, can be told to fail. */
export class MockCalendarProvider implements CalendarProvider {
  readonly name = "mock-calendar";
  readonly created: (CalendarJobEvent & { eventId: string })[] = [];
  readonly deleted: { techId: string; eventId: string }[] = [];
  failCreates = false;
  private counter = 0;

  async createJobEvent(event: CalendarJobEvent): Promise<string | null> {
    if (this.failCreates) {
      throw new Error("Mock calendar is unavailable.");
    }
    this.counter += 1;
    const eventId = `mock-event-${this.counter}`;
    this.created.push({ ...event, eventId });
    return eventId;
  }

  async deleteJobEvent(input: {
    techId: string;
    refreshCredential: string | null;
    eventId: string;
  }): Promise<void> {
    this.deleted.push({ techId: input.techId, eventId: input.eventId });
  }
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/**
 * Live provider: exchanges the tech's stored refresh credential for an
 * access credential, then writes to the tech's primary calendar.
 * Constructed only when Google OIDC is configured; per-tech it no-ops
 * (with a log) when that tech never granted offline access.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly name = "google-calendar";

  constructor(private readonly config: GoogleOidcConfig) {}

  private async accessCredential(refreshCredential: string): Promise<string | null> {
    try {
      const response = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: refreshCredential,
          grant_type: "refresh_token"
        })
      });
      if (!response.ok) return null;
      const body = (await response.json()) as Record<string, unknown>;
      return typeof body.access_token === "string" ? body.access_token : null;
    } catch {
      return null;
    }
  }

  async createJobEvent(event: CalendarJobEvent): Promise<string | null> {
    if (!event.refreshCredential) {
      console.log(
        `calendar: tech ${event.techId} has no Google grant; skipped job event (${event.summary})`
      );
      return null;
    }
    try {
      const access = await this.accessCredential(event.refreshCredential);
      if (!access) {
        console.error(`calendar: could not refresh access for tech ${event.techId}; skipped job event`);
        return null;
      }
      const response = await fetch(GOOGLE_CALENDAR_EVENTS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          summary: event.summary,
          description: event.description,
          ...(event.location ? { location: event.location } : {}),
          start: { dateTime: event.startIso },
          end: { dateTime: event.endIso }
        })
      });
      if (!response.ok) {
        console.error(`calendar: event create failed for tech ${event.techId} (HTTP ${response.status})`);
        return null;
      }
      const body = (await response.json()) as Record<string, unknown>;
      return typeof body.id === "string" ? body.id : null;
    } catch (error) {
      console.error(`calendar: event create threw for tech ${event.techId}:`, error);
      return null;
    }
  }

  async deleteJobEvent(input: {
    techId: string;
    refreshCredential: string | null;
    eventId: string;
  }): Promise<void> {
    if (!input.refreshCredential) return;
    try {
      const access = await this.accessCredential(input.refreshCredential);
      if (!access) return;
      await fetch(`${GOOGLE_CALENDAR_EVENTS_URL}/${encodeURIComponent(input.eventId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${access}` }
      });
    } catch (error) {
      console.error(`calendar: event delete threw for tech ${input.techId}:`, error);
    }
  }
}
