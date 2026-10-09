// Every lint rule entry fires on the code it forbids, in the file it names, and
// stays quiet in a file it allows; the dash rule tells an aside from a lone
// placeholder dash. A rule that never fires guards nothing, which is how three
// of the suite's old pins ended up checking almost nothing (their comment
// stripping ran on text with the newlines already collapsed).
import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import plugin from "./plugin.mjs";
import { ONE_HOME } from "./rules.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
});
const cwd = process.cwd();
const at = (file) => `${cwd}/${file}`;
const options = ONE_HOME.map(({ bad: _bad, was: _was, ...entry }) => entry);

// the first allowed path of an entry, made concrete, for its quiet case
const allowedFile = (entry) => {
  const pattern = entry.allow?.[0];
  if (!pattern) return null;
  const path = pattern.replace(/^\^/, "").replace(/\$$/, "").replace(/\\\./g, ".").replace(/^\//, "");
  return path.startsWith("src/") ? path : `src/renderer/src/${path}`;
};

tester.run("tastytunes/one-home", plugin.rules["one-home"], {
  valid: ONE_HOME.filter(allowedFile).map((entry) => ({
    name: `${entry.id} is allowed in its home`,
    code: entry.bad.code,
    filename: at(allowedFile(entry)),
    options,
  })),
  invalid: ONE_HOME.map((entry) => ({
    name: `${entry.id} fires on its example`,
    code: entry.bad.code,
    filename: at(entry.bad.file),
    options,
    errors: [{ messageId: "broke", data: { id: entry.id, message: entry.message } }],
  })),
});

tester.run("tastytunes/no-dash-aside", plugin.rules["no-dash-aside"], {
  valid: [
    { name: "a lone dash placeholder", code: "const s = '—';", filename: at("src/renderer/src/a.tsx") },
    { name: "a spaced dash between numbers", code: "const s = '3 — 4';", filename: at("src/renderer/src/a.tsx") },
    { name: "commas in copy", code: "const x = <p>Saved, and done</p>;", filename: at("src/renderer/src/a.tsx") },
  ],
  invalid: [
    { name: "an aside in a string", code: "const s = 'Saved — done';", filename: at("src/renderer/src/a.tsx"), errors: [{ messageId: "aside" }] },
    { name: "an aside in JSX text", code: "const x = <p>Saved — done</p>;", filename: at("src/renderer/src/a.tsx"), errors: [{ messageId: "aside" }] },
    { name: "an aside in a template", code: "const s = `Saved — done, ${n} left`;", filename: at("src/renderer/src/a.tsx"), errors: [{ messageId: "aside" }] },
  ],
});
