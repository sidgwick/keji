import { Keji, type VideoTarget } from "./keji.ts";

interface MarkdownSection {
  level: number;
  title: string;
  content: string[];
  children: MarkdownSection[];
  childIndex: Map<string, MarkdownSection>;
}

export function mergeMarkdownSections(markdowns: string[]): string {
  const root: MarkdownSection = { level: 0, title: "", content: [], children: [], childIndex: new Map() };
  for (const markdown of Array.isArray(markdowns) ? markdowns : []) {
    const stack: MarkdownSection[] = [root];
    let pending: string[] = [];
    let fence: string | null = null;
    const flush = () => {
      const block = pending.join("\n").trim();
      if (block) stack.at(-1)!.content.push(block);
      pending = [];
    };
    for (const line of String(markdown || "").split(/\r?\n/)) {
      const fenceLine = line.match(/^\s*(`{3,}|~{3,})/);
      if (fenceLine) {
        const marker = fenceLine[1]![0]!;
        if (!fence) fence = marker;
        else if (fence === marker) fence = null;
        pending.push(line);
        continue;
      }
      const heading = !fence ? line.match(/^(#{1,6})\s+(.+)\s*#*\s*$/) : null;
      if (!heading) {
        pending.push(line);
        continue;
      }
      flush();
      const level = heading[1]!.length;
      while (stack.at(-1)!.level >= level) stack.pop();
      const parent = stack.at(-1)!;
      const title = heading[2]!.trim();
      const key = title.toLocaleLowerCase().replace(/\s+/g, " ");
      let section = parent.childIndex.get(key);
      if (!section) {
        section = { level, title, content: [], children: [], childIndex: new Map() };
        parent.childIndex.set(key, section);
        parent.children.push(section);
      }
      stack.push(section);
    }
    flush();
  }
  const render = (section: MarkdownSection): string => {
    const blocks: string[] = [];
    if (section.level) blocks.push(`${"#".repeat(section.level)} ${section.title}`);
    blocks.push(...section.content, ...section.children.map(render));
    return blocks.filter(Boolean).join("\n\n");
  };
  return render(root);
}

export function noteExcerpt(markdown?: string): string {
  return String(markdown || "")
    .replace(/!\[([^\]]*)\]\(data:image\/[^;]+;base64,[^)]+\)/g, " $1 ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, " $1 ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

export function formatNoteMarkdown(title: string, video: VideoTarget, bodyMarkdown: string): string {
  return `# ${title}\n\n> ${video.part || "当前分 P"} · 第 ${video.page || 1}/${video.pageCount || 1} 节 · [视频链接](${video.url || ""})\n\n${bodyMarkdown}`;
}

export function noteBodyMarkdown(markdown: string): string {
  return String(markdown || "").replace(/^#[^\n]*\n\n>[^\n]*\n\n/, "");
}

export function restoreScreenshotEmbeds(updatedMarkdown: string, previousMarkdown: string): string {
  const screenshots = [...previousMarkdown.matchAll(/!\[([^\]]*)\]\((data:image\/[^;]+;base64,[^)]+)\)/g)];
  let output = updatedMarkdown;
  for (const [whole, alt, dataUrl] of screenshots) {
    const placeholder = `[视频关键帧：${alt}]`;
    if (output.includes(placeholder)) output = output.replace(placeholder, whole);
    else if (!output.includes(dataUrl!)) output += `\n\n> 关键帧 · ${alt}\n\n${whole}`;
  }
  return output;
}

function createTimestampNode(label: string, videoUrl?: string | null): Node {
  const seconds = Keji.parseTime(label);
  if (seconds !== null && videoUrl) {
    try {
      const parsed = new URL(videoUrl);
      if (/(^|\.)bilibili\.com$/i.test(parsed.hostname) && /^\/video\/BV[\w]+/i.test(parsed.pathname)) {
        parsed.searchParams.set("t", String(seconds));
        const link = document.createElement("a");
        link.href = parsed.toString();
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = "timestamp-link";
        link.title = `在 B 站跳到 ${label}`;
        link.textContent = label;
        return link;
      }
    } catch {
      // Fall back to plain text node when video URL is unavailable or invalid.
    }
  }
  return document.createTextNode(label);
}

export function renderMessageWithTimestamps(container: HTMLElement, text: string, videoUrl?: string | null): void {
  const fragment = document.createDocumentFragment();
  const source = String(text || "");
  const pattern = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    fragment.append(document.createTextNode(source.slice(offset, match.index)));
    fragment.append(createTimestampNode(match[1]!, videoUrl));
    offset = (match.index || 0) + match[0].length;
  }
  fragment.append(document.createTextNode(source.slice(offset)));
  container.replaceChildren(fragment);
}

export function renderMarkdownPreview(markdown: string, sourceVideo: VideoTarget | null = null): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "markdown-body";
  const lines = String(markdown || "").split(/\r?\n/);

  const appendInline = (parent: HTMLElement, source: string) => {
    const pattern = /(!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\$([^\s$][^$\n]*?[^\s$]|[^\s$])\$|\*\*([^*]+)\*\*|\*([^*]+)\*|\[(\d{1,2}:\d{2}(?::\d{2})?)\])/g;
    let offset = 0;
    for (const match of source.matchAll(pattern)) {
      parent.append(document.createTextNode(source.slice(offset, match.index)));
      if (match[1]?.startsWith("![")) {
        if (/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(match[3]!)) {
          const image = document.createElement("img");
          image.src = match[3]!;
          image.alt = match[2] || "";
          image.loading = "lazy";
          parent.append(image);
        } else parent.append(document.createTextNode(match[2] || "[图片链接未显示]"));
      } else if (match[4]) {
        const link = document.createElement("a");
        link.href = match[5]!;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = match[4];
        parent.append(link);
      } else if (match[10]) {
        parent.append(createTimestampNode(match[10], sourceVideo?.url));
      } else if (match[6]) {
        const code = document.createElement("code");
        code.textContent = match[6];
        parent.append(code);
      } else if (match[7]) {
        const math = document.createElement("code");
        math.className = "math-inline";
        math.textContent = match[7];
        parent.append(math);
      } else {
        const emphasis = document.createElement(match[8] ? "strong" : "em");
        emphasis.textContent = match[8] || match[9] || "";
        parent.append(emphasis);
      }
      offset = (match.index || 0) + match[0].length;
    }
    parent.append(document.createTextNode(source.slice(offset)));
  };

  const startsBlock = (line: string) => /^(?:#{1,6}\s|```|\$\$|\s*>|\s*[-*+]\s+|\s*\d+[.)]\s+|\s*(?:---+|___+|\*\*\*+)\s*$)/.test(line);
  const isTableRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  const tableCells = (line: string) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
  const listPattern = /^(\s*)([-*+]\s+|\d+[.)]\s+)(.*)$/;

  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index += 1; continue; }
    if (/^```/.test(line)) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index]!)) codeLines.push(lines[index++]!);
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.append(code);
      root.append(pre);
      continue;
    }
    if (/^\s*\$\$/.test(line)) {
      const trimmed = line.trim();
      const mathBlock = document.createElement("div");
      mathBlock.className = "math-block";
      if (trimmed.length > 4 && trimmed.endsWith("$$")) {
        mathBlock.textContent = trimmed.slice(2, -2).trim();
        index += 1;
      } else {
        const mathLines = [trimmed.slice(2)];
        index += 1;
        while (index < lines.length && !/\$\$\s*$/.test(lines[index]!)) mathLines.push(lines[index++]!);
        if (index < lines.length) mathLines.push(lines[index++]!.replace(/\$\$\s*$/, ""));
        mathBlock.textContent = mathLines.join("\n").trim();
      }
      root.append(mathBlock);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const node = document.createElement(`h${heading[1]!.length}`);
      appendInline(node, heading[2]!);
      root.append(node);
      index += 1;
      continue;
    }
    if (index + 1 < lines.length && /^\s*\|/.test(line) && isTableRule(lines[index + 1]!)) {
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const header = document.createElement("tr");
      for (const value of tableCells(line)) {
        const cell = document.createElement("th");
        appendInline(cell, value);
        header.append(cell);
      }
      head.append(header);
      table.append(head);
      index += 2;
      const body = document.createElement("tbody");
      while (index < lines.length && /^\s*\|/.test(lines[index]!)) {
        const row = document.createElement("tr");
        for (const value of tableCells(lines[index++]!)) {
          const cell = document.createElement("td");
          appendInline(cell, value);
          row.append(cell);
        }
        body.append(row);
      }
      table.append(body);
      root.append(table);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = document.createElement("blockquote");
      while (index < lines.length && /^\s*>/.test(lines[index]!)) {
        const paragraph = document.createElement("p");
        appendInline(paragraph, lines[index++]!.replace(/^\s*>\s?/, ""));
        quote.append(paragraph);
      }
      root.append(quote);
      continue;
    }
    const firstList = line.match(listPattern);
    if (firstList) {
      const rootOrdered = /^\d/.test(firstList[2]!);
      const rootList = document.createElement(rootOrdered ? "ol" : "ul");
      const stack: Array<{ depth: number; ordered: boolean; listEl: HTMLElement; lastLi: HTMLLIElement | null }> = [
        { depth: Math.floor(firstList[1]!.replace(/\t/g, "  ").length / 2), ordered: rootOrdered, listEl: rootList, lastLi: null }
      ];
      while (index < lines.length) {
        const match = lines[index]!.match(listPattern);
        if (!match) break;
        const depth = Math.floor(match[1]!.replace(/\t/g, "  ").length / 2);
        const ordered = /^\d/.test(match[2]!);
        if (depth === stack[0]!.depth && ordered !== stack[0]!.ordered && stack.length === 1) break;
        if (depth > stack.at(-1)!.depth && stack.at(-1)!.lastLi) {
          const nested = document.createElement(ordered ? "ol" : "ul");
          stack.at(-1)!.lastLi!.append(nested);
          stack.push({ depth, ordered, listEl: nested, lastLi: null });
        } else {
          while (stack.length > 1 && depth < stack.at(-1)!.depth) stack.pop();
          if (ordered !== stack.at(-1)!.ordered && stack.length > 1) {
            const parentLi = stack[stack.length - 2]!.lastLi;
            stack.pop();
            if (parentLi) {
              const sibling = document.createElement(ordered ? "ol" : "ul");
              parentLi.append(sibling);
              stack.push({ depth, ordered, listEl: sibling, lastLi: null });
            }
          }
        }
        const item = document.createElement("li");
        const task = match[3]!.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) {
          item.className = "task-list-item";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.disabled = true;
          checkbox.checked = task[1]!.toLowerCase() === "x";
          item.append(checkbox);
          appendInline(item, task[2]!);
        } else {
          appendInline(item, match[3]!);
        }
        stack.at(-1)!.listEl.append(item);
        stack.at(-1)!.lastLi = item;
        index += 1;
      }
      root.append(rootList);
      continue;
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      root.append(document.createElement("hr"));
      index += 1;
      continue;
    }
    const paragraph = document.createElement("p");
    const paragraphLines: string[] = [];
    while (index < lines.length && lines[index]!.trim() && !startsBlock(lines[index]!)
      && !(index + 1 < lines.length && /^\s*\|/.test(lines[index]!) && isTableRule(lines[index + 1]!))) {
      paragraphLines.push(lines[index++]!);
    }
    paragraphLines.forEach((part, partIndex) => {
      if (partIndex) paragraph.append(document.createElement("br"));
      appendInline(paragraph, part);
    });
    root.append(paragraph);
  }
  return root;
}
