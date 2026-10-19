// Turn the merged submissions on main into packages/ entries.
//
//   node tools/ingest.mjs
//
// A submission was validated on its PR, and merged as it was (the workflow cannot push to a
// fork's branch, so it never edits the PR). This validates it again on main, because two PRs
// merged moments apart can both have passed alone — the second asking for an id the first just
// took. A valid one is appended to packages/; either way the submission file is removed. One that
// no longer validates has no PR left to comment on, so it gets an issue saying why.
//
// Idempotent, and run by submit.yml after each merge and by build.yml as the fallback for a run
// that stopped in between. Both share one concurrency group, so writes never interleave.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "./validate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = process.env.GITHUB_REPOSITORY || "deck-desktop/deck-registry";
const gh = (args) => execFileSync("gh", args, { stdio: ["ignore", "pipe", "pipe"] }).toString();

/** Who submitted a file: the author of the PR whose merge added it. */
function authorOf(file) {
  const [commit] = JSON.parse(gh(["api", `repos/${REGISTRY}/commits?path=${file}&per_page=1`]));
  const [pr] = commit ? JSON.parse(gh(["api", `repos/${REGISTRY}/commits/${commit.sha}/pulls`])) : [];
  return pr ? { id: pr.user.id, login: pr.user.login, pr: pr.number } : null;
}

const dir = join(root, "submissions");
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
const done = [];
for (const f of files) {
  const rel = `submissions/${f}`, id = f.slice(0, -5);
  let submission = null, result;
  const author = authorOf(rel);
  try { submission = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { /* reported below */ }
  if (!author) result = { errors: ["no merged PR added it"], notes: [] };
  else if (!submission) result = { errors: ["it is not valid JSON"], notes: [] };
  else result = await validate(id, submission, author);
  rmSync(join(dir, f));
  if (!result.errors.length) {
    const at = join(root, "packages", result.pkg.kind, `${id}.json`);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, JSON.stringify(result.pkg, null, 2) + "\n");
    done.push(`${id} ${submission.tag}`);
    console.log(`ingested ${id} ${submission.tag}`);
  } else {
    console.log(`dropped ${rel}: ${result.errors.join("; ")}`);
    const body = [`The submission \`${rel}\`${author ? ` from @${author.login} (#${author.pr})` : ""} was merged, but no longer validates on main, so it was not published:`, "",
      ...result.errors.map((e) => `- ${e}`), "", "Open a new submission once it is fixed."].join("\n");
    try { gh(["issue", "create", "--repo", REGISTRY, "--title", `Submission ${id} was not published`, "--body", body]); }
    catch (e) { console.warn(`could not open an issue: ${e.message}`); }
  }
}
if (process.env.GITHUB_OUTPUT && done.length) {
  writeFileSync(process.env.GITHUB_OUTPUT, `message=registry: ${done.join(", ")}\n`, { flag: "a" });
}
