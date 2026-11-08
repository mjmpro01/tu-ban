import { inflateRawSync, inflateSync, unzipSync } from "node:zlib";

/**
 * Plain text out of the document types the library accepts, with no third-party code.
 * PDF support covers text PDFs (Word / browser / LaTeX exports, with or without embedded
 * fonts); scanned pages are images and give no text.
 */
export async function extractText(name: string, data: Buffer): Promise<string> {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return tidy(pdfText(data));
  if (ext === "docx") return tidy(docxText(data));
  const text = decodeText(data);
  if (ext === "html" || ext === "htm") return tidy(htmlText(text));
  return tidy(text);
}

export const LIBRARY_TYPES = ["pdf", "docx", "md", "markdown", "txt", "csv", "tsv", "json", "html", "htm", "xml", "yaml", "yml", "log"];

function tidy(s: string) {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .normalize("NFC")
    .trim();
}

function decodeText(data: Buffer) {
  if (data[0] === 0xff && data[1] === 0xfe) return data.subarray(2).toString("utf16le");
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return data.subarray(3).toString("utf8");
  return data.toString("utf8");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function htmlText(html: string) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote|pre)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  );
}

// ---------------------------------------------------------------- DOCX (a zip of XML)

/** Read one file out of a zip archive (stored or deflated entries). */
export function unzipEntry(zip: Buffer, wanted: string): Buffer | undefined {
  // end of central directory: the last 0x06054b50 signature
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Không phải file zip hợp lệ");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) break;
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (name === wanted) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const raw = zip.subarray(start, start + size);
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`Kiểu nén zip ${method} chưa hỗ trợ`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return undefined;
}

function docxText(data: Buffer) {
  const xml = unzipEntry(data, "word/document.xml");
  if (!xml) throw new Error("File .docx không có word/document.xml");
  return decodeEntities(
    xml
      .toString("utf8")
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tc>/g, "\t")
      .replace(/<[^>]+>/g, ""),
  );
}

// ---------------------------------------------------------------- PDF

type PdfObj = { dict: string; stream?: Buffer };

function inflate(buf: Buffer): Buffer {
  for (const f of [inflateSync, unzipSync, inflateRawSync]) {
    try {
      return f(buf);
    } catch {}
  }
  // a truncated stream still often holds most of its text
  try {
    return inflateSync(buf, { finishFlush: 2 /* Z_SYNC_FLUSH */ });
  } catch {
    return Buffer.alloc(0);
  }
}

/** All objects of the file, including the ones packed in object streams (PDF 1.5+). */
function readObjects(pdf: Buffer): Map<number, PdfObj> {
  const s = pdf.toString("latin1");
  const objs = new Map<number, PdfObj>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = s.indexOf("endobj", start);
    if (end < 0) break;
    const body = s.slice(start, end);
    const si = body.search(/\bstream\r?\n/);
    if (si < 0) {
      objs.set(num, { dict: body });
    } else {
      const dict = body.slice(0, si);
      const dataStart = start + si + body.slice(si).match(/^stream\r?\n/)![0].length;
      const lenMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      let dataEnd = lenMatch ? dataStart + Number(lenMatch[1]) : -1;
      if (dataEnd < 0 || dataEnd > end || !/^\s*endstream/.test(s.slice(dataEnd, dataEnd + 20))) {
        dataEnd = s.lastIndexOf("endstream", end);
      }
      let stream = pdf.subarray(dataStart, Math.max(dataStart, dataEnd));
      if (/\/FlateDecode/.test(dict)) stream = inflate(stream);
      else if (/\/Filter/.test(dict)) stream = Buffer.alloc(0); // images and other filters carry no text
      objs.set(num, { dict, stream });
    }
    re.lastIndex = end;
  }
  // object streams
  for (const o of [...objs.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict) || !o.stream?.length) continue;
    const n = Number(/\/N\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
    const text = o.stream.toString("latin1");
    const head = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = head[i * 2];
      const off = first + head[i * 2 + 1];
      const next = i + 1 < n ? first + head[i * 2 + 3] : text.length;
      if (!objs.has(num)) objs.set(num, { dict: text.slice(off, next) });
    }
  }
  return objs;
}

const ref = (dict: string, key: string) => {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return m ? Number(m[1]) : undefined;
};

/** The inline dictionary after a key, or the dictionary of the object it references. */
function subDict(objs: Map<number, PdfObj>, dict: string, key: string): string | undefined {
  const r = ref(dict, key);
  if (r !== undefined) return objs.get(r)?.dict;
  const i = dict.search(new RegExp(`/${key}\\s*<<`));
  if (i < 0) return undefined;
  let depth = 0;
  for (let j = dict.indexOf("<<", i); j < dict.length - 1; j++) {
    if (dict[j] === "<" && dict[j + 1] === "<") {
      depth++;
      j++;
    } else if (dict[j] === ">" && dict[j + 1] === ">") {
      depth--;
      j++;
      if (!depth) return dict.slice(dict.indexOf("<<", i) + 2, j - 1);
    }
  }
  return undefined;
}

