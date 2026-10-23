import type { ArtifactStore } from "./store.ts";

// "approved" is only parsed from older sessions; approval now starts execution in one step.
export type Phase = "off" | "planning" | "review" | "approved" | "executing" | "done";
export interface PlanState {
  v: 1; phase: Phase; artifactId?: string; revision?: string;
  approval?: { revision: string; approvedAt: string }; previousTools?: string[];
}
export const PLAN_ENTRY = "pi-artifact:plan:v1";
const phases: Phase[] = ["off", "planning", "review", "approved", "executing", "done"];
// Explicit user opt-in: child permissions are owned by the subagent extension, not this policy.
const PLAN_DELEGATION_TOOLS = new Set(["subagent", "list_subagents", "subagent_status"]);
export const PLANNING_TOOLS = new Set([
  "read", "grep", "find", "ls", "web_search", "web_fetch", "ask_user_question",
  "read_artifact", "create_artifact", "edit_artifact", "replace_artifact", "request_plan_review",
  "TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "set_verify", "view_context", "self_compact",
]);
const isRef = (s: PlanState) => typeof s.artifactId === "string" && /^art_[\w-]+$/.test(s.artifactId) && typeof s.revision === "string" && /^[a-f0-9]{64}$/.test(s.revision);
export function parseState(value: unknown): PlanState | undefined {
  if (!value || typeof value !== "object") return;
  const s = value as PlanState;
  if (s.v !== 1 || !phases.includes(s.phase) || (s.phase !== "off" && !isRef(s))) return;
  if (["approved", "executing"].includes(s.phase) && (s.approval?.revision !== s.revision || typeof s.approval?.approvedAt !== "string")) return;
  if (s.previousTools && (!Array.isArray(s.previousTools) || s.previousTools.some(x => typeof x !== "string"))) return;
  return structuredClone(s);
}

