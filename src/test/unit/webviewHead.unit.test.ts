import * as assert from "assert";
import { webviewCsp, webviewHead } from "../../utils/webviewUtils";

const SRC = "https://example.vscode-cdn.net";

suite("webviewCsp", () => {
  test("inline styles, no fonts", () => {
    assert.strictEqual(
      webviewCsp({ cspSource: SRC, nonce: "N", fonts: false, inlineStyles: true }),
      `default-src 'none'; style-src ${SRC} 'unsafe-inline'; script-src ${SRC} 'nonce-N';`,
    );
  });

  test("nonce'd styles and fonts", () => {
    assert.strictEqual(
      webviewCsp({ cspSource: SRC, nonce: "N", fonts: true, inlineStyles: false }),
      `default-src 'none'; style-src ${SRC} 'nonce-N'; script-src ${SRC} 'nonce-N'; font-src ${SRC};`,
    );
  });
});

suite("webviewHead", () => {
  test("codicons add the stylesheet link and font-src", () => {
    const head = webviewHead({ cspSource: SRC, nonce: "N", styles: "body{}", title: "T", codiconCssUri: "x/codicon.css" });
    assert.ok(head.startsWith("<head>") && head.endsWith("</head>"));
    assert.ok(head.includes(`<title>T</title>`));
    assert.ok(head.includes(`<link rel="stylesheet" href="x/codicon.css">`));
    assert.ok(head.includes(`font-src ${SRC};`));
    assert.ok(head.includes(`<style>body{}</style>`));
  });

  test("without codicons or title there is no link, font-src or title", () => {
    const head = webviewHead({ cspSource: SRC, nonce: "N", styles: "" });
    assert.ok(!head.includes("<link"));
    assert.ok(!head.includes("font-src"));
    assert.ok(!head.includes("<title>"));
  });

  test("nonce'd styles put the nonce on the style block", () => {
    const head = webviewHead({ cspSource: SRC, nonce: "N", styles: "a{}", inlineStyles: false });
    assert.ok(head.includes(`<style nonce="N">a{}</style>`));
    assert.ok(head.includes(`style-src ${SRC} 'nonce-N'`));
  });
});
