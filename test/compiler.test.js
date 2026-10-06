import test from "node:test";
import assert from "node:assert/strict";
import * as parse5 from "parse5";
import { compileTemplates, TemplateError } from "../src/index.js";

const BASE = "http://localhost/app/";

const compile = (files, entry = "index.html", options = {}) =>
  compileTemplates(files, entry, { baseUrl: BASE, ...options });

const rejectCode = (fn, code) => {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof TemplateError);
    assert.equal(
      error.code,
      code,
      `expected ${code}, got ${error.code}: ${error.message}`,
    );
    return true;
  });
};

test("escapes text and ordinary quoted attributes", () => {
  const compiled = compile({
    "index.html": `<p title="{{x}}">{{x}}</p><input value='{{x}}'>`,
  });
  const html = compiled.render({ x: `<img src=x onerror="alert(1)" a='b'>` });
  assert.equal(
    html,
    `<p title="&lt;img src=x onerror=&quot;alert(1)&quot; a=&#x27;b&#x27;&gt;">&lt;img src=x onerror="alert(1)" a='b'&gt;</p><input value='&lt;img src=x onerror=&quot;alert(1)&quot; a=&#x27;b&#x27;&gt;'>`,
  );
});

test("accepts safe absolute, protocol and site-relative URLs and normalizes same-origin URLs", () => {
  const compiled = compile({
    "index.html":
      '<a href="{{a}}">A</a><a href="{{b}}">B</a><a href="{{c}}">C</a><a href="{{d}}">D</a>',
  });
  const html = compiled.render({
    a: "https://example.com/path?q=1#frag",
    b: "/root",
    c: "child/../x?y=1",
    d: "#section",
  });
  assert.ok(html.includes('href="https://example.com/path?q=1#frag"'));
  assert.ok(html.includes('href="/root"'));
  assert.ok(html.includes('href="/app/x?y=1"'));
  assert.ok(html.includes('href="/app/#section"'));
});

test("rejects dangerous URL protocols, protocol-relative URLs, control characters, and partial dynamic URL values at render or compile", () => {
  rejectCode(
    () =>
      compile({
        "index.html": '<a href="x {{url}}">x</a>',
      }),
    "PARTIAL_DYNAMIC_URL",
  );
  rejectCode(
    () =>
      compile({
        "index.html": '<a href="{{url}}x">x</a>',
      }),
    "PARTIAL_DYNAMIC_URL",
  );

  const compiled = compile({ "index.html": '<a href="{{url}}">x</a>' });
  rejectCode(
    () => compile({ "index.html": '<a href="{{a}}{{b}}"></a>' }),
    "MULTIPLE_DYNAMIC_URL_VALUES",
  );
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,abc",
    "vbscript:msgbox(1)",
    "file:///tmp/x",
    "//evil.example/x",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "java\x00script:alert(1)",
    "http://evil\\example",
  ]) {
    assert.throws(() => compiled.render({ url }), /URL/);
  }
});

test("rejects interpolation in forbidden element and attribute contexts with positions", () => {
  const cases = [
    ["<d{{x}}>", "DYNAMIC_TAG_NAME"],
    ['<div {{x}}="y">', "DYNAMIC_ATTRIBUTE_NAME"],
    ["<div class={{x}}>", "UNQUOTED_DYNAMIC_ATTRIBUTE"],
    ['<div onclick="{{x}}">', "FORBIDDEN_DYNAMIC_ATTRIBUTE"],
    ['<div style="{{x}}">', "FORBIDDEN_DYNAMIC_ATTRIBUTE"],
    ['<div srcdoc="{{x}}">', "FORBIDDEN_DYNAMIC_ATTRIBUTE"],
    ['<div srcset="{{x}}">', "FORBIDDEN_DYNAMIC_ATTRIBUTE"],
    ["<!-- {{x}} -->", "DYNAMIC_COMMENT"],
    ["<script>{{x}}</script>", "DYNAMIC_RAW_ELEMENT"],
    ["<style>{{x}}</style>", "DYNAMIC_RAW_ELEMENT"],
    ["<title>{{x}}</title>", "FORBIDDEN_ELEMENT"],
    ["<textarea>{{x}}</textarea>", "FORBIDDEN_ELEMENT"],
    ["<svg>{{x}}</svg>", "FORBIDDEN_ELEMENT"],
    ["<math>{{x}}</math>", "FORBIDDEN_ELEMENT"],
  ];
  for (const [source, code] of cases)
    rejectCode(() => compile({ "index.html": source }), code);

  let caught;
  try {
    compile({ "index.html": '<a href="x{{url}}">' });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.file, "index.html");
  assert.equal(caught.position.line, 0);
  assert.equal(caught.position.column, 10);
});

