import { describe, expect, it } from "vitest";
import { editedContent, FORWARD_INTRO, quotedHtml, quotedText } from "./quotedContent.js";

const reply = "Thanks!\n\nOn Mon, 3 Nov 2026 at 09:00, Alice <a@example.com> wrote:\n> Lunch?\n";
const forward = `FYI\n\n${FORWARD_INTRO}\nFrom: Alice <a@example.com>\n\nThe plan.`;

describe("quotedText and quotedHtml", () => {
  it("finds a reply's attribution and a forward's rule", () => {
    expect(quotedText(reply)).toBe(
      "On Mon, 3 Nov 2026 at 09:00, Alice <a@example.com> wrote:\n> Lunch?\n"
    );
    expect(quotedText(forward.replace(/\n/g, "\r\n"))).toBe(
      `${FORWARD_INTRO}\nFrom: Alice <a@example.com>\n\nThe plan.`
    );
    expect(quotedText("I wrote: nothing quoted here")).toBe("");
  });

  it("finds Gmail's quote block and Apple Mail's cited blockquote", () => {
    expect(quotedHtml('<p>Hi</p><div class="gmail_quote">On ... wrote:</div>')).toBe(
      '<div class="gmail_quote">On ... wrote:</div>'
    );
    expect(quotedHtml('<p>Hi</p><blockquote type="cite">old</blockquote>')).toBe(
      '<blockquote type="cite">old</blockquote>'
    );
    expect(quotedHtml("<p>Hi</p>")).toBe("");
    expect(quotedHtml(undefined)).toBe("");
  });
});

describe("editedContent", () => {
  it("replaces the new text and keeps what is quoted below it", () => {
    const html = '<p>FYI</p><div class="gmail_quote">The plan.</div>';
    expect(editedContent({ body: forward, htmlBody: html }, { body: "See below" })).toEqual({
      body: `See below\n\n${FORWARD_INTRO}\nFrom: Alice <a@example.com>\n\nThe plan.`,
      htmlBody: 'See below<br><br><div class="gmail_quote">The plan.</div>',
    });
  });

  it("drops the quoted part when asked", () => {
    expect(editedContent({ body: reply }, { body: "Just this" }, false)).toEqual({
      body: "Just this",
      htmlBody: null,
    });
  });

  it("derives text from new HTML and keeps no stale HTML part", () => {
    expect(editedContent({ body: "Old" }, { htmlBody: "<p>New &amp; better</p>" })).toEqual({
      body: "New & better",
      htmlBody: "<p>New &amp; better</p>",
    });
    expect(editedContent({ body: "Old", htmlBody: "<p>Old</p>" }, { body: "New" })).toEqual({
      body: "New",
      htmlBody: null,
    });
  });
});
