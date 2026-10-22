# Google

**Mode**: 🌐 / 🔐 Mixed · **Domains**: `google.com`, `suggestqueries.google.com`, `news.google.com`, `trends.google.com`

## Commands

| Command | Description |
|---------|-------------|
| `opencli google news [keyword]` | Get Google News headlines (top stories or search) |
| `opencli google search <keyword>` | Search Google and extract results from the page |
| `opencli google images <keyword>` | Search Google Images: original image URLs, pixel size, file size, source page; optional local thumbnails |
| `opencli google image-download <url...>` | Download images from the `image_url` values returned by `google images` |
| `opencli google suggest <keyword>` | Get Google search suggestions |
| `opencli google trends` | Get Google Trends daily trending searches |

## What works today

- Public API commands work without a browser:
  - `news` — RSS feed, supports top stories and keyword search
  - `suggest` — JSON API, no auth needed
  - `trends` — RSS feed, supports different regions
- `google search` uses browser mode to extract results from google.com.
- `google images` uses browser mode too. It reads the **original** image URL, width/height, file size, source domain and page URL from the results page, not just the gstatic thumbnail, so results can be filtered and downloaded without opening each one.
- `google image-download` is plain HTTP (no browser). It saves each file with the extension of its real format, rejects responses that are not images (e.g. hotlink-protection pages), and never overwrites an existing file (`name.jpg` → `name_2.jpg`).

## Current limitations

- `google search` may trigger CAPTCHA in Standalone browser mode. Extension mode (with an established Chrome session) is more reliable.
- Google frequently changes its DOM structure. If `search` stops returning results, selectors may need updating.
- Snippet extraction may return empty for some results depending on Google's layout.
- `google images` returns at most 100 results per call (what Google renders on the first page) and does not scroll for more.
- `google images` filters are limited to what the Google Images Tools menu still offers (`--size`, `--type`, `--color`, `--license`). Aspect-ratio and photo/face filters are ignored by Google and therefore not exposed.
- Some hosts block hotlinking; `google image-download` retries once without a Referer and reports `failed` with a reason otherwise. Pass `--referer <page_url>` (the `page_url` column) to retry with the source page as Referer. Check the image's license on the source page before reusing it, `--license creative-commons` only narrows the search.

## Usage Examples

```bash
# Search images, with filters
opencli google images "golden retriever puppy" --limit 10 --size large -f json
opencli google images "logo" --type clipart --color transparent --license creative-commons

# Save thumbnails (01.jpg, 02.jpg, ... = result rank) to look at before choosing
opencli google images "golden retriever puppy" --limit 12 --preview ./previews -f json

# Download chosen originals (several URLs: comma or space separated)
opencli google image-download "https://example.com/a.jpg,https://example.com/b.webp" --output ./pics -f json

# Get top news headlines
opencli google news --limit 5

# Search news for a topic
opencli google news "artificial intelligence" --limit 10 --lang en --region US

# Search Google
opencli google search "typescript tutorial" --limit 10

# Get search suggestions
opencli google suggest python

# Output as JSON
opencli google search "machine learning" -f json

# Get trending searches in Japan
opencli google trends --region JP --limit 10
```

## Prerequisites

- `suggest`, `news`, `trends` do not require Chrome.
- `search` and `images` require:
  - Chrome running (or Standalone mode will auto-launch)
  - For best results, use the [Browser Bridge extension](/guide/browser-bridge) with an established Google session

## Notes

- `suggest` defaults to `--lang zh-CN`; other commands default to `--lang en`.
- `news` supports `--lang` and `--region` parameters for localized results.
- `trends` traffic values are raw strings (e.g. "500K+", "1,000,000+"), not numeric.
- `images` columns: `rank`, `title`, `width`, `height`, `file_size` (as Google shows it, e.g. `522KB`), `domain`, `image_url`, `page_url`, `preview` (local thumbnail path when `--preview` is set, otherwise `null`). `--color` accepts `color`, `bw`, `transparent` or a swatch (`red`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple`, `pink`, `white`, `gray`, `black`, `brown`); `--license` accepts `creative-commons` or `commercial`.
- `image-download` columns: `index`, `status` (`success` / `failed`), `file` (absolute path), `bytes`, `format`, `url`, `error`. It exits non-zero only when every URL fails; check `status` per row for partial failures.
- `search` output includes three result types: `result` (standard), `snippet` (featured answer box), and `paa` (People Also Ask).
