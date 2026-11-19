import { describe, expect, it } from "./expect.js";
import { hasMarkdown, inline, renderMarkdown } from "../panels/markdown.js";

describe("node text as Markdown", () => {
  it("keeps line breaks and shows raw HTML as text", () => {
    expect(renderMarkdown("one\ntwo <b>x</b>")).toBe("<p>one<br>two &lt;b&gt;x&lt;/b&gt;</p>");
  });

  it("formats bold, italic, strikethrough and code", () => {
    expect(inline("**a** *b* _c_ ~~d~~ `e*f*`")).toBe(
      "<strong>a</strong> <em>b</em> <em>c</em> <del>d</del> <code>e*f*</code>",
    );
    expect(inline("snake_case_name stays")).toBe("snake_case_name stays");
  });

  it("makes layr links chips the panel opens, with their kind's mark", () => {
    const html = inline("see [Login](layr://pipeline/task/12) and [Card](layr://concepts/prototype/abc)");
    expect(html).toContain('class="link-chip"');
    expect(html).toContain('data-layr-link="layr://pipeline/task/12"');
    expect(html).toContain("▶ Login");
    expect(html).toContain("▣ Card");
  });

  it("opens web links outside and drops other links to their label", () => {
    expect(inline("[site](https://example.com/a?b=1)")).toBe(
      '<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer" data-web-link="1">site</a>',
    );
    expect(inline("[x](javascript:alert(1))")).toBe("x");
    expect(inline("go to https://example.com.")).toContain('href="https://example.com"');
  });

  it("escapes what could break out of an attribute", () => {
    expect(inline('[a](https://x.com/"onmouseover=1)')).not.toContain('"onmouseover');
  });

  it("makes headings, lists, quotes and code blocks", () => {
    expect(renderMarkdown("# Title\n- a\n- b\n\n1. one\n> said\n```js\nx < 1\n```")).toBe(
      "<h1>Title</h1><ul><li>a</li><li>b</li></ul><ol><li>one</li></ol><blockquote>said</blockquote>" +
        '<div class="codeblock"><div class="codeblock-lang">js</div><pre><code>x &lt; 1</code></pre></div>',
    );
  });

  it("tells plain text from text with Markdown", () => {
    expect(hasMarkdown("Bread and butter")).toBe(false);
    expect(hasMarkdown("Bread **and** butter")).toBe(true);
    expect(hasMarkdown("- a list")).toBe(true);
    expect(hasMarkdown("[x](layr://concepts/node/1)")).toBe(true);
  });
});
