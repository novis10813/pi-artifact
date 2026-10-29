import { resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import installPane from "./pane-controller.ts";
import { ArtifactStore, exactEdits, progressOf, type Artifact, type ArtifactRecord } from "./store.ts";
import { PlanController, PLAN_ENTRY } from "./plan.ts";

const PENDING_ENTRY = "pi-artifact:pending:v1";
// Agent definitions live in the user's subagent directory, not in this package.
const PLAN_REVIEWERS = [
  ["logic-reviewer", "requirements and logic"],
  ["system-reviewer", "existing system integration"],
  ["scope-reviewer", "scope and design necessity"],
  ["execution-reviewer", "execution and handoff"],
  ["verification-reviewer", "acceptance and regression"],
] as const;
// Plan reviewers and the approve prompt refer to these section names.
const planTemplate = () => `# <Feature name> Spec

> Replace the content in angle brackets and delete items that do not apply.
> A work unit describes an acceptable outcome; it is not the same as one agent call.

## 1. Goal and Boundaries

- **Goal:** <What this change should accomplish>
- **In scope:** <What this change includes>
- **Not doing:** <What this change explicitly excludes>

## 2. Context and Required Decisions

- **Current state:** <Relevant modules, interfaces and behavior, with code locations>
- **Required decisions:** <Design and compatibility constraints the implementation must follow; separate existing facts from new design>
- **Open questions:** <Questions that affect scope or design; resolve them before implementation, do not leave them for a worker to guess>

## 3. Requirements and Acceptance

| Requirement | Expected behavior | Acceptance scenario and pass condition |
| ----------- | ----------------- | -------------------------------------- |
| R1 | <Behavior in the normal case> | <Input, action and expected result> |
| R2 | <Failure case, or existing behavior that must remain> | <Error result or regression check> |

## 4. Work Units

### W1｜<Name of the acceptable outcome>

- **Outcome:** <What is delivered and which requirements it covers>
- **Inputs and constraints:** <Required context, files, interfaces and decided design>
- **Change scope:** <Which modules are expected to change, and what must not change>
- **Dependencies and handoff:** <Which output of which unit is needed; which interface or outcome is handed to later units. Write "None" if there are no dependencies>
- **Acceptance:** <Test location, executable and arguments (run without a shell), and expected result>
- **Handoff and stop:** <Which changes and evidence to report; which problems require stopping to ask>

<!-- Copy the format above for later units, numbered W2, W3. -->

## 5. Execution and Completion

- **Layers:** <Layer 1: W1, W2. Layer 2: W3 (needs W1). Units in a layer run in parallel; list files or interfaces that two units in one layer both change>
- **Boundaries:**
  - Always: <Actions a worker takes without asking>
  - Ask first: <Actions that pause the workflow for user approval>
  - Never: <Actions that stop the unit>
- **Overall verification:** <Command run after each merge and its pass condition; manual checks before shipping>
`;
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
    pi.setActiveTools(plan.restricted ? [...new Set([...previous.filter(x => plan!.allowsPlanningTool(x)), "read_artifact", "edit_artifact", "replace_artifact", "request_plan_review"])] : previous);
  };
  const pane = installPane(pi, async ctx => {
    // Reading records a saved/external content change even outside Plan Mode.
    const record = await paneRecord();
    if (record) await store!.read(record.id);
    if (plan?.active) { await plan.sync(); loadout(); status(ctx); }
  }, () => plan?.active ? `PLAN ${plan.state.phase}` : "");
  const paneRecord = async () => {
    if (!pane.document || !store) return undefined;
    // DocumentSession resolves symlinks; compare canonical targets rather than display paths.
    const records = await store.list();
    for (const record of records) {
      if (record.status === "abandoned") continue;
      try { if (await store.filePath(record.id) === pane.document.path) return record; } catch { /* stale entry */ }
    }
  };
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
          await pane.open(await p.store.filePath(p.plan.state.artifactId), ctx);
        } catch (error) { ctx.ui.notify(`Plan retained without pane: ${errorText(error)}`, "warning"); }
      }
    }
    status(ctx);
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  const setPending = (id?: string) => { pi.appendEntry(PENDING_ENTRY, id ?? null); pending = id; };
  const open = async (a: Artifact, ctx: ExtensionContext, reveal = false) => {
    if (ctx.mode !== "tui") return;
    try { await pane.open(await store!.filePath(a.record.id), ctx, reveal); }
    catch (error) { ctx.ui.notify(`Artifact saved, pane unavailable: ${errorText(error)}`, "warning"); }
  };
  const idle = (ctx: ExtensionContext) => {
    if (!ctx.isIdle()) throw new Error("模型仍在回應。等它結束或先中斷（Esc），再執行這個指令。");
    if (pane.busy || pane.dirty) throw new Error("右側有未儲存編輯或文件 I/O。先 /plan save 儲存，或用 /plan open 處理草稿，再變更 Plan Mode 狀態。");
  };
  const guardDraft = (id: string) => {
    // Conservatively protect every visible dirty draft, including one opened by path.
    if (pane.dirty) throw new Error(`Unsaved manual draft. Save/copy/discard before updating ${id}.`);
  };
  pi.registerTool({
    name: "create_artifact", label: "Create Artifact",
    description: "Create a local artifact, or update the SAME active Plan Mode document. End your turn so the user can inspect or edit the document in the right pane. Saving is not execution approval.",
    promptSnippet: "Use artifact tools for reviewable plan/spec/report documents. Read/edit/replace the existing artifact for revisions, not a new artifact per reply.",
    promptGuidelines: ["Pass full Markdown content, not a path or summary.", "After create_artifact succeeds, stop this turn for user feedback. Opening or saving an artifact never authorizes implementation."],
    parameters: Type.Object({ content: Type.String({ description: "Full artifact content" }), title: Type.Optional(Type.String({ description: "Accepted for compatibility; not written into document content" })) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = ensure(ctx); guardDraft(p.plan.state.artifactId ?? "new artifact");
      // During implementation the approved document must not be silently replaced.
      if (p.plan.state.phase === "executing") throw new Error("實作進行中。要修改計畫請先由使用者 /plan revise。");
      if (p.plan.state.phase === "done") throw new Error("計畫已完成。要重新提交請先由使用者 /plan revise。");
      const a = p.plan.active ? await p.store.update(p.plan.state.artifactId!, () => params.content, p.plan.state.revision) : await p.store.create(params.content, params.title);
      if (p.plan.active) await p.plan.submit();
      if (ctx.hasUI) setPending(a.record.id);
      await open(a, ctx); loadout(); status(ctx);
      const next = p.plan.active ? "The user may keep discussing, /plan review (optional), or /plan approve to approve and start implementation." : "The user can inspect/edit the right pane, or reopen with /plan list, and continue in chat.";
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
      const revision = params.revision ?? a.revision;
      const content = params.revision !== undefined ? await p.store.revision(params.artifactId, revision) : a.content;
      return text(`Artifact ${a.record.id}\nRevision: ${revision}\n\n${content}`, { artifactId: a.record.id, revision, status: a.record.status });
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
  const progressLabel = (a: ArtifactRecord) => ({ discussing: "討論中", reviewing: "審查中", implementing: "實作中", done: "已完成" })[progressOf(a)];
  const requireIdle = (ctx: ExtensionContext) => {
    if (!ctx.isIdle()) throw new Error("模型仍在回應。等它結束或先中斷（Esc），再執行這個指令。");
    if (pane.busy) throw new Error("文件 I/O 進行中，請稍後再試。");
  };
  const resolveDraft = async (ctx: ExtensionContext): Promise<boolean> => {
    requireIdle(ctx);
    if (!pane.dirty) return true;
    const choice = await ctx.ui.select("右側有未儲存修改", ["儲存", "放棄修改", "取消"]);
    requireIdle(ctx);
    if (choice === "儲存") return pane.save();
    if (choice === "放棄修改") { pane.discardDraft(); return true; }
    return false;
  };
  const openArtifact = async (id: string, ctx: ExtensionContext) => {
    requireIdle(ctx);
    if (ctx.mode !== "tui") throw new Error("開啟 artifact 需要互動式 fullscreen 介面。");
    const path = await store!.filePath(id);
    // Reopening the same artifact also lets the user explicitly abandon an unsaved draft.
    if (!(await resolveDraft(ctx))) return;
    await pane.open(path, ctx, true); await pane.refresh();
    if (pending === id) setPending();
    status(ctx);
  };
  const discardArtifact = async (record: ArtifactRecord, ctx: ExtensionContext) => {
    requireIdle(ctx);
    const current = await paneRecord(), isOpen = current?.id === record.id;
    const active = plan!.active && plan!.state.artifactId === record.id;
    const warning = `${record.path}\n只從清單移除，保留文件與歷史版本。${isOpen && pane.dirty ? "\n目前未儲存的修改會被放棄。" : ""}${active ? "\n此文件是目前計畫，將退出 Plan Mode 並恢復原本工具權限，不會核准或執行計畫。" : ""}`;
    if (!(await ctx.ui.confirm("移除 artifact？", warning))) return;
    requireIdle(ctx);
    await store!.abandon(record.id);
    if (isOpen) pane.discardDraft();
    if (active) { const tools = plan!.off(); if (tools) pi.setActiveTools(tools); }
    if (pending === record.id) setPending();
    status(ctx); ctx.ui.notify("Artifact 已從清單移除，文件與歷史版本保留。", "info");
  };
  const listArtifacts = async (ctx: ExtensionCommandContext) => {
    requireIdle(ctx);
    if (ctx.mode !== "tui") throw new Error("Artifact 清單需要互動式終端介面。");
    let completed = false;
    while (true) {
      const rows = (await store!.list()).filter(a => a.status !== "abandoned" && (progressOf(a) === "done") === completed).reverse();
      const labels = rows.map(a => `${progressLabel(a)} · ${a.path}`);
      const toggle = completed ? "顯示未完成" : "顯示已完成";
      const choice = await ctx.ui.select(completed ? "已完成的 artifacts" : "未完成的 artifacts", [...labels, toggle]);
      if (choice === undefined) return;
      if (choice === toggle) { completed = !completed; continue; }
      const record = rows[labels.indexOf(choice)];
      if (!record) return;
      const action = await ctx.ui.select(record.path, ["開啟", "設為目前計畫", ...(completed ? [] : ["標記完成"]), "刪除"]);
      if (action === undefined) continue;
      requireIdle(ctx);
      if (action === "刪除") { await discardArtifact(record, ctx); continue; }
      if (action === "開啟") { await openArtifact(record.id, ctx); return; }
      if (action === "設為目前計畫") {
        if (plan!.active) throw new Error("已有進行中的計畫。先 /plan off 退出，再設定另一份計畫。");
        if (!(await resolveDraft(ctx))) continue;
        await start(await store!.read(record.id), ctx); return;
      }
      if (action === "標記完成") {
        idle(ctx);
        if (plan!.active && plan!.state.artifactId === record.id) await plan!.finish();
        else await store!.setProgress(record.id, "done");
        loadout(); status(ctx);
      }
    }
  };
  const short = (revision?: string) => revision?.slice(0, 8) ?? "?";
  // Subcommands, their purpose, and why each is unavailable in the current phase (undefined = available).
  const SUBCOMMANDS: Array<{ name: string; description: string; blocked: () => string | undefined }> = [
    { name: "status", description: "顯示目前階段與用法", blocked: () => undefined },
    { name: "list", description: "從清單開啟、完成或移除 artifact", blocked: () => undefined },
    { name: "open", description: "<artifact-path> 開啟清單中的文件，Tab 補完路徑", blocked: () => undefined },
    { name: "toggle", description: "收起／展開右側文件，保留草稿", blocked: () => pane.document ? undefined : "沒有開啟的文件" },
    { name: "save", description: "儲存右側草稿", blocked: () => pane.document ? undefined : "沒有開啟的文件" },
    { name: "copy", description: "<path> 將草稿另存成新檔", blocked: () => pane.document ? undefined : "沒有開啟的文件" },
    { name: "discard", description: "移除目前右側顯示的 artifact，保留檔案", blocked: () => pane.visible ? undefined : "右側沒有顯示文件，不會刪除" },
    { name: "review", description: "選用：由主模型呼叫 subagent 審查目前版本，不是執行授權", blocked: () => !plan?.active ? "沒有進行中的計畫" : plan.state.phase === "executing" ? "實作進行中" : plan.state.phase === "done" ? "計畫已完成" : !pi.getActiveTools().includes("subagent") ? "subagent 工具未啟用" : undefined },
    { name: "approve", description: "核准目前已儲存的版本並立即開始實作", blocked: () => !plan?.active ? "沒有進行中的計畫" : ["planning", "review"].includes(plan.state.phase) ? (pane.dirty ? "右側有未儲存編輯" : undefined) : plan.state.phase === "executing" ? "已在實作中" : "計畫已完成" },
    { name: "revise", description: "回到規劃，撤銷執行授權", blocked: () => plan?.active ? undefined : "沒有進行中的計畫" },
    { name: "done", description: "標記目前計畫或討論文件完成", blocked: () => plan?.active || pane.document ? undefined : "沒有目前計畫或開啟的文件" },
    { name: "off", description: "退出 Plan Mode 並恢復原本工具權限", blocked: () => plan?.active ? undefined : "沒有進行中的計畫" },
  ];
  const usage = () => [
    plan?.active ? `目前：PLAN ${plan.state.phase} · ${plan.state.artifactId} · rev ${short(plan.state.revision)}${plan.state.phase === "executing" ? "（已核准實作）" : "（尚未允許實作）"}` : "目前：未在 Plan Mode",
    "/plan　進入規劃模式，再於對話輸入指示",
    ...SUBCOMMANDS.map(c => `/plan ${c.name}　${c.description}${c.blocked() ? `（不可用：${c.blocked()}）` : ""}`),
  ].join("\n");
  const start = async (a: Artifact, ctx: ExtensionCommandContext) => {
    const p = ensure(ctx);
    await p.plan.enter(a.record.id, pi.getActiveTools()); if (pending) setPending(); await open(a, ctx, true);
    loadout(); status(ctx);
    ctx.ui.notify(`已進入規劃模式 ${a.record.id}。請在接下來的對話輸入規劃指示，尚未允許實作。subagent 可直接呼叫，子代理權限未受 Plan Mode 限制。`, "info");
  };
  pi.registerCommand("plan", {
    description: "Plan Mode：/plan 進入規劃模式 · review 選用審查 · approve 核准並執行 · off 退出",
    getArgumentCompletions: async prefix => {
      const match = prefix.match(/^open\s+([\s\S]*)$/);
      if (match) {
        if (!store) return null;
        const fragment = match[1].replace(/^\.\//, "");
        const rows = (await store.list()).filter(a => a.status !== "abandoned" && progressOf(a) !== "done" && a.path.startsWith(fragment));
        return rows.length ? rows.map(a => ({ value: `open ${a.path}`, label: a.path, description: progressLabel(a) })) : null;
      }
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
        const p = ensure(ctx), raw = args.trim(), [first = "", ...rest] = raw.split(/\s+/), value = raw.slice(first.length).trim();
        const action = !raw ? (p.plan.active ? "status" : "start") : first === "on" ? "on" : ["open", "copy"].includes(first) || !rest.length && SUBCOMMANDS.some(c => c.name === first) || raw === "execute" ? first : "invalid";
        if (action === "invalid") throw new Error("用 /plan 進入規劃模式，再於對話輸入指示。子指令請見 /plan status。");
        if (action === "status") {
          if (p.plan.active) { await p.plan.sync(); loadout(); }
          const record = p.plan.state.artifactId ? (await p.store.read(p.plan.state.artifactId)).record : await paneRecord();
          ctx.ui.notify(`${usage()}${record ? `\n文件：${record.path} · ${progressLabel(record)}` : ""}`, "info"); return;
        }
        if (["open", "copy"].includes(action) && !value) throw new Error(`用法：/plan ${action} <path>`);
        if (action === "on") throw new Error("/plan on 已移除。直接用 /plan 進入規劃模式。");
        if (action === "execute") throw new Error("/plan execute 已移除。用 /plan approve 核准目前版本並立即開始實作。");
        if (action === "list") { await listArtifacts(ctx); return; }
        if (action === "open") { await openArtifact((await p.store.resolve(value)).record.id, ctx); return; }
        if (action === "toggle") { pane.toggle(ctx); return; }
        if (action === "save") { requireIdle(ctx); if (!pane.document) throw new Error("沒有開啟的文件。"); await pane.save(); return; }
        if (action === "copy") {
          requireIdle(ctx); if (!pane.document) throw new Error("沒有開啟的文件。");
          const target = resolve(ctx.cwd, value); await pane.document.saveCopy(target);
          ctx.ui.notify(`Draft copy saved: ${target}`, "info"); return;
        }
        if (action === "discard") {
          if (!pane.visible) { ctx.ui.notify("右側沒有顯示 artifact，不會刪除。", "info"); return; }
          const record = await paneRecord();
          if (record) await discardArtifact(record, ctx);
          return;
        }
        if (action === "off" && !p.plan.active) { ctx.ui.notify("目前不在 Plan Mode，沒有需要退出的計畫。", "info"); return; }
        idle(ctx);
        if (action === "start") {
          if (p.plan.active) throw new Error(`已有進行中的計畫${p.plan.state.artifactId ? ` ${p.plan.state.artifactId}` : "（狀態損毀）"}。用 /plan off 退出後再開始新計畫。`);
          await start(await p.store.create(planTemplate()), ctx);
        } else if (action === "off") {
          if (!(await ctx.ui.confirm("退出 Plan Mode？", "將移除規劃限制並恢復原本的工具權限。計畫不會被核准或執行。"))) { ctx.ui.notify("已取消，仍在 Plan Mode。", "info"); return; }
          const tools = p.plan.off(); if (tools) pi.setActiveTools(tools); status(ctx);
          ctx.ui.notify(tools ? "已退出 Plan Mode，已恢復原本的工具權限。計畫未被核准或執行。" : "已退出 Plan Mode，但找不到原本的工具清單（狀態損毀），工具未還原。用 /reload 重新載入。計畫未被核准或執行。", tools ? "info" : "warning");
        } else if (action === "review") {
          if (["planning", "review"].includes(p.plan.state.phase) && !pi.getActiveTools().includes("subagent")) throw new Error("subagent 工具未啟用，無法委派審查。請先安裝或啟用 subagent extension；也可略過審查，直接 /plan approve。");
          await p.plan.submit(); if (pending) setPending(); loadout(); status(ctx);
          const { artifactId, revision } = p.plan.state;
          const snapshot = resolve(p.store.root, "revisions", artifactId!, `${revision}.md`);
          ctx.ui.notify(`已提交 rev ${short(revision)}，將由主模型呼叫 subagent 審查。審查不是執行授權，可繼續提問與修改；修改後會回到規劃。子代理權限未受 Plan Mode 限制。`, "info");
          pi.sendUserMessage([
            `Plan review requested: ${artifactId}, exact revision ${revision}.`,
            `Main agent: call subagent directly now, in foreground, once for each of these five plan reviewers: ${PLAN_REVIEWERS.map(([agent, lane]) => `${agent} (${lane})`).join(", ")}. Use separate calls; they need not run concurrently. Report findings in chat only; do not write line-comment review records.`,
            `Give every child the same self-contained brief: review only the immutable plan snapshot at ${JSON.stringify(snapshot)}, revision ${revision}. Cwd: ${JSON.stringify(ctx.cwd)}. The requirement baseline is the **Goal** item under the snapshot's ## 1. Goal and Boundaries, maintained by the main agent; if it is missing or empty, the reviewer must say requirement coverage was not checked. Do not ask for a fixed number of findings. Do not modify files, run shells or delegate again. These are task instructions, NOT a Plan Mode tool restriction on the child.`,
            `After all five return, read_artifact and compare its current revision to ${revision}. Report one section per lane, each labeled with revision ${revision} and one status: the reviewer's verdict (NO ISSUES, ISSUES or UNVERIFIED), FAILED if the call failed or returned no report, or STALE for every lane if the revision changed; do not treat a stale review as passing the new plan. Keep each reviewer's Issues and Needs confirmation items separate. If some reviewers fail, still report the others and list the failed lanes with the reason; do not retry automatically or fabricate a review.`,
            `Do not edit the plan in response to findings unless the user asks. A positive review never approves or starts implementation. Continue Q&A or revisions, and wait for the user's /plan approve before implementation.`,
          ].join("\n"));
        } else if (action === "approve") {
          if (ctx.mode !== "tui") throw new Error("核准執行需要互動式確認視窗，請在 pi 終端介面中執行 /plan approve。");
          await p.plan.sync(); const revision = p.plan.state.revision;
          if (!["planning", "review"].includes(p.plan.state.phase) || !revision) throw new Error(p.plan.state.phase === "executing" ? "這個版本已在實作中。" : p.plan.state.phase === "done" ? "計畫已完成。要再實作請先 /plan revise。" : "沒有可核准的計畫。先用 /plan 進入規劃模式。");
          const a = await p.store.read(p.plan.state.artifactId!); await open(a, ctx);
          const ok = await ctx.ui.confirm("核准並開始實作？", `${a.record.id}\nSHA-256 ${revision}\n確認後立即開始實作這個確切版本，並開放主模型的專案寫入、shell 指令與 workflow 等委派。subagent 已可呼叫，其子代理權限未受 Plan Mode 限制。計畫之後若變更，授權會自動撤銷。`);
          if (!ok) { ctx.ui.notify("已取消核准，仍在規劃中，尚未允許實作。", "info"); return; }
          // The draft or the file may have changed while the dialog was open.
          idle(ctx); await p.plan.approve(revision); if (pending) setPending(); loadout(); status(ctx);
          ctx.ui.notify(`已核准 rev ${short(revision)} 並開始實作。計畫變更會自動撤銷授權；完成後用 /plan done，或 /plan off 退出。`, "info");
          pi.sendUserMessage([
            `Execute approved plan ${p.plan.state.artifactId}, exact revision ${revision}. Read it with read_artifact. Write one workflow script from it and run it in the background. If the git working tree has uncommitted changes, stop and ask the user first.`,
            `1. Branches: create integration branch plan/${short(revision)} in its own worktree. For each §5 layer, create one worktree per unit from the integration branch with runCheck (git worktree add); worktree creation must be safe to rerun on resume. Run a layer's units with parallel().`,
            `2. Units: label every call with the unit id (W1, W2…) and run every agent and check of a unit with cwd set to its worktree. Build gets only §1, the unit's §4 entry and §5 Boundaries; there is no planner. Then repairUntilPass: checks = the unit's Acceptance command; reviewers = agentType spec-reviewer (against the unit) and code-reviewer; repair = Build with the failure report.`,
            `3. Commits: Build, every repair and the merge agent commit their changes before returning, without a co-author trailer. Every check, including each repairUntilPass round and each Overall verification, first runs runCheck with command "sh" and args ["-c", 'test -z "$(git status --porcelain)"'] in that worktree, so uncommitted work fails.`,
            `4. Merge: after a layer passes, a merge agent in the integration worktree merges its unit branches, resolves conflicts from the plan, then runCheck the §5 Overall verification. The next layer branches from that result.`,
            `5. Boundaries: Ask first → checkpoint(..., { headless: "abort" }); when it stops the run, ask the user, then continue with resumeFromRunId. Never → stop.`,
            `6. Stop: if repairs run out, a check errors, or scope, a key design or acceptance would have to change, stop and report. Do not improvise; return to planning and obtain a fresh approval.`,
            `7. Report: per requirement (R1, R2…) its acceptance result, plus the integration branch, test output and remaining limits. Do not merge into the user's branch or edit the approved plan; wait for the user.`,
          ].join("\n"));
        } else if (action === "revise") {
          await p.plan.revise(); if (pending) setPending(); loadout(); status(ctx);
          ctx.ui.notify("已回到規劃模式，可以繼續提問與修改計畫；尚未允許實作", "info");
        } else if (action === "done") {
          if (p.plan.active) await p.plan.finish();
          else {
            const record = await paneRecord();
            if (!record) throw new Error("沒有目前計畫或開啟的文件。");
            await p.store.setProgress(record.id, "done");
          }
          loadout(); status(ctx);
          ctx.ui.notify(p.plan.active ? "已標記完成，專案寫入與 shell 再次封鎖。用 /plan off 退出並恢復工具。" : "已標記完成，從未完成清單隱藏。", "info");
        }
      } catch (error) { ctx.ui.notify(errorText(error), "error"); }
      finally { commandBusy = false; }
    },
  });
  pi.on("input", () => { if (pending) setPending(); });
  pi.on("tool_call", async (event, ctx) => {
    const p = ensure(ctx);
    if (pending && ctx.hasUI) return { block: true, terminate: true, reason: `Artifact ${pending} is awaiting user feedback. End this turn. Inspect/edit the right pane or use /plan list, then continue in chat.` };
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
