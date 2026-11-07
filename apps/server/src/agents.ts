import {
  type AgentInfo,
  type AgentSettings,
  type CharacterId,
  DEFAULT_TOOL_POLICY,
  SKILL_NAME_PATTERN,
  TOOL_GROUPS,
  type ToolPolicy,
  emptyUsage,
} from "@tu-ban/shared";
import { CLAUDE_MODEL, MAX_REVIEW_ROUNDS, MAX_SUBTASKS, MAX_TREE_BUDGET_USD } from "./config.ts";

/** An agent: fixed identity (id, character, desk) + settings that can be edited from the dashboard. */
export interface AgentConfig extends AgentSettings {
  id: string;
  character: CharacterId;
  desk: number;
}

export const MANAGER_ID = "manager";

const COMMON = `You work in a small AI office with other agents. Keep the user informed with short progress notes.
Reply in the same language as the task (Vietnamese if the task is written in Vietnamese).`;

/** Defaults shipped with the app. Edits made in the dashboard are stored as overrides on top of these. */
export const ROSTER: AgentConfig[] = [
  {
    id: MANAGER_ID,
    name: "Manager",
    role: "Lập kế hoạch, giao việc, tổng hợp",
    provider: "claude",
    model: CLAUDE_MODEL,
    character: "manager",
    desk: 0,
    enabled: true,
    skills: [],
    tools: { ...DEFAULT_TOOL_POLICY },
    systemPrompt: `${COMMON}
You are the Manager of this office. You plan, delegate, check and combine; your team does the hands-on work.

How to work:
1. If the request is a quick question you can answer well yourself, just answer it.
2. Otherwise split it into a few concrete sub-tasks with clear deliverables. Call delegate_task once per sub-task;
   start independent sub-tasks together, then call wait_for_tasks with their ids.
3. When a sub-task needs earlier results, pass those task ids in context_task_ids instead of copying the text.
4. After code changes, call request_review on that task. If changes are requested, delegate a fix to the same agent
   with the reviewer's feedback, then review again.
5. Finish with a short answer for the user that combines the results and lists any files that were created.`,
  },
  {
    id: "researcher",
    name: "Researcher",
    role: "Tìm kiếm, đọc tài liệu, review",
    provider: "claude",
    model: CLAUDE_MODEL,
    character: "researcher",
    desk: 1,
    enabled: true,
    skills: [],
    tools: { ...DEFAULT_TOOL_POLICY },
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
    enabled: true,
    skills: [],
    tools: { ...DEFAULT_TOOL_POLICY },
    systemPrompt: `${COMMON}\nYou are the writer. Produce clear, well-structured documents and save them as Markdown files in the working folder.`,
  },
  {
    id: "cursor",
    name: "Dev Cursor",
    role: "Sửa code nhiều file trong repo local",
    provider: "cursor",
    model: CLAUDE_MODEL,
    character: "cursor",
    desk: 3,
    enabled: true,
    skills: [],
    tools: { ...DEFAULT_TOOL_POLICY },
    systemPrompt: COMMON,
  },
  {
    id: "copilot",
    name: "Dev Copilot",
    role: "Task GitHub issue → PR",
    provider: "copilot",
    model: CLAUDE_MODEL,
    character: "copilot",
    desk: 4,
    enabled: true,
    skills: [],
    tools: { ...DEFAULT_TOOL_POLICY },
    systemPrompt: COMMON,
  },
];

export const SETTINGS_KEYS = ["name", "role", "provider", "model", "systemPrompt", "enabled", "skills", "tools"] as const;

export const pickSettings = (c: AgentSettings): AgentSettings => ({
  name: c.name,
  role: c.role,
  provider: c.provider,
  model: c.model,
  systemPrompt: c.systemPrompt,
  enabled: c.enabled,
  skills: [...c.skills],
  tools: { ...c.tools },
});

const SKILL_RE = new RegExp(SKILL_NAME_PATTERN);
const TOOL_MODES = ["off", "ask", "auto"];

