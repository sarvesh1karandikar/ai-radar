import type { DailyEdition, EditionItem, RawItem, ScoredItem, SourceConfig, SourceHealth, Taxonomy } from "../../src/types";
import { TAXONOMY } from "../../src/types";
import { clamp, hoursSince, inferSignal, normalizeText, primaryCategory } from "./util";

const KEYWORDS: Record<Taxonomy, string[]> = {
  multi_agent_systems: [
    "multi-agent",
    "multi agent",
    "agentic",
    "agents",
    "tool use",
    "tool-calling",
    "orchestration",
    "long-running agent",
    "planner"
  ],
  inference_systems: [
    "inference",
    "serving",
    "latency",
    "throughput",
    "speculative decoding",
    "vllm",
    "quantization",
    "batching",
    "kv cache",
    "paged attention"
  ],
  training_infrastructure: [
    "training",
    "cluster",
    "distributed",
    "checkpoint",
    "gpu",
    "tpu",
    "cuda",
    "nvlink",
    "infiniband",
    "fabric"
  ],
  model_architecture_math: [
    "transformer",
    "attention",
    "moe",
    "mixture-of-experts",
    "architecture",
    "reasoning",
    "benchmark",
    "optimization",
    "gradient",
    "sparse"
  ],
  datacenter_power_compute: [
    "datacenter",
    "data center",
    "power",
    "energy",
    "grid",
    "cooling",
    "rack",
    "hyperscale",
    "silicon",
    "capacity"
  ],
  model_security: [
    "security",
    "jailbreak",
    "prompt injection",
    "guardrail",
    "safety",
    "alignment",
    "red team",
    "vulnerability",
    "malware",
    "sandbox"
  ],
  developer_tools: [
    "sdk",
    "api",
    "mcp",
    "github",
    "framework",
    "cli",
    "coding",
    "eval",
    "harness",
    "open source"
  ],
  business_signal: [
    "funding",
    "partnership",
    "launch",
    "revenue",
    "acquisition",
    "regulation",
    "policy",
    "market",
    "pricing",
    "customer"
  ]
};

const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "from",
  "has",
  "have",
  "into",
  "its",
  "new",
  "not",
  "our",
  "that",
  "the",
  "their",
  "this",
  "through",
  "using",
  "with",
  "your"
]);

type SparseVector = Map<string, number>;

function itemText(item: Pick<RawItem, "title" | "snippet" | "sourceName" | "tags">): string {
  return `${item.title} ${item.snippet ?? ""} ${item.sourceName} ${item.tags.join(" ")}`;
}

