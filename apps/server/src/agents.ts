import { type AgentInfo, type CharacterId, type ProviderId, emptyUsage } from "@tu-ban/shared";
import { CLAUDE_MODEL, MAX_REVIEW_ROUNDS, MAX_SUBTASKS } from "./config.ts";

export interface AgentConfig {
  id: string;
  name: string;
  role: string;
  provider: ProviderId;
  model?: string;
  character: CharacterId;
  desk: number;
  systemPrompt: string;
}

const COMMON = `You work in a small AI office with other agents. Keep the user informed with short progress notes.
Reply in the same language as the task (Vietnamese if the task is written in Vietnamese).`;

export const ROSTER: AgentConfig[] = [
  {
    id: "manager",
    name: "Manager",
    role: "Lập kế hoạch, chia việc, tổng hợp",
    provider: "claude",
    model: CLAUDE_MODEL,
    character: "manager",
    desk: 0,
    systemPrompt: `${COMMON}
You are the Manager of this office. You plan, delegate, check and combine; your team does the hands-on work.

Your team (use these ids with the team tools):
- researcher: web research and reading documents; also reviews other agents' work
- writer: writes documents and reports as Markdown files in the shared working folder
- cursor: changes code in the local repository
- copilot: handles GitHub issues and opens pull requests

How to work:
1. If the request is a quick question you can answer well yourself, just answer it.
2. Otherwise split it into a few concrete sub-tasks with clear deliverables. Call delegate_task once per sub-task;
   start independent sub-tasks together, then call wait_for_tasks with their ids.
3. When a sub-task needs earlier results, pass those task ids in context_task_ids instead of copying the text.
4. After code changes, call request_review on that task. If changes are requested, delegate a fix to the same agent
   with the reviewer's feedback, then review again.
5. Finish with a short answer for the user that combines the results and lists any files that were created.

Limits per request: at most ${MAX_SUBTASKS} sub-tasks and ${MAX_REVIEW_ROUNDS} reviews. A tool call fails when a limit or the
budget is reached; then summarise what the team has done so far.`,
  },
  {
    id: "researcher",
    name: "Researcher",
    role: "Tìm kiếm, đọc tài liệu, review",
    provider: "claude",
    model: CLAUDE_MODEL,
    character: "researcher",
    desk: 1,
    systemPrompt: `${COMMON}\nYou are the researcher. Search the web and read files to answer accurately, citing sources.`,
  },
  {
    id: "writer",
    name: "Writer",
    role: "Viết báo cáo, nội dung",
    provider: "claude",
    model: CLAUDE_MODEL,
    character: "writer",
    desk: 2,
    systemPrompt: `${COMMON}\nYou are the writer. Produce clear, well-structured documents and save them as Markdown files in the working folder.`,
  },
  {
    id: "cursor",
    name: "Dev Cursor",
    role: "Sửa code nhiều file trong repo local",
    provider: "cursor",
    character: "cursor",
    desk: 3,
    systemPrompt: COMMON,
  },
  {
    id: "copilot",
    name: "Dev Copilot",
    role: "Task GitHub issue → PR",
    provider: "copilot",
    character: "copilot",
    desk: 4,
    systemPrompt: COMMON,
  },
];

export function toAgentInfo(c: AgentConfig, runtime: ProviderId): AgentInfo {
  return {
    id: c.id,
    name: c.name,
    role: c.role,
    provider: c.provider,
    runtime,
    model: runtime === "claude" ? c.model : undefined,
    character: c.character,
    desk: c.desk,
    status: "idle",
    activity: "idle",
    summary: "Đang rảnh",
    usage: emptyUsage(),
    requests: 0,
  };
}

/** Keyword hint used by the demo Manager to pick a plan. */
export function routeTask(prompt: string): string {
  const p = prompt.toLowerCase();
  if (/(github|issue|pull request|\bpr\b)/.test(p)) return "copilot";
  if (/(code|bug|refactor|sửa lỗi|lập trình|function|hàm|test)/.test(p)) return "cursor";
  if (/(tìm|search|research|nghiên cứu|tra cứu|so sánh|compare)/.test(p)) return "researcher";
  if (/(viết|write|báo cáo|report|blog|bài|email|tóm tắt|summary)/.test(p)) return "writer";
  return "manager";
}
