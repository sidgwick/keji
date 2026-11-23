# 课记：B 站视频笔记扩展

一个本地运行的 Chrome / Edge Manifest V3 扩展。支持在「01 模型连接」中显式配置接口协议（`通用 OpenAI 兼容 / 中转站` 或 `小米 MiMo 开放平台`）与四档模型能力（`支持文本`、`支持图片`、`支持视频但不理解音轨`、`支持视频且理解音轨`）。前三档先读取 B 站字幕或通过本机/云端 `/audio/transcriptions` 转写文字稿，再按能力做纯文本、关键帧图片或紧凑视频校对；选择`支持视频且理解音轨`时，即使没有字幕也可免转写直接提取音频分片与画面联合生成课程笔记。

## 本地安装

1. 安装 Node.js 22 或更高版本，在仓库根目录运行 `npm install` 和 `npm run build`。
2. 在 Chrome 或 Edge 打开 `chrome://extensions` 或 `edge://extensions`，打开“开发者模式”。
3. 选择“加载已解压的扩展程序”，选中 `.output/chrome-mv3`。
4. 打开课记工作区左侧栏底部的“设置”（或通过扩展管理页的“扩展程序选项”跳转），填写笔记 API 地址、模型名称和可选的 API Key；可以先点“测试模型连接”发送一条简短文本请求，确认服务地址与模型可用。该测试会按服务商规则计费，不会发送音频或视频。
5. 没有字幕时，可填写云端语音识别 API 地址，或按下面的步骤启动本机 Whisper 服务并填写本机地址。
6. 保存时允许扩展访问所配置的笔记 API 和当前语音识别服务地址。
7. 在 B 站视频播放页点击工具栏中的“课记”，会打开独立的课程工作区，并自动填入当前视频链接。也可以直接打开课记，再粘贴视频链接。

开发时运行 `npm run dev` 并保持终端进程运行。首次在 Chrome/Gmail profile 的 `chrome://extensions` 中启用开发者模式，加载 `.output/chrome-mv3-dev`；这个开发版会由 WXT 监听源码变化并自动热更新或重载受影响的扩展页面。不要在开发时改用 `npm run build`：它生成正式版 `.output/chrome-mv3`，不会连接开发热更新服务，重新构建后需要在扩展管理页手动重载正式版。

### 打包本地安装包

运行 `npm run zip`，WXT 会构建并打包 Chrome 扩展。也可以运行 `python3 scripts/package-extension.py` 生成并校验 `dist/keji-v<版本号>.zip`。

扩展入口与 Svelte 界面位于 `src/entrypoints/`。领域与共享模块按无环分层拆分在 `src/lib/` 中：
- **基础领域层**：笔记结构注册表 `src/lib/note-structures.ts`、Markdown 合并与安全渲染 `src/lib/markdown.ts`、SRT/TXT 字幕编解码 `src/lib/subtitles.ts`、ZIP 资源包构建 `src/lib/bundle-zip.ts`、记忆闪卡解析与间隔重复 `src/lib/flashcards.ts`、随堂自测题解析与判分 `src/lib/quiz.ts`，以及协议/时间等核心辅助 `src/lib/keji.ts`。
- **后台服务层（`src/lib/background/`）**：B 站页签与流解析 `bilibili.ts`、IndexedDB 笔记库 `notes-db.ts`、WebDAV 同步 `webdav-sync.ts`、多模态 LLM 调用（含随堂自测与三模式对话）`llm-service.ts`，由 `src/entrypoints/background/index.ts` 统一路由消息与过程缓存。
- **工作区控制器与面板**：响应式状态 `src/lib/workspace/state.svelte.ts`、视觉抽帧管线 `visual-pipeline.ts`、共享界面工具 `ui.ts`，以及独立功能控制器 `transcription.svelte.ts`、`flashcards.svelte.ts`、`quiz.svelte.ts`、`discussion.svelte.ts`；对应工作区组件按模块拆分为 `DashboardPanel.svelte`、`TranscriptPanel.svelte`、`MarkdownEditor.svelte`、`QuizPanel.svelte`、`FlashcardPanel.svelte`、`DiscussionPanel.svelte`、`NoteLibrary.svelte`、`TemplatePicker.svelte`、`WorkspaceRail.svelte`、`SettingsPanel.svelte` 与主壳层 `App.svelte`。构建产物由 WXT 写入 `.output/`。

API 地址示例为服务商文档中提供的根地址，例如 `https://api.example.com/v1`。扩展向该地址的 `/chat/completions` 路径发送请求。API Key 可以留空，适用于本机无鉴权的兼容服务。

## 当前功能

