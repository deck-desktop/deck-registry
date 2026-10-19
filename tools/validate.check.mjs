// The validator's rules that need no network: the submission's shape, the release's files, the
// lockfile, version order.
//
//   node tools/validate.check.mjs
import assert from "node:assert/strict";
import { checkAssets, checkLockfile, checkPermissions, checkSubmission, compareVersions, MAX_FILE, RESERVED } from "./validate.mjs";

// ---- the submission ------------------------------------------------------------------------
const good = { kind: "plugin", repo: "someone/deck-plugin-thing", tag: "v1.2.0" };
assert.deepEqual(checkSubmission("thing", good), []);
assert.match(checkSubmission("Thing", good)[0], /lowercase/, "an id is lowercase");
assert.match(checkSubmission("-x", good)[0], /lowercase/, "and starts with a letter or digit");
assert.match(checkSubmission("a".repeat(41), good)[0], /40/);
for (const id of RESERVED) assert.ok(checkSubmission(id, good).some((e) => /Deck's own/.test(e)), `${id} is reserved`);
assert.ok(checkSubmission("thing", { ...good, extra: 1 }).some((e) => /unexpected field/.test(e)), "nothing but the three fields");
assert.ok(checkSubmission("thing", { ...good, kind: "theme" }).some((e) => /kind/.test(e)));
assert.ok(checkSubmission("thing", { ...good, repo: "https://github.com/a/b" }).some((e) => /owner\/name/.test(e)));
assert.ok(checkSubmission("thing", { ...good, tag: "1.2.0" }).some((e) => /tag/.test(e)), "the tag has its v");
assert.ok(checkSubmission("thing", { ...good, tag: "v1.2" }).some((e) => /tag/.test(e)), "and a whole version");
assert.deepEqual(checkSubmission("thing", { ...good, tag: "v1.2.0-beta.1" }), [], "a pre-release version is a version");
assert.ok(checkSubmission("thing", [good]).some((e) => /object/.test(e)));

// ---- the release's files ---------------------------------------------------------------------
const asset = (name, size = 100) => ({ name, size, digest: `sha256:${"a".repeat(64)}` });
assert.deepEqual(checkAssets("plugin", [asset("plugin.json"), asset("plugin.js"), asset("mcp.js")]), []);
assert.ok(checkAssets("plugin", [asset("plugin.json")]).some((e) => /no `plugin.js`/.test(e)));
assert.ok(checkAssets("plugin", [asset("plugin.json"), asset("plugin.js"), asset("evil.exe")]).some((e) => /evil.exe/.test(e)), "nothing a plugin cannot contain");
assert.ok(checkAssets("plugin", [asset("plugin.json"), asset("plugin.js", MAX_FILE + 1)]).some((e) => /10 MB/.test(e)));
assert.ok(checkAssets("plugin", [asset("plugin.json", 8 << 20), asset("plugin.js", 8 << 20)]).some((e) => /15 MB/.test(e)), "the total too");
assert.ok(checkAssets("plugin", [asset("plugin.json"), { name: "plugin.js", size: 1 }]).some((e) => /sha256/.test(e)), "GitHub's digest is required");
assert.deepEqual(checkAssets("language", [asset("language.json"), asset("snippets--go.json")]), []);
assert.ok(checkAssets("language", [asset("language.json"), asset("plugin.js")]).some((e) => /plugin.js/.test(e)));

// ---- the lockfile ----------------------------------------------------------------------------
const pkg = (name, extra = {}) => [`node_modules/${name}`, { version: "1.0.0", resolved: `https://registry.npmjs.org/${name}/-/x.tgz`, integrity: "sha512-abc", ...extra }];
const lock = (...entries) => ({ lockfileVersion: 3, packages: { "": { name: "p" }, ...Object.fromEntries([pkg("deck-plugin-sdk"), ...entries]) } });
assert.deepEqual(checkLockfile(lock(pkg("esbuild"), pkg("@esbuild/linux-x64"), pkg("react"))), []);
assert.ok(checkLockfile(lock(pkg("left-pad", { resolved: "https://evil.example/left-pad.tgz" }))).some((e) => /registry.npmjs.org/.test(e)), "only npm's registry");
assert.ok(checkLockfile(lock(pkg("left-pad", { resolved: "git+ssh://git@github.com/a/b.git" }))).some((e) => /registry.npmjs.org/.test(e)), "not a git dependency");
assert.ok(checkLockfile(lock(pkg("left-pad", { integrity: undefined }))).some((e) => /integrity/.test(e)), "with its hash");
assert.ok(checkLockfile(lock(["node_modules/mine", { link: true, resolved: "../mine" }])).some((e) => /link/.test(e)), "no folder links");
assert.ok(checkLockfile(lock(pkg("react", { name: "evil-react" }))).some((e) => /alias/.test(e)), "a package the build runs is the real one");
assert.ok(checkLockfile(lock(pkg("@esbuild/linux-x64", { name: "evil" }))).some((e) => /alias/.test(e)), "esbuild's binary too");
assert.deepEqual(checkLockfile(lock(pkg("string-width-cjs", { name: "string-width" }))), [], "an alias of something the build never runs is fine");
assert.ok(checkLockfile({ lockfileVersion: 1, dependencies: {} }).length, "npm 6's lockfile is refused");
assert.ok(checkLockfile({ lockfileVersion: 3, packages: { "": {} } }).some((e) => /deck-plugin-sdk/.test(e)));

// ---- permissions ------------------------------------------------------------------------------
const table = {
  permissions: { files: "Read and change files", network: "Connect to servers", terminals: "Use your terminals" },
  bridge: { fsWrite: "files", fsRead: "files", httpSend: "network" },
  modules: { terminals: "terminals", p2p: "network" },
};
const bundle = (s) => `var b=()=>window.__deck?.forPlugin?.(i)?.bridge??window.__deck?.bridge;${s}`;
assert.deepEqual(checkPermissions(["files"], bundle("b().fsWrite(a,c)"), table).errors, []);
assert.ok(checkPermissions(undefined, bundle(""), table).errors[0].includes('"permissions"'), "it has to say");
assert.deepEqual(checkPermissions([], bundle("b().configRead(a)"), table).errors, [], "nothing beyond its own data needs nothing");
assert.ok(checkPermissions([], bundle("b().fsWrite(a,c)"), table).errors.some((e) => /fsWrite.*"files"/.test(e)), "a call it did not declare");
assert.ok(checkPermissions(["files"], bundle("b().httpSend(r)"), table).errors.some((e) => /"network"/.test(e)));
assert.ok(checkPermissions(["files", "rockets"], bundle(""), table).errors.some((e) => /unknown permission: rockets/.test(e)));
assert.ok(checkPermissions(["files"], bundle("window.__TAURI_INTERNALS__.invoke('exec')"), table).errors.some((e) => /around the bridge/.test(e)), "no reaching around it");
assert.ok(checkPermissions([], "x=window.__deck?.forPlugin?.(i)?.terminals??window.__deck?.terminals", table).errors.some((e) => /"terminals"/.test(e)), "a whole module counts");
assert.deepEqual(checkPermissions(["files"], bundle("b().fsReadBytes(a)"), table).errors, [], "a longer name is not a match for a shorter one");
assert.equal(checkPermissions([], bundle("eval(s)"), table).notes.length, 1, "eval is noted, not refused");

// ---- versions ----------------------------------------------------------------------------------
assert.ok(compareVersions("1.10.0", "1.2.0") > 0);
assert.ok(compareVersions("1.0.0", "1.0.0-beta") > 0, "a release is after its pre-release");
assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
console.log("validate: all checks passed");
