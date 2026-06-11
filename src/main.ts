import "./styles.css";
import type { DailyEdition, EditionItem, SourceHealth } from "./types";

const app = document.querySelector<HTMLDivElement>("#app");

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

function renderItem(item: EditionItem, index: number) {
  return `
    <article class="radar-item">
      <div class="item-index">${String(index + 1).padStart(2, "0")}</div>
      <div class="item-body">
        <div class="item-meta">
          <span>${escapeHtml(item.source)}</span>
          <span>${escapeHtml(item.signal)}</span>
          <span>${escapeHtml(item.readTime)}</span>
        </div>
        <h3><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a></h3>
        <p>${escapeHtml(item.whyItMatters)}</p>
        <div class="tag">${escapeHtml(categoryLabel(item.category))}</div>
      </div>
    </article>
  `;
}

function renderSourceHealth(sources: SourceHealth[]) {
  const healthy = sources.filter((source) => source.status === "ok" && source.fetched > 0);
  return healthy
    .slice(0, 10)
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

function renderEdition(edition: DailyEdition) {
  const failureCount = edition.sourceHealth.filter((source) => source.status === "failed").length;
  return `
    <main>
      <section class="masthead">
        <div class="masthead-copy">
          <p class="eyebrow">${escapeHtml(formatDate(edition.date))}</p>
          <h1>${escapeHtml(edition.title)}</h1>
          <p class="summary">${escapeHtml(edition.summary)}</p>
        </div>
        <div class="signal-panel" aria-label="Source health summary">
          <div>
            <span class="metric">${edition.stats.fetched}</span>
            <span>candidates</span>
          </div>
          <div>
            <span class="metric">${edition.stats.selected}</span>
            <span>ranked</span>
          </div>
          <div>
            <span class="metric">${failureCount}</span>
            <span>failed</span>
          </div>
        </div>
      </section>

      <section class="source-band">
        <ul>${renderSourceHealth(edition.sourceHealth)}</ul>
      </section>

      <section class="section-grid">
        <div class="section-label">
          <span>01</span>
          <h2>Must Read</h2>
        </div>
        <div class="item-list">
          ${edition.mustRead.map(renderItem).join("")}
        </div>
      </section>

      <section class="deep-dive">
        <div class="section-label">
          <span>02</span>
          <h2>Deep Dive</h2>
        </div>
        <article class="deep-dive-body">
          <div class="tag">${escapeHtml(categoryLabel(edition.deepDive.category))}</div>
          <h3><a href="${escapeHtml(edition.deepDive.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(edition.deepDive.title)}</a></h3>
          <p>${escapeHtml(edition.deepDive.summary)}</p>
          <ul>
            ${edition.deepDive.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}
          </ul>
        </article>
      </section>

      <section class="section-grid">
        <div class="section-label">
          <span>03</span>
          <h2>Watchlist</h2>
        </div>
        <div class="item-list compact">
          ${edition.watchlist.map(renderItem).join("")}
        </div>
      </section>

      <section class="bookmark">
        <div>
          <p class="eyebrow">Bookmark</p>
          <h2><a href="${escapeHtml(edition.bookmark.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(edition.bookmark.title)}</a></h2>
          <p>${escapeHtml(edition.bookmark.whyItMatters)}</p>
        </div>
        <span>${escapeHtml(edition.bookmark.signal)}</span>
      </section>
    </main>
  `;
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

loadEdition()
  .then((edition) => {
    app.innerHTML = renderEdition(edition);
  })
  .catch((error) => {
    app.innerHTML = `
      <main class="error-state">
        <h1>AI Systems Radar</h1>
        <p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>
      </main>
    `;
  });
