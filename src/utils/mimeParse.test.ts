import { describe, it, expect } from "vitest";
import {
  parseMimeAttachments,
  extractMimeAttachment,
  extractHtmlBody,
  extractRfcMessageIdFromSource,
  extractTextBody,
} from "./mimeParse.js";

describe("extractRfcMessageIdFromSource", () => {
  it("extracts a Message-ID header and strips angle brackets", () => {
    const src = "From: a@b.com\r\nMessage-ID: <abc123@mail.example.com>\r\nSubject: Hi\r\n\r\nBody";
    expect(extractRfcMessageIdFromSource(src)).toBe("abc123@mail.example.com");
  });

  it("matches the Message-Id casing variant", () => {
    const src = "Message-Id: <XYZ@host>\r\n\r\nbody";
    expect(extractRfcMessageIdFromSource(src)).toBe("XYZ@host");
  });

  it("returns empty string when there is no Message-ID header", () => {
    expect(extractRfcMessageIdFromSource("Subject: Hi\r\n\r\nbody")).toBe("");
  });

  it("returns empty string for a subject+body blob with no header block", () => {
    expect(extractRfcMessageIdFromSource("Subject: Hello\n\nsome body text")).toBe("");
  });

  it("ignores a Message-ID-looking line in the body", () => {
    const src = "Subject: Hi\r\n\r\nMessage-ID: <notheader@x.com>";
    expect(extractRfcMessageIdFromSource(src)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(extractRfcMessageIdFromSource("")).toBe("");
  });
});

const MIME_WITH_PDF = `Content-Type: multipart/mixed;
\tboundary="_004_TEST"
MIME-Version: 1.0

--_004_TEST
Content-Type: text/plain; charset="us-ascii"
Content-Transfer-Encoding: quoted-printable

Hello world

--_004_TEST
Content-Type: application/pdf; name="report.pdf"
Content-Description: report.pdf
Content-Disposition: attachment;
\tfilename="report.pdf"; size=100;
\tcreation-date="Mon, 14 Apr 2026 12:10:46 GMT";
\tmodification-date="Mon, 14 Apr 2026 12:10:46 GMT"
Content-Transfer-Encoding: base64

JVBERi0xLjAKMSAwIG9iago=

--_004_TEST--`;

const MIME_TEXT_ONLY = `Content-Type: text/plain; charset="us-ascii"
MIME-Version: 1.0

Just a plain text email with no attachments.`;

const MIME_MULTI_ATTACH = `Content-Type: multipart/mixed;
\tboundary="_004_MULTI"

--_004_MULTI
Content-Type: text/plain; charset="us-ascii"

Body text

--_004_MULTI
Content-Type: application/pdf; name="doc1.pdf"
Content-Disposition: attachment; filename="doc1.pdf"; size=50
Content-Transfer-Encoding: base64

AAAA

--_004_MULTI
Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document; name="doc2.docx"
Content-Disposition: attachment; filename="doc2.docx"; size=75
Content-Transfer-Encoding: base64

BBBB

--_004_MULTI--`;

const MIME_WITH_INLINE = `Content-Type: multipart/mixed;
\tboundary="_004_INLINE"

--_004_INLINE
Content-Type: text/html; charset="us-ascii"

<html><body>Hi</body></html>

--_004_INLINE
Content-Type: image/png; name="image001.png"
Content-Disposition: inline; filename="image001.png"
Content-Transfer-Encoding: base64

iVBORw0KGgo=

--_004_INLINE
Content-Type: application/pdf; name="actual-doc.pdf"
Content-Disposition: attachment; filename="actual-doc.pdf"; size=200
Content-Transfer-Encoding: base64

JVBERi0xLjAK

--_004_INLINE--`;

describe("parseMimeAttachments", () => {
  it("extracts attachment metadata from MIME source", () => {
    const result = parseMimeAttachments(MIME_WITH_PDF);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("report.pdf");
    expect(result[0].mimeType).toBe("application/pdf");
    expect(result[0].size).toBe(100);
  });

  it("returns empty array for text-only messages", () => {
    const result = parseMimeAttachments(MIME_TEXT_ONLY);
    expect(result).toHaveLength(0);
  });

  it("extracts multiple attachments", () => {
    const result = parseMimeAttachments(MIME_MULTI_ATTACH);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("doc1.pdf");
    expect(result[1].name).toBe("doc2.docx");
  });

  it("skips inline dispositions", () => {
    const result = parseMimeAttachments(MIME_WITH_INLINE);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("actual-doc.pdf");
  });

  it("returns empty array for empty input", () => {
    expect(parseMimeAttachments("")).toHaveLength(0);
    expect(parseMimeAttachments("   ")).toHaveLength(0);
  });

  it("estimates size from base64 when size header missing", () => {
    const noSizeMime = `Content-Type: multipart/mixed;
\tboundary="_004_NOSIZE"

--_004_NOSIZE
Content-Type: application/pdf; name="test.pdf"
Content-Disposition: attachment; filename="test.pdf"
Content-Transfer-Encoding: base64

AAAAAAAAAAAAAAAA

--_004_NOSIZE--`;
    const result = parseMimeAttachments(noSizeMime);
    expect(result).toHaveLength(1);
    expect(result[0].size).toBeGreaterThan(0);
  });
});

describe("extractMimeAttachment", () => {
  it("decodes base64 content for a named attachment", () => {
    const result = extractMimeAttachment(MIME_WITH_PDF, "report.pdf");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("report.pdf");
    expect(result!.data).toBeInstanceOf(Buffer);
    expect(result!.data.length).toBeGreaterThan(0);
  });

  it("returns null for non-existent attachment", () => {
    const result = extractMimeAttachment(MIME_WITH_PDF, "nope.pdf");
    expect(result).toBeNull();
  });

  it("extracts the correct attachment from multiple", () => {
    const result = extractMimeAttachment(MIME_MULTI_ATTACH, "doc2.docx");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("doc2.docx");
  });

  it("returns null for empty input", () => {
    expect(extractMimeAttachment("", "test.pdf")).toBeNull();
    expect(extractMimeAttachment("   ", "test.pdf")).toBeNull();
  });
});

// Nested multipart: mixed container with alternative (text+html) as one child
// and the attachment as a sibling. This is the most common real-world shape.
const MIME_NESTED_MULTIPART = `Content-Type: multipart/mixed;
\tboundary="_outer_"

--_outer_
Content-Type: multipart/alternative;
\tboundary="_inner_"

--_inner_
Content-Type: text/plain; charset="us-ascii"

Plain body

--_inner_
Content-Type: text/html; charset="us-ascii"

<html><body>HTML body</body></html>

--_inner_--

--_outer_
Content-Type: application/pdf; name="nested.pdf"
Content-Disposition: attachment; filename="nested.pdf"; size=42
Content-Transfer-Encoding: base64

JVBERi0xLjAK

--_outer_--`;

// Attachment nested inside multipart/related (common for HTML emails
// with inline images that also carry a real file attachment).
const MIME_DEEPLY_NESTED = `Content-Type: multipart/mixed;
\tboundary="_L1_"

--_L1_
Content-Type: multipart/related;
\tboundary="_L2_"

--_L2_
Content-Type: text/html

<html>body</html>

--_L2_
Content-Type: application/pdf; name="deep.pdf"
Content-Disposition: attachment; filename="deep.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjAK

--_L2_--

--_L1_--`;

describe("parseMimeAttachments — nested multipart", () => {
  it("finds attachments alongside a nested multipart/alternative", () => {
    const result = parseMimeAttachments(MIME_NESTED_MULTIPART);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("nested.pdf");
  });

  it("descends into multipart/related to find attachments", () => {
    const result = parseMimeAttachments(MIME_DEEPLY_NESTED);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("deep.pdf");
  });
});

describe("extractMimeAttachment — nested multipart", () => {
  it("extracts a nested attachment by name", () => {
    const result = extractMimeAttachment(MIME_NESTED_MULTIPART, "nested.pdf");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("nested.pdf");
    expect(result!.data.length).toBeGreaterThan(0);
  });

  it("extracts an attachment from deeply nested multipart/related", () => {
    const result = extractMimeAttachment(MIME_DEEPLY_NESTED, "deep.pdf");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("deep.pdf");
  });
});

// Quoted-printable and raw (7bit/8bit) encoded attachments.
// "Hello=0A" decodes to "Hello\n".
const MIME_QP_ATTACH = `Content-Type: multipart/mixed;
\tboundary="_QP_"

--_QP_
Content-Type: text/plain; name="note.txt"
Content-Disposition: attachment; filename="note.txt"
Content-Transfer-Encoding: quoted-printable

Hello=0Aworld=21

--_QP_--`;

const MIME_7BIT_ATTACH = `Content-Type: multipart/mixed;
\tboundary="_7B_"

--_7B_
Content-Type: text/csv; name="data.csv"
Content-Disposition: attachment; filename="data.csv"
Content-Transfer-Encoding: 7bit

id,name
1,alice
2,bob

--_7B_--`;

describe("extractMimeAttachment — transfer encodings", () => {
  it("decodes quoted-printable content", () => {
    const result = extractMimeAttachment(MIME_QP_ATTACH, "note.txt");
    expect(result).not.toBeNull();
    expect(result!.data.toString("utf8")).toBe("Hello\nworld!");
  });

  it("returns raw bytes for 7bit content", () => {
    const result = extractMimeAttachment(MIME_7BIT_ATTACH, "data.csv");
    expect(result).not.toBeNull();
    expect(result!.data.toString("utf8")).toContain("id,name");
    expect(result!.data.toString("utf8")).toContain("alice");
  });
});

describe("parseMimeAttachments — transfer encodings", () => {
  it("lists quoted-printable attachments", () => {
    const result = parseMimeAttachments(MIME_QP_ATTACH);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("note.txt");
  });

  it("lists 7bit attachments", () => {
    const result = parseMimeAttachments(MIME_7BIT_ATTACH);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("data.csv");
  });
});

describe("extractHtmlBody (#32)", () => {
  it("extracts the text/html part from a multipart/alternative message", () => {
    const src = `Content-Type: multipart/alternative;
\tboundary="alt-bound"
MIME-Version: 1.0

--alt-bound
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: 7bit

Hello in plain text

--alt-bound
Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: 7bit

<html><body><p>Hello in <b>HTML</b></p></body></html>

--alt-bound--`;
    expect(extractHtmlBody(src)).toBe("<html><body><p>Hello in <b>HTML</b></p></body></html>");
  });

  it("decodes a quoted-printable HTML part", () => {
    const src = `Content-Type: multipart/alternative; boundary="b"
MIME-Version: 1.0

--b
Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

<p>Caf=C3=A9 =26 tea</p>

--b--`;
    expect(extractHtmlBody(src)).toBe("<p>Café & tea</p>");
  });

  it("handles a non-multipart text/html message", () => {
    const src = `Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: 7bit

<h1>Direct HTML</h1>`;
    expect(extractHtmlBody(src)).toBe("<h1>Direct HTML</h1>");
  });

  it("returns null for a plain-text-only message", () => {
    const src = `Content-Type: text/plain; charset="utf-8"

just text, no html`;
    expect(extractHtmlBody(src)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractHtmlBody("")).toBeNull();
  });
});

// A real reply from Outlook for iOS, in Big5: 「請問您我的連絡方式是由那位人員提供或連繫」.
// Read as UTF-8 it came back from read_message as OUTLOOK_MOJIBAKE.
const OUTLOOK_TEXT = "請問您我的連絡方式是由那位人員提供或連繫";
const OUTLOOK_BIG5 = Buffer.from(
  "bdd0b0ddb17aa7daaabab373b5b8a4e8a6a1ac4fa5d1a8baa6eca448adfbb4a3a8d1a9ceb373c3b4",
  "hex"
);
const OUTLOOK_MOJIBAKE = "�аݱz�ڪ��s���覡�O�Ѩ���H�����ѩγsô";
const OUTLOOK_HTML = `<div dir="ltr">${OUTLOOK_TEXT}</div>`;
const OUTLOOK_HTML_BIG5 = Buffer.concat([
  Buffer.from('<div dir="ltr">'),
  OUTLOOK_BIG5,
  Buffer.from("</div>"),
]);

/** Raw MIME bytes: CRLF-terminated ASCII lines around raw body bytes. */
function mimeBytes(...pieces: Array<string | Buffer>): Buffer {
  return Buffer.concat(
    pieces.map((piece) =>
      typeof piece === "string" ? Buffer.from(piece.replace(/\n/g, "\r\n"), "latin1") : piece
    )
  );
}

function base64Lines(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .match(/.{1,76}/g)!
    .join("\n");
}

/** Quoted-printable with every byte escaped, broken by soft line breaks. */
function quotedPrintable(bytes: Buffer): string {
  const escaped = [...bytes].map((b) => `=${b.toString(16).toUpperCase().padStart(2, "0")}`);
  const lines: string[] = [];
  for (let i = 0; i < escaped.length; i += 24) lines.push(escaped.slice(i, i + 24).join(""));
  return lines.join("=\n");
}

const TRANSFER_ENCODINGS: Record<string, (bytes: Buffer) => string | Buffer> = {
  base64: base64Lines,
  "quoted-printable": quotedPrintable,
  "8bit": (bytes) => bytes,
};

describe("body charsets", () => {
  it("reproduces the reported mojibake when the Big5 sample is read as UTF-8", () => {
    expect(new TextDecoder("utf-8").decode(OUTLOOK_BIG5)).toBe(OUTLOOK_MOJIBAKE);
  });

  it("decodes the Outlook for iOS Big5 reply (multipart/alternative, base64)", () => {
    const src = mimeBytes(`From: =?big5?B?pKSk5Q==?= <director@hospital.example.tw>
Content-Type: multipart/alternative;
\tboundary="_000_SEZPR01MB0001_"
MIME-Version: 1.0

--_000_SEZPR01MB0001_
Content-Type: text/plain; charset="big5"
Content-Transfer-Encoding: base64

${base64Lines(OUTLOOK_BIG5)}

--_000_SEZPR01MB0001_
Content-Type: text/html; charset="big5"
Content-Transfer-Encoding: base64

${base64Lines(OUTLOOK_HTML_BIG5)}

--_000_SEZPR01MB0001_--
`);
    expect(extractTextBody(src)).toBe(OUTLOOK_TEXT);
    expect(extractHtmlBody(src)).toBe(OUTLOOK_HTML);
    // A base64 body is ASCII, so the same message as a decoded string agrees.
    expect(extractTextBody(src.toString("utf8"))).toBe(OUTLOOK_TEXT);
  });

  for (const [encoding, encode] of Object.entries(TRANSFER_ENCODINGS)) {
    it(`decodes a single-part Big5 text/plain body sent ${encoding}`, () => {
      const src = mimeBytes(
        `Content-Type: text/plain; charset=Big5
Content-Transfer-Encoding: ${encoding}

`,
        encode(OUTLOOK_BIG5)
      );
      expect(extractTextBody(src)).toBe(OUTLOOK_TEXT);
    });

    it(`decodes a single-part Big5 text/html body sent ${encoding}`, () => {
      const src = mimeBytes(
        `Content-Type: text/html; charset="big5"
Content-Transfer-Encoding: ${encoding}

`,
        encode(OUTLOOK_HTML_BIG5)
      );
      expect(extractHtmlBody(src)).toBe(OUTLOOK_HTML);
    });
  }

  it("decodes each part of a multipart/alternative in its own charset", () => {
    const src = mimeBytes(
      `Content-Type: multipart/alternative; boundary="alt"

--alt
Content-Type: text/plain; charset="big5"
Content-Transfer-Encoding: 8bit

`,
      OUTLOOK_BIG5,
      `
--alt
Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

${quotedPrintable(Buffer.from(OUTLOOK_HTML))}
--alt--
`
    );
    expect(extractTextBody(src)).toBe(OUTLOOK_TEXT);
    expect(extractHtmlBody(src)).toBe(OUTLOOK_HTML);
  });

  it.each([
    ["gb18030", "c7ebceca", "请问"],
    ["shift_jis", "82a896e282a28d8782ed82b9", "お問い合わせ"],
    ["euc-kr", "b9aec0c7", "문의"],
    ["iso-8859-1", "636166e9", "café"],
  ])("decodes a %s body", (charset, hex, text) => {
    const src = mimeBytes(
      `Content-Type: text/plain; charset=${charset}
Content-Transfer-Encoding: 8bit

`,
      Buffer.from(hex, "hex")
    );
    expect(extractTextBody(src)).toBe(text);
  });

  it("falls back to UTF-8 for a part with no charset", () => {
    const src = mimeBytes(
      `Content-Type: multipart/mixed; boundary="m"

--m
Content-Type: text/plain
Content-Transfer-Encoding: 8bit

`,
      Buffer.from("請問您"),
      `
--m--
`
    );
    expect(extractTextBody(src)).toBe("請問您");
  });

  it("falls back to UTF-8 for a charset the runtime does not know", () => {
    const src = mimeBytes(`Content-Type: text/html; charset="x-no-such-charset"
Content-Transfer-Encoding: base64

${base64Lines(Buffer.from("<p>請問您</p>"))}
`);
    expect(extractHtmlBody(src)).toBe("<p>請問您</p>");
  });

  it("returns an 8bit body from an already-decoded string as is", () => {
    const src = `Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: 8bit

請問您`;
    expect(extractTextBody(src)).toBe("請問您");
  });
});

// Build a multipart/mixed tree nested `levels` deep, with a single PDF
// attachment as the innermost leaf. Each level uses a distinct boundary.
function buildNestedMime(levels: number): string {
  let inner = `Content-Type: application/pdf; name="bottom.pdf"
Content-Disposition: attachment; filename="bottom.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjAK
`;
  for (let i = levels; i >= 1; i--) {
    const b = `_d${i}_`;
    inner = `Content-Type: multipart/mixed;
\tboundary="${b}"

--${b}
${inner}
--${b}--
`;
  }
  return inner;
}

describe("parseMimeAttachments — recursion depth cap (#defense-in-depth)", () => {
  it("finds an attachment nested within the depth bound", () => {
    // 5 levels of nesting is well under the 20-level cap.
    const result = parseMimeAttachments(buildNestedMime(5));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("bottom.pdf");
  });

  it("does not throw or overflow on pathologically deep nesting", () => {
    // 200 levels far exceeds the cap; the parser must stop descending and
    // return what it parsed rather than recursing without bound.
    const deep = buildNestedMime(200);
    expect(() => parseMimeAttachments(deep)).not.toThrow();
    // The bottom attachment is below the cap, so it is not surfaced — the
    // point is that the call completes safely.
    const result = parseMimeAttachments(deep);
    expect(Array.isArray(result)).toBe(true);
  });
});
