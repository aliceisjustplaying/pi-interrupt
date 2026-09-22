import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Claude Code send-now semantics for Pi: Ctrl+Enter interrupts the run, then
 *  everything queued goes out right away with the editor text behind it. */
export default function interruptMode(pi: ExtensionAPI) {
  let enabled = false;
  let pending: string[] = [];
  let lastSubmission = "";

  const showStatus = (ctx: ExtensionContext) => {
    ctx.ui.setStatus("interrupt-mode", enabled ? "interrupt mode ON" : undefined);
  };

  pi.registerCommand("interrupt-mode", {
    description: "Interrupt on ordinary Enter submissions: on | off | status (default off; resets on reload)",
    getArgumentCompletions: (prefix) => ["on", "off", "status"]
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Interrupt mode is only available in the terminal UI.", "warning");
        return;
      }
      const action = args.trim() || "status";
      if (action === "on") enabled = true;
      else if (action === "off") enabled = false;
      else if (action !== "status") {
        ctx.ui.notify("Usage: /interrupt-mode on|off|status", "warning");
        return;
      }
      showStatus(ctx);
      ctx.ui.notify(enabled
        ? "Interrupt mode ON: ordinary steering submissions abort the active run, then send together with anything queued. Follow-up submissions still queue. Commands and images keep normal behavior."
        : "Interrupt mode OFF: normal steering and follow-up behavior.", "info");
    },
  });

  pi.registerCommand("interrupt-restore", {
    description: "Restore the last interrupt submission to an empty editor after a send failure",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      if (pending.length) {
        ctx.ui.notify("An interrupt message is still waiting for cancellation. It has not been sent yet.", "warning");
      } else if (ctx.ui.getEditorText().trim()) {
        ctx.ui.notify("Clear or save your current draft before restoring the interrupt message.", "warning");
      } else if (lastSubmission) {
        ctx.ui.setEditorText(lastSubmission);
      } else {
        ctx.ui.notify("No interrupt submission to restore in this extension session.", "info");
      }
    },
  });

  pi.registerShortcut("ctrl+enter", {
    description: "Send queued messages now: interrupt the run, then send queued entries followed by the editor text",
    handler: async (ctx) => {
      if (ctx.mode !== "tui") return;
      const text = ctx.ui.getEditorText();
      // Leave commands to Pi's regular submission path.
      if (text.trimStart().startsWith("/") || text.trimStart().startsWith("!")) {
        ctx.ui.notify("Use Enter for slash commands and shell commands.", "info");
        return;
      }
      if (ctx.isIdle()) {
        if (!text.trim()) return;
        lastSubmission = text;
        pi.sendUserMessage(text);
        ctx.ui.setEditorText("");
        return;
      }
      // Claude Code send-now: nothing queued and no draft means nothing to send.
      if (!text.trim() && !ctx.hasPendingMessages()) return;
      // Pi's abort handler restores queued messages into the editor ahead of
      // the draft before cancelling. Capture that combined text so the queued
      // entries and the draft all go out right after cancellation settles.
      ctx.abort();
      const queued = ctx.ui.getEditorText();
      ctx.ui.setEditorText("");
      if (!queued.trim()) return;
      if (ctx.isIdle()) {
        // Cancellation settled synchronously; do not wait for another event.
        lastSubmission = queued;
        pi.sendUserMessage(queued);
        return;
      }
      pending.push(queued);
      ctx.ui.setStatus("interrupt-mode", "interrupt: waiting for cancellation");
    },
  });

  pi.on("session_start", (_event, ctx) => showStatus(ctx));

  pi.on("input", (event, ctx) => {
    if (!enabled || ctx.mode !== "tui" || event.source !== "interactive" ||
        event.streamingBehavior !== "steer" || ctx.isIdle() ||
        event.images?.length || !event.text.trim() || event.text.trimStart().startsWith("/")) {
      return { action: "continue" };
    }
    // Pi clears the editor before dispatching a steering submission, so the
    // abort's queue restore below captures only previously queued entries.
    // Rapid submissions during cancellation are retained in order in one prompt.
    if (pending.length === 0) {
      ctx.abort();
      const restored = ctx.ui.getEditorText();
      ctx.ui.setEditorText("");
      const combined = [restored, event.text]
        .filter((part) => part.trim())
        .join("\n\n");
      if (combined.trim()) pending.push(combined);
    } else {
      pending.push(event.text);
    }
    ctx.ui.setStatus("interrupt-mode", "interrupt mode: waiting for cancellation");
    return { action: "handled" };
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!pending.length) return;
    const text = pending.join("\n\n");
    // Pi defers sends from this hook until all settled handlers have finished.
    lastSubmission = text;
    pi.sendUserMessage(text, { deliverAs: "steer" });
    pending = [];
    showStatus(ctx);
  });

  // Do not move captured input to another session while cancellation is pending.
  const guardNavigation = (_event: unknown, ctx: ExtensionContext) => {
    if (!pending.length) return;
    ctx.ui.notify("Wait for the interrupted message to be submitted before switching sessions.", "warning");
    return { cancel: true as const };
  };
  pi.on("session_before_switch", guardNavigation);
  pi.on("session_before_fork", guardNavigation);
  pi.on("session_before_tree", guardNavigation);
}
