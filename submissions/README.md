# Submitting a plugin or a language

1. Publish a GitHub release of your package, tagged `v<version>`, from a public repository you
   own:
   - **A plugin:** attach `plugin.json`, `plugin.js` and, if it has agent tools, `mcp.js`, built
     with `npm ci && npm run build` at the tag.
   - **A language:** attach `language.json`, and each `snippets/<name>.json` as
     `snippets--<name>.json`.
   - **Also commit** at the tag a README.md, a LICENSE and, for a plugin, `package-lock.json`.
2. Open a pull request that adds one file, `submissions/<id>.json`, where `<id>` is your
   package's id:

   ```json
   { "kind": "plugin", "repo": "you/deck-plugin-thing", "tag": "v1.0.0" }
   ```

The checks run on the PR and comment what they found. When they pass, the PR is merged and the
package is listed within a few minutes. A new version is a new release and a new PR in the same
way. A version, once published, never changes.

The checks decide only whether it is a valid package: who owns it, that its version is new, that
its files are what its source builds to. They are not a review of what it does. Deck shows a
package from anyone but a verified organisation as Community.
