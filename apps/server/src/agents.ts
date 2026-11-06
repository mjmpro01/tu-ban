import { type AgentInfo, type CharacterId, type ProviderId, emptyUsage } from "@tu-ban/shared";
import { CLAUDE_MODEL } from "./config.ts";

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
    systemPrompt: `${COMMON}\nYou are the office manager. Break requests into clear steps, decide what to do, and summarise results crisply.`,
  },
  {
    id: "researcher",
    name: "Researcher",
    role: "Tìm kiếm, đọc tài liệu",
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

/** Keyword router used when the user does not pick an agent. */
export function routeTask(prompt: string): string {
  const p = prompt.toLowerCase();
  if (/(github|issue|pull request|\bpr\b)/.test(p)) return "copilot";
  if (/(code|bug|refactor|sửa lỗi|lập trình|function|hàm|test)/.test(p)) return "cursor";
  if (/(tìm|search|research|nghiên cứu|tra cứu|so sánh|compare)/.test(p)) return "researcher";
  if (/(viết|write|báo cáo|report|blog|bài|email|tóm tắt|summary)/.test(p)) return "writer";
  return "manager";
}
