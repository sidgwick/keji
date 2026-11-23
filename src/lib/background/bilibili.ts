import { Keji, type VideoTarget } from "../keji.ts";
import {
  BILIBILI_CDN_SUFFIXES,
  getCachedAudio,
  isBilibiliCdnUrl,
} from "../lesson-cache.ts";

const BILIBILI_VIDEO_URL_RE = /^https:\/\/(www\.)?bilibili\.com\/video\//i;
const BILIBILI_VIDEO_TAB_PATTERNS = [
  "https://www.bilibili.com/video/*",
  "https://bilibili.com/video/*"
];

interface InspectBilibiliOptions {
  mode: "meta" | "dash";
  preferredLanguage?: string;
  streamKind?: "audio" | "video";
  targetBytes?: number;
}

function pageFromUrl(url: string): number {
  try {
    return Math.max(1, Number(new URL(url).searchParams.get("p")) || 1);
  } catch {
    return 1;
  }
}

export async function getVideoTab(
  tabId?: number | null,
  lessonHint: VideoTarget | null = null
): Promise<chrome.tabs.Tab & { id: number; url: string }> {
  const hintBvid = (Keji.bvidFromUrl(lessonHint?.url || "") || String(lessonHint?.bvid || "").trim()).toUpperCase();
  const hintPage = Math.max(0, Number(lessonHint?.page) || 0);
  const matchesHint = (url?: string) => Boolean(
    url
    && BILIBILI_VIDEO_URL_RE.test(url)
    && (!hintBvid || Keji.bvidFromUrl(url) === hintBvid)
  );

  const byId = tabId != null && Number.isInteger(Number(tabId))
    ? await chrome.tabs.get(Number(tabId)).catch(() => null)
    : null;
  if (byId?.id && matchesHint(byId.url) && (!hintPage || pageFromUrl(byId.url!) === hintPage)) {
    return byId as chrome.tabs.Tab & { id: number; url: string };
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [] as chrome.tabs.Tab[]);
  if (activeTab?.id && matchesHint(activeTab.url) && (!hintPage || pageFromUrl(activeTab.url!) === hintPage)) {
    return activeTab as chrome.tabs.Tab & { id: number; url: string };
  }

  const openTabs = await chrome.tabs.query({ url: BILIBILI_VIDEO_TAB_PATTERNS }).catch(() => [] as chrome.tabs.Tab[]);
  const openMatches = openTabs
    .filter((candidate) => Boolean(candidate.id && matchesHint(candidate.url)))
    .sort((a, b) => (Number(Boolean(b.active)) - Number(Boolean(a.active))) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
  if (hintPage >= 1) {
    const exactPageTab = openMatches.find((candidate) => pageFromUrl(candidate.url!) === hintPage);
    if (exactPageTab?.id) return exactPageTab as chrome.tabs.Tab & { id: number; url: string };
  }
  if (byId?.id && matchesHint(byId.url)) return byId as chrome.tabs.Tab & { id: number; url: string };
  if (activeTab?.id && matchesHint(activeTab.url)) return activeTab as chrome.tabs.Tab & { id: number; url: string };
  if (openMatches[0]?.id) return openMatches[0] as chrome.tabs.Tab & { id: number; url: string };

  if (!byId?.id && !activeTab?.id) throw new Error("没有找到当前标签页。");
  throw new Error("请载入一个 B 站视频链接。");
}

async function inspectBilibiliPage<T = Record<string, any>>(tabId: number, options: InspectBilibiliOptions): Promise<T> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [options],
    func: async (opts: InspectBilibiliOptions) => {
      const win = globalThis as any;
      const loc = win.location;
      const perf = win.performance;
      const doc = win.document;

      const md5Hex = (text: string): string => {
        const msg = new TextEncoder().encode(text);
        const padLen = (((msg.length + 8) >> 6) + 1) << 6;
        const buf = new Uint8Array(padLen);
        buf.set(msg);
        buf[msg.length] = 0x80;
        const view = new DataView(buf.buffer);
        view.setUint32(padLen - 8, (msg.length << 3) >>> 0, true);
        view.setUint32(padLen - 4, (msg.length >>> 29) >>> 0, true);
        const K = new Uint32Array(64);
        for (let i = 0; i < 64; i += 1) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
        const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
        const M = new Uint32Array(16);
        let a0 = 0x67452301;
        let b0 = 0xefcdab89;
        let c0 = 0x98badcfe;
        let d0 = 0x10325476;
        for (let offset = 0; offset < buf.length; offset += 64) {
          for (let j = 0; j < 16; j += 1) M[j] = view.getUint32(offset + j * 4, true);
          let a = a0;
          let b = b0;
          let c = c0;
          let d = d0;
          for (let i = 0; i < 64; i += 1) {
            let f = 0;
            let g = 0;
            if (i < 16) {
              f = (b & c) | (~b & d);
              g = i;
            } else if (i < 32) {
              f = (d & b) | (~d & c);
              g = (5 * i + 1) % 16;
            } else if (i < 48) {
              f = b ^ c ^ d;
              g = (3 * i + 5) % 16;
            } else {
              f = c ^ (b | ~d);
              g = (7 * i) % 16;
            }
            const shift = S[((i >> 4) << 2) + (i & 3)]!;
            const sum = (a + f + K[i]! + M[g]!) >>> 0;
            const rotated = ((sum << shift) | (sum >>> (32 - shift))) >>> 0;
            const nextB = (b + rotated) >>> 0;
            a = d;
            d = c;
            c = b;
            b = nextB;
          }
          a0 = (a0 + a) >>> 0;
          b0 = (b0 + b) >>> 0;
          c0 = (c0 + c) >>> 0;
          d0 = (d0 + d) >>> 0;
        }
        let hex = "";
        for (const word of [a0, b0, c0, d0]) {
          for (let byte = 0; byte < 4; byte += 1) {
            hex += ((word >>> (byte * 8)) & 0xff).toString(16).padStart(2, "0");
          }
        }
        return hex;
      };

      const buildWbiSignedUrl = async (
        pathname: string,
        params: Record<string, string | number>
      ): Promise<string | null> => {
        try {
          const navRes = await fetch("https://api.bilibili.com/x/web-interface/nav", { credentials: "include" });
          const navJson = await navRes.json().catch(() => null);
          const wbiImg = navJson?.data?.wbi_img;
          const imgKey = String(wbiImg?.img_url || "").split("/").pop()?.split(".")[0] || "";
          const subKey = String(wbiImg?.sub_url || "").split("/").pop()?.split(".")[0] || "";
          if (!imgKey || !subKey) return null;
          const mixinTab = [
            46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
            27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
            37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
            22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
          ];
          const combined = imgKey + subKey;
          const mixinKey = mixinTab.map((idx) => combined[idx] || "").join("").slice(0, 32);
          const signedParams: Record<string, string | number> = {
            ...params,
            wts: Math.round(Date.now() / 1000)
          };
          const query = Object.keys(signedParams)
            .sort()
            .map((key) => {
              const cleaned = String(signedParams[key] ?? "").replace(/[!'()*]/g, "");
              return `${encodeURIComponent(key)}=${encodeURIComponent(cleaned)}`;
            })
            .join("&");
          const wRid = md5Hex(query + mixinKey);
          return `https://api.bilibili.com${pathname}?${query}&w_rid=${wRid}`;
        } catch {
          return null;
        }
      };

      const urlBvid = String(loc?.pathname || "").match(/\/video\/(BV[\w]+)/i)?.[1] || "";
      const urlPage = Math.max(0, Number(new URLSearchParams(loc?.search || "").get("p")) || 0);
      const state = win.__INITIAL_STATE__;
      const stateData = state?.videoData;
      const stateBvid = String(stateData?.bvid || state?.bvid || "");
      let data = stateData;
      if ((!data || (urlBvid && stateBvid.toUpperCase() !== urlBvid.toUpperCase())) && urlBvid) {
        try {
          const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(urlBvid)}`, {
            credentials: "include"
          });
          const viewJson = await viewRes.json().catch(() => null);
          if (viewJson?.data) data = viewJson.data;
        } catch {}
      }
      if (!data) return { error: "当前页面还没有加载出视频信息，请稍后重试。" };

      const pageNo = urlPage >= 1 ? urlPage : Math.max(1, Number(state?.p) || 1);
      const page = data.pages?.[pageNo - 1] || data;
      const bvid = String(data.bvid || urlBvid || stateBvid || "");
      const aid = Number(data.aid || state?.aid) || 0;
      const expectedCid = Number(page?.cid || (pageNo === 1 ? state?.cid || data.cid : 0)) || 0;
      const pageDuration = Number(page?.duration || data.duration) || 0;
      const perfEntries = (perf?.getEntriesByType?.("resource") || []) as Array<{ name: string }>;

      if (opts.mode === "dash") {
        const streamKind = opts.streamKind === "video" ? "video" : "audio";
        const targetBytes = Math.max(0, Number(opts.targetBytes) || 0);
        if (!expectedCid) return { error: "当前页面还没有加载出分 P 标识，请稍后重试。" };

        const hasUsableTracks = (list: any): boolean => {
          if (!Array.isArray(list)) return false;
          const nowSec = Math.floor(Date.now() / 1000);
          return list.some((item: any) => {
            const rawUrl = item?.baseUrl || item?.base_url;
            if (!rawUrl) return false;
            try {
              const deadline = Number(new URL(rawUrl).searchParams.get("deadline")) || 0;
              return deadline === 0 || deadline > nowSec + 60;
            } catch {
              return false;
            }
          });
        };

        let playData: any = null;
        let verifiedCid = 0;

        // 1. Prefer the exact player playurl request for expectedCid when present in Performance entries.
        const playerPlayUrl = perfEntries
          .map((entry) => entry.name)
          .filter((url) => {
            try {
              const parsed = new URL(url);
              return parsed.origin === "https://api.bilibili.com"
                && (parsed.pathname === "/x/player/wbi/playurl" || parsed.pathname === "/x/player/playurl")
                && parsed.searchParams.get("cid") === String(expectedCid);
            } catch {
              return false;
            }
          })
          .at(-1);
        if (playerPlayUrl) {
          try {
            const res = await fetch(playerPlayUrl, { credentials: "include" });
            const json = res.ok ? await res.json().catch(() => null) : null;
            const candidate = json?.code === 0 ? (json?.data || json?.result) : null;
            if (hasUsableTracks(candidate?.dash?.[streamKind])) {
              playData = candidate;
              verifiedCid = expectedCid;
            }
          } catch {}
        }

        // 2. Fall back to initial SSR __playinfo__ when still on the initial (bvid, page, cid) without SPA switch.
        if (!playData) {
          const ssrData = win.__playinfo__?.data || win.__playinfo__?.result;
          const sameInitialBvid = Boolean(
            stateData && String(stateData.bvid || state?.bvid || "").toUpperCase() === bvid.toUpperCase()
          );
          const sameInitialPage = Math.max(1, Number(state?.p) || 1) === pageNo;
          const initialPageObj = stateData?.pages?.[pageNo - 1] || stateData;
          const sameInitialCid = Number(
            initialPageObj?.cid || (pageNo === 1 ? state?.cid || stateData?.cid : 0)
          ) === expectedCid;
          const switchedOtherCid = perfEntries.some((entry) => {
            try {
              const parsed = new URL(entry.name);
              return parsed.origin === "https://api.bilibili.com"
                && (parsed.pathname === "/x/player/wbi/playurl" || parsed.pathname === "/x/player/playurl")
                && Boolean(parsed.searchParams.get("cid"))
                && parsed.searchParams.get("cid") !== String(expectedCid);
            } catch {
              return false;
            }
          });
          const ssrDuration = Number(ssrData?.timelength) > 0 ? Number(ssrData.timelength) / 1000 : 0;
          const durationOk = !pageDuration || !ssrDuration
            || Math.abs(pageDuration - ssrDuration) <= Math.max(3, pageDuration * 0.02);
          if (
            sameInitialBvid
            && sameInitialPage
            && sameInitialCid
            && !switchedOtherCid
            && durationOk
            && hasUsableTracks(ssrData?.dash?.[streamKind])
          ) {
            playData = ssrData;
            verifiedCid = expectedCid;
          }
        }

        // 3. Direct CID-bound playurl API request (handles SPA switches, expired URLs, missing SSR data).
        if (!playData && bvid) {
          const wbiUrl = await buildWbiSignedUrl("/x/player/wbi/playurl", {
            bvid,
            cid: expectedCid,
            qn: 80,
            fnver: 0,
            fnval: 4048,
            fourk: 1
          });
          const legacyUrl = `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${expectedCid}&qn=80&fnver=0&fnval=4048&fourk=1`;
          for (const apiUrl of [wbiUrl, legacyUrl].filter((value): value is string => Boolean(value))) {
            try {
              const res = await fetch(apiUrl, { credentials: "include" });
              const json = res.ok ? await res.json().catch(() => null) : null;
              const candidate = json?.code === 0 ? (json?.data || json?.result) : null;
              if (hasUsableTracks(candidate?.dash?.[streamKind])) {
                playData = candidate;
                verifiedCid = expectedCid;
                break;
              }
            } catch {}
          }
        }

        if (!playData) {
          return {
            error: streamKind === "audio"
              ? "播放器还没有提供可下载的音轨，且直接获取当前分 P 音轨失败，请稍后重试。"
              : "播放器尚未提供视频流，且直接获取当前分 P 视频流失败，请稍后重试。"
          };
        }

        const duration = Number(playData?.timelength) > 0
          ? Number(playData.timelength) / 1000
          : pageDuration;
        const tracks = Array.isArray(playData?.dash?.[streamKind]) ? [...playData.dash[streamKind]] : [];
        tracks.sort((a: any, b: any) => {
          if (streamKind === "video") {
            const aCompat = String(a.codecs || "").startsWith("avc1") ? 1 : 0;
            const bCompat = String(b.codecs || "").startsWith("avc1") ? 1 : 0;
            if (bCompat !== aCompat) return bCompat - aCompat;
            if (targetBytes > 0 && duration > 0) {
              const aBytes = (Number(a.bandwidth) || 0) * duration / 8;
              const bBytes = (Number(b.bandwidth) || 0) * duration / 8;
              const aFits = aBytes > 0 && aBytes <= targetBytes * 0.9;
              const bFits = bBytes > 0 && bBytes <= targetBytes * 0.9;
              if (aFits !== bFits) return bFits ? 1 : -1;
              if (!aFits && !bFits) return (Number(a.bandwidth) || 0) - (Number(b.bandwidth) || 0);
            }
          }
          return Number(b.bandwidth) - Number(a.bandwidth);
        });
        const nowSec = Math.floor(Date.now() / 1000);
        const track = tracks.find((item: any) => {
          const u = item?.baseUrl || item?.base_url;
          if (!u) return false;
          try {
            const deadline = Number(new URL(u).searchParams.get("deadline")) || 0;
            return deadline === 0 || deadline > nowSec + 60;
          } catch {
            return true;
          }
        }) || tracks.find((item: any) => item.baseUrl || item.base_url);
        const url = track?.baseUrl || track?.base_url;
        if (!url) {
          return {
            error: streamKind === "audio"
              ? "当前分 P 暂无可用的音轨地址。"
              : "当前分 P 暂无可用的视频流地址。"
          };
        }
        if (streamKind === "video") {
          return {
            url,
            mimeType: track.mimeType || "video/mp4",
            codec: track.codecs || "",
            width: Number(track.width) || 0,
            height: Number(track.height) || 0,
            bandwidth: Number(track.bandwidth) || 0,
            duration
          };
        }
        const backupUrls = track.backupUrl || track.backup_url || [];
        return {
          url,
          backupUrls: Array.isArray(backupUrls) ? backupUrls : [],
          duration,
          bvid,
          page: pageNo,
          part: String(page?.part || data.title || "当前分 P"),
          expectedCid,
          streamCid: verifiedCid || expectedCid,
          codec: track.codecs || "",
          bandwidth: Number(track.bandwidth) || 0
        };
      }

      const preferredLanguage = String(opts.preferredLanguage || "");
      let cover = "";
      try {
        const coverUrl = new URL(data.pic, loc.origin);
        if (coverUrl.protocol === "https:") cover = coverUrl.href;
      } catch {}
      const video = {
        bvid,
        aid,
        title: data.title || doc?.title || "",
        cover,
        part: page.part || data.title || "当前分 P",
        page: pageNo,
        pageCount: data.pages?.length || 1,
        cid: expectedCid,
        duration: pageDuration,
        url: `${loc.origin}${loc.pathname}${loc.search}`
      };
      const parts = (data.pages || [page]).map((part: any, index: number) => {
        const partUrl = new URL(loc.href);
        partUrl.searchParams.set("p", String(index + 1));
        return {
          page: index + 1,
          part: part.part || data.title || `第 ${index + 1} 节`,
          duration: Number(part.duration) || 0,
          url: partUrl.toString()
        };
      });

      let requestUrl = perfEntries
        .map((entry) => entry.name)
        .filter((url) => {
          try {
            const parsed = new URL(url);
            return parsed.origin === "https://api.bilibili.com"
              && parsed.pathname === "/x/player/wbi/v2"
              && parsed.searchParams.get("cid") === String(video.cid);
          } catch {
            return false;
          }
        })
        .at(-1);
      if (!requestUrl && video.cid && (video.bvid || video.aid)) {
        const playerParams: Record<string, string | number> = video.bvid
          ? { bvid: video.bvid, cid: video.cid }
          : { aid: video.aid, cid: video.cid };
        requestUrl = (await buildWbiSignedUrl("/x/player/wbi/v2", playerParams))
          || (video.bvid
            ? `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(video.bvid)}&cid=${video.cid}`
            : `https://api.bilibili.com/x/player/v2?aid=${video.aid}&cid=${video.cid}`);
      }
      if (!requestUrl) return { video, parts, captions: [], captionTracks: [], captionMessage: "播放器没有提供字幕轨道信息。" };

      let captionTracks: any[] = [];
      let selectedSubtitleLanguage = "";
      let selectedLanguageLabel = "";
      try {
        const response = await fetch(requestUrl, { credentials: "include" });
        if (!response.ok) throw new Error(`字幕信息请求失败（HTTP ${response.status}）`);
        const res = await response.json();
        const tracks = res?.data?.subtitle?.subtitles || [];
        if (!tracks.length) {
          return {
            video,
            parts,
            captions: [],
            captionTracks: [],
            captionMessage: res?.data?.need_login_subtitle
              ? "B 站提示这段字幕需要登录后查看。"
              : "当前分 P 没有可用字幕。可以直接获取音轨转写，也可以粘贴文字稿。"
          };
        }

        const trackKey = (track: any) => String(track.lan ?? track.id ?? "");
        captionTracks = tracks.map((track: any) => ({
          key: trackKey(track),
          label: String(track.lan_doc || track.lan || "未知语言"),
          automatic: Boolean(track.ai_type || /ai-/i.test(track.lan || ""))
        }));
        const selected = tracks.find((track: any) => trackKey(track) === preferredLanguage)
          || tracks.find((track: any) => /中文|简体|普通话/i.test(track.lan_doc || "") || /^(zh|ai-zh)/i.test(track.lan || ""))
          || tracks[0];
        selectedSubtitleLanguage = trackKey(selected);
        selectedLanguageLabel = selected.lan_doc || selected.lan || "字幕";
        const subtitleUrl = selected.subtitle_url?.startsWith("//")
          ? `https:${selected.subtitle_url}`
          : selected.subtitle_url;
        if (!subtitleUrl) {
          return {
            video, parts, captions: [], captionTracks, selectedSubtitleLanguage,
            language: selectedLanguageLabel,
            captionMessage: "字幕轨道没有提供可读取的字幕地址。"
          };
        }

        const subtitleResponse = await fetch(subtitleUrl, { credentials: "omit" });
        if (!subtitleResponse.ok) throw new Error(`字幕正文请求失败（HTTP ${subtitleResponse.status}）`);
        const subtitle = await subtitleResponse.json();
        const captions = (subtitle.body || [])
          .filter((cue: any) => cue && Number.isFinite(Number(cue.from)) && String(cue.content || "").trim())
          .map((cue: any) => ({ time: Number(cue.from), text: String(cue.content).trim() }));
        return {
          video,
          parts,
          captions,
          captionTracks,
          selectedSubtitleLanguage,
          language: selectedLanguageLabel,
          captionMessage: captions.length ? `已读取 ${captions.length} 条字幕。` : "字幕文件没有可用正文。"
        };
      } catch (error) {
        return {
          video, parts, captions: [], captionTracks, selectedSubtitleLanguage,
          language: selectedLanguageLabel,
          captionMessage: (error as Error).message || "读取字幕失败。可以直接获取音轨转写，也可以粘贴文字稿。"
        };
      }
    }
  });
  const payload = result?.result as any;
  if (payload?.error) throw new Error(payload.error);
  return payload as T;
}