- 在独立扩展标签页中整理课程；从 B 站播放页点击课记图标时，会自动带入该视频链接。
- 没有从 B 站视频打开时先进入课程控制台，显示本机笔记数、学习课程数、累计学习时长、已完成整理数和最近 5 篇笔记；近期记录显示模型、整理状态与处理时间，可直接继续编辑。带 B 站链接打开时仍直接进入对应课程。
- 读取课程标题、分 P 目录和当前分 P 的字幕时间戳；多字幕轨时可切换字幕语言；多 P 课程可在右侧抽屉搜索分 P、查看「已记」状态并随时切换节次或载入其他 B 站视频链接。
- 提供详细笔记、精简总结、实操步骤、时间线梳理、记忆闪卡、随堂自测和自定义 Prompt 共 7 种模块化的笔记结构；预览中的时间戳可点击跳回当前分 P 对应位置。
- 支持记忆闪卡主动回忆与 Anki 导出：生成「记忆闪卡」或包含问答表格的笔记后，可在工作区直接翻面复习（支持 `Space` 翻面、`1/2/3` 评估“重来/有点难/记住了”、自动重练错题、一键跳回原视频对应时间戳），间隔重复进度随笔记保存在本机；笔记库支持一键「复习到期闪卡」跨课程集中复习，并支持将单篇或全部闪卡导出为标准 Anki `.tsv` 文件。
- 支持「随堂自测」主动理解检验：既可直接选用「随堂自测」笔记结构，也可在任意已生成笔记的工具栏点击「随堂自测」按需基于文字稿与笔记生成 4–6 道聚焦核心原理、易混点与推导关键的单选题（含解析、视频时间戳跳转与答疑回看）；作答进度与错题重练状态随笔记保存在本机。
- 没有可用字幕时，默认直接读取播放器提供的 DASH 音轨，下载当前分 P 的完整音频（并按课节缓存在本机 OPFS 目录中）并在本机按约三分钟切段；各段可分发到多个云端或本机 `/audio/transcriptions` API 并行识别，转写结果（含时间戳分段和检测语言）同样会按课节缓存在本机 OPFS 目录中，文字稿随分段识别逐步显示。服务返回检测语言时，工作区会汇总显示各时间段的语言。某个 API 请求失败时会尝试其他已配置端点，后台会串行合并各段结果以防并发覆盖；失败时保留已识别内容，且不会覆盖用户手动修改的文字稿。视频无需播放。
- 选中一条或多条带时间戳的转写行后，可单独在界面中切换语言并重新识别对应音频片段；请求会在选区前后保留几秒上下文，识别结果只替换选中的文字稿行。若本机已缓存该分 P 的音轨（或五分钟内重复识别相同选区），将直接复用本地缓存的音轨而无需重新下载，也不要求原 B 站标签页保持打开。
- 手动编辑或导入的文字稿会随当前课程缓存在本机 OPFS 目录中，重新打开同一分 P 可直接续用；点击“重新读取字幕”可恢复 B 站原字幕，也可导出 `.txt` 纯文本或 `.srt` 字幕。
- 按「01 模型连接」中的协议模板与四档模型能力调度多模态请求：
  - **支持文本**：仅发纯文本整理笔记和讨论，不向模型提交图片或视频流。
  - **支持图片**：在全片均匀与讲稿时间分布基础上抽取最多 24 张候选帧，由视觉模型筛选并校准最多 8 张关键画面嵌入 Markdown（`image_url`）。
  - **支持视频但不理解音轨**：先获取字幕或语音转写文字稿，再优先筛选紧凑 MP4 视频流（Base64 内联上限约 36 MB 原始视频）连同 `video_url` 块联合校对画面与时间点（小米 MiMo 协议自动附带适配 `fps` 与 `media_resolution: "default"`）；超限或接口不支持时自动回退到关键帧分析。
  - **支持视频且理解音轨**：无字幕视频无需先行转写即可直接生成笔记；扩展会下载并缓存 B 站音轨解码切片为 10 分钟以内的 WAV Base64 段（MiMo 传 `data:audio/wav;base64,...`，通用 OpenAI 传 `{ data, format: "wav" }`）直接交由模型分段听写整理，随后结合视频流或候选关键帧校对画面并截取高清截图。视频轨与音轨优先写入浏览器 OPFS 过程缓存，后续切换模板重生成或重试画面分析直接复用。
