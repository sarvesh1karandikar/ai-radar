import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { DailyEdition, RawItem, ScoredItem, SourceConfig } from "../../src/types";
import { fetchAllSources } from "./fetchers";
import { composeLocalEdition, dedupeItems, filterFreshItems, scoreItems, selectCandidates } from "./scoring";

const root = process.cwd();

function hasFlag(flag: string) {
  return process.argv.includes(flag);
}

function optionValue(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function fixtureNow(items: RawItem[]): Date {
  const latest = items
    .map((item) => Date.parse(item.publishedAt ?? item.fetchedAt))
    .filter((time) => !Number.isNaN(time))
    .sort((a, b) => b - a)[0];
  return latest ? new Date(latest) : new Date();
}

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), "utf8")) as T;
}

async function previousUrlSet(): Promise<Set<string>> {
  try {
    const previous = await readJson<DailyEdition>("content/latest.json");
    return new Set([
      ...previous.mustRead.map((item) => item.url),
      ...previous.watchlist.map((item) => item.url),
      previous.deepDive.url,
      previous.bookmark.url
    ]);
  } catch {
    return new Set();
  }
}

async function writeEdition(edition: DailyEdition) {
  const fileName = `${edition.date}.json`;
  const payload = `${JSON.stringify(edition, null, 2)}\n`;
  await fs.mkdir(path.join(root, "content/editions"), { recursive: true });
  await fs.mkdir(path.join(root, "public/content/editions"), { recursive: true });
  await fs.writeFile(path.join(root, "content/editions", fileName), payload);
  await fs.writeFile(path.join(root, "content/latest.json"), payload);
  await fs.writeFile(path.join(root, "public/content/editions", fileName), payload);
  await fs.writeFile(path.join(root, "public/content/latest.json"), payload);
}

function applySelectionCounts(edition: DailyEdition, selected: ScoredItem[]) {
  const selectedSources = new Map<string, number>();
  for (const item of selected) {
    selectedSources.set(item.raw.sourceId, (selectedSources.get(item.raw.sourceId) ?? 0) + 1);
  }
  edition.sourceHealth = edition.sourceHealth.map((source) => ({
    ...source,
    selected: selectedSources.get(source.id) ?? 0
  }));
}

function printReport(edition: DailyEdition) {
  const failures = edition.sourceHealth.filter((source) => source.status === "failed");
  console.log(`AI Systems Radar ${edition.date}`);
  console.log(`Mode: ${edition.mode}`);
  console.log(`Fetched: ${edition.stats.fetched}`);
  console.log(`After dedupe: ${edition.stats.afterDedupe}`);
  console.log(`After freshness: ${edition.stats.afterFreshness}`);
  console.log(`Dropped stale: ${edition.stats.droppedStale}`);
  console.log(`Selected: ${edition.stats.selected}`);
  console.log(`Pipeline: ${edition.stats.pipeline}`);
  console.log(`Clusters: ${edition.stats.clusters}`);
  console.log(`Failures: ${failures.length}`);
  for (const source of edition.sourceHealth) {
    const status = source.status === "ok" ? "ok" : source.status;
    const suffix = source.error ? ` - ${source.error}` : "";
    console.log(`- ${source.name}: ${status}, fetched ${source.fetched}, selected ${source.selected}${suffix}`);
  }
  console.log("");
  console.log("Must read:");
  for (const item of edition.mustRead) {
    console.log(`- [${item.signal}] ${item.title} (${item.source})`);
  }
}

async function run() {
  const mode = optionValue("--mode", "fixture") as "fixture" | "live";
  const shouldWrite = hasFlag("--write");
  const dryRun = hasFlag("--dry-run");
  const healthOnly = hasFlag("--health-only");
  const freshnessWindowHours = Number(optionValue("--freshness-hours", "48"));
  const sources = await readJson<SourceConfig[]>("config/sources.json");
  const sourceById = new Map(sources.map((source) => [source.id, source]));

  const fetched =
    mode === "fixture"
      ? {
          items: await readJson<RawItem[]>("fixtures/raw-items.json"),
          health: sources.map((source) => ({
            id: source.id,
            name: source.name,
            type: source.type,
            status: source.enabled ? ("ok" as const) : ("skipped" as const),
            fetched: source.enabled ? 0 : 0,
            selected: 0
          }))
        }
      : await fetchAllSources(sources);

  if (mode === "fixture") {
    const counts = new Map<string, number>();
    for (const item of fetched.items) {
      counts.set(item.sourceId, (counts.get(item.sourceId) ?? 0) + 1);
    }
    fetched.health = fetched.health.map((source) => ({ ...source, fetched: counts.get(source.id) ?? 0 }));
  }

  const previousUrls = await previousUrlSet();
  const now = mode === "fixture" ? fixtureNow(fetched.items) : new Date();
  const deduped = dedupeItems(fetched.items, sourceById);
  const fresh = filterFreshItems(deduped, freshnessWindowHours, now);
  const scored = scoreItems(fresh, sourceById, previousUrls, now);
  const selected = selectCandidates(scored);
  if (!selected.length) {
    throw new Error("No candidates selected; check source health, taxonomy filters, and freshness window");
  }

  const edition = composeLocalEdition(selected, sourceById, fetched.health, mode);

  edition.stats.fetched = fetched.items.length;
  edition.stats.afterDedupe = deduped.length;
  edition.stats.afterFreshness = fresh.length;
  edition.stats.droppedStale = deduped.length - fresh.length;
  edition.stats.selected = selected.length;
  edition.stats.clusters = new Set(selected.map((item) => item.clusterId ?? 0)).size;
  edition.stats.failures = fetched.health.filter((source) => source.status === "failed").length;
  applySelectionCounts(edition, selected);

  printReport(edition);

  if (healthOnly) {
    return;
  }

  if (shouldWrite && !dryRun) {
    await writeEdition(edition);
    console.log(`Wrote content/latest.json and public/content/latest.json`);
  } else {
    console.log(JSON.stringify(edition, null, 2));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
