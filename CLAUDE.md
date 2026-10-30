# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Sensum & Bakery — a single-page bilingual (RU/AZ) PWA barista handbook: drink recipes, prep ("заготовки") recipes, the "Витрина" (salads, sandwiches, desserts with allergen notes), promos ("Акции"), favorites, and an «Ещё» tab holding the changelog and the training section («Обучение»: flashcards and quizzes generated from the recipe data, with quiz results sent to the training manager's Google Sheet and Telegram). No framework, no build step — the entire app is one static `index.html` file (~210KB: markup, CSS, JS and all recipe data) plus photos in `images/`, a service worker, manifest, and icons. As of v1.78: 56 drinks, 23 preps, 35 vitrina items, 3 promos, 82 photos.

## Commands

There is no build or test tooling — it's plain HTML/CSS/JS. The only check is the data audit script (stdlib Python, no install):

```bash
python3 tools/audit.py
```

It reads `DATA` / `IMAGES` / `CHANGELOG` out of `index.html` and checks (photo files exist and their filename hash matches the content, leftover files in `images/` are reported): RU/AZ parity (same ids, same `ing`/`steps`/`usedin` lengths, same `cat`/`img`), every `cat`/`kind`/allergen key exists in its dictionary, every `img` exists in `IMAGES`, every prep `trig` actually occurs in the ingredients of the items in its `usedin` (both languages), promo and changelog ids resolve, and `APP_VERSION` matches `sw.js` `CACHE`. Exit code 1 means a real problem (**run it before every push that touches `index.html`**); `WARN` lines are advisory (e.g. vitrina items without a photo fall back to an icon, and promo gift-drink choices are plain names, not ids). To preview locally:

```bash
python3 -m http.server 8000
```

then open `http://localhost:8000/index.html`.

Deploying is `git push` to `main` — GitHub Pages (legacy build, serving the repo root of `main`) rebuilds automatically in about a minute. Live at https://nuranshahbalayev-hub.github.io/Sensum-Bakery---Handbook/.

Pushes go to a feature branch and are merged to `main` by the owner (pull request). **Before every push that changes `index.html`, bump `CACHE` in `sw.js`** (e.g. `sensum-v1.26` → `.27`) and `APP_VERSION` inside `index.html`. This is an installed PWA; without the version bump, already-open/installed clients can keep serving stale content — see Service worker below.

## File map

- `index.html` — everything: markup, one `<style>` block, and three `<script>` blocks (an inline theme-flash guard in `<head>`, the main app script with `IMAGES`/`DATA`/`CHANGELOG` and all logic, and the service-worker registration at the end). Line numbers drift constantly — search by function name instead.
- `sw.js` — service worker (offline cache + update handling).
- `manifest.webmanifest`, `icon-*.png`, `apple-touch-icon.png` — PWA metadata.
- `images/` — all photos, `<key>.<hash>.webp`, longest side ≤1000px.
- `tools/audit.py` — the data audit described above.
- `tools/photo.py` — add/replace a photo (needs Pillow): `python3 tools/photo.py <key> <source-image>`. Converts to WebP, writes `images/<key>.<hash>.webp`, deletes the key's old file and updates `IMAGES` in `index.html`. **Always use it instead of dropping files into `images/` by hand.** A new drink/vitrina item uses the same key as its `img` field.
- `tools/apps-script/Code.gs` — the Google Apps Script bound to the training manager's results sheet (see "Training results" below). It is a copy kept here for history and review; the running version lives in the sheet's Apps Script editor. `node tools/apps-script/test.js` runs it against in-memory mocks of the Apps Script services.

## Architecture

### Data is embedded, not fetched

`index.html`'s main `<script>` opens with two single-line literals:

