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
      const key = title
        .replace(/\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\s*$/g, "")
        .toLocaleLowerCase()
        .replace(/\s+/g, " ");
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
  const heading = Keji.formatEpisodeHeading({
    title,
    courseTitle: video?.title,
    part: video?.part,
    page: video?.page,
    pageCount: video?.pageCount,
  });
  const metaParts = [
    heading.courseLabel || Keji.cleanPartTitle(video?.part, video?.page) || "课程笔记",
    video?.url ? `[视频链接](${video.url})` : "",
  ].filter(Boolean);
  return `# ${heading.mainTitle}\n\n> ${metaParts.join(" · ")}\n\n${bodyMarkdown}`;
}

export function noteBodyMarkdown(markdown: string): string {
  return String(markdown || "").replace(/^#[^\n]*\n\n>[^\n]*\n\n/, "");
}

export function extractNoteSummaryPreview(markdown?: string): string {
  const body = noteBodyMarkdown(String(markdown || ""))
    .replace(/!\[([^\]]*)\]\(data:image\/[^;]+;base64,[^)]+\)/g, " ")
    .replace(/\[\[KEYFRAME:[^\]]+\]\]/gi, " ")
    .replace(/```[\s\S]*?```/g, " ");
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s*(?:核心提要|核心主旨|核心公式与速查|实操目标|前置准备)?\s*$/.test(line) && !/^\|/.test(line));
  const candidate = lines.find((line) => line.length >= 6) || lines[0] || "";
  if (!candidate) return "";
  const cleaned = candidate
    .replace(/^\s{0,3}(?:>\s?|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/\*\*(?:核心问题|核心主旨|全片主线|内容提要)\*\*\s*[：:]\s*/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 96 ? `${cleaned.slice(0, 95)}…` : cleaned;
}

export function foldMarkdownImagesForEdit(markdown: string): {
  draft: string;
  imageMap: Map<string, string>;
} {
  const imageMap = new Map<string, string>();
  let index = 0;
  const draft = String(markdown || "").replace(
    /!\[([^\]]*)\]\((data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+)\)/gi,
    (_whole, alt: string, dataUrl: string) => {
      index += 1;
      const token = `keji-frame://${index}`;
      imageMap.set(token, dataUrl);
      return `![${alt}](${token})`;
    }
  );
  return { draft, imageMap };
}

