/**
 * Google Calendar through its REST API, across every linked account:
 * calendars, events, invitations and free time.
 */
import type { GoogleAccounts } from "./accounts.js";

const API = "https://www.googleapis.com/calendar/v3";
const BATCH = "https://www.googleapis.com/batch/calendar/v3";
const MAX_DESCRIPTION_CHARS = 8000;

export type SendUpdates = "all" | "externalOnly" | "none";

export interface EventInput {
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  attendees?: string[];
  optionalAttendees?: string[];
  recurrence?: string[];
  addGoogleMeet?: boolean;
  reminderMinutes?: number[];
  visibility?: "default" | "public" | "private" | "confidential";
  showAs?: "busy" | "free";
  colorId?: string;
}

interface GoogleTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** A Google time field from `YYYY-MM-DD` (all day) or an ISO 8601 date-time. */
export function timeField(value: string, timeZone?: string): GoogleTime {
  if (DATE.test(value)) return { date: value };
  const match = DATE_TIME.exec(value);
  if (!match) {
    throw new Error(
      `"${value}" is not YYYY-MM-DD or an ISO date-time such as 2026-10-08T14:00:00+08:00.`
    );
  }
  if (!match[7] && !timeZone) {
    throw new Error(
      `"${value}" has no UTC offset; add one or give timeZone (an IANA name such as Asia/Taipei).`
    );
  }
  const dateTime = match[6] === undefined ? value.replace(/(T\d{2}:\d{2})/, "$1:00") : value;
  return { dateTime, ...(timeZone && { timeZone }) };
}

/** Shift the wall-clock fields of a date or date-time, keeping its offset. */
export function shiftTime(value: string, { days = 0, minutes = 0 }): string {
  if (DATE.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }
  const match = DATE_TIME.exec(value);
  if (!match) throw new Error(`"${value}" is not a date-time.`);
  const [, y, mo, d, h, mi, s] = match;
  const shifted = new Date(Date.UTC(+y, +mo - 1, +d + days, +h, +mi + minutes, +(s ?? 0)));
  return `${shifted.toISOString().slice(0, 19)}${match[7] ?? ""}`;
}

/** An RFC 3339 bound for event queries; dates must carry an offset. */
function bound(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  const match = DATE_TIME.exec(value);
  if (!match?.[7]) {
    throw new Error(
      `${name} must be an ISO date-time with a UTC offset, such as 2026-10-08T00:00:00+08:00.`
    );
  }
  return value;
}

function startMillis(event: { start?: GoogleTime }): number {
  const value = event.start?.dateTime ?? (event.start?.date ? `${event.start.date}T00:00:00Z` : "");
  return Date.parse(value) || 0;
}

