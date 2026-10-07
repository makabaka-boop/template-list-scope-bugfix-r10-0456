import { fail, TemplateError } from "./errors.js";
import { parseTemplate } from "./template-parser.js";
import { createScanner } from "./html-scanner.js";

const MAX_FILES = 6;
const MAX_TOTAL_BYTES = 20 * 1024;
const DEFAULT_BASE_URL = "http://localhost/";

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

function normalizeIncludeTarget(target, fromFile) {
  if (
    !target ||
    target[0] === "/" ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)
  ) {
    fail("include target must be a relative file path", {
      code: "INVALID_INCLUDE",
    });
  }
  const baseParts = fromFile.split("/").slice(0, -1);
  const parts = target.split("/");
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (baseParts.length === 0)
        fail("include path escapes the file map", { code: "INVALID_INCLUDE" });
      baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  return baseParts.join("/");
}

function hasForbiddenControlCharacter(value) {
  return /\p{Cc}/u.test(value);
}

export function safeUrl(value, baseUrl = DEFAULT_BASE_URL) {
  if (typeof value !== "string") throw new TypeError("URL must be a string");
  if (
    value === "" ||
    hasForbiddenControlCharacter(value) ||
    /[\t\n\f\r ]/.test(value) ||
    value.includes("\\") ||
    value.startsWith("//")
  ) {
    throw new TemplateError(
      "URL is not a permitted http(s) absolute URL or site-relative path",
      {
        code: "INVALID_URL",
      },
    );
  }

  let parsed;
  try {
    parsed = new URL(value, baseUrl);
  } catch {
    throw new TemplateError("URL cannot be parsed against the fixed base URL", {
      code: "INVALID_URL",
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TemplateError(`URL protocol ${parsed.protocol} is not allowed`, {
      code: "INVALID_URL",
    });
  }
  const base = new URL(baseUrl);
  if (parsed.origin === base.origin) {
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  return parsed.href;
}

class TemplateGraph {
  constructor(files, baseUrl) {
    this.files = files;
    this.baseUrl = baseUrl;
    this.astCache = new Map();
    this.includedFiles = new Set();
    this.totalBytes = 0;
    const names = Object.entries(files);
    if (names.length > MAX_FILES) {
      fail(`received ${names.length} template files; limit is ${MAX_FILES}`, {
        code: "TEMPLATE_LIMIT_EXCEEDED",
      });
    }
    for (const [name, content] of names) {
      if (typeof content !== "string") {
        fail(`template ${name} must be a string`, {
          code: "INVALID_TEMPLATE_FILE",
          file: name,
        });
      }
      this.totalBytes += byteLength(content);
    }
    if (this.totalBytes > MAX_TOTAL_BYTES) {
      fail(
        `templates are ${this.totalBytes} bytes; limit is ${MAX_TOTAL_BYTES} bytes`,
        {
          code: "TEMPLATE_LIMIT_EXCEEDED",
        },
      );
    }
  }

  getAst(file, referenceLoc, chain) {
    if (!Object.prototype.hasOwnProperty.call(this.files, file)) {
      fail(`included template ${file} was not provided`, {
        code: "MISSING_INCLUDE_FILE",
        file: referenceLoc?.file,
        position: referenceLoc,
        includeChain: chain,
      });
    }
    if (!this.astCache.has(file))
      this.astCache.set(file, parseTemplate(this.files[file], file));
    return this.astCache.get(file);
  }
}

function withChain(error, chain, loc) {
  if (error instanceof TemplateError) {
    if (!error.includeChain) error.includeChain = [...chain];
    if (!error.file && loc?.file) error.file = loc.file;
    if (!error.position && loc) error.position = loc;
  }
  return error;
}

function compileNodes(nodes, scanner, graph, chain, program) {
  for (const node of nodes) {
    if (node.type === "literal") {
      scanner.literal(node.text, node.loc);
      program.push({
        type: "literal",
        value: node.text,
        loc: node.loc,
        chain: [...chain],
      });
    } else if (node.type === "output") {
      const context = scanner.output(node.loc);
      program.push({
        type: "output",
        kind: context.kind,
        path: node.path,
        loc: node.loc,
        chain: [...chain],
      });
    } else if (node.type === "each") {
      compileEach(node, scanner, graph, chain, program);
    } else if (node.type === "if") {
      compileIf(node, scanner, graph, chain, program);
    } else if (node.type === "include") {
      compileInclude(node, scanner, graph, chain, program);
    }
  }
}

function compileEach(node, scanner, graph, chain, program) {
  // A list block is structurally independent of runtime data: it must begin
  // in HTML text state, and one iteration must return to that same state, so
  // zero or many iterations all keep the surrounding document valid.
  if (!scanner.isData()) {
    fail("each block must start in HTML text state", {
      code: "EACH_NOT_IN_TEXT_CONTEXT",
      file: node.loc.file,
      position: node.loc,
      includeChain: [...chain],
    });
  }
  const bodyScanner = scanner.clone();
  const body = [];
  try {
    compileNodes(node.nodes, bodyScanner, graph, chain, body);
  } catch (error) {
    if (error instanceof TemplateError && !error.includeChain)
      error.includeChain = [...chain];
    throw error;
  }
  if (!bodyScanner.isData()) {
    fail("each body must return to the same HTML text state it started in", {
      code: "INCOMPATIBLE_EACH_CONTEXT",
      file: node.loc.file,
      position: node.loc,
      includeChain: [...chain],
    });
  }
  // The body is scanned only for structural validation; the outer scanner
  // stays in the state before the block (empty iterations emit nothing).
  program.push({
    type: "each",
    path: node.path,
    alias: node.alias,
    nodes: body,
    loc: node.loc,
    chain: [...chain],
  });
}

function compileIf(node, scanner, graph, chain, program) {
  const beforeIf = scanner.clone();
  const thenScanner = scanner.clone();
  const thenProgram = [];
  compileNodes(node.nodes, thenScanner, graph, chain, thenProgram);

  const elseScanner = beforeIf.clone();
  const elseProgram = [];
  compileNodes(node.elseNodes, elseScanner, graph, chain, elseProgram);

  try {
    thenScanner.merge(elseScanner);
  } catch (error) {
    if (error instanceof TemplateError) {
      error.code = "INCOMPATIBLE_BRANCH_CONTEXT";
      error.file = node.loc.file;
      error.position = node.loc;
      error.includeChain = [...chain];
    }
    throw error;
  }
  scanner.restore(thenScanner);
  program.push({
    type: "if",
    path: node.path,
    thenNodes: thenProgram,
    elseNodes: elseProgram,
    loc: node.loc,
    chain: [...chain],
  });
}

function compileInclude(node, scanner, graph, chain, program) {
  const target = normalizeIncludeTarget(node.target, chain[chain.length - 1]);
  const nextChain = [...chain, target];
  if (chain.includes(target)) {
    fail(`include cycle detected at ${target}`, {
      code: "INCLUDE_CYCLE",
      file: node.loc.file,
      position: node.loc,
      includeChain: nextChain,
    });
  }
  if (nextChain.length > MAX_FILES) {
    fail(`include depth/file count exceeds ${MAX_FILES}`, {
      code: "TEMPLATE_LIMIT_EXCEEDED",
      file: node.loc.file,
      position: node.loc,
      includeChain: nextChain,
    });
  }
  graph.includedFiles.add(target);
  let ast;
  try {
    ast = graph.getAst(target, node.loc, nextChain);
  } catch (error) {
    throw withChain(error, nextChain, node.loc);
  }
  const includedProgram = [];
  try {
    compileNodes(ast.nodes, scanner, graph, nextChain, includedProgram);
  } catch (error) {
    throw withChain(error, nextChain, node.loc);
  }
  program.push({
    type: "include",
    target,
    nodes: includedProgram,
    loc: node.loc,
    chain: [...nextChain],
  });
}

export function compileTemplates(files, entry, options = {}) {
  if (!files || typeof files !== "object")
    fail("files must be an object", { code: "INVALID_ARGUMENT" });
  if (!Object.prototype.hasOwnProperty.call(files, entry)) {
    fail(`entry template ${entry} was not provided`, {
      code: "MISSING_ENTRY_FILE",
      file: entry,
    });
  }
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const parsedBase = new URL(baseUrl);
  if (parsedBase.protocol !== "http:" && parsedBase.protocol !== "https:") {
    fail("baseUrl must use http or https", { code: "INVALID_ARGUMENT" });
  }
  const graph = new TemplateGraph(files, baseUrl);
  const chain = [entry];
  const ast = graph.getAst(entry, null, chain);
  graph.includedFiles.add(entry);
  const scanner = createScanner();
  const program = [];
  compileNodes(ast.nodes, scanner, graph, chain, program);
  scanner.assertComplete();

  if (graph.includedFiles.size > MAX_FILES) {
    fail(
      `compilation uses ${graph.includedFiles.size} files; limit is ${MAX_FILES}`,
      {
        code: "TEMPLATE_LIMIT_EXCEEDED",
      },
    );
  }

  return {
    program,
    files: [...graph.includedFiles],
    baseUrl,
    render(data = {}) {
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        fail("render data must be a plain object", {
          code: "VARIABLE_TYPE_ERROR",
        });
      }
      // The caller's data object is the read-only outermost scope. Iteration
      // aliases live in null-prototype frames pushed on top, so they can never
      // mutate the input or the Object prototype (even an alias like
      // "__proto__").
      const scope = { frames: [data] };
      validateProgram(program, scope, baseUrl);
      return renderProgram(program, scope, baseUrl);
    },
  };
}

const MAX_EACH_ITEMS = 32;

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function pushAlias(scope, alias, row) {
  const frame = Object.create(null);
  frame[alias] = row;
  scope.frames.push(frame);
}

function popAlias(scope) {
  scope.frames.pop();
}

function failAtNode(node, message, code, cause) {
  fail(message, {
    code,
    file: node.loc?.file,
    position: node.loc,
    includeChain: node.chain && node.chain.length > 1 ? [...node.chain] : undefined,
    cause,
  });
}

function requireSafeUrl(value, baseUrl, loc, chain) {
  try {
    return safeUrl(value, baseUrl);
  } catch (error) {
    if (error instanceof TemplateError) {
      fail(error.message, {
        code: "INVALID_URL",
        file: loc?.file,
        position: loc,
        includeChain: chain && chain.length > 1 ? [...chain] : undefined,
        cause: error,
      });
    }
    throw error;
  }
}

function lookup(path, scope, loc, chain) {
  let current;
  let found = false;
  // The first path segment resolves against the innermost alias frame first,
  // shadowing outer aliases and root data without changing either.
  for (let i = scope.frames.length - 1; i >= 0; i -= 1) {
    const frame = scope.frames[i];
    if (Object.prototype.hasOwnProperty.call(frame, path[0])) {
      current = frame[path[0]];
      found = true;
      break;
    }
  }
  if (!found) {
    fail(`missing variable ${path.join(".")}`, {
      code: "MISSING_VARIABLE",
      file: loc?.file,
      position: loc,
      includeChain: chain && chain.length > 1 ? [...chain] : undefined,
    });
  }
  for (let i = 1; i < path.length; i += 1) {
    const key = path[i];
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, key)
    ) {
      fail(`missing variable ${path.join(".")}`, {
        code: "MISSING_VARIABLE",
        file: loc?.file,
        position: loc,
        includeChain: chain && chain.length > 1 ? [...chain] : undefined,
      });
    }
    current = current[key];
  }
  return current;
}