export function unfoldMarkdownImagesFromEdit(
  draft: string,
  imageMap: Map<string, string>
): string {
  if (!imageMap || !imageMap.size) return String(draft || "");
  return String(draft || "").replace(
    /!\[([^\]]*)\]\((keji-frame:\/\/\d+)\)/gi,
    (whole, alt: string, token: string) => {
      const dataUrl = imageMap.get(token);
      return dataUrl ? `![${alt}](${dataUrl})` : whole;
    }
  );
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
    const pattern = /(!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\$\$([^$\n]+?)\$\$|\$([^\s$][^$\n]*?[^\s$]|[^\s$])\$|\*\*([^*]+)\*\*|\*([^*]+)\*|\[(\d{1,2}:\d{2}(?::\d{2})?)\])/g;
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
      } else if (match[11]) {
        parent.append(createTimestampNode(match[11], sourceVideo?.url));
      } else if (match[6]) {
        const code = document.createElement("code");
        code.textContent = match[6];
        parent.append(code);
      } else if (match[7] || match[8]) {
        const math = document.createElement("code");
        math.className = "math-inline";
        math.textContent = (match[7] || match[8] || "").trim();
        parent.append(math);
      } else {
        const emphasis = document.createElement(match[9] ? "strong" : "em");
        emphasis.textContent = match[9] || match[10] || "";
        parent.append(emphasis);
      }
      offset = (match.index || 0) + match[0].length;
    }
    parent.append(document.createTextNode(source.slice(offset)));
  };

  const startsBlock = (line: string) => /^(?:#{1,6}\s|\s*(?:`{3,}|~{3,})|\s*\$\$|\s*>|\s*[-*+]\s+|\s*\d+[.)]\s+|\s*(?:---+|___+|\*\*\*+)\s*$)/.test(line);
  const isTableRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  const tableCells = (line: string) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
  const listPattern = /^(\s*)([-*+]\s+|\d+[.)]\s+)(.*)$/;
  const standaloneImagePattern = /^\s*!\[([^\]]*)\]\((data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+)\)\s*$/i;
  const legacyFrameQuotePattern = /^\s*>\s*\*\*画面要点\s*·[^*]+\*\*[：:]/;

  const consumeFencedCodeBlock = (startIndex: number): { pre: HTMLPreElement; nextIndex: number } => {
    const opener = lines[startIndex]!;
    const indent = (opener.match(/^(\s*)/)?.[1] || "").length;
    const marker = opener.trim().match(/^(`{3,}|~{3,})/)?.[1]?.[0] || "`";
    const closeRe = new RegExp(`^\\s*${marker === "`" ? "`" : "~"}{3,}\\s*$`);
    const codeLines: string[] = [];
    let cursor = startIndex + 1;
    while (cursor < lines.length && !closeRe.test(lines[cursor]!)) {
      const rawLine = lines[cursor++]!;
      let strip = 0;
      while (strip < indent && rawLine[strip] === " ") strip += 1;
      codeLines.push(rawLine.slice(strip));
    }
    if (cursor < lines.length) cursor += 1;
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = codeLines.join("\n");
    pre.append(code);
    return { pre, nextIndex: cursor };
  };

  const appendFigureBlock = (alt: string, dataUrl: string) => {
    const figure = document.createElement("figure");
    figure.className = "note-figure";
    const image = document.createElement("img");
    image.src = dataUrl;
    image.alt = alt;
    image.loading = "lazy";
    figure.append(image);

    const tsMatch = alt.match(/\s*(?:·|\||\[)?\s*(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*$/);
    const caption = tsMatch ? alt.slice(0, tsMatch.index).trim() : alt.trim();
    const timestamp = tsMatch?.[1] || "";
    if (caption || timestamp) {
      const figcaption = document.createElement("figcaption");
      figcaption.className = "note-figcaption";
      figcaption.append(document.createTextNode("图"));
      if (timestamp) {
        figcaption.append(document.createTextNode(" · "));
        figcaption.append(createTimestampNode(timestamp, sourceVideo?.url));
      }
      if (caption) {
        figcaption.append(document.createTextNode(` · ${caption}`));
      }
      figure.append(figcaption);
    }
    root.append(figure);
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index += 1; continue; }
    const standaloneImg = line.match(standaloneImagePattern);
    if (standaloneImg) {
      appendFigureBlock(standaloneImg[1] || "", standaloneImg[2]!);
      index += 1;
      continue;
    }
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) {
      const { pre, nextIndex } = consumeFencedCodeBlock(index);
      root.append(pre);
      index = nextIndex;
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
      const level = heading[1]!.length;
      const node = document.createElement(`h${level}`);
      if (
        level === 1
        && [...root.children].every((el) => el.tagName === "H1" || el.classList.contains("note-meta-quote"))
      ) {
        node.className = "note-leading-title";
      }
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
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index]!)) {
        quoteLines.push(lines[index++]!);
      }
      let nextNonEmpty = index;
      while (nextNonEmpty < lines.length && !lines[nextNonEmpty]!.trim()) nextNonEmpty += 1;
      if (
        quoteLines.length === 1
        && legacyFrameQuotePattern.test(quoteLines[0]!)
        && nextNonEmpty < lines.length
        && standaloneImagePattern.test(lines[nextNonEmpty]!)
      ) {
        continue;
      }
      const quote = document.createElement("blockquote");
      for (const quoteLine of quoteLines) {
        const paragraph = document.createElement("p");
        appendInline(paragraph, quoteLine.replace(/^\s*>\s?/, ""));
        quote.append(paragraph);
      }
      if (
        [...root.children].every((el) => el.tagName === "H1")
        && quoteLines.length === 1
        && (/\[视频链接\]\(https?:\/\//i.test(quoteLines[0]!) || (/模型[:：]/.test(quoteLines[0]!) && /来源[:：]/.test(quoteLines[0]!)))
      ) {
        quote.className = "note-meta-quote";
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
        const currentLine = lines[index]!;
        if (!currentLine.trim()) {
          let lookahead = index + 1;
          while (lookahead < lines.length && !lines[lookahead]!.trim()) lookahead += 1;
          if (lookahead < lines.length) {
            const upcoming = lines[lookahead]!;
            if (/^\s+(?:`{3,}|~{3,})/.test(upcoming) || (/^\s{2,}\S/.test(upcoming) && !startsBlock(upcoming))) {
              index = lookahead;
              continue;
            }
            const nextMatch = upcoming.match(listPattern);
            if (nextMatch) {
              const nextDepth = Math.floor(nextMatch[1]!.replace(/\t/g, "  ").length / 2);
              const nextOrdered = /^\d/.test(nextMatch[2]!);
              if (nextDepth > 0 || nextOrdered === rootOrdered) {
                index = lookahead;
                continue;
              }
            }
          }
          break;
        }
        if (/^\s+(?:`{3,}|~{3,})/.test(currentLine) && stack.at(-1)!.lastLi) {
          const { pre, nextIndex } = consumeFencedCodeBlock(index);
          stack.at(-1)!.lastLi!.append(pre);
          index = nextIndex;
          continue;
        }
        const match = currentLine.match(listPattern);
        if (!match) {
          if (/^\s{2,}\S/.test(currentLine) && !startsBlock(currentLine) && stack.at(-1)!.lastLi) {
            const cont = document.createElement("p");
            appendInline(cont, currentLine.trim());
            stack.at(-1)!.lastLi!.append(cont);
            index += 1;
            continue;
          }
          break;
        }
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
