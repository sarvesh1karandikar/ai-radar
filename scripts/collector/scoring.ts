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
    .filter((item) => item.topicalScore >= 0.18)
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
    whyItMatters: `${signal === "primary" || signal === "research" ? "Grounded source" : "Attention signal"} for ${categoryLabel}; ranked by ${metric}. ${extractivePhrase(item.raw)}`,
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
        item.raw.tags.some((tag) =>
          ["training_infrastructure", "inference_systems", "model_architecture_math", "model_security"].includes(tag)
        )
    ) ?? items[0];
  const bookmarkCandidate = items.find((item) => ["github_search", "arxiv"].includes(item.raw.sourceType)) ?? items[0];
  const today = new Date().toISOString().slice(0, 10);
  const clusterCount = new Set(items.map((item) => item.clusterId ?? 0)).size;

  return {
    date: today,
    generatedAt: new Date().toISOString(),
    mode,
    title: "AI Systems Radar",
    summary:
      "Today's radar is ranked locally with TF-IDF clustering, source trust, freshness, momentum, and diversity scoring. Primary sources lead; GitHub and Hacker News remain labeled attention signals.",
    mustRead,
    watchlist,
    deepDive: {
      title: deepDiveCandidate.raw.title,
      url: deepDiveCandidate.raw.url,
      source: deepDiveCandidate.raw.sourceName,
      category: primaryCategory(deepDiveCandidate.raw, sourceById.get(deepDiveCandidate.raw.sourceId)),
      summary: `${deepDiveCandidate.raw.sourceName} is the strongest non-signal item in today's clustered candidate set for ${primaryCategory(deepDiveCandidate.raw, sourceById.get(deepDiveCandidate.raw.sourceId)).replace(/_/g, " ")}.`,
      bullets: [
        `Extract: ${extractivePhrase(deepDiveCandidate.raw)}`,
        `Local score: ${deepDiveCandidate.score.toFixed(2)} across trust, topical fit, recency, momentum, novelty, and depth.`,
        "Open the source before treating any vendor or community signal as a final claim."
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