/** Minutes `timeZone` is ahead of UTC at `date`. */
function zoneOffset(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  const wall = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second")
  );
  return Math.round((wall - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** An instant as an ISO date-time with a fixed offset in minutes, e.g. +08:00. */
export function atOffset(ms: number, offsetMinutes: number): string {
  const local = new Date(ms + offsetMinutes * 60000).toISOString().slice(0, 19);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${local}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** A Google date-time shown in `timeZone` (an IANA name); unchanged when that fails. */
export function inZone(
  value: string | undefined,
  timeZone: string | undefined
): string | undefined {
  if (!value || !timeZone || !value.includes("T")) return value;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  try {
    return atOffset(ms, zoneOffset(new Date(ms), timeZone));
  } catch {
    return value;
  }
}

/** The offset in minutes of an ISO date-time such as ...+08:00 or ...Z. */
function offsetOf(value: string): number {
  const match = /(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match || match[1] === "Z") return 0;
  return (match[2] === "-" ? -1 : 1) * (Number(match[3]) * 60 + Number(match[4]));
}

/**
 * An event in a compact shape. Times are given in `timeZone` when asked for,
 * otherwise in the event's own zone, not the calendar's (often UTC).
 */
export function eventView(account: string, calendarId: string, event: any, timeZone?: string) {
  const self = event.attendees?.find((attendee: any) => attendee.self);
  const description: string | undefined = event.description;
  return {
    account,
    calendarId,
    id: event.id,
    status: event.status,
    summary: event.summary ?? "(no title)",
    ...(description && {
      description: description.slice(0, MAX_DESCRIPTION_CHARS),
      ...(description.length > MAX_DESCRIPTION_CHARS && { descriptionTruncated: true }),
    }),
    location: event.location,
    start: inZone(event.start?.dateTime, timeZone ?? event.start?.timeZone) ?? event.start?.date,
    end: inZone(event.end?.dateTime, timeZone ?? event.end?.timeZone) ?? event.end?.date,
    allDay: Boolean(event.start?.date),
    timeZone: event.start?.timeZone,
    htmlLink: event.htmlLink,
    organizer: event.organizer?.email,
    attendees: event.attendees?.map((attendee: any) => ({
      email: attendee.email,
      displayName: attendee.displayName,
      responseStatus: attendee.responseStatus,
      ...(attendee.optional && { optional: true }),
      ...(attendee.organizer && { organizer: true }),
      ...(attendee.self && { self: true }),
    })),
    myResponseStatus: self?.responseStatus,
    meetLink:
      event.hangoutLink ??
      event.conferenceData?.entryPoints?.find((point: any) => point.entryPointType === "video")
        ?.uri,
    recurringEventId: event.recurringEventId,
    recurrence: event.recurrence,
    visibility: event.visibility,
    showAs: event.transparency === "transparent" ? "free" : "busy",
    eventType: event.eventType,
  };
}

/** Overlapping intervals merged, in start order. */
export function mergedIntervals(busy: Array<{ start: number; end: number }>) {
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of [...busy].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/** The gaps of at least `minMs` between busy intervals (ms) within [from, to). */
export function freeWindows(
  busy: Array<{ start: number; end: number }>,
  from: number,
  to: number,
  minMs: number
): Array<{ start: number; end: number }> {
  const free: Array<{ start: number; end: number }> = [];
  let cursor = from;
  for (const interval of mergedIntervals(busy)) {
    if (cursor >= to) break;
    if (Math.min(interval.start, to) - cursor >= minMs) {
      free.push({ start: cursor, end: Math.min(interval.start, to) });
    }
    cursor = Math.max(cursor, interval.end);
  }
  if (to - cursor >= minMs) free.push({ start: cursor, end: to });
  return free;
}

export class Calendar {
  constructor(private readonly accounts: GoogleAccounts) {}

  private url(path: string, query: Record<string, unknown> = {}): string {
    const url = new URL(`${API}/${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private calendarPath(calendarId: string): string {
    return `calendars/${encodeURIComponent(calendarId)}`;
  }

  async listCalendars(account: string) {
    const data = await this.accounts.request(
      account,
      this.url("users/me/calendarList", { maxResults: 250 })
    );
    return (data.items ?? []).map((item: any) => ({
      account,
      id: item.id,
      summary: item.summaryOverride ?? item.summary,
      primary: Boolean(item.primary),
      accessRole: item.accessRole,
      timeZone: item.timeZone,
      selected: Boolean(item.selected),
      ...(item.hidden && { hidden: true }),
    }));
  }

  /** Calendars shown in the user's Google Calendar, plus the primary one. */
  private async shownCalendars(
    account: string
  ): Promise<Array<{ id: string; accessRole: string }>> {
    const calendars = await this.listCalendars(account);
    return calendars.filter((item: any) => item.primary || (item.selected && !item.hidden));
  }

  async listEvents(
    accounts: string[],
    args: {
      calendarId?: string;
      timeMin?: string;
      timeMax?: string;
      query?: string;
      maxResults?: number;
      pageToken?: string;
      timeZone?: string;
    }
  ) {
    const maxResults = args.maxResults ?? 50;
    const query = {
      singleEvents: true,
      orderBy: "startTime",
      timeMin: bound(args.timeMin, "timeMin") ?? new Date().toISOString(),
      timeMax: bound(args.timeMax, "timeMax"),
      q: args.query,
      timeZone: args.timeZone,
      maxResults,
    };
    if (accounts.length === 1 && args.calendarId) {
      const [account] = accounts;
      const data = await this.accounts.request(
        account,
        this.url(`${this.calendarPath(args.calendarId)}/events`, {
          ...query,
          pageToken: args.pageToken,
        })
      );
      return {
        events: (data.items ?? []).map((event: any) =>
          eventView(account, args.calendarId!, event, args.timeZone)
        ),
        nextPageToken: data.nextPageToken ?? null,
        timeZone: data.timeZone,
      };
    }
    if (args.pageToken) throw new Error("pageToken needs one account and a calendarId.");
    const events: ReturnType<typeof eventView>[] = [];
    const errors: Array<{ account: string; calendarId?: string; error: string }> = [];
    let more = false;
    await Promise.all(
      accounts.map(async (account) => {
        try {
          const calendars = args.calendarId
            ? [{ id: args.calendarId }]
            : await this.shownCalendars(account);
          const responses = await this.accounts.batch(
            account,
            BATCH,
            calendars.map((calendar) => ({
              method: "GET" as const,
              path: this.url(`${this.calendarPath(calendar.id)}/events`, query).slice(
                "https://www.googleapis.com".length
              ),
            }))
          );
          responses.forEach((response, index) => {
            const calendarId = calendars[index].id;
            if (response.status !== 200) {
              errors.push({
                account,
                calendarId,
                error: response.body?.error?.message ?? `HTTP ${response.status}`,
              });
              return;
            }
            if (response.body.nextPageToken) more = true;
            for (const event of response.body.items ?? [])
              events.push(eventView(account, calendarId, event, args.timeZone));
          });
        } catch (error) {
          errors.push({ account, error: error instanceof Error ? error.message : String(error) });
        }
      })
    );
    events.sort(
      (a, b) =>
        startMillis({ start: toGoogle(a.start, a.allDay) }) -
        startMillis({ start: toGoogle(b.start, b.allDay) })
    );
    return {
      accounts,
      events: events.slice(0, maxResults),
      truncated: more || events.length > maxResults,
      ...(errors.length && { errors }),
    };
  }

  async getEvent(account: string, calendarId: string, eventId: string) {
    const event = await this.accounts.request(
      account,
      this.url(`${this.calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`)
    );
    return eventView(account, calendarId, event);
  }

  private eventBody(input: EventInput, current?: any) {
    const body: Record<string, unknown> = {};
    if (input.summary !== undefined) body.summary = input.summary;
    if (input.description !== undefined) body.description = input.description;
    if (input.location !== undefined) body.location = input.location;
    // A PATCH merges start and end into the stored ones, so moving between all-day and timed
    // must clear the other kind of time, or Google refuses an event with both.
    const replacing = (time: GoogleTime) =>
      !current
        ? time
        : time.date
          ? { ...time, dateTime: null, timeZone: null }
          : { date: null, ...time };
    if (input.start) {
      const allDay = DATE.test(input.start);
      let end = input.end;
      if (!end) {
        // Keep the current length when only the start moves; otherwise a day or an hour.
        const length =
          current?.start && current?.end && Boolean(current.start.date) === allDay
            ? startMillis({ start: current.end }) - startMillis({ start: current.start })
            : 0;
        end = allDay
          ? shiftTime(input.start, { days: Math.max(1, Math.round(length / 86400000)) })
          : shiftTime(input.start, { minutes: length > 0 ? Math.round(length / 60000) : 60 });
      } else if (allDay && DATE.test(end) && end <= input.start) {
        // Google's all-day end date is exclusive.
        end = shiftTime(input.start, { days: 1 });
      }
      if (DATE.test(end) !== allDay) {
        throw new Error(
          "Give start and end in the same form: both YYYY-MM-DD, or both date-times."
        );
      }
      body.start = replacing(timeField(input.start, input.timeZone));
      body.end = replacing(timeField(end, input.timeZone));
    } else if (input.end) {
      if (current?.start && DATE.test(input.end) !== Boolean(current.start.date)) {
        throw new Error(
          "To switch between all day and a time, give start as well as end, both in the new form."
        );
      }
      body.end = timeField(input.end, input.timeZone ?? current?.end?.timeZone);
    }
    if (input.attendees !== undefined || input.optionalAttendees !== undefined) {
      const required = input.attendees ?? [];
      const optional = input.optionalAttendees ?? [];
      body.attendees = [
        ...required.map((email) => ({ email })),
        ...optional.map((email) => ({ email, optional: true })),
      ];
    }
    if (input.recurrence !== undefined) body.recurrence = input.recurrence;
    if (input.reminderMinutes !== undefined) {
      body.reminders = {
        useDefault: false,
        overrides: input.reminderMinutes.map((minutes) => ({ method: "popup", minutes })),
      };
    }
    if (input.visibility) body.visibility = input.visibility;
    if (input.showAs) body.transparency = input.showAs === "free" ? "transparent" : "opaque";
    if (input.colorId) body.colorId = input.colorId;
    if (input.addGoogleMeet) {
      body.conferenceData = {
        createRequest: {
          requestId: crypto.randomUUID(),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
    }
    return body;
  }

  async createEvent(
    account: string,
    calendarId: string,
    input: EventInput,
    sendUpdates: SendUpdates
  ) {
    if (!input.start) throw new Error("Give a start.");
    const event = await this.accounts.request(
      account,
      this.url(`${this.calendarPath(calendarId)}/events`, {
        sendUpdates,
        conferenceDataVersion: input.addGoogleMeet ? 1 : undefined,
      }),
      { method: "POST", body: { summary: "", ...this.eventBody(input) } }
    );
    return eventView(account, calendarId, event);
  }

  async updateEvent(
    account: string,
    calendarId: string,
    eventId: string,
    input: EventInput & { addAttendees?: string[]; removeAttendees?: string[] },
    sendUpdates: SendUpdates
  ) {
    const path = `${this.calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`;
    const current = await this.accounts.request(account, this.url(path));
    const body = this.eventBody(input, current);
    if (input.addAttendees?.length || input.removeAttendees?.length) {
      const removed = new Set((input.removeAttendees ?? []).map((email) => email.toLowerCase()));
      const base: any[] = (body.attendees as any[]) ?? current.attendees ?? [];
      const kept = base.filter((attendee) => !removed.has(String(attendee.email).toLowerCase()));
      const known = new Set(kept.map((attendee) => String(attendee.email).toLowerCase()));
      for (const email of input.addAttendees ?? []) {
        if (!known.has(email.toLowerCase())) kept.push({ email });
      }
      body.attendees = kept;
    } else if (body.attendees) {
      // Keep response states of attendees who stay on the event.
      const previous = new Map(
        (current.attendees ?? []).map((attendee: any) => [
          String(attendee.email).toLowerCase(),
          attendee,
        ])
      );
      body.attendees = (body.attendees as any[]).map((attendee) => ({
        ...(previous.get(attendee.email.toLowerCase()) as object | undefined),
        ...attendee,
      }));
    }
    if (!Object.keys(body).length) throw new Error("Give at least one field to change.");
    const event = await this.accounts.request(
      account,
      this.url(path, { sendUpdates, conferenceDataVersion: input.addGoogleMeet ? 1 : undefined }),
      { method: "PATCH", body }
    );
    return eventView(account, calendarId, event);
  }

  async deleteEvent(
    account: string,
    calendarId: string,
    eventId: string,
    sendUpdates: SendUpdates
  ) {
    await this.accounts.request(
      account,
      this.url(`${this.calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`, {
        sendUpdates,
      }),
      { method: "DELETE" }
    );
    return { account, calendarId, eventId, success: true };
  }

  async respond(
    account: string,
    calendarId: string,
    eventId: string,
    response: "accepted" | "declined" | "tentative",
    comment: string | undefined,
    sendUpdates: SendUpdates
  ) {
    const path = `${this.calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`;
    const current = await this.accounts.request(account, this.url(path));
    const attendees: any[] = current.attendees ?? [];
    const self = attendees.find((attendee) => attendee.self);
    if (!self) throw new Error(`${account} is not an invited attendee of this event.`);
    self.responseStatus = response;
    if (comment !== undefined) self.comment = comment;
    const event = await this.accounts.request(account, this.url(path, { sendUpdates }), {
      method: "PATCH",
      body: { attendees },
    });
    return eventView(account, calendarId, event);
  }

  async findFreeTime(
    accounts: string[],
    args: { timeMin: string; timeMax: string; durationMinutes?: number; calendarIds?: string[] }
  ) {
    const timeMin = bound(args.timeMin, "timeMin")!;
    const timeMax = bound(args.timeMax, "timeMax")!;
    const from = Date.parse(timeMin);
    const to = Date.parse(timeMax);
    if (!(to > from)) throw new Error("timeMax must be after timeMin.");
    const busy: Array<{ start: number; end: number }> = [];
    const checked: Array<{ account: string; calendarId: string; busy: number; error?: string }> =
      [];
    await Promise.all(
      accounts.map(async (account) => {
        try {
          const ids =
            args.calendarIds ??
            (await this.shownCalendars(account))
              .filter((calendar) => ["owner", "writer"].includes(calendar.accessRole))
              .map((calendar) => calendar.id);
          const data = await this.accounts.request(account, `${API}/freeBusy`, {
            method: "POST",
            body: { timeMin, timeMax, items: ids.map((id) => ({ id })) },
          });
          for (const [calendarId, info] of Object.entries<any>(data.calendars ?? {})) {
            const intervals = (info.busy ?? []).map((item: any) => ({
              start: Date.parse(item.start),
              end: Date.parse(item.end),
            }));
            busy.push(...intervals);
            checked.push({
              account,
              calendarId,
              busy: intervals.length,
              ...(info.errors?.length && {
                error: info.errors.map((e: any) => e.reason).join(", "),
              }),
            });
          }
        } catch (error) {
          checked.push({
            account,
            calendarId: "*",
            busy: 0,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );
    const minMs = (args.durationMinutes ?? 30) * 60000;
    // Answer in the offset the question was asked in.
    const offset = offsetOf(timeMin);
    const iso = (ms: number) => atOffset(ms, offset);
    return {
      timeMin,
      timeMax,
      durationMinutes: args.durationMinutes ?? 30,
      free: freeWindows(busy, from, to, minMs).map((window) => ({
        start: iso(window.start),
        end: iso(window.end),
        minutes: Math.round((window.end - window.start) / 60000),
      })),
      busy: mergedIntervals(busy)
        .filter((interval) => interval.end > from && interval.start < to)
        .map((interval) => ({ start: iso(interval.start), end: iso(interval.end) })),
      calendars: checked,
    };
  }
}

function toGoogle(value: string | undefined, allDay: boolean): GoogleTime {
  return allDay ? { date: value } : { dateTime: value };
}