function validateProgram(nodes, scope, baseUrl) {
  for (const node of nodes) {
    if (node.type === "literal") continue;
    if (node.type === "output") {
      const value = lookup(node.path, scope, node.loc, node.chain);
      if (typeof value !== "string") {
        failAtNode(
          node,
          `variable ${node.path.join(".")} must be a string`,
          "VARIABLE_TYPE_ERROR",
        );
      }
      if (node.kind === "url") requireSafeUrl(value, baseUrl, node.loc, node.chain);
    } else if (node.type === "if") {
      const value = lookup(node.path, scope, node.loc, node.chain);
      if (typeof value !== "boolean") {
        failAtNode(
          node,
          `if variable ${node.path.join(".")} must be a boolean`,
          "VARIABLE_TYPE_ERROR",
        );
      }
      validateProgram(
        value ? node.thenNodes : node.elseNodes,
        scope,
        baseUrl,
      );
    } else if (node.type === "each") {
      const value = lookup(node.path, scope, node.loc, node.chain);
      if (!Array.isArray(value)) {
        failAtNode(
          node,
          `each variable ${node.path.join(".")} must be an array`,
          "VARIABLE_TYPE_ERROR",
        );
      }
      if (value.length > MAX_EACH_ITEMS) {
        failAtNode(
          node,
          `each variable ${node.path.join(".")} has ${value.length} items; limit is ${MAX_EACH_ITEMS}`,
          "EACH_LIMIT_EXCEEDED",
        );
      }
      // Validate every item before any output is constructed so a single bad
      // later item fails the whole render atomically.
      for (const row of value) {
        if (!isPlainObject(row)) {
          failAtNode(
            node,
            `each item of ${node.path.join(".")} must be a plain object`,
            "VARIABLE_TYPE_ERROR",
          );
        }
        pushAlias(scope, node.alias, row);
        try {
          validateProgram(node.nodes, scope, baseUrl);
        } finally {
          popAlias(scope);
        }
      }
    } else if (node.type === "include") {
      validateProgram(node.nodes, scope, baseUrl);
    }
  }
}

