/**
 * Google Calendar tools for every linked Google account, prefixed calendar_
 * and taking an `account`, and the account nicknames they and the mail
 * tools accept. Gmail is served by the mail_* tools in src/mail/.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, toolResult } from "../mcp/tooling.js";
import { accountName, type GoogleAccounts, type GoogleAccountSummary } from "./accounts.js";
import { Calendar } from "./calendar.js";

type Kind = "read" | "write" | "destructive";

/** How a host should use the Google tools; read once per session. */
export function googleInstructions(accounts: GoogleAccountSummary[], manageUrl: string): string {
  // The account list grows with every link, so it comes last.
  const linked = accounts.length
    ? `Accounts are linked and removed at ${manageUrl}. Linked Google accounts: ${accounts.map((a) => `${accountName(a)}: ${a.services.join(", ") || "no services"}`).join("; ")}.`
    : `No Google account is linked yet; accounts are linked at ${manageUrl}.`;
  return `calendar_* tools serve Google Calendar for every linked Google account. They take account=<address or nickname>: without it, calendar_list_events, calendar_list_calendars and calendar_find_free_time cover every account, and the others need it when several are linked. Event IDs only work with the account they came from. ${linked}`;
}

export function registerGoogleTools(server: McpServer, accounts: GoogleAccounts): void {
  const calendar = new Calendar(accounts);

  function tool(
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    kind: Kind,
    fn: (args: any) => Promise<unknown>
  ) {
    registerTool(
      server,
      name,
      {
        description,
        inputSchema,
        annotations: {
          readOnlyHint: kind === "read",
          destructiveHint: kind === "destructive",
          idempotentHint: kind === "read",
          openWorldHint: true,
        },
      },
      (args) => toolResult(() => fn(args))
    );
  }

  // Each field gets its own schema instance: a shared one is emitted as a JSON
  // Schema $ref, which strict host validators may not resolve.
  // Accounts are named by address or nickname, so these are not email fields.
  const account = () =>
    z
      .string()
      .min(1)
      .max(254)
      .optional()
      .describe(
        "Linked Google address or its nickname (see list_accounts). Required when several Google accounts are linked."
      );
  const anyAccount = () =>
    z
      .string()
      .min(1)
      .max(254)
      .optional()
      .describe(
        "Linked Google address or its nickname (see list_accounts). Omit to cover every linked account."
      );
  const id = (description: string) => z.string().min(1).describe(description);
  tool(
    "set_account_nickname",
    "Give a linked Google account a nickname such as work or personal, usable as an account in the mail_* and calendar_* tools. An empty nickname removes it. Only when the user asks.",
    {
      account: z.string().min(1).max(254).describe("The account's address or current nickname."),
      nickname: z
        .string()
        .max(32)
        .describe("1-32 letters, digits, spaces, dots, dashes or underscores; empty to remove."),
    },
    "write",
    async (args) => ({
      success: true,
      account: await accounts.setNickname(args.account, args.nickname),
    })
  );

  // ------------------------------------------------------------- Calendar

  const calendarId = () =>
    z
      .string()
      .min(1)
      .optional()
      .describe("Calendar ID from calendar_list_calendars; defaults to the primary calendar.");
  const sendUpdates = () =>
    z
      .enum(["all", "externalOnly", "none"])
      .optional()
      .describe("Who Google emails about the change. Default all.");
  const eventFields = {
    summary: z.string().max(1024).optional().describe("Title."),
    start: z
      .string()
      .optional()
      .describe(
        "YYYY-MM-DD for all-day events, or an ISO date-time such as 2026-10-08T14:00:00+08:00 (without an offset, give timeZone)."
      ),
    end: z
      .string()
      .optional()
      .describe(
        "Same form as start. Defaults to one hour after start, or one day for all-day events. An all-day end date is exclusive."
      ),
    timeZone: z.string().optional().describe("IANA time zone, e.g. Asia/Taipei."),
    description: z.string().max(8000).optional(),
    location: z.string().max(1024).optional(),
    attendees: z
      .array(z.string().email())
      .max(100)
      .optional()
      .describe("Required attendees; replaces the list. Invitations are emailed per sendUpdates."),
    optionalAttendees: z.array(z.string().email()).max(100).optional(),
    recurrence: z
      .array(z.string())
      .max(10)
      .optional()
      .describe('RFC 5545 lines, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10"].'),
    addGoogleMeet: z.boolean().optional().describe("Attach a new Google Meet link."),
    reminderMinutes: z
      .array(z.number().int().min(0).max(40320))
      .max(5)
      .optional()
      .describe("Popup reminders, minutes before start; [] for none. Omit for calendar defaults."),
    visibility: z.enum(["default", "public", "private", "confidential"]).optional(),
    showAs: z.enum(["busy", "free"]).optional(),
    colorId: z.string().optional().describe("Google event color ID, 1-11."),
  };

  tool(
    "calendar_list_calendars",
    "List Google calendars with their IDs, access roles and whether they are shown. Without account, lists every linked account's calendars.",
    { account: anyAccount() },
    "read",
    async (args) => {
      const targets = await accounts.resolveAll(args.account, "calendar");
      const lists = await Promise.all(
        targets.map((email) =>
          calendar
            .listCalendars(email)
            .catch((error: Error) => [{ account: email, error: error.message }])
        )
      );
      return { calendars: lists.flat() };
    }
  );
  tool(
    "calendar_list_events",
    "List Google Calendar events in a time range, expanded into single occurrences and sorted by start. Without account, merges every linked account's shown calendars; without calendarId, covers each account's shown calendars. Starts from now when timeMin is omitted. Each event carries its account and calendarId for follow-up calls.",
    {
      account: anyAccount(),
      calendarId: z.string().optional().describe("One calendar; default: all shown calendars."),
      timeMin: z
        .string()
        .optional()
        .describe("Earliest end time, ISO date-time with offset, e.g. 2026-10-08T00:00:00+08:00."),
      timeMax: z.string().optional().describe("Latest start time, ISO date-time with offset."),
      query: z
        .string()
        .optional()
        .describe("Free-text search over titles, descriptions, locations and attendees."),
      maxResults: z.number().int().min(1).max(250).optional().describe("Default 50."),
      pageToken: z.string().optional().describe("Needs account and calendarId."),
      timeZone: z
        .string()
        .optional()
        .describe("IANA zone for returned times; default each calendar's."),
    },
    "read",
    async (args) => calendar.listEvents(await accounts.resolveAll(args.account, "calendar"), args)
  );
  tool(
    "calendar_get_event",
    "Read one Google Calendar event with attendees, responses and conference link.",
    { account: account(), calendarId: calendarId(), eventId: id("Event ID.") },
    "read",
    async (args) =>
      calendar.getEvent(
        await accounts.resolve(args.account, "calendar"),
        args.calendarId ?? "primary",
        args.eventId
      )
  );
  tool(
    "calendar_create_event",
    "Create a Google Calendar event. Confirm attendees with the user first: invitations are emailed (sendUpdates). For several Google accounts, ask which calendar to use when unclear.",
    {
      account: account(),
      calendarId: calendarId(),
      ...eventFields,
      summary: z.string().min(1).max(1024).describe("Title."),
      start: eventFields.start.unwrap().describe(eventFields.start.description!),
      sendUpdates: sendUpdates(),
    },
    "write",
    async (args) =>
      calendar.createEvent(
        await accounts.resolve(args.account, "calendar"),
        args.calendarId ?? "primary",
        args,
        args.sendUpdates ?? "all"
      )
  );
  tool(
    "calendar_update_event",
    "Change a Google Calendar event; only given fields change. Moving start alone keeps the event's length. addAttendees/removeAttendees edit the guest list; attendees replaces it. For a recurring event, an occurrence ID changes that occurrence and the series ID (recurringEventId) changes the series.",
    {
      account: account(),
      calendarId: calendarId(),
      eventId: id("Event ID."),
      ...eventFields,
      addAttendees: z.array(z.string().email()).max(100).optional(),
      removeAttendees: z.array(z.string().email()).max(100).optional(),
      sendUpdates: sendUpdates(),
    },
    "write",
    async (args) =>
      calendar.updateEvent(
        await accounts.resolve(args.account, "calendar"),
        args.calendarId ?? "primary",
        args.eventId,
        args,
        args.sendUpdates ?? "all"
      )
  );
  tool(
    "calendar_delete_event",
    "Delete a Google Calendar event (or cancel it for its guests). Only when the user asked.",
    {
      account: account(),
      calendarId: calendarId(),
      eventId: id("Event ID."),
      sendUpdates: sendUpdates(),
    },
    "destructive",
    async (args) =>
      calendar.deleteEvent(
        await accounts.resolve(args.account, "calendar"),
        args.calendarId ?? "primary",
        args.eventId,
        args.sendUpdates ?? "all"
      )
  );
  tool(
    "calendar_respond_to_event",
    "Accept, decline or tentatively accept an invitation as the given account; the organizer is notified per sendUpdates. Only when the user asked.",
    {
      account: account(),
      calendarId: calendarId(),
      eventId: id("Event ID."),
      response: z.enum(["accepted", "declined", "tentative"]),
      comment: z.string().max(1000).optional().describe("Note to the organizer."),
      sendUpdates: sendUpdates(),
    },
    "write",
    async (args) =>
      calendar.respond(
        await accounts.resolve(args.account, "calendar"),
        args.calendarId ?? "primary",
        args.eventId,
        args.response,
        args.comment,
        args.sendUpdates ?? "all"
      )
  );
  tool(
    "calendar_find_free_time",
    "Find time free on all of the user's calendars between timeMin and timeMax, using Google's free/busy data (events shown as free are ignored). Without account, combines every linked account. Returns free windows of at least durationMinutes and the merged busy times; working hours are not applied.",
    {
      account: anyAccount(),
      timeMin: z.string().describe("ISO date-time with offset."),
      timeMax: z.string().describe("ISO date-time with offset."),
      durationMinutes: z.number().int().min(5).max(1440).optional().describe("Default 30."),
      calendarIds: z
        .array(z.string())
        .max(50)
        .optional()
        .describe(
          "Only these calendars (needs account); default: calendars the account owns or edits."
        ),
    },
    "read",
    async (args) => {
      if (args.calendarIds && !args.account) throw new Error("calendarIds needs an account.");
      return calendar.findFreeTime(await accounts.resolveAll(args.account, "calendar"), args);
    }
  );
}
