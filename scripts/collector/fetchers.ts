import { XMLParser } from "fast-xml-parser";
import type { RawItem, SourceConfig, SourceHealth, Taxonomy } from "../../src/types";
import { asArray, DEFAULT_TIMEOUT_MS, keywordIncludes, makeRawItem, stripHtml, titleFromUrl } from "./util";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text"
});

const TOPIC_KEYWORDS = [
  "ai",
  "agent",
  "llm",
  "model",
  "inference",
  "training",
  "gpu",
  "datacenter",
  "data center",
  "security",
  "prompt injection",
  "transformer",
  "deep learning",
  "machine learning",
  "mcp",
  "eval"
];

const DEFAULT_RETRIES = 2;

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function retryableStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

async function fetchWithRetry(url: string, init: RequestInit, retries = DEFAULT_RETRIES): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok || !retryableStatus(response.status) || attempt === retries) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status} for ${url}`);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
    }
    await sleep(350 * 2 ** attempt);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchText(url: string, timeoutMs?: number, retries?: number): Promise<string> {
  const response = await fetchWithRetry(url, {
    headers: {
      "User-Agent": "AI Systems Radar/0.1 (+https://ai-radar.sarveshk.dev)",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/html;q=0.8"
    },
    signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }, retries ?? DEFAULT_RETRIES);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

function tagsFromText(text: string, source: SourceConfig): Taxonomy[] {
  const lowered = text.toLowerCase();
  const inferred: Taxonomy[] = [];
  if (lowered.includes("agent")) inferred.push("multi_agent_systems");
  if (lowered.includes("inference") || lowered.includes("serving")) inferred.push("inference_systems");
  if (lowered.includes("gpu") || lowered.includes("training") || lowered.includes("cluster")) inferred.push("training_infrastructure");
  if (lowered.includes("architecture") || lowered.includes("attention") || lowered.includes("moe")) inferred.push("model_architecture_math");
  if (lowered.includes("power") || lowered.includes("datacenter") || lowered.includes("data center")) inferred.push("datacenter_power_compute");
  if (lowered.includes("security") || lowered.includes("jailbreak") || lowered.includes("safety")) inferred.push("model_security");
  if (lowered.includes("github") || lowered.includes("sdk") || lowered.includes("api") || lowered.includes("framework")) inferred.push("developer_tools");
  if (lowered.includes("funding") || lowered.includes("launch") || lowered.includes("partnership")) inferred.push("business_signal");
  return Array.from(new Set(inferred)).slice(0, 4);
}

async function fetchRss(source: SourceConfig): Promise<RawItem[]> {
  if (!source.url) throw new Error("RSS source missing url");
  const xml = parser.parse(await fetchText(source.url, source.timeoutMs, source.retries));
  const rssItems = asArray(xml.rss?.channel?.item);
  const atomItems = asArray(xml.feed?.entry);
  const items = rssItems.length ? rssItems : atomItems;

  return items.slice(0, source.limit ?? 20).map((entry: Record<string, unknown>) => {
    const titleNode = entry.title;
    const title =
      typeof titleNode === "object" && titleNode
        ? stripHtml(String((titleNode as Record<string, unknown>)["#text"] ?? (titleNode as Record<string, unknown>).text ?? "Untitled"))
        : stripHtml(String(titleNode ?? "Untitled"));
    const rawLink = Array.isArray(entry.link) ? entry.link[0] : entry.link;
    const href =
      typeof rawLink === "object" && rawLink && "href" in rawLink
        ? String((rawLink as { href: string }).href)
        : String(rawLink ?? entry.guid ?? "");
    const url = href || String(entry.id ?? source.url);
    const snippet = stripHtml(String(entry.description ?? entry.summary ?? entry["content:encoded"] ?? ""));
    const publishedAt = String(entry.pubDate ?? entry.published ?? entry.updated ?? "");
    return makeRawItem({
      title,
      url,
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      publishedAt: publishedAt || undefined,
      snippet,
      author: typeof entry.author === "object" ? String((entry.author as { name?: string }).name ?? "") : undefined,
      tags: tagsFromText(`${title} ${snippet}`, source)
    });
  });
}

async function fetchSitemap(source: SourceConfig): Promise<RawItem[]> {
  if (!source.url) throw new Error("Sitemap source missing url");
  const xml = parser.parse(await fetchText(source.url, source.timeoutMs, source.retries));
  const nested = asArray(xml.sitemapindex?.sitemap).slice(0, 5);
  if (nested.length) {
    const childItems = await Promise.all(
      nested.map((sitemap: Record<string, unknown>) =>
        fetchSitemap({
          ...source,
          url: String(sitemap.loc),
          limit: Math.ceil((source.limit ?? 30) / nested.length)
        })
      )
    );
    return childItems.flat().slice(0, source.limit ?? 30);
  }

  const includes = source.pathIncludes ?? [];
  const urls = asArray(xml.urlset?.url)
    .filter((entry: Record<string, unknown>) => {
      const loc = String(entry.loc ?? "");
      return !includes.length || includes.some((part) => loc.includes(part));
    })
    .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
      String(b.lastmod ?? "").localeCompare(String(a.lastmod ?? ""))
    )
    .slice(0, source.limit ?? 30);

  return urls.map((entry: Record<string, unknown>) => {
    const url = String(entry.loc);
    const title = titleFromUrl(url);
    return makeRawItem({
      title,
      url,
      sourceId: source.id,
      sourceName: source.name,
      sourceType: "sitemap",
      publishedAt: String(entry.lastmod ?? "") || undefined,
      snippet: `Official ${source.name} page updated in the source sitemap.`,
      tags: tagsFromText(title, source)
    });
  });
}

async function fetchArxiv(source: SourceConfig): Promise<RawItem[]> {
  const query = source.query ?? "cat:cs.AI";
  const params = new URLSearchParams({
    search_query: query,
    sortBy: "submittedDate",
    sortOrder: "descending",
    max_results: String(source.limit ?? 25)
  });
  const xml = parser.parse(await fetchText(`https://export.arxiv.org/api/query?${params}`, source.timeoutMs, source.retries));
  return asArray(xml.feed?.entry).map((entry: Record<string, unknown>) => {
    const title = stripHtml(String(entry.title ?? "Untitled arXiv paper"));
    const id = String(entry.id ?? "");
    const link = asArray(entry.link as Record<string, unknown>[]).find((candidate) => candidate.title === "pdf") ?? {};
    const url = id || String(link.href ?? "");
    const summary = stripHtml(String(entry.summary ?? ""));
    const authors = asArray(entry.author as Record<string, unknown>[])
      .map((author) => String(author.name ?? ""))
      .filter(Boolean)
      .slice(0, 4)
      .join(", ");
    return makeRawItem({
      title,
      url,
      sourceId: source.id,
      sourceName: source.name,
      sourceType: "arxiv",
      publishedAt: String(entry.published ?? entry.updated ?? "") || undefined,
      snippet: summary,
      author: authors,
      tags: tagsFromText(`${title} ${summary}`, source)
    });
  });
}