function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function buildTfIdfVectors(items: ScoredItem[]): Map<string, SparseVector> {
  const docs = items.map((item) => ({
    id: item.raw.id,
    tokens: tokenize(itemText(item.raw))
  }));
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const token of new Set(doc.tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const vectors = new Map<string, SparseVector>();
  for (const doc of docs) {
    const counts = new Map<string, number>();
    for (const token of doc.tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    const vector: SparseVector = new Map();
    for (const [token, count] of counts) {
      const tf = count / Math.max(1, doc.tokens.length);
      const idf = Math.log((docs.length + 1) / ((documentFrequency.get(token) ?? 0) + 1)) + 1;
      vector.set(token, tf * idf);
    }
    const norm = Math.sqrt(Array.from(vector.values()).reduce((sum, weight) => sum + weight * weight, 0)) || 1;
    for (const [token, weight] of vector) {
      vector.set(token, weight / norm);
    }
    vectors.set(doc.id, vector);
  }
  return vectors;
}

function cosine(left?: SparseVector, right?: SparseVector): number {
  if (!left || !right) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let dot = 0;
  for (const [token, weight] of small) {
    dot += weight * (large.get(token) ?? 0);
  }
  return dot;
}

export function clusterItems(items: ScoredItem[], similarityThreshold = 0.32): ScoredItem[] {
  const vectors = buildTfIdfVectors(items);
  const clusters: Array<{ id: number; items: ScoredItem[] }> = [];
  for (const item of items) {
    let bestCluster: { id: number; items: ScoredItem[] } | undefined;
    let bestSimilarity = 0;
    for (const cluster of clusters) {
      const maxSimilarity = Math.max(
        ...cluster.items.map((candidate) => cosine(vectors.get(item.raw.id), vectors.get(candidate.raw.id)))
      );
      if (maxSimilarity > bestSimilarity) {
        bestSimilarity = maxSimilarity;
        bestCluster = cluster;
      }
    }
    if (bestCluster && bestSimilarity >= similarityThreshold) {
      bestCluster.items.push(item);
      item.clusterId = bestCluster.id;
    } else {
      const cluster = { id: clusters.length + 1, items: [item] };
      clusters.push(cluster);
      item.clusterId = cluster.id;
    }
  }
  return items;
}

export function classifyItem(item: Pick<RawItem, "title" | "snippet" | "tags">): Taxonomy[] {
  const text = normalizeText(`${item.title} ${item.snippet ?? ""}`);
  const found = TAXONOMY.filter((category) => KEYWORDS[category].some((keyword) => text.includes(normalizeText(keyword))));
  return Array.from(new Set([...item.tags, ...found]));
}

function titleTokens(title: string): Set<string> {
  const ignored = new Set(["the", "and", "for", "with", "from", "into", "about", "using"]);
  return new Set(
    normalizeText(title)
      .split(" ")
      .filter((token) => token.length > 2 && !ignored.has(token))
  );
}

function titleSimilarity(left: string, right: string): number {
  const leftTokens = titleTokens(left);
  const rightTokens = titleTokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

function isLowQualitySignal(item: RawItem): boolean {
  const text = normalizeText(`${item.title} ${item.snippet ?? ""}`);
  return [
    "free llm api keys",
    "free api keys",
    "api keys for gpt",
    "leaked api key",
    "leaked api keys",
    "cracked api",
    "bypass api key"
  ].some((phrase) => text.includes(phrase));
}

function preferredItem(left: RawItem, right: RawItem, sourceById: Map<string, SourceConfig>): RawItem {
  const leftTrust = sourceById.get(left.sourceId)?.trustWeight ?? 0;
  const rightTrust = sourceById.get(right.sourceId)?.trustWeight ?? 0;
  if (leftTrust !== rightTrust) return leftTrust > rightTrust ? left : right;
  const leftDate = Date.parse(left.publishedAt ?? left.fetchedAt);
  const rightDate = Date.parse(right.publishedAt ?? right.fetchedAt);
  if (!Number.isNaN(leftDate) && !Number.isNaN(rightDate) && leftDate !== rightDate) {
    return leftDate > rightDate ? left : right;
  }
  return (left.snippet?.length ?? 0) >= (right.snippet?.length ?? 0) ? left : right;
}

export function dedupeItems(items: RawItem[], sourceById: Map<string, SourceConfig>): RawItem[] {
  const byCanonical = new Map<string, RawItem>();
  const kept: RawItem[] = [];

  for (const item of items) {
    const key = item.canonicalUrl || normalizeText(item.title).slice(0, 96);
    const existing = byCanonical.get(key);
    if (existing) {
      const preferred = preferredItem(existing, item, sourceById);
      byCanonical.set(key, preferred);
      const index = kept.indexOf(existing);
      if (index >= 0) kept[index] = preferred;
      continue;
    }

    const similar = kept.find((candidate) => titleSimilarity(candidate.title, item.title) >= 0.86);
    if (similar) {
      const preferred = preferredItem(similar, item, sourceById);
      const similarKey = similar.canonicalUrl || normalizeText(similar.title).slice(0, 96);
      byCanonical.delete(similarKey);
      byCanonical.set(preferred.canonicalUrl || normalizeText(preferred.title).slice(0, 96), preferred);
      kept[kept.indexOf(similar)] = preferred;
      continue;
    }

    byCanonical.set(key, item);
    kept.push(item);
  }
  return kept;
}

export function filterFreshItems(items: RawItem[], windowHours = 48, now = new Date()): RawItem[] {
  return items.filter((item) => hoursSince(item.publishedAt ?? item.fetchedAt, now) <= windowHours);
}

export function scoreItems(
  items: RawItem[],
  sourceById: Map<string, SourceConfig>,
  previousUrls = new Set<string>(),
  now = new Date()
): ScoredItem[] {
  return items
    .map((item) => {
      const source = sourceById.get(item.sourceId);
      const tags = classifyItem(item);
      const sourceWeights = source?.categoryWeights ?? {};
      const topicalScore = clamp(
        tags.reduce((total, tag) => total + (sourceWeights[tag] ?? 0.45), 0) / Math.max(1, Math.min(3, tags.length))
      );
      const recencyScore = clamp(1 - hoursSince(item.publishedAt ?? item.fetchedAt, now) / 96, 0.05, 1);
      const trustScore = clamp(source?.trustWeight ?? 0.4);
      const stars = item.metrics?.stars ?? 0;
      const hnScore = item.metrics?.hnScore ?? 0;
      const comments = item.metrics?.hnComments ?? 0;
      const momentumScore = clamp(Math.log10(stars + hnScore + comments * 0.5 + 1) / 3);
      const noveltyScore = previousUrls.has(item.canonicalUrl) ? 0.2 : 1;
      const depthScore = clamp(((item.snippet?.length ?? 0) + item.title.length) / 360);
      const score =
        trustScore * 0.28 +
        topicalScore * 0.28 +
        recencyScore * 0.18 +
        momentumScore * 0.15 +
        depthScore * 0.07 +
        noveltyScore * 0.04;
      const reasons = [
        `${Math.round(trustScore * 100)} trust`,
        `${Math.round(topicalScore * 100)} topical match`,
        `${Math.round(recencyScore * 100)} recency`
      ];
      return {
        raw: { ...item, tags },
        score,
        recencyScore,
        trustScore,
        topicalScore,
        momentumScore,
        noveltyScore,
        depthScore,
        reasons
      };
    })
    .filter((item) => item.topicalScore >= 0.18 && !isLowQualitySignal(item.raw))
    .sort((a, b) => b.score - a.score);
}

export function selectCandidates(items: ScoredItem[], limit = 28): ScoredItem[] {
  const clustered = clusterItems(items);
  const vectors = buildTfIdfVectors(clustered);
  const counts = new Map<string, number>();
  const clusterCounts = new Map<number, number>();
  const selected: ScoredItem[] = [];

  while (selected.length < limit) {
    let best: ScoredItem | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const item of clustered) {
      if (selected.includes(item)) continue;
      if ((counts.get(item.raw.sourceId) ?? 0) >= 4) continue;
      if ((clusterCounts.get(item.clusterId ?? 0) ?? 0) >= 2) continue;
      const maxSimilarity = selected.length
        ? Math.max(...selected.map((candidate) => cosine(vectors.get(item.raw.id), vectors.get(candidate.raw.id))))
        : 0;
      const diversityPenalty = maxSimilarity * 0.18;
      const clusterPenalty = ((clusterCounts.get(item.clusterId ?? 0) ?? 0) * 0.08);
      const mmrScore = item.score * 0.82 - diversityPenalty - clusterPenalty;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        best = item;
      }
    }
    if (!best) break;
    selected.push(best);
    counts.set(best.raw.sourceId, (counts.get(best.raw.sourceId) ?? 0) + 1);
    clusterCounts.set(best.clusterId ?? 0, (clusterCounts.get(best.clusterId ?? 0) ?? 0) + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

function extractivePhrase(item: RawItem): string {
  const text = (item.snippet || item.title).replace(/\s+/g, " ").trim();
  if (!text) return item.title;
  const sentence = text
    .split(/(?<=[.!?])\s+/)
    .find((part) => part.length >= 36) ?? text;
  const words = sentence.split(/\s+/).slice(0, 18).join(" ");
  return words.endsWith(".") ? words : `${words}...`;
}

function sentencesFromItem(item: RawItem): string[] {
  const text = (item.snippet || item.title)
    .replace(/\s+/g, " ")
    .replace(/\[[^\]]+\]/g, "")
    .trim();
  if (!text) return [item.title];
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 24);
  return sentences.length ? sentences : [text];
}

function shortenText(text: string, maxWords: number): string {
  const words = text.replace(/\s+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}...`;
}

function sourceExcerpt(item: RawItem): string {
  return shortenText(sentencesFromItem(item)[0] ?? item.title, 36);
}

export function publicContextQuality(item: RawItem): EditionItem["contextQuality"] {
  const snippet = item.snippet?.replace(/\s+/g, " ").trim() ?? "";
  if (item.sourceType === "sitemap") return "thin public context";
  if (snippet.length < 80) return "thin public context";
  if (/paywall|subscribe to read|sign in to read/i.test(snippet)) return "thin public context";
  return "source-grounded";
}

function hasDeepDiveContext(item: RawItem): boolean {
  return publicContextQuality(item) === "source-grounded" && item.snippet !== undefined && item.snippet.length >= 120;
}

function readerAngle(signal: EditionItem["signal"], categoryLabel: string): string {
  if (signal === "primary") {
    return `For systems readers, the useful lens is ${categoryLabel}: what changes about building, serving, securing, or operating AI systems.`;
  }
  if (signal === "research") {
    return `Read it as a research lead for ${categoryLabel}, with the paper as the ground truth before any downstream commentary.`;
  }
  if (signal === "builder-signal") {
    return `Treat it as builder momentum in ${categoryLabel}; the repository is a signal to inspect, not a primary claim by itself.`;
  }
  if (signal === "community-signal") {
    return `Treat it as an attention signal around ${categoryLabel}; follow the original linked source before drawing conclusions.`;
  }
  return `Use it as discovery context for ${categoryLabel} until a stronger public source confirms the details.`;
}

function evidenceLine(item: ScoredItem, metric: string): string {
  const cluster = item.clusterId ? `, cluster ${item.clusterId}` : "";
  return `${item.raw.sourceName}; ${metric}; local score ${item.score.toFixed(2)}${cluster}.`;
}

function sourceTypeLabel(signal: EditionItem["signal"]): string {
  if (signal === "primary") return "primary-source item";
  if (signal === "research") return "research paper";
  if (signal === "builder-signal") return "builder signal";
  if (signal === "community-signal") return "community signal";
  return "discovery signal";
}

function briefForItem(item: ScoredItem, signal: EditionItem["signal"], categoryLabel: string): string {
  const excerpt = sourceExcerpt(item.raw);
  if (signal === "primary") {
    return `${item.raw.sourceName} surfaced this as a ${categoryLabel} update. ${excerpt}`;
  }
  if (signal === "research") {
    return `This paper is a ${categoryLabel} lead from the research stream. ${excerpt}`;
  }
  if (signal === "builder-signal") {
    return `${item.raw.title} is appearing as builder momentum, not as a verified product claim. ${excerpt}`;
  }
  if (signal === "community-signal") {
    return `This is an attention signal from a public discussion thread. ${excerpt}`;
  }
  return `This is a fallback discovery item for ${categoryLabel}. ${excerpt}`;
}

function technicalTakeawayForItem(item: ScoredItem, signal: EditionItem["signal"], categoryLabel: string): string {
  const quality = publicContextQuality(item.raw);
  const contextPhrase =
    quality === "source-grounded"
      ? "The public metadata is strong enough for a compact self-contained read."
      : "Only thin public context was available, so this stays as a lighter note.";
  if (signal === "builder-signal") {
    return `Track the repository as a ${categoryLabel} signal: stars, description, and recent activity suggest builder interest, while the source itself remains the citation. ${contextPhrase}`;
  }
  if (signal === "community-signal") {
    return `Treat the discussion as a demand or attention marker around ${categoryLabel}, not as independent confirmation. ${contextPhrase}`;
  }
  if (signal === "research") {
    return `The systems angle is ${categoryLabel}; the useful question is whether the method changes reliability, runtime behavior, governance, or infrastructure constraints. ${contextPhrase}`;
  }
  return `The systems angle is ${categoryLabel}; read it for operational impact on building, serving, securing, or scaling AI systems. ${contextPhrase}`;
}

function itemToEditionItem(item: ScoredItem, sourceById: Map<string, SourceConfig>): EditionItem {
  const category = primaryCategory(item.raw, sourceById.get(item.raw.sourceId));
  const signal = inferSignal(item.raw.sourceType);
  const metric = item.raw.metrics?.stars
    ? `${item.raw.metrics.stars.toLocaleString()} GitHub stars`
    : item.raw.metrics?.hnScore
      ? `${item.raw.metrics.hnScore} HN points`
      : item.reasons.join(", ");
  const categoryLabel = category.replace(/_/g, " ");
  return {
    title: item.raw.title,
    url: item.raw.url,
    source: item.raw.sourceName,
    category,
    signal,
    whyItMatters: `${extractivePhrase(item.raw)} ${readerAngle(signal, categoryLabel)}`,
    brief: briefForItem(item, signal, categoryLabel),
    technicalTakeaway: technicalTakeawayForItem(item, signal, categoryLabel),
    evidence: evidenceLine(item, metric),
    sourceExcerpt: sourceExcerpt(item.raw),
    citationUrl: item.raw.url,
    contextQuality: publicContextQuality(item.raw),
    readTime: item.raw.sourceType === "arxiv" ? "paper skim" : "3 min"
  };
}

function pickMustRead(items: ScoredItem[], sourceById: Map<string, SourceConfig>): EditionItem[] {
  const picked: ScoredItem[] = [];
  const addFrom = (predicate: (item: ScoredItem) => boolean, max: number) => {
    for (const item of items) {
      if (picked.length >= 5) break;
      if (picked.filter(predicate).length >= max) break;
      if (picked.includes(item) || !predicate(item)) continue;
      picked.push(item);
    }
  };

  addFrom((item) => inferSignal(item.raw.sourceType) === "primary", 2);
  addFrom((item) => inferSignal(item.raw.sourceType) === "research", 2);
  addFrom((item) => ["builder-signal", "community-signal"].includes(inferSignal(item.raw.sourceType)), 1);

  for (const item of items) {
    if (picked.length >= 5) break;
    if (picked.includes(item)) continue;
    const signal = inferSignal(item.raw.sourceType);
    const signalCount = picked.filter((candidate) =>
      ["builder-signal", "community-signal", "discovery"].includes(inferSignal(candidate.raw.sourceType))
    ).length;
    if (signal === "discovery") {
      continue;
    }
    if (["builder-signal", "community-signal"].includes(signal) && signalCount >= 2) {
      continue;
    }
    picked.push(item);
    if (picked.length === 5) break;
  }
  for (const item of items) {
    if (picked.length === 5) break;
    if (!picked.includes(item)) picked.push(item);
  }
  return picked.map((item) => itemToEditionItem(item, sourceById));
}

export function composeLocalEdition(
  items: ScoredItem[],
  sourceById: Map<string, SourceConfig>,
  health: SourceHealth[],
  mode: DailyEdition["mode"]
): DailyEdition {
  if (!items.length) {
    throw new Error("No candidates available after freshness and scoring filters");
  }
  const mustRead = pickMustRead(items, sourceById);
  const mustReadUrls = new Set(mustRead.map((item) => item.url));
  const watchlist = items
    .filter((item) => !mustReadUrls.has(item.raw.url))
    .slice(0, 3)
    .map((item) => itemToEditionItem(item, sourceById));
  const deepDiveCandidate =
    items.find(
      (item) =>
        !["github_search", "hn", "google_news"].includes(item.raw.sourceType) &&
        hasDeepDiveContext(item.raw) &&
        item.raw.tags.some((tag) =>
          ["training_infrastructure", "inference_systems", "model_architecture_math", "model_security"].includes(tag)
        )
    ) ??
    items.find((item) => !["github_search", "hn", "google_news"].includes(item.raw.sourceType) && hasDeepDiveContext(item.raw)) ??
    items[0];
  const deepDiveSignal = inferSignal(deepDiveCandidate.raw.sourceType);
  const deepDiveCategory = primaryCategory(deepDiveCandidate.raw, sourceById.get(deepDiveCandidate.raw.sourceId));
  const deepDiveCategoryLabel = deepDiveCategory.replace(/_/g, " ");
  const deepDiveNote = itemToEditionItem(deepDiveCandidate, sourceById);
  const bookmarkCandidate = items.find((item) => ["github_search", "arxiv"].includes(item.raw.sourceType)) ?? items[0];
  const today = new Date().toISOString().slice(0, 10);
  const clusterCount = new Set(items.map((item) => item.clusterId ?? 0)).size;

  return {
    date: today,
    generatedAt: new Date().toISOString(),
    mode,
    title: "AI Systems Radar",
    summary:
      "A daily systems-first reading issue for AI infrastructure, agents, inference, research, security, and builder momentum. The ranking is local and statistical; the claims stay tied to public sources.",
    mustRead,
    watchlist,
    deepDive: {
      title: deepDiveCandidate.raw.title,
      url: deepDiveCandidate.raw.url,
      source: deepDiveCandidate.raw.sourceName,
      category: deepDiveCategory,
      summary: `${deepDiveNote.brief} It gets the longer read because the public context is ${deepDiveNote.contextQuality} and the item is close to the systems layer.`,
      bullets: [
        `What happened: ${deepDiveNote.brief}`,
        `Why it matters: ${deepDiveNote.technicalTakeaway}`,
        `Technical signal: ${sourceTypeLabel(deepDiveSignal)} for ${deepDiveCategoryLabel}.`,
        `Evidence: ${deepDiveNote.evidence}`
      ]
    },
    bookmark: itemToEditionItem(bookmarkCandidate, sourceById),
    sourceHealth: health,
    stats: {
      fetched: health.reduce((sum, source) => sum + source.fetched, 0),
      afterDedupe: items.length,
      afterFreshness: items.length,
      droppedStale: 0,
      selected: mustRead.length + watchlist.length,
      clusters: clusterCount,
      failures: health.filter((source) => source.status === "failed").length,
      pipeline: "statistical_ml"
    }
  };
}
