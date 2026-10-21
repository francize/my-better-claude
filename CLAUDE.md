# my-better-claude

## Versions

Marketplace installs update only when a plugin's version changes, so every
change to what a plugin ships (hooks, skills, types, plugin.json, README) bumps
its version before it is pushed:

- Bump the patch number unless asked otherwise.
- Change it in both places, to the same value:
  `plugins/<name>/.claude-plugin/plugin.json` and that plugin's entry in
  `.claude-plugin/marketplace.json`.
- Put the bump in the same commit as the change. A change already pushed
  without one gets a follow-up `chore(<name>): bump version to <x.y.z>` commit
  naming what it ships.
- Tests-only changes do not bump.
