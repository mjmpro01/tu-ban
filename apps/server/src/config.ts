import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "../../..");

const env = process.env;

/**
 * demo: every agent runs on the scripted mock provider (no keys, no cost).
 * live: agents use their real provider; one that is not set up falls back to mock.
 * Default: live when ANTHROPIC_API_KEY or NINEROUTER_URL is set, demo otherwise.
 */
export const MODE: "demo" | "live" =
  env.TU_BAN_MODE === "live" || env.TU_BAN_MODE === "demo"
    ? env.TU_BAN_MODE
    : env.ANTHROPIC_API_KEY || env.NINEROUTER_URL
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

/** Default ceiling for all spending in one day, in USD (0 = no daily limit). Editable in the dashboard. */
export const DAILY_BUDGET_USD = Number(env.DAILY_BUDGET_USD ?? 0);

/** Notifications. Secrets stay in the environment: they are never stored in the database or shown in the dashboard. */
export const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
export const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID;
export const TELEGRAM_API_BASE = (env.TELEGRAM_API_BASE ?? "https://api.telegram.org").replace(/\/$/, "");
export const SLACK_WEBHOOK_URL = env.SLACK_WEBHOOK_URL;

/**
 * 9router (https://github.com/decolua/9router): one local gateway in front of many AI accounts.
 * When set, Claude agents send their requests through it (ANTHROPIC_BASE_URL) and Mem0 uses its
 * OpenAI-compatible /v1 API for fact extraction and embeddings.
 */
export const NINEROUTER_URL = env.NINEROUTER_URL?.replace(/\/$/, "");
export const NINEROUTER_KEY = env.NINEROUTER_KEY;

/** Shared memory. With MEM0_URL the office uses a Mem0 server (vector search); without it, keyword search in Postgres. */
export const MEM0_URL = env.MEM0_URL?.replace(/\/$/, "");
export const MEM0_API_KEY = env.MEM0_API_KEY;
/** Send the model settings below to Mem0 at start-up (POST /configure). Set to 0 to manage Mem0 yourself. */
export const MEM0_CONFIGURE = env.MEM0_CONFIGURE !== "0";
/** 9router as Mem0 reaches it (Mem0 in Docker: http://host.docker.internal:20128). Default NINEROUTER_URL. */
export const MEM0_NINEROUTER_URL = (env.MEM0_NINEROUTER_URL ?? env.NINEROUTER_URL)?.replace(/\/$/, "");
/** Model Mem0 uses to extract facts, through 9router (e.g. a cheap, fast model). */
export const MEMORY_LLM_MODEL = env.MEMORY_LLM_MODEL;
/**
 * Embeddings. MEMORY_EMBED_URL points to an OpenAI-compatible embedding server, e.g. Hugging Face
 * text-embeddings-inference running AITeamVN/Vietnamese_Embedding; unset = 9router's /v1/embeddings.
 * Mem0 calls it, so give the address Mem0 can reach (in docker-compose: http://tei).
 */
export const MEMORY_EMBED_URL = env.MEMORY_EMBED_URL?.replace(/\/$/, "");
export const MEMORY_EMBED_MODEL = env.MEMORY_EMBED_MODEL ?? (env.MEMORY_EMBED_URL ? "AITeamVN/Vietnamese_Embedding" : undefined);
export const MEMORY_EMBED_DIMS = Number(env.MEMORY_EMBED_DIMS ?? 1024);