type CMap = { bytes: number; map: Map<number, string> };

function hexToUnicode(hex: string) {
  let out = "";
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  if (hex.length === 2) out = String.fromCharCode(parseInt(hex, 16));
  return out;
}

function parseCMap(text: string): CMap {
  const map = new Map<number, string>();
  let bytes = 1;
  const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(text);
  if (cs) bytes = cs[1].length / 2;
  for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(parseInt(m[1], 16), hexToUnicode(m[2]));
      bytes = Math.max(bytes, m[1].length / 2);
    }
  }
  for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      bytes = Math.max(bytes, m[1].length / 2);
      if (m[3].startsWith("[")) {
        const items = [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => hexToUnicode(x[1]));
        items.forEach((u, k) => lo + k <= hi && map.set(lo + k, u));
      } else {
        const base = hexToUnicode(m[3].slice(1, -1));
        for (let c = lo; c <= hi && c - lo < 65536; c++)
          map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo)));
      }
    }
  }
  return { bytes, map };
}

/** Byte strings in content streams: literal (…) with escapes, or hex <…>. */
function readString(src: string, i: number): [Buffer, number] {
  if (src[i] === "<") {
    const end = src.indexOf(">", i);
    let hex = src.slice(i + 1, end).replace(/\s+/g, "");
    if (hex.length % 2) hex += "0";
    return [Buffer.from(hex, "hex"), end + 1];
  }
  const out: number[] = [];
  let depth = 1;
  let j = i + 1;
  for (; j < src.length && depth; j++) {
    const c = src[j];
    if (c === "\\") {
      const n = src[++j];
      const esc: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
      if (n in esc) out.push(esc[n]);
      else if (/[0-7]/.test(n)) {
        let oct = n;
        while (oct.length < 3 && /[0-7]/.test(src[j + 1])) oct += src[++j];
        out.push(parseInt(oct, 8) & 255);
      } else if (n === "\r") {
        if (src[j + 1] === "\n") j++;
      } else if (n !== "\n") out.push(n.charCodeAt(0));
    } else {
      if (c === "(") depth++;
      if (c === ")" && --depth === 0) break;
      out.push(c.charCodeAt(0) & 255);
    }
  }
  return [Buffer.from(out), j + 1];
}

function decodeBytes(b: Buffer, cmap?: CMap) {
  if (!cmap) return b.toString("latin1");
  let out = "";
  for (let i = 0; i < b.length; i += cmap.bytes) {
    const code = cmap.bytes === 2 ? (b[i] << 8) | (b[i + 1] ?? 0) : b[i];
    out += cmap.map.get(code) ?? (cmap.bytes === 1 ? String.fromCharCode(code) : "");
  }
  return out;
}

