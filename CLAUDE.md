# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Sensum & Bakery — a single-page bilingual (RU/AZ) PWA barista handbook: drink recipes, prep ("заготовки") recipes, the "Витрина" (salads, sandwiches, desserts with allergen notes), promos ("Акции"), favorites, and a changelog. No framework, no build step — the entire app is one static `index.html` file (~5.2MB, mostly embedded base64 photos) plus a service worker, manifest, and icons. As of v1.76: 56 drinks, 23 preps, 35 vitrina items, 3 promos, 82 embedded photos.

## Commands

There is no build or test tooling — it's plain HTML/CSS/JS. The only check is the data audit script (stdlib Python, no install):

```bash
python3 tools/audit.py
```

It reads `DATA` / `IMAGES` / `CHANGELOG` out of `index.html` and checks: RU/AZ parity (same ids, same `ing`/`steps`/`usedin` lengths, same `cat`/`img`), every `cat`/`kind`/allergen key exists in its dictionary, every `img` exists in `IMAGES`, every prep `trig` actually occurs in the ingredients of the items in its `usedin` (both languages), promo and changelog ids resolve, and `APP_VERSION` matches `sw.js` `CACHE`. Exit code 1 means a real problem (**run it before every push that touches `index.html`**); `WARN` lines are advisory (e.g. vitrina items without a photo fall back to an icon, and promo gift-drink choices are plain names, not ids). To preview locally:

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
- `tools/audit.py` — the data audit described above.

## Architecture

### Data is embedded, not fetched

`index.html`'s main `<script>` opens with two large single-line literals:

- `IMAGES` — `{key: "data:image/jpeg;base64,..."}` map, 82 photos.
- `DATA` — every list/dictionary exists as an `_ru` / `_az` pair: `drinks`, `preps`, `vitrina`, `promos` (lists) and `CATS`, `KINDS`, `VCATS` (vitrina categories), `ALG` (allergen names) (dictionaries). `ui` is the single RU/AZ string table read through `T(key)`.
  - Vitrina items: `{id, name, cat, img?, desc, alg:{has:[…], may:[…]}, anote, tags}`. Allergens are derived from the composition; `anote` is the free-text caution (e.g. sauce usually contains X). `img` is optional — cards fall back to `VIT_ICON[id]` / `VIT_CAT_ICON[cat]`.
  - Promos: `{id, icon, name, sub, price, days[0–6], from, to, parts:[{title, ids, extra}], …}`; `promoStatus()` decides whether a promo is active now.

Both are compact JSON on a single very long line. Don't `grep`/`Read` that line directly — it's several hundred KB. Extract it with a small Python script (find the `DATA={` / `IMAGES={` offset, bracket-match to the closing `}`, `json.loads`) when you need to inspect entries, and do targeted string replacement in `index.html` for edits rather than round-tripping the whole blob.

`APP_VERSION` and `CHANGELOG` (array of `{id, date, type: 'news'|'fix', title:{ru,az}, items:{ru,az}, changed:[ids]}`) live right after `DATA`. The Changes tab renders `CHANGELOG` directly. Other persisted client state (`localStorage`): `sensum_lang`, `sensum_theme`, `sensum_favs` / `sensum_favpreps` / `sensum_favvit` (favorites per section). Unseen changelog entries (tracked via `localStorage.sensum_seen_change`) populate two separate sets that drive card badges: `type:'fix'` → `changedSet` → "Обновлено"/"Düzəliş" badge; `type:'news'` → `newSet` → "Новинка"/"Yeni" badge (checked first, so a brand-new item shows "Новинка" rather than "Обновлено" even though both types can carry a `changed` list).

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

### Service worker

`sw.js` is network-first for document/navigation requests (so `index.html` is always fetched fresh when online, falling back to cache offline) and cache-first for everything else. Because this app is added-to-homescreen on real devices, the registration script also reloads the page once on `controllerchange` — otherwise an already-open/installed instance can sit on stale JS indefinitely even after a successful deploy, since `clients.claim()` alone doesn't refresh content already on screen.

## Conventions worth knowing before editing recipe data

- **Espresso shots:** double shot = 18 g dose → 36 g yield (`["Эспрессо (двойной)","36 г"]`); single shot = 18 g output as half of a double pull (`["Эспрессо (одинарный)","18 г"]`, note "половина дабл-пролива" / AZ "dabl çəkimin yarısı").
- **Powder naming:** RU "Паудер <Name>" / AZ "<Name> paudəri" (e.g. "Паудер Elizabeta" / "Elizabeta paudəri").
- **Images:** `.card .ph{aspect-ratio:1/1}` and `.hero{aspect-ratio:16/10}`, both `object-fit:cover` — CSS crops at display time, so a new source photo doesn't need to be pre-cropped to a fixed ratio before embedding; a portrait photo can be center-cropped ~3:4 and a landscape one just resized, both read fine through `cover`.
- **Data source of truth:** never invent or guess a recipe change — it always comes from the project owner's explicit instruction (text, voice note, or photo of a handwritten recipe).
