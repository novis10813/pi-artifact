import { resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import installPane from "./pane-controller.ts";
import { ArtifactStore, exactEdits, type Artifact } from "./store.ts";
import { PlanController, PLAN_ENTRY, PLANNING_TOOLS } from "./plan.ts";
import { openReviewUI } from "./review.ts";

const PENDING_ENTRY = "pi-artifact:pending:v1";
const text = (s: string, details: unknown = undefined) => ({ content: [{ type: "text" as const, text: s }], details });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function (pi: ExtensionAPI): void {
  let store: ArtifactStore | undefined, plan: PlanController | undefined;
  let pending: string | undefined;
  let commandBusy = false;
  const ensure = (ctx: ExtensionContext) => {
    if (!store || store.cwd !== ctx.cwd) {
      store = new ArtifactStore(ctx.cwd);
      plan = new PlanController(store, state => pi.appendEntry(PLAN_ENTRY, state));
    }
    return { store: store!, plan: plan! };
  };
  // The plan phase is shown in the pane's bottom-right corner, not in the global footer.
  const status = (_ctx: ExtensionContext) => pane.repaint();
  const loadout = () => {
    if (!plan?.active) return;
    const previous = plan.state.previousTools ?? pi.getActiveTools();
    pi.setActiveTools(plan.restricted ? [...new Set([...previous.filter(x => PLANNING_TOOLS.has(x)), "read_artifact", "edit_artifact", "replace_artifact", "request_plan_review"])] : previous);
  };
  const pane = installPane(pi, async ctx => {
    if (plan?.active) { await plan.sync(); loadout(); status(ctx); }
  }, () => plan?.active ? `PLAN ${plan.state.phase}` : "");
  const restore = async (_event: unknown, ctx: ExtensionContext) => {
    const p = ensure(ctx);
    const branch = ctx.sessionManager.getBranch();
    p.plan.restore(branch);
    pending = undefined;
    for (const entry of branch) if (entry.type === "custom" && entry.customType === PENDING_ENTRY) pending = typeof entry.data === "string" ? entry.data : undefined;
    if (p.plan.active) {
      try { await p.plan.sync(); } catch (error) { ctx.ui.notify(errorText(error), "error"); }
      loadout();
      if (ctx.mode === "tui" && p.plan.state.artifactId) {
        try {
          const a = await p.store.read(p.plan.state.artifactId);
          await pane.open(resolve(ctx.cwd, a.record.path), ctx);
        } catch (error) { ctx.ui.notify(`Plan retained without pane: ${errorText(error)}`, "warning"); }
      }
    }
    status(ctx);
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  const setPending = (id?: string) => { pi.appendEntry(PENDING_ENTRY, id ?? null); pending = id; };
  const open = async (a: Artifact, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    try { await pane.open(resolve(ctx.cwd, a.record.path), ctx); }
    catch (error) { ctx.ui.notify(`Artifact saved, pane unavailable: ${errorText(error)}`, "warning"); }
  };
  const idle = (ctx: ExtensionContext) => {
    if (!ctx.isIdle()) throw new Error("Wait for the agent to finish or interrupt it first.");
    if (pane.busy || pane.dirty) throw new Error("Save/copy/discard the manual draft before changing Plan Mode state.");
  };
  const review = async (a: Artifact, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") throw new Error("Interactive terminal review required. The artifact is available through read_artifact in other modes.");
    idle(ctx);
    const previous = await store!.read(a.record.id);
    const lines = previous.content.split(/\r?\n/);
    let frontmatterEnd = 0;
    if (lines[0] === "---") { const end = lines.indexOf("---", 1); if (end >= 0) frontmatterEnd = end + 1; }
    const previousReview = await store!.readReview(a.record.id, previous.revision);
    const initialComments = new Map<number, string>((previousReview?.lineComments ?? []).map(c => [c.line, c.comment]));
    const title = lines.slice(1, Math.max(1, frontmatterEnd - 1)).find(line => line.startsWith("title:"))?.slice(6).trim() || a.record.id;
    const result = await openReviewUI(ctx, { id: a.record.id, title, lines, frontmatterEnd, initialComments });
    if (!result || result.decision === "abandoned") return;
    const saved = await store!.review(a.record.id, previous.revision, result.decision, result.overallComment, [...result.lineComments].map(([line, comment]) => ({ line, comment })));
    if (pending === a.record.id) setPending();
    if (plan?.active && plan.state.artifactId === a.record.id) {
      if (result.decision === "rejected") await plan.revise();
      ctx.ui.notify(`Review ${result.decision}. Execution is still locked. ${result.decision === "approved" ? "Use /plan approve, then /plan execute." : "Continue revising this plan."}`, "info");
    }
    pi.sendUserMessage(`Artifact review result:\n${JSON.stringify({ artifactId: a.record.id, revision: previous.revision, approved: result.decision === "approved", comments: saved.lineComments.map(c => ({ line: c.line, text: lines[c.line - 1]?.trim() ? lines[c.line - 1] : lines.slice(0, c.line - 1).findLast(line => line.trim()) ?? "", comment: c.comment })), overallComment: saved.overallComment ?? "", executionApproved: false })}`);
    loadout(); status(ctx);
  };
  const guardDraft = (id: string) => {
    // Conservatively protect every visible dirty draft, including one opened by path.
    if (pane.dirty) throw new Error(`Unsaved manual draft. Save/copy/discard before updating ${id}.`);
  };
  pi.registerTool({
    name: "create_artifact", label: "Create Artifact",
    description: "Create a local artifact, or update the SAME active Plan Mode document. End your turn immediately and wait for /artifact review. Saving is not execution approval.",
    promptSnippet: "Use artifact tools for reviewable plan/spec/report documents. Read/edit/replace the existing artifact for revisions, not a new artifact per reply.",
    promptGuidelines: ["Pass full Markdown content, not a path or summary.", "After create_artifact succeeds, stop this turn for review. Generic artifact approval never authorizes implementation."],
    parameters: Type.Object({ content: Type.String({ description: "Full artifact content" }), title: Type.Optional(Type.String({ description: "Optional artifact title" })) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = ensure(ctx); guardDraft(p.plan.state.artifactId ?? "new artifact");
      const a = p.plan.active ? await p.store.update(p.plan.state.artifactId!, () => params.content, p.plan.state.revision) : await p.store.create(params.content, params.title);
      if (p.plan.active) await p.plan.submit();
      if (ctx.hasUI) setPending(a.record.id);
      await open(a, ctx); loadout(); status(ctx);
      return { ...text(`Artifact created: ${a.record.id}\nSTOP: End your turn now. Review with /artifact. Saving/review is not execution authorization.`, { artifactId: a.record.id, revision: a.revision }), terminate: true };
    },
  });
  pi.registerTool({
    name: "edit_artifact", label: "Edit Artifact", description: "Update an existing artifact using unique non-overlapping exact replacements against its original content. Resets approval.",
    parameters: Type.Object({ artifactId: Type.String({ description: "Target artifact id" }), edits: Type.Array(Type.Object({ oldText: Type.String({ description: "Exact text to replace" }), newText: Type.String({ description: "Replacement text" }) }), { minItems: 1 }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = ensure(ctx); guardDraft(params.artifactId);
      const a = await p.store.update(params.artifactId, content => exactEdits(content, params.edits));
      if (p.plan.active) await p.plan.sync(); await pane.refresh(); loadout(); status(ctx);
      return text(`Artifact updated: ${a.record.id}`, { artifactId: a.record.id, appliedEdits: params.edits.length, revision: a.revision });
    },
  });
  pi.registerTool({
    name: "read_artifact", label: "Read Artifact", description: "Read an artifact's full content and current revision, or a specific immutable revision.",
    parameters: Type.Object({ artifactId: Type.String(), revision: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = ensure(ctx), a = await p.store.read(params.artifactId);
      return text(params.revision ? await p.store.revision(params.artifactId, params.revision) : a.content, { artifactId: a.record.id, revision: params.revision ?? a.revision, status: a.record.status });
    },
  });
  pi.registerTool({
    name: "replace_artifact", label: "Replace Artifact", description: "Replace full artifact content, requiring the current revision from read_artifact. Use for substantial revisions, never create a duplicate plan.",
    parameters: Type.Object({ artifactId: Type.String(), content: Type.String(), expectedRevision: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = ensure(ctx); guardDraft(params.artifactId);
      const a = await p.store.update(params.artifactId, () => params.content, params.expectedRevision);
      if (p.plan.active) await p.plan.sync(); await pane.refresh(); loadout(); status(ctx);
      return text(`Artifact replaced: ${a.record.id}`, { artifactId: a.record.id, revision: a.revision });
    },
  });
  pi.registerTool({
    name: "request_plan_review", label: "Submit Plan", description: "Submit current plan revision for user review and stop this turn. Does not approve or execute the plan.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const p = ensure(ctx); guardDraft(p.plan.state.artifactId ?? "plan"); await p.plan.submit();
      loadout(); status(ctx);
      return { ...text(`Plan ${p.plan.state.artifactId} ready. STOP. User: /plan review, /plan approve, then /plan execute.`, { artifactId: p.plan.state.artifactId, revision: p.plan.state.revision }), terminate: true };
    },
  });
  pi.registerCommand("artifact", {
    description: "Open existing artifact in the split pane; review, list or abandon. /artifact [id|path] | review <id> | abandon <id>",
    handler: async (args, ctx) => {
      if (commandBusy) { ctx.ui.notify("Another artifact/plan command is active.", "warning"); return; }
      commandBusy = true;
      try {
        const p = ensure(ctx), raw = args.trim();
        if (raw.startsWith("review ")) { await review(await p.store.resolve(raw.slice(7)), ctx); return; }
        if (raw.startsWith("abandon ")) {
          idle(ctx); const a = await p.store.resolve(raw.slice(8));
          if (p.plan.active && a.record.id === p.plan.state.artifactId) throw new Error("Use /plan off before abandoning its artifact.");
          if (await ctx.ui.confirm("Abandon artifact?", a.record.id)) await p.store.abandon(a.record.id); return;
        }
        let target = raw;
        if (!target) {
          const rows = (await p.store.list()).filter(a => a.status !== "abandoned");
          if (!rows.length) { ctx.ui.notify("No artifacts.", "info"); return; }
          target = await ctx.ui.select("Artifacts (including prior approvals)", rows.map(a => `${a.id} ${a.status} ${a.path}`)) ?? "";
          if (!target) return; target = target.split(" ")[0];
        }
        const a = await p.store.resolve(target); await open(a, ctx);
        const action = await ctx.ui.select(a.record.id, ["Review with line comments", "Keep editing", "Abandon"]);
        if (action === "Review with line comments") await review(a, ctx);
        if (action === "Abandon") {
          idle(ctx); if (p.plan.active && p.plan.state.artifactId === a.record.id) throw new Error("Use /plan off first.");
          if (await ctx.ui.confirm("Abandon artifact?", a.record.id)) await p.store.abandon(a.record.id);
        }
      } catch (error) { ctx.ui.notify(errorText(error), "error"); }
      finally { commandBusy = false; }
    },
  });
  pi.registerCommand("plan", {
    description: "Plan Mode: on [goal], use <artifact-id>, status, show, review, approve, execute, revise, done, off",
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (commandBusy) { ctx.ui.notify("Another artifact/plan command is active.", "warning"); return; }
      commandBusy = true;
      try {
        const p = ensure(ctx), match = args.trim().match(/^(\S+)(?:\s+([\s\S]+))?$/), action = match?.[1] ?? "status", value = match?.[2];
        if (action === "status") { ctx.ui.notify(JSON.stringify(p.plan.state, null, 2), "info"); return; }
        if (action === "show") { if (!p.plan.active) throw new Error("No active plan."); await open(await p.store.read(p.plan.state.artifactId!), ctx); return; }
        idle(ctx);
        if (action === "on" || action === "use") {
          if (p.plan.active) throw new Error("A plan is already active. Use /plan revise, or /plan off before switching.");
          const a = action === "use" ? await p.store.resolve(value ?? "") : await p.store.create(`# Plan\n\n## Goal\n${value ?? "Discuss and define the requested change."}\n\n## Approach\n\n## Verification\n\n## Not doing\n`, value ?? "Plan");
          await p.plan.enter(a.record.id, pi.getActiveTools()); await open(a, ctx);
          loadout(); status(ctx);
          pi.sendUserMessage(`Plan Mode enabled for ${a.record.id}. ${value ?? "Use the conversation's requirements."} Explore and revise this SAME artifact. Do not implement. Submit with request_plan_review when ready.`);
        } else if (action === "off") {
          if (p.plan.active && !(await ctx.ui.confirm("Leave Plan Mode?", "This removes the planning restrictions, without approving or executing the plan. Continue?"))) return;
          const tools = p.plan.off(); if (tools) pi.setActiveTools(tools); status(ctx);
        } else if (action === "review") {
          await p.plan.submit(); loadout(); status(ctx); await review(await p.store.read(p.plan.state.artifactId!), ctx);
        } else if (action === "approve") {
          if (ctx.mode !== "tui") throw new Error("Plan approval requires the interactive user confirmation dialog.");
          await p.plan.sync(); const revision = p.plan.state.revision;
          if (p.plan.state.phase !== "review" || !revision) throw new Error("Submit/review the plan before approving it.");
          const a = await p.store.read(p.plan.state.artifactId!); await open(a, ctx);
          if (await ctx.ui.confirm("Approve this exact plan revision?", `${a.record.id}\nSHA-256 ${revision}\nThis approves the document only. /plan execute is a separate action.`)) {
            idle(ctx); await p.plan.approve(revision); status(ctx);
          }
        } else if (action === "execute") {
          if (ctx.mode !== "tui") throw new Error("Execution requires the interactive user confirmation dialog.");
          await p.plan.sync(); const revision = p.plan.state.revision;
          if (p.plan.state.phase !== "approved" || !revision) throw new Error("Use /plan approve first.");
          if (await ctx.ui.confirm("Start approved implementation?", `Plan ${p.plan.state.artifactId}\nSHA-256 ${revision}\nProject writes, shell commands and delegated work will become available. Existing work outside this session is not controlled.`)) {
            idle(ctx); await p.plan.execute(revision); loadout(); status(ctx);
            pi.sendUserMessage(`Execute approved plan ${p.plan.state.artifactId}, exact revision ${revision}. Read it with read_artifact. Reuse existing tasks, set_verify, and reviewers. Do not silently broaden scope. If the plan changes, return to planning and obtain a fresh approval.`);
          }
        } else if (action === "revise") { await p.plan.revise(); if (pending) setPending(); loadout(); status(ctx); }
        else if (action === "done") { p.plan.finish(); loadout(); status(ctx); }
        else throw new Error("Usage: /plan on [goal] | use <id> | status | show | review | approve | execute | revise | done | off");
      } catch (error) { ctx.ui.notify(errorText(error), "error"); }
      finally { commandBusy = false; }
    },
  });
  pi.on("input", () => { if (pending) setPending(); });
  pi.on("tool_call", async (event, ctx) => {
    const p = ensure(ctx);
    if (pending && ctx.hasUI) return { block: true, terminate: true, reason: `Artifact ${pending} is awaiting review. End this turn. Use /artifact to review.` };
    const reason = await p.plan.block(event.toolName, event.input as Record<string, unknown>, pane.dirty);
    loadout(); status(ctx);
    if (reason) return { block: true, terminate: p.plan.state.phase === "review", reason };
  });
  pi.on("user_bash", async (_event, ctx) => {
    const p = ensure(ctx);
    if (p.plan.active) {
      const reason = await p.plan.block("bash", {}, pane.dirty);
      loadout(); status(ctx);
      if (reason) return { result: { output: reason, exitCode: 1, cancelled: false, truncated: false } };
    }
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    const p = ensure(ctx);
    if (!p.plan.active) return;
    try { await p.plan.sync(); } catch (error) { ctx.ui.notify(errorText(error), "error"); }
    loadout(); status(ctx);
    return { message: { customType: "pi-artifact:plan-context", content: p.plan.prompt(), display: false } };
  });
}