/** Run the text operators of one content stream. */
function contentText(src: string, fonts: Map<string, CMap | undefined>): string {
  let out = "";
  let font: CMap | undefined;
  const stack: (string | number | Buffer | (Buffer | number)[])[] = [];
  let lastY: number | undefined;
  let size = 12;
  /** Rough end of the last text run on the line (0.5 em per character), to tell kerning from word gaps. */
  let endX: number | undefined;
  let scale = 1;
  /** Start of the current line (Td moves are relative to it). */
  let lineX = 0;
  let i = 0;
  const advance = (chars: number) => {
    if (endX !== undefined) endX += chars * size * scale * 0.5;
  };
  const newline = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "%") {
      i = src.indexOf("\n", i) + 1 || src.length;
    } else if (c === "(" || (c === "<" && src[i + 1] !== "<")) {
      const [b, j] = readString(src, i);
      stack.push(b);
      i = j;
    } else if (c === "[") {
      const arr: (Buffer | number)[] = [];
      i++;
      while (i < src.length && src[i] !== "]") {
        if (src[i] === "(" || src[i] === "<") {
          const [b, j] = readString(src, i);
          arr.push(b);
          i = j;
        } else if (/[-+.\d]/.test(src[i])) {
          const m = /^[-+]?\d*\.?\d+/.exec(src.slice(i, i + 32));
          if (m) {
            arr.push(Number(m[0]));
            i += m[0].length;
          } else i++;
        } else i++;
      }
      stack.push(arr);
      i++;
    } else if (c === "/") {
      const m = /^\/[^\s/<>[\]()]+/.exec(src.slice(i, i + 128))!;
      stack.push(m[0]);
      i += m[0].length;
    } else if (c === "<" && src[i + 1] === "<") {
      // inline dictionaries (marked content): skip
      const end = src.indexOf(">>", i);
      i = end < 0 ? src.length : end + 2;
    } else if (/[-+.\d]/.test(c)) {
      const m = /^[-+]?\d*\.?\d+/.exec(src.slice(i, i + 32));
      if (m) {
        stack.push(Number(m[0]));
        i += m[0].length;
      } else i++;
    } else {
      const m = /^[A-Za-z'"*]+/.exec(src.slice(i, i + 8));
      const op = m ? m[0] : c;
      i += op.length;
      if (op === "BI") {
        // inline image data
        const end = src.indexOf("EI", i);
        i = end < 0 ? src.length : end + 2;
      } else if (op === "Tf") {
        const name = stack[stack.length - 2];
        font = typeof name === "string" ? fonts.get(name.slice(1)) : undefined;
        const sz = stack[stack.length - 1];
        if (typeof sz === "number" && sz > 0) size = sz;
      } else if (op === "Tj" || op === "'" || op === '"') {
        if (op !== "Tj") newline();
        const b = stack[stack.length - 1];
        if (Buffer.isBuffer(b)) {
          const t = decodeBytes(b, font);
          out += t;
          advance(t.length);
        }
      } else if (op === "TJ") {
        const arr = stack[stack.length - 1];
        if (Array.isArray(arr))
          for (const x of arr) {
            if (typeof x === "number") {
              if (x < -200 && !out.endsWith(" ")) out += " ";
            } else {
              const t = decodeBytes(x, font);
              out += t;
              advance(t.length);
            }
          }
      } else if (op === "Td" || op === "TD") {
        const [x, y] = stack.slice(-2);
        if (typeof y === "number" && Math.abs(y) > 0.5) newline();
        else if (typeof x === "number") {
          // same line: kerning moves are small, a word gap is wider than the text drawn so far
          const to = lineX + x;
          if (endX !== undefined && to - endX > size * scale * 0.6 && !out.endsWith(" ") && !out.endsWith("\n")) out += " ";
        }
        if (typeof x === "number") {
          lineX += x;
          endX = lineX;
        }
      } else if (op === "Tm") {
        const [a, , , , x, y] = stack.slice(-6);
        if (typeof y === "number" && typeof x === "number") {
          if (lastY !== undefined && Math.abs(y - lastY) > 0.5) newline();
          // same line: a space only when there is a real gap since the last run
          else if (lastY !== undefined && endX !== undefined && x - endX > size * scale * 0.6 && !out.endsWith(" ")) out += " ";
          lastY = y;
          scale = typeof a === "number" && a > 0 ? a : 1;
          endX = x;
          lineX = x;
        }
      } else if (op === "T*" || op === "ET") {
        if (op === "T*") newline();
        else if (!out.endsWith("\n") && !out.endsWith(" ")) out += " ";
      }
      stack.length = 0;
    }
  }
  return out;
}

function pdfText(pdf: Buffer): string {
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("Không phải file PDF");
  if (/\/Encrypt\s/.test(pdf.toString("latin1"))) throw new Error("PDF có mật khẩu / mã hoá, không đọc được nội dung");
  const objs = readObjects(pdf);
  const cmaps = new Map<number, CMap | undefined>();
  const fontCMap = (fontObj?: string) => {
    if (!fontObj) return undefined;
    const r = ref(fontObj, "ToUnicode");
    if (r === undefined) return undefined;
    if (!cmaps.has(r)) {
      const s = objs.get(r)?.stream;
      cmaps.set(r, s ? parseCMap(s.toString("latin1")) : undefined);
    }
    return cmaps.get(r);
  };
  const pages = [...objs.entries()]
    .filter(([, o]) => /\/Type\s*\/Page(?!s)\b/.test(o.dict))
    .sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  for (const [, page] of pages) {
    // resources may be inherited from the parent Pages node
    let res = subDict(objs, page.dict, "Resources");
    let parent = ref(page.dict, "Parent");
    for (let k = 0; !res && parent !== undefined && k < 20; k++) {
      const p = objs.get(parent)?.dict ?? "";
      res = subDict(objs, p, "Resources");
      parent = ref(p, "Parent");
    }
    const fonts = new Map<string, CMap | undefined>();
    const fontDict = res ? subDict(objs, res, "Font") : undefined;
    if (fontDict) for (const m of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) fonts.set(m[1], fontCMap(objs.get(Number(m[2]))?.dict));
    const contents = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(page.dict)?.[1] ?? "";
    const text = [...contents.matchAll(/(\d+)\s+\d+\s+R/g)]
      .map((m) => objs.get(Number(m[1]))?.stream?.toString("latin1") ?? "")
      .join("\n");
    parts.push(contentText(text, fonts));
  }
  return parts.join("\n\n");
}
