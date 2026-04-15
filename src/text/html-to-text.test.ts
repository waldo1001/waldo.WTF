import { describe, expect, it } from "vitest";
import { htmlToText } from "./html-to-text.js";

describe("htmlToText", () => {
  it("returns empty string for empty/whitespace/tag-only input", () => {
    expect(htmlToText("")).toBe("");
    expect(htmlToText("   ")).toBe("");
    expect(htmlToText("\n\t  \n")).toBe("");
    expect(htmlToText("<div></div>")).toBe("");
    expect(htmlToText("<p></p><p></p>")).toBe("");
  });

  it("drops script/style/head element contents", () => {
    expect(htmlToText("<script>alert(1)</script>visible")).toBe("visible");
    expect(htmlToText("<style>.x{color:red}</style>visible")).toBe("visible");
    expect(
      htmlToText("<head><title>t</title><style>a{}</style></head><body>b</body>"),
    ).toBe("b");
    expect(
      htmlToText("<div><script>x=1</script>hello<style>y{}</style></div>"),
    ).toBe("hello");
  });

  it("converts <p>/<br>/<div>/<li>/<tr> to newlines", () => {
    expect(htmlToText("<p>hello</p><p>world</p>")).toBe("hello\n\nworld");
    expect(htmlToText("line1<br>line2")).toBe("line1\nline2");
    expect(htmlToText("line1<br/>line2<br />line3")).toBe("line1\nline2\nline3");
    expect(htmlToText("<ul><li>a</li><li>b</li></ul>")).toContain("a");
    expect(htmlToText("<ul><li>a</li><li>b</li></ul>")).toContain("b");
    expect(htmlToText("<ul><li>a</li><li>b</li></ul>").split("\n").length).toBeGreaterThanOrEqual(2);
  });

  it("decodes named, numeric, and hex HTML entities", () => {
    expect(htmlToText("A &amp; B")).toBe("A & B");
    expect(htmlToText("&lt;tag&gt;")).toBe("<tag>");
    expect(htmlToText("it&#39;s")).toBe("it's");
    expect(htmlToText("en&#8211;dash")).toBe("en–dash");
    expect(htmlToText("hex&#x2013;dash")).toBe("hex–dash");
    expect(htmlToText("a&nbsp;b")).toBe("a b");
    expect(htmlToText("&quot;hi&quot;")).toBe('"hi"');
  });

  it("collapses whitespace runs and trims lines", () => {
    expect(htmlToText("a    b")).toBe("a b");
    expect(htmlToText("  hello  ")).toBe("hello");
    expect(htmlToText("<p>a</p><p></p><p></p><p></p><p>b</p>")).toBe("a\n\nb");
    expect(htmlToText("<p>  padded  </p>")).toBe("padded");
  });

  it("tolerates malformed HTML without throwing", () => {
    expect(() => htmlToText("<p>hello<p>world")).not.toThrow();
    expect(() => htmlToText("<div><span>unclosed")).not.toThrow();
    expect(() => htmlToText("stray < bracket")).not.toThrow();
    expect(htmlToText("<p>hello<p>world")).toContain("hello");
    expect(htmlToText("<p>hello<p>world")).toContain("world");
  });

  it("extracts readable text from a realistic Outlook HTML sample", () => {
    const sample = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<style type="text/css">
  body { font-family: Calibri; font-size: 11pt; }
  .signature { color: #888; }
</style>
</head><body>
<div>
<p>Hi Alice,</p>
<p>Can you confirm the <b>sponsor list</b> for Thursday?</p>
<ul><li>Item A</li><li>Item B</li></ul>
<p>Thanks,<br>Bob</p>
<div class="signature">Bob &mdash; Example Co</div>
</div>
</body></html>`;
    const out = htmlToText(sample);
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).not.toContain("{");
    expect(out).not.toContain("font-family");
    expect(out).toContain("Hi Alice");
    expect(out).toContain("sponsor list");
    expect(out).toContain("Item A");
    expect(out).toContain("Item B");
    expect(out).toContain("Bob — Example Co");
  });
});