/**
 * Validate an edit coming from the dashboard. Throws a user-facing (Vietnamese) message.
 * `knownSkills` (when given) rejects skills that are not in the library.
 */
export function validateSettings(id: string, s: Partial<AgentSettings>, knownSkills?: Set<string>): Partial<AgentSettings> {
  const out: Partial<AgentSettings> = {};
  if (s.name !== undefined) {
    const v = String(s.name).trim();
    if (!v || v.length > 40) throw new Error("Tên phải có từ 1 đến 40 ký tự");
    out.name = v;
  }
  if (s.role !== undefined) {
    const v = String(s.role).trim();
    if (v.length > 120) throw new Error("Vai trò tối đa 120 ký tự");
    out.role = v;
  }
  if (s.provider !== undefined) {
    if (!["claude", "cursor", "copilot"].includes(s.provider)) throw new Error("Provider không hợp lệ");
    out.provider = s.provider;
  }
  if (s.model !== undefined) {
    const v = String(s.model).trim();
    if (!/^[a-z0-9][a-z0-9.\-_:]{1,63}$/i.test(v)) throw new Error("Tên model không hợp lệ");
    out.model = v;
  }
  if (s.systemPrompt !== undefined) {
    const v = String(s.systemPrompt);
    if (v.length > 20000) throw new Error("System prompt tối đa 20.000 ký tự");
    out.systemPrompt = v;
  }
  if (s.enabled !== undefined) {
    if (id === MANAGER_ID && !s.enabled) throw new Error("Không thể tắt Manager: Manager nhận mọi yêu cầu không chỉ định agent");
    out.enabled = !!s.enabled;
  }
  if (s.skills !== undefined) {
    if (!Array.isArray(s.skills) || s.skills.length > 50) throw new Error("Danh sách skill không hợp lệ");
    const names = [...new Set(s.skills.map(String))];
    const bad = names.find((n) => !SKILL_RE.test(n) || (knownSkills && !knownSkills.has(n)));
    if (bad) throw new Error(`Skill "${bad}" không có trong thư viện`);
    out.skills = names.sort();
  }
  if (s.tools !== undefined) {
    if (typeof s.tools !== "object" || s.tools === null) throw new Error("Quyền công cụ không hợp lệ");
    const tools = { ...DEFAULT_TOOL_POLICY } as ToolPolicy;
    for (const g of TOOL_GROUPS) {
      const mode = (s.tools as Partial<ToolPolicy>)[g.id];
      if (mode === undefined) continue;
      if (!TOOL_MODES.includes(mode)) throw new Error(`Chế độ "${mode}" không hợp lệ cho nhóm ${g.label}`);
      tools[g.id] = mode;
    }
    out.tools = tools;
  }
  return out;
}

/**
 * The part of the Manager's prompt generated from the current roster, so renaming or disabling
 * an agent never leaves the Manager delegating to someone who is not there.
 */
export function managerTeamSection(configs: AgentConfig[]): string {
  const team = configs.filter((c) => c.id !== MANAGER_ID && c.enabled);
  const lines = team.length
    ? team.map((c) => `- ${c.id} (${c.name}): ${c.role || "no role set"}`).join("\n")
    : "- (nobody: every other agent is disabled, so do the work yourself)";
  return `Your team (use these ids with the team tools):
${lines}

Limits per request: at most ${MAX_SUBTASKS} sub-tasks, ${MAX_REVIEW_ROUNDS} reviews and $${MAX_TREE_BUDGET_USD} for the whole team.
A tool call fails when a limit or the budget is reached; then summarise what the team has done so far.`;
}

export function toAgentInfo(c: AgentConfig, runtime: AgentInfo["runtime"]): AgentInfo {
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
    summary: c.enabled ? "Đang rảnh" : "Đã tắt",
    usage: emptyUsage(),
    requests: 0,
    enabled: c.enabled,
  };
}
