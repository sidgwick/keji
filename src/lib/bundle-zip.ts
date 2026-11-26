import { NOTE_DOCUMENT_STRUCTURES, type NoteViewKey } from "./note-structures.ts";

export function safeFilename(value?: string, fallback = "课程笔记"): string {
  return String(value || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .trim()
    .slice(0, 70) || fallback;
}

interface ZipFileEntry {
  path: string;
  data: Uint8Array | string;
}

function rewriteEmbeddedImages(
  markdown: string,
  prefix = ""
): { markdown: string; files: Array<{ path: string; data: Uint8Array }> } {
  const files: Array<{ path: string; data: Uint8Array }> = [];
  let index = 0;
  const rewritten = String(markdown || "").replace(
    /!\[([^\]]*)\]\(data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)\)/gi,
    (_whole, alt: string, format: string, encoded: string) => {
      index += 1;
      const timestamp = alt.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)/)?.[1]?.replace(/:/g, "-") || "frame";
      const extension = format.toLowerCase() === "jpeg" ? "jpg" : format.toLowerCase();
      const filePath = `assets/${prefix ? `${prefix}-` : ""}${String(index).padStart(2, "0")}-${timestamp}.${extension}`;
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let offset = 0; offset < binary.length; offset += 1) bytes[offset] = binary.charCodeAt(offset);
      files.push({ path: filePath, data: bytes });
      return `![${alt}](${filePath})`;
    }
  );
  return { markdown: rewritten, files };
}

function createStoredZip(files: ZipFileEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    crcTable[n] = value >>> 0;
  }
  const crc32 = (bytes: Uint8Array) => {
    let crc = 0xFFFFFFFF;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xFF]! ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  };
  const entries = files.map((file) => {
    const filePath = String(file.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!filePath || filePath.split("/").some((part) => part === "..")) throw new Error("ZIP 文件路径无效。");
    const name = encoder.encode(filePath);
    const data = file.data instanceof Uint8Array ? file.data : encoder.encode(String(file.data ?? ""));
    return { name, data, crc: crc32(data) };
  });
  if (entries.length > 0xFFFF) throw new Error("ZIP 文件数量超出格式上限。");

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const header = (length: number, write: (view: DataView) => void) => {
    const bytes = new Uint8Array(length);
    write(new DataView(bytes.buffer));
    return bytes;
  };
  for (const entry of entries) {
    if (entry.data.length > 0xFFFFFFFF || offset > 0xFFFFFFFF) throw new Error("ZIP 文件超过 4 GB 上限。");
    const local = header(30, (view) => {
      view.setUint32(0, 0x04034B50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x0800, true);
      view.setUint16(8, 0, true); view.setUint16(10, 0, true); view.setUint16(12, 0x0021, true);
      view.setUint32(14, entry.crc, true); view.setUint32(18, entry.data.length, true); view.setUint32(22, entry.data.length, true);
      view.setUint16(26, entry.name.length, true); view.setUint16(28, 0, true);
    });
    localParts.push(local, entry.name, entry.data);
    const central = header(46, (view) => {
      view.setUint32(0, 0x02014B50, true); view.setUint16(4, 20, true); view.setUint16(6, 20, true);
      view.setUint16(8, 0x0800, true); view.setUint16(10, 0, true); view.setUint16(12, 0, true); view.setUint16(14, 0x0021, true);
      view.setUint32(16, entry.crc, true); view.setUint32(20, entry.data.length, true); view.setUint32(24, entry.data.length, true);
      view.setUint16(28, entry.name.length, true); view.setUint16(30, 0, true); view.setUint16(32, 0, true);
      view.setUint16(34, 0, true); view.setUint16(36, 0, true); view.setUint32(38, 0, true); view.setUint32(42, offset, true);
    });
    centralParts.push(central, entry.name);
    offset += local.length + entry.name.length + entry.data.length;
  }
  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = header(22, (view) => {
    view.setUint32(0, 0x06054B50, true); view.setUint16(4, 0, true); view.setUint16(6, 0, true);
    view.setUint16(8, entries.length, true); view.setUint16(10, entries.length, true);
    view.setUint32(12, centralSize, true); view.setUint32(16, centralOffset, true); view.setUint16(20, 0, true);
  });
  const zip = new Uint8Array(offset + centralSize + end.length);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    zip.set(part, cursor);
    cursor += part.length;
  }
  return zip;
}

export function createNoteBundleZip(note: {
  title?: string;
  markdown: string;
  views?: Partial<Record<NoteViewKey, string>>;
  flashcardMarkdown?: string;
  quizMarkdown?: string;
  personalNote?: string;
}): {
  filename: string;
  zip: Uint8Array;
  imageCount: number;
} {
  const folder = safeFilename(note.title || "课程笔记");
  const docEntries: Array<{ prefix: string; filename: string; markdown: string }> = [];
  for (const item of NOTE_DOCUMENT_STRUCTURES) {
    const content = String(note.views?.[item.id] || "").trim();
    if (content) docEntries.push({ prefix: item.id, filename: `${item.label}.md`, markdown: content });
  }
  const hasViewEntries = docEntries.length > 0;
  const flashcardMd = String(note.flashcardMarkdown || "").trim();
  if (flashcardMd) docEntries.push({ prefix: "flashcards", filename: "记忆闪卡.md", markdown: flashcardMd });
  const quizMd = String(note.quizMarkdown || "").trim();
  if (quizMd) docEntries.push({ prefix: "quiz", filename: "随堂自测.md", markdown: quizMd });
  const rawPersonal = String(note.personalNote || "").trim();
  const personalMd = rawPersonal ? `# 我的批注\n\n${rawPersonal}\n` : "";

  if (!docEntries.length) {
    const prepared = rewriteEmbeddedImages(note.markdown || "");
    const files: ZipFileEntry[] = [
      { path: `${folder}/笔记.md`, data: prepared.markdown },
      ...prepared.files.map((file) => ({ ...file, path: `${folder}/${file.path}` }))
    ];
    if (personalMd) files.push({ path: `${folder}/我的批注.md`, data: personalMd });
    return {
      filename: `${folder}-笔记资源包.zip`,
      zip: createStoredZip(files),
      imageCount: prepared.files.length
    };
  }

  const fallbackMd = String(note.markdown || "").trim();
  if (!hasViewEntries && fallbackMd && fallbackMd !== flashcardMd && fallbackMd !== quizMd) {
    docEntries.unshift({ prefix: "note", filename: "笔记.md", markdown: fallbackMd });
  }
  if (personalMd) {
    docEntries.push({ prefix: "personal", filename: "我的批注.md", markdown: personalMd });
  }

  const files: ZipFileEntry[] = [];
  let imageCount = 0;
  const usePrefix = docEntries.length > 1 || hasViewEntries || Boolean(flashcardMd) || Boolean(quizMd);
  for (const entry of docEntries) {
    const prepared = rewriteEmbeddedImages(entry.markdown, usePrefix ? entry.prefix : "");
    files.push({ path: `${folder}/${entry.filename}`, data: prepared.markdown });
    for (const asset of prepared.files) {
      files.push({ ...asset, path: `${folder}/${asset.path}` });
    }
    imageCount += prepared.files.length;
  }
  return {
    filename: `${folder}-笔记资源包.zip`,
    zip: createStoredZip(files),
    imageCount
  };
}
