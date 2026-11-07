import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "../../..");

const env = process.env;

/**
 * demo: every agent runs on the scripted mock provider (no keys, no cost).
 * live: agents use their real provider; one that is not set up falls back to mock.
 * Default: live when ANTHROPIC_API_KEY is set, demo otherwise.
 */
export const MODE: "demo" | "live" =
  env.TU_BAN_MODE === "live" || env.TU_BAN_MODE === "demo"
    ? env.TU_BAN_MODE
    : env.ANTHROPIC_API_KEY
      ? "live"
      : "demo";

export const PORT = Number(env.PORT ?? 8787);

/** Folder the agents work in (their cwd). Keep it separate from this repo. */
export const WORKDIR = resolve(ROOT, env.TU_BAN_WORKDIR ?? "workspace");
if (!existsSync(WORKDIR)) mkdirSync(WORKDIR, { recursive: true });

/** Default Claude model for every Claude agent (override per agent in agents.ts). */
export const CLAUDE_MODEL = env.CLAUDE_MODEL ?? "claude-opus-5-5";

/** Hard spend ceiling per task for Claude agents, in USD. */
export const MAX_BUDGET_USD = Number(env.MAX_BUDGET_USD ?? 1);

/** Max agent turns per task. */
export const MAX_TURNS = Number(env.MAX_TURNS ?? 30);

/** Command used to run the Cursor CLI agent. */
export const CURSOR_AGENT_CMD = env.CURSOR_AGENT_CMD ?? "cursor-agent";

/** Delay multiplier for the demo provider (lower = faster). */
export const DEMO_SPEED = Number(env.DEMO_SPEED ?? 1);

/** Postgres connection string. Unset = keep everything in memory only. */
export const DATABASE_URL = env.DATABASE_URL;

/** Teamwork limits for one user request (the Manager's task and everything it delegates). */
export const MAX_TREE_BUDGET_USD = Number(env.MAX_TREE_BUDGET_USD ?? 5);
export const MAX_SUBTASKS = Number(env.MAX_SUBTASKS ?? 8);
export const MAX_REVIEW_ROUNDS = Number(env.MAX_REVIEW_ROUNDS ?? 2);

/** First admin account, created at start-up when no account exists yet. */
export const ADMIN_USERNAME = env.ADMIN_USERNAME;
export const ADMIN_PASSWORD = env.ADMIN_PASSWORD;

/** Public address of the dashboard (used in notification links). */
export const PUBLIC_URL = (env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");

/** Send the session cookie over HTTPS only. On by default when PUBLIC_URL is https. */
export const COOKIE_SECURE = env.COOKIE_SECURE ? env.COOKIE_SECURE === "1" : PUBLIC_URL.startsWith("https://");