- `IMAGES` — `{key: "images/<key>.<hash>.webp"}` map; `img(key)` returns the path and every render site uses it as `<img src>`. Photos are separate WebP files in `images/`, **not** embedded. The 8-hex-char hash in the filename is the SHA-1 of the file content: because the service worker serves photos cache-first, a swapped photo must get a new URL or installed apps would keep showing the old one.
- `DATA` — every list/dictionary exists as an `_ru` / `_az` pair: `drinks`, `preps`, `vitrina`, `promos` (lists) and `CATS`, `KINDS`, `VCATS` (vitrina categories), `ALG` (allergen names) (dictionaries). `ui` is the single RU/AZ string table read through `T(key)`.
  - Vitrina items: `{id, name, cat, img?, desc, alg:{has:[…], may:[…]}, anote, tags}`. Allergens are derived from the composition; `anote` is the free-text caution (e.g. sauce usually contains X). `img` is optional — cards fall back to `VIT_ICON[id]` / `VIT_CAT_ICON[cat]`.
  - Promos: `{id, icon, name, sub, price, days[0–6], from, to, parts:[{title, ids, extra}], …}`; `promoStatus()` decides whether a promo is active now.

`DATA` is compact JSON on a single very long line (~150KB). Don't `grep`/`Read` that line directly. Extract it with a small Python script (find the `DATA={` offset, bracket-match to the closing `}`, `json.loads` — `tools/audit.py` has an `extract()` helper) when you need to inspect entries, and do targeted string replacement in `index.html` for edits rather than round-tripping the whole blob.

`APP_VERSION` and `CHANGELOG` (array of `{id, date, type: 'news'|'fix', title:{ru,az}, items:{ru,az}, changed:[ids]}`) live right after `DATA`. The «Изменения» screen (under the «Ещё» tab) renders `CHANGELOG` directly. Other persisted client state (`localStorage`): `sensum_lang`, `sensum_theme`, `sensum_favs` / `sensum_favpreps` / `sensum_favvit` (favorites per section), `sensum_learn` (training: see below). Unseen changelog entries (tracked via `localStorage.sensum_seen_change`) populate two separate sets that drive card badges: `type:'fix'` → `changedSet` → "Обновлено"/"Düzəliş" badge; `type:'news'` → `newSet` → "Новинка"/"Yeni" badge (checked first, so a brand-new item shows "Новинка" rather than "Обновлено" even though both types can carry a `changed` list).

### Clickable prep links (`trig`)

Every drink/prep ingredient name is plain text in its `ing` array, e.g. `["Сироп корицы","20 мл"]`. `ingRows(list)` makes an ingredient clickable by calling `prepFor(name)`, which does a case-insensitive substring match: for each prep `p`, if `name.toLowerCase().includes(p.trig)`, the ingredient links to `p.id`.