/** Only user command handlers call approve/execute. No text-matching grants authority. */
export class PlanController {
  state: PlanState = { v: 1, phase: "off" };
  private corrupt = false;
  constructor(readonly store: ArtifactStore, private persist: (state: PlanState) => void) {}
  get active() { return this.corrupt || this.state.phase !== "off"; }
  get restricted() { return this.active && this.state.phase !== "executing"; }
  allowsPlanningTool(tool: string) {
    return PLANNING_TOOLS.has(tool) || (["planning", "review"].includes(this.state.phase) && PLAN_DELEGATION_TOOLS.has(tool));
  }
  private set(state: PlanState) { this.persist(structuredClone(state)); this.state = state; this.corrupt = false; }
  restore(entries: Array<{ type: string; customType?: string; data?: unknown }>) {
    this.state = { v: 1, phase: "off" }; this.corrupt = false;
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== PLAN_ENTRY) continue;
      const state = parseState(entry.data);
      // A corrupt latest plan state must not silently restore an old execution grant.
      if (!state) { this.corrupt = true; this.state = { ...this.state, phase: this.state.artifactId ? "planning" : "off", approval: undefined }; continue; }
      this.state = state; this.corrupt = false;
    }
    // Reload/resume/tree/fork never silently starts or resumes execution; /plan approve must be confirmed again.
    if (this.state.phase === "executing" || this.state.phase === "approved") this.state = { ...this.state, phase: "review", approval: undefined };
  }
  async enter(id: string, tools: string[]) {
    const a = await this.store.read(id);
    if (a.record.status === "abandoned") throw new Error("Cannot plan an abandoned artifact.");
    this.set({ v: 1, phase: "planning", artifactId: id, revision: a.revision, previousTools: this.active ? this.state.previousTools : [...tools] });
  }
  async sync(): Promise<boolean> {
    if (!this.active) return false;
    if (this.corrupt) throw new Error("Corrupt persisted Plan Mode state. Use /plan off, then /plan to recover explicitly.");
    let revision: string;
    try { revision = (await this.store.read(this.state.artifactId!)).revision; }
    catch (error) {
      const phase = this.state.phase === "done" ? "done" : "planning";
      if (this.state.phase !== phase || this.state.approval) this.set({ ...this.state, phase, approval: undefined });
      throw error;
    }
    if (revision === this.state.revision) return false;
    // A finished plan stays done after edits; only /plan revise reopens it.
    this.set({ ...this.state, phase: this.state.phase === "done" ? "done" : "planning", revision, approval: undefined });
    return true;
  }
  async submit() {
    if (!this.active) throw new Error("沒有進行中的計畫。先用 /plan 進入規劃模式。");
    await this.sync();
    if (this.state.phase === "executing") throw new Error("實作進行中。要修改計畫請先 /plan revise。");
    if (this.state.phase === "done") throw new Error("計畫已完成。要再修改請先 /plan revise，或 /plan off 退出。");
    this.set({ ...this.state, phase: "review", approval: undefined });
  }
  /** Approves the exact saved revision and starts execution in one persisted step. Review is optional. */
  async approve(expectedRevision: string) {
    await this.sync();
    if (!["planning", "review"].includes(this.state.phase)) throw new Error(this.state.phase === "executing" ? "這個版本已在實作中。" : this.state.phase === "done" ? "計畫已完成。要再實作請先 /plan revise。" : "沒有可核准的計畫。先用 /plan 進入規劃模式。");
    if (this.state.revision !== expectedRevision) throw new Error("計畫在確認期間已變更，未放行實作。請檢視新版本後再 /plan approve。");
    this.set({ ...this.state, phase: "executing", approval: { revision: expectedRevision, approvedAt: new Date().toISOString() } });
  }
  async revise() {
    if (!this.active) throw new Error("沒有進行中的計畫。先用 /plan 進入規劃模式。");
    await this.sync(); this.set({ ...this.state, phase: "planning", approval: undefined });
  }
  finish() {
    if (this.state.phase !== "executing") throw new Error(this.state.phase === "done" ? "計畫已完成，要再實作請先 /plan revise。" : "沒有正在實作的計畫，無法標記完成。先用 /plan approve 核准並開始實作。");
    this.set({ ...this.state, phase: "done", approval: undefined });
  }
  off() { const tools = this.state.previousTools; this.set({ v: 1, phase: "off" }); return tools; }
  async block(tool: string, input: Record<string, unknown>, dirty = false): Promise<string | undefined> {
    if (!this.active) return;
    try { await this.sync(); } catch (error) { return `Plan unreadable. Execution locked: ${String(error)}`; }
    if (dirty && this.state.phase === "executing") {
      this.set({ ...this.state, phase: "planning", approval: undefined });
    }
    if (!this.restricted) return;
    if (PLAN_DELEGATION_TOOLS.has(tool) && !["planning", "review"].includes(this.state.phase)) return `Plan Mode (${this.state.phase}) blocks ${tool}. Use /plan revise to reopen planning, or /plan off to exit.`;
    if (!this.allowsPlanningTool(tool)) return `Plan Mode (${this.state.phase}) blocks ${tool}. Main-agent shells, arbitrary code, workflows, background jobs, project writes and unknown tools require the user to /plan approve this revision. Subagent child permissions are not restricted by Plan Mode.`;
    if (["edit_artifact", "replace_artifact"].includes(tool) && input.artifactId !== this.state.artifactId) return "Plan Mode may update only its active plan artifact.";
    if (dirty && ["edit_artifact", "replace_artifact", "create_artifact", "request_plan_review"].includes(tool)) return "Unsaved manual plan edits. Save, copy or discard them before a model update or review.";
  }
  prompt(): string {
    if (!this.active) return "";
    if (this.state.phase === "done") return `Plan Mode: done. Active plan ${this.state.artifactId}, revision ${this.state.revision}. Implementation is finished and project writes/shell are blocked again. Edits do not reopen this plan; do not call request_plan_review. Only the user's /plan revise reopens it, or /plan off exits.`;
    return `Plan Mode: ${this.state.phase}. Active plan ${this.state.artifactId}, revision ${this.state.revision}. ${this.state.phase === "executing"
      ? "Implement only this approved revision. Reuse existing task, verification and reviewer tools. Plan content changes revoke permission before the next tool call."
      : "Do not implement project changes or run shells/workflows/codemode. Explore with read/grep/find/ls/web tools, and call subagent directly for exploration or review. Ask child agents not to write or run shells, but do not claim this is enforced: Plan Mode does not restrict child tools or nested delegation. Subagent conclusions never approve or start execution. Summarize findings in the main conversation and label them with the reviewed revision; after edits, old conclusions are stale. Read and update the SAME artifact using read_artifact/edit_artifact/replace_artifact, not a new plan per reply. Keep the **Goal** item under ## 1. Goal and Boundaries updated with the requirements and decisions clarified in discussion; plan reviewers use it as the requirement baseline. Save is not approval. Keep answering questions and revising during review; any edit returns the plan to planning and invalidates earlier review conclusions. When ready call request_plan_review and end your turn. Only the user's /plan approve authorizes execution; it approves this exact revision and starts implementation."}`;
  }
}
