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
    if (!ctx.isIdle()) throw new Error("模型仍在回應。等它結束或先中斷（Esc），再執行這個指令。");
    if (pane.busy || pane.dirty) throw new Error("右側有未儲存編輯。先 :w 儲存、/plan-pane copy 或 discard，再變更 Plan Mode 狀態。");
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
    // Line review is a compatibility feature; it never changes Plan Mode phase or authorization.
    if (plan?.active && plan.state.artifactId === a.record.id) ctx.ui.notify(`Line review ${result.decision} saved. It does not change Plan Mode or authorize execution; use /plan approve for that.`, "info");
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
      // During implementation the approved document must not be silently replaced.
      if (p.plan.state.phase === "executing") throw new Error("實作進行中。要修改計畫請先由使用者 /plan revise。");
      const a = p.plan.active ? await p.store.update(p.plan.state.artifactId!, () => params.content, p.plan.state.revision) : await p.store.create(params.content, params.title);
      if (p.plan.active) await p.plan.submit();
      if (ctx.hasUI) setPending(a.record.id);
      await open(a, ctx); loadout(); status(ctx);
      const next = p.plan.active ? "The user may keep discussing, /plan review (optional), or /plan approve to approve and start implementation." : "Review with /artifact.";
      return { ...text(`Artifact created: ${a.record.id}\nSTOP: End your turn now. ${next} Saving/review is not execution authorization.`, { artifactId: a.record.id, revision: a.revision }), terminate: true };
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
      return { ...text(`Plan ${p.plan.state.artifactId} submitted. End this turn. The user may keep discussing, run /plan review (optional), or /plan approve to approve and start implementation.`, { artifactId: p.plan.state.artifactId, revision: p.plan.state.revision }), terminate: true };
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
  const short = (revision?: string) => revision?.slice(0, 8) ?? "?";
  // Subcommands, their purpose, and why each is unavailable in the current phase (undefined = available).
  const SUBCOMMANDS: Array<{ name: string; description: string; blocked: () => string | undefined }> = [
    { name: "status", description: "顯示目前階段與用法", blocked: () => undefined },
    { name: "show", description: "重新開啟右側計畫文件", blocked: () => plan?.active ? undefined : "沒有進行中的計畫" },
    { name: "review", description: "選用：由主模型呼叫 subagent 審查目前版本，不是執行授權", blocked: () => !plan?.active ? "沒有進行中的計畫" : plan.state.phase === "executing" ? "實作進行中" : plan.state.phase === "done" ? "計畫已完成" : !pi.getActiveTools().includes("subagent") ? "subagent 工具未啟用" : undefined },
    { name: "approve", description: "核准目前已儲存的版本並立即開始實作", blocked: () => !plan?.active ? "沒有進行中的計畫" : ["planning", "review"].includes(plan.state.phase) ? (pane.dirty ? "右側有未儲存編輯" : undefined) : plan.state.phase === "executing" ? "已在實作中" : "計畫已完成" },
    { name: "revise", description: "回到規劃，撤銷執行授權", blocked: () => plan?.active ? undefined : "沒有進行中的計畫" },
    { name: "done", description: "標記實作完成，再次封鎖寫入", blocked: () => plan?.state.phase === "executing" ? undefined : plan?.state.phase === "done" ? "計畫已完成，要再實作請先 /plan revise" : "沒有正在實作的計畫" },
    { name: "off", description: "退出 Plan Mode 並恢復原本工具權限", blocked: () => plan?.active ? undefined : "沒有進行中的計畫" },
    { name: "use", description: "<artifact-id> 以既有 artifact 開始規劃", blocked: () => plan?.active ? "已有進行中的計畫" : undefined },
  ];
  const usage = () => [
    plan?.active ? `目前：PLAN ${plan.state.phase} · ${plan.state.artifactId} · rev ${short(plan.state.revision)}${plan.state.phase === "executing" ? "（已核准實作）" : "（尚未允許實作）"}` : "目前：未在 Plan Mode",
    "/plan <目標>　開始規劃",
    ...SUBCOMMANDS.map(c => `/plan ${c.name}　${c.description}${c.blocked() ? `（不可用：${c.blocked()}）` : ""}`),
  ].join("\n");
  const start = async (a: Artifact, goal: string | undefined, ctx: ExtensionCommandContext) => {
    const p = ensure(ctx);
    await p.plan.enter(a.record.id, pi.getActiveTools()); if (pending) setPending(); await open(a, ctx);
    loadout(); status(ctx);
    ctx.ui.notify(`已開始規劃 ${a.record.id}。模型會探索並修改同一份計畫，尚未允許實作。subagent 可直接呼叫，子代理權限未受 Plan Mode 限制。下一步：繼續討論，或 /plan review（選用）、/plan approve 核准並開始實作。`, "info");
    pi.sendUserMessage(`Plan Mode enabled for ${a.record.id}. ${goal ?? "Use the conversation's requirements."} Explore and revise this SAME artifact. Do not implement. Submit with request_plan_review when ready.`);
  };
  pi.registerCommand("plan", {
    description: "Plan Mode：/plan <目標> 開始規劃 · review 選用審查 · approve 核准並執行 · off 退出",
    getArgumentCompletions: prefix => {
      // Free-form goal text is never forced into a subcommand.
      if (/\s/.test(prefix)) return null;
      const items = SUBCOMMANDS.filter(c => c.name.startsWith(prefix)).map(c => {
        const reason = c.blocked();
        return { value: c.name, label: c.name, description: reason ? `${c.description}（目前不可用：${reason}）` : c.description };
      });
      return items.length ? items : null;
    },
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (commandBusy) { ctx.ui.notify("另一個 artifact/plan 指令正在執行，請稍候。", "warning"); return; }
      commandBusy = true;
      try {
        const p = ensure(ctx), raw = args.trim(), [first = "", ...rest] = raw.split(/\s+/), value = rest.join(" ");
        // Reserved words are subcommands only when bare (or `use <id>`); anything else is a goal.
        const action = !raw ? "status" : first === "on" ? "on" : first === "use" && rest.length === 1 ? "use" : !rest.length && SUBCOMMANDS.some(c => c.name === first) || raw === "execute" ? first : "goal";
        if (action === "status") { ctx.ui.notify(usage(), "info"); return; }
        if (action === "use" && !value) throw new Error("用法：/plan use <artifact-id>");
        if (action === "on") throw new Error("/plan on 已移除。直接用 /plan <目標> 開始規劃。");
        if (action === "execute") throw new Error("/plan execute 已移除。用 /plan approve 核准目前版本並立即開始實作。");
        if (action === "show") { if (!p.plan.state.artifactId) throw new Error("沒有進行中的計畫。先用 /plan <目標> 開始規劃。"); await open(await p.store.read(p.plan.state.artifactId), ctx); return; }
        if (action === "off" && !p.plan.active) { ctx.ui.notify("目前不在 Plan Mode，沒有需要退出的計畫。", "info"); return; }
        idle(ctx);
        if (action === "goal" || action === "use") {
          if (p.plan.active) throw new Error(`已有進行中的計畫${p.plan.state.artifactId ? ` ${p.plan.state.artifactId}` : "（狀態損毀）"}。用 /plan off 退出後再開始新計畫。`);
          const goal = action === "goal" ? raw : undefined;
          await start(action === "use" ? await p.store.resolve(value) : await p.store.create(`# Plan\n\n## Goal\n${goal}\n\n## Approach\n\n## Verification\n\n## Not doing\n`, goal), goal, ctx);
        } else if (action === "off") {
          if (!(await ctx.ui.confirm("退出 Plan Mode？", "將移除規劃限制並恢復原本的工具權限。計畫不會被核准或執行。"))) { ctx.ui.notify("已取消，仍在 Plan Mode。", "info"); return; }
          const tools = p.plan.off(); if (tools) pi.setActiveTools(tools); status(ctx);
          ctx.ui.notify(tools ? "已退出 Plan Mode，已恢復原本的工具權限。計畫未被核准或執行。" : "已退出 Plan Mode，但找不到原本的工具清單（狀態損毀），工具未還原。用 /reload 重新載入。計畫未被核准或執行。", tools ? "info" : "warning");
        } else if (action === "review") {
          if (!pi.getActiveTools().includes("subagent")) throw new Error("subagent 工具未啟用，無法委派審查。請先安裝或啟用 subagent extension；也可略過審查，直接 /plan approve。");
          await p.plan.submit(); if (pending) setPending(); loadout(); status(ctx);
          const { artifactId, revision } = p.plan.state;
          const snapshot = resolve(p.store.root, "revisions", artifactId!, `${revision}.md`);
          ctx.ui.notify(`已提交 rev ${short(revision)}，將由主模型呼叫 subagent 審查。審查不是執行授權，可繼續提問與修改；修改後會回到規劃。子代理權限未受 Plan Mode 限制。`, "info");
          pi.sendUserMessage([
            `Plan review requested: ${artifactId}, exact revision ${revision}.`,
            `Main agent: call subagent directly now, in foreground, using spec-reviewer (or another available review agent). Return its findings and your concise summary to this conversation. Do not open the manual /artifact line-review UI.`,
            `Give the child a self-contained brief: review only the immutable plan snapshot at ${JSON.stringify(snapshot)}. Cwd: ${JSON.stringify(ctx.cwd)}. Read that snapshot and relevant repository files to check feasibility, scope, missing requirements, risks and verification. Report findings with severity and locations, and label the result with revision ${revision}. Do not modify files, run shells or delegate again. These are task instructions, NOT a Plan Mode tool restriction on the child.`,
            `The main agent must read_artifact after the child returns and compare its current revision to ${revision}. If it changed, label the result stale; do not treat the old review as passing the new plan. A positive review never approves or starts implementation. If delegation fails, report the failure without fabricating a review. Continue Q&A or revisions, and wait for the user's /plan approve before implementation.`,
          ].join("\n"));
        } else if (action === "approve") {
          if (ctx.mode !== "tui") throw new Error("核准執行需要互動式確認視窗，請在 pi 終端介面中執行 /plan approve。");
          await p.plan.sync(); const revision = p.plan.state.revision;
          if (!["planning", "review"].includes(p.plan.state.phase) || !revision) throw new Error(p.plan.state.phase === "executing" ? "這個版本已在實作中。" : p.plan.state.phase === "done" ? "計畫已完成。要再實作請先 /plan revise。" : "沒有可核准的計畫。先用 /plan <目標> 開始規劃。");
          const a = await p.store.read(p.plan.state.artifactId!); await open(a, ctx);
          const ok = await ctx.ui.confirm("核准並開始實作？", `${a.record.id}\nSHA-256 ${revision}\n確認後立即開始實作這個確切版本，並開放主模型的專案寫入、shell 指令與 workflow 等委派。subagent 已可呼叫，其子代理權限未受 Plan Mode 限制。計畫之後若變更，授權會自動撤銷。`);
          if (!ok) { ctx.ui.notify("已取消核准，仍在規劃中，尚未允許實作。", "info"); return; }
          // The draft or the file may have changed while the dialog was open.
          idle(ctx); await p.plan.approve(revision); if (pending) setPending(); loadout(); status(ctx);
          ctx.ui.notify(`已核准 rev ${short(revision)} 並開始實作。計畫變更會自動撤銷授權；完成後用 /plan done，或 /plan off 退出。`, "info");
          pi.sendUserMessage(`Execute approved plan ${p.plan.state.artifactId}, exact revision ${revision}. Read it with read_artifact. Reuse existing tasks, set_verify, and reviewers. Do not silently broaden scope. If the plan changes, return to planning and obtain a fresh approval.`);
        } else if (action === "revise") {
          await p.plan.revise(); if (pending) setPending(); loadout(); status(ctx);
          ctx.ui.notify("已回到規劃模式，可以繼續提問與修改計畫；尚未允許實作", "info");
        } else if (action === "done") {
          p.plan.finish(); loadout(); status(ctx);
          ctx.ui.notify("已標記完成，專案寫入與 shell 再次封鎖。用 /plan off 退出並恢復工具。", "info");
        }
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
    if (reason) return { block: true, reason };
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
