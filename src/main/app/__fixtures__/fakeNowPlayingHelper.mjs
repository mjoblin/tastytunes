// A stand-in for the Now Playing helper (native/nowplaying) in nowPlayingBridge.test: it says
// hello (or what --hello names), writes every line it is sent to the --record file, and after
// the first "info" (or the first message --on names) prints the --then line (a command, as the
// real helper prints a key press, or a log line); with --die it ends before its hello instead,
// and with --quiet it never says hello (a helper slow to start).
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const record = arg("--record");
const then = arg("--then");
// --die: end before the hello with a line on stderr, as a helper that can't run on this system
const die = arg("--die");
if (die) {
  process.stderr.write(`${die}\n`);
  process.exit(2);
}
let sent = false;
const on = arg("--on") ?? "info";
if (!process.argv.includes("--quiet"))
  process.stdout.write(`${arg("--hello") ?? "hello tastytunes-nowplaying 1"}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  if (record) appendFileSync(record, `${line}\n`);
  if (!sent && then && line.includes(`"t":"${on}"`)) {
    sent = true;
    process.stdout.write(`${then}\n`);
  }
});
process.stdin.on("end", () => process.exit(0));
