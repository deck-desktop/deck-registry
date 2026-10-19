// Validate a submission: the one gate between a plugin's release and the registry.
//
//   node tools/validate.mjs --pr <number> [--out <dir>]
//       reads the PR's files and its submission through the API; writes result.json and
//       report.md to --out. This is what .github/workflows/submit.yml runs.
//
// What a submission is: one new file, submissions/<id>.json, holding { kind, repo, tag }. The
// package is the GitHub release `tag` of `repo`; validation checks it is well formed, that the
// person submitting owns it, that its version is new, and, where that can be proven, that its
// files are what its source builds to. Nothing here is a review of what a plugin does: points
// (later) are advice, and these checks only decide whether it is a valid package.
//
// SECURITY. This runs with a token that can merge and push (pull_request_target), so it never
// runs the submitter's code:
// - the PR is never checked out: its file list and the submission are read through the API;
// - their repository is cloned as data;
// - the rebuild runs only when nothing of theirs would execute: no deck-plugin.config.mjs (the
//   SDK's build imports it), no .npmrc, and a lockfile whose every package comes from
//   registry.npmjs.org with an integrity hash. Then `npm ci --ignore-scripts` installs published
//   packages without running any, and the build executes only these, from npm: deck-plugin-sdk
//   (the build itself), esbuild and its binary, and what the build require()s to check imports
//   (react, lucide-react, framer-motion). Those names are in BUILD_RUNS below; a build-plugin.mjs
//   change that executes anything else must add it there.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = process.env.GITHUB_REPOSITORY || "deck-desktop/deck-registry";