- 支持一键清理过程文件缓存：在笔记详情页可清理单节过程缓存，在笔记库和「设置 → 05 其他信息」可查看音轨/原视频/转写缓存占用并清理全部过程数据；清理只移除缓存的音轨、原视频流与过程转写文本，**完整保留所有已生成笔记的正文、内嵌关键帧截图与讨论记录**。
- 生成后可在工作区切换“预览 / 编辑”修订 Markdown，标题失焦或回车即独立保存；离开编辑器或切换页面前会提示是否放弃未保存修改。预览支持标题、嵌套列表、任务列表、引用、代码块、表格、公式块及内嵌截图；可复制 Markdown 或导出包含相对路径截图文件的 ZIP 资源包。
- 笔记生成后提供三种互动模式：
  - **课程答疑**：围绕当前视频讲稿、笔记与关键帧截图解释概念、推导或代码细节，附带可点击跳回原视频的时间戳链接，不改动笔记正文。
  - **费曼复述**：用自己的话复述本节核心原理后，由模型对照原视频讲稿指出理解准确之处、遗漏或概念偏差，并给出关键追问，不改动笔记正文。
  - **修订笔记**：让模型结合文字稿与最多 8 张已选关键帧画面直接修改或重排整份 Markdown 笔记，保留原截图与时间戳。笔记库支持按课程（BV 号）聚合多 P 笔记或按时间展示，支持按状态、模型和关键词筛选，支持行内改名、原视频直达、资源包导出与删除。
- 可选配置 WebDAV 文件 URL，在笔记库手动上传或下载合并本机笔记库；也可明确启用自动同步。自动同步默认关闭，启用后会将包含文字稿、讨论和关键帧截图的完整笔记库在保存、修改或删除后的约两分钟空闲期传到该地址；每次先下载并合并远程更改，再上传合并结果。删除记录也会传播，避免旧副本把已删笔记重新带回。笔记只传输到你配置的 WebDAV 端点，不会发送到模型 API。配置了同步端点后笔记库会显示同步状态，也提供“立即同步”。建议使用 HTTPS；每台设备使用相同地址即可搬运和合并本机笔记。上传前会校验上次下载的远程版本，并优先使用 ETag、其次使用 Last-Modified 条件写入；服务器未提供这两种校验信息时会拒绝覆盖，避免静默丢失并发更改。发现远端已变化时，需先下载合并再上传。单个备份上传或下载上限为 200 MiB。
- API Key 和笔记保存在当前浏览器；模型请求从扩展后台直接发到配置的 API。

## 本机 Whisper 转写

