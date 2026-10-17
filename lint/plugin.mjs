// TastyTunes' own lint rules (0.11.0, the foundations sweep). They replace the
// invariant suite's source-text pins for "one home" rules and banned APIs:
// a pin read normalised source text with a regex, ran only inside the
// 25-minute gate, saw comments, and broke on every refactor; a rule reads the
// syntax tree, runs on every commit (npm run check, CI on push), and points at
// the line. Each rule's entries live in ./rules.mjs with the example of the
// code it forbids, and ./rules.test.mjs proves every entry fires on its
// example and stays quiet where it is allowed.
import { relative, sep } from "node:path";

/** The file being linted as a repo-relative POSIX path ("src/main/app/menu.ts"). */
const repoPath = (context) => relative(context.cwd, context.filename).split(sep).join("/");

const matches = (path, patterns) => (patterns ?? []).some((p) => new RegExp(p).test(path));

/**
 * One rule for every entry of RULES: an AST selector that must not match,
 * outside the entry's `allow` files, inside its `files` (all of src when
 * absent). The report names the entry, so a hit says which rule it broke.
 */
const oneHome = {
  meta: {
    type: "problem",
    docs: { description: "TastyTunes' one-home rules and banned patterns (lint/rules.mjs)" },
    schema: { type: "array" },
    messages: { broke: "{{message}} [{{id}}]" },
  },
  create(context) {
    const path = repoPath(context);
    const listeners = {};
    for (const entry of context.options) {
      if (entry.files && !matches(path, entry.files)) continue;
      if (matches(path, entry.allow)) continue;
      const report = (node) =>
        context.report({
          node,
          messageId: "broke",
          data: { id: entry.id, message: entry.message },
        });
      const prev = listeners[entry.selector];
      listeners[entry.selector] = prev
        ? (node) => {
            prev(node);
            report(node);
          }
        : report;
    }
    return listeners;
  },
};

/**
 * No em dash aside in copy a reader sees (the register: commas and full
 * sentences, never an em dash aside). An aside is a dash with a letter on at
 * least one side, the way the invariant suite's S76 read it: in JSX text a
 * letter (and closing punctuation) before the dash or a letter after it; in a
 * string a letter on both sides, or a string that opens with one. A dash on
 * its own (an empty-value placeholder) is not an aside.
 */
const JSX_ASIDE = /\p{L}[.,)’';]* ?—|— ?\p{L}/u;
const STRING_ASIDE = /\p{L}[.,)’';]* ?— ?\p{L}|^ ?— ?\p{L}/u;
const noDashAside = {
  meta: {
    type: "problem",
    docs: { description: "No em dash aside in user-facing copy" },
    schema: [],
    messages: { aside: "An em dash aside in copy; use a comma or a full stop (the register)" },
  },
  create(context) {
    const check = (node, text, re) => {
      if (typeof text === "string" && re.test(text)) context.report({ node, messageId: "aside" });
    };
    return {
      JSXText: (node) => check(node, node.value, JSX_ASIDE),
      Literal: (node) => check(node, node.value, STRING_ASIDE),
      TemplateElement: (node) => check(node, node.value.cooked, STRING_ASIDE),
    };
  },
};

export default {
  meta: { name: "tastytunes" },
  rules: { "one-home": oneHome, "no-dash-aside": noDashAside },
};