**Convention:** a prep's `trig` must (a) be its own `name` lowercased, and (b) actually occur as a substring inside the ingredient text used by every drink/prep listed in that prep's own `usedin` array — in both RU and AZ. If an ingredient gets renamed (e.g. "Коричный сироп" → "Сироп корицы") without updating every reference, or `trig` carries extra text the real ingredient string doesn't have (e.g. AZ `"mix rum (premiks)"` when the ingredient says just `"Mix Rum"`), the link silently stops working — no error, the ingredient just renders as inert text. When renaming an ingredient or a prep, grep every `ing`/`usedin` occurrence of the old string across both languages, not just the prep's own `name`/`trig`. A full-app audit script (cross-referencing every prep's `usedin` list against the actual `ing` text of the drinks/preps it names) is the fast way to check for drift after a rename.

### Changelog entries vs. silent edits

Not every change gets a `CHANGELOG` entry. The standing rule from the project owner (Nuran): a genuinely **new** drink or prep gets a `type:'news'` entry (with `changed` listing its id, so it carries the "Новинка" badge); a **significant change in technique** that staff need to notice gets a `type:'fix'` entry. Routine corrections — gram/quantity tweaks, an ingredient rename, a clarified step, a photo swap, a shelf-life change — do **not** get a changelog entry; just edit the data in place. If a request to change a drink/prep doesn't say one way or the other, ask rather than defaulting to logging it — unprompted "Обновлено" badges on cards nobody actually needs to re-read trains staff to ignore the tab.

### Language switching swaps whole arrays, not per-string

`LANG` (`'ru'|'az'`) selects `drinks`, `preps`, `CATS`, `KINDS` by re-pointing them at `DATA['drinks_'+LANG]` etc. (`setLang()`), then calls `_reindex()` to rebuild the `drinkById`/`prepById` lookup maps and `applyUI()` to re-render chrome text via `T()`. There's no per-component i18n — adding a language means adding matching `_az`-suffixed siblings for every top-level `DATA` key, plus every key in `ui`.

Azerbaijani has dotted İ/i vs dotless I/ı, which native `.toUpperCase()` / CSS `text-transform:uppercase` get wrong. Any UI text that needs uppercase display goes through the `upperLocale()` helper instead (see `.chtype`/`.newr` badges) — don't reach for `text-transform:uppercase` on new AZ-visible text.

### The card detail view is a bottom sheet, not a route

`openDrink(id)`/`openPrep(id)` (dispatched via `openItem(id)`) build the detail markup into `#sheetInner` and call `showOverlay()`. Closing always funnels through `hideOverlay()` / `closeSheet()` / `slideDownAndClose()` — there are four independent close triggers (✕ button, backdrop tap, Escape, swipe-down) kept on one shared path so animation, focus restoration, and body-scroll-unlock stay in sync. Route any new way of closing the sheet through `closeSheet()`.

Swipe-to-dismiss (`dragStart`/`dragMove`/`dragEnd` near the bottom of the script) only arms once `sheet.scrollTop<=1` — deliberately gated so it doesn't fight the sheet's own internal scrolling on long recipes. Body scroll is locked with `position:fixed` + a saved `scrollY` (`lockBodyScroll`/`unlockBodyScroll`), not `overflow:hidden` — the latter doesn't reliably block touch scroll on mobile and lets the grid behind the sheet scroll while the user tries to swipe.

### The «Ещё» tab and its sub-screens

The fifth nav tab is `more`. `switchTab()` knows seven views (`VIEWS`): the five tabs plus `changes` and `learn`, which `NAV_OF` maps to the `more` button so it stays highlighted while a sub-screen is open. The hub (`renderMore()`) shows one tile per sub-screen; each sub-screen has a `.subbar` with a back button (`data-gotab="more"`). The unseen-changes dot (`#changesdot`) sits on the «Ещё» button.

### Training (Обучение)

- **Questions are generated, not stored.** `buildQuiz()` takes items from `learnItems()` (drinks filtered by category, or preps by kind; items without `ing` are skipped) and calls the generators in `GEN`: `dose`, `comp`, `photo`, `vessel` for drinks; `dose`, `comp`, `shelf`, `used`, `storage` for preps. A recipe edit changes the questions automatically; there is no question bank to maintain.
- **Distractor rules to keep when touching the generators:** dose distractors prefer real doses of the same ingredient elsewhere, then rounded multiples (`niceNum`); `comp` never offers an ingredient whose first word matches one of the item's own; `photo` never offers a drink with the identical photo file (the Raf drinks share one photo); `used` never offers a drink that mentions the prep in its ingredients, even if `usedin` forgot it. Doses parse only `N г|мл|шт|q|ml|əd` (`QRX`); decor lines (`декор`/`dekor`) are skipped.
- **Flashcards** keep a Leitner box per item in `sensum_learn.box` (keys `d:<id>` / `p:<id>`): «Знаю» +1 (max 5), «Повторить» resets to 0 and re-queues the card once. An item counts as learned at box ≥ 2, and a wrong quiz answer resets its box to 0.
- A language switch returns the training to its home screen (`learnLangChanged()`), since questions are generated in the current language.
- Training strings live in `DATA.ui` like every other UI string (keys such as `learn_title`, `q_dose`, `id_title`, `send_sent`); `LT(key, vars)` fills `{placeholders}`.

### Training results: Google Sheet, Apps Script, Telegram

- `RESULTS_URL` (top of the training code) is the `/exec` URL of the Apps Script web app bound to the sheet «Sensum Обучение: результаты тестов» in the owner's Google Drive (folder «Sensum Обучение»). An empty string turns sending off, and tests then run without an employee code.
- Employees log in once with their 4-digit code from the sheet's «Сотрудники» tab (`GET ?action=whoami&code=…` returns `{ok, name, branch}`); the login is stored in `sensum_learn.me`. With `RESULTS_URL` set a quiz cannot start without a login (flashcards can), and the quiz header shows who is logged in.
- A finished quiz goes into `sensum_learn.outbox`; `flushOutbox()` POSTs it as `text/plain` JSON (`{id, code, scope, score, total, mistakes:[{q,a,c}], lang, ver, ts}`). `text/plain` keeps it a CORS simple request, which Apps Script answers without a preflight. Offline results stay in the outbox and are retried on app start, on `online` and when the page becomes visible. The script ignores a repeated `id`; `unknown_code` drops the item and logs the employee out.
- The script appends the row to «Результаты» (per-row formulas for % and pass/fail against the named range `PassThreshold`), sends a Telegram message at once when the score is below the threshold, a 24-hour digest daily at `DigestHour`, and on Mondays at `WeeklyHour` a weekly report including who hasn't taken a test in 7 days. Thresholds and hours live on the sheet's «Настройки» tab. The bot token and chat id live in the script's properties (set from the sheet's «Sensum» menu), never in the sheet or this repo.
- **Employee names and codes never go into this repo or `index.html`**: the repo and the GitHub Pages site are public. They live only in the private sheet.
- **Changing the script:** edit `tools/apps-script/Code.gs` and run `node tools/apps-script/test.js`; the owner then pastes it into the sheet's Apps Script editor and publishes it with **Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy**. That keeps the same `/exec` URL; «New deployment» would create a new URL, and `RESULTS_URL` would have to change with it.
- The sheet's locale is en_GB on purpose: formulas written by the script and through the Sheets API use comma separators, which a ru_RU locale rejects.