/** Deck's own modules and the view prefixes: a plugin with one of these ids could never load. */
export const RESERVED = new Set(["terminals", "editor", "docs", "settings", "deck", "module", "plugin", "browser"]);
/** Packages the rebuild executes. Each must be the real one from npm (see SECURITY above). */
export const BUILD_RUNS = ["deck-plugin-sdk", "esbuild", "react", "lucide-react", "framer-motion"];
export const MAX_FILE = 10 * 1024 * 1024, MAX_TOTAL = 15 * 1024 * 1024;
/** New packages one owner may add in a day: auto-merge without review needs a brake on spam. */
export const NEW_PER_DAY = 5;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export const assetName = (name) => name.replace(/\//g, "--");
export function compareVersions(a, b) {
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  if (x[4] === y[4]) return 0;
  return x[4] === undefined ? 1 : y[4] === undefined ? -1 : x[4] < y[4] ? -1 : 1;
}

/** The submission file's shape, exactly: anything else is refused rather than ignored. */
export function checkSubmission(id, s) {
  const errors = [];
  if (!ID.test(id)) errors.push(`the file name \`${id}\` must be the package id: lowercase letters, digits and dashes, 40 at most`);
  if (RESERVED.has(id)) errors.push(`\`${id}\` is one of Deck's own names and cannot be a package id`);
  if (typeof s !== "object" || s === null || Array.isArray(s)) return [...errors, "the submission must be a JSON object"];
  const extra = Object.keys(s).filter((k) => !["kind", "repo", "tag"].includes(k));
  if (extra.length) errors.push(`unexpected field${extra.length > 1 ? "s" : ""}: ${extra.join(", ")}`);
  if (s.kind !== "plugin" && s.kind !== "language") errors.push("`kind` must be \"plugin\" or \"language\"");
  if (typeof s.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(s.repo)) errors.push("`repo` must be \"owner/name\"");
  if (typeof s.tag !== "string" || !/^v/.test(s.tag) || !SEMVER.test(s.tag.slice(1))) errors.push("`tag` must be v<version>, such as v1.0.0");
  return errors;
}

/** The release's files: the allowed names, the required ones, and the size limits. */
export function checkAssets(kind, assets) {
  const errors = [];
  const ok = (n) => kind === "plugin" ? ["plugin.json", "plugin.js", "mcp.js"].includes(n) : n === "language.json" || /^snippets--[\w.-]+\.json$/.test(n);
  for (const a of assets) if (!ok(a.name)) errors.push(`the release has \`${a.name}\`, which a ${kind} cannot contain`);
  for (const need of kind === "plugin" ? ["plugin.json", "plugin.js"] : ["language.json"]) {
    if (!assets.some((a) => a.name === need)) errors.push(`the release has no \`${need}\``);
  }
  for (const a of assets) if (a.size > MAX_FILE) errors.push(`\`${a.name}\` is ${(a.size / 1048576).toFixed(1)} MB; a file may be 10 MB at most`);
  const total = assets.reduce((n, a) => n + a.size, 0);
  if (total > MAX_TOTAL) errors.push(`the release is ${(total / 1048576).toFixed(1)} MB; a package may be 15 MB at most`);
  for (const a of assets) if (!/^sha256:[0-9a-f]{64}$/.test(a.digest ?? "")) errors.push(`GitHub gives no sha256 for \`${a.name}\`; upload it again`);
  return errors;
}

/** Whether a lockfile lets `npm ci` install only published npm packages (see SECURITY). */
export function checkLockfile(lock) {
  const errors = [];
  if (!lock || lock.lockfileVersion < 2 || typeof lock.packages !== "object") return ["package-lock.json must be npm 7 or newer (lockfileVersion 2 or 3)"];
  for (const [path, p] of Object.entries(lock.packages)) {
    if (path === "") continue;
    if (p.link) { errors.push(`\`${path}\` is a link to a folder; publish it to npm or bundle it`); continue; }
    if (!p.resolved?.startsWith("https://registry.npmjs.org/") || !/^sha(512|384|256)-/.test(p.integrity ?? "")) {
      errors.push(`\`${path}\` does not come from registry.npmjs.org with an integrity hash`);
    }
    const name = path.replace(/^.*node_modules\//, "");
    const runs = BUILD_RUNS.includes(name) || name.startsWith("@esbuild/");
    if (runs && p.name && p.name !== name) errors.push(`\`${name}\` is an alias of \`${p.name}\`; the build runs it, so it must be the real package`);
  }
  if (!lock.packages["node_modules/deck-plugin-sdk"]) errors.push("the lockfile has no deck-plugin-sdk; a plugin is built with it");
  return errors;
}

/**
 * Deck's permission table, from the deck-plugin-sdk this registry installs (permissions.json, SDK
 * 1.8 and later), or DECK_PERMISSIONS naming a copy. Null with an older SDK: the permission
 * checks are skipped and the report says so.
 */
export function loadPermissions() {
  const at = process.env.DECK_PERMISSIONS ?? join(root, "tools", "node_modules", "deck-plugin-sdk", "permissions.json");
  return existsSync(at) ? JSON.parse(readFileSync(at, "utf8")) : null;
}

/**
 * What a plugin's permissions must be, from its manifest and its bundle: the declared list must
 * hold only known names, and cover every bridge call the bundle makes. Calls survive minifying:
 * the shim reaches the bridge as `b().fsWrite(`, a property of a call. Reaching Deck's internals
 * directly (around the bridge) is refused outright.
 */
export function checkPermissions(declared, bundle, table) {
  const errors = [], notes = [];
  if (!Array.isArray(declared)) {
    return { errors: ['plugin.json must say what it uses: "permissions": [...], or [] when it needs nothing beyond its own data and settings'], notes };
  }
  const unknown = declared.filter((p) => !(p in table.permissions));
  if (unknown.length) errors.push(`unknown permission${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (known: ${Object.keys(table.permissions).join(", ")})`);
  if (/__TAURI_INTERNALS__|__TAURI_IPC__|window\.__TAURI__\b/.test(bundle)) {
    errors.push("its bundle reaches Deck's internals directly, around the bridge its permissions apply to");
  }
  const needs = new Map();
  for (const [fn, p] of Object.entries(table.bridge)) {
    // `().fn(`: the shim calls the bridge as b().fn(...), so a method of the same name on
    // something else (a RegExp's .exec, a stream's .write) does not count.
    if (new RegExp(`\\(\\)\\.${fn}\\(`).test(bundle)) needs.set(p, [...(needs.get(p) ?? []), fn]);
  }
  for (const [mod, p] of Object.entries(table.modules)) {
    if (new RegExp(`__deck\\?\\.${mod}\\b`).test(bundle)) needs.set(p, [...(needs.get(p) ?? []), mod]);
  }
  for (const [p, fns] of needs) {
    if (!declared.includes(p)) errors.push(`it uses ${fns.slice(0, 4).join(", ")}${fns.length > 4 ? ` and ${fns.length - 4} more` : ""}, which ${fns.length > 1 ? "need" : "needs"} the "${p}" permission; add it to "permissions"`);
  }
  if (/\beval\(|new Function\(/.test(bundle)) notes.push("Its bundle uses eval or new Function, which runs code made at run time; a library may do this legitimately.");
  return { errors, notes };
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const gh = (path) => JSON.parse(execFileSync("gh", ["api", path], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }).toString());
const ghOk = (path) => { try { execFileSync("gh", ["api", path], { stdio: "ignore" }); return true; } catch { return false; } };
const kebab = (name) => name.replace(/([a-z])([A-Z0-9])/g, "$1-$2").replace(/([0-9])([A-Z])/g, "$1-$2").toLowerCase();

async function iconNodeOf(icon) {
  const file = join(root, "tools", "node_modules", "lucide-react", "dist", "esm", "icons", `${kebab(icon)}.mjs`);
  if (typeof icon !== "string" || !/^[A-Z][A-Za-z0-9]*$/.test(icon) || !existsSync(file)) return null;
  const { __iconNode } = await import(pathToFileURL(file).href);
  return __iconNode.map(([tag, { key: _key, ...attrs }]) => [tag, attrs]);
}

/**
 * Validate one submission, as `author` ({ id, login }). Returns { errors, notes, pkg }: `pkg` is
 * the package record with the new version appended, ready to write to packages/, when there are
 * no errors.
 */
export async function validate(id, submission, author) {
  const errors = checkSubmission(id, submission), notes = [];
  if (errors.length) return { errors, notes };
  const { kind, repo, tag } = submission;
  const version = tag.slice(1);
  const at = join(root, "packages", kind, `${id}.json`);
  const existing = existsSync(at) ? JSON.parse(readFileSync(at, "utf8")) : null;
  if (!existing && existsSync(join(root, "packages", kind === "plugin" ? "language" : "plugin", `${id}.json`))) {
    errors.push(`\`${id}\` is taken by a ${kind === "plugin" ? "language" : "plugin"}`);
  }

  // Who owns it. By numeric id: a renamed account keeps its packages, a recycled name gets none.
  let info;
  try { info = gh(`repos/${repo}`); } catch { return { errors: [...errors, `\`${repo}\` is not a public repository GitHub can find`], notes }; }
  if (info.private) errors.push(`\`${repo}\` is private; a package's source has to be public`);
  const owner = { id: info.owner.id, login: info.owner.login, type: info.owner.type };
  if (existing && (existing.repo.toLowerCase() !== repo.toLowerCase() || existing.owner.id !== owner.id)) {
    errors.push(`\`${id}\` belongs to ${existing.repo}; publish new versions from there`);
  }
  if (owner.type === "User" && owner.id !== author.id) errors.push(`${repo} belongs to ${owner.login}; only they can submit it`);
  if (owner.type === "Organization" && !ghOk(`orgs/${owner.login}/public_members/${author.login}`)) {
    errors.push(`${author.login} is not a public member of ${owner.login}; make the membership public, or submit from ${owner.login}'s own account`);
  }
  if (existing?.removed) errors.push(`\`${id}\` was removed from the registry`);
  if (!existing) {
    const day = Date.now() - 24 * 3600e3;
    const mine = readdirSync(join(root, "packages")).flatMap((k) => existsSync(join(root, "packages", k))
      ? readdirSync(join(root, "packages", k)).map((f) => JSON.parse(readFileSync(join(root, "packages", k, f), "utf8"))) : [])
      .filter((p) => p.owner.id === owner.id && Date.parse(p.versions[0]?.publishedAt ?? 0) > day);
    if (mine.length >= NEW_PER_DAY) errors.push(`${owner.login} added ${mine.length} packages in the last day; try again tomorrow`);
  }
  if (existing?.versions.some((v) => compareVersions(v.version, version) >= 0)) {
    errors.push(`${version} is not newer than ${existing.versions.map((v) => v.version).sort(compareVersions).at(-1)}, the latest published`);
  }

  // The release.
  let rel;
  try { rel = gh(`repos/${repo}/releases/tags/${tag}`); } catch { return { errors: [...errors, `${repo} has no release \`${tag}\``], notes }; }
  if (rel.draft || rel.prerelease) errors.push(`release ${tag} is a ${rel.draft ? "draft" : "pre-release"}; publish it as a full release`);
  errors.push(...checkAssets(kind, rel.assets));
  if (errors.length) return { errors, notes };
  const assets = new Map(rel.assets.map((a) => [a.name, a]));
  const digest = (name) => assets.get(assetName(name))?.digest.slice(7);

  // The source at the tag, as data.
  const dir = mkdtempSync(join(tmpdir(), `submit-${id}-`));
  try {
    execFileSync("git", ["-c", "core.autocrlf=false", "clone", "-q", "--depth", "1", "--branch", tag, `https://github.com/${repo}.git`, dir], { stdio: "pipe" });
    const has = (f) => existsSync(join(dir, f));
    if (!has("README.md")) errors.push("there is no README.md at the tag; it is the package's page");
    if (!["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"].some(has)) errors.push("there is no LICENSE at the tag; say how others may use it");

    // The manifest: the released one must be the one in the source.
    const manifestName = kind === "plugin" ? "plugin.json" : "language.json";
    if (!has(manifestName)) return { errors: [...errors, `there is no ${manifestName} at the tag`], notes };
    const manifestBytes = readFileSync(join(dir, manifestName));
    if (sha256(manifestBytes) !== digest(manifestName)) errors.push(`the release's ${manifestName} is not the one at the tag`);
    let m;
    try { m = JSON.parse(manifestBytes.toString("utf8")); } catch (e) { return { errors: [...errors, `${manifestName} is not valid JSON: ${e.message}`], notes }; }
    const mid = kind === "plugin" ? m.id : m.languageId;
    if (mid !== id) errors.push(`${manifestName} says its id is \`${mid}\`, not \`${id}\``);
    if (m.version !== version) errors.push(`${manifestName} says version ${m.version}; the tag says ${version}`);
    const name = kind === "plugin" ? m.name : m.languageId;
    if (typeof name !== "string" || !name.trim() || name.length > 60) errors.push("the name must be 1 to 60 characters");
    const description = kind === "plugin" ? m.description
      : `${(m.extensions ?? []).map((e) => `.${e}`).join(", ")} — ${m.server?.command ?? m.server?.module ?? "no language server"}`;
    if (kind === "plugin" && (typeof m.description !== "string" || m.description.trim().length < 10 || m.description.length > 300)) {
      errors.push("the description must be 10 to 300 characters");
    }
    if (kind === "plugin" && (typeof m.minDeck !== "string" || !SEMVER.test(m.minDeck))) errors.push("`minDeck` must say which Deck it needs, such as \"1.7.0\"");
    if (m.color !== undefined && !/^#[0-9a-f]{6}$/i.test(m.color)) errors.push("`color` must be #rrggbb");
    const icon = m.icon ?? (kind === "plugin" ? "Package" : "FileCode");
    const iconNode = await iconNodeOf(icon);
    if (!iconNode) errors.push(`\`${icon}\` is not a lucide icon name (lucide.dev/icons, in PascalCase)`);

    // The files: a language's are its source; a plugin's are rebuilt from it, when that proves anything.
    let buildVerified = false;
    if (kind === "language") {
      const snippets = existsSync(join(dir, "snippets")) ? readdirSync(join(dir, "snippets")).filter((f) => f.endsWith(".json")).map((f) => `snippets/${f}`) : [];
      const want = new Set(["language.json", ...snippets].map(assetName));
      for (const a of assets.keys()) if (!want.has(a)) errors.push(`the release has \`${a}\`, which is not in the source`);
      for (const f of snippets) if (digest(f) !== sha256(readFileSync(join(dir, f)))) errors.push(`the release's ${f} is not the one at the tag`);
      buildVerified = true;
    } else if (has("deck-plugin.config.mjs")) {
      notes.push("It has a deck-plugin.config.mjs, which the build runs, so its plugin.js could not be rebuilt here to check it matches the source. It is listed as **build not verified**.");
    } else if (has(".npmrc")) {
      errors.push("there is an .npmrc at the tag; the rebuild installs from registry.npmjs.org only, so remove it");
    } else if (!has("package-lock.json")) {
      errors.push("there is no package-lock.json at the tag; commit it, so the build can be repeated exactly");
    } else {
      const lockErrors = checkLockfile(JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")));
      errors.push(...lockErrors);
      if (!lockErrors.length) {
        try {
          execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/"], { cwd: dir, stdio: "pipe", shell: process.platform === "win32" });
          execFileSync(process.execPath, [join(dir, "node_modules", "deck-plugin-sdk", "bin", "deck-plugin.mjs"), "build"], { cwd: dir, stdio: "pipe" });
          for (const f of ["plugin.js", "mcp.js"]) {
            if (!assets.has(f) && !has(f)) continue;
            if (!has(f)) errors.push(`the source builds no ${f}, but the release has one`);
            else if (!assets.has(f)) errors.push(`the source builds ${f}, but the release has none`);
            else if (sha256(readFileSync(join(dir, f))) !== digest(f)) {
              errors.push(`the release's ${f} is not what the source builds to. Build it with \`npm ci && npm run build\` at the tag, then upload that file`);
            }
          }
          buildVerified = !errors.length;
        } catch (e) {
          errors.push(`the build failed: ${(e.stderr ?? e.message).toString().trim().split("\n").slice(-3).join(" ")}`);
        }
      }
    }
    // What it may use: declared, and covering what its bundle calls (when Deck's table is here).
    let permissions;
    if (kind === "plugin") {
      const table = loadPermissions();
      if (!table) notes.push("Its permissions were not checked: this registry's deck-plugin-sdk predates them.");
      else {
        const bundle = has("plugin.js") && buildVerified ? readFileSync(join(dir, "plugin.js"), "utf8")
          : Buffer.from(await (await fetch(assets.get("plugin.js").browser_download_url)).arrayBuffer()).toString("utf8");
        const r = checkPermissions(m.permissions, bundle, table);
        errors.push(...r.errors);
        notes.push(...r.notes);
        if (Array.isArray(m.permissions)) permissions = [...new Set(m.permissions)];
      }
    }
    if (errors.length) return { errors, notes };

    const record = {
      version, tag, publishedAt: rel.published_at, readme: true,
      manifest: {
        name, description, icon,
        ...(m.color ? { color: m.color } : {}),
        minDeck: kind === "plugin" ? m.minDeck : null,
        ...(permissions ? { permissions } : {}),
        ...(kind === "language" ? { requires: m.server?.command ?? m.server?.module ?? null, extensions: m.extensions ?? [] } : {}),
      },
      iconNode,
      files: Object.fromEntries([...assets.values()].map((a) => [a.name.replace(/^snippets--/, "snippets/"), { sha256: a.digest.slice(7), bytes: a.size }])),
      buildVerified,
    };
    // Shown as its publisher: the name on the account's GitHub profile, else the account itself.
    let shown = owner.login;
    try { shown = gh(`users/${owner.login}`).name?.trim() || owner.login; } catch { /* the account is enough */ }
    const pkg = existing ?? { kind, id, repo: info.full_name, owner, publisher: { name: shown, verified: false }, versions: [] };
    return { errors, notes, pkg: { ...pkg, versions: [...pkg.versions, record] } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The PR's one submission, read through the API: its number decides nothing else. */
export function readPr(number) {
  const pr = gh(`repos/${REGISTRY}/pulls/${number}`);
  const files = gh(`repos/${REGISTRY}/pulls/${number}/files?per_page=100`);
  const errors = [];
  const sub = files.length === 1 && files[0].status === "added" && /^submissions\/[^/]+\.json$/.test(files[0].filename) ? files[0] : null;
  if (!sub) errors.push("A submission PR adds exactly one file, `submissions/<id>.json`, and changes nothing else.");
  if (pr.base.ref !== "main") errors.push("Open it against `main`.");
  let submission = null;
  if (sub) {
    const raw = execFileSync("gh", ["api", `repos/${pr.head.repo.full_name}/contents/${sub.filename}?ref=${pr.head.sha}`, "-H", "Accept: application/vnd.github.raw"], { stdio: ["ignore", "pipe", "pipe"] }).toString();
    try { submission = JSON.parse(raw); } catch (e) { errors.push(`${sub.filename} is not valid JSON: ${e.message}`); }
  }
  return { errors, id: sub ? sub.filename.slice("submissions/".length, -".json".length) : null, submission, author: { id: pr.user.id, login: pr.user.login } };
}

export function report(id, submission, result) {
  const head = result.errors.length ? `### ✗ \`${id}\` cannot be published yet` : `### ✓ \`${id}\` ${submission?.tag ?? ""} is valid`;
  return [head, "",
    ...result.errors.map((e) => `- ✗ ${e}`),
    ...result.notes.map((n) => `- ${n}`),
    "", result.errors.length ? "Fix these, publish a new release if the files changed, and push to this PR to check again." : "It is merged and listed automatically.",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : process.argv[i + 1]; };
  const out = resolve(arg("out") ?? ".");
  mkdirSync(out, { recursive: true });
  const pr = readPr(arg("pr"));
  const result = pr.errors.length ? { errors: pr.errors, notes: [] } : await validate(pr.id, pr.submission, pr.author);
  writeFileSync(join(out, "result.json"), JSON.stringify({ ok: !result.errors.length, id: pr.id, author: pr.author, ...result }, null, 2));
  writeFileSync(join(out, "report.md"), report(pr.id, pr.submission, result));
  console.log(readFileSync(join(out, "report.md"), "utf8"));
}