test("trusted static literals may use dangerous attributes, raw elements, and RCDATA-like nonforeign tags", () => {
  const compiled = compile({
    "index.html":
      '<div onclick="doThing()" style="color: red" srcdoc="trusted" srcset="/a.png"></div><script>if (a < b) {}</script><style>a::before { content: "<"; }</style>',
  });
  assert.equal(
    compiled.render({}),
    '<div onclick="doThing()" style="color: red" srcdoc="trusted" srcset="/a.png"></div><script>if (a < b) {}</script><style>a::before { content: "<"; }</style>',
  );
});

test("rejects include targets that try to look like variable interpolation", () => {
  rejectCode(
    () => compile({ "index.html": '{{#include "{{x}}"}}', "{{x}}": "" }),
    "INVALID_INCLUDE",
  );
});

test("rejects templates left inside tags, attributes, comments, script, or style", () => {
  const sources = [
    '<div title="x',
    "<!-- x",
    "<script>x",
    "<style>x",
    "<div",
    "<div title",
  ];
  for (const source of sources)
    rejectCode(
      () => compile({ "index.html": source }),
      "UNTERMINATED_HTML_CONTEXT",
    );
});

test("propagates context through compatible if and else branches and rejects incompatible ends", () => {
  const compiled = compile({
    "index.html":
      '{{#if ok}}<a href="{{u}}">{{x}}</a>{{else}}<b>{{y}}</b>{{/if}}<span>{{z}}</span>',
  });
  const html = compiled.render({
    ok: true,
    u: "/ok",
    x: "<b>",
    y: "<i>",
    z: "z",
  });
  assert.match(html, /<a href="\/ok">&lt;b&gt;<\/a><span>z<\/span>/);

  rejectCode(
    () =>
      compile({
        "index.html": '{{#if ok}}<div class="x">{{else}}<!-- ok {{/if}}',
      }),
    "INCOMPATIBLE_BRANCH_CONTEXT",
  );

  rejectCode(
    () =>
      compile({
        "index.html": '{{#if ok}}<script>{{else}}<div title="static">{{/if}}',
      }),
    "INCOMPATIBLE_BRANCH_CONTEXT",
  );
});

test("include contents inherit and are rejected in each surrounding context", () => {
  rejectCode(
    () =>
      compile({
        "index.html": 'before<a data-{{#include "p"}}>after',
        p: "{{x}}",
      }),
    "DYNAMIC_ATTRIBUTE_NAME",
  );
  rejectCode(
    () =>
      compile({
        "index.html": 'before<a href="x{{#include "p"}}y">after',
        p: "{{x}}",
      }),
    "PARTIAL_DYNAMIC_URL",
  );
});

