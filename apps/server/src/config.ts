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

/**
 * Two-way Telegram: the bot also takes requests and approvals (long polling, no public URL needed).
 * On by default when TELEGRAM_BOT_TOKEN is set; TELEGRAM_BOT_COMMANDS=0 keeps it send-only.
 */
export const TELEGRAM_BOT_COMMANDS = !!TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_COMMANDS !== "0";
const ids = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
/** Chats that may send requests. Default: TELEGRAM_CHAT_ID. */
export const TELEGRAM_ALLOWED_CHATS = ids(env.TELEGRAM_ALLOWED_CHATS ?? TELEGRAM_CHAT_ID);
/** Chats that may also approve, cancel and edit memory (admin rights). Default: TELEGRAM_CHAT_ID. */
export const TELEGRAM_ADMIN_CHATS = ids(env.TELEGRAM_ADMIN_CHATS ?? TELEGRAM_CHAT_ID);

/**
 * Two-way Slack through Socket Mode (no public URL): an app-level token (xapp-…, scope connections:write)
 * and a bot token (xoxb-…, scopes app_mentions:read, chat:write, im:history).
 */
export const SLACK_APP_TOKEN = env.SLACK_APP_TOKEN;
export const SLACK_BOT_TOKEN = env.SLACK_BOT_TOKEN;
export const SLACK_API_BASE = (env.SLACK_API_BASE ?? "https://slack.com/api").replace(/\/$/, "");
/** Channel ids that may send requests (empty = any channel the bot is in, and direct messages). */
export const SLACK_ALLOWED_CHANNELS = ids(env.SLACK_ALLOWED_CHANNELS);
/** Slack user ids that may approve, cancel and write memory. */
export const SLACK_ADMIN_USERS = ids(env.SLACK_ADMIN_USERS);
/** Channel where approval requests are posted with buttons. */
export const SLACK_APPROVAL_CHANNEL = env.SLACK_APPROVAL_CHANNEL;

/**
 * GitHub Copilot coding agent: a task becomes a GitHub issue assigned to Copilot, which works in
 * the cloud and opens a pull request. Needs a user token (fine-grained PAT with Issues and
 * Pull requests read/write, or a classic PAT with the repo scope) on a repository where the
 * Copilot coding agent is enabled.
 */
export const COPILOT_GITHUB_TOKEN = env.COPILOT_GITHUB_TOKEN ?? env.GITHUB_TOKEN;
/** owner/name of the repository Copilot works in. */
export const COPILOT_REPO = env.COPILOT_REPO;
export const COPILOT_BASE_BRANCH = env.COPILOT_BASE_BRANCH;
export const COPILOT_ASSIGNEE = env.COPILOT_ASSIGNEE ?? "copilot-swe-agent[bot]";
export const GITHUB_API_BASE = (env.GITHUB_API_BASE ?? "https://api.github.com").replace(/\/$/, "");
export const COPILOT_POLL_SECONDS = Math.max(5, Number(env.COPILOT_POLL_SECONDS ?? 30));
export const COPILOT_TIMEOUT_MINUTES = Number(env.COPILOT_TIMEOUT_MINUTES ?? 120);
