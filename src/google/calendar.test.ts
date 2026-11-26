import { describe, expect, it } from "vitest";
import type { GoogleAccounts } from "./accounts.js";
import {
  atOffset,
  Calendar,
  eventView,
  freeWindows,
  inZone,
  shiftTime,
  timeField,
} from "./calendar.js";

function fake(route: (method: string, url: string, body?: any) => any) {
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  const accounts = {
    async request(_email: string, url: string, init: any = {}) {
      const method = init.method ?? "GET";
      calls.push({ method, url, body: init.body });
      return route(method, url, init.body);
    },
    async batch(_email: string, _endpoint: string, requests: any[]) {
      return requests.map((request) => {
        const url = `https://www.googleapis.com${request.path}`;
        calls.push({ method: request.method, url });
        return { status: 200, body: route(request.method, url) };
      });
    },
  };
  return { calendar: new Calendar(accounts as unknown as GoogleAccounts), calls };
}

describe("time helpers", () => {
  it("builds Google time fields", () => {
    expect(timeField("2026-10-08")).toEqual({ date: "2026-10-08" });
    expect(timeField("2026-10-08T14:00+08:00")).toEqual({ dateTime: "2026-10-08T14:00:00+08:00" });
    expect(timeField("2026-10-08T14:00:00", "Asia/Taipei")).toEqual({
      dateTime: "2026-10-08T14:00:00",
      timeZone: "Asia/Taipei",
    });
    expect(() => timeField("2026-10-08T14:00:00")).toThrow(/timeZone/);
    expect(() => timeField("tomorrow")).toThrow(/not YYYY-MM-DD/);
  });

  it("shifts wall-clock times and dates", () => {
    expect(shiftTime("2026-12-31", { days: 1 })).toBe("2027-01-01");
    expect(shiftTime("2026-10-08T23:30:00+08:00", { minutes: 60 })).toBe(
      "2026-10-09T00:30:00+08:00"
    );
    expect(shiftTime("2026-10-08T09:00:00", { minutes: 30 })).toBe("2026-10-08T09:30:00");
  });

  it("shows times in the event's zone or a requested one", () => {
    expect(inZone("2026-10-20T13:00:00Z", "Asia/Taipei")).toBe("2026-10-20T21:00:00+08:00");
    expect(inZone("2026-03-08T12:00:00Z", "America/New_York")).toBe("2026-03-08T08:00:00-04:00");
    expect(inZone("2026-10-20T13:00:00Z", "Not/AZone")).toBe("2026-10-20T13:00:00Z");
    expect(inZone("2026-10-20", "Asia/Taipei")).toBe("2026-10-20");
    expect(atOffset(Date.UTC(2026, 0, 1, 0, 30), -330)).toBe("2025-12-31T19:00:00-05:30");
    const event = {
      id: "e",
      start: { dateTime: "2026-10-20T13:00:00Z", timeZone: "Asia/Taipei" },
      end: { dateTime: "2026-10-20T14:00:00Z", timeZone: "Asia/Taipei" },
    };
    expect(eventView("a", "primary", event)).toMatchObject({
      start: "2026-10-20T21:00:00+08:00",
      end: "2026-10-20T22:00:00+08:00",
    });
    expect(eventView("a", "primary", event, "Europe/London").start).toBe(
      "2026-10-20T14:00:00+01:00"
    );
  });

  it("finds free windows between merged busy times", () => {
    const h = (hours: number) => hours * 3600000;
    expect(
      freeWindows(
        [
          { start: h(10), end: h(11) },
          { start: h(10.5), end: h(12) },
          { start: h(13), end: h(13.25) },
          { start: h(16), end: h(20) },
        ],
        h(9),
        h(17),
        h(0.5)
      )
    ).toEqual([
      { start: h(9), end: h(10) },
      { start: h(12), end: h(13) },
      { start: h(13.25), end: h(16) },
    ]);
  });
});

