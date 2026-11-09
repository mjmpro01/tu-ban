import {
  COPILOT_ASSIGNEE,
  COPILOT_BASE_BRANCH,
  COPILOT_GITHUB_TOKEN,
  COPILOT_POLL_SECONDS,
  COPILOT_REPO,
  COPILOT_TIMEOUT_MINUTES,
  GITHUB_API_BASE,
} from "../config.ts";
import { type AgentProvider, type RunContext, type RunResult, clip, sleep } from "./types.ts";

type Json = Record<string, any>;

class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function gh<T = Json>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${GITHUB_API_BASE}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${COPILOT_GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "tu-ban-ai-office",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new GitHubError(`GitHub ${res.status}: ${clip(data.message ?? text, 200)}`, res.status);
  return data as T;
}

/** The pull request Copilot opened for an issue: the PR that cross-references it (Copilot links it from the issue). */
async function findPullRequest(repo: string, issue: number, signal: AbortSignal): Promise<number | undefined> {
  const events = await gh<Json[]>("GET", `/repos/${repo}/issues/${issue}/timeline?per_page=100`, undefined, signal);
  for (const e of events) {
    const src = e.source?.issue;
    if (e.event === "cross-referenced" && src?.pull_request && (!src.repository || src.repository.full_name === repo)) return src.number;
    if (e.event === "connected" && e.subject?.number) return e.subject.number;
  }
  return undefined;
}

/** What the PR's timeline says about Copilot's session. */
async function copilotState(repo: string, pr: number, signal: AbortSignal) {
  const events = await gh<Json[]>("GET", `/repos/${repo}/issues/${pr}/timeline?per_page=100`, undefined, signal);
  const names = events.map((e) => String(e.event ?? ""));
  return {
    finished: names.includes("copilot_work_finished"),
    failed: names.includes("copilot_work_finished_failure"),
    started: names.includes("copilot_work_started"),
  };
}

/**
 * GitHub Copilot coding agent. The task becomes an issue assigned to Copilot; the office follows the
 * pull request Copilot opens until Copilot says it is done (or the PR leaves draft / drops "[WIP]").
 */