async function fetchGithubSearch(source: SourceConfig): Promise<RawItem[]> {
  const params = new URLSearchParams({
    q: source.query ?? "llm stars:>100",
    sort: "updated",
    order: "desc",
    per_page: String(source.limit ?? 25)
  });
  const response = await fetchWithRetry(`https://api.github.com/search/repositories?${params}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "AI Systems Radar/0.1 (+https://ai-radar.sarveshk.dev)",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    },
    signal: AbortSignal.timeout(source.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }, source.retries ?? DEFAULT_RETRIES);
  if (!response.ok) throw new Error(`GitHub search HTTP ${response.status}`);
  const json = (await response.json()) as { items?: Array<Record<string, unknown>> };
  return (json.items ?? []).map((repo) => {
    const title = String(repo.full_name ?? repo.name ?? "GitHub repository");
    const description = String(repo.description ?? "");
    return makeRawItem({
      title,
      url: String(repo.html_url ?? ""),
      sourceId: source.id,
      sourceName: source.name,
      sourceType: "github_search",
      publishedAt: String(repo.pushed_at ?? repo.updated_at ?? repo.created_at ?? "") || undefined,
      snippet: description,
      tags: tagsFromText(`${title} ${description}`, source),
      metrics: {
        stars: Number(repo.stargazers_count ?? 0),
        forks: Number(repo.forks_count ?? 0)
      }
    });
  });
}

async function fetchHackerNews(source: SourceConfig): Promise<RawItem[]> {
  const endpoints = source.endpoints ?? ["topstories"];
  const endpointIds = await Promise.all(
    endpoints.map(async (endpoint) => {
      const text = await fetchText(`https://hacker-news.firebaseio.com/v0/${endpoint}.json`, source.timeoutMs, source.retries);
      return JSON.parse(text) as number[];
    })
  );
  const ids = Array.from(new Set(endpointIds.flat())).slice(0, source.limit ?? 75);
  const stories = await Promise.all(
    ids.map(async (id) => {
      try {
        const text = await fetchText(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, source.timeoutMs, source.retries);
        return JSON.parse(text) as Record<string, unknown> | null;
      } catch {
        return null;
      }
    })
  );
  return stories
    .filter((story): story is Record<string, unknown> => Boolean(story?.title))
    .filter((story) => keywordIncludes(`${story.title ?? ""} ${story.text ?? ""} ${story.url ?? ""}`, TOPIC_KEYWORDS))
    .map((story) => {
      const id = Number(story.id);
      const title = stripHtml(String(story.title));
      const url = String(story.url ?? `https://news.ycombinator.com/item?id=${id}`);
      return makeRawItem({
        title,
        url,
        sourceId: source.id,
        sourceName: source.name,
        sourceType: "hn",
        publishedAt: story.time ? new Date(Number(story.time) * 1000).toISOString() : undefined,
        snippet: `Hacker News discussion signal with ${Number(story.score ?? 0)} points and ${Number(story.descendants ?? 0)} comments.`,
        tags: tagsFromText(title, source),
        metrics: {
          hnScore: Number(story.score ?? 0),
          hnComments: Number(story.descendants ?? 0)
        }
      });
    });
}

