# Reusable skills (from the wider ecosystem, not authored here)

These are generic patterns/libraries with well-established usage that don't need a project-specific skill file — pull in the library's own docs, an existing community skill/plugin if one is installed, or a thin wrapper, rather than re-deriving this project's version of these from scratch. They're listed here so Claude Code knows they exist and where to look, not implemented in `.claude/skills/`.

| Topic | What it covers | Where to look |
|---|---|---|
| **Chrome Extension Manifest V3 boilerplate** | `manifest.json` structure, `chrome.sidePanel` API setup, service worker registration, host_permissions scoping | [Chrome for Developers — Manifest V3 docs](https://developer.chrome.com/docs/extensions/mv3/), [Side Panel API docs](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) |
| **Readability.js integration** | Extracting main article content from arbitrary DOM, stripping boilerplate | [Mozilla's readability GitHub repo](https://github.com/mozilla/readability) — usage examples in its README |
| **Transformers.js in a Web Worker** | Loading a quantized embedding model (e.g. `all-MiniLM-L6-v2`) client-side, running inference off the main thread | [Hugging Face Transformers.js docs](https://huggingface.co/docs/transformers.js) — has a dedicated Web Worker example |
| **IndexedDB patterns** | Schema design, transactions, common wrapper libraries (`idb`) to avoid raw IndexedDB boilerplate | [`idb` library docs](https://github.com/jakearchibald/idb) |
| **CSS Custom Highlight API** | Non-destructive text highlighting via `Highlight` objects and `::highlight()` pseudo-element, browser support notes | [MDN — CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API) |
| **Gemini API tool-calling / function-calling** | Request/response shape for tool-use loops, streaming, free-tier quota limits | [Google AI Gemini API docs — function calling](https://ai.google.dev/gemini-api/docs/function-calling) |
| **Ollama local model serving** | Running a local LLM server for the future E5 fallback, API shape for chat/tool-use | [Ollama docs](https://ollama.com/library) — only needed when sub-feature E5 is actually built |

## How to use this list

When a sub-feature from `docs/master-spec.md` needs one of these, check whether a skill or plugin covering it is already available in the current environment first — if `search_skills`/`search_plugins`-equivalent tooling is present, use it. Otherwise, go directly to the linked docs rather than writing a bespoke `.claude/skills/` entry for it, since these are stable, well-documented, non-project-specific patterns. Only the logic unique to *this project's decisions* (scoring formulas, quota backfill, thread schema, scan-button state matrix, citation-to-highlight mapping, search-result filtering scope) gets a local skill file in `.claude/skills/`.