function escapeHtmlText(value) {
  return value.replace(/[&<>]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
    }
  });
}

function escapeHtmlAttribute(value) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#x27;";
    }
  });
}

function renderProgram(nodes, scope, baseUrl) {
  let output = "";
  for (const node of nodes) {
    if (node.type === "literal") {
      output += node.value;
    } else if (node.type === "output") {
      const value = lookup(node.path, scope, node.loc, node.chain);
      if (node.kind === "text") output += escapeHtmlText(value);
      else if (node.kind === "url")
        output += escapeHtmlAttribute(
          requireSafeUrl(value, baseUrl, node.loc, node.chain),
        );
      else output += escapeHtmlAttribute(value);
    } else if (node.type === "each") {
      const value = lookup(node.path, scope, node.loc, node.chain);
      for (const row of value) {
        pushAlias(scope, node.alias, row);
        try {
          output += renderProgram(node.nodes, scope, baseUrl);
        } finally {
          popAlias(scope);
        }
      }
    } else if (node.type === "if") {
      const value = lookup(node.path, scope, node.loc, node.chain);
      output += renderProgram(
        value ? node.thenNodes : node.elseNodes,
        scope,
        baseUrl,
      );
    } else if (node.type === "include") {
      output += renderProgram(node.nodes, scope, baseUrl);
    }
  }
  return output;
}
