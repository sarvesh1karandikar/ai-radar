import crypto from "node:crypto";
import type { RawItem, SourceConfig, Taxonomy } from "../../src/types";

export const DEFAULT_TIMEOUT_MS = 15000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function stableId(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}

export function canonicalizeUrl(input: string): string {
  try {
    const url = new URL(input);
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        key.startsWith("utm_") ||
        ["fbclid", "gclid", "mc_cid", "mc_eid", "ref", "source"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/" && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return input.trim();
  }
}

export function stripHtml(value = ""): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const slug = parts[parts.length - 1] || parsed.hostname;
    return slug
      .replace(/\.(html|htm)$/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  } catch {
    return url;
  }
}

export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function hoursSince(date: string | undefined, now = new Date()): number {
  if (!date) return 96;
  const time = Date.parse(date);
  if (Number.isNaN(time)) return 96;
  return Math.max(0, (now.getTime() - time) / (60 * 60 * 1000));
}

export function inferSignal(sourceType: RawItem["sourceType"]) {
  if (sourceType === "arxiv") return "research" as const;
  if (sourceType === "github_search") return "builder-signal" as const;
  if (sourceType === "hn") return "community-signal" as const;
  if (sourceType === "google_news") return "discovery" as const;
  return "primary" as const;
}

export function primaryCategory(item: Pick<RawItem, "tags">, source?: SourceConfig): Taxonomy {
  if (item.tags[0]) return item.tags[0];
  const weighted = Object.entries(source?.categoryWeights ?? {}).sort((a, b) => b[1] - a[1]);
  return (weighted[0]?.[0] as Taxonomy | undefined) ?? "developer_tools";
}

export function makeRawItem(input: Omit<RawItem, "id" | "canonicalUrl" | "fetchedAt"> & { fetchedAt?: string }): RawItem {
  const canonicalUrl = canonicalizeUrl(input.url);
  const fetchedAt = input.fetchedAt ?? new Date().toISOString();
  return {
    ...input,
    id: stableId(`${input.sourceId}:${canonicalUrl}:${input.title}`),
    canonicalUrl,
    fetchedAt
  };
}

export function keywordIncludes(text: string, keywords: string[]): boolean {
  const normalized = normalizeText(text);
  return keywords.some((keyword) => normalized.includes(normalizeText(keyword)));
}
