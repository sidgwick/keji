import {
  configureBilibiliCdnRequestHeaders,
  getVideoTab,
  readCurrentDashSource,
  readCurrentVideo,
  resolveValidatedAudioTrack,
} from "../../lib/background/bilibili.ts";
import {
  cancelGenerationTask,
  discussNote,
  enrichNoteWithFrames,
  enrichNoteWithVideo,
  generateNote,
  generateNoteQuiz,
  hasActiveGenerationTasks,
  normalizeSettings,
  testModelConnection,
} from "../../lib/background/llm-service.ts";
import {
  clearLegacyTranscriptDraftsStore,
  deleteNote,
  findMatchingNotes,
  getAllNotes,
  getNote,
  listNotes,
  noteIntermediateBytes,
  saveNote,
  stripIntermediateFromNotes,
  summarizeNote,
  updateFlashcardReviewItem,
  updateNote,
  updateNoteQuizState,
} from "../../lib/background/notes-db.ts";
import {
  REMOTE_NOTES_SYNC_ALARM,
  disableRemoteNotesAutoSync,
  getRemoteNotesSyncState,
  queueRemoteNotesAutoSync,
  restoreAutoRemoteNotesSync,
  runAutoRemoteNotesSync,
  runRemoteNotesBackupWithSyncState,
} from "../../lib/background/webdav-sync.ts";
import { collectFlashcardsFromNotes } from "../../lib/flashcards.ts";
import { Keji, type TranscriptSegment, type VideoTarget } from "../../lib/keji.ts";
import {
  clearAllLessonOpfsCaches,
  clearLessonOpfsCache,
  getCachedAudio,
  getLessonCacheStatus,
  isBilibiliCdnUrl,
  listAllLessonOpfsCaches,
  normalizeLessonKey,
  putCachedTranscription,
} from "../../lib/lesson-cache.ts";

function createSerialQueue() {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const task = queue.then(operation, operation);
    queue = task.catch(() => {});
    return task;
  };
}

