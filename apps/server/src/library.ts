import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { DEFAULT_LIBRARY_SETTINGS, type LibraryDoc, type LibraryHit, type LibrarySettings } from "@tu-ban/shared";
import { WORKDIR } from "./config.ts";
import { LIBRARY_TYPES, extractText } from "./extract.ts";
import { fold } from "./memory.ts";
import type { Store } from "./store.ts";

/** The files live in the agents' work folder, so agents can also open the originals. */
export const LIBRARY_DIR = join(WORKDIR, "library");
const INDEX_DIR = join(LIBRARY_DIR, ".index");
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_DOCS = 500;
const CHUNK_CHARS = 1000;
const OVERLAP = 150;

type Chunk = { doc: string; idx: number; text: string; tf: Map<string, number>; len: number };
type Stored = LibraryDoc & { text: string };

const STOP = new Set(
  "va la cua cho cac nhung mot de voi trong khi thi co khong duoc nay do o tu den ve nhu the hay roi da se dang bi vi neu ma cung rat the and the of to a an in on for is are be with or at by it this that".split(" "),
);
const terms = (s: string) => (fold(s).match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w));

/** Cut text into overlapping passages, preferring paragraph and sentence ends. */
export function chunkText(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_CHARS);
    if (end < text.length) {
      const window = text.slice(start + CHUNK_CHARS / 2, end);
      const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "));
      if (cut > 0) end = start + CHUNK_CHARS / 2 + cut + 1;
    }
    const piece = text.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= text.length) break;
    start = Math.max(end - OVERLAP, start + 1);
  }
  return out;
}

/** Whether a path (relative to the work folder) points inside the library folder. */
export function insideLibrary(file: string) {
  const full = resolve(WORKDIR, file);
  return full.startsWith(LIBRARY_DIR + sep) && !full.startsWith(INDEX_DIR + sep);
}

const safeName = (name: string) =>
  basename(name)
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/^\.+/, "")
    .slice(0, 120) || "tai-lieu";

