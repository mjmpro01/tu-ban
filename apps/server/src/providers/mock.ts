import { DEMO_SPEED } from "../config.ts";
import { type AgentProvider, type RunContext, type RunResult, clip, sleep } from "./types.ts";

type Step =
  | { kind: "think"; ms: number }
  | { kind: "tool"; tool: string; input: string; ms: number }
  | { kind: "say"; text: string; ms: number }
  | { kind: "approve"; tool: string; input: string };

/** Scripted, cost-free runs so the office can be demoed without any API keys. */
function script(agentId: string, prompt: string): Step[] {
  const topic = clip(prompt, 40);
  switch (agentId) {
    case "researcher":
      return [
        { kind: "think", ms: 2500 },
        { kind: "tool", tool: "WebSearch", input: topic, ms: 4000 },
        { kind: "tool", tool: "WebFetch", input: "https://example.com/bai-viet", ms: 3500 },
        { kind: "say", text: "Đã tìm được 3 nguồn liên quan, đang đọc kỹ…", ms: 2500 },
        { kind: "tool", tool: "Read", input: "notes/nguon-tham-khao.md", ms: 3000 },
        { kind: "think", ms: 2500 },
      ];
    case "writer":
      return [
        { kind: "think", ms: 2000 },
        { kind: "say", text: "Lên dàn ý 4 phần…", ms: 3000 },
        { kind: "approve", tool: "Write", input: "bao-cao.md" },
        { kind: "tool", tool: "Write", input: "bao-cao.md", ms: 5000 },
        { kind: "say", text: "Đang rà soát văn phong…", ms: 3000 },
      ];
    case "cursor":
      return [
        { kind: "think", ms: 2000 },
        { kind: "tool", tool: "Grep", input: "function handle", ms: 2500 },
        { kind: "tool", tool: "Read", input: "src/app.ts", ms: 2500 },
        { kind: "tool", tool: "Edit", input: "src/app.ts", ms: 4000 },
        { kind: "approve", tool: "Bash", input: "npm test" },
        { kind: "tool", tool: "Bash", input: "npm test", ms: 5000 },
      ];
    case "copilot":
      return [
        { kind: "say", text: "Đã nhận issue, đang làm trên cloud…", ms: 3000 },
        { kind: "tool", tool: "remote", input: "commit: fix parser edge case", ms: 6000 },
        { kind: "tool", tool: "remote", input: "commit: add tests", ms: 5000 },
        { kind: "say", text: "Đã mở pull request, chờ CI…", ms: 4000 },
      ];
    default:
      return [
        { kind: "think", ms: 3000 },
        { kind: "say", text: "Chia việc thành 3 bước…", ms: 3000 },
        { kind: "tool", tool: "TodoWrite", input: "kế hoạch", ms: 2500 },
        { kind: "think", ms: 2500 },
      ];
  }
}

export const mockProvider: AgentProvider = {
  id: "mock",
  async available() {
    return { ok: true };
  },

  async run(ctx: RunContext): Promise<RunResult> {
    const wait = (ms: number) => sleep(ms * DEMO_SPEED * (0.8 + Math.random() * 0.4), ctx.signal);
    let tokensOut = 0;
    for (const step of script(ctx.agent.id, ctx.task.prompt)) {
      if (step.kind === "think") {
        ctx.emit({ type: "thinking", activity: "thinking", summary: "Đang suy nghĩ…" });
        await wait(step.ms);
      } else if (step.kind === "say") {
        ctx.emit({ type: "message", activity: "write", summary: step.text, detail: step.text });
        tokensOut += 60;
        await wait(step.ms);
      } else if (step.kind === "tool") {
        const remote = step.tool === "remote";
        ctx.emit({
          type: "tool_start",
          activity: remote ? "remote" : step.tool.match(/Search|Fetch|Read|Grep/) ? "search" : "code",
          tool: step.tool,
          summary: `${step.tool}: ${step.input}`,
        });
        await wait(step.ms);
        ctx.emit({ type: "tool_end", activity: remote ? "remote" : "thinking", tool: step.tool, summary: `${step.tool} xong` });
      } else if (step.kind === "approve") {
        const ok = await ctx.requestApproval(step.tool, `${step.tool}: ${step.input}`, { input: step.input });
        if (!ok) {
          ctx.emit({ type: "message", activity: "write", summary: "Bị từ chối, chuyển sang cách khác…" });
          await wait(2000);
        }
      }
    }
    const result = `(demo) Đã hoàn thành: ${clip(ctx.task.prompt, 80)}`;
    return {
      result,
      usage: ctx.agent.provider === "claude" ? { tokensIn: 3200, tokensOut: tokensOut + 400, costUsd: 0 } : undefined,
    };
  },
};
