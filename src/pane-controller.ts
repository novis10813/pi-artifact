import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, join, basename } from "node:path";
import { getAgentDir, withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DocumentSession } from "./document.ts";
import { SplitView } from "./split.ts";

/** Owns only the document pane. Lifecycle and permission state live in extension.ts. */
export default function installPane(pi: ExtensionAPI, changed?: (ctx: ExtensionContext) => Promise<void>, label: () => string = () => "") {
  let document: DocumentSession | undefined;
  let view: SplitView | undefined;
  let context: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let refreshing = false;
  let saving = false;
  let lastError = "";
  // Hidden keeps the document session (draft, cursor) without the split layout.
  let hidden = false;
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
  const stop = () => { if (timer) clearInterval(timer); timer = undefined; };
  const detach = () => { stop(); view?.unmount(); view = undefined; context?.ui.setStatus("plan-pane", undefined); };
  const save = async (): Promise<boolean> => {
    if (!document) return false;
    if (saving) { view?.message("Save already in progress"); return false; }
    if (refreshing) { view?.message("Reading disk · run :w again shortly"); return false; }
    const target = document, targetView = view;
    const report = (error: unknown) => {
      try { targetView?.message(errorText(error)); } catch { /* detached view */ }
      try { context?.ui.notify(errorText(error), "error"); } catch { /* stale context */ }
    };
    saving = true;
    try {
      try { await target.save(withFileMutationQueue); }
      catch (error) { report(error); return false; }
      // The file is written. Status and plan-sync failures are reported but do not turn this into a failed save.
      try { targetView?.message("Saved · F6 chat / document"); context?.ui.setStatus("plan-pane", "plan"); }
      catch (error) { report(error); }
      try { if (context) await changed?.(context); }
      catch (error) { report(error); }
      return true;
    } finally { saving = false; }
  };
  const refresh = async () => {
    if (refreshing || saving || !document || !view) return;
    refreshing = true;
    const target = document, targetView = view;
    try {
      if (!targetView.attached) {
        detach(); context?.ui.notify("Plan pane detached after layout/editor change. Draft retained. Use /plan-pane show or copy <path>.", "warning");
        return;
      }
      const before = target.buffer.text;
      await target.refresh();
      if (before !== target.buffer.text && context) await changed?.(context);
      if (document !== target || view !== targetView) return;
      if (target.conflict) targetView.message("Disk changed · draft kept · /plan-pane copy <path>");
      else if (lastError) targetView.message("F6 chat / document");
      lastError = "";
      context?.ui.setStatus("plan-pane", `plan${target.dirty ? "*" : ""}${target.conflict ? " conflict" : ""}`);
    } catch (error) {
      const message = errorText(error);
      targetView.message(message);
      if (message !== lastError) context?.ui.notify(message, "error");
      lastError = message;
    } finally { refreshing = false; }
  };
  const show = (ctx: ExtensionContext, focus = true) => {
    if (!document) throw new Error("Open a Markdown file first: /plan-pane open <path.md>");
    if (ctx.mode !== "tui") throw new Error("Plan pane requires interactive fullscreen mode.");
    if (view?.attached) { if (focus) view.focusPlan(); return; }
    detach(); context = ctx; hidden = false;
    // :wq hides only the document it saved, even if another one was opened meanwhile.
    const owner = document;
    const next = new SplitView(ctx, document, save, () => { if (document === owner) hide(ctx); }, label);
    next.mount(); view = next;
    ctx.ui.setStatus("plan-pane", `plan${document.dirty ? "*" : ""}`);
    timer = setInterval(() => { void refresh(); }, 500); timer.unref?.();
  };
  /** Collapse to full-width chat. Never saves, discards, or changes Plan Mode state. */
  const hide = (ctx: ExtensionContext) => {
    if (!document) throw new Error("No document open.");
    detach(); hidden = true;
    ctx.ui.setStatus("plan-pane", `plan hidden${document.dirty ? "*" : ""}`);
    ctx.ui.notify(`Plan pane hidden${document.dirty ? " · unsaved draft kept" : ""} · F7 or /plan-pane toggle to show`, "info");
  };
  const toggle = (ctx: ExtensionContext) => {
    if (!document) throw new Error("No plan pane open. Start with /plan <goal> or /plan-pane open <path.md>.");
    if (saving || refreshing) throw new Error("Document I/O in progress. Try again shortly.");
    if (view?.attached) hide(ctx); else show(ctx, false);
  };
  const open = async (path: string, ctx: ExtensionContext) => {
    if (saving || refreshing) throw new Error("Document I/O in progress. Try again shortly.");
    // Model updates to the same document must not re-open a pane the user hid.
    if (document?.path === path) { if (!hidden) show(ctx, false); return; }
    if (document?.dirty) throw new Error("Unsaved draft. Save, copy, or discard it first.");
    const next = await DocumentSession.open(path);
    detach(); document = next; show(ctx);
  };
  pi.registerCommand("plan-pane", {
    description: "Split Markdown editor: open <path.md>, show, toggle, save, copy <new.md>, close, discard",
    handler: async (args, ctx) => {
      const match = args.trim().match(/^(\S+)(?:\s+([\s\S]+))?$/);
      const action = match?.[1] ?? "show", path = match?.[2];
      try {
        if (saving || refreshing) throw new Error("Document I/O in progress. Try again shortly.");
        if (action === "open") {
          if (!path) throw new Error("Usage: /plan-pane open <existing-path.md> (spaces allowed, no quotes needed)");
          if (document?.dirty) throw new Error("Unsaved draft. Save, copy, or explicitly discard it before opening another file.");
          if (ctx.mode !== "tui") throw new Error("Plan pane requires interactive fullscreen mode.");
          const next = await DocumentSession.open(resolve(ctx.cwd, path));
          detach(); document = next; show(ctx);
        } else if (action === "show") show(ctx);
        else if (action === "toggle") toggle(ctx);
        else if (action === "save") { if (!document) throw new Error("No document open."); await save(); }
        else if (action === "copy") {
          if (!path || !document) throw new Error("Usage: /plan-pane copy <new-path.md>");
          const target = resolve(ctx.cwd, path); await document.saveCopy(target);
          ctx.ui.notify(`Draft copy saved: ${target}`, "info");
        } else if (action === "close" || action === "discard") {
          if (document?.dirty && action !== "discard") throw new Error("Unsaved draft. Save/copy it, or explicitly use /plan-pane discard.");
          detach(); document = undefined; hidden = false;
        } else throw new Error("Usage: /plan-pane open <path.md> | show | toggle | save | copy <new.md> | close | discard");
      } catch (error) { ctx.ui.notify(errorText(error), "error"); }
    },
  });
  pi.registerShortcut?.("f7", {
    description: "Show or hide the plan pane",
    handler: ctx => { try { toggle(ctx); } catch (error) { ctx.ui.notify(errorText(error), "error"); } },
  });
  // Session navigation must not abandon a dirty workspace draft or associate it
  // with a different branch. /reload and shutdown use a private recovery copy.
  const beforeNavigation = (_event: unknown, ctx: ExtensionContext) => {
    if (document?.dirty || saving || refreshing) {
      ctx.ui.notify("Save/copy/discard the plan-pane draft before changing sessions or branches.", "warning");
      return { cancel: true };
    }
    detach(); document = undefined; hidden = false;
    return undefined;
  };
  pi.on("session_before_switch", beforeNavigation);
  pi.on("session_before_fork", beforeNavigation);
  pi.on("session_before_tree", beforeNavigation);
  pi.on("session_shutdown", async (_event, ctx) => {
    stop();
    if (document?.dirty) {
      const directory = join(getAgentDir(), "drafts", "pi-artifact");
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `${Date.now()}-${randomUUID()}-${basename(document.path)}`);
        await writeFile(path, document.buffer.text, { flag: "wx", mode: 0o600 });
        ctx.ui.notify(`Unsaved plan draft recovered to ${path}`, "warning");
      } catch (error) {
        ctx.ui.notify(`Could not recover plan draft: ${errorText(error)}`, "error");
        process.stderr.write(`pi-artifact: unsaved draft recovery failed: ${errorText(error)}\n`);
      }
    }
    detach(); document = undefined; hidden = false;
  });
  return { open, show, hide, toggle, save, refresh,
    repaint() { view?.repaint(); },
    get hidden() { return hidden; },
    get document() { return document; },
    get busy() { return saving || refreshing; },
    get dirty() { return document?.dirty ?? false; },
    close() { if (document?.dirty) throw new Error("Unsaved draft. Save/copy/discard it first."); detach(); document = undefined; hidden = false; },
  };
}
