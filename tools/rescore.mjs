// Score plugin versions published before points existed.
//
//   node tools/rescore.mjs                  # dry run: print each score, write nothing
//   node tools/rescore.mjs --go             # write the points into packages/
//   node tools/rescore.mjs --go git notes   # just these plugins
//   node tools/rescore.mjs --all            # every listed version, not only each plugin's newest
//
// A submission is scored when it is published (validate.mjs). This gives the versions already in
// packages/ the same score, worked out the same way: the source cloned at the version's tag as
// data, the files' facts read there, the plugin rebuilt from its lockfile and checked against the
// released files' hashes (rebuildPlugin, shared with validate.mjs), the permissions checked
// against the released plugin.js, and the newest SDK on npm.
//
// A version that already has points is left alone, so a second run changes nothing; a published
// version never changes, and neither do its points. Languages get none. Run it locally, with git
// and npm on PATH, then commit packages/: build.yml rebuilds the catalogue from it.
//
// SECURITY: the same as validate.mjs. The clone is data, and the rebuild runs only the packages
// BUILD_RUNS names, installed with --ignore-scripts from a lockfile that points at npm alone.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPermissions, compareVersions, loadPermissions, newestSdk, rebuildPlugin } from "./validate.mjs";
import { fileFacts, points } from "./node_modules/deck-plugin-sdk/validate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const go = args.includes("--go"), every = args.includes("--all");
const only = args.filter((a) => !a.startsWith("--"));

const table = loadPermissions();
if (!table) { console.error("deck-plugin-sdk's permissions.json is missing: run npm ci in tools/"); process.exit(1); }
const newest = await newestSdk();
console.log(`newest deck-plugin-sdk on npm: ${newest ?? "unknown (offline); up-to-date scores 0"}`);

const dir = join(root, "packages", "plugin");
let scored = 0, kept = 0, failed = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const at = join(dir, file);
  const pkg = JSON.parse(readFileSync(at, "utf8"));
  if (pkg.removed || (only.length && !only.includes(pkg.id))) continue;
  const live = pkg.versions.filter((v) => !v.retracted).sort((a, b) => compareVersions(b.version, a.version));
  let changed = false;
  for (const v of every ? live : live.slice(0, 1)) {
    if (v.points) { kept++; continue; }
    const clone = mkdtempSync(join(tmpdir(), `rescore-${pkg.id}-`));
    try {
      execFileSync("git", ["-c", "core.autocrlf=false", "clone", "-q", "--depth", "1", "--branch", v.tag, `https://github.com/${pkg.repo}.git`, clone], { stdio: "pipe" });
      const read = (f) => (existsSync(join(clone, f)) ? readFileSync(join(clone, f), "utf8") : null);
      const build = rebuildPlugin(clone, new Set(Object.keys(v.files)), (name) => v.files[name]?.sha256);
      // What it uses, from the plugin.js people install: the released one, by the hash it was published with.
      const res = await fetch(`https://github.com/${pkg.repo}/releases/download/${v.tag}/plugin.js`);
      if (!res.ok) throw new Error(`its released plugin.js answered ${res.status}`);
      const manifest = JSON.parse(read("plugin.json") ?? "{}");
      const perms = checkPermissions(manifest.permissions, await res.text(), table);
      const score = points({
        ...fileFacts(read), buildVerified: build.buildVerified, typechecks: build.typechecks,
        permissions: Array.isArray(manifest.permissions) ? [...new Set(manifest.permissions)] : null, used: perms.used, newestSdk: newest,
      });
      v.points = score;
      changed = true;
      scored++;
      const missed = score.checks.filter((c) => !c.got).map((c) => c.id).join(", ");
      console.log(`${pkg.id} ${v.version}: ${score.total}${missed ? `  (missed: ${missed})` : ""}`);
    } catch (e) {
      failed++;
      console.log(`${pkg.id} ${v.version}: NOT SCORED — ${(e.stderr ?? e.message).toString().trim().split("\n").pop()}`);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  }
  if (go && changed) writeFileSync(at, JSON.stringify(pkg, null, 2) + "\n");
}
console.log(`\n${scored} scored, ${kept} already had points, ${failed} could not be scored.${go ? "" : " Dry run: nothing written; --go writes packages/."}`);
