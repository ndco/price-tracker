#!/usr/bin/env node
// One command for every check that does not need a browser:
//   node test/run.js
// The extractor fixture suite needs real DOM APIs and lives in
// test/extract.html — `node test/run.js --serve` hosts it for you.

const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EXT = path.join(ROOT, "price-tracker");

let failed = 0;
const head = (s) => console.log("\n\x1b[1m" + s + "\x1b[0m");
const good = (s) => console.log("  \x1b[32m✓\x1b[0m " + s);
const bad = (s) => { failed++; console.log("  \x1b[31m✗\x1b[0m " + s); };

// --- 1. every file parses ----------------------------------------------------
head("Syntax");
for (const f of fs.readdirSync(EXT).filter((f) => f.endsWith(".js"))) {
  try {
    execFileSync(process.execPath, ["--check", path.join(EXT, f)], { stdio: "pipe" });
    good(f);
  } catch (e) { bad(f + " — " + String(e.stderr || e).split("\n")[1]); }
}
try {
  const m = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  good("manifest.json (v" + m.version + ")");
} catch (e) { bad("manifest.json — " + e.message); }

// --- 2. everything the manifest and the pages reference actually exists ------
head("References");
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
const referenced = new Set([manifest.background.service_worker, manifest.action.default_popup]);
for (const set of [manifest.icons, manifest.action.default_icon]) {
  for (const p of Object.values(set || {})) referenced.add(p);
}
const popupHtml = fs.readFileSync(path.join(EXT, "popup.html"), "utf8");
for (const m of popupHtml.matchAll(/(?:src|href)="([^"]+)"/g)) referenced.add(m[1]);
const worker = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
const imp = /importScripts\(([^)]*)\)/.exec(worker);
if (imp) for (const m of imp[1].matchAll(/"([^"]+)"/g)) referenced.add(m[1]);
for (const m of worker.matchAll(/files:\s*\[([^\]]*)\]/g)) {
  for (const f of m[1].matchAll(/"([^"]+)"/g)) referenced.add(f[1]);
}
for (const r of referenced) {
  fs.existsSync(path.join(EXT, r)) ? good(r) : bad("missing: " + r);
}

// --- 2b. injected scripts get their dependencies ----------------------------
// The extractor's JSON-LD layer reads `PTLd` from the page's isolated world.
// A caller that injects the extractor without injecting ldparse.js first gets
// no error — the best layer just silently does nothing and a weaker one
// answers. That shipped once; this check is why it cannot ship again.
head("Injection wiring");
for (const f of ["popup.js", "background.js"]) {
  const src = fs.readFileSync(path.join(EXT, f), "utf8");
  const calls = [...src.matchAll(/executeScript\(\s*\{[\s\S]{0,220}?\}\s*\)/g)].map((m) => m[0]);
  const injectsExtractor = calls.filter((c) => c.includes("inject-extract.js"));
  if (!injectsExtractor.length) { good(f + " — injects nothing"); continue; }
  const injectsLd = calls.some((c) => c.includes("ldparse.js"));
  injectsLd
    ? good(f + " — injects ldparse.js alongside the extractor")
    : bad(f + " — injects inject-extract.js but never ldparse.js (JSON-LD layer would be dead)");
}

// --- 2c. every message the worker answers has someone asking ----------------
// `checkOne` shipped with a handler, a message type, and no caller anywhere.
// Nothing failed — the retry path simply did not exist, so an item that gave
// up stayed given up. A handler with no sender is dead weight at best and a
// missing feature at worst.
head("Message wiring");
{
  const worker = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  const senders = ["popup.js", "background.js"]
    .map((f) => fs.readFileSync(path.join(EXT, f), "utf8")).join("\n");
  const handled = new Set(
    [...worker.matchAll(/msg\.type\s*===\s*"([^"]+)"/g)].map((m) => m[1]));
  for (const type of handled) {
    new RegExp('type:\\s*"' + type + '"').test(senders)
      ? good(type + " — handled and sent")
      : bad(type + " — the worker answers it, but nothing ever sends it");
  }
}

// --- 2d. the tab loader does not trust the event stream alone ---------------
// A tab starts loading before the worker can attach its onUpdated listener, so
// a cached page reaches "complete" unobserved. Listening alone made every fast
// page wait out the timeout and count as a failure; three of those retire the
// item for good. The loader has to ask the tab where it got to as well.
head("Tab load wiring");
{
  const worker = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  const fn = /function waitForComplete[\s\S]*?\n}/.exec(worker);
  if (!fn) {
    bad("waitForComplete not found");
  } else {
    /chrome\.tabs\.get\s*\(/.test(fn[0])
      ? good("waitForComplete reads the tab's current status")
      : bad("waitForComplete only listens for onUpdated — a page that loaded " +
            "before the listener attached will time out");
  }
  /if \(!loaded\) return \{ ok: false/.test(worker)
    ? bad("readViaTab abandons the page on timeout instead of trying to read it")
    : good("a load timeout still attempts extraction");
}

// --- 3. nothing ships that should not ---------------------------------------
head("Bundle");
// Anything in price-tracker/ ends up in the store package. Markdown is the
// easy mistake — a CLAUDE.md or README dropped in there ships to every user.
const SHOULD_NOT_SHIP = /^(_|.*\.md$|.*\.test\.|fixtures?$|test$|docs$|node_modules$)/i;
const strays = fs.readdirSync(EXT).filter((f) => SHOULD_NOT_SHIP.test(f));
strays.length
  ? bad("would ship: " + strays.join(", "))
  : good("no scratch or design files in the extension folder");

// --- 4. the behaviour suites -------------------------------------------------
for (const suite of ["store.test.js", "pipeline.test.js", "ldparse.test.js"]) {
  const file = path.join(__dirname, suite);
  if (!fs.existsSync(file)) continue;
  head(suite.replace(".test.js", ""));
  try {
    const out = execFileSync(process.execPath, [file], { stdio: "pipe" }).toString();
    process.stdout.write(out.split("\n").map((l) => (l ? "  " + l : l)).join("\n"));
    if (/[1-9]\d* failed/.test(out)) failed++;
  } catch (e) {
    process.stdout.write(String(e.stdout || "") + String(e.stderr || ""));
    bad(suite + " exited non-zero");
  }
}

// --- 5. the browser suite ----------------------------------------------------
if (process.argv.includes("--serve")) {
  head("Serving the extractor suite");
  console.log("  open http://localhost:8731/test/extract.html");
  spawn(process.execPath, [path.join(__dirname, "serve.js")], { stdio: "inherit" });
} else {
  head("Not run here");
  console.log("  test/extract.html needs real DOM APIs — run:");
  console.log("    node test/run.js --serve   then open http://localhost:8731/test/extract.html");
}

head(failed ? "\x1b[31m" + failed + " check(s) failed\x1b[0m" : "\x1b[32mAll checks passed\x1b[0m");
process.exit(failed ? 1 : 0);