export async function fetchSource(source: SourceConfig): Promise<{ items: RawItem[]; health: SourceHealth }> {
  const started = Date.now();
  if (!source.enabled) {
    return {
      items: [],
      health: { id: source.id, name: source.name, type: source.type, status: "skipped", fetched: 0, selected: 0 }
    };
  }
  try {
    const items =
      source.type === "rss" || source.type === "google_news"
        ? await fetchRss(source)
        : source.type === "sitemap"
          ? await fetchSitemap(source)
          : source.type === "arxiv"
            ? await fetchArxiv(source)
            : source.type === "github_search"
              ? await fetchGithubSearch(source)
              : await fetchHackerNews(source);
    return {
      items,
      health: {
        id: source.id,
        name: source.name,
        type: source.type,
        status: "ok",
        fetched: items.length,
        selected: 0,
        elapsedMs: Date.now() - started
      }
    };
  } catch (error) {
    return {
      items: [],
      health: {
        id: source.id,
        name: source.name,
        type: source.type,
        status: "failed",
        fetched: 0,
        selected: 0,
        elapsedMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

export async function fetchAllSources(sources: SourceConfig[]) {
  const results = await Promise.all(sources.map((source) => fetchSource(source)));
  return {
    items: results.flatMap((result) => result.items),
    health: results.map((result) => result.health)
  };
}
