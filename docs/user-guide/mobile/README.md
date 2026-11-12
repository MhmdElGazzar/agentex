# Mobile Testing User Guide

Test native Android and iOS apps with an AI agent and Appium: the essentials, step by step.
About fifteen minutes to read; your first run right after.

[All user guides](../README.md) · [PDF version](./agentex-mobile-user-guide.pdf) ·
[Full AgenTeX User Guide](../agentex/README.md) · [Full mobile reference](../../mobile-testing.md)

To update this guide or re-export its PDF, see [Updating a guide](../README.md#updating-a-guide).

## Why

It's 5 PM. The release ships tomorrow, and 40 screens are still waiting for your thumb. Same
build, same taps, second device. Screenshots if you remember. `logcat` open in another window,
hoping you catch the crash that hides behind a screen that looks fine.

| Today | With AgenTeX |
|-------|--------------|
| ✕ 40 screens × 2 devices, by hand | ✓ one command, plain-English tests |
| ✕ screenshots when you remember | ✓ a screenshot for every step |
| ✕ logcat watched in another window | ✓ crashes caught from the device log |
| ✕ bug steps rebuilt from memory | ✓ defects written up for you |

**You describe the test. An agent taps through it on a real device. You review the proof.**

## Your path

Six stops from zero to a full mobile regression:

1. [How it works](./01-how-it-works.md): the whole idea in one picture
2. [Setup in 4 steps](./02-setup.md): install, device, permissions
3. [Point it at your app](./03-point-it-at-your-app.md): one JSON block
4. [Your first run](./04-first-run.md): one command, with checkpoints
5. [Write a spec](./05-write-a-spec.md): plain-English markdown
6. [Run at scale and read the results](./06-run-at-scale.md): parallel devices, results

Then: [7. If something breaks + cheat sheet](./07-troubleshooting-and-cheat-sheet.md).