扩展调用 [Speaches](https://github.com/speaches-ai/speaches) 提供的 OpenAI 兼容 `/audio/transcriptions` API。Speaches 有 CPU 和 CUDA 镜像；要使用 NVIDIA GPU，必须先让宿主 Linux 的 NVIDIA 驱动正常工作，再把 GPU 设备映射进容器。镜像和语音模型首次下载需要网络，后续转写在本机完成。

### Arch Linux + NVIDIA GPU

RTX 50 系列（Blackwell）在 Arch 上使用 `nvidia-open` 内核模块和 `nvidia-utils`。如果使用标准 Arch `linux` 内核，安装 NVIDIA 驱动与容器工具：

```sh
sudo pacman -Syu nvidia-open nvidia-utils nvidia-container-toolkit
```

重启后确认宿主机驱动已接管显卡：

```sh
nvidia-smi
```

此命令应显示显卡和驱动版本；如果提示无法连接 NVIDIA 驱动，先解决宿主机驱动问题，容器暂时仍无法使用 GPU。使用其他内核时，改装 `nvidia-open-dkms` 并安装对应内核的 headers。

Docker Engine 28.3 或更新版本支持 CDI 设备映射。启用 NVIDIA CDI 自动刷新并检查设备：

```sh
sudo systemctl enable --now nvidia-cdi-refresh.path
sudo systemctl restart nvidia-cdi-refresh.service
nvidia-ctk cdi list
```

列表应包含 `nvidia.com/gpu=0`。容器通过 CDI 映射 GPU，不需要把 NVIDIA 驱动安装进容器，也不需要为此重启 Docker daemon。

### 启动 GPU 版 Speaches

以下命令会替换已有的 CPU 版 `speaches` 容器，保留 `speaches-model-cache` 中已下载的模型。服务只绑定到本机回环地址，不对局域网开放。RTX 5060 8 GB 显存可先用 large-v3 的 `int8_float16`；若希望优先节省显存，可把模型改为 `Systran/faster-whisper-medium`。

```sh
docker rm -f speaches 2>/dev/null || true
docker run --detach --name speaches --restart unless-stopped \
  --publish 127.0.0.1:8000:8000 \
  --volume speaches-model-cache:/home/ubuntu/.cache/huggingface/hub \
  --device nvidia.com/gpu=all \
  --env WHISPER__INFERENCE_DEVICE=cuda \
  --env WHISPER__COMPUTE_TYPE=int8_float16 \
  ghcr.io/speaches-ai/speaches:latest-cuda
```

确认服务可用并下载多语言模型：

```sh
curl http://127.0.0.1:8000/health
curl -X POST http://127.0.0.1:8000/v1/models/Systran/faster-whisper-large-v3
curl http://127.0.0.1:8000/v1/models
docker logs --tail 100 speaches
```

`nvidia-smi` 可观察转写时的 GPU 显存占用。若 CUDA 或设备映射报错，检查 `nvidia-smi`、`nvidia-ctk cdi list` 和 Speaches 日志；若显存不足，可先改用 `Systran/faster-whisper-medium`。如需回退到 CPU，将镜像改成 `ghcr.io/speaches-ai/speaches:latest-cpu`，移除 `--device` 和两个 `WHISPER__...` CUDA 环境变量即可。

### 配置课记扩展

打开课记设置，在通用的语音识别配置中填写：

- 本机服务地址：`http://127.0.0.1:8000/v1/audio/transcriptions`；若运行多个 Whisper 服务，每行填一个地址
- 本机语音模型：`Systran/faster-whisper-large-v3`
- 语音识别 API Key：留空（Speaches 默认不需要鉴权）

保存设置时，在浏览器弹出的权限提示中允许访问 `127.0.0.1`。启动服务后，在 B 站视频页点击“获取音轨并转写”；课记会直接下载当前分 P 的音轨，无需播放或拖动进度条。多个 API 地址会自动分担各段；单地址自动按顺序处理。

云端和本机转写使用同一组“服务地址、模型、API Key”配置；可在地址框中每行填写一个转写服务，最多四个地址，共用模型和转写 API Key。可留空转写语言以自动检测，也可填写 `zh`、`en` 等两字母代码，并提供最多 200 字符的专业词汇提示。扩展只会调用已填写的服务，不会启动本机 Whisper 实例。自动模式下，一个地址串行处理，多个地址并行分发。转写 API Key 与笔记 API Key 分开保存，本机服务无鉴权时留空即可。音频只会发送到你填写的转写地址；使用本机地址时，不会把笔记 API Key 发给本机服务。

转写完成后，文字稿仍会发给你配置的笔记模型 API 生成 Markdown；若希望文字稿也留在本机，需要另行使用本地运行的笔记模型。

## 当前限制

- 一次整理一个分 P；同一课程可在右侧「课程选集」抽屉逐节切换并分别生成笔记。快速音轨转写会在浏览器解码音轨，转换为 WAV 分段后发送到配置的 API；浏览器不支持解码时会尝试发送完整 `.m4a`。语音转写需要兼容 OpenAI `/audio/transcriptions` 的服务；不同服务对 WAV、`m4a`、`verbose_json` 和时间戳字段的支持可能不同。本机转写速度和并行度取决于配置的服务实例及其 GPU 资源。
- 长文字稿按约 12,000 字符分段；首段先建立章节，之后按设置的并行度（1–4，默认 2）并行生成片段。相邻片段各提供最多 600 字符边界上下文，要求只整理当前片段。结果按原视频顺序合并并按标题层级合并重复章节，代码块内的标题不会误合并。每个按序完成的分段都会立即保存累计笔记与进度；如果服务商因生成长度上限或内容过滤提前终止某段，该段不会标记完成；中途失败或关闭工作区后，可从笔记库重新打开并从失败段续跑。较低并行度可减少服务商限流风险。API 计费由所选服务商决定。
- 音视频校对与笔记讨论会发送完整文字稿和当前笔记，不会静默截掉末尾内容；若超过服务商上下文限制，视频校对会走关键帧回退，讨论请求会明确显示 API 错误。
- 当前 B 站 DASH 视频轨不含音轨；「支持视频但不理解音轨」由同一请求中的字幕/转写文字稿补充口述信息，「支持视频且理解音轨」则额外从本机解码切片音轨分片发送音频块联合理解。受限于通用兼容接口的 Base64 内联体积上限，完整视频直传控制在约 36 MB（Base64 约 48 MB）以内，超出时自动回退至候选关键帧画面校对。完整视频请求由服务商按其采样策略抽帧，关键帧回退则由视觉模型从候选画面中筛选重点时刻，并在本机优先复用缓存视频轨截高清 JPEG 嵌入笔记。
- 若清理了全部过程缓存，将失去本节用于「重新生成」或「补充画面分析」的原始音视频与转写过程文本，但不会影响已生成的 Markdown 笔记正文、内嵌截图与讨论记录；如需再次生成，只需重新打开对应 B 站视频拉取字幕或音轨即可。
- 字幕接口与 B 站页面行为可能变化；字幕也可能受登录状态或视频设置影响。
- 目前只支持返回 `choices[0].message.content` 的 Chat Completions 兼容接口，不处理供应商特有的多模态或异步任务格式。
- 单文件 Markdown 使用内嵌图片，体积会比纯文本大；部分 Markdown 预览服务可能会禁用 `data:` 图片。
- 视频音频、文字稿和笔记会发送给用户配置的对应模型服务；请按该服务的隐私和用量规则使用。