test("static includes compile in each caller context and cannot select files dynamically", () => {
  const compiled = compile(
    {
      "index.html":
        '<p title="{{#include "part.html"}}">{{#include "part.html"}}</p>{{#include "nested.html"}}',
      "part.html": "{{x}}",
      "nested.html": '{{#include "part.html"}}',
    },
    "index.html",
  );
  const html = compiled.render({ x: "<q>" });
  assert.match(html, /<p title="&lt;q&gt;">\s*&lt;q&gt;\s*<\/p>\s*&lt;q&gt;/);

  rejectCode(
    () => compile({ "index.html": "{{#include x}}" }),
    "INVALID_INCLUDE",
  );
  rejectCode(
    () => compile({ "index.html": '{{#include "{{x}}"}}' }),
    "INVALID_INCLUDE",
  );
  rejectCode(
    () => compile({ "index.html": '{{#include "missing.html"}}' }),
    "MISSING_INCLUDE_FILE",
  );
});

test("rejects include cycles and reports the include chain", () => {
  try {
    compile({
      "index.html": '{{#include "a.html"}}',
      "a.html": '{{#include "b.html"}}',
      "b.html": '{{#include "a.html"}}',
    });
    assert.fail("expected compile failure");
  } catch (error) {
    assert.equal(error.code, "INCLUDE_CYCLE");
    assert.deepEqual(error.includeChain, [
      "index.html",
      "a.html",
      "b.html",
      "a.html",
    ]);
    assert.equal(error.file, "b.html");
  }
});

test("same partial can be used safely in multiple contexts but is independently checked", () => {
  const compiled = compile({
    "index.html":
      '<p>{{#include "safe.html"}}</p><p title="{{#include "safe.html"}}"></p>',
    "safe.html": "{{x}}",
  });
  assert.equal(
    compiled.render({ x: "&" }),
    '<p>&amp;</p><p title="&amp;"></p>',
  );

  rejectCode(
    () =>
      compile({
        "index.html":
          '<p>{{#include "bad.html"}}</p><p title="{{#include "bad.html"}}"></p>',
        "bad.html": "<!-- {{x}} -->",
      }),
    "DYNAMIC_COMMENT",
  );
});

test("enforces maximum files and total byte length", () => {
  rejectCode(
    () =>
      compile({
        "index.html":
          '{{#include "a"}}{{#include "b"}}{{#include "c"}}{{#include "d"}}{{#include "e"}}{{#include "f"}}',
        a: "",
        b: "",
        c: "",
        d: "",
        e: "",
        f: "",
      }),
    "TEMPLATE_LIMIT_EXCEEDED",
  );

  rejectCode(
    () =>
      compile({
        "index.html": "x".repeat(20 * 1024 + 1),
      }),
    "TEMPLATE_LIMIT_EXCEEDED",
  );
});

test("render is atomic: missing values, non-boolean conditions, and type errors emit no partial HTML", () => {
  const compiled = compile({
    "index.html":
      "<header>{{present}}</header>{{#if flag}}<main>{{missing}}</main>{{/if}}",
  });
  try {
    compiled.render({ present: "shown", flag: true });
    assert.fail("expected render failure");
  } catch (error) {
    assert.equal(error.code, "MISSING_VARIABLE");
  }

  const typeCompiled = compile({
    "index.html": "before{{#if flag}}yes{{else}}no{{/if}}after",
  });
  rejectCode(() => typeCompiled.render({ flag: "yes" }), "VARIABLE_TYPE_ERROR");
  rejectCode(() => typeCompiled.render({}), "MISSING_VARIABLE");
});

test("compiled template can render many times", () => {
  const compiled = compile({ "index.html": '<a href="{{u}}">{{x}}</a>' });
  assert.equal(compiled.render({ u: "/a", x: "A" }), '<a href="/a">A</a>');
  assert.equal(
    compiled.render({ u: "https://example.com", x: "B" }),
    '<a href="https://example.com/">B</a>',
  );
});

