import { type CanUseTool, type SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { toolActivity } from "@tu-ban/shared";
import { MAX_BUDGET_USD, MAX_TURNS } from "../config.ts";
import { type AgentProvider, type RunContext, type RunResult, clip, summarizeToolInput } from "./types.ts";

/** Tools that only read: run them without asking the human. Everything else needs approval. */
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "LS", "NotebookRead"]);

type Block = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
};

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === "string" ? c.text : "")).join(" ");
  return "";
}

/** Runs an agent with the Claude Agent SDK and translates its message stream into office events. */
export const claudeProvider: AgentProvider = {
  id: "claude",

  async available() {
    // The SDK also accepts other credential sources (e.g. a logged-in Claude Code profile),
    // so a missing ANTHROPIC_API_KEY is only a hint, not a hard failure.
    return { ok: true };
  },

  async run(ctx: RunContext): Promise<RunResult> {
    const abortController = new AbortController();
    ctx.signal.addEventListener("abort", () => abortController.abort(), { once: true });

    const toolNames = new Map<string, string>();

    const canUseTool: CanUseTool = async (toolName, input) => {
      if (READ_ONLY_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: input };
      const ok = await ctx.requestApproval(toolName, summarizeToolInput(toolName, input), input);
      return ok
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "The human operator denied this action. Try another approach or explain what you need." };
    };

    const stream = query({
      prompt: ctx.task.prompt,
      options: {
        model: ctx.config.model,
        cwd: ctx.workdir,
        systemPrompt: { type: "preset", preset: "claude_code", append: ctx.config.systemPrompt },
        // Isolation: do not pick up ~/.claude or project settings from the host machine.
        settingSources: [],
        permissionMode: "default",
        canUseTool,
        maxTurns: MAX_TURNS,
        maxBudgetUsd: MAX_BUDGET_USD,
        abortController,
      },
    });

    let final: RunResult | undefined;
    for await (const msg of stream as AsyncIterable<SDKMessage>) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content as Block[]) {
          if (block.type === "thinking") {
            ctx.emit({ type: "thinking", activity: "thinking", summary: "Đang suy nghĩ…" });
          } else if (block.type === "text" && block.text?.trim()) {
            ctx.emit({ type: "message", activity: "write", summary: clip(block.text, 120), detail: block.text });
          } else if (block.type === "tool_use" && block.id && block.name) {
            toolNames.set(block.id, block.name);
            ctx.emit({
              type: "tool_start",
              activity: toolActivity(block.name),
              tool: block.name,
              summary: summarizeToolInput(block.name, block.input),
              detail: JSON.stringify(block.input, null, 2)?.slice(0, 4000),
            });
          }
        }
      } else if (msg.type === "user") {
        const content = msg.message.content;
        if (!Array.isArray(content)) continue;
        for (const block of content as Block[]) {
          if (block.type !== "tool_result" || !block.tool_use_id) continue;
          const tool = toolNames.get(block.tool_use_id) ?? "tool";
          const text = blockText(block.content);
          ctx.emit({
            type: "tool_end",
            activity: block.is_error ? "error" : "thinking",
            tool,
            summary: `${tool} ${block.is_error ? "lỗi" : "xong"}${text ? `: ${clip(text, 60)}` : ""}`,
            detail: text.slice(0, 4000),
          });
        }
      } else if (msg.type === "result") {
        const usage = {
          tokensIn: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
          tokensOut: msg.usage.output_tokens,
          costUsd: msg.total_cost_usd,
        };
        if (msg.subtype === "success") {
          final = { result: msg.result, usage };
        } else {
          const reason = msg.errors?.join("; ") || msg.subtype;
          throw Object.assign(new Error(reason), { usage });
        }
      }
    }
    if (!final) throw new Error(ctx.signal.aborted ? "cancelled" : "Agent stopped without a result");
    return final;
  },
};
