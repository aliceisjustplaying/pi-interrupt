# pi-interrupt

**Ctrl+Enter: stop the current Pi run, then send your message.** Enter still steers and Alt+Enter still queues a follow-up. This is a standalone [Pi extension](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), not a Pi fork or provider patch.

## Install

```sh
pi install git:github.com/aliceisjustplaying/pi-interrupt
```

Run `/reload` in an existing Pi session, or start a new one. Tested with Pi **0.87.0** and Node **24**.

## Keys

| Key | While Pi is working |
| --- | --- |
| **Enter** | Steer: deliver your message after the current turn's tools finish. |
| **Alt+Enter** | Follow-up: wait until the agent finishes. |
| **Ctrl+Enter** | Interrupt: request cancellation, wait for the run to settle, then send the editor text. |
| **Escape** | Pi's normal abort action. |

When idle, Ctrl+Enter sends the editor text normally. Empty input does nothing. Slash commands and `!` shell commands stay in the editor: use Enter for those.

The extension registers `ctrl+enter` through Pi's shortcut API. Your terminal must report Ctrl+Enter separately from Enter; otherwise Pi cannot distinguish them. Existing custom keybindings or extensions may conflict. Enter and Alt+Enter in the table are Pi's default bindings, not bindings installed by this package.

Sources: [implementation](index.ts), [Pi keybindings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/keybindings.md).

## Optional: interrupt on Enter

You don't need this for Ctrl+Enter. To make ordinary Enter submissions interrupt too:

```text
/interrupt-mode on
/interrupt-mode status
/interrupt-mode off
```

This option is **off by default** and resets when the extension reloads or a new session runtime starts. A footer indicator appears when it is on. Explicit follow-ups still queue; slash commands and image-bearing input keep their normal behavior. The mode follows Pi's steering input action, so it also respects a remapped submit key.

If a submission fails—for example, because no model is selected—use `/interrupt-restore` to put the last interrupt submission back into an empty editor. It will not overwrite a new draft. This recovery copy lasts only until the extension reloads or the session runtime changes.

## Limits

- **Cancellation is cooperative, not instant.** A tool that ignores cancellation can delay the new message. Already completed writes or other side effects are not undone.
- The extension calls Pi's normal abort API. It does not independently kill background jobs, servers or subagents.
- Ctrl+Enter sends **editor text**, not a separate attachment payload. Use the normal submission path for images.
- Interrupt messages submitted while cancellation is pending are combined in order into one prompt. Existing Pi steering and follow-up queues are left intact. Use Pi's normal queue controls to remove an outdated queued instruction.
- Pending interrupt text is held in memory until resubmission, not in Pi's visible queue. Do not exit or reload before it is sent. The extension blocks session navigation while that text is pending.
- This changes input handling, not model latency or response style. It does not install a system prompt, alter authentication or change model settings.

See [source](index.ts) and [session integration tests](test/session.test.mjs). The tests use a fake model stream; they do not measure live model responsiveness or verify your terminal's key reporting.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

Tests cover input routing, rapid submissions, navigation guards and actual Pi abort/settle/resubmit behavior with a queued follow-up. They use isolated model credentials and a fake stream, not a live provider. Test artifacts stay under `$TMPDIR` when set, otherwise `.test-artifacts/`.

[MIT license](LICENSE).
