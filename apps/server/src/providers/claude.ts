import { type CanUseTool, type SDKMessage, createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { toolActivity } from "@tu-ban/shared";
import { TOOL_GROUPS } from "@tu-ban/shared";
import { type AgentProvider, type RunContext, type RunResult, type TeamApi, clip, summarizeToolInput } from "./types.ts";

/** Harmless internal tools that are not part of the configurable groups. */
const ALWAYS_ALLOWED = new Set(["TodoWrite", "Skill"]);

const TEAM_SERVER = "team";
const TEAM_PREFIX = `mcp__${TEAM_SERVER}__`;
/** How much of each sub-task result goes back to the Manager in one tool result. */
const RESULT_CHARS = 8000;

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

/** In-process MCP server exposing the team API to the Manager. */
function teamServer(team: TeamApi) {
  const ids = team.members().map((m) => m.id) as [string, ...string[]];
  // note: the list is fixed for this run; agents enabled later join from the next request
  const guard =
    <A>(fn: (args: A) => Promise<ReturnType<typeof text>>) =>
    async (args: A) => {
      try {
        return await fn(args);
      } catch (e) {
        return text(`Error: ${(e as Error).message}`, true);
      }
    };
  return createSdkMcpServer({
    name: TEAM_SERVER,
    alwaysLoad: true,
    // waiting for teammates can take a long time
    timeout: 60 * 60 * 1000,
    tools: [
      tool(
        "delegate_task",
        `Give a sub-task to a team member. Returns the new task id immediately; the work runs in the background.
Team: ${team
          .members()
          .map((m) => `${m.id} (${m.role})`)
          .join("; ")}.`,
        {
          agent_id: (ids.length ? z.enum(ids) : z.string()).describe("Who does the work"),
          instructions: z.string().min(10).describe("What to do and what to deliver, self-contained"),
          context_task_ids: z.array(z.string()).optional().describe("Earlier task ids whose results this sub-task needs"),
        },
        guard(async (a) => {
          const id = team.delegate(a.agent_id, a.instructions, a.context_task_ids);
          return text(`Delegated to ${a.agent_id}. task_id: ${id}`);
        }),
      ),
      tool(
        "wait_for_tasks",
        "Wait until the given sub-tasks finish and return their results.",
        { task_ids: z.array(z.string()).min(1) },
        guard(async (a) => {
          const results = await team.waitFor(a.task_ids);
          return text(
            results
              .map((r) => `## ${r.agentId} — task ${r.taskId} — ${r.status}\n${clip(r.result ?? r.error ?? "", RESULT_CHARS)}`)
              .join("\n\n"),
          );
        }),
      ),
      tool(
        "request_review",
        "Ask a reviewer to check a finished sub-task (use after code changes). Returns APPROVED or CHANGES_REQUESTED with feedback.",
        { task_id: z.string(), focus: z.string().optional().describe("What the reviewer should look at closely") },
        guard(async (a) => {
          const r = await team.review(a.task_id, a.focus);
          return text(`${r.approved ? "APPROVED" : "CHANGES_REQUESTED"} (review task ${r.reviewTaskId})
${clip(r.feedback, RESULT_CHARS)}`);
        }),
      ),
    ],
  });
}

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

    // Tool permissions from the agent settings: "off" groups are removed, "auto" runs, "ask" waits for a human.
    const disallowedTools = TOOL_GROUPS.filter((g) => ctx.config.tools[g.id] === "off").flatMap((g) => [...g.tools]);
    const canUseTool: CanUseTool = async (toolName, input) => {
      if (ALWAYS_ALLOWED.has(toolName) || toolName.startsWith(TEAM_PREFIX)) return { behavior: "allow", updatedInput: input };
      const mode = ctx.toolMode(toolName);
      if (mode === "auto") return { behavior: "allow", updatedInput: input };
      if (mode === "off") return { behavior: "deny", message: `You are not allowed to use ${toolName}. Work without it or explain what you need.` };
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
        // Only the work folder's own .claude/ is read (that is where the skill library lives);
        // ~/.claude on the host machine is never loaded.
        settingSources: ["project"],
        skills: ctx.skills,
        permissionMode: "default",
        disallowedTools,
        canUseTool,
        maxTurns: ctx.limits.maxTurns,
        maxBudgetUsd: ctx.limits.maxBudgetUsd,
        abortController,
        ...(ctx.team ? { mcpServers: { [TEAM_SERVER]: teamServer(ctx.team) } } : {}),
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
            if (block.name.startsWith(TEAM_PREFIX)) continue;
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
          if (tool.startsWith(TEAM_PREFIX)) continue;
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