test("parse5 confirms escaping, entities, split tags, comments, and dangerous URL data preserve DOM structure", () => {
  const compiled = compile(
    {
      "index.html": `
      <p id="text">{{attack}}</p>
      <p id="attr" title="{{attack}}"></p>
      <a id="url" href="{{url}}">link</a>
      <!-- {{#if debug}}static trusted comment{{else}}other trusted comment{{/if}} -->
      {{#if split}}<a href="{{link}}">{{label}}{{else}}<em>{{label}}</em>{{/if}}
    `,
    },
    "index.html",
  );

  const data = {
    attack: `<img src=x onerror=alert(1)><!--"><svg onload=alert(1)>`,
    url: "/safe?x=1&y=2",
    split: true,
    link: "/path?a=1&b=2",
    label: `</a><img src=x onerror=alert(1)>`,
    debug: false,
  };
  compiled.render(data);
  const html = compiled.render(data);
  const document = parse5.parse(html);
  const findNode = (node, predicate) => {
    if (predicate(node)) return node;
    for (const child of node.childNodes ?? []) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return null;
  };
  const body = findNode(document, (node) => node.nodeName === "body");
  const findById = (node, id) =>
    findNode(node, (candidate) =>
      candidate.attrs?.some((attr) => attr.name === "id" && attr.value === id),
    );
  const allTags = (node, names = []) => {
    if (node.nodeName && !node.nodeName.startsWith("#"))
      names.push(node.nodeName);
    for (const child of node.childNodes ?? []) allTags(child, names);
    return names;
  };

  const textNode = findById(body, "text");
  assert.equal(textNode.nodeName, "p");
  assert.equal(textNode.childNodes[0].value, data.attack);
  const attrNode = findById(body, "attr");
  assert.equal(
    attrNode.attrs.find((attr) => attr.name === "title").value,
    data.attack,
  );
  const urlNode = findById(body, "url");
  assert.equal(
    urlNode.attrs.find((attr) => attr.name === "href").value,
    "/safe?x=1&y=2",
  );
  assert.deepEqual(
    allTags(body).filter((name) => name === "img"),
    [],
  );
  assert.deepEqual(
    allTags(body).filter((name) => name === "svg"),
    [],
  );
  assert.deepEqual(
    allTags(body).filter((name) => name === "script"),
    [],
  );
});

test("parse5 validates one include reused in text, attribute, and complete URL contexts", () => {
  const compiled = compile({
    "index.html":
      '<p id="text">{{#include "value.html"}}</p><p id="attr" title="{{#include "value.html"}}"></p><a id="url" href="{{#include "url.html"}}">go</a>',
    "value.html": "{{x}}",
    "url.html": "{{u}}",
  });
  const html = compiled.render({
    x: '</p><img src=x onerror="alert(1)">',
    u: "/included?from=x&to=y",
  });
  const document = parse5.parse(html);
  const findNode = (node, predicate) => {
    if (predicate(node)) return node;
    for (const child of node.childNodes ?? []) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return null;
  };
  const body = findNode(document, (node) => node.nodeName === "body");
  const byId = (id) =>
    findNode(body, (node) =>
      node.attrs?.some((attr) => attr.name === "id" && attr.value === id),
    );
  const tags = [];
  const collectTags = (node) => {
    if (node.nodeName && !node.nodeName.startsWith("#"))
      tags.push(node.nodeName);
    for (const child of node.childNodes ?? []) collectTags(child);
  };
  for (const child of body.childNodes) collectTags(child);

  const text = byId("text");
  assert.equal(text.childNodes.length, 1);
  assert.equal(text.childNodes[0].value, '</p><img src=x onerror="alert(1)">');
  assert.equal(
    byId("attr").attrs.find((attr) => attr.name === "title").value,
    '</p><img src=x onerror="alert(1)">',
  );
  assert.equal(byId("url").attrs.length, 2);
  assert.equal(
    byId("url").attrs.find((attr) => attr.name === "href").value,
    "/included?from=x&to=y",
  );
  assert.deepEqual(tags, ["p", "p", "a"]);
});

