---
name: recipe-update
description: Change the handbook's content — a drink, prep (заготовка), vitrina item, promo, photo or UI text — from the owner's instruction (text, voice note transcript or photo of a handwritten recipe), and ship it as a pull request to main. Use for any request like «измени рецепт», «добавь напиток», «поменяй граммовку», «замени фото», «новая акция», «исправь перевод».
---

# Recipe and content update

The owner (Nuran, training manager) sends a change; you apply it to `index.html` in both languages, verify it and open a PR to `main`. Read `CLAUDE.md` first if it is not already in context: it explains `DATA`, `trig`/`usedin`, the changelog rule and the release steps this procedure relies on.

## 1. Pin down the change before editing

- **Never invent or guess recipe content.** Every quantity, ingredient, step, name and shelf life comes from the owner's message. If something is missing or ambiguous (a photo you can't read, "как обычно", a dose without a unit), ask.
- **Changelog:** a new drink/prep gets a `type:'news'` entry; a significant technique change gets `type:'fix'`; routine corrections (grams, a renamed ingredient, a clarified step, a photo, shelf life) get **no** entry. If the message doesn't say which, ask: «Добавить запись в «Изменения» или поменять тихо?».
- **Azerbaijani:** every RU text needs its AZ twin. Use the existing AZ wording of the same ingredient elsewhere in `DATA` (search it first). For genuinely new phrases, draft them and list them in the PR as «AZ на проверку» — the owner checks AZ.

## 2. Edit

- Find the entry with a small Python script using `tools/audit.py`'s `extract()`; never print the whole `DATA` line.
- Edit with targeted string replacements on the exact JSON fragment, asserting each fragment occurs exactly once, for `_ru` and `_az` alike. Don't round-trip the whole `DATA` blob through `json.dumps`.
- Renamed ingredient or prep: update every `ing`/`usedin` occurrence in both languages and keep each prep's `trig` matching the ingredient text (see CLAUDE.md, «Clickable prep links»).
- New prep used by a drink: add the drink to the prep's `usedin` with the dose from the drink's own recipe.
- Photo: `python3 tools/photo.py <key> <source-image>` (never copy files into `images/` by hand). A new drink/vitrina item's `img` is its key.
- New UI text: add a key to `DATA.ui` with `ru` and `az` and read it through `T()`; no Russian literals in JS.

## 3. Release and verify

```bash
python3 tools/release.py          # bumps APP_VERSION + sw.js CACHE, runs the data audit
node tools/smoke.js               # whole app in a browser, mocked results backend
```

Both must pass (audit: 0 errors; review new WARN lines). If the change touched training texts or generators, the smoke test's quiz-generator line covers them.

## 4. Ship

- Branch `claude/<short-topic>` from the latest `origin/main`; one commit; push; open the PR **against `main`** (never on top of another feature branch).
- PR description in Russian: what changed (per drink/prep), whether a changelog entry was added, «AZ на проверку» list if any, and the check results.
- Tell the owner the PR link and that the site updates about a minute after «Merge».
