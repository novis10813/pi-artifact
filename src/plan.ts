import type { ArtifactStore } from "./store.ts";

export type Phase = "off" | "planning" | "review" | "approved" | "executing" | "done";
export interface PlanState {
  v: 1; phase: Phase; artifactId?: string; revision?: string;
  approval?: { revision: string; approvedAt: string }; previousTools?: string[];
}
export const PLAN_ENTRY = "pi-artifact:plan:v1";
const phases: Phase[] = ["off", "planning", "review", "approved", "executing", "done"];
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
    // Reload/resume/tree/fork never silently starts or resumes execution.
    if (this.state.phase === "executing") this.state = { ...this.state, phase: "approved" };
  }
  async enter(id: string, tools: string[]) {
    const a = await this.store.read(id);
    if (a.record.status === "abandoned") throw new Error("Cannot plan an abandoned artifact.");
    this.set({ v: 1, phase: "planning", artifactId: id, revision: a.revision, previousTools: this.active ? this.state.previousTools : [...tools] });
  }
  async sync(): Promise<boolean> {
    if (!this.active) return false;
    if (this.corrupt) throw new Error("Corrupt persisted Plan Mode state. Use /plan off or /plan on to recover explicitly.");
    let revision: string;
    try { revision = (await this.store.read(this.state.artifactId!)).revision; }
    catch (error) {
      if (this.state.phase !== "planning" || this.state.approval) this.set({ ...this.state, phase: "planning", approval: undefined });
      throw error;
    }
    if (revision === this.state.revision) return false;
    this.set({ ...this.state, phase: "planning", revision, approval: undefined });
    return true;
  }
  async submit() {
    if (!this.active) throw new Error("Enable /plan on first.");
    await this.sync();
    this.set({ ...this.state, phase: "review", approval: undefined });
  }
  async approve(expectedRevision: string) {
    await this.sync();
    if (this.state.phase !== "review" || this.state.revision !== expectedRevision) throw new Error("Plan changed or is not submitted for review. Review it again.");
    this.set({ ...this.state, phase: "approved", approval: { revision: expectedRevision, approvedAt: new Date().toISOString() } });
  }
  async execute(expectedRevision: string) {
    await this.sync();
    if (this.state.phase !== "approved" || this.state.revision !== expectedRevision || this.state.approval?.revision !== expectedRevision) throw new Error("Current plan revision is not approved. Use /plan review and /plan approve first.");
    this.set({ ...this.state, phase: "executing" });
  }
  async revise() {
    if (!this.active) throw new Error("No active plan.");
    await this.sync(); this.set({ ...this.state, phase: "planning", approval: undefined });
  }
  finish() {
    if (this.state.phase !== "executing") throw new Error("No plan is executing.");
    this.set({ ...this.state, phase: "done" });
  }
  off() { const tools = this.state.previousTools; this.set({ v: 1, phase: "off" }); return tools; }
  async block(tool: string, input: Record<string, unknown>, dirty = false): Promise<string | undefined> {
    if (!this.active) return;
    try { await this.sync(); } catch (error) { return `Plan unreadable. Execution locked: ${String(error)}`; }
    if (dirty && this.state.phase === "executing") {
      this.set({ ...this.state, phase: "planning", approval: undefined });
    }
    if (!this.restricted) return;
    if (!PLANNING_TOOLS.has(tool)) return `Plan Mode (${this.state.phase}) blocks ${tool}. Shells, arbitrary code, delegation, background jobs, project writes and unknown tools require an approved revision and /plan execute.`;
    if (["edit_artifact", "replace_artifact"].includes(tool) && input.artifactId !== this.state.artifactId) return "Plan Mode may update only its active plan artifact.";
    if (dirty && ["edit_artifact", "replace_artifact", "create_artifact", "request_plan_review"].includes(tool)) return "Unsaved manual plan edits. Save, copy or discard them before a model update or review.";
    if (this.state.phase === "review" && !["read", "read_artifact", "view_context", "self_compact"].includes(tool)) return "Plan is awaiting user review. Stop this turn. Only explicit /plan revise resumes editing, and /plan approve then /plan execute authorizes work.";
  }
  prompt(): string {
    if (!this.active) return "";
    return `Plan Mode: ${this.state.phase}. Active plan ${this.state.artifactId}, revision ${this.state.revision}. ${this.state.phase === "executing"
      ? "Implement only this approved revision. Reuse existing task, verification and reviewer tools. Plan content changes revoke permission before the next tool call."
      : "Do not implement project changes or run shells/delegation/codemode. Explore with read/grep/find/ls/web tools. Read and update the SAME artifact using read_artifact/edit_artifact/replace_artifact, not a new plan per reply. Save is not approval. When ready call request_plan_review and end your turn. Only user /plan approve followed by /plan execute authorizes execution."}`;
  }
}