### Service worker

`sw.js` is network-first for document/navigation requests (so `index.html` is always fetched fresh when online, falling back to cache offline) and cache-first for everything else. Photos live in their own cache, `sensum-img`, which is **not** wiped when `CACHE` is bumped: on install the worker reads `index.html`, extracts every `images/*.webp` path, downloads the missing ones (so the whole handbook works offline) and deletes cached photos no longer referenced. Bumping `CACHE` therefore re-downloads only the small app shell, not the photos. Because this app is added-to-homescreen on real devices, the registration script also reloads the page once on `controllerchange` — otherwise an already-open/installed instance can sit on stale JS indefinitely even after a successful deploy, since `clients.claim()` alone doesn't refresh content already on screen.

## Conventions worth knowing before editing recipe data

- **Espresso shots:** double shot = 18 g dose → 36 g yield (`["Эспрессо (двойной)","36 г"]`); single shot = 18 g output as half of a double pull (`["Эспрессо (одинарный)","18 г"]`, note "половина дабл-пролива" / AZ "dabl çəkimin yarısı").
- **Powder naming:** RU "Паудер <Name>" / AZ "<Name> paudəri" (e.g. "Паудер Elizabeta" / "Elizabeta paudəri").
- **Images:** `.card .ph{aspect-ratio:1/1}` and `.hero{aspect-ratio:16/10}`, both `object-fit:cover` — CSS crops at display time, so a new source photo doesn't need to be pre-cropped to a fixed ratio before adding it with `tools/photo.py`; a portrait photo can be center-cropped ~3:4 and a landscape one just resized, both read fine through `cover`.
- **Data source of truth:** never invent or guess a recipe change — it always comes from the project owner's explicit instruction (text, voice note, or photo of a handwritten recipe).
