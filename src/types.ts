export const TAXONOMY = [
  "multi_agent_systems",
  "inference_systems",
  "training_infrastructure",
  "model_architecture_math",
  "datacenter_power_compute",
  "model_security",
  "developer_tools",
  "business_signal"
] as const;

export type Taxonomy = (typeof TAXONOMY)[number];

export type SourceType =
  | "rss"
  | "sitemap"
  | "arxiv"
  | "github_search"
  | "hn"
  | "google_news";

export interface SourceConfig {
  id: string;
  name: string;
  type: SourceType;
  url?: string;
  query?: string;
  endpoints?: string[];
  pathIncludes?: string[];
  enabled: boolean;
  trustWeight: number;
  categoryWeights: Partial<Record<Taxonomy, number>>;
  timeoutMs?: number;
  retries?: number;
  limit?: number;
}

export interface RawItem {
  id: string;
  title: string;
  url: string;
  canonicalUrl: string;
  sourceId: string;
  sourceName: string;
  sourceType: SourceType;
  publishedAt?: string;
  fetchedAt: string;
  snippet?: string;
  author?: string;
  tags: Taxonomy[];
  metrics?: {
    hnScore?: number;
    hnComments?: number;
    stars?: number;
    forks?: number;
  };
}

export interface ScoredItem {
  raw: RawItem;
  score: number;
  recencyScore: number;
  trustScore: number;
  topicalScore: number;
  momentumScore: number;
  noveltyScore: number;
  depthScore: number;
  reasons: string[];
  clusterId?: number;
}

export interface SourceHealth {
  id: string;
  name: string;
  type: SourceType;
  status: "ok" | "failed" | "skipped";
  fetched: number;
  selected: number;
  elapsedMs?: number;
  error?: string;
}

export interface EditionItem {
  title: string;
  url: string;
  source: string;
  category: Taxonomy;
  signal: "primary" | "research" | "builder-signal" | "community-signal" | "discovery";
  whyItMatters: string;
  brief: string;
  technicalTakeaway: string;
  evidence: string;
  sourceExcerpt: string;
  citationUrl: string;
  contextQuality: "source-grounded" | "thin public context";
  readTime: string;
}

export interface DailyEdition {
  date: string;
  generatedAt: string;
  mode: "fixture" | "live";
  title: string;
  summary: string;
  mustRead: EditionItem[];
  watchlist: EditionItem[];
  deepDive: {
    title: string;
    url: string;
    source: string;
    category: Taxonomy;
    summary: string;
    bullets: string[];
  };
  bookmark: EditionItem;
  sourceHealth: SourceHealth[];
  stats: {
    fetched: number;
    afterDedupe: number;
    afterFreshness: number;
    droppedStale: number;
    selected: number;
    clusters: number;
    failures: number;
    pipeline: "statistical_ml";
  };
}
