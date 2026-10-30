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
// are advice, and these checks only decide whether it is a valid package.
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
//   (react, lucide-react, framer-motion). Those names are BUILD_RUNS, in the SDK's validate.mjs; a
//   build-plugin.mjs change that executes anything else must add it there.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// What needs only a package's files is deck-plugin-sdk's (validate.mjs): the same checks
// `deck-plugin publish` runs on the author's machine before anything is public, so the two can
// never disagree. This file adds what needs GitHub: who owns it, the release, the rebuild.
import {
  assetName, BUILD_RUNS, checkAssets as checkFiles, checkIcon, checkId, checkLockfile, checkPermissions, compareVersions, fileFacts, ICON_FILE, MAX_FILE, MAX_TOTAL, points, RESERVED, SEMVER,
} from "./node_modules/deck-plugin-sdk/validate.mjs";
export { assetName, BUILD_RUNS, checkLockfile, checkPermissions, compareVersions, MAX_FILE, MAX_TOTAL, RESERVED };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = process.env.GITHUB_REPOSITORY || "deck-desktop/deck-registry";

/** A release's assets: the SDK's rules, and GitHub's sha256 on every one (the SDK checks a digest only
 *  where there is one, since an author's own files have none). */
export const checkAssets = (kind, assets) => checkFiles(kind, assets.map((a) => ({ digest: null, ...a })));

/** New packages one owner may add in a day: auto-merge without review needs a brake on spam. */
export const NEW_PER_DAY = 5;

/** The submission file's shape, exactly: anything else is refused rather than ignored. */
export function checkSubmission(id, s) {
  const errors = checkId(id).map((e) => e.replace("the id", "the file name, which is the package id,"));
  if (typeof s !== "object" || s === null || Array.isArray(s)) return [...errors, "the submission must be a JSON object"];
  const extra = Object.keys(s).filter((k) => !["kind", "repo", "tag"].includes(k));
  if (extra.length) errors.push(`unexpected field${extra.length > 1 ? "s" : ""}: ${extra.join(", ")}`);
  if (s.kind !== "plugin" && s.kind !== "language") errors.push("`kind` must be \"plugin\" or \"language\"");
  if (typeof s.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(s.repo)) errors.push("`repo` must be \"owner/name\"");
  if (typeof s.tag !== "string" || !/^v/.test(s.tag) || !SEMVER.test(s.tag.slice(1))) errors.push("`tag` must be v<version>, such as v1.0.0");
  return errors;
}

/**
 * Deck's permission table, from the deck-plugin-sdk this registry installs (permissions.json), or
 * DECK_PERMISSIONS naming a copy. Null when neither is there: the permission checks are skipped
 * and the report says so.
 */
export function loadPermissions() {
  const at = process.env.DECK_PERMISSIONS ?? join(root, "tools", "node_modules", "deck-plugin-sdk", "permissions.json");
  return existsSync(at) ? JSON.parse(readFileSync(at, "utf8")) : null;
}

