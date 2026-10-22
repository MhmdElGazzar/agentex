### Added
- **An architecture map on the README.** A "How it fits together" section with two mermaid
  diagrams. The first shows what you can run: every command, the skill it runs, the skills
  that spec steps or other skills trigger, and the subagents that take parallel work. The
  second shows which skill relies on which. Both are generated from the plugin's own files by
  `node scripts/dev/architecture.js --write`, and `scripts/dev/architecture.test.js` fails
  whenever a command, skill or agent is added without regenerating, so the map cannot go
  stale. Maintainer tooling only: `scripts/dev/` is never shipped; the README section is.
