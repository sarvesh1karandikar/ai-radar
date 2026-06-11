import "./styles.css";
import type { DailyEdition, EditionItem, SourceHealth } from "./types";

const app = document.querySelector<HTMLDivElement>("#app");

type BookPageKind = "cover" | "opening" | "brief" | "deep-dive" | "appendix";

interface BookPage {
  id: string;
  kind: BookPageKind;
  eyebrow: string;
  title: string;
  html: string;
  citation?: {
    label: string;
    url: string;
  };
}

interface BookState {
  edition: DailyEdition;
  pages: BookPage[];
  pageIndex: number;
  direction: "next" | "prev";
}

const appState: { book?: BookState } = {};

function categoryLabel(value: string) {
  return value.replace(/_/g, " ");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(`${value}T12:00:00`));
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sourceInitials(source: string) {
  return source
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function signalLabel(item: Pick<EditionItem, "signal" | "contextQuality">) {
  return `${item.signal} / ${item.contextQuality}`;
}

function pageFromUrl(total: number) {
  const params = new URLSearchParams(window.location.search);
  const rawPage = params.get("page") ?? window.location.hash.match(/page-(\d+)/)?.[1] ?? "1";
  const parsed = Number.parseInt(rawPage, 10);
  if (Number.isNaN(parsed)) return 0;
  return Math.min(total - 1, Math.max(0, parsed - 1));
}

function setPageInUrl(pageIndex: number) {
  const url = new URL(window.location.href);
  url.searchParams.set("page", String(pageIndex + 1));
  url.hash = `page-${pageIndex + 1}`;
  window.history.replaceState(null, "", url);
}

function renderFact(label: string, value: string) {
  return `
    <div class="fact-block">
      <span>${escapeHtml(label)}</span>
      <p>${escapeHtml(value)}</p>
    </div>
  `;
}

function renderCitation(citation?: BookPage["citation"]) {
  if (!citation) return "";
  return `
    <a class="citation-link" href="${escapeHtml(citation.url)}" target="_blank" rel="noopener noreferrer">
      <span>Citation</span>
      <strong>${escapeHtml(citation.label)}</strong>
    </a>
  `;
}

function openingSignals(edition: DailyEdition) {
  const lead = edition.mustRead[0];
  const signals = [
    lead ? `Lead item: ${lead.title}, from ${lead.source}.` : "Lead item still settling.",
    `Long read: ${edition.deepDive.title}, anchored by ${edition.deepDive.source}.`,
    `Builder bookmark: ${edition.bookmark.title}, labeled ${edition.bookmark.signal}.`
  ];
  return signals.map((signal) => `<li>${escapeHtml(signal)}</li>`).join("");
}

function sourceHealthList(sources: SourceHealth[]) {
  const healthy = sources.filter((source) => source.status === "ok" && source.fetched > 0);
  return healthy
    .slice(0, 12)
    .map(
      (source) => `
        <li class="source-chip" title="${escapeHtml(source.name)}">
          <span class="source-dot">${escapeHtml(sourceInitials(source.name))}</span>
          <span>${escapeHtml(source.name)}</span>
          <strong>${source.fetched}</strong>
        </li>
      `
    )
    .join("");
}

function buildBriefPage(item: EditionItem, chapter: string, index: number): BookPage {
  const itemNumber = String(index + 1).padStart(2, "0");
  return {
    id: `${chapter.toLowerCase()}-${itemNumber}`,
    kind: "brief",
    eyebrow: `${chapter} / ${itemNumber} / ${signalLabel(item)}`,
    title: item.title,
    citation: {
      label: item.source,
      url: item.citationUrl || item.url
    },
    html: `
      <div class="book-facts">
        ${renderFact("What happened", item.brief || item.whyItMatters)}
        ${renderFact("Why it matters for AI systems", item.technicalTakeaway || item.whyItMatters)}
        ${renderFact("Technical signal", `${categoryLabel(item.category)} / ${item.signal}`)}
        ${renderFact("Evidence", item.evidence)}
      </div>
      <blockquote>${escapeHtml(item.sourceExcerpt || item.whyItMatters)}</blockquote>
    `
  };
}

function buildBookPages(edition: DailyEdition): BookPage[] {
  const failureCount = edition.sourceHealth.filter((source) => source.status === "failed").length;
  const pages: BookPage[] = [
    {
      id: "cover",
      kind: "cover",
      eyebrow: `Issue / ${formatDate(edition.date)}`,
      title: edition.title,
      html: `
        <p class="cover-summary">${escapeHtml(edition.summary)}</p>
        <div class="cover-meter" aria-label="Issue summary">
          <span>10-15 min read</span>
          <span>${edition.stats.fetched} candidates</span>
          <span>${edition.stats.clusters} clusters</span>
          <span>${failureCount} failed</span>
        </div>
        <p class="content-policy">Self-contained summaries only. Source links are citations, not required reading.</p>
      `
    },
    {
      id: "opening",
      kind: "opening",
      eyebrow: "Today in 30 seconds",
      title: "The Shape of the Issue",
      html: `
        <p class="opening-prose">
          Primary-source items set the spine of the issue, while builder and community signals sit nearby as early indicators.
          The pacing is intentionally compact: a few anchors, one deeper note, and a short watchlist.
        </p>
        <ol class="opening-list">${openingSignals(edition)}</ol>
      `
    }
  ];

  edition.mustRead.forEach((item, index) => {
    pages.push(buildBriefPage(item, "Must Read", index));
  });

  pages.push({
    id: "deep-dive",
    kind: "deep-dive",
    eyebrow: `Deep Dive / ${categoryLabel(edition.deepDive.category)}`,
    title: edition.deepDive.title,
    citation: {
      label: edition.deepDive.source,
      url: edition.deepDive.url
    },
    html: `
      <p class="opening-prose">${escapeHtml(edition.deepDive.summary)}</p>
      <div class="book-facts">
        ${edition.deepDive.bullets.map((bullet) => renderFact(bullet.split(":")[0] || "Note", bullet)).join("")}
      </div>
    `
  });

  edition.watchlist.forEach((item, index) => {
    pages.push(buildBriefPage(item, "Watchlist", index));
  });

  pages.push(buildBriefPage(edition.bookmark, "Bookmark", 0));

  pages.push({
    id: "appendix",
    kind: "appendix",
    eyebrow: "Appendix",
    title: "Sources Checked",
    html: `
      <p class="opening-prose">
        ${edition.stats.afterFreshness} fresh items survived the window; ${edition.stats.selected} formed the ranked candidate pool.
        The public context policy favors summaries, short source excerpts, and citations over article mirroring.
      </p>
      <ul class="source-grid">${sourceHealthList(edition.sourceHealth)}</ul>
    `
  });

  return pages;
}

function renderBookPage(page: BookPage, state: BookState) {
  const animationClass = state.direction === "next" ? "turn-next" : "turn-prev";
  return `
    <article class="book-page ${animationClass}" data-page-kind="${page.kind}" aria-live="polite">
      <div class="page-inner">
        <p class="eyebrow">${escapeHtml(page.eyebrow)}</p>
        <h1>${escapeHtml(page.title)}</h1>
        <div class="page-copy">${page.html}</div>
        ${renderCitation(page.citation)}
      </div>
    </article>
  `;
}

function renderBook(state: BookState) {
  if (!app) return;
  const page = state.pages[state.pageIndex];
  const previousDisabled = state.pageIndex === 0 ? "disabled" : "";
  const nextDisabled = state.pageIndex === state.pages.length - 1 ? "disabled" : "";
  app.innerHTML = `
    <main class="book-reader">
      <section class="book-stage" aria-label="AI Radar book reader">
        ${renderBookPage(page, state)}
      </section>
      <nav class="book-controls" aria-label="Book navigation">
        <button type="button" data-book-action="prev" ${previousDisabled} aria-label="Previous page">Prev</button>
        <span>Page ${state.pageIndex + 1} of ${state.pages.length}</span>
        <button type="button" data-book-action="next" ${nextDisabled} aria-label="Next page">Next</button>
      </nav>
    </main>
  `;
  bindBookControls(state);
  setPageInUrl(state.pageIndex);
}

function goToPage(state: BookState, nextIndex: number) {
  const bounded = Math.min(state.pages.length - 1, Math.max(0, nextIndex));
  if (bounded === state.pageIndex) return;
  state.direction = bounded > state.pageIndex ? "next" : "prev";
  state.pageIndex = bounded;
  renderBook(state);
}

function bindBookControls(state: BookState) {
  app?.querySelector('[data-book-action="prev"]')?.addEventListener("click", () => {
    goToPage(state, state.pageIndex - 1);
  });
  app?.querySelector('[data-book-action="next"]')?.addEventListener("click", () => {
    goToPage(state, state.pageIndex + 1);
  });
}

function bindKeyboardNavigation() {
  window.addEventListener("keydown", (event) => {
    const state = appState.book;
    if (!state) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      goToPage(state, state.pageIndex - 1);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      goToPage(state, state.pageIndex + 1);
    }
    if (event.key === "Home") {
      event.preventDefault();
      goToPage(state, 0);
    }
    if (event.key === "End") {
      event.preventDefault();
      goToPage(state, state.pages.length - 1);
    }
  });
}

async function loadEdition() {
  const response = await fetch("/content/latest.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unable to load latest edition (${response.status})`);
  }
  return (await response.json()) as DailyEdition;
}

if (!app) {
  throw new Error("Missing #app root");
}

bindKeyboardNavigation();

loadEdition()
  .then((edition) => {
    const pages = buildBookPages(edition);
    appState.book = {
      edition,
      pages,
      pageIndex: pageFromUrl(pages.length),
      direction: "next"
    };
    renderBook(appState.book);
  })
  .catch((error) => {
    app.innerHTML = `
      <main class="error-state">
        <h1>AI Systems Radar</h1>
        <p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>
      </main>
    `;
  });
