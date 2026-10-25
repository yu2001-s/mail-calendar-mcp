import { describe, expect, it } from "vitest";
import { connectorInstructions } from "@/mcp/server.js";

const linked = ["main", "work", "personal", "family", "travel"].map((nickname) => ({
  email: `${nickname}.someone.with.a.long.address@gmail.com`,
  nickname,
  services: ["gmail" as const, "calendar" as const],
  addedAt: "2026-10-01T00:00:00Z",
}));

describe("connectorInstructions", () => {
  it("fits in the 2048 characters hosts keep, with every part and five accounts", () => {
    const instructions = connectorInstructions({
      mail: { primaryAddress: "someone.with.a.long.address@custom-domain.example.com" },
      google: {
        linked,
        manageUrl: "https://mail-calendar-mcp.someone-1234ab-account.workers.dev/accounts",
      },
      mailListeners: true,
      uploads: true,
    });
    expect(instructions.length).toBeLessThanOrEqual(2048);
    expect(instructions).toContain("mail_search");
    expect(instructions).toContain("calendar_list_events");
    expect(instructions.endsWith(`${linked.at(-1)!.email}): gmail, calendar.`)).toBe(true);
  });

  it("leaves out the parts that are not configured", () => {
    const instructions = connectorInstructions({});
    expect(instructions).toBe(
      "list_accounts lists every connected account and the addresses each sends from."
    );
  });
});