export default defineBackground(() => {
  chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  const queueTranscriptionUpdate = createSerialQueue();

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === REMOTE_NOTES_SYNC_ALARM) void runAutoRemoteNotesSync();
  });

  chrome.runtime.onStartup.addListener(() => {
    void restoreAutoRemoteNotesSync();
  });

  chrome.action.onClicked.addListener(async (tab) => {
    const workspaceUrl = new URL(chrome.runtime.getURL("workspace.html"));
    if (tab?.id && /^https:\/\/(www\.)?bilibili\.com\/video\//i.test(tab.url || "")) {
      workspaceUrl.searchParams.set("tabId", String(tab.id));
      workspaceUrl.searchParams.set("videoUrl", tab.url!);
    }
    await chrome.tabs.create({ url: workspaceUrl.toString() });
  });

  chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string" || message.target === "offscreen") return false;
    const task = message.target === "background" ? handleOffscreenMessage(message) : routeMessage(message);
    task
      .then(sendResponse)
      .catch((error: Error & { cancelled?: boolean; partialMarkdown?: string; completedChunks?: number }) => sendResponse({
        ok: false,
        error: error.message || "发生未知错误",
        ...(error.cancelled ? { cancelled: true } : {}),
        ...(error.partialMarkdown ? { partialMarkdown: error.partialMarkdown, completedChunks: error.completedChunks || 0 } : {})
      }));
    return true;
  });

  async function routeMessage(message: any) {
    switch (message.type) {
      case "READ_CURRENT_VIDEO":
        return { ok: true, video: await readCurrentVideo(message.tabId, message.subtitleLanguage) };
      case "READ_VIDEO_SOURCE":
        return { ok: true, source: await readCurrentDashSource(message.tabId, "video", Number(message.maxTargetBytes) || 0, message.lesson || null) };
      case "PREPARE_LESSON_AUDIO":
        return { ok: true, ...await prepareLessonAudioForNote(message.tabId, message.lesson) };
      case "CACHE_LESSON_AUDIO":
        return { ok: true, ...await cacheLessonAudio(message.tabId, message.lesson) };
      case "RELEASE_LESSON_AUDIO":
        await releaseLessonAudio();
        return { ok: true };
      case "PREPARE_VIDEO_CAPTURE":
        await configureBilibiliCdnRequestHeaders();
        return { ok: true };
      case "GET_SETTINGS": {
        const { settings } = await chrome.storage.local.get("settings");
        return { ok: true, settings: normalizeSettings(settings) };
      }
      case "TEST_MODEL_CONNECTION":
        return { ok: true, result: await testModelConnection(message.settings) };
      case "SAVE_NOTE": {
        const note = await saveNote(message.note);
        await queueRemoteNotesAutoSync();
        return { ok: true, note: summarizeNote(note) };
      }
      case "UPDATE_NOTE": {
        const note = await updateNote(message.note);
        await queueRemoteNotesAutoSync();
        return { ok: true, note: summarizeNote(note) };
      }
      case "DELETE_NOTE": {
        const deleted = await deleteNote(message.id);
        await queueRemoteNotesAutoSync();
        return { ok: true, deleted };
      }
      case "LIST_NOTES":
        return { ok: true, ...await listNotes({ query: message.query, previewLimit: message.previewLimit }) };
      case "GET_NOTE":
        return { ok: true, note: await getNote(message.id) };
      case "UPDATE_FLASHCARD_REVIEW_ITEM": {
        const review = await updateFlashcardReviewItem(message.id, message.state);
        await queueRemoteNotesAutoSync();
        return { ok: true, review };
      }
      case "GET_DUE_FLASHCARDS":
        return { ok: true, cards: collectFlashcardsFromNotes(await getAllNotes(), { dueOnly: true }) };
      case "GET_ALL_FLASHCARDS":
        return { ok: true, cards: collectFlashcardsFromNotes(await getAllNotes()) };
      case "GENERATE_NOTE_QUIZ":
        return { ok: true, result: await generateNoteQuiz(message.payload) };
      case "UPDATE_NOTE_QUIZ": {
        const quizState = await updateNoteQuizState(message.id, message.quizState);
        await queueRemoteNotesAutoSync();
        return { ok: true, quizState };
      }
      case "REMOTE_NOTES_BACKUP":
        return { ok: true, result: await runRemoteNotesBackupWithSyncState(message.action) };
      case "QUEUE_REMOTE_NOTES_SYNC":
        await queueRemoteNotesAutoSync();
        return { ok: true };
      case "DISABLE_REMOTE_NOTES_SYNC":
        await disableRemoteNotesAutoSync();
        return { ok: true };
      case "GET_REMOTE_NOTES_SYNC_STATE":
        return { ok: true, ...await getRemoteNotesSyncState() };
      case "GENERATE_NOTE":
        return {
          ok: true,
          ...await generateNote(message.payload, async ({ video, start, end }) => {
            await ensureOffscreenDocument();
            const encoded = await chrome.runtime.sendMessage({
              target: "offscreen",
              type: "ENCODE_AUDIO_WAV_CHUNK",
              bvid: video.bvid || Keji.bvidFromUrl(video.url),
              page: video.page || 1,
              cid: video.cid || 0,
              videoUrl: video.url || "",
              start,
              end
            });
            if (!encoded?.ok || !encoded.wavBase64) throw new Error(encoded?.error || "编码音频分片失败。");
            return encoded.wavBase64;
          })
        };
      case "CANCEL_GENERATION":
        cancelGenerationTask(message.taskId);
        return { ok: true };
      case "ENRICH_NOTE_WITH_FRAMES":
        return { ok: true, markdown: await enrichNoteWithFrames(message.payload) };
      case "ENRICH_NOTE_WITH_VIDEO":
        return { ok: true, markdown: await enrichNoteWithVideo(message.payload) };
      case "DISCUSS_NOTE":
        return { ok: true, result: await discussNote(message.payload) };
      case "START_DIRECT_AUDIO_TRANSCRIPTION":
        return { ok: true, transcription: await startDirectAudioTranscription(message.tabId, message.lesson || null) };
      case "RETRANSCRIBE_AUDIO_RANGE":
        return await retranscribeAudioRange(message);
      case "GET_LESSON_CACHE_STATUS":
        return { ok: true, status: await getLessonCacheOverviewStatus(message) };
      case "GET_CACHE_OVERVIEW":
        return { ok: true, overview: await getAllCacheOverview() };
      case "CLEAR_LESSON_CACHE":
        return { ok: true, ...await clearLessonCache(message) };
      case "CLEAR_ALL_CACHES":
        return { ok: true, ...await clearAllProcessCaches() };
      case "STOP_AUDIO_TRANSCRIPTION":
        if (await hasOffscreenDocument()) {
          try {
            await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_AUDIO_CAPTURE" });
            return { ok: true };
          } catch {
            // Offscreen document may close between check and delivery.
          }
        }
        {
          const { transcription = null } = await chrome.storage.local.get("transcription");
          if (transcription) {
            await chrome.storage.local.set({ transcription: { ...transcription, status: "cancelled", error: "已停止转写。" } });
          }
        }
        return { ok: true };
      case "GET_TRANSCRIPTION": {
        const { transcription = null } = await chrome.storage.local.get("transcription");
        if (transcription && ["starting", "downloading", "transcribing"].includes(transcription.status)
            && !await hasOffscreenDocument()) {
          transcription.status = "error";
          transcription.error = "上次转写已中断，请重新开始。";
          await chrome.storage.local.set({ transcription });
        }
        return { ok: true, transcription };
      }
      default:
        return { ok: false, error: "不支持的操作" };
    }
  }

  async function hasOffscreenDocument(): Promise<boolean> {
    const offscreenUrl = chrome.runtime.getURL("offscreen.html");
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
      documentUrls: [offscreenUrl]
    });
    return contexts.length > 0;
  }

  async function ensureOffscreenDocument(): Promise<void> {
    if (await hasOffscreenDocument()) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA" as chrome.offscreen.Reason, "BLOBS" as chrome.offscreen.Reason],
      justification: "Process Bilibili audio for speech transcription or direct audio understanding."
    });
  }

  async function getTranscriptionSettings() {
    const { settings: storedSettings } = await chrome.storage.local.get("settings");
    const settings = normalizeSettings(storedSettings);
    const baseUrl = String(settings.baseUrl || "").trim().replace(/\/+$/, "");
    const configuredEndpoint = String(settings.transcriptionEndpoint || "").trim();
    const endpoints = configuredEndpoint
      ? configuredEndpoint.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
      : baseUrl ? [`${baseUrl}/audio/transcriptions`] : [];
    if (endpoints.length > 4) throw new Error("最多配置 4 个语音识别 API 地址。");
    const endpoint = endpoints[0] || "";
    const model = String(settings.transcriptionModel || "whisper-1").trim();
    const transcriptionLanguage = String(settings.transcriptionLanguage || "").trim().toLowerCase();
    if (transcriptionLanguage && !/^[a-z]{2}$/.test(transcriptionLanguage)) {
      throw new Error("转写语言请填写两字母语言代码（例如 zh、en、ja），留空则自动检测。");
    }
    const apiKey = String(settings.transcriptionApiKey || "").trim();
    if (!endpoint || !model) throw new Error("请先在设置页填写语音识别 API 地址和模型。");
    const endpointOrigins = new Set<string>();
    for (const value of endpoints) {
      let endpointUrl: URL;
      try { endpointUrl = new URL(value); } catch { throw new Error(`语音识别 API 地址格式不正确：${value}`); }
      if (!/^https?:$/.test(endpointUrl.protocol)) throw new Error("语音识别 API 地址必须使用 HTTP 或 HTTPS。");
      endpointOrigins.add(endpointUrl.origin);
    }
    for (const origin of endpointOrigins) {
      if (!await chrome.permissions.contains({ origins: [`${origin}/*`] })) {
        throw new Error(`扩展还没有语音识别 API 域名权限：${origin}。请在设置中保存并授权。`);
      }
    }
    return {
      endpoint,
      endpoints,
      model,
      apiKey,
      language: transcriptionLanguage,
      prompt: String(settings.transcriptionPrompt || "").trim().slice(0, 200),
      transcriptionConcurrency: Number(settings.transcriptionConcurrency) || 0
    };
  }

  async function prepareLessonAudioForNote(tabId?: number, lessonHint: VideoTarget | null = null) {
    if (!await chrome.permissions.contains({ permissions: ["offscreen"] })) {
      throw new Error("请先允许课记使用音频处理权限，再直接分析课程音视频。");
    }
    const { videoPayload, audioSource } = await resolveValidatedAudioTrack(tabId, lessonHint);
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "PREPARE_LESSON_AUDIO",
      audioSource,
      video: videoPayload,
      videoUrl: videoPayload.url || "",
      bvid: videoPayload.bvid,
      page: videoPayload.page,
      cid: videoPayload.cid || 0
    });
    if (!response?.ok) throw new Error(response?.error || "准备课程音轨失败。");
    return { duration: Number(response.duration) || Number(videoPayload.duration) || 0, fromCache: Boolean(response.fromCache) };
  }

  async function cacheLessonAudio(tabId?: number, lessonHint: VideoTarget | null = null) {
    if (!await chrome.permissions.contains({ permissions: ['offscreen'] })) {
      throw new Error('请先允许课记使用音频处理权限。');
    }
    const { videoPayload, audioSource } = await resolveValidatedAudioTrack(tabId, lessonHint);
    if (lessonHint && (videoPayload.bvid !== lessonHint.bvid || Number(videoPayload.page) !== Number(lessonHint.page)
      || (lessonHint.cid && Number(videoPayload.cid) !== Number(lessonHint.cid)))) {
      throw new Error('B 站播放页与当前分 P 不一致，请重新载入本节后再准备媒体文件。');
    }
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen', type: 'CACHE_LESSON_AUDIO', audioSource, video: videoPayload,
      videoUrl: videoPayload.url || '', bvid: videoPayload.bvid,
      page: videoPayload.page, cid: videoPayload.cid || 0
    });
    if (!response?.ok) throw new Error(response?.error || '缓存课程音轨失败。');
    return { size: Number(response.size) || 0, fromCache: Boolean(response.fromCache) };
  }

  async function releaseLessonAudio(): Promise<void> {
    if (!await hasOffscreenDocument()) return;
    await chrome.runtime.sendMessage({ target: "offscreen", type: "RELEASE_LESSON_AUDIO" }).catch(() => {});
    const { transcription = null } = await chrome.storage.local.get("transcription");
    const activeTranscription = Boolean(
      transcription && ["starting", "downloading", "transcribing"].includes(transcription.status)
    );
    if (!activeTranscription) {
      await chrome.offscreen.closeDocument().catch(() => {});
    }
  }

  async function startDirectAudioTranscription(tabId?: number, lessonHint: VideoTarget | null = null) {
    if (!await chrome.permissions.contains({ permissions: ["offscreen"] })) {
      throw new Error("请先允许课记处理视频音轨。");
    }
    const settings = await getTranscriptionSettings();
    const { cachedAudio, videoPayload, audioSource } = await resolveValidatedAudioTrack(tabId, lessonHint);

    await ensureOffscreenDocument();
    const taskId = crypto.randomUUID();
    const transcription = {
      taskId,
      status: "starting",
      bvid: videoPayload.bvid,
      page: videoPayload.page,
      cid: videoPayload.cid,
      title: videoPayload.title,
      part: videoPayload.part,
      url: videoPayload.url,
      currentTime: 0,
      duration: audioSource?.duration || videoPayload.duration || 0,
      segments: [],
      detectedLanguages: [],
      text: "",
      error: "",
      method: "direct",
      fromCache: Boolean(cachedAudio)
    };
    await chrome.storage.local.set({ transcription });
    try {
      const response = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "START_DIRECT_AUDIO_TRANSCRIPTION",
        taskId,
        audioSource,
        video: videoPayload,
        settings
      });
      if (!response?.ok) throw new Error(response?.error || "无法启动快速音轨转写。");
      return transcription;
    } catch (error) {
      await chrome.offscreen.closeDocument().catch(() => {});
      throw error;
    }
  }

  async function retranscribeAudioRange(message: any) {
    const start = Number(message.start);
    const end = Number(message.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 180) {
      throw new Error("片段时间范围无效；单次重识别最多支持 3 分钟音频。");
    }
    const settings = await getTranscriptionSettings();
    settings.language = String(message.language || "").trim().toLowerCase();
    if (settings.language && !/^[a-z]{2}$/.test(settings.language)) {
      throw new Error("转写语言请填写两字母代码，例如 zh、en 或 ja。");
    }

    const lessonTarget: VideoTarget = { bvid: message.bvid, page: message.page, url: message.url };
    const cachedAudio = await getCachedAudio(lessonTarget);
    let audioSource: Record<string, any> | null = null;
    let videoUrl = cachedAudio?.meta?.url || message.url || "";
    let bvid = String(message.bvid || cachedAudio?.meta?.bvid || "").toUpperCase();
    let page = Number(message.page || cachedAudio?.meta?.page) || 1;

    if (!cachedAudio) {
      const tab = await getVideoTab(message.tabId, lessonTarget);
      const videoInfo = await readCurrentVideo(tab.id);
      if (videoInfo.video.bvid !== message.bvid || Number(videoInfo.video.page) !== Number(message.page)) {
        throw new Error("当前 B 站视频或分 P 已变化，请重新载入工作区后再试。");
      }
      audioSource = await readCurrentDashSource(tab.id, "audio", 0, lessonTarget);
      const audioUrl = isBilibiliCdnUrl(audioSource.url, true);
      if (!audioUrl) throw new Error("B 站返回了未识别或非 HTTPS 的音频服务器地址，课记没有下载。");
      if (!await chrome.permissions.contains({ origins: [`${audioUrl.origin}/*`] })) {
        throw new Error("扩展还没有当前 B 站音频服务器的访问权限，请重试并允许访问音频服务器。");
      }
      await configureBilibiliCdnRequestHeaders(new URL(tab.url).origin);
      videoUrl = tab.url;
      bvid = videoInfo.video.bvid;
      page = videoInfo.video.page;
    }

    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "RETRANSCRIBE_AUDIO_RANGE",
      audioSource,
      useCachedAudio: Boolean(cachedAudio),
      videoUrl,
      bvid,
      page,
      start,
      end,
      settings
    });
    if (!response?.ok) throw new Error(response?.error || "重新识别失败。");
    return { ok: true, segments: response.segments || [] };
  }

  function handleOffscreenMessage(message: any) {
    return queueTranscriptionUpdate(() => applyTranscriptionUpdate(message));
  }

  async function applyTranscriptionUpdate(message: any) {
    const { transcription = {} } = await chrome.storage.local.get("transcription");
    if (transcription.taskId && transcription.taskId !== message.taskId) {
      return { ok: true, ignored: true };
    }
    const cacheIfReady = (state: any) => {
      if (state.bvid && state.page && state.text) {
        return putCachedTranscription(
          { bvid: state.bvid, page: state.page, url: state.url },
          {
            cid: state.cid || 0,
            title: state.title || "",
            part: state.part || "",
            duration: Number(state.duration) || 0,
            text: state.text,
            segments: Array.isArray(state.segments) ? state.segments : [],
            detectedLanguages: Array.isArray(state.detectedLanguages) ? state.detectedLanguages : []
          }
        ).catch(() => {});
      }
      return Promise.resolve();
    };
    if (message.type === "TRANSCRIPTION_PROGRESS") {
      await chrome.storage.local.set({ transcription: { ...transcription, ...message.state } });
      return { ok: true };
    }
    if (message.type === "TRANSCRIPTION_SEGMENTS") {
      const segments: TranscriptSegment[] = [...(transcription.segments || []), ...(message.segments || [])]
        .sort((a, b) => a.time - b.time);
      const detectedLanguages = [...new Set([
        ...(transcription.detectedLanguages || []),
        ...(Array.isArray(message.languages) ? message.languages : [message.language])
      ].map((language) => String(language || "").trim()).filter(Boolean))];
      const text = segments.map((segment) => `[${Keji.formatTime(segment.time)}] ${segment.text}`).join("\n");
      const next = { ...transcription, segments, text, detectedLanguages, status: transcription.status || "transcribing", error: "" };
      await chrome.storage.local.set({ transcription: next });
      await cacheIfReady(next);
      return { ok: true };
    }
    if (message.type === "TRANSCRIPTION_DONE") {
      const doneState = { ...transcription, ...message.state, status: "done" };
      await chrome.storage.local.set({ transcription: doneState });
      await cacheIfReady(doneState);
      await chrome.offscreen.closeDocument().catch(() => {});
      return { ok: true };
    }
    if (message.type === "TRANSCRIPTION_ERROR") {
      await chrome.storage.local.set({
        transcription: {
          ...transcription,
          ...message.state,
          status: message.state?.status === "cancelled" ? "cancelled" : "error",
          error: message.error
        }
      });
      await chrome.offscreen.closeDocument().catch(() => {});
      return { ok: true };
    }
    return { ok: false, error: "未知的转写状态消息。" };
  }

  async function getLessonCacheOverviewStatus(message: any) {
    const noteId = String(message.noteId || "").trim();
    let lessonKey = normalizeLessonKey(message.lessonKey || message);
    const matchingNotes = await findMatchingNotes({ lessonKey, noteId });
    if (!lessonKey && matchingNotes.length) lessonKey = Keji.lessonKey(matchingNotes[0]!);

    const opfsStatus = lessonKey ? await getLessonCacheStatus(lessonKey) : {
      lessonKey: "",
      hasAudio: false,
      audioBytes: 0,
      hasVideo: false,
      videoBytes: 0,
      hasMuxedVideo: false,
      muxedVideoBytes: 0,
      hasTranscript: false,
      transcriptBytes: 0,
      metaBytes: 0,
      opfsBytes: 0,
      meta: null
    };

    let noteIntermediate = 0;
    for (const note of matchingNotes) noteIntermediate += noteIntermediateBytes(note);
    return {
      ...opfsStatus,
      noteIntermediateBytes: noteIntermediate,
      totalBytes: opfsStatus.opfsBytes + noteIntermediate
    };
  }

  async function getAllCacheOverview() {
    const [opfs, notes] = await Promise.all([listAllLessonOpfsCaches(), getAllNotes()]);
    const lessonSet = new Set<string>();
    for (const [key, entry] of opfs.lessons) {
      if (entry.opfsBytes > 0) lessonSet.add(key);
    }
    let noteIntermediate = 0;
    for (const note of notes) {
      const size = noteIntermediateBytes(note);
      noteIntermediate += size;
      if (size > 0) lessonSet.add(Keji.lessonKey(note) || note.id);
    }
    const transcriptBytes = opfs.transcriptBytes + opfs.metaBytes + noteIntermediate;
    return {
      audioBytes: opfs.audioBytes,
      videoBytes: opfs.videoBytes,
      muxedVideoBytes: opfs.muxedVideoBytes,
      transcriptBytes,
      noteIntermediateBytes: noteIntermediate,
      totalBytes: opfs.audioBytes + opfs.videoBytes + opfs.muxedVideoBytes + transcriptBytes,
      lessonCount: lessonSet.size
    };
  }

  async function assertNotActiveForCacheCleanup(lessonKey = ""): Promise<void> {
    if (hasActiveGenerationTasks()) {
      throw new Error("当前有笔记生成任务正在运行，请先停止生成后再清理缓存。");
    }
    const { transcription = null } = await chrome.storage.local.get("transcription");
    if (transcription && ["starting", "downloading", "transcribing"].includes(transcription.status)
        && await hasOffscreenDocument()) {
      const taskKey = Keji.lessonKey(transcription);
      if (!lessonKey || !taskKey || taskKey === lessonKey) {
        throw new Error("当前有音轨转写任务正在运行，请先停止转写后再清理缓存。");
      }
    }
  }

  async function clearLessonCache(message: any) {
    const noteId = String(message.noteId || "").trim();
    let lessonKey = normalizeLessonKey(message.lessonKey || message);
    const matchingNotes = await findMatchingNotes({ lessonKey, noteId });
    if (!lessonKey && matchingNotes.length) lessonKey = Keji.lessonKey(matchingNotes[0]!);

    await assertNotActiveForCacheCleanup(lessonKey);
    if (matchingNotes.some((note) => note.generationStatus === "running")) {
      const { transcription = null } = await chrome.storage.local.get("transcription");
      if (hasActiveGenerationTasks() || (transcription && ["starting", "downloading", "transcribing"].includes(transcription.status))) {
        throw new Error("本节笔记正在生成中，请先停止后再清理缓存。");
      }
    }

    let freedBytes = 0;
    if (lessonKey) {
      const opfsCleared = await clearLessonOpfsCache(lessonKey);
      freedBytes += opfsCleared.freedBytes;
      const { transcription = null } = await chrome.storage.local.get("transcription");
      if (transcription && Keji.lessonKey(transcription) === lessonKey) {
        await chrome.storage.local.remove("transcription");
      }
      await releaseLessonAudio().catch(() => {});
    }

    const stripped = await stripIntermediateFromNotes(matchingNotes, false);
    return { freedBytes: freedBytes + stripped.freedBytes };
  }

  async function clearAllProcessCaches() {
    await assertNotActiveForCacheCleanup();
    const opfsCleared = await clearAllLessonOpfsCaches();
    await clearLegacyTranscriptDraftsStore();
    await chrome.storage.local.remove("transcription");
    await releaseLessonAudio().catch(() => {});
    const stripped = await stripIntermediateFromNotes(await getAllNotes(), true);
    return { freedBytes: opfsCleared.freedBytes + stripped.freedBytes, cleanedNotes: stripped.cleanedNotes };
  }
});
