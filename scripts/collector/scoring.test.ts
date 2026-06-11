import assert from "node:assert/strict";
import test from "node:test";
import type { RawItem, SourceConfig } from "../../src/types";
import { classifyItem, clusterItems, dedupeItems, filterFreshItems, scoreItems, selectCandidates } from "./scoring";

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
  snippet: "Serving systems, batching, security, and model safety.",
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
