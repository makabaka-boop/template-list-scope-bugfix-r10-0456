// 商品页面实例：嵌套列表 + 条件分支 + 包含模板 + 重复别名。
// 运行：node examples/product-page.mjs
import { writeFileSync } from "node:fs";
import { compileTemplates } from "../src/index.js";

const files = {
  "page.html": `<!doctype html>
<html lang="zh">
<head><meta charset="utf"></head>
<body>
<header><h1>{{shop.name}}</h1><p>{{shop.slogan}}</p></header>
<main>
{{#each catalog as item}}
<section class="category">
  <h2>{{item.name}}</h2>
  <ul class="products">
    {{#include "product-row.html"}}
  </ul>
</section>
{{/each}}
</main>
{{#if shop.promo}}<aside class="promo">{{shop.promoText}}</aside>{{else}}<aside>感谢惠顾</aside>{{/if}}
</body>
</html>`,
  // 注意：内层 each 也使用别名 item，遮蔽外层分类对象；
  // include 必须读到当前商品而不是外层分类或上一轮的商品。
  "product-row.html": `{{#each item.products as item}}<li class="product">
    <a href="{{item.url}}" title="{{item.name}}">{{item.name}}</a>
    {{#if item.sale}}<strong class="sale">特价</strong>{{/if}}
    {{#if item.hasTags}}<div class="tags">{{#each item.tags as tag}}<span>{{tag.label}}</span>{{/each}}</div>{{/if}}
  </li>{{/each}}`,
};

const data = {
  shop: {
    name: "示例商城",
    slogan: "嵌套模板 & 特殊字符 <正常显示>",
    promo: true,
    promoText: "满 99 包邮 & 7 天无理由",
  },
  catalog: [
    {
      name: "图书",
      products: [
        {
          name: "A&B 指南",
          url: "/book/a-b?ref=home&sort=1",
          sale: true,
          hasTags: true,
          tags: [{ label: "新书" }, { label: "热门" }],
        },
        {
          name: "<前端> 安全渲染",
          url: "https://cdn.example.org/book/frontend",
          sale: false,
          hasTags: false,
          tags: [],
        },
      ],
    },
    {
      name: "周边",
      products: [
        {
          name: "马克杯",
          url: "products/../mug?x=1",
          sale: true,
          hasTags: true,
          tags: [{ label: "限量" }],
        },
      ],
    },
  ],
};

const compiled = compileTemplates(files, "page.html", {
  baseUrl: "https://shop.example.com/app/",
});

const before = JSON.stringify(data);
const html = compiled.render(data);
if (JSON.stringify(data) !== before) throw new Error("渲染修改了输入数据");

writeFileSync(new URL("./product-page.html", import.meta.url), html);
console.log("已生成 examples/product-page.html，字节数：", Buffer.byteLength(html));
console.log("输入数据未被修改，根数据键 item =", data.item);