export const copilotProvider: AgentProvider = {
  id: "copilot",

  async available() {
    if (!COPILOT_GITHUB_TOKEN) return { ok: false, reason: "chưa có COPILOT_GITHUB_TOKEN (hoặc GITHUB_TOKEN)" };
    if (!COPILOT_REPO || !/^[\w.-]+\/[\w.-]+$/.test(COPILOT_REPO)) return { ok: false, reason: "chưa đặt COPILOT_REPO=owner/tên-repo" };
    return { ok: true };
  },

  async run(ctx: RunContext): Promise<RunResult> {
    const repo = COPILOT_REPO!;
    const signal = ctx.signal;
    // the issue costs Copilot requests and starts work in the repository: follow the "write" permission
    const mode = ctx.toolMode("Write");
    if (mode === "off") throw new Error("Agent này không có quyền ghi (Quyền dùng công cụ → Ghi file), nên không giao được việc cho Copilot");
    const title = clip(ctx.task.title, 120);
    if (mode === "ask") {
      const ok = await ctx.requestApproval("GitHubIssue", `Tạo issue trên ${repo} và giao cho Copilot: ${title}`, { repo, title });
      if (!ok) throw new Error("Người duyệt không cho tạo issue cho Copilot");
    }

    const body = [
      ctx.task.prompt,
      ctx.memoryContext ? `\n---\n${ctx.memoryContext}` : "",
      `\n---\n_Tạo từ Văn phòng AI (task ${ctx.task.id})._`,
    ].join("\n");
    ctx.emit({ type: "tool_start", activity: "remote", tool: "GitHubIssue", summary: `Tạo issue trên ${repo}` });
    const issue = await gh("POST", `/repos/${repo}/issues`, { title, body: body.slice(0, 60000) }, signal);
    ctx.emit({ type: "tool_end", activity: "remote", tool: "GitHubIssue", summary: `Issue #${issue.number}: ${issue.html_url}`, detail: issue.html_url });

    // hand it to Copilot (only non-empty fields: empty strings are rejected)
    const assignment: Json = { target_repo: repo };
    if (COPILOT_BASE_BRANCH) assignment.base_branch = COPILOT_BASE_BRANCH;
    if (ctx.config.systemPrompt.trim()) assignment.custom_instructions = ctx.config.systemPrompt.trim().slice(0, 4000);
    const assigned = await gh(
      "POST",
      `/repos/${repo}/issues/${issue.number}/assignees`,
      { assignees: [COPILOT_ASSIGNEE], agent_assignment: assignment },
      signal,
    );
    const logins: string[] = (assigned.assignees ?? []).map((a: Json) => String(a.login).toLowerCase());
    if (!logins.some((l) => l.startsWith("copilot"))) {
      throw new Error(
        `GitHub không giao được issue #${issue.number} cho Copilot. Kiểm tra Copilot coding agent đã bật cho ${repo} và token là token của người dùng (PAT). ${issue.html_url}`,
      );
    }
    ctx.emit({ type: "message", activity: "remote", summary: `Đã giao issue #${issue.number} cho Copilot, đang chờ Copilot mở pull request…` });

    const cancel = () =>
      gh("POST", `/repos/${repo}/issues/${issue.number}/comments`, { body: "Đã huỷ từ Văn phòng AI." }).catch(() => {});
    signal.addEventListener("abort", () => void cancel(), { once: true });

    const deadline = Date.now() + COPILOT_TIMEOUT_MINUTES * 60_000;
    const wait = () => sleep(COPILOT_POLL_SECONDS * 1000, signal);
    let prNumber: number | undefined;
    let lastCommits = 0;
    let sawWip = false;
    let errors = 0;
    while (Date.now() < deadline) {
      await wait();
      try {
        if (!prNumber) {
          prNumber = await findPullRequest(repo, issue.number, signal);
          if (!prNumber) continue;
          ctx.emit({ type: "message", activity: "code", summary: `Copilot đã mở pull request #${prNumber}` });
        }
        const pr = await gh(`GET`, `/repos/${repo}/pulls/${prNumber}`, undefined, signal);
        const wip = /^\s*\[WIP\]/i.test(pr.title ?? "");
        sawWip ||= wip;
        if (pr.commits > lastCommits) {
          ctx.emit({ type: "tool_end", activity: "code", tool: "git", summary: `Copilot đẩy commit (${pr.commits} commit, +${pr.additions}/-${pr.deletions})` });
          lastCommits = pr.commits;
        }
        const state = await copilotState(repo, prNumber, signal);
        if (state.failed) throw new Error(`Copilot báo lỗi khi làm pull request #${prNumber}: ${pr.html_url}`);
        const done = state.finished || pr.state === "closed" || (!pr.draft && !wip) || (sawWip && !wip);
        errors = 0;
        if (!done) continue;
        const result = [
          `Copilot đã ${pr.merged ? "xong và PR đã được merge" : pr.state === "closed" ? "đóng" : "hoàn thành"} pull request #${prNumber}: ${pr.title}`,
          pr.html_url,
          `${pr.commits} commit, ${pr.changed_files} file thay đổi (+${pr.additions}/-${pr.deletions}). Issue: ${issue.html_url}`,
          pr.body ? `\n${clip(pr.body, 3000)}` : "",
        ].join("\n");
        return { result };
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof GitHubError && (e.status === 401 || e.status === 403 || e.status === 404)) throw e;
        if (e instanceof Error && e.message.startsWith("Copilot báo lỗi")) throw e;
        // network hiccups: keep following, but not forever
        if (++errors >= 5) throw e;
        ctx.emit({ type: "message", activity: "remote", summary: `GitHub chưa trả lời (${clip((e as Error).message, 60)}), thử lại…` });
      }
    }
    throw new Error(`Quá ${COPILOT_TIMEOUT_MINUTES} phút mà Copilot chưa xong. Theo dõi tiếp tại ${issue.html_url}`);
  },
};
