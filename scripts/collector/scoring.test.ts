import assert from "node:assert/strict";
import test from "node:test";
import type { RawItem, SourceConfig } from "../../src/types";
import {
  classifyItem,
  clusterItems,
  composeLocalEdition,
  dedupeItems,
  filterFreshItems,
  publicContextQuality,
  scoreItems,
  selectCandidates
} from "./scoring";

const source: SourceConfig = {
  id: "test",
  name: "Test",
  type: "rss",
  enabled: true,
  trustWeight: 0.9,
  categoryWeights: {
    inference_systems: 0.9,
    model_security: 0.7
  }
};

const item: RawItem = {
  id: "1",
  title: "Low-latency inference with prompt injection guardrails",
  url: "https://example.com/a?utm_source=test",
  canonicalUrl: "https://example.com/a",
  sourceId: "test",
  sourceName: "Test",
  sourceType: "rss",
  publishedAt: new Date().toISOString(),
  fetchedAt: new Date().toISOString(),
  snippet:
    "Serving systems, batching, security, and model safety. The update describes production inference behavior, guardrail design, and operational tradeoffs for teams running model APIs.",
  tags: []
};

test("classifyItem maps text into the project taxonomy", () => {
  const tags = classifyItem(item);
  assert.ok(tags.includes("inference_systems"));
  assert.ok(tags.includes("model_security"));
});

test("dedupeItems keeps one canonical URL", () => {
  const deduped = dedupeItems([item, { ...item, id: "2", title: "Duplicate" }], new Map([["test", source]]));
  assert.equal(deduped.length, 1);
});

test("dedupeItems collapses highly similar syndicated titles", () => {
  const duplicate: RawItem = {
    ...item,
    id: "2",
    url: "https://example.org/syndicated",
    canonicalUrl: "https://example.org/syndicated",
    title: "Low latency inference with prompt injection guardrails"
  };
  const deduped = dedupeItems([item, duplicate], new Map([["test", source]]));
  assert.equal(deduped.length, 1);
});

test("filterFreshItems applies the daily freshness window", () => {
  const now = new Date("2026-06-11T12:00:00Z");
  const freshItem = {
    ...item,
    publishedAt: "2026-06-11T11:00:00Z"
  };
  const oldItem = {
    ...item,
    id: "old",
    publishedAt: "2026-06-08T11:59:00Z"
  };
  const fresh = filterFreshItems([freshItem, oldItem], 48, now);
  assert.deepEqual(fresh.map((candidate) => candidate.id), [freshItem.id]);
});

test("scoreItems and selectCandidates produce ranked items", () => {
  const scored = scoreItems([item], new Map([["test", source]]));
  assert.equal(scored.length, 1);
  assert.ok(scored[0].score > 0.5);
  assert.equal(selectCandidates(scored, 1).length, 1);
});

test("scoreItems filters credential-bait builder signals", () => {
  const bait: RawItem = {
    ...item,
    id: "bait",
    title: "Free LLM API keys for every model",
    url: "https://example.com/bait",
    canonicalUrl: "https://example.com/bait",
    sourceType: "github_search",
    snippet: "Free API keys for GPT, Claude, DeepSeek, and other models."
  };
  const scored = scoreItems([bait], new Map([["test", source]]));
  assert.equal(scored.length, 0);
});

test("composeLocalEdition emits self-contained reader notes", () => {
  const sourceById = new Map([["test", source]]);
  const selected = selectCandidates(scoreItems([item], sourceById), 1);
  const edition = composeLocalEdition(selected, sourceById, [], "fixture");
  const note = edition.mustRead[0];
  assert.ok(note.brief.length > 20);
  assert.ok(note.technicalTakeaway.length > 20);
  assert.ok(note.evidence.length > 20);
  assert.ok(note.sourceExcerpt.length > 20);
  assert.equal(note.citationUrl, item.url);
  assert.equal(note.contextQuality, "source-grounded");
});

test("composeLocalEdition avoids thin public context for deep dive when richer context exists", () => {
  const thin: RawItem = {
    ...item,
    id: "thin",
    title: "Fast inference launch",
    url: "https://example.com/thin",
    canonicalUrl: "https://example.com/thin",
    snippet: "Short update.",
    tags: ["inference_systems"]
  };
  const rich: RawItem = {
    ...item,
    id: "rich",
    title: "Runtime governance for production AI agents",
    url: "https://example.com/rich",
    canonicalUrl: "https://example.com/rich",
    sourceType: "arxiv",
    snippet:
      "Production AI agents increasingly require runtime governance across policy, identity, tool use, memory, and observability planes. This paper proposes an architecture for controlling agent behavior in deployed systems.",
    tags: ["multi_agent_systems", "model_security"]
  };
  const sourceById = new Map([["test", source]]);
  const selected = selectCandidates(scoreItems([thin, rich], sourceById), 2);
  const edition = composeLocalEdition(selected, sourceById, [], "fixture");
  assert.equal(publicContextQuality(thin), "thin public context");
  assert.equal(edition.deepDive.url, rich.url);
});

test("composeLocalEdition preserves builder and community signal labels", () => {
  const githubItem: RawItem = {
    ...item,
    id: "repo",
    title: "example/agent-runtime",
    url: "https://github.com/example/agent-runtime",
    canonicalUrl: "https://github.com/example/agent-runtime",
    sourceType: "github_search",
    snippet: "Open source runtime for agent orchestration, tool use, evals, and secure deployment.",
    metrics: { stars: 1200 }
  };
  const hnItem: RawItem = {
    ...item,
    id: "hn",
    title: "Show HN: Agent runtime traces",
    url: "https://news.ycombinator.com/item?id=1",
    canonicalUrl: "https://news.ycombinator.com/item?id=1",
    sourceType: "hn",
    snippet: "Hacker News discussion signal with 220 points and 80 comments about agents, tool use, and runtime traces.",
    tags: ["multi_agent_systems"],
    metrics: { hnScore: 220, hnComments: 80 }
  };
  const sourceById = new Map([["test", source]]);
  const selected = selectCandidates(scoreItems([githubItem, hnItem], sourceById), 2);
  const edition = composeLocalEdition(selected, sourceById, [], "fixture");
  const allItems = [...edition.mustRead, ...edition.watchlist, edition.bookmark];
  assert.ok(allItems.some((candidate) => candidate.url === githubItem.url && candidate.signal === "builder-signal"));
  assert.ok(allItems.some((candidate) => candidate.url === hnItem.url && candidate.signal === "community-signal"));
});

test("clusterItems groups statistically similar candidates", () => {
  const sourceById = new Map([["test", source]]);
  const sibling: RawItem = {
    ...item,
    id: "sibling",
    title: "Low latency model serving with injection guardrails",
    url: "https://example.com/b",
    canonicalUrl: "https://example.com/b",
    snippet: "Inference serving, batching, security, and guardrails for production systems."
  };
  const unrelated: RawItem = {
    ...item,
    id: "unrelated",
    title: "Datacenter power planning for AI training clusters",
    url: "https://example.com/c",
    canonicalUrl: "https://example.com/c",
    snippet: "Power, cooling, racks, and grid capacity for GPU clusters.",
    tags: ["datacenter_power_compute"]
  };
  const clustered = clusterItems(scoreItems([item, sibling, unrelated], sourceById), 0.25);
  const byId = new Map(clustered.map((candidate) => [candidate.raw.id, candidate]));
  assert.equal(byId.get("1")?.clusterId, byId.get("sibling")?.clusterId);
  assert.notEqual(byId.get("1")?.clusterId, byId.get("unrelated")?.clusterId);
});
