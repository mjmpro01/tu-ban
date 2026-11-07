import { DEMO_SPEED } from "../config.ts";
import { type AgentProvider, type RunContext, type RunResult, type TeamApi, clip, sleep } from "./types.ts";

type Step =
  | { kind: "think"; ms: number }
  | { kind: "tool"; tool: string; input: string; ms: number }
  | { kind: "say"; text: string; ms: number }
  | { kind: "approve"; tool: string; input: string };

/** Scripted, cost-free runs so the office can be demoed without any API keys. */
function script(agentId: string, prompt: string, kind: string): Step[] {
  const topic = clip(prompt, 40);
  if (kind === "review")
    return [
      { kind: "tool", tool: "Read", input: "src/app.ts", ms: 3000 },
      { kind: "think", ms: 2500 },
      { kind: "say", text: "Đang đối chiếu với yêu cầu…", ms: 2500 },
    ];
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
    if (ctx.team) return managerPlan(ctx, ctx.team, wait);
    let tokensOut = 0;
    for (const step of script(ctx.agent.id, ctx.task.title, ctx.task.kind)) {
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
    const result =
      ctx.task.kind === "review"
        ? reviewVerdict(ctx.task.prompt)
        : `(demo) ${ctx.agent.name} đã hoàn thành: ${ctx.task.title}`;
    return {
      result,
      usage: ctx.agent.provider === "claude" ? { tokensIn: 3200, tokensOut: tokensOut + 400, costUsd: 0 } : undefined,
    };
  },
};

/** Demo reviewer: asks for changes on the first look at code, approves the fix. */
function reviewVerdict(prompt: string) {
  if (/Sửa theo góp ý/.test(prompt)) return "(demo) Đã kiểm tra bản sửa: các điểm góp ý đã được xử lý.\nVERDICT: APPROVED";
  return "(demo) Thiếu test cho trường hợp chuỗi rỗng; tên biến `tmp` khó hiểu.\nVERDICT: CHANGES_REQUESTED";
}

/** Demo Manager: plans with keywords, then really delegates, waits and reviews through the team API. */
async function managerPlan(ctx: RunContext, team: TeamApi, wait: (ms: number) => Promise<void>): Promise<RunResult> {
  const say = (text: string) => ctx.emit({ type: "message", activity: "write", summary: text, detail: text });
  const p = ctx.task.prompt.toLowerCase();
  const topic = clip(ctx.task.prompt, 60);
  ctx.emit({ type: "thinking", activity: "thinking", summary: "Đang lập kế hoạch…" });
  await wait(2500);

  const lines: string[] = [];
  if (/(github|issue|pull request|\bpr\b|code|bug|refactor|sửa lỗi|lập trình|hàm|test)/.test(p)) {
    const onGithub = /(github|issue|pull request|\bpr\b)/.test(p);
    const dev = onGithub ? "copilot" : "cursor";
    say(`Kế hoạch: ${onGithub ? "Dev Copilot" : "Dev Cursor"} xử lý, Researcher review.`);
    await wait(1500);
    let work = team.delegate(dev, `Thực hiện: ${topic}`);
    await team.waitFor([work]);
    let review = await team.review(work, "tính đúng đắn và test");
    if (!review.approved) {
      say("Review yêu cầu sửa, giao lại kèm góp ý.");
      work = team.delegate(dev, `Sửa theo góp ý review: ${clip(review.feedback, 120)}`, [work, review.reviewTaskId]);
      await team.waitFor([work]);
      review = await team.review(work);
    }
    lines.push(`- ${onGithub ? "Dev Copilot" : "Dev Cursor"} đã thực hiện thay đổi.`, `- Review: ${review.approved ? "đã duyệt" : "còn góp ý chưa xử lý"}.`);
  } else {
    say("Kế hoạch: Researcher thu thập thông tin, Writer lập dàn ý, rồi Writer viết bản hoàn chỉnh.");
    await wait(1500);
    const research = team.delegate("researcher", `Thu thập thông tin và số liệu về: ${topic}`);
    const outline = team.delegate("writer", `Lập dàn ý cho: ${topic}`);
    const first = await team.waitFor([research, outline]);
    ctx.emit({ type: "thinking", activity: "thinking", summary: "Họp: tổng hợp tài liệu và dàn ý…" });
    await wait(6000);
    const draft = team.delegate("writer", "Viết bản hoàn chỉnh dựa trên tài liệu và dàn ý đã có", [research, outline]);
    const [final] = await team.waitFor([draft]);
    lines.push(...first.map((r) => `- ${r.agentId}: ${r.status === "done" ? "xong" : "lỗi"}`), `- Bản hoàn chỉnh: ${final.status === "done" ? "xong" : "lỗi"}`);
  }
  ctx.emit({ type: "thinking", activity: "thinking", summary: "Viết tổng kết cho người dùng…" });
  await wait(2000);
  return {
    result: `(demo) Tổng kết cho: ${topic}\n${lines.join("\n")}`,
    usage: { tokensIn: 5200, tokensOut: 900, costUsd: 0 },
  };
}