describe("Calendar", () => {
  it("creates events with sensible defaults", async () => {
    const { calendar, calls } = fake((_m, _u, body) => ({ id: "e1", ...body }));
    await calendar.createEvent(
      "a@gmail.com",
      "primary",
      {
        summary: "Lunch",
        start: "2026-10-08T12:00:00+08:00",
        attendees: ["b@example.com"],
        addGoogleMeet: true,
      },
      "all"
    );
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(url.searchParams.get("sendUpdates")).toBe("all");
    expect(url.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(calls[0].body).toMatchObject({
      summary: "Lunch",
      start: { dateTime: "2026-10-08T12:00:00+08:00" },
      end: { dateTime: "2026-10-08T13:00:00+08:00" },
      attendees: [{ email: "b@example.com" }],
      conferenceData: { createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" } } },
    });
    await calendar.createEvent(
      "a@gmail.com",
      "primary",
      { summary: "Trip", start: "2026-10-08", end: "2026-10-08" },
      "none"
    );
    expect(calls[1].body).toMatchObject({
      start: { date: "2026-10-08" },
      end: { date: "2026-10-09" },
    });
  });

  it("keeps an event's length when only the start moves, and edits guests", async () => {
    const current = {
      id: "e1",
      start: { dateTime: "2026-10-08T10:00:00+08:00" },
      end: { dateTime: "2026-10-08T10:45:00+08:00" },
      attendees: [
        { email: "keep@example.com", responseStatus: "accepted" },
        { email: "drop@example.com", responseStatus: "needsAction" },
      ],
    };
    const { calendar, calls } = fake((method, _u, body) =>
      method === "GET" ? current : { ...current, ...body }
    );
    await calendar.updateEvent(
      "a@gmail.com",
      "primary",
      "e1",
      {
        start: "2026-10-09T15:00:00+08:00",
        addAttendees: ["new@example.com"],
        removeAttendees: ["DROP@example.com"],
      },
      "all"
    );
    const patch = calls.find((call) => call.method === "PATCH")!;
    expect(patch.body.end).toEqual({ date: null, dateTime: "2026-10-09T15:45:00+08:00" });
    expect(patch.body.attendees).toEqual([
      { email: "keep@example.com", responseStatus: "accepted" },
      { email: "new@example.com" },
    ]);
  });

  it("turns an all-day event into a timed one and back, clearing the other kind of time", async () => {
    const allDay = { id: "e1", start: { date: "2026-11-26" }, end: { date: "2026-11-27" } };
    const { calendar, calls } = fake((method, _u, body) =>
      method === "GET" ? allDay : { ...allDay, ...body }
    );
    await calendar.updateEvent(
      "a@gmail.com",
      "primary",
      "e1",
      { start: "2026-11-26T11:19:00+08:00" },
      "none"
    );
    const patch = calls.find((call) => call.method === "PATCH")!;
    // Not the all-day event's 24 hours: a new time gets the default hour.
    expect(patch.body.start).toEqual({ date: null, dateTime: "2026-11-26T11:19:00+08:00" });
    expect(patch.body.end).toEqual({ date: null, dateTime: "2026-11-26T12:19:00+08:00" });

    const timed = {
      id: "e2",
      start: { dateTime: "2026-11-26T11:19:00+08:00", timeZone: "Asia/Taipei" },
      end: { dateTime: "2026-11-26T11:40:00+08:00", timeZone: "Asia/Taipei" },
    };
    const back = fake((method, _u, body) => (method === "GET" ? timed : { ...timed, ...body }));
    await back.calendar.updateEvent(
      "a@gmail.com",
      "primary",
      "e2",
      { start: "2026-11-26" },
      "none"
    );
    const undo = back.calls.find((call) => call.method === "PATCH")!;
    expect(undo.body.start).toEqual({ date: "2026-11-26", dateTime: null, timeZone: null });
    expect(undo.body.end).toEqual({ date: "2026-11-27", dateTime: null, timeZone: null });

    await expect(
      calendar.updateEvent(
        "a@gmail.com",
        "primary",
        "e1",
        { end: "2026-11-26T12:00:00+08:00" },
        "none"
      )
    ).rejects.toThrow(/give start as well/);
    await expect(
      calendar.updateEvent(
        "a@gmail.com",
        "primary",
        "e1",
        { start: "2026-11-26T11:19:00+08:00", end: "2026-11-27" },
        "none"
      )
    ).rejects.toThrow(/same form/);
  });

  it("responds as the invited account", async () => {
    const event = {
      id: "e2",
      attendees: [
        { email: "org@example.com", organizer: true, responseStatus: "accepted" },
        { email: "a@gmail.com", self: true, responseStatus: "needsAction" },
      ],
    };
    const { calendar, calls } = fake((method, _u, body) =>
      method === "GET" ? event : { ...event, ...body }
    );
    const result = await calendar.respond(
      "a@gmail.com",
      "primary",
      "e2",
      "tentative",
      "Might be late",
      "all"
    );
    expect(calls[1].body.attendees[1]).toMatchObject({
      responseStatus: "tentative",
      comment: "Might be late",
    });
    expect(result.myResponseStatus).toBe("tentative");
    const stranger = fake(() => ({ id: "e3", attendees: [{ email: "x@example.com" }] }));
    await expect(
      stranger.calendar.respond("a@gmail.com", "primary", "e3", "accepted", undefined, "all")
    ).rejects.toThrow(/not an invited attendee/);
  });

  it("merges events across accounts and shown calendars", async () => {
    const lists: Record<string, any> = {
      "a@gmail.com": {
        items: [
          { id: "a@gmail.com", primary: true, selected: true },
          { id: "hidden", selected: false },
        ],
      },
      "b@work.com": {
        items: [
          { id: "b@work.com", primary: true, selected: true },
          { id: "team", selected: true },
        ],
      },
    };
    const events: Record<string, any[]> = {
      "a%40gmail.com": [
        {
          id: "a1",
          summary: "Late",
          start: { dateTime: "2026-10-08T18:00:00+08:00" },
          end: { dateTime: "2026-10-08T19:00:00+08:00" },
        },
      ],
      "b%40work.com": [
        {
          id: "b1",
          summary: "Early",
          start: { dateTime: "2026-10-08T09:00:00+08:00" },
          end: { dateTime: "2026-10-08T10:00:00+08:00" },
        },
      ],
      team: [
        {
          id: "t1",
          summary: "Holiday",
          start: { date: "2026-10-08" },
          end: { date: "2026-10-09" },
        },
      ],
    };
    let account = "";
    const calls: string[] = [];
    const accounts = {
      async request(email: string, url: string) {
        account = email;
        calls.push(url);
        return lists[email];
      },
      async batch(email: string, _e: string, requests: any[]) {
        expect(email).toBe(account === email ? email : email);
        return requests.map((request) => {
          calls.push(request.path);
          const id = request.path.match(/calendars\/([^/]+)\/events/)[1];
          return { status: 200, body: { items: events[id] ?? [] } };
        });
      },
    };
    const calendar = new Calendar(accounts as unknown as GoogleAccounts);
    const result = await calendar.listEvents(["a@gmail.com", "b@work.com"], {
      timeMin: "2026-10-08T00:00:00+08:00",
      timeMax: "2026-10-09T00:00:00+08:00",
    });
    expect(result.events.map((event) => event.id)).toEqual(["t1", "b1", "a1"]);
    expect(result.events.map((event) => event.account)).toEqual([
      "b@work.com",
      "b@work.com",
      "a@gmail.com",
    ]);
    expect(calls.some((path) => path.includes("calendars/hidden"))).toBe(false);
    expect(calls.find((path) => path.includes("/events?"))).toContain("singleEvents=true");
    await expect(calendar.listEvents(["a@gmail.com"], { timeMin: "2026-10-08" })).rejects.toThrow(
      /offset/
    );
  });

  it("combines free/busy across accounts", async () => {
    const accounts = {
      async request(email: string, url: string, init: any = {}) {
        if (url.includes("calendarList"))
          return { items: [{ id: email, primary: true, accessRole: "owner" }] };
        expect(init.body.items).toEqual([{ id: email }]);
        const busy =
          email === "a@gmail.com"
            ? [{ start: "2026-10-08T01:00:00Z", end: "2026-10-08T02:00:00Z" }]
            : [{ start: "2026-10-08T01:30:00Z", end: "2026-10-08T03:00:00Z" }];
        return { calendars: { [email]: { busy } } };
      },
    };
    const calendar = new Calendar(accounts as unknown as GoogleAccounts);
    const result = await calendar.findFreeTime(["a@gmail.com", "b@work.com"], {
      timeMin: "2026-10-08T00:00:00Z",
      timeMax: "2026-10-08T05:00:00Z",
      durationMinutes: 60,
    });
    const local = await calendar.findFreeTime(["a@gmail.com"], {
      timeMin: "2026-10-08T08:00:00+08:00",
      timeMax: "2026-10-08T13:00:00+08:00",
    });
    expect(local.busy[0]).toEqual({
      start: "2026-10-08T09:00:00+08:00",
      end: "2026-10-08T10:00:00+08:00",
    });
    expect(result.busy).toEqual([
      { start: "2026-10-08T01:00:00+00:00", end: "2026-10-08T03:00:00+00:00" },
    ]);
    expect(result.free).toEqual([
      { start: "2026-10-08T00:00:00+00:00", end: "2026-10-08T01:00:00+00:00", minutes: 60 },
      { start: "2026-10-08T03:00:00+00:00", end: "2026-10-08T05:00:00+00:00", minutes: 120 },
    ]);
  });
});