/** Reference documents the agents can search and quote. */
export class Library {
  private docs = new Map<string, LibraryDoc>();
  private chunks: Chunk[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;
  private value: LibrarySettings = { ...DEFAULT_LIBRARY_SETTINGS };

  constructor(private store: Store) {}

  async init() {
    await mkdir(INDEX_DIR, { recursive: true });
    const saved = await this.store.db?.loadSetting<Partial<LibrarySettings>>("library");
    if (saved) this.value = { ...this.value, ...validateLibrarySettings(saved, true) };
    for (const f of await readdir(INDEX_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(await readFile(join(INDEX_DIR, f), "utf8")) as Stored;
        // the index lives in the agents' work folder: never trust a path that leaves the library
        if (!insideLibrary(s.file) || !/^[0-9a-f-]{36}$/.test(s.id)) continue;
        // a file removed by hand leaves its index entry behind
        if (!existsSync(join(WORKDIR, s.file))) continue;
        this.addToIndex(s);
      } catch (e) {
        console.warn(`[library] bỏ qua ${f}: ${(e as Error).message}`);
      }
    }
    this.recompute();
    if (this.docs.size) console.log(`[library] ${this.docs.size} tài liệu, ${this.chunks.length} đoạn`);
  }

  get settings() {
    return this.value;
  }

  async updateSettings(patch: unknown) {
    this.value = { ...this.value, ...validateLibrarySettings(patch) };
    await this.store.db?.saveSetting("library", this.value);
    return this.value;
  }

  list(): LibraryDoc[] {
    return [...this.docs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string) {
    return this.docs.get(id);
  }

  async text(id: string) {
    if (!this.docs.has(id)) throw Object.assign(new Error("Không có tài liệu này"), { statusCode: 404 });
    return ((JSON.parse(await readFile(join(INDEX_DIR, `${id}.json`), "utf8")) as Stored).text);
  }

  async add(name: string, data: Buffer, createdBy?: string): Promise<LibraryDoc> {
    const ext = extname(name).slice(1).toLowerCase();
    if (!LIBRARY_TYPES.includes(ext)) throw new Error(`Chưa hỗ trợ file .${ext || "?"} (được: ${LIBRARY_TYPES.join(", ")})`);
    if (!data.length) throw new Error("File rỗng");
    if (data.length > MAX_FILE_BYTES) throw new Error("File lớn hơn 20 MB");
    if (this.docs.size >= MAX_DOCS) throw new Error(`Thư viện tối đa ${MAX_DOCS} tài liệu`);
    let text = "";
    let warning: string | undefined;
    try {
      text = await extractText(name, data);
      if (!text) warning = ext === "pdf" ? "Không đọc được chữ (có thể là bản scan): agent vẫn mở được file gốc" : "File không có nội dung chữ";
    } catch (e) {
      warning = `Không đọc được nội dung: ${(e as Error).message}`;
    }
    // keep the original name; add a number when it is taken
    const base = safeName(name);
    let file = base;
    for (let n = 2; existsSync(join(LIBRARY_DIR, file)); n++) file = base.replace(/(\.[^.]*)?$/, (e) => ` (${n})${e}`);
    const id = randomUUID();
    await writeFile(join(LIBRARY_DIR, file), data);
    const chunks = text ? chunkText(text).length : 0;
    const doc: Stored = {
      id,
      name: basename(name),
      file: relative(WORKDIR, join(LIBRARY_DIR, file)),
      size: data.length,
      chars: text.length,
      chunks,
      createdBy,
      createdAt: Date.now(),
      warning,
      text,
    };
    await writeFile(join(INDEX_DIR, `${id}.json`), JSON.stringify(doc));
    this.addToIndex(doc);
    this.recompute();
    const { text: _t, ...meta } = doc;
    return meta;
  }

  async remove(id: string) {
    const doc = this.docs.get(id);
    if (!doc) throw Object.assign(new Error("Không có tài liệu này"), { statusCode: 404 });
    await rm(join(WORKDIR, doc.file), { force: true });
    await rm(join(INDEX_DIR, `${id}.json`), { force: true });
    this.docs.delete(id);
    this.chunks = this.chunks.filter((c) => c.doc !== id);
    this.recompute();
  }

  private addToIndex(s: Stored) {
    const { text, ...meta } = s;
    this.docs.set(s.id, meta);
    if (!text) return;
    chunkText(text).forEach((t, idx) => {
      const tf = new Map<string, number>();
      // the file name counts as part of every passage, so "hợp đồng" finds hop-dong.docx
      const words = [...terms(t), ...terms(s.name.replace(/[-_.]/g, " "))];
      for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
      this.chunks.push({ doc: s.id, idx, text: t, tf, len: words.length });
    });
  }

  private recompute() {
    this.df.clear();
    let total = 0;
    for (const c of this.chunks) {
      total += c.len;
      for (const w of c.tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
    }
    this.avgLen = this.chunks.length ? total / this.chunks.length : 1;
  }

  /** BM25 over the passages; scores are scaled to 0..1 for display. */
  search(query: string, limit = 5): LibraryHit[] {
    const q = [...new Set(terms(query))];
    if (!q.length || !this.chunks.length) return [];
    const N = this.chunks.length;
    const k1 = 1.2;
    const b = 0.75;
    const scored: { c: Chunk; score: number; hits: number }[] = [];
    for (const c of this.chunks) {
      let score = 0;
      let hits = 0;
      for (const w of q) {
        const f = c.tf.get(w);
        if (!f) continue;
        hits++;
        const idf = Math.log(1 + (N - this.df.get(w)! + 0.5) / (this.df.get(w)! + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.len) / this.avgLen));
      }
      if (score > 0) scored.push({ c, score: score * (0.5 + (0.5 * hits) / q.length), hits });
    }
    scored.sort((a, b) => b.score - a.score);
    // at most two passages from one document, so one long file does not crowd out the rest
    const perDoc = new Map<string, number>();
    const top = scored.filter((s) => {
      const n = perDoc.get(s.c.doc) ?? 0;
      perDoc.set(s.c.doc, n + 1);
      return n < 2;
    });
    const best = top[0]?.score ?? 1;
    return top.slice(0, Math.max(1, Math.min(limit, 20))).map((s) => {
      const doc = this.docs.get(s.c.doc)!;
      return { docId: doc.id, name: doc.name, file: doc.file, chunk: s.c.idx, text: s.c.text, score: Math.round((s.score / best) * (s.hits / q.length) * 100) / 100 };
    });
  }
}

export function validateLibrarySettings(raw: unknown, partial = false): Partial<LibrarySettings> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: Partial<LibrarySettings> = {};
  if (r.autoContext !== undefined) {
    if (typeof r.autoContext !== "boolean") throw new Error("autoContext phải là true/false");
    out.autoContext = r.autoContext;
  }
  if (r.contextChunks !== undefined) {
    const n = Number(r.contextChunks);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error("Số đoạn tài liệu tự đưa vào phải từ 1 đến 10");
    out.contextChunks = n;
  }
  if (!partial && !Object.keys(out).length) throw new Error("Không có gì để đổi");
  return out;
}

/** The passages put into an agent's instructions, with where they come from. */
export function librarySection(hits: LibraryHit[]) {
  return [
    "## Tài liệu tham khảo liên quan",
    "Trích từ thư viện tài liệu của văn phòng. Khi dùng, ghi rõ nguồn (tên file). Mở file gốc bằng đường dẫn nếu cần đọc thêm:",
    ...hits.map((h) => `### ${h.name} (đoạn ${h.chunk + 1}, file: ${h.file})\n${h.text.slice(0, 1200)}`),
    "Dùng library_search để tìm thêm trong thư viện.",
  ].join("\n\n");
}
