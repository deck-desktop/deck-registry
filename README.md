# Deck plugin registry

`index.json` is the registry [Deck](https://deck.hasan-zarif.com) reads to list, install and
update plugins and language definitions. Deck and the website fetch it from

```
https://raw.githubusercontent.com/deck-desktop/deck-registry/main/index.json
```

It names each published plugin and language, its version, and the URL and SHA-256 of every file.
The files themselves live in their own repositories (`deck-plugin-<id>`, `deck-language-<id>`);
Deck checks each download against the hash here before installing it.

This repository is written by `publish-registry.mjs` in Deck's own repository. Do not edit
`index.json` by hand: a hash that does not match the file it names makes that install fail.
