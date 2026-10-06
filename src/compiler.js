import { fail, TemplateError } from "./errors.js";
import { parseTemplate } from "./template-parser.js";
import { createScanner } from "./html-scanner.js";

const MAX_FILES = 6;
const MAX_TOTAL_BYTES = 20 * 1024;
const MAX_EACH_ITEMS = 32;
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
      program.push({ type: "literal", value: node.text });
    } else if (node.type === "output") {
      const context = scanner.output(node.loc);
      program.push({
        type: "output",
        kind: context.kind,
        path: node.path,
        loc: node.loc,
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
  if (!scanner.inText()) {
    fail("each block must begin in HTML text content", {
      code: "EACH_OUTSIDE_TEXT_CONTEXT",
      file: node.loc.file,
      position: node.loc,
    });
  }
  // The body is reviewed once, independently of the runtime array: it must
  // leave every iteration in the same text context where it began.
  const bodyScanner = createScanner();
  const body = [];
  compileNodes(node.nodes, bodyScanner, graph, chain, body);
  if (!bodyScanner.inText()) {
    fail("each body must end in the same HTML text context where it began", {
      code: "EACH_CONTEXT_MISMATCH",
      file: node.loc.file,
      position: node.loc,
    });
  }
  program.push({
    type: "each",
    path: node.path,
    alias: node.alias,
    nodes: body,
    loc: node.loc,
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
      const scope = createRootScope(data);
      validateProgram(program, scope, baseUrl, [entry]);
      return renderProgram(program, scope, baseUrl);
    },
  };
}

function requireSafeUrl(value, baseUrl, loc) {
  try {
    return safeUrl(value, baseUrl);
  } catch (error) {
    if (error instanceof TemplateError) {
      fail(error.message, {
        code: "INVALID_URL",
        file: loc?.file,
        position: loc,
        cause: error,
      });
    }
    throw error;
  }
}

// Render-time data is a scope chain: each loop iteration pushes a frame that
// binds the alias in a null-prototype map, so aliases (including names like
// "__proto__") shadow outer variables without ever mutating the caller's
// root data.
function createRootScope(data) {
  return { parent: null, vars: null, root: data };
}

function childScope(scope, alias, value) {
  const vars = Object.create(null);
  vars[alias] = value;
  return { parent: scope, vars, root: scope.root };
}

function lookup(path, scope, loc) {
  const [head, ...rest] = path;
  let current;
  let found = false;
  for (let frame = scope; frame; frame = frame.parent) {
    if (frame.vars && Object.prototype.hasOwnProperty.call(frame.vars, head)) {
      current = frame.vars[head];
      found = true;
      break;
    }
  }
  if (!found) {
    const root = scope.root;
    if (
      root !== null &&
      typeof root === "object" &&
      Object.prototype.hasOwnProperty.call(root, head)
    ) {
      current = root[head];
      found = true;
    }
  }
  if (!found) {
    fail(`missing variable ${path.join(".")}`, {
      code: "MISSING_VARIABLE",
      file: loc?.file,
      position: loc,
    });
  }
  for (const key of rest) {
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, key)
    ) {
      fail(`missing variable ${path.join(".")}`, {
        code: "MISSING_VARIABLE",
        file: loc?.file,
        position: loc,
      });
    }
    current = current[key];
  }
  return { value: current };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validateProgram(nodes, scope, baseUrl, chain) {
  for (const node of nodes) {
    try {
      validateNode(node, scope, baseUrl, chain);
    } catch (error) {
      if (error instanceof TemplateError && !error.includeChain)
        error.includeChain = [...chain];
      throw error;
    }
  }
}

function validateNode(node, scope, baseUrl, chain) {
  if (node.type === "literal") return;
  if (node.type === "output") {
    const { value } = lookup(node.path, scope, node.loc);
    if (typeof value !== "string") {
      fail(`variable ${node.path.join(".")} must be a string`, {
        code: "VARIABLE_TYPE_ERROR",
        file: node.loc?.file,
        position: node.loc,
      });
    }
    if (node.kind === "url") requireSafeUrl(value, baseUrl, node.loc);
    return;
  }
  if (node.type === "if") {
    const { value } = lookup(node.path, scope, node.loc);
    if (typeof value !== "boolean") {
      fail(`if variable ${node.path.join(".")} must be a boolean`, {
        code: "VARIABLE_TYPE_ERROR",
        file: node.loc?.file,
        position: node.loc,
      });
    }
    validateProgram(
      value ? node.thenNodes : node.elseNodes,
      scope,
      baseUrl,
      chain,
    );
    return;
  }
  if (node.type === "each") {
    const name = node.path.join(".");
    const { value } = lookup(node.path, scope, node.loc);
    if (!Array.isArray(value)) {
      fail(`each variable ${name} must be an array`, {
        code: "VARIABLE_TYPE_ERROR",
        file: node.loc?.file,
        position: node.loc,
      });
    }
    if (value.length > MAX_EACH_ITEMS) {
      fail(
        `each variable ${name} has ${value.length} items; limit is ${MAX_EACH_ITEMS}`,
        {
          code: "EACH_LIMIT_EXCEEDED",
          file: node.loc?.file,
          position: node.loc,
        },
      );
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!isPlainObject(value[index])) {
        fail(`each item ${name}[${index}] must be a plain object`, {
          code: "VARIABLE_TYPE_ERROR",
          file: node.loc?.file,
          position: node.loc,
        });
      }
    }
    // Every item is validated before anything renders, so an invalid item
    // fails the whole render instead of emitting earlier page fragments.
    for (let index = 0; index < value.length; index += 1) {
      try {
        validateProgram(
          node.nodes,
          childScope(scope, node.alias, value[index]),
          baseUrl,
          chain,
        );
      } catch (error) {
        if (error instanceof TemplateError) {
          error.eachLocation = error.eachLocation
            ? `${name}[${index}] > ${error.eachLocation}`
            : `${name}[${index}]`;
        }
        throw error;
      }
    }
    return;
  }
  if (node.type === "include") {
    validateProgram(node.nodes, scope, baseUrl, [...chain, node.target]);
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
      const { value } = lookup(node.path, scope, node.loc);
      if (node.kind === "text") output += escapeHtmlText(value);
      else if (node.kind === "url")
        output += escapeHtmlAttribute(requireSafeUrl(value, baseUrl, node.loc));
      else output += escapeHtmlAttribute(value);
    } else if (node.type === "each") {
      const { value } = lookup(node.path, scope, node.loc);
      for (const item of value) {
        output += renderProgram(
          node.nodes,
          childScope(scope, node.alias, item),
          baseUrl,
        );
      }
    } else if (node.type === "if") {
      const { value } = lookup(node.path, scope, node.loc);
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
