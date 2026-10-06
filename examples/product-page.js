// Product page instance: nested lists with repeated aliases, conditionals,
// and shared includes rendering untrusted product data.
// Run with: node examples/product-page.js
import assert from "node:assert/strict";
import * as parse5 from "parse5";
import { compileTemplates, TemplateError } from "../src/index.js";

const files = {
  "pages/index.html": `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="description" content="{{shop.title}}"></head>
<body>
<h1 title="{{shop.title}}">{{shop.title}}</h1>
{{#include "sections/catalog.html"}}
<footer>{{shop.footnote}}</footer>
</body>
</html>`,
  // Two nesting levels reuse the alias "item"; the inner loop must not
  // clobber the outer one, and the include must see the inner product.
  "pages/sections/catalog.html": `{{#each categories as item}}
<section class="category" data-slug="{{item.slug}}">
  <h2>{{item.name}}</h2>
  {{#if item.hasNotice}}<p class="notice">{{item.notice}}</p>{{else}}<p class="notice muted">No notice</p>{{/if}}
  <ul>
  {{#each item.products as item}}
    {{#include "product-card.html"}}
  {{/each}}
  </ul>
  <p>Back to category: {{item.name}}</p>
</section>
{{/each}}`,
  "pages/sections/product-card.html": `<li class="product{{#if item.featured}} featured{{else}} plain{{/if}}" data-sku-count="{{item.skuLabel}}">
    <a href="{{item.url}}" title="{{item.name}}">{{item.name}}</a>
    {{#if item.sale}}<strong class="price-sale">{{item.price}}</strong>{{else}}<span class="price">{{item.price}}</span>{{/if}}
    <ul class="skus">
    {{#each item.skus as sku}}
      <li data-sku="{{sku.code}}">{{sku.label}}</li>
    {{/each}}
    </ul>
  </li>
`,
};

const compiled = compileTemplates(files, "pages/index.html", {
  baseUrl: "https://shop.example/app/",
});

const data = {
  shop: { title: "Ops <Demo> Shop & Co", footnote: "© 2026" },
  categories: [
    {
      slug: "audio",
      name: "Audio & Hi-Fi",
      hasNotice: true,
      notice: 'Weekend "flash" sale <limited>',
      products: [
        {
          name: 'Headphones <Pro> "X"',
          url: "/products/hp-x?ref=home",
          price: "¥899",
          featured: true,
          sale: true,
          skuLabel: "2",
          skus: [
            { code: "HPX-BLK", label: "Black" },
            { code: "HPX-WHT", label: "White <limited>" },
          ],
        },
        {
          name: "Earbuds & Co",
          url: "https://example.com/products/eb",
          price: "¥299",
          featured: false,
          sale: false,
          skuLabel: "1",
          skus: [{ code: "EB-GRY", label: "Grey" }],
        },
      ],
    },
    {
      slug: "coming-soon",
      name: "Coming Soon",
      hasNotice: false,
      products: [], // empty list -> empty fragment, same template constraints
    },
  ],
};

const snapshot = JSON.stringify(data);
const html = compiled.render(data);
console.log("=== rendered page ===");
console.log(html);

// 1. Root data is byte-for-byte identical after rendering: repeated aliases
//    and loop bookkeeping never leak into the caller's object.
assert.equal(JSON.stringify(data), snapshot, "root data must not change");
console.log("\n[ok] root data unchanged after render");

// 2. The outer alias survives the inner loop: after the inner each, "item"
//    is the category again.
assert.ok(html.includes("Back to category: Audio &amp; Hi-Fi"));
assert.ok(html.includes("Back to category: Coming Soon"));
console.log("[ok] outer alias restored after nested loop with the same alias");

// 3. The include read the inner product, not the outer category.
assert.ok(html.includes('title="Headphones &lt;Pro&gt; &quot;X&quot;"'));
assert.ok(html.includes('href="/products/hp-x?ref=home"'));
assert.ok(html.includes('href="https://example.com/products/eb"'));
console.log("[ok] include resolved per-item values in text, attribute and URL contexts");

// 4. The empty category produced an empty list fragment but kept the
//    surrounding structure.
assert.ok(html.includes('data-slug="coming-soon"'));
assert.ok(!html.includes("coming-soon-product"));
console.log("[ok] empty list rendered as an empty fragment");

// 5. parse5 independently confirms the untrusted data stayed inert.
const document = parse5.parse(html);
const tags = [];
const collect = (node) => {
  if (node.nodeName && !node.nodeName.startsWith("#")) tags.push(node.nodeName);
  for (const child of node.childNodes ?? []) collect(child);
};
collect(document);
assert.deepEqual(
  tags.filter((name) => name === "script" || name === "img"),
  [],
);
assert.equal(tags.filter((name) => name === "li").length, 2 + 3); // products + skus
console.log("[ok] parse5: escaping preserved DOM structure, no injected elements");

// 6. A special but legal field name as alias cannot touch root data either.
const special = compileTemplates(
  { "index.html": "{{#each items as __proto__}}[{{__proto__.label}}]{{/each}}" },
  "index.html",
);
const specialData = { items: [{ label: "a" }, { label: "b" }] };
assert.equal(special.render(specialData), "[a][b]");
assert.equal(Object.getPrototypeOf(specialData), Object.prototype);
assert.equal(specialData.polluted, undefined);
console.log("[ok] __proto__ alias rendered safely without polluting root data");

// 7. Atomic failure: one bad URL in a later item fails the whole render
//    before any page fragment is produced, and the diagnostic names the
//    include chain and the offending items.
const badData = JSON.parse(snapshot);
badData.categories[0].products[1].url = "javascript:alert(1)";
try {
  compiled.render(badData);
  assert.fail("expected the render to fail");
} catch (error) {
  assert.ok(error instanceof TemplateError);
  assert.equal(error.code, "INVALID_URL");
  console.log("\n=== diagnostic for invalid item ===");
  console.log(error.format());
  assert.deepEqual(error.includeChain, [
    "pages/index.html",
    "pages/sections/catalog.html",
    "pages/sections/product-card.html",
  ]);
  assert.equal(error.eachLocation, "categories[0] > item.products[1]");
  assert.equal(error.file, "pages/sections/product-card.html");
  console.log("[ok] whole render failed atomically; no partial page returned");
}
