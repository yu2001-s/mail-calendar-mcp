/**
 * Tests for SMTP configuration and raw submission. The transporter is injected,
 * so nothing touches the network.
 */

import { describe, it, expect, vi } from "vitest";
import {
  resolveSmtpConfig,
  sendRawViaSmtp,
  smtpSession,
  SMTP_ENV,
  type SmtpConfig,
} from "./smtpMailer.js";

const baseEnv = {
  [SMTP_ENV.host]: "smtp.example.com",
  [SMTP_ENV.user]: "alice@example.com",
  [SMTP_ENV.password]: "s3cret",
} as NodeJS.ProcessEnv;

const testConfig: SmtpConfig = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  user: "alice@example.com",
  pass: "s3cret",
  from: "alice@example.com",
  allowedFrom: ["team@example.com"],
};

describe("resolveSmtpConfig", () => {
  it("resolves host/user/password from env with sensible defaults", () => {
    const cfg = resolveSmtpConfig(baseEnv);
    expect(cfg.host).toBe("smtp.example.com");
    expect(cfg.user).toBe("alice@example.com");
    expect(cfg.pass).toBe("s3cret");
    expect(cfg.port).toBe(587); // STARTTLS default
    expect(cfg.secure).toBe(false);
    expect(cfg.from).toBe("alice@example.com"); // defaults to user
  });

  it("defaults to port 465 when secure is set", () => {
    const cfg = resolveSmtpConfig({ ...baseEnv, [SMTP_ENV.secure]: "true" });
    expect(cfg.secure).toBe(true);
    expect(cfg.port).toBe(465);
  });

  it("honors an explicit port and From override", () => {
    const cfg = resolveSmtpConfig({
      ...baseEnv,
      [SMTP_ENV.port]: "2525",
      [SMTP_ENV.from]: "noreply@example.com",
    });
    expect(cfg.port).toBe(2525);
    expect(cfg.from).toBe("noreply@example.com");
  });

  it("parses an explicit comma-separated sender alias allowlist", () => {
    const cfg = resolveSmtpConfig({
      ...baseEnv,
      [SMTP_ENV.allowedFrom]: "team@example.com, billing@example.com",
    });
    expect(cfg.allowedFrom).toEqual(["team@example.com", "billing@example.com"]);
  });

  it("throws an actionable error when host/user are missing", () => {
    expect(() => resolveSmtpConfig({})).toThrow(/not configured/i);
    expect(() => resolveSmtpConfig({})).toThrow(SMTP_ENV.host);
    expect(() => resolveSmtpConfig({})).toThrow(SMTP_ENV.user);
  });

  it("throws when no password is set", () => {
    expect(() =>
      resolveSmtpConfig({
        [SMTP_ENV.host]: "smtp.nonexistent.invalid",
        [SMTP_ENV.user]: "nobody@nonexistent.invalid",
      })
    ).toThrow(/no smtp password/i);
  });

  it("rejects an invalid port", () => {
    expect(() => resolveSmtpConfig({ ...baseEnv, [SMTP_ENV.port]: "not-a-port" })).toThrow(
      /invalid/i
    );
  });
});

describe("sendRawViaSmtp", () => {
  it("submits the exact raw message with a separate Bcc-capable envelope", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<raw@example.com>" });
    const close = vi.fn();
    const createTransport = vi.fn().mockReturnValue({ sendMail, close });
    const raw = Buffer.from("From: alice@example.com\r\n\r\nExact");

    const result = await sendRawViaSmtp(
      raw,
      {
        from: "Alice <alice@example.com>",
        to: ["visible@example.com", "hidden@example.com"],
      },
      testConfig,
      createTransport as never
    );

    expect(result).toMatchObject({ success: true, messageId: "<raw@example.com>" });
    expect(sendMail).toHaveBeenCalledWith({
      envelope: {
        from: "alice@example.com",
        to: ["visible@example.com", "hidden@example.com"],
      },
      raw,
    });
    expect(close).toHaveBeenCalled();
  });

  it("marks connection failures as uncertain but SMTP rejections as definite", async () => {
    const uncertainTransport = vi.fn().mockReturnValue({
      sendMail: vi.fn().mockRejectedValue(new Error("socket closed")),
      close: vi.fn(),
    });
    expect(
      await sendRawViaSmtp(
        Buffer.from("x"),
        { from: "alice@example.com", to: ["to@example.com"] },
        testConfig,
        uncertainTransport as never
      )
    ).toMatchObject({ success: false, uncertain: true });

    const rejection = Object.assign(new Error("rejected"), { responseCode: 550 });
    const rejectedTransport = vi.fn().mockReturnValue({
      sendMail: vi.fn().mockRejectedValue(rejection),
      close: vi.fn(),
    });
    expect(
      await sendRawViaSmtp(
        Buffer.from("x"),
        { from: "alice@example.com", to: ["to@example.com"] },
        testConfig,
        rejectedTransport as never
      )
    ).toMatchObject({ success: false, uncertain: false });
  });
});

describe("smtpSession", () => {
  it("logs in once for several messages and closes when done", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<m@example.com>" });
    const close = vi.fn();
    const createTransport = vi.fn().mockReturnValue({ sendMail, close });
    const session = smtpSession(createTransport as never);
    const envelope = { from: "alice@example.com", to: ["to@example.com"] };

    for (const text of ["one", "two", "three"]) {
      expect(await session.send(Buffer.from(text), envelope, testConfig)).toMatchObject({
        success: true,
      });
    }
    // Refused before it reaches the server, like a single send.
    expect(
      await session.send(Buffer.from("x"), { ...envelope, from: "eve@example.com" }, testConfig)
    ).toMatchObject({ success: false, error: expect.stringMatching(/not a configured sender/) });

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport.mock.calls[0][0]).toMatchObject({ pool: true, maxConnections: 1 });
    expect(sendMail).toHaveBeenCalledTimes(3);
    expect(close).not.toHaveBeenCalled();
    session.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
