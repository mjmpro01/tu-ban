import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SKILL_NAME_PATTERN, type SkillDetail, type SkillSummary } from "@tu-ban/shared";
import { WORKDIR } from "./config.ts";

/**
 * Skill library shared by the agents. Skills live where the Claude Agent SDK discovers project skills:
 * <workdir>/.claude/skills/<name>/SKILL.md (+ any extra files in that folder).
 */
export const SKILLS_DIR = join(WORKDIR, ".claude", "skills");

const NAME_RE = new RegExp(SKILL_NAME_PATTERN);
const MAX_DESCRIPTION = 1024;
const MAX_BODY = 100_000;
const MAX_FILES = 50;

export function assertSkillName(name: string) {
  if (!NAME_RE.test(name)) throw new Error("Tên skill chỉ gồm chữ thường a-z, số và dấu gạch ngang, tối đa 64 ký tự");
}

/** Split a SKILL.md into its front matter fields and body. */
function parse(md: string): { name?: string; description: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return { description: "", body: md };
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        /* keep as written */
      }
    } else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    fields[kv[1]] = v;
  }
  return { name: fields.name, description: fields.description ?? "", body: m[2].replace(/^\n/, "") };
}

function serialize(name: string, description: string, body: string) {
  // a JSON string is a valid double-quoted YAML scalar, so any description is safe
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trimEnd()}\n`;
}

async function listFiles(dir: string, prefix = "", depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (out.length >= MAX_FILES) break;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(join(dir, e.name), rel, depth + 1)));
    else if (rel !== "SKILL.md") out.push(rel);
  }
  return out.slice(0, MAX_FILES);
}

export async function listSkills(usedBy: (name: string) => string[]): Promise<SkillSummary[]> {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true }).catch(() => []);
  const skills: SkillSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !NAME_RE.test(e.name)) continue;
    const md = await readFile(join(SKILLS_DIR, e.name, "SKILL.md"), "utf8").catch(() => undefined);
    if (md === undefined) continue;
    const { description } = parse(md);
    skills.push({ name: e.name, description, files: await listFiles(join(SKILLS_DIR, e.name)), usedBy: usedBy(e.name) });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function skillExists(name: string) {
  if (!NAME_RE.test(name)) return false;
  return stat(join(SKILLS_DIR, name, "SKILL.md")).then(
    () => true,
    () => false,
  );
}

export async function getSkill(name: string, usedBy: (name: string) => string[]): Promise<SkillDetail | undefined> {
  assertSkillName(name);
  const md = await readFile(join(SKILLS_DIR, name, "SKILL.md"), "utf8").catch(() => undefined);
  if (md === undefined) return undefined;
  const { description, body } = parse(md);
  return { name, description, body, files: await listFiles(join(SKILLS_DIR, name)), usedBy: usedBy(name) };
}

export async function saveSkill(name: string, input: { description?: string; body?: string }) {
  assertSkillName(name);
  const description = String(input.description ?? "").replace(/\s+/g, " ").trim();
  const body = String(input.body ?? "");
  if (!description) throw new Error("Cần mô tả skill: agent dựa vào mô tả để biết khi nào dùng skill");
  if (description.length > MAX_DESCRIPTION) throw new Error(`Mô tả tối đa ${MAX_DESCRIPTION} ký tự`);
  if (!body.trim()) throw new Error("Nội dung skill trống");
  if (body.length > MAX_BODY) throw new Error("Nội dung skill tối đa 100.000 ký tự");
  const dir = join(SKILLS_DIR, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), serialize(name, description, body), "utf8");
}

export async function deleteSkill(name: string) {
  assertSkillName(name);
  await rm(join(SKILLS_DIR, name), { recursive: true, force: true });
}