export async function readCurrentVideo(tabId?: number | null, preferredSubtitleLanguage = "") {
  const tab = await getVideoTab(tabId);
  const payload = await inspectBilibiliPage<Record<string, any>>(tab.id, {
    mode: "meta",
    preferredLanguage: String(preferredSubtitleLanguage || "")
  });
  if (!payload?.video) throw new Error("无法读取 B 站页面信息。");
  return { ...payload, tabId: tab.id, windowId: tab.windowId };
}

export async function readCurrentDashSource(
  tabId: number | null | undefined,
  kind: "audio" | "video",
  maxTargetBytes = 0,
  lessonHint: VideoTarget | null = null
): Promise<Record<string, any>> {
  const tab = await getVideoTab(tabId, lessonHint);
  const source = await inspectBilibiliPage<Record<string, any>>(tab.id, {
    mode: "dash",
    streamKind: kind,
    targetBytes: Math.max(0, Number(maxTargetBytes) || 0)
  });
  if (!source?.url) throw new Error(kind === "audio" ? "无法读取 B 站音轨地址，请稍后重试。" : "无法读取 B 站视频流地址。");
  if (kind === "video" && !isBilibiliCdnUrl(source.url, true)) {
    throw new Error("B 站返回了无法识别的视频 CDN 地址。");
  }
  return source;
}

