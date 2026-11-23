<script lang="ts">
  import * as fc from '../../lib/workspace/flashcards.svelte.ts';

  let reviewSection: HTMLElement | undefined;
  let revealButton: HTMLButtonElement | undefined;
  let lastFocusTrigger = 0;

  $effect(() => {
    const trigger = fc.flashcardState.focusTrigger;
    if (!fc.flashcardState.visible || trigger <= 0 || trigger === lastFocusTrigger) return;
    lastFocusTrigger = trigger;
    requestAnimationFrame(() => {
      if (reviewSection) {
        window.scrollTo({ top: window.scrollY + reviewSection.getBoundingClientRect().top - 24 });
      }
      revealButton?.focus({ preventScroll: true });
    });
  });
</script>

<section
  bind:this={reviewSection}
  class="flashcard-review"
  class:hidden={!fc.flashcardState.visible}
  id="flashcard-review"
  aria-label="闪卡复习"
>
  <header class="flashcard-review-heading">
    <div>
      <p class="section-label">主动回忆</p>
      <h3>闪卡复习</h3>
      <p class="flashcard-progress" id="flashcard-progress" role="status" aria-live="polite">{fc.flashcardState.progress}</p>
      <p class="flashcard-shortcuts">快捷键：空格翻面 · 1 重来 · 2 有点难 · 3 记住了 · Esc 结束</p>
    </div>
    <button class="text-button" id="close-flashcard-review" type="button" onclick={() => fc.closeFlashcardReview()}>结束复习</button>
  </header>

  <article class="flashcard-card" class:hidden={!fc.flashcardState.cardVisible} id="flashcard-card">
    <p class="flashcard-face-label">问题</p>
    <div class="flashcard-face-content" id="flashcard-front">{fc.flashcardState.front}</div>
    <div class="flashcard-answer" class:hidden={!fc.flashcardState.answerRevealed} id="flashcard-answer-wrap">
      <p class="flashcard-face-label">答案</p>
      <div class="flashcard-face-content" id="flashcard-back">{fc.flashcardState.back}</div>
    </div>
    <a
      class="flashcard-source"
      class:hidden={!fc.flashcardState.sourceUrl}
      href={fc.flashcardState.sourceUrl}
      id="flashcard-source"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="跳转到视频对应时间"
    >{fc.flashcardState.sourceLabel}</a>
  </article>

  <div class="flashcard-controls">
    <button
      bind:this={revealButton}
      class="primary-button"
      class:hidden={fc.flashcardState.answerRevealed}
      id="reveal-flashcard"
      type="button"
      onclick={() => fc.revealFlashcard()}
    ><span>显示答案</span><span aria-hidden="true">↓</span></button>
    <div class="flashcard-ratings" class:hidden={!fc.flashcardState.ratingsVisible} id="flashcard-ratings" role="group" aria-label="评估记忆情况">
      <button class="secondary-button" id="rate-again" type="button" disabled={fc.flashcardState.saving} onclick={() => fc.gradeFlashcard('again')}>
        <strong>重来</strong><span>10 分钟</span>
      </button>
      <button class="secondary-button" id="rate-hard" type="button" disabled={fc.flashcardState.saving} onclick={() => fc.gradeFlashcard('hard')}>
        <strong>有点难</strong><span id="hard-interval">{fc.flashcardState.hardInterval}</span>
      </button>
      <button class="primary-button" id="rate-good" type="button" disabled={fc.flashcardState.saving} onclick={() => fc.gradeFlashcard('good')}>
        <span>记住了</span><span id="good-interval">{fc.flashcardState.goodInterval}</span>
      </button>
    </div>
  </div>

  <div class="flashcard-finished" class:hidden={!fc.flashcardState.finished} id="flashcard-finished">
    <p id="flashcard-finished-copy">{fc.flashcardState.finishedCopy}</p>
    <button class="text-button" class:hidden={!fc.flashcardState.hasMissed} id="retry-missed-flashcards" type="button" onclick={() => fc.retryMissedFlashcards()}>重练错题</button>
    <button class="text-button" id="restart-flashcards" type="button" onclick={() => fc.restartFlashcards()}>再练一遍全部</button>
  </div>
</section>

<style>
  .flashcard-review {
    margin-top: 24px;
    border-top: 1px solid var(--border);
    padding-top: 20px;
  }

  .flashcard-review-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px 16px;
  }

  .flashcard-review-heading > div {
    min-width: 0;
  }

  .flashcard-review-heading h3 {
    margin: 4px 0 0;
    font-size: 18px;
    font-weight: 600;
  }

  .flashcard-progress {
    min-height: 20px;
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .flashcard-shortcuts {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 12px;
  }

  .flashcard-card {
    max-width: 820px;
    min-height: 192px;
    margin: 16px auto 0;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px 32px;
    background: var(--well);
  }

  .flashcard-face-label {
    margin: 0 0 8px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
  }

  .flashcard-face-content {
    color: var(--ink);
    font-size: 17px;
    line-height: 1.8;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .flashcard-answer {
    margin-top: 24px;
    border-top: 1px solid var(--border);
    padding-top: 16px;
  }

  .flashcard-source {
    display: inline-block;
    margin-top: 16px;
    color: var(--accent);
    font-size: 13px;
    text-decoration: underline;
  }

  .flashcard-controls {
    max-width: 820px;
    margin: 16px auto 0;
  }

  .flashcard-controls > :global(.primary-button) {
    margin-top: 0;
  }

  .flashcard-ratings {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .flashcard-ratings > button {
    display: flex;
    min-height: 48px;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 0;
    padding: 8px 12px;
  }

  .flashcard-ratings strong {
    font-size: 13px;
    font-weight: 600;
  }

  .flashcard-ratings span {
    color: inherit;
    font-size: 12px;
  }

  .flashcard-finished {
    display: flex;
    max-width: 820px;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
    margin: 16px auto 0;
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }

  .flashcard-finished p {
    min-width: 0;
    flex: 1 1 240px;
    margin: 0;
    color: var(--muted);
    font-size: 13px;
  }

  .flashcard-finished :global(.text-button) {
    color: var(--accent);
  }

  @media (max-width: 700px) {
    .flashcard-card {
      min-height: 176px;
      padding: 20px 16px;
    }

    .flashcard-ratings {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
