# AI Systems Radar

Static GitHub Pages digest for `ai-radar.sarveshk.dev`. A scheduled GitHub Actions workflow fetches public primary sources and signal feeds, ranks them with a local statistical pipeline, writes `content/editions/YYYY-MM-DD.json`, updates `content/latest.json`, builds the Vite site, and deploys `dist` to GitHub Pages.

## Source Contract

- Primary sources are preferred: official lab feeds/sitemaps, research feeds, infrastructure blogs, and vendor engineering posts.
- GitHub Search and Hacker News are builder/community signals. They can influence attention, but they are labeled as signals in the edition.
- Google News is a low-trust fallback discovery source and should not be used as a deep dive.
- Sources live in `config/sources.json` with enabled flags, trust weights, category weights, limits, optional timeouts, and optional retries.

## Statistical Pipeline

No LLM or private API key is required.

The collector uses:

- Keyword taxonomy classification for the AI systems categories.
- TF-IDF vectors over title, snippet, source, and tags.
- Cosine-similarity clustering to group related items.
- MMR-style selection to balance score and diversity.
- Local scoring across source trust, topical fit, freshness, momentum, novelty, and depth.
- Extractive/source-grounded blurbs from public titles and snippets.

## Local Commands

```sh
npm ci
npm test
npm run dry-run
npm run dry-run:live
npm run generate:fixture
npm run build
npm run dev
```

Optional local environment:

```sh
GITHUB_TOKEN=...
```

The built-in `GITHUB_TOKEN` is enough inside GitHub Actions for authenticated GitHub API requests.

## Guardrails

- Every published URL must be a public `http` or `https` URL.
- GitHub and Hacker News items are labeled as `builder-signal` and `community-signal`.
- Deep dives cannot use GitHub, Hacker News, or Google News fallback items.
- The collector dedupes by canonical URL and highly similar titles, filters to a freshness window, clusters candidates, and prints fetched/deduped/fresh/selected counts.

## Publishing

The workflow in `.github/workflows/deploy.yml` runs:

- On pushes to `main`: build and deploy the existing content.
- On manual dispatch: refresh content, commit generated JSON, build, and deploy.
- Daily at `13:00 UTC`: refresh content, commit generated JSON, build, and deploy.

The generated commit uses `[skip ci]` to avoid triggering a duplicate workflow.

GitHub Pages setup:

1. In the repository, go to Settings -> Pages.
2. Set Build and deployment source to GitHub Actions.
3. Set the custom domain to `ai-radar.sarveshk.dev`.
4. Enable Enforce HTTPS after DNS verifies.

DNS setup for `sarveshk.dev`:

```txt
Type:  CNAME
Name:  ai-radar
Value: <github-username>.github.io
```

For this account, the expected target is:

```txt
ai-radar.sarveshk.dev CNAME sarvesh1karandikar.github.io
```

Reference docs:

- GitHub Pages custom domains: https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site
- GitHub Pages custom workflows: https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
- arXiv API: https://info.arxiv.org/help/api/user-manual.html
- GitHub Search API: https://docs.github.com/en/rest/search/search#search-repositories
- Hacker News API: https://github.com/HackerNews/API
