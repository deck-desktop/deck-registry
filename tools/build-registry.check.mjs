// What build-registry.mjs makes of packages/: run against a scratch packages/ and read back.
//
//   node tools/build-registry.check.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const tools = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "build-registry-check-"));
try {
  // The builder reads packages/ beside tools/, so the check gets a registry of its own.
  cpSync(tools, join(dir, "tools"), { recursive: true, filter: (src) => !src.includes("node_modules") });
  const pkg = (kind, id, versions, extra = {}) => {
    mkdirSync(join(dir, "packages", kind), { recursive: true });
    writeFileSync(join(dir, "packages", kind, `${id}.json`), JSON.stringify({
      kind, id, repo: `someone/deck-${kind}-${id}`, owner: { id: 1, login: "someone", type: "User" },
      publisher: { name: "Someone", verified: false }, versions, ...extra,
    }));
  };
  const v = (version, extra = {}) => ({
    version, tag: `v${version}`, publishedAt: "2026-10-19T00:00:00Z", readme: true,
    manifest: { name: "Thing", description: "Does a thing.", icon: "Box", minDeck: "1.6.0" },
    files: { "plugin.json": { sha256: "a".repeat(64), bytes: 10 }, "plugin.js": { sha256: "b".repeat(64), bytes: 20 } },
    ...extra,
  });
  pkg("plugin", "thing", [v("1.0.0"), v("1.10.0"), v("1.2.0"), v("2.0.0", { retracted: true })]);
  pkg("plugin", "gone", [v("1.0.0")], { removed: true });
  // Its latest needs a Deck that reads the catalogue; the one before is what older Decks get.
  const needs = (version, minDeck) => ({ ...v(version), manifest: { ...v(version).manifest, minDeck } });
  pkg("plugin", "split", [needs("2.1.0", "1.6.0"), needs("2.1.1", "1.7.0")]);
  pkg("plugin", "newonly", [needs("0.1.0", "1.7.0")]);
  pkg("language", "zig", [{ ...v("0.1.0", { readme: false }), manifest: { name: "zig", description: ".zig", icon: "FileCode", requires: "zls", extensions: ["zig"] },
    files: { "language.json": { sha256: "c".repeat(64), bytes: 5 }, "snippets/zig.json": { sha256: "d".repeat(64), bytes: 6 } } }]);

  execFileSync(process.execPath, [join(dir, "tools", "build-registry.mjs")], { stdio: "pipe" });
  const read = (p) => JSON.parse(readFileSync(join(dir, p), "utf8"));
  const catalog = read("catalog.json"), index = read("index.json");

  assert.equal(catalog.schema, 3);
  assert.equal(index.schema, 2);
  assert.deepEqual(catalog.plugins.map((e) => `${e.kind}:${e.id}`), ["plugin:newonly", "plugin:split", "plugin:thing", "language:zig"], "removed packages are not listed");
  assert.equal(catalog.plugins.find((e) => e.id === "split").version, "2.1.1", "the catalogue offers the latest");
  assert.equal(index.plugins.find((e) => e.id === "split").version, "2.1.0", "index.json offers the newest an older Deck can run");
  assert.equal(index.plugins.find((e) => e.id === "newonly"), undefined, "and nothing when none can");

  const thing = catalog.plugins.find((e) => e.id === "thing");
  assert.equal(thing.version, "1.10.0", "the newest by semver (1.10 after 1.2), a retracted 2.0.0 skipped");
  assert.equal(thing.detail, "details/plugin/thing/1.10.0.json");
  assert.equal(thing.repo, "someone/deck-plugin-thing");
  assert.equal(thing.files, undefined, "no files in the catalogue");
  assert.equal(thing.published, "2026-10-19T00:00:00Z", "when the listed version was published");
  assert.equal(thing.buildVerified, undefined, "only an unverified build says so");

  for (const ver of ["1.0.0", "1.10.0", "1.2.0", "2.0.0"]) read(`details/plugin/thing/${ver}.json`);
  read("details/plugin/gone/1.0.0.json");   // an install made from an older catalogue still has its files
  const d = read("details/plugin/thing/1.10.0.json");
  assert.equal(d.files["plugin.js"].url, "https://github.com/someone/deck-plugin-thing/releases/download/v1.10.0/plugin.js");
  assert.equal(d.readme, "https://raw.githubusercontent.com/someone/deck-plugin-thing/v1.10.0/README.md");

  const zig = read("details/language/zig/0.1.0.json");
  assert.equal(zig.files["snippets/zig.json"].url, "https://github.com/someone/deck-language-zig/releases/download/v0.1.0/snippets--zig.json",
    "a snippet's asset is flat, its key still the path it installs at");
  assert.equal(zig.readme, null);
  const zigIndex = index.plugins.find((e) => e.id === "zig");
  assert.deepEqual([zigIndex.requires, zigIndex.extensions], ["zls", ["zig"]]);
  assert.deepEqual(index.plugins.find((e) => e.id === "thing").files, d.files, "index.json carries the latest's files inline");

  // The same packages build the same details, byte for byte: a detail never changes once published.
  const before = readFileSync(join(dir, "details/plugin/thing/1.10.0.json"), "utf8");
  execFileSync(process.execPath, [join(dir, "tools", "build-registry.mjs")], { stdio: "pipe" });
  assert.equal(readFileSync(join(dir, "details/plugin/thing/1.10.0.json"), "utf8"), before);
  console.log("build-registry: all checks passed");
} finally { rmSync(dir, { recursive: true, force: true }); }