test("parse5 checks URL payloads do not introduce attributes or elements", () => {
  const compiled = compile({ "index.html": '<a href="{{url}}">x</a>' });
  const html = compiled.render({
    url: "/path?x=" + encodeURIComponent('" onclick="alert(1)'),
  });
  const document = parse5.parse(html);
  const findNode = (node, predicate) => {
    if (predicate(node)) return node;
    for (const child of node.childNodes ?? []) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return null;
  };
  const body = findNode(document, (node) => node.nodeName === "body");
  const a = findNode(body, (node) => node.nodeName === "a");
  assert.equal(a.nodeName, "a");
  assert.equal(a.attrs.length, 1);
  assert.equal(a.attrs[0].name, "href");
  assert.match(a.attrs[0].value, /^\/path\?x=%22/);
});

test("each scopes aliases per iteration without leaking into root data", () => {
  const compiled = compile({
    "index.html":
      "{{#each items as row}}[{{row.name}}|{{title}}]{{/each}}after:{{row.name}}",
  });
  const data = {
    items: [{ name: "a" }, { name: "b" }],
    row: { name: "ROOT" },
    title: "T",
  };
  const snapshot = JSON.stringify(data);
  assert.equal(compiled.render(data), "[a|T][b|T]after:ROOT");
  assert.equal(JSON.stringify(data), snapshot, "render must not mutate data");
});

test("nested loops may reuse an alias; the inner loop shadows only its body", () => {
  const compiled = compile({
    "index.html":
      "{{#each cats as row}}[{{row.name}}:{{#each row.items as row}}{{row.name}};{{/each}}={{row.name}}]{{/each}}",
  });
  assert.equal(
    compiled.render({
      cats: [
        { name: "C1", items: [{ name: "i1" }, { name: "i2" }] },
        { name: "C2", items: [{ name: "i3" }] },
      ],
    }),
    "[C1:i1;i2;=C1][C2:i3;=C2]",
  );
});

test("aliases may use special legal field names without touching root data", () => {
  const compiled = compile({
    "index.html": "{{#each items as __proto__}}[{{__proto__.label}}]{{/each}}",
  });
  const data = { items: [{ label: "x" }] };
  assert.equal(compiled.render(data), "[x]");
  assert.equal(Object.getPrototypeOf(data), Object.prototype);
  assert.equal(data.polluted, undefined);
});

test("includes inside a loop read the current item of every iteration", () => {
  const compiled = compile({
    "index.html": '{{#each items as row}}{{#include "card.html"}};{{/each}}{{row.name}}',
    "card.html": "[{{row.name}}]",
  });
  const data = { items: [{ name: "a" }, { name: "b" }], row: { name: "ROOT" } };
  assert.equal(compiled.render(data), "[a];[b];ROOT");
});

test("each bodies are checked structurally at compile time, empty list or not", () => {
  rejectCode(
    () => compile({ "index.html": "<div {{#each items as row}}x{{/each}}>" }),
    "EACH_OUTSIDE_TEXT_CONTEXT",
  );
  rejectCode(
    () =>
      compile({ "index.html": '<p title="{{#each items as row}}x{{/each}}">' }),
    "EACH_OUTSIDE_TEXT_CONTEXT",
  );
  rejectCode(
    () => compile({ "index.html": "{{#each items as row}}<b {{/each}}>" }),
    "EACH_CONTEXT_MISMATCH",
  );
  rejectCode(
    () =>
      compile({
        "index.html": '{{#each items as row}}<span title="{{row.x}}{{/each}}">',
      }),
    "EACH_CONTEXT_MISMATCH",
  );
  rejectCode(
    () =>
      compile({
        "index.html": '{{#each items as row}}{{#include "p"}}{{/each}}',
        p: "<div",
      }),
    "EACH_CONTEXT_MISMATCH",
  );
  // A balanced body compiles and renders an empty fragment for an empty list.
  const compiled = compile({
    "index.html": "<ul>{{#each items as row}}<li>{{row.name}}</li>{{/each}}</ul>",
  });
  assert.equal(compiled.render({ items: [] }), "<ul></ul>");
  assert.equal(
    compiled.render({ items: [{ name: "<x>" }] }),
    "<ul><li>&lt;x&gt;</li></ul>",
  );
});

