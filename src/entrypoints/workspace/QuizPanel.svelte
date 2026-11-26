<script lang="ts">
  import * as ctrl from '../../lib/workspace/controller.ts';
  import * as qz from '../../lib/workspace/quiz.svelte.ts';
  import { workspace } from '../../lib/workspace/state.svelte.ts';

  const isGeneratingQuiz = $derived(
    qz.quizState.generating || (workspace.activeNoteGenerating && workspace.generatingView === 'quiz')
  );

  function splitInlineCode(text: string): Array<{ code: boolean; value: string }> {
    const source = String(text || '');
    const parts: Array<{ code: boolean; value: string }> = [];
    let offset = 0;
    for (const match of source.matchAll(/`([^`]+)`/g)) {
      const idx = match.index || 0;
      if (idx > offset) parts.push({ code: false, value: source.slice(offset, idx) });
      parts.push({ code: true, value: match[1]! });
      offset = idx + match[0].length;
    }
    if (offset < source.length) parts.push({ code: false, value: source.slice(offset) });
    return parts;
  }
</script>

<section
  class="quiz-panel"
  class:hidden={workspace.noteTab !== 'quiz'}
  id="quiz-panel"
  aria-label="随堂自测"
>
  <header class="quiz-heading" class:hidden={!qz.quizState.hasQuestions}>
    <div>
      <p class="section-label">理解检验</p>
      <h3>随堂自测</h3>
      <p class="quiz-progress" id="quiz-progress" role="status" aria-live="polite">{qz.quizState.progressLabel}</p>
    </div>
    <div class="quiz-header-actions">
      <button
        class="text-button"
        class:hidden={!qz.quizState.hasWrong}
        id="retry-wrong-quiz"
        type="button"
        disabled={qz.quizState.saving}
        onclick={() => qz.retryWrongQuizQuestions()}
      >重做错题</button>
      <button
        class="text-button"
        class:hidden={!qz.quizState.hasQuestions}
        id="reset-quiz-answers"
        type="button"
        disabled={qz.quizState.saving}
        onclick={() => qz.resetAllQuizAnswers()}
      >{qz.quizState.wrongOnly ? '重做全部题目' : '重新作答'}</button>
      <button
        class="text-button"
        id="regenerate-quiz"
        type="button"
        disabled={isGeneratingQuiz || workspace.generating || !qz.quizState.canGenerate}
        onclick={() => qz.generateQuizForActiveNote()}
      >{isGeneratingQuiz ? '正在出题…' : '重新出题'}</button>
    </div>
  </header>

  {#if !qz.quizState.hasQuestions}
    <div class="quiz-empty-card">
      <div>
        <strong>{isGeneratingQuiz ? '正在生成本节随堂自测…' : '还没有随堂自测题'}</strong>
        <p>{isGeneratingQuiz ? '正在结合本节内容设计理解检验单选题，完成后自动展示并保存。' : '结合本节笔记或文字稿自动出 5–8 道理解检验单选题，支持即时解析、错题重做与原视频回看。'}</p>
      </div>
      <button
        class="primary-button quiz-generate-button"
        id="generate-quiz-empty"
        type="button"
        disabled={isGeneratingQuiz || workspace.generating || !qz.quizState.canGenerate}
        onclick={() => qz.generateQuizForActiveNote()}
      >{isGeneratingQuiz ? '正在生成自测题…' : '生成本节随堂自测'}</button>
    </div>
  {:else}
    <ol class="quiz-list">
      {#each qz.quizState.questions as item, index (item.id)}
        {@const chosen = qz.quizState.answers[item.id] || ''}
        {@const videoUrl = qz.videoLinkForQuizTimestamp(item.timestamp)}
        <li class="quiz-card">
          <p class="quiz-question">
            <span class="quiz-index">Q{index + 1}</span>
            <span>
              {#each splitInlineCode(item.question) as seg}
                {#if seg.code}<code class="quiz-inline-code">{seg.value}</code>{:else}{seg.value}{/if}
              {/each}
            </span>
          </p>
          <div class="quiz-options" role="group" aria-label={`第 ${index + 1} 题选项`}>
            {#each item.options as opt (opt.key)}
              {@const selected = chosen === opt.key}
              {@const isCorrect = Boolean(chosen) && opt.key === item.answer}
              {@const isWrongChoice = Boolean(chosen) && selected && opt.key !== item.answer}
              <button
                type="button"
                class="quiz-option"
                class:is-correct={isCorrect}
                class:is-wrong={isWrongChoice}
                disabled={Boolean(chosen) || qz.quizState.saving}
                aria-pressed={selected}
                onclick={() => qz.selectQuizOption(item.id, opt.key)}
              >
                <span class="quiz-option-key">{opt.key}</span>
                <span class="quiz-option-text">
                  {#each splitInlineCode(opt.text) as seg}
                    {#if seg.code}<code class="quiz-inline-code">{seg.value}</code>{:else}{seg.value}{/if}
                  {/each}
                </span>
                {#if isCorrect}
                  <span class="quiz-option-badge">正确</span>
                {:else if isWrongChoice}
                  <span class="quiz-option-badge">误选</span>
                {/if}
              </button>
            {/each}
          </div>
          {#if chosen}
            <div class="quiz-explanation" class:is-right={chosen === item.answer}>
              <strong>{chosen === item.answer ? '回答正确' : `回答有误（正确答案：${item.answer}）`}</strong>
              {#if item.explanation}
                <p>
                  {#each splitInlineCode(item.explanation) as seg}
                    {#if seg.code}<code class="quiz-inline-code">{seg.value}</code>{:else}{seg.value}{/if}
                  {/each}
                </p>
              {/if}
              <div class="quiz-explanation-actions">
                {#if videoUrl}
                  <a class="quiz-source-link" href={videoUrl} target="_blank" rel="noopener noreferrer">回看原视频讲解 · {item.timestamp} ↗</a>
                {/if}
                <button
                  type="button"
                  class="text-button quiz-ask-assistant"
                  onclick={() => ctrl.askAssistantAboutQuizItem(item, chosen)}
                >向助教追问 ↗</button>
                <button
                  type="button"
                  class="text-button quiz-ask-assistant"
                  onclick={() => ctrl.saveQuizItemToPersonalNote(item, chosen)}
                >📌 记入批注</button>
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .quiz-panel {
    max-width: 820px;
    margin: 16px auto 0;
  }

  .quiz-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px 16px;
  }

  .quiz-heading > div:first-child {
    min-width: 0;
    flex: 1 1 260px;
  }

  .quiz-heading h3 {
    margin: 4px 0 0;
    font-size: 18px;
    font-weight: 600;
  }

  .quiz-progress {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .quiz-header-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
  }

  .quiz-empty-card {
    display: grid;
    gap: 16px;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
    background: var(--well);
  }

  .quiz-empty-card strong {
    display: block;
    font-size: 16px;
    font-weight: 600;
  }

  .quiz-empty-card p {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
  }

  .quiz-generate-button {
    width: auto;
    justify-self: start;
    margin-top: 0;
  }

  .quiz-list {
    display: grid;
    gap: 16px;
    margin: 16px 0 0;
    padding: 0;
    list-style: none;
  }

  .quiz-card {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 18px;
    background: var(--well);
  }

  .quiz-question {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0 0 12px;
    font-size: 15px;
    font-weight: 600;
    line-height: 1.65;
    color: var(--ink);
  }

  .quiz-index {
    flex: none;
    border-radius: 6px;
    padding: 1px 7px;
    background: var(--active);
    color: var(--accent);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .quiz-inline-code {
    display: inline-block;
    margin: 0 2px;
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(15, 23, 42, 0.06);
    font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 0.9em;
    font-weight: 500;
  }

  .quiz-options {
    display: grid;
    gap: 8px;
  }

  .quiz-option {
    display: flex;
    width: 100%;
    min-height: 42px;
    align-items: flex-start;
    gap: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 9px 12px;
    background: var(--surface);
    color: var(--ink);
    font-size: 14px;
    line-height: 1.55;
    text-align: left;
  }

  .quiz-option:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--active);
  }

  .quiz-option:disabled {
    cursor: default;
    opacity: 1;
  }

  .quiz-option.is-correct {
    border-color: var(--success-border);
    background: var(--success-fill);
    color: var(--success);
  }

  .quiz-option.is-wrong {
    border-color: var(--danger-border);
    background: var(--danger-fill);
    color: var(--danger);
  }

  .quiz-option-key {
    flex: none;
    font-weight: 600;
  }

  .quiz-option-text {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .quiz-option-badge {
    flex: none;
    font-size: 12px;
    font-weight: 600;
  }

  .quiz-explanation {
    margin-top: 12px;
    border: 1px solid var(--danger-border);
    border-radius: 8px;
    padding: 10px 14px;
    background: var(--danger-fill);
    font-size: 13px;
    line-height: 1.65;
  }

  .quiz-explanation.is-right {
    border-color: var(--success-border);
    background: var(--success-fill);
  }

  .quiz-explanation strong {
    display: block;
    color: var(--danger);
    font-weight: 600;
  }

  .quiz-explanation.is-right strong {
    color: var(--success);
  }

  .quiz-explanation p {
    margin: 4px 0 0;
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  .quiz-explanation-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 14px;
    margin-top: 8px;
  }

  .quiz-source-link {
    display: inline-block;
    color: var(--accent);
    font-size: 12px;
    font-weight: 600;
    text-decoration: underline;
  }

  .quiz-ask-assistant {
    min-height: 26px;
    padding: 2px 6px;
    color: var(--accent);
    font-size: 12px;
    font-weight: 600;
  }

  @media (max-width: 700px) {
    .quiz-card {
      padding: 14px 12px;
    }
  }
</style>
