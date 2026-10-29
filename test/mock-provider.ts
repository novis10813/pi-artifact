/** Test fixture only. No network transport. Never exposed by the package manifest. */
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let step = 0, calls = 0, reviewStep = 0;
  const log = (value: unknown) => appendFile("probe.jsonl", JSON.stringify(value) + "\n");
  pi.registerTool({ name: "test_write", label: "Unsafe test probe", description: "Test nested permission interception", exposure: "codemode", parameters: Type.Object({}),
    async execute() { await writeFile("denied-nested.txt", "BUG"); return { content: [{ type: "text", text: "BUG" }], details: undefined }; },
  });
  // Allowed name, intentionally delegates to an unsafe hidden tool to test central hooks.
  pi.registerTool({ name: "web_search", label: "Test search", description: "Offline nested permission probe", parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      try { const result = await ctx.executeTool("test_write", {}); await log({ nestedResult: result }); }
      catch (error) { await log({ nestedBlocked: String(error) }); }
      return { content: [{ type: "text", text: "Offline search finished." }], details: undefined };
    },
  });
  // Dispatch fixture, not a real child process or a read-only enforcement test.
  pi.registerTool({ name: "subagent", label: "Offline reviewer", description: "Offline review dispatch fixture", parameters: Type.Object({ agent: Type.String(), task: Type.String() }),
    async execute(_id, args) {
      await log({ reviewDispatch: args });
      return { content: [{ type: "text", text: "Review PASS. No blocking issues. Execution remains unapproved." }], details: undefined };
    },
  });
  pi.on("tool_result", async event => { await log({ tool: event.toolName, isError: event.isError, details: event.details }); });
  pi.registerProvider("plan-test", {
    name: "Offline Plan Test", baseUrl: "http://invalid.localhost", apiKey: "not-a-credential", api: "plan-test-api",
    models: [{ id: "scripted", name: "Offline scripted model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const message: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "pending", timestamp: Date.now() };
        try {
          if (++calls > 16) throw new Error("Unexpected provider loop");
          await options?.onPayload?.({ test: true }, model);
          // before_agent_start context becomes a later user message in the normalized
          // transcript. Read the actual command message, not simply the final user role.
          const userTexts = context.messages.filter((m: any) => m.role === "user").map((m: any) =>
            typeof m.content === "string" ? m.content : m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"));
          const execute = userTexts.some(text => text.startsWith("Execute approved plan "));
          const review = userTexts.findLast(text => text.startsWith("Plan review requested: "));
          await log({ providerCall: calls, step, execute, reviewStep });
          const index = JSON.parse(await readFile(join(".pi/artifacts/index.json"), "utf8"));
          const artifact = index.artifacts.findLast((a: any) => a.status !== "abandoned");
          let tool: { name: string; arguments: unknown } | undefined;
          if (execute && step < 10) { step = 10; tool = { name: "write", arguments: { path: "approved.txt", content: "approved implementation\n" } }; }
          else if (review && reviewStep === 0) { reviewStep++; tool = { name: "subagent", arguments: { agent: "logic-reviewer", task: review } }; }
          else if (review && reviewStep === 1) { reviewStep++; tool = { name: "read_artifact", arguments: { artifactId: artifact.id } }; }
          else if (!execute && step === 0) { step++; tool = { name: "web_search", arguments: {} }; }
          else if (!execute && step === 1) { step++; tool = { name: "edit_artifact", arguments: { artifactId: artifact.id, edits: [{ oldText: "## 4. Work Units", newText: "## 4. Work Units\nImplement one verified change." }] } }; }
          else if (!execute && step === 2) { step++; tool = { name: "request_plan_review", arguments: {} }; }
          stream.push({ type: "start", partial: message });
          if (tool) {
            const toolCall = { type: "toolCall" as const, id: `script-${calls}`, ...tool };
            message.content.push(toolCall);
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
            message.stopReason = "toolUse";
          } else {
            const response = execute ? "Implementation complete." : review && reviewStep === 2 ? "Subagent review complete. No blocking issues. Still awaiting user approval." : "Waiting for explicit plan approval.";
            message.content.push({ type: "text", text: response });
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            stream.push({ type: "text_delta", contentIndex: 0, delta: response, partial: message });
            stream.push({ type: "text_end", contentIndex: 0, content: response, partial: message });
            message.stopReason = "stop";
          }
          stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
        } catch (error) {
          await log({ providerError: String(error) });
          message.stopReason = "error"; message.errorMessage = String(error);
          stream.push({ type: "error", reason: "error", error: message }); stream.end();
        }
      })();
      return stream;
    },
  });
}