export async function configureBilibiliCdnRequestHeaders(origin = "https://www.bilibili.com"): Promise<void> {
  const parsedOrigin = new URL(origin);
  if (!/^https:$/.test(parsedOrigin.protocol) || !/(^|\.)bilibili\.com$/i.test(parsedOrigin.hostname)) {
    throw new Error("无法为非 B 站页面配置视频 CDN 请求头。");
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [
          { header: "Referer", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: `${parsedOrigin.origin}/` },
          { header: "Origin", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: parsedOrigin.origin }
        ]
      },
      condition: {
        requestDomains: BILIBILI_CDN_SUFFIXES,
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ["xmlhttprequest" as chrome.declarativeNetRequest.ResourceType]
      }
    }]
  });
}

export async function resolveValidatedAudioTrack(tabId?: number | null, lessonHint: VideoTarget | null = null) {
  let tab: (chrome.tabs.Tab & { id: number; url: string }) | null = null;
  let videoInfo: any = null;
  let liveError: Error | null = null;
  try {
    tab = await getVideoTab(tabId, lessonHint);
    videoInfo = await readCurrentVideo(tab.id);
  } catch (error) {
    liveError = error as Error;
  }
  const target = videoInfo?.video || lessonHint;
  const expectedCid = videoInfo?.video?.cid || lessonHint?.cid || 0;
  const cachedAudio = target ? await getCachedAudio(target, { expectedCid }) : null;
  if (cachedAudio) {
    const videoPayload = videoInfo?.video
      ? { ...videoInfo.video, url: videoInfo.video.url || tab?.url || "" }
      : {
        bvid: cachedAudio.meta?.bvid || lessonHint?.bvid || Keji.bvidFromUrl(lessonHint?.url || ""),
        page: Number(cachedAudio.meta?.page || lessonHint?.page) || 1,
        cid: Number(cachedAudio.meta?.cid || lessonHint?.cid) || 0,
        title: cachedAudio.meta?.title || lessonHint?.title || "未命名视频",
        part: cachedAudio.meta?.part || lessonHint?.part || "当前分 P",
        duration: Number(cachedAudio.meta?.duration || lessonHint?.duration) || 0,
        url: cachedAudio.meta?.url || lessonHint?.url || ""
      };
    return {
      cachedAudio: true,
      videoPayload,
      audioSource: {
        duration: Number(videoPayload.duration) || 0,
        bvid: videoPayload.bvid,
        page: videoPayload.page,
        part: videoPayload.part,
        expectedCid: videoPayload.cid
      }
    };
  }
  if (liveError || !tab || !videoInfo) throw liveError || new Error("请载入一个 B 站视频链接。");
  const audioSource = await readCurrentDashSource(tab.id, "audio", 0, videoInfo.video);
  if (audioSource.bvid !== videoInfo.video.bvid
      || Number(audioSource.page) !== Number(videoInfo.video.page)
      || Number(audioSource.expectedCid) !== Number(videoInfo.video.cid)
      || !audioSource.expectedCid
      || !audioSource.streamCid
      || Number(audioSource.expectedCid) !== Number(audioSource.streamCid)) {
    throw new Error("读取音轨期间当前分 P 发生了切换，请重新载入课程后再试。");
  }
  const expectedDuration = Number(videoInfo.video.duration) || 0;
  const audioDuration = Number(audioSource.duration) || 0;
  if (expectedDuration && audioDuration && Math.abs(expectedDuration - audioDuration) > Math.max(2, expectedDuration * 0.01)) {
    throw new Error("当前分 P 时长与播放器音轨时长不一致，请等播放器切换完成后重试。");
  }
  const audioUrl = isBilibiliCdnUrl(audioSource.url, true);
  if (!audioUrl) throw new Error("B 站返回了未识别或非 HTTPS 的音频 CDN 地址，课记为安全起见没有下载。");
  if (!await chrome.permissions.contains({ origins: [`${audioUrl.origin}/*`] })) {
    throw new Error("扩展还没有当前 B 站音频服务器的访问权限。请重试并允许访问 bilivideo.com。");
  }
  await configureBilibiliCdnRequestHeaders(new URL(videoInfo.video.url || tab.url).origin);
  return {
    cachedAudio: false,
    videoPayload: { ...videoInfo.video, url: videoInfo.video.url || tab.url },
    audioSource
  };
}