/** The newest deck-plugin-sdk on npm, for the up-to-date check; null when npm cannot be reached. */
export async function newestSdk() {
  try { return (await (await fetch("https://registry.npmjs.org/deck-plugin-sdk/latest")).json()).version ?? null; } catch { return null; }
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
 * Rebuild a plugin from its source at the tag, cloned in `dir`, and check the built files against
 * the release's: `assets` has its asset names, `digest(name)` a released file's sha256. Then
 * type-check it with the TypeScript its own lockfile installed. Shared with rescore.mjs, which
 * scores the versions published before points existed.
 */
export function rebuildPlugin(dir, assets, digest) {
  const errors = [], notes = [];
  const has = (f) => existsSync(join(dir, f));
  let buildVerified = false;
  /** Whether `tsc --noEmit` passes: null when it could not be run (no rebuild, no tsconfig, no typescript). */
  let typechecks = null;
  if (has("deck-plugin.config.mjs")) {
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
        // Type-checked with the TypeScript its own lockfile installed: tsc reads the code, it never runs it.
        const tsc = join(dir, "node_modules", "typescript", "bin", "tsc");
        if (buildVerified && has("tsconfig.json") && existsSync(tsc)) {
          try { execFileSync(process.execPath, [tsc, "--noEmit", "-p", "."], { cwd: dir, stdio: "pipe" }); typechecks = true; } catch { typechecks = false; }
        }
      } catch (e) {
        errors.push(`the build failed: ${(e.stderr ?? e.message).toString().trim().split("\n").slice(-3).join(" ")}`);
      }
    }
  }
  return { errors, notes, buildVerified, typechecks };
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
    // An icon of its own (icon.svg) or a lucide one by name. Its own is carried inline, checked
    // to be only shapes, and must be the released file: the one Deck installs.
    let iconNode = null, iconSvg = null;
    if (kind === "plugin" && icon === ICON_FILE) {
      if (!has(ICON_FILE) || !assets.has(ICON_FILE)) errors.push(`plugin.json's icon is ${ICON_FILE}: put it in the source and in the release`);
      else {
        const svg = readFileSync(join(dir, ICON_FILE));
        if (sha256(svg) !== digest(ICON_FILE)) errors.push(`the release's ${ICON_FILE} is not the one at the tag`);
        errors.push(...checkIcon(svg.toString("utf8")));
        iconSvg = `data:image/svg+xml;base64,${svg.toString("base64")}`;
      }
    } else {
      iconNode = await iconNodeOf(icon);
      if (!iconNode) errors.push(`\`${icon}\` is not a lucide icon name (lucide.dev/icons, in PascalCase), or ${ICON_FILE} for one of its own`);
    }

    // The files: a language's are its source; a plugin's are rebuilt from it, when that proves anything.
    let buildVerified = false;
    /** Whether `tsc --noEmit` passes: null when it could not be run (no rebuild, no tsconfig, no typescript). */
    let typechecks = null;
    if (kind === "language") {
      const snippets = existsSync(join(dir, "snippets")) ? readdirSync(join(dir, "snippets")).filter((f) => f.endsWith(".json")).map((f) => `snippets/${f}`) : [];
      const want = new Set(["language.json", ...snippets].map(assetName));
      for (const a of assets.keys()) if (!want.has(a)) errors.push(`the release has \`${a}\`, which is not in the source`);
      for (const f of snippets) if (digest(f) !== sha256(readFileSync(join(dir, f)))) errors.push(`the release's ${f} is not the one at the tag`);
      buildVerified = true;
    } else {
      const r = rebuildPlugin(dir, assets, digest);
      errors.push(...r.errors);
      notes.push(...r.notes);
      ({ buildVerified, typechecks } = r);
    }
    // What it may use: declared, and covering what its bundle calls (when Deck's table is here).
    let permissions, used = [];
    if (kind === "plugin") {
      const table = loadPermissions();
      if (!table) notes.push("Its permissions were not checked: this registry's deck-plugin-sdk predates them.");
      else {
        const bundle = has("plugin.js") && buildVerified ? readFileSync(join(dir, "plugin.js"), "utf8")
          : Buffer.from(await (await fetch(assets.get("plugin.js").browser_download_url)).arrayBuffer()).toString("utf8");
        const r = checkPermissions(m.permissions, bundle, table, id);
        errors.push(...r.errors);
        notes.push(...r.notes);
        used = r.used;
        if (Array.isArray(m.permissions)) permissions = [...new Set(m.permissions)];
      }
    }
    if (errors.length) return { errors, notes };

    // Its points (a plugin's only: a language has no bundle to rebuild or check), worked out now
    // and kept with the version, which never changes.
    let score;
    if (kind === "plugin") {
      const read = (f) => (has(f) ? readFileSync(join(dir, f), "utf8") : null);
      score = points({ ...fileFacts(read), buildVerified, typechecks, permissions: permissions ?? null, used, newestSdk: await newestSdk() });
      notes.push(`Points: **${score.total}** of 100.${score.checks.filter((c) => c.fix).map((c) => `
  - ${c.fix} (+${c.max})`).join("")}`);
    }

    const record = {
      version, tag, publishedAt: rel.published_at, readme: true,
      manifest: {
        name, description, icon,
        ...(m.color ? { color: m.color } : {}),
        minDeck: kind === "plugin" ? m.minDeck : null,
        ...(permissions ? { permissions } : {}),
        ...(kind === "language" ? { requires: m.server?.command ?? m.server?.module ?? null, extensions: m.extensions ?? [] } : {}),
      },
      ...(iconNode ? { iconNode } : {}),
      ...(iconSvg ? { iconSvg } : {}),
      files: Object.fromEntries([...assets.values()].map((a) => [a.name.replace(/^snippets--/, "snippets/"), { sha256: a.digest.slice(7), bytes: a.size }])),
      buildVerified,
      ...(score ? { points: score } : {}),
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
