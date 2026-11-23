<script lang="ts">
  import * as qz from '../../lib/workspace/quiz.svelte.ts';

  let quizSection: HTMLElement | undefined;
  let lastFocusTrigger = 0;

  $effect(() => {
    const trigger = qz.quizState.focusTrigger;
    if (!qz.quizState.visible || trigger <= 0 || trigger === lastFocusTrigger) return;
    lastFocusTrigger = trigger;
    requestAnimationFrame(() => {
      if (quizSection) {
        window.scrollTo({ top: window.scrollY + quizSection.getBoundingClientRect().top - 24 });
      }
    });
  });
</script>

<section
  bind:this={quizSection}
  class="quiz-panel"
  class:hidden={!qz.quizState.visible}
  id="quiz-panel"
  aria-label="随堂自测"
>
  <header class="quiz-heading">
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
      >{qz.quizState.wrongOnly ? '显示全部重做' : '重新作答'}</button>
      <button
        class="text-button"
        class:hidden={qz.quizState.isTemplateQuiz}
        id="regenerate-quiz"
        type="button"
        disabled={qz.quizState.generating}
        onclick={() => qz.generateQuizForActiveNote()}
      >{qz.quizState.generating ? '正在出题…' : '重新出题'}</button>
      <button class="text-button" id="close-quiz-panel" type="button" onclick={() => qz.closeQuizPanel()}>收起</button>
    </div>
  </header>

  {#if !qz.quizState.questions.length}
    <p class="quiz-empty">还没有解析出可用的自测题目；点击「生成随堂自测」即可围绕本节内容自动出题。</p>
  {:else}
    <ol class="quiz-list">
      {#each qz.quizState.questions as item, index (item.id)}
        {@const chosen = qz.quizState.answers[item.id] || ''}
        {@const videoUrl = qz.videoLinkForQuizTimestamp(item.timestamp)}
        <li class="quiz-card">
          <p class="quiz-question">
            <span class="quiz-index">Q{index + 1}</span>
            <span>{item.question}</span>
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
                <span class="quiz-option-text">{opt.text}</span>
                {#if isCorrect}
                  <span class="quiz-option-badge">正确</span>
                {:else if isWrongChoice}
                  <span class="quiz-option-badge">已选</span>
                {/if}
              </button>
            {/each}
          </div>
          {#if chosen}
            <div class="quiz-explanation" class:is-right={chosen === item.answer}>
              <strong>{chosen === item.answer ? '回答正确' : `回答有误（正确答案：${item.answer}）`}</strong>
              {#if item.explanation}
                <p>{item.explanation}</p>
              {/if}
              {#if videoUrl}
                <a class="quiz-source-link" href={videoUrl} target="_blank" rel="noopener noreferrer">回看原视频讲解 · {item.timestamp} ↗</a>
              {/if}
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
    margin: 24px auto 0;
    border-top: 1px solid var(--border);
    padding-top: 20px;
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

  .quiz-empty {
    margin: 16px 0 0;
    color: var(--muted);
    font-size: 13px;
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

  .quiz-source-link {
    display: inline-block;
    margin-top: 8px;
    color: var(--accent);
    font-size: 12px;
    font-weight: 600;
    text-decoration: underline;
  }

  @media (max-width: 700px) {
    .quiz-card {
      padding: 14px 12px;
    }
  }
</style>
