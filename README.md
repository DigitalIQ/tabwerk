# Tabwerk

English · [Deutsch](README.de.md)

A Chrome extension for people with many open tabs. Tabwerk finds, groups, sorts and deduplicates tabs, watches web pages and saves every state of your windows, tabs and groups.

**Install:** [Tabwerk in the Chrome Web Store](https://chromewebstore.google.com/detail/tabwerk/jimalfhplojokembebogjlplobgoobdg)

Anything that can be computed exactly is done in code. For semantic questions Tabwerk can optionally use [Jev](https://docs.typesafe.ai), a decision model by TypeSafe. Jev is available through [OpenRouter](https://openrouter.ai) or directly from [TypeSafe](https://typesafe.ai). Without a key, every feature that only needs code still works.

## Features

| Area | What happens | Who decides |
|---|---|---|
| Quick search | A shortcut opens a search on top of any page: tabs, actions, bookmarks, history | Code (fuzzy search), Jev only on request with `⇧↵` |
| Find | Describe a tab in your own words and Tabwerk jumps to it | Jev (`choice`) |
| Page search | Describe in your own words what you are looking for on the current page, Tabwerk highlights the passage | Extraction: code, relevance and sentence: Jev (`noul`/`choice`) |
| Groups | Suggests existing groups or new ones from your categories, with a confidence per tab | Jev (`choice`) |
| Sort | Tabs or whole groups by priority, or by site, last used, opening time or title | Priority: Jev (`score`), otherwise code |
| Duplicates | Finds identical addresses and lets you pick what to close per entry; finds the same content under a different address | Addresses: code, content: Jev (`noul`) |
| Watchers | Watches a page and notifies you when a condition in plain language is met | Comparison: code, evaluation: Jev (`noul`) |
| History | Saves after every change and restores any state | Code |
| Cleanup suggestion | Marks old and unimportant tabs for closing | Age: code, importance: Jev (`score`) |
| Auto-sort | New tabs land in the right group automatically | Rules: code, otherwise optionally Jev |
| Duplicate guard | A page that is already open does not open again, unless you want it to | Code |
| Discard | Inactive tabs free their memory | Code |
| Notes | Pin a note to a tab via right-click, `Alt+Shift+N` or quick search | Code |
| Group names | Untitled groups get a short name | Candidates: code, choice: Jev |
| Sessions | Save a window under a name and reopen it later | Code |
| Focus | Collapse other groups and block distracting sites for a while | Code |
| Snooze | Close a tab and reopen it at the time you choose | Code |
| Link list | Copy tabs as Markdown or plain text | Code |
| Statistics | Tabs per window and site, oldest tabs, tab count over time | Code |
| Declutter page | Hides ads, cookie banners, promotions, newsletter boxes, social buttons and, if you like, comments, recommendations or a rule of your own. Each page type is analyzed once, later visits need no request | Candidates and hiding: code, classification: Jev (`choice`) |
| Forms | Save, fill, fill with test data; protected fields only with a separate switch | Code, unknown fields optionally Jev |
| Learning | Remembers locally where you follow or correct Jev: suggests rules, adjusts the confidence threshold per feature, passes earlier choices to Jev as examples, thumbs up or down on watchers | Code, examples optionally to Jev |
| Allow copying | Lifts blocks on copy, paste, selection and right-click, for one tab or always for a site | Code |
| Export and import | Everything as a file, sessions also as a bookmarks file | Code |

Every feature can be switched off on its own in the settings. Dependent features follow their parent.

Every action saves the current state first. “Undo” in the popup or `Alt+Shift+Z` jumps right back to it.

What Jev does well and where it is weak is described in [docs/jev-im-browser.md](docs/jev-im-browser.md) (German).

## Languages

Tabwerk speaks English and German. It follows the browser language. You can pin a language in the settings under “Language”. Dates, times, numbers, amounts and plurals are formatted for the chosen language through `Intl`. Test data for forms comes as US and German addresses. Any other browser language falls back to English.

Adding a language:

1. Copy `_locales/en/messages.json` to `_locales/<code>/messages.json` and translate the `message` values. Keep `$1` to `$9` as they are. Keys ending in `_one` and `_other` are singular and plural.
2. Add the code to `LANGUAGES` in `src/lib/i18n.js` and add a name under `lang_<code>` in every language file.
3. `npm test` checks that all languages have the same keys and placeholders.

Translations are welcome as a pull request.

## Session codec for developers

The storage module in [packages/session-codec](packages/session-codec/README.md) is a standalone ESM package for compressed browser windows. Tabwerk uses its legacy entry point so existing histories stay readable as they are. The new API adds a versioned format, content checks and input limits.

The package is available as [tabwerk-session-codec on npm](https://www.npmjs.com/package/tabwerk-session-codec). An [offline example for Tab Session Manager](examples/tab-session-manager/README.md) shows another use with that extension's export format. The [local acceptance notes](docs/session-codec.md) (German) describe the package, compatibility and browser checks.

A separate [experimental delta store and browser comparison](examples/garrison-backup-benchmark/README.md) explores transactional storage, crash recovery, retention and incremental exports. [Measurements and limits](examples/garrison-backup-benchmark/PUBLIC-RESULTS.md) document the comparison with Garrison's backup code. The prototype is not part of npm version 0.1.0 and is not an integration into Garrison. Security reports about this code are also handled by Manuel Bissinger (DigitalIQ) through the [security policy](SECURITY.md).

## Install from source

1. Clone the repository or download it as a ZIP and unpack it.
2. Open `chrome://extensions` in Chrome.
3. Turn on “Developer mode” in the top right.
4. Click “Load unpacked” and pick the folder.
5. The settings open. Choose OpenRouter or TypeSafe and connect Tabwerk. This step is optional.

Shortcuts:

| Shortcut | Action |
|---|---|
| `⌘⇧Space` (Mac), `Ctrl+Shift+Space` | Quick search |
| `Alt+Shift+T` | Popup |
| `Alt+Shift+N` | Note for the current tab |
| `Alt+Shift+Z` | Undo the last Tabwerk action |
| your choice | Fill form |
| your choice | Page search by meaning |

Change them at `chrome://extensions/shortcuts`.

## Per window

Groups, sorting, duplicates, undo and history work in the window where you open the popup. Other windows stay untouched. Duplicates and history have an “All windows” checkbox. Find and quick search look through all windows and list tabs from the current window first.

## Quick search

- Typing searches in code, fuzzy: “gh tabw” finds “GitHub … tabwerk”. Accents and ß do not matter.
- Filters: `/t` tabs, `/a` actions, `/b` bookmarks, `/h` history, `/n` notes, `/s` sessions, `/z` snoozed tabs, `/f` forms.
- Note for the active tab: `/N` opens the note window. `/N text` saves the text right away. An existing note gets it as a new line.
- Page search by meaning: `/F query` searches the active page with Jev at once. `/F` alone only opens the search bar. So you do not need a separate shortcut.
- Color mode: automatic per site, follow the system, always light or always dark.
- Full text: if you like, quick search also looks through the visible text of open tabs.
- With `/h` and `⇧↵` Jev finds pages in your history from a description, such as “the article about solar power from last week”.
- `↵` opens, `⌘⌫` closes the selected tab, `Esc` closes the search.
- Actions: close tab, pin, mute, duplicate, move to new window, close duplicates, sort, collapse and expand groups, undo, back up now and more. Actions that use Jev are marked.
- Turn on bookmarks and history in the settings. Chrome then asks for permission once.
- Quick search never asks Jev while you type, only on `⇧↵` and only if you turn that on in the settings.

On normal web pages the search sits on top of the page, with the page visible behind frosted glass. Extensions cannot show anything on `chrome://` pages or in the Web Store. There a small window opens instead.

## Page search by meaning

Instead of searching for an exact word as with `Ctrl+F`, you describe in your own words what the page should say, for example “costs on top of the listed price” or “what happens if I cancel”. Tabwerk reads the visible paragraphs, list items, headings, quotes and table cells of the page. Jev rates each passage and picks the strongest sentence per match without writing a new one. The strongest sentence shows in bold green, the rest of the passage in pale green. Use the arrows in the bar or `↵`/`⇧↵` to move between matches.

The fastest way is `/F query` in quick search, which starts the search at once. Alternatively use the “Search page” button in the popup under “Find”, or set your own shortcut at `chrome://extensions/shortcuts`. Pressing the shortcut again closes the bar. The search only runs when you ask for it, never in the background, and only on the visible page itself: embedded frames from other origins, the PDF viewer and content inside a shadow DOM are left out. On `chrome://` pages and in the Web Store a short notice opens instead of the bar. Without a Jev key Tabwerk shows a notice instead of searching.

## Declutter page

Modeled on [Unclutter](https://github.com/kitze/unclutter) by Kitze (MIT license, see `NOTICE`), rewritten for Tabwerk.

- Turn it on under Settings, Features, Pages. Chrome asks once for access to all sites, because saved rules should apply whenever a page loads.
- “Page” in the popup or “Declutter page” in quick search starts the analysis. Tabwerk collects up to 60 suspicious elements in code, and Jev assigns each one a category. Only what Jev classifies with at least 90 % confidence disappears.
- The result applies to the whole page type, for example all articles in one section. Tabwerk declutters further pages of the same type without a new request.
- Categories: ads, cookie banners, promotions, newsletters and social media are on. Comments, recommended articles and a rule in your own words can be added. Switching takes effect at once, without a new analysis.
- Cookie banners are only hidden. Tabwerk clicks nothing and gives no consent. If you want to make a choice, pause decluttering on that page.
- Unchecking an element in the popup shows it again. That counts as a correction: if Jev is often wrong on a site, Tabwerk raises the threshold. It never goes below 90 %.
- “Never declutter” applies to a site and all its subdomains. Sites on the privacy list are never analyzed.
- “Analyze on page visit” analyzes new page types on its own, once per type. The cost counts toward the monthly usage, one analysis costs about $0.0001 to $0.001.
- Main content, navigation, headings, login, payment and paywalls are protected and never hidden.

## Watchers

A watcher checks a page at a fixed interval: 5 minutes, 15 minutes, 1 hour, 6 hours, 24 hours or a custom value in `hh:mm:ss`. Chrome wakes extensions at most every 30 seconds.

Create one in the popup or by right-clicking a page:

- “Watch this page”
- “Watch selected text” puts the selection into the condition
- “Watch linked page” on a link

Tabwerk compares the page text in code. Only when something has changed does it ask Jev whether the change matches the condition. If the page is open in a tab, Tabwerk reads the rendered text from that tab. Otherwise it loads the page in the background.

## History

Tabwerk listens to every change to tabs, groups and windows. After 1.5 seconds of quiet it saves a snapshot. If nothing changed since the last one, no new snapshot is made. On top of that an alarm saves every 10 minutes.

Retention: everything from the last 24 hours (at most 400), one per hour up to 7 days, one per day up to 90 days.

Storage format: each window is stored as its own block, compressed with gzip. A block is named after a fingerprint (SHA-256) of its content. A window that does not change is therefore stored only once, no matter how many snapshots point to it. On a simulated day with 8 windows, 320 tabs and 600 changes this takes 2.2 MB instead of 34 MB. Blocks that no snapshot points to anymore are removed during cleanup. Snapshots in the old format are converted once after the update.

When restoring, Tabwerk reuses open tabs and opens missing ones. Tabs that were not part of the old state stay open and move to the end. Tabwerk saves the current state before every restore.

History lives only locally in `chrome.storage.local`. It is not a backup that survives reinstalling the extension.

## Privacy and security

- Tabwerk has no server of its own and collects no usage data.
- Jev only receives the data for the question at hand: tab title, site and path. Query parameters and anchors stay local. Watchers only send the changed lines of the watched page.
- Sites on the exclusion list in the settings never go to Jev.
- The key is stored unencrypted in `chrome.storage.local` and is not synced. Any extension with access to your Chrome profile could read it. Use a dedicated key with a spending limit.
- Saved forms are encrypted (AES-GCM). The key is stored non-extractable in IndexedDB. Exports contain them in readable form.
- Tabwerk asks for site access one site at a time, only when you create a watcher.
- Bookmarks and history are optional permissions. Tabwerk only asks when you turn on searching them.
- The repository contains no keys. Tests run without keys against fixed test answers.

The full privacy policy is in [PRIVACY.md](PRIVACY.md).

## Development

```bash
npm install
npm test          # unit tests without a browser
npm run e2e       # loads the extension in Chrome for Testing and clicks through everything
npm run icons     # renders the icons again
npm run pack      # builds dist/tabwerk-<version>.zip for the Chrome Web Store
npm run store     # creates store images from the test screenshots
```

`npm install` enables the Git hooks in `.githooks/`. After that every commit rebuilds the store package in `dist/`. Without `npm install`: `git config core.hooksPath .githooks`.

Texts and details for the Chrome Web Store are in [store/listing.md](store/listing.md) and [store/review.md](store/review.md).

`npm run e2e` needs Chrome for Testing from the Playwright cache or `CHROME_PATH`. During tests, Jev requests go to a local proxy:

| Environment | Proxy answers with |
|---|---|
| nothing set or `JEV_OFFLINE=1` | fixed test answers, no network |
| `OPENROUTER_API_KEY` | real answers from Jev through OpenRouter |
| `JEV_HELPER=/path/to/script` | output of your own script that sends a request file to Jev |

Checks that need real Jev answers are skipped offline. All test data is made up.

Layout:

```
manifest.json
_locales/              UI texts per language (Chrome i18n format)
src/background.js      service worker, messages, events, alarms, context menu
src/lib/i18n.js        translation and per-language formats
src/lib/jev.js         Jev through OpenRouter or TypeSafe
src/lib/prompts.js     questions to Jev (pure functions)
src/lib/features.js    find, groups, sort, duplicates
src/lib/history.js     history and restore
src/lib/fuzzy.js       fuzzy search
src/lib/actions.js     quick search actions
src/lib/watch.js       watchers
src/lib/duration.js    intervals
src/lib/flags.js       switches for every feature
src/lib/extras.js      cleanup, auto-sort, duplicate guard, notes, sessions, focus, snooze, statistics
src/lib/formsbg.js     save and fill forms
src/lib/formstore.js   store forms encrypted
src/lib/transfer.js    export and import
src/content/forms.js   functions that run inside the page
src/palette/           quick search
src/popup/             popup
src/options/           settings
src/watch/             window for new watchers from the context menu
src/note/              note window
src/focus/             page shown for sites blocked in focus mode
src/stats/             statistics
src/offscreen/         HTML to text for watchers
tests/                 node --test
scripts/e2e.mjs        end-to-end test
```

Code comments and the files in `docs/` are written in German.

## Support

If Tabwerk helps you, you can [buy me a coffee](https://buymeacoffee.com/manuel_8472). Tabwerk stays free either way.

## License

Tabwerk is released under the MIT license, see [LICENSE](LICENSE).

Fonts Geist and Geist Mono: SIL Open Font License, see `assets/fonts/LICENSE-Geist.txt`. Phosphor icons: MIT, see `assets/icons/LICENSE-Phosphor.txt`.
