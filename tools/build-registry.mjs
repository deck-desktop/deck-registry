// Build the registry's published files from packages/, the record of what has been published.
//
//   node tools/build-registry.mjs            # write catalog.json, details/ and index.json here
//   node tools/build-registry.mjs --out dir  # somewhere else (a check compares the two)
//
// packages/<kind>/<id>.json is the source: who owns a package, and every version ever published,
// with its files' hashes and what its manifest said. It only grows: a version is appended once its
// release has been checked, and never changed. Everything else here is generated from it, by CI on
// every push to main (.github/workflows/build.yml), and never edited by hand.
//
// Nothing is downloaded: every hash was taken when the version was published, from the release it
// names. That is what makes a build repeatable and the details safe to cache for good.
//
//   catalog.json                          the list Deck and the website read whole (schema 3)
//   details/<kind>/<id>/<version>.json    one per version: its files, their hashes, its README
//   index.json                            schema 2, files inline, for Deck 1.6 and older
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outIndex = process.argv.indexOf("--out");
const out = outIndex === -1 ? root : resolve(process.argv[outIndex + 1]);

/** The first Deck that reads catalog.json; every Deck before it reads index.json. */
const FIRST_CATALOG_DECK = "1.7.0";
/** A file's name as a release asset: flat, so a language's snippets/x.json is snippets--x.json. */
const assetName = (name) => name.replace(/\//g, "--");
/** Semver order, enough for x.y.z with an optional -pre (a pre-release sorts before its release). */
function compareVersions(a, b) {
  const parse = (v) => { const [core, pre] = v.split("-", 2); return { n: core.split(".").map(Number), pre }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) - (y.n[i] ?? 0);
  if (x.pre === y.pre) return 0;
  return x.pre === undefined ? 1 : y.pre === undefined ? -1 : x.pre < y.pre ? -1 : 1;
}

const packages = [];
for (const kind of ["plugin", "language"]) {
  const dir = join(root, "packages", kind);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    packages.push(JSON.parse(readFileSync(join(dir, f), "utf8")));
  }
}

/** Where a published file is downloaded from, and its README read from. */
const fileUrl = (p, v, name) => `https://github.com/${p.repo}/releases/download/${v.tag}/${assetName(name)}`;
const readmeUrl = (p, v) => (v.readme ? `https://raw.githubusercontent.com/${p.repo}/${v.tag}/README.md` : null);
const detailPath = (p, v) => `details/${p.kind}/${p.id}/${v.version}.json`;

const index = [], catalog = [], details = [];
for (const p of packages) {
  // The newest version not withdrawn is the one offered. A package with none is not listed, but
  // its details stay, so an install made from an older catalogue still has its files.
  const live = p.versions.filter((v) => !v.retracted).sort((a, b) => compareVersions(b.version, a.version));
  const mine = new Map();
  for (const v of p.versions) {
    const d = {
      schema: 3, kind: p.kind, id: p.id, version: v.version, readme: readmeUrl(p, v), signature: null,
      files: Object.fromEntries(Object.entries(v.files).map(([name, f]) => [name, { url: fileUrl(p, v, name), sha256: f.sha256, bytes: f.bytes }])),
    };
    mine.set(v.version, d);
    details.push([detailPath(p, v), d]);
  }
  if (p.removed) continue;
  /** One version as an index.json entry: everything about it, its files inline. */
  const whole = (v) => {
    const m = v.manifest;
    return {
      kind: p.kind, id: p.id, version: v.version, publisher: p.publisher, signature: null,
      readme: readmeUrl(p, v), name: m.name, description: m.description, icon: m.icon,
      ...(m.color ? { color: m.color } : {}),
      minDeck: m.minDeck ?? null,
      ...(p.kind === "language" ? { requires: m.requires ?? null, extensions: m.extensions ?? [] } : {}),
      files: mine.get(v.version).files,
      ...(v.iconNode ? { iconNode: v.iconNode } : {}),
    };
  };
  if (live[0]) {
    const { files, readme, signature, ...listed } = whole(live[0]);
    catalog.push({ ...listed, repo: p.repo, detail: detailPath(p, live[0]), ...(p.discontinued ? { discontinued: true } : {}) });
  }
  // index.json is read only by Decks from before catalogues, so it offers the newest version one
  // of those can run: a plugin whose latest needs a newer Deck stays installable there at the
  // version before.
  const old = live.find((v) => !v.manifest.minDeck || compareVersions(v.manifest.minDeck, FIRST_CATALOG_DECK) < 0);
  if (old) index.push(whole(old));
}

const generated = new Date().toISOString();
const write = (rel, data) => {
  const at = join(out, rel);
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(at, JSON.stringify(data, null, 2) + "\n");
};
// Rewritten whole: a detail is the same bytes every run for the same version, so git sees no change.
rmSync(join(out, "details"), { recursive: true, force: true });
for (const [rel, d] of details) write(rel, d);
write("catalog.json", { generated, schema: 3, plugins: catalog });
write("index.json", { generated, schema: 2, plugins: index });
console.log(`${catalog.length} listed, ${details.length} versions -> ${out}`);
