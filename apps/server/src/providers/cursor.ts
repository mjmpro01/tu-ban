import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { toolActivity } from "@tu-ban/shared";
import { CURSOR_AGENT_CMD } from "../config.ts";
import { type AgentProvider, type RunContext, type RunResult, clip, summarizeToolInput } from "./types.ts";

/**
 * EXPERIMENTAL — Cursor CLI adapter.
 *
 * Runs `cursor-agent -p <prompt> --output-format stream-json` in the work folder and maps the
 * JSON lines it prints to office events. The Cursor CLI and its output format change quickly:
 * check `cursor-agent --help` and adjust the flags / the parser below to your installed version.
 * Unknown lines are ignored, so a format change degrades to "working…" rather than crashing.
 *
 * Note: without `--force` the CLI does not run shell commands on its own; approvals happen
 * inside Cursor, not in this office's approval queue.
 */
export const cursorProvider: AgentProvider = {
  id: "cursor",

  async available() {
    const r = spawnSync(CURSOR_AGENT_CMD, ["--version"], { encoding: "utf8" });
    if (r.error) return { ok: false, reason: `không tìm thấy lệnh "${CURSOR_AGENT_CMD}" (cài Cursor CLI hoặc đặt CURSOR_AGENT_CMD)` };
    return { ok: true };
  },

  run(ctx: RunContext): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(CURSOR_AGENT_CMD, ["-p", ctx.task.prompt, "--output-format", "stream-json"], {
        cwd: ctx.workdir,
        env: process.env,
      });
      ctx.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });

      let result = "";
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString()));

      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        let obj: Record<string, any>;
        try {
          obj = JSON.parse(line);
        } catch {
          return;
        }
        const type = String(obj.type ?? "");
        if (type === "assistant") {
          const text = extractText(obj.message?.content ?? obj.text);
          if (text) ctx.emit({ type: "message", activity: "write", summary: clip(text, 120), detail: text });
        } else if (type === "thinking") {
          ctx.emit({ type: "thinking", activity: "thinking", summary: "Đang suy nghĩ…" });
        } else if (type === "tool_call") {
          const call = obj.tool_call ?? {};
          const name = String(Object.keys(call)[0] ?? obj.name ?? "tool");
          const args = call[name]?.args ?? call[name] ?? {};
          if (obj.subtype === "started") {
            ctx.emit({ type: "tool_start", activity: toolActivity(name), tool: name, summary: summarizeToolInput(name, args) });
          } else if (obj.subtype === "completed") {
            ctx.emit({ type: "tool_end", activity: "thinking", tool: name, summary: `${name} xong` });
          }
        } else if (type === "result") {
          result = String(obj.result ?? result);
        }
      });

      child.on("error", reject);
      child.on("close", (code) => {
        if (ctx.signal.aborted) return reject(new Error("cancelled"));
        if (code === 0) resolve({ result: result || "Xong." });
        else reject(new Error(`cursor-agent thoát với mã ${code}: ${clip(stderr, 300)}`));
      });
    });
  },
};

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join(" ").trim();
  return "";
}
