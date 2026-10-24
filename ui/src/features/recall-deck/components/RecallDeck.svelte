<script>
  import { toast, confirmDialog } from "../../../shared/stores/toasts.svelte.js";
  import { reportError } from "../../../shared/utils/errors.js";
  import { BrainCircuit, Plus, RotateCcw, Flame, CheckCircle, Clock, Target, ChevronRight, Edit2, Trash2, X, Layers, PartyPopper } from "lucide-svelte";
  import { cardsStore, loadData, startSession, endSession, rateCard } from "../stores/cards.svelte.js";
  import { cardsService } from "../services/cards.service.js";
  import { formatDate, getCardStatus, getDifficultyLevel } from "../utils/card-helpers.js";

  let { profileId = null } = $props();

  // Modal states
  let showCreateModal = $state(false);
  let editingCard = $state(null);
  let formData = $state({
    subjectId: null,
    front: "",
    back: "",
  });

  $effect(() => {
    if (profileId != null) {
      loadData(profileId);
    }
  });

  $effect(() => {
    const onChanged = () => loadData(profileId);
    window.addEventListener("cf:data-changed", onChanged);
    return () => window.removeEventListener("cf:data-changed", onChanged);
  });

  function openCreateModal() {
    editingCard = null;
    formData = {
      subjectId: cardsStore.allSubjects[0]?.id || null,
      front: "",
      back: "",
    };
    showCreateModal = true;
  }

  function openEditModal(card) {
    editingCard = card;
    formData = {
      subjectId: card.subjectId,
      front: card.front,
      back: card.back,
    };
    showCreateModal = true;
  }

  async function saveCard() {
    if (!formData.subjectId || !formData.front.trim() || !formData.back.trim()) {
      toast.warning("Please fill in all fields");
      return;
    }
    try {
      if (editingCard) {
        // Pass subjectId to allow changing the subject when editing
        await cardsService.update(profileId, editingCard.id, formData.subjectId, formData.front.trim(), formData.back.trim());
        toast.success("Card updated!");
      } else {
        await cardsService.create(profileId, formData.subjectId, formData.front.trim(), formData.back.trim());
        toast.success("Card created!", "It will appear in your deck soon");
      }
      showCreateModal = false;
      window.dispatchEvent(new Event("cf:data-changed"));
    } catch (e) {
      reportError(e);
    }
  }

  async function deleteCard(cardId) {
    const confirmed = await confirmDialog({
      title: "Delete Card",
      message: "Are you sure you want to delete this card? This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await cardsService.remove(profileId, cardId);
      toast.success("Card deleted");
      window.dispatchEvent(new Event("cf:data-changed"));
    } catch (e) {
      reportError(e);
    }
  }
</script>

<section class="recall-deck atl-view">
  <div class="deck-head">
    <div class="deck-title">
      <div>
        <h2>Recall Deck</h2>
        <p class="standing">
          {cardsStore.stats?.dueToday ?? 0} due today · {cardsStore.stats?.reviewedToday ?? 0} reviewed today
          · {cardsStore.stats?.totalCards ?? 0} in the deck
          {#if (cardsStore.stats?.streak ?? 0) > 0}· {cardsStore.stats.streak}-day streak{/if}
        </p>
      </div>
    </div>
    <div class="deck-actions">
      <div class="view-toggle" role="group" aria-label="Deck scope">
        <button
          class="toggle-btn"
          class:active={cardsStore.viewMode === "due"}
          aria-pressed={cardsStore.viewMode === "due"}
          onclick={() => (cardsStore.viewMode = "due")}
        >
          <Clock size={14} />
          Due ({cardsStore.stats?.dueToday ?? 0})
        </button>
        <button
          class="toggle-btn"
          class:active={cardsStore.viewMode === "all"}
          aria-pressed={cardsStore.viewMode === "all"}
          onclick={() => (cardsStore.viewMode = "all")}
        >
          <Target size={14} />
          All ({cardsStore.stats?.totalCards ?? 0})
        </button>
      </div>
      <button class="cf-btn primary" onclick={openCreateModal} disabled={profileId == null}>
        <Plus size={14} />
        Create Card
      </button>
    </div>
  </div>

  {#if profileId == null}
    <div class="warn-card">
      <p>Select a student profile to use the Recall Deck.</p>
    </div>
  {:else if cardsStore.loading}
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Loading cards...</p>
    </div>
  {:else if cardsStore.sessionMode && cardsStore.currentCard}
    <!-- Review Session -->
    <div class="session">
      <div class="progress-section">
        <div class="progress-bar">
          <div class="progress-fill" style="width: {cardsStore.progress}%"></div>
        </div>
        <div class="progress-text">
          <span>{cardsStore.currentIndex + 1} of {cardsStore.dueCards.length} cards</span>
          <span>{cardsStore.progress}% complete</span>
        </div>
      </div>

      <div class="card-container">
        <div class="flashcard" class:flipped={cardsStore.showAnswer}>
          <div class="card-face card-front-face">
            <div class="card-header">
              <span class="card-label">Question</span>
              <span class="card-subject">{cardsStore.currentCard.subjectName}</span>
            </div>
            <div class="card-content">{cardsStore.currentCard.front}</div>
          </div>
          <div class="card-face card-back-face">
            <div class="card-header">
              <span class="card-label">Answer</span>
              <span class="card-subject">{cardsStore.currentCard.subjectName}</span>
            </div>
            <div class="card-content">{cardsStore.currentCard.back}</div>
          </div>
        </div>
      </div>

      {#if !cardsStore.showAnswer}
        <button class="show-btn" onclick={() => (cardsStore.showAnswer = true)}>
          <ChevronRight size={20} />
          Show Answer
        </button>
      {:else}
        <div class="rating-buttons">
          <button class="rate-btn again" onclick={() => rateCard(profileId, 0)}>
            <span class="rate-label">Again</span>
            <span class="rate-interval">&lt;1m</span>
          </button>
          <button class="rate-btn hard" onclick={() => rateCard(profileId, 3)}>
            <span class="rate-label">Hard</span>
            <span class="rate-interval">~3d</span>
          </button>
          <button class="rate-btn good" onclick={() => rateCard(profileId, 4)}>
            <span class="rate-label">Good</span>
            <span class="rate-interval">~1w</span>
          </button>
          <button class="rate-btn easy" onclick={() => rateCard(profileId, 5)}>
            <span class="rate-label">Easy</span>
            <span class="rate-interval">~2w</span>
          </button>
        </div>
      {/if}

      <button class="end-btn" onclick={() => endSession(profileId)}>
        <RotateCcw size={14} />
        End Session
      </button>
    </div>
  {:else if cardsStore.viewMode === "due"}
    <!-- Due Cards View -->
    {#if cardsStore.dueCards.length > 0}
      <div class="due-cards">
        <div class="due-message">
          <div class="due-icon"><Layers size={22} strokeWidth={1.75} aria-hidden="true" /></div>
          <h3>You have {cardsStore.dueCards.length} card{cardsStore.dueCards.length > 1 ? "s" : ""} due for review!</h3>
          <p>Ready to test your memory?</p>
        </div>
        <button class="start-btn" onclick={startSession}>
          <BrainCircuit size={18} />
          Start Review Session
        </button>
      </div>
    {:else}
      <div class="no-cards">          <div class="celebration" aria-hidden="true">
            <PartyPopper size={28} strokeWidth={1.75} />
          </div>
        <h3>All caught up!</h3>
        <p>No cards due for review today.</p>
        {#if cardsStore.stats && cardsStore.stats.totalCards > 0}
          <div class="stats-info">
            <p>You have <strong>{cardsStore.stats.totalCards}</strong> card{cardsStore.stats.totalCards > 1 ? "s" : ""} in your deck.</p>
            {#if cardsStore.stats.streak > 0}
              <p class="streak-display">
                <Flame size={16} class="flame-icon" />
                Current streak: <strong>{cardsStore.stats.streak} day{cardsStore.stats.streak > 1 ? "s" : ""}</strong>
              </p>
            {/if}
          </div>
        {:else}
          <p class="hint">Create your first card to start building your recall deck!</p>
        {/if}
      </div>
    {/if}
  {:else}
    <!-- All Cards View — the deck as a review-ordered list, not a wall of
         tiles. Status, subject, question, answer and the SM-2 read-out are
         columns of one row; the edit/delete verbs stay at the row's end. -->
    <div class="all-cards-view">
      {#if cardsStore.allCards.length === 0}
        <p class="empty">No cards yet. Create your first flashcard!</p>
      {:else}
        <div class="cards-grid">
          {#each cardsStore.allCards as card (card.id)}
            {@const status = getCardStatus(card)}
            {@const difficulty = getDifficultyLevel(card)}
            <div class="card-item">
              <div class="card-item-head">
                <span class="card-status {status.class}">{status.text}</span>
                <span class="card-difficulty {difficulty.class}">{difficulty.text}</span>
                <span class="card-item-subject">{card.subjectName}</span>
                <span class="card-meta mono">
                  EF {card.easeFactor.toFixed(2)} · {card.interval}d
                </span>
              </div>
              <div class="card-item-front">
                <strong>Q:</strong> {card.front}
              </div>
              <div class="card-item-back">
                <strong>A:</strong> {card.back}
              </div>
              <div class="card-item-footer">
                <span class="card-meta">
                  Interval: {card.interval}d · due {getCardStatus(card).text.toLowerCase()}
                </span>
                <div class="card-item-actions">
                  <button class="mini-btn" onclick={() => openEditModal(card)} title="Edit">
                    <Edit2 size={12} />
                  </button>
                  <button class="mini-btn del" onclick={() => deleteCard(card.id)} title="Delete">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</section>

<!-- Create/Edit Modal -->
{#if showCreateModal}
  <div class="modal-backdrop" onclick={() => (showCreateModal = false)} role="presentation">
    <div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Card editor" tabindex="-1">
      <div class="modal-head">
        <h3>{editingCard ? "Edit Card" : "Create New Card"}</h3>
        <button class="close-btn" onclick={() => (showCreateModal = false)} aria-label="Close" title="Close"
          ><X size={13} strokeWidth={2} aria-hidden="true" /></button>
      </div>
      <div class="modal-body">
        <label>
          <span>Subject *</span>
          <select bind:value={formData.subjectId}>
            {#each cardsStore.allSubjects as s}
              <option value={s.id}>{s.track} › {s.name}</option>
            {/each}
          </select>
        </label>
        <label>
          <span>Front (Question) *</span>
          <textarea
            bind:value={formData.front}
            placeholder="e.g., What is the time complexity of binary search?"
            rows="3"
          ></textarea>
        </label>
        <label>
          <span>Back (Answer) *</span>
          <textarea
            bind:value={formData.back}
            placeholder="e.g., O(log n)"
            rows="3"
          ></textarea>
        </label>
      </div>
      <div class="modal-foot">
        <button class="cancel-btn" onclick={() => (showCreateModal = false)}>
          Cancel
        </button>
        <button class="save-btn" onclick={saveCard}>
          {editingCard ? "Update" : "Create"} Card
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .recall-deck {
    margin-top: 0;
  }

  .deck-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 0;
    flex-wrap: wrap;
    gap: 16px;
  }

  .deck-title {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .deck-title h2 {
    font-size: var(--text-2xl);
    margin: 0;
    color: var(--atlas-ink);
    font-weight: 650;
    letter-spacing: -0.01em;
  }

  .standing {
    font-size: var(--text-md);
    color: var(--atlas-ink-3);
    margin: 0;
    font-variant-numeric: tabular-nums;
  }

  .deck-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .view-toggle {
    display: flex;
    background: var(--surface);
    border-radius: var(--radius-lg);
    padding: 3px;
    border: 1px solid var(--border);
  }

  .toggle-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    color: var(--text-secondary);
    border: none;
    padding: 8px 14px;
    border-radius: var(--radius-md);
    font-size: var(--text-md);
    cursor: pointer;
    transition: all 0.15s;
  }

  .toggle-btn:hover {
    color: var(--text-main);
  }

  .toggle-btn.active {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }

  .warn-card {
    background: var(--color-warning-bg, var(--atlas-warn-bg));
    border: 1px solid var(--color-warning-border, var(--atlas-warn-bg));
    border-radius: var(--radius-lg);
    padding: 16px;
    color: var(--color-warning);
  }

  .warn-card p {
    margin: 0;
    font-size: var(--text-lg);
  }

  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 60px 20px;
    gap: 16px;
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .loading-state p {
    color: var(--text-muted);
    font-size: var(--text-lg);
    margin: 0;
  }

  /* Review Session */
  .session {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    padding: 28px;
  }

  .progress-section {
    margin-bottom: 24px;
  }

  .progress-bar {
    height: 10px;
    background: var(--bg-main);
    border-radius: var(--radius-sm);
    overflow: hidden;
    margin-bottom: 8px;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent), var(--color-success));
    transition: width 0.3s ease;
    border-radius: var(--radius-sm);
  }

  .progress-text {
    display: flex;
    justify-content: space-between;
    color: var(--text-muted);
    font-size: var(--text-md);
  }

  .card-container {
    perspective: 1200px;
    margin-bottom: 24px;
  }

  .flashcard {
    position: relative;
    width: 100%;
    min-height: 320px;
    transform-style: preserve-3d;
    transition: transform 0.6s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .flashcard.flipped {
    transform: rotateY(180deg);
  }

  .card-face {
    position: absolute;
    width: 100%;
    min-height: 320px;
    backface-visibility: hidden;
    background: var(--bg-main);
    border: 2px solid var(--border);
    border-radius: var(--radius-xl);
    padding: 32px;
    display: flex;
    flex-direction: column;
  }

  .card-back-face {
    transform: rotateY(180deg);
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
  }

  .card-label {
    font-size: var(--text-sm);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-muted);
    font-weight: 600;
  }

  .card-subject {
    font-size: var(--text-md);
    color: var(--accent);
  }

  .card-content {
    flex: 1;
    font-size: var(--text-2xl);
    color: var(--text-main);
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    line-height: 1.6;
    font-weight: 500;
  }

  .show-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    padding: 18px;
    background: var(--accent);
    color: var(--atlas-on-fill);
    border: none;
    border-radius: var(--radius-lg);
    font-size: var(--text-2xl);
    font-weight: 600;
    cursor: pointer;
    margin-bottom: 12px;
    transition: all 0.15s;
  }

  .show-btn:hover {
    filter: brightness(1.1);
    transform: translateY(-1px);
  }

  .rating-buttons {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 12px;
  }

  .rate-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 18px 8px;
    border: 2px solid;
    border-radius: var(--radius-lg);
    cursor: pointer;
    background: transparent;
    transition: all 0.2s;
  }

  .rate-btn:hover {
    transform: translateY(-2px);
  }

  .rate-label {
    font-size: var(--text-xl);
    font-weight: 600;
    margin-bottom: 4px;
  }

  .rate-interval {
    font-size: var(--text-sm);
    opacity: 0.8;
  }

  .rate-btn.again {
    border-color: var(--color-danger);
    color: var(--color-danger);
  }

  .rate-btn.again:hover {
    background: var(--color-danger-bg, var(--atlas-bad-bg));
  }

  .rate-btn.hard {
    border-color: var(--color-warning);
    color: var(--color-warning);
  }

  .rate-btn.hard:hover {
    background: var(--color-warning-bg, var(--atlas-warn-bg));
  }

  .rate-btn.good {
    border-color: var(--color-success);
    color: var(--color-success);
  }

  .rate-btn.good:hover {
    background: var(--color-success-bg, var(--atlas-ok-bg));
  }

  .rate-btn.easy {
    border-color: var(--accent);
    color: var(--accent);
  }

  .rate-btn.easy:hover {
    background: var(--accent-soft);
  }

  .end-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    padding: 12px;
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    cursor: pointer;
    font-size: var(--text-lg);
    transition: all 0.15s;
  }

  .end-btn:hover {
    background: var(--surface);
    color: var(--text-main);
    border-color: var(--border-strong);
  }

  /* Due Cards */
  .due-cards {
    background: linear-gradient(135deg, var(--accent-soft), var(--color-success-bg, var(--atlas-ok-bg)));
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    padding: 40px;
    text-align: center;
  }

  .due-message {
    margin-bottom: 28px;
  }

  .due-icon {
    font-size: var(--text-metric);
    margin-bottom: 16px;
  }

  .due-message h3 {
    font-size: var(--text-2xl);
    color: var(--text-main);
    margin: 0 0 8px 0;
    font-weight: 650;
  }

  .due-message p {
    color: var(--text-secondary);
    margin: 0;
    font-size: var(--text-xl);
  }

  .start-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 16px 32px;
    background: var(--accent);
    color: var(--atlas-on-fill);
    border: none;
    border-radius: var(--radius-lg);
    font-size: var(--text-2xl);
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }

  .start-btn:hover {
    filter: brightness(1.1);
    transform: translateY(-2px);
  }

  /* No Cards */
  .no-cards {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    padding: 48px 32px;
    text-align: center;
  }

  .celebration {
    font-size: var(--text-metric);
    margin-bottom: 16px;
  }

  .no-cards h3 {
    font-size: var(--text-2xl);
    color: var(--text-main);
    margin: 0 0 8px 0;
    font-weight: 650;
  }

  .no-cards p {
    color: var(--text-secondary);
    margin: 0;
    font-size: var(--text-xl);
  }

  .stats-info {
    margin-top: 20px !important;
    padding: 16px;
    background: var(--bg-main);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
  }

  .stats-info p {
    margin: 4px 0;
    font-size: var(--text-lg);
    color: var(--text-secondary);
  }

  .stats-info strong {
    color: var(--text-main);
  }

  .streak-display {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin-top: 8px !important;
  }

  .flame-icon {
    color: var(--color-warning);
  }

  .hint {
    margin-top: 16px !important;
    font-size: var(--text-lg);
    color: var(--text-muted) !important;
  }

  /* All Cards View */
  .all-cards-view {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    padding: 24px;
  }

  .stats-bar {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    margin-bottom: 24px;
  }

  .stat-item {
    background: var(--bg-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 16px;
    text-align: center;
    transition: all 0.15s;
  }

  .stat-item:hover {
    border-color: var(--border-strong);
  }

  .stat-item.streak {
    background: linear-gradient(135deg, var(--color-warning-bg, var(--atlas-warn-bg)), transparent);
    border-color: var(--color-warning-border, var(--atlas-warn-bg));
  }

  .stat-icon {
    color: var(--color-warning);
    margin-bottom: 4px;
  }

  .stat-value {
    display: block;
    font-size: var(--text-metric);
    font-weight: 700;
    color: var(--text-main);
    line-height: 1.2;
  }

  .stat-label {
    display: block;
    font-size: var(--text-md);
    color: var(--text-muted);
    margin-top: 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 500;
  }

  .empty {
    color: var(--text-muted);
    text-align: center;
    padding: 40px;
    font-size: var(--text-xl);
  }

  .cards-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 16px;
  }

  .card-item {
    background: var(--bg-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 18px;
    transition: all 0.15s;
  }

  .card-item:hover {
    border-color: var(--border-strong);
    transform: translateY(-2px);
  }

  .card-item-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }

  .card-item-head .card-item-subject {
    margin: 0;
  }

  .card-item-head .card-meta {
    margin-left: auto;
  }

  .mono {
    font-family: var(--font-mono);
  }

  .card-status {
    font-size: var(--text-sm);
    font-weight: 600;
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .card-status.overdue {
    background: var(--color-danger-bg, var(--atlas-bad-bg));
    color: var(--color-danger);
  }

  .card-status.due-today {
    background: var(--color-success-bg, var(--atlas-ok-bg));
    color: var(--color-success);
  }

  .card-status.soon {
    background: var(--color-warning-bg, var(--atlas-warn-bg));
    color: var(--color-warning);
  }

  .card-status.later {
    background: var(--bg-main);
    color: var(--text-muted);
    border: 1px solid var(--border);
  }

  .card-difficulty {
    font-size: var(--text-xs);
    font-weight: 500;
    padding: 3px 8px;
    border-radius: var(--radius-sm);
  }

  .card-difficulty.easy {
    background: var(--color-success-bg, var(--atlas-ok-bg));
    color: var(--color-success);
  }

  .card-difficulty.normal {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .card-difficulty.hard {
    background: var(--color-warning-bg, var(--atlas-warn-bg));
    color: var(--color-warning);
  }

  .card-difficulty.very-hard {
    background: var(--color-danger-bg, var(--atlas-bad-bg));
    color: var(--color-danger);
  }

  .card-item-subject {
    font-size: var(--text-sm);
    color: var(--accent);
    margin-bottom: 0;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-item-front,
  .card-item-back {
    font-size: var(--text-lg);
    color: var(--text-main);
    margin-bottom: 8px;
    line-height: 1.5;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .card-item-front strong,
  .card-item-back strong {
    color: var(--text-muted);
    margin-right: 6px;
    font-weight: 600;
  }

  .card-item-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }

  .card-meta {
    font-size: var(--text-sm);
    color: var(--text-muted);
    font-family: ui-monospace, monospace;
  }

  .card-item-actions {
    display: flex;
    gap: 6px;
  }

  .mini-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: var(--surface);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all 0.15s;
  }

  .mini-btn:hover {
    background: var(--bg-main);
    color: var(--text-main);
    border-color: var(--border-strong);
  }

  .mini-btn.del:hover {
    color: var(--color-danger);
    border-color: var(--color-danger);
  }

  /* Modal */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: var(--atlas-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    backdrop-filter: blur(4px);
  }

  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    width: 90%;
    max-width: 520px;
    max-height: 90vh;
    overflow-y: auto;
  }

  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 24px;
    border-bottom: 1px solid var(--border);
  }

  .modal-head h3 {
    margin: 0;
    color: var(--text-main);
    font-size: var(--text-2xl);
    font-weight: 650;
  }

  .close-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: var(--text-2xl);
    cursor: pointer;
    padding: 0;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    transition: all 0.15s;
  }

  .close-btn:hover {
    background: var(--bg-main);
    color: var(--text-main);
  }

  .modal-body {
    padding: 24px;
  }

  .modal-body label {
    display: block;
    margin-bottom: 18px;
    color: var(--text-secondary);
    font-size: var(--text-lg);
  }

  .modal-body label span {
    display: block;
    margin-bottom: 8px;
    font-size: var(--text-md);
    color: var(--text-main);
    font-weight: 500;
  }

  .modal-body select,
  .modal-body textarea {
    width: 100%;
    padding: 12px 14px;
    background: var(--bg-main);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    color: var(--text-main);
    font-family: inherit;
    font-size: var(--text-xl);
    resize: vertical;
    transition: border-color 0.15s;
  }

  .modal-body select:focus,
  .modal-body textarea:focus {
    outline: none;
    border-color: var(--accent);
  }

  .modal-foot {
    display: flex;
    gap: 12px;
    padding: 20px 24px;
    border-top: 1px solid var(--border);
  }

  .cancel-btn {
    flex: 1;
    padding: 12px;
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    cursor: pointer;
    font-size: var(--text-lg);
    transition: all 0.15s;
  }

  .cancel-btn:hover {
    background: var(--bg-main);
    color: var(--text-main);
    border-color: var(--border-strong);
  }

  .save-btn {
    flex: 1;
    padding: 12px;
    background: var(--color-success);
    color: var(--atlas-on-fill);
    border: none;
    border-radius: var(--radius-lg);
    cursor: pointer;
    font-weight: 600;
    font-size: var(--text-lg);
    transition: all 0.15s;
  }

  .save-btn:hover {
    filter: brightness(1.1);
  }

  @media (max-width: 768px) {
    .deck-head {
      flex-direction: column;
      align-items: stretch;
    }

    .deck-actions {
      flex-direction: column;
    }

    .view-toggle {
      width: 100%;
    }

    .toggle-btn {
      flex: 1;
      justify-content: center;
    }

    .add-btn {
      width: 100%;
      justify-content: center;
    }

    .stats-bar {
      grid-template-columns: repeat(2, 1fr);
    }

    .rating-buttons {
      grid-template-columns: repeat(2, 1fr);
    }

    .cards-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
