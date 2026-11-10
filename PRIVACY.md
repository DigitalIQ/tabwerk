# Tabwerk privacy policy

English · [Deutsch](PRIVACY.de.md)

Last updated: November 10, 2026

Tabwerk is a Chrome extension without a server of its own. The provider of Tabwerk receives no data from you. Tabwerk has no tracking or ads.

## What stays on your computer

Everything Tabwerk stores lives in `chrome.storage.local` in your Chrome profile:

- settings and, if you entered one, your key for OpenRouter or TypeSafe
- the history of your windows, tabs and groups
- named sessions, notes, snoozed tabs
- for each emoji you select, the number of successful selections and the time of last use for favorites and statistics
- watchers and the last text read from each watched page
- saved forms, encrypted with AES-GCM. Tabwerk creates the key itself and stores it non-extractable in your Chrome profile. This protects against someone looking into the profile files, not against malware on your computer. Password, card, account, IBAN and TAN fields are only saved if you turn on the switch “Also save protected fields”. Exports contain forms in readable form.
- the list of sites where Tabwerk always allows copying
- for learning: up to 1000 of your decisions on Jev suggestions, with the tab's title and site, Jev's suggestion, your choice and Jev's confidence. Sites on the exclusion list are left out. You can delete this in the settings under “Learning”.

This data stays in your Chrome profile. Removing Tabwerk deletes it. You can also clear your history in the settings.

## What Tabwerk sends

Only if you enter a key and use a feature that needs Jev does Tabwerk send a request to the service you chose: OpenRouter (openrouter.ai) or TypeSafe (typesafe.ai). Jev is a decision model by TypeSafe. The request contains only what this one decision needs:

| Feature | Content of the request |
|---|---|
| Find, groups, sort, cleanup, group names | Title, site and path of the tabs. No parameters after “?” and no anchors after “#” |
| Page search by meaning | Your query and the visible text of the current page: paragraphs, list items, headings, quotes and table cells, at most 160 passages and 60,000 characters. Values from form fields are never included |
| Declutter page | Page type (such as article or home page) and up to 60 short descriptions of page elements: tag, class and ID names, position and up to 450 characters of visible text per element. Tabwerk replaces links, email addresses and long numbers with placeholders first. No address, no page title, no article text and no form values. Plus your own rule, if you created one |
| Find same content | Title, site and path of the compared tabs |
| Watchers | Your condition, the page's title and site, the changed lines or text around numbers |
| History in plain language | Your query and title, site and path of up to 200 visited pages from the chosen period |
| Bookmark folders | Title, site and path of the page and the names of your bookmark folders |
| Map form fields | Labels and names of the fields. No values |
| Groups, when “Send earlier choices to Jev as examples” is on | Additionally up to 8 earlier assignments: title, site and group name |

Sites on your exclusion list never go to Jev. Processing at OpenRouter and TypeSafe is governed by their privacy policies.

## Permissions in Chrome

Tabwerk only asks for permissions when a feature needs them:

- read access to a site only when you create a watcher for exactly that site
- bookmarks and history only when you turn on searching them
- read access to all sites only for full-text search and for “Declutter page”. With full-text search the text read stays in the browser. With decluttering only the descriptions from the table above go to Jev, and only during an analysis. If you turn “Declutter page” off, Tabwerk gives the permission back, as long as full-text search is off too.
- read access to a site when you want to always allow copying there

## Contact

Please send questions and feedback as an issue in the repository: https://github.com/DigitalIQ/tabwerk/issues
