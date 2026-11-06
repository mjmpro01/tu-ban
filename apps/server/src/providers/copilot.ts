import type { AgentProvider } from "./types.ts";

/**
 * PLACEHOLDER — GitHub Copilot adapter.
 *
 * Planned flow (Copilot coding agent): create a GitHub issue from the task, assign it to Copilot,
 * then follow the issue / pull request through GitHub webhooks or polling:
 *   assigned → "remote" (working in the cloud), commits pushed → "code",
 *   PR opened → hand-off to the Reviewer, PR checks → done / error.
 * The GitHub API for assigning Copilot and the events it emits depend on your plan and change
 * over time, so this is left unimplemented until it can be tested against a real account.
 * Until then the agent runs on the demo provider.
 */
export const copilotProvider: AgentProvider = {
  id: "copilot",
  async available() {
    return { ok: false, reason: "chưa cài adapter Copilot (xem apps/server/src/providers/copilot.ts)" };
  },
  async run() {
    throw new Error("Copilot adapter is not implemented yet");
  },
};
