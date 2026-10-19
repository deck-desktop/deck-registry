// Write stats.json: each listed package's GitHub stars and downloads.
//
//   node tools/stats.mjs
//
// Downloads are what GitHub counts on the package's release assets: its manifest (plugin.json or
// language.json) across every release, since every install and every update fetches it once.
// Stars are its repository's. Asked of GitHub's GraphQL API a few dozen repositories per query,
// so a registry of hundreds is still a handful of requests a day.
//
// Run daily by .github/workflows/stats.yml. stats.json is written only when a number changed, or
// when the last one is a week old: GitHub stops a public repository's scheduled workflows after
// 60 days without a commit, and a quiet registry would otherwise go silent for good.
//
// One package per repository is assumed for stars: two packages from one repository would each
// be shown its stars.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const at = join(root, "stats.json");
const PER_QUERY = 40;
const WEEK = 7 * 24 * 3600e3;

const packages = ["plugin", "language"].flatMap((kind) => {
  const dir = join(root, "packages", kind);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))) : [];
}).filter((p) => !p.removed);

/** One GraphQL query for a batch of repositories, each under its own alias. */
function query(batch) {
  const parts = batch.map((p, i) => {
    const [owner, name] = p.repo.split("/");
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      stargazerCount
      releases(first: 100) { nodes { releaseAssets(first: 20) { nodes { name downloadCount } } } }
    }`;
  });
  const out = execFileSync("gh", ["api", "graphql", "-f", `query={ ${parts.join("\n")} }`], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
  return JSON.parse(out.toString()).data;
}

const stats = {};
for (let i = 0; i < packages.length; i += PER_QUERY) {
  const batch = packages.slice(i, i + PER_QUERY);
  const data = query(batch);
  batch.forEach((p, j) => {
    const r = data[`r${j}`];
    if (!r) return;   // gone or renamed: no numbers rather than wrong ones
    const manifest = p.kind === "plugin" ? "plugin.json" : "language.json";
    // ponytail: the first 100 releases. Page through them when a package has more.
    const downloads = r.releases.nodes.reduce((n, rel) => n + (rel.releaseAssets.nodes.find((a) => a.name === manifest)?.downloadCount ?? 0), 0);
    stats[`${p.kind}:${p.id}`] = { stars: r.stargazerCount, downloads };
  });
}

const sorted = Object.fromEntries(Object.entries(stats).sort(([a], [b]) => a.localeCompare(b)));
const before = existsSync(at) ? JSON.parse(readFileSync(at, "utf8")) : null;
const same = before && JSON.stringify(before.packages) === JSON.stringify(sorted);
if (same && Date.now() - Date.parse(before.generated) < WEEK) {
  console.log(`unchanged: ${Object.keys(sorted).length} packages`);
} else {
  writeFileSync(at, JSON.stringify({ generated: new Date().toISOString(), packages: sorted }, null, 2) + "\n");
  console.log(`${same ? "weekly rewrite" : "updated"}: ${Object.keys(sorted).length} packages`);
}