test("each keeps text, attribute, and URL escaping contexts inside the body", () => {
  const compiled = compile({
    "index.html":
      '{{#each items as row}}<p title="{{row.name}}">{{row.name}}</p><a href="{{row.url}}">go</a>{{/each}}',
  });
  const html = compiled.render({
    items: [
      { name: `<b>"q"</b>`, url: "/ok?a=1&b=2" },
      { name: "plain", url: "https://example.com/x" },
    ],
  });
  assert.equal(
    html,
    '<p title="&lt;b&gt;&quot;q&quot;&lt;/b&gt;">&lt;b&gt;"q"&lt;/b&gt;</p><a href="/ok?a=1&amp;b=2">go</a>' +
      '<p title="plain">plain</p><a href="https://example.com/x">go</a>',
  );
});

test("each validates the list itself before rendering", () => {
  const compiled = compile({
    "index.html": "{{#each items as row}}{{row.name}}{{/each}}",
  });
  rejectCode(() => compiled.render({}), "MISSING_VARIABLE");
  rejectCode(() => compiled.render({ items: "abc" }), "VARIABLE_TYPE_ERROR");
  rejectCode(() => compiled.render({ items: {} }), "VARIABLE_TYPE_ERROR");
  rejectCode(
    () => compiled.render({ items: [["not", "plain"]] }),
    "VARIABLE_TYPE_ERROR",
  );
  rejectCode(
    () => compiled.render({ items: [null] }),
    "VARIABLE_TYPE_ERROR",
  );
  rejectCode(
    () => compiled.render({ items: Array.from({ length: 33 }, () => ({})) }),
    "EACH_LIMIT_EXCEEDED",
  );
  assert.equal(
    compiled.render({ items: Array.from({ length: 32 }, () => ({ name: "n" })) }).length,
    32,
  );
});

test("an invalid item fails the whole render atomically with include diagnostics", () => {
  const compiled = compile({
    "index.html": '<header>{{title}}</header>{{#include "list.html"}}',
    "list.html": '{{#each items as row}}<a href="{{row.url}}">{{row.name}}</a>{{/each}}',
  });
  let caught;
  try {
    compiled.render({
      title: "shop",
      items: [
        { name: "ok", url: "/ok" },
        { name: "bad", url: "javascript:alert(1)" },
      ],
    });
    assert.fail("expected render failure");
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.code, "INVALID_URL");
  assert.equal(caught.file, "list.html");
  assert.deepEqual(caught.includeChain, ["index.html", "list.html"]);
  assert.equal(caught.eachLocation, "items[1]");
  assert.match(caught.format(), /include chain: index\.html -> list\.html/);

  // A missing variable in a later item also fails before any output.
  rejectCode(
    () =>
      compiled.render({
        title: "shop",
        items: [{ name: "ok", url: "/ok" }, { url: "/no-name" }],
      }),
    "MISSING_VARIABLE",
  );
});

test("parser rejects mismatched block closers and else outside if", () => {
  rejectCode(
    () => compile({ "index.html": "{{#if x}}y{{/each}}" }),
    "INVALID_TEMPLATE_SYNTAX",
  );
  rejectCode(
    () => compile({ "index.html": "{{#each items as row}}y{{/if}}" }),
    "INVALID_TEMPLATE_SYNTAX",
  );
  rejectCode(
    () => compile({ "index.html": "{{#each items as row}}a{{else}}b{{/each}}" }),
    "INVALID_TEMPLATE_SYNTAX",
  );
  rejectCode(
    () => compile({ "index.html": "{{#each items as row}}a" }),
    "INVALID_TEMPLATE_SYNTAX",
  );
});
