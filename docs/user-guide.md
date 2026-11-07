# Docent user guide

Everything about installing, configuring and using Docent. For what the project is and how it's built, see the [README](../README.md).

**Contents:** [Setup](#setup) · [How to use it](#how-to-use-it) · [Troubleshooting](#troubleshooting)

---

## Setup

### Requirements
- **Chrome 116 or newer** (it uses the side panel and the CSS Custom Highlight API).
- **Node.js 18+**, only for the one-time `npm run vendor` step and the tests.
- At least one model to write answers:
  - **Gemini** (recommended): a free API key from [Google AI Studio](https://aistudio.google.com/apikey).
  - **Ollama** (optional, offline, slower on most laptops): [ollama.com](https://ollama.com).

### 1. Get the code and its vendored libraries

```sh
git clone <this repository>
cd docent
npm run vendor
```

`npm run vendor` downloads two large third-party files that aren't in git: Transformers.js and the ONNX Runtime WebAssembly binary (14 MB), at pinned versions. Nothing gets embedded until this has run. Details: [`workers/vendor/VENDORED.md`](../workers/vendor/VENDORED.md).

### 2. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `docent` folder.
4. Pin **Docent** to the toolbar (the puzzle-piece menu → pin).

After pulling new code, click the reload icon on the extension's card.

### 3. Choose a model

Click the toolbar icon to open the side panel, then **⚙** (settings):

- **Gemini API key:** paste your key and press **Save**. It's stored only in this browser.
- **Headings & summaries:** "Gemini Flash-Lite (local Ollama if Gemini fails)" or "Local Ollama only". Chat follows the same choice.
- **Ollama model:** the name of a model you've pulled (for example `qwen2.5:1.5b`). Leave it empty to skip Ollama.
- **Search the web with:** DuckDuckGo, Google, Bing or Brave Search.

**How chat picks a model:** with a Gemini key, chat uses the newest stable **Gemini Flash** model. When that model's free daily quota runs out, it moves to the next Flash model, then the Flash-Lite models, then Ollama. A model that doesn't reply within 25 seconds is skipped for that question. The line under each answer says which model wrote it, and why if it had to fall back.

### 4. Optional: local models with Ollama

Ollama runs a language model on your own computer. Answers and headings then work offline, and your questions never leave the machine. It's slower than Gemini on most laptops, and small models follow instructions less reliably: they cite less and are likelier to answer from memory. The relevance gate and the grounding check help with that.

**Install:**

| System | Command |
|---|---|
| Linux | `curl -fsSL https://ollama.com/install.sh \| sh` (installs it as a background service) |
| macOS | `brew install ollama`, or the app from [ollama.com/download](https://ollama.com/download) |
| Windows | the installer from [ollama.com/download](https://ollama.com/download) |

**Start it** (if it isn't already running as a service or app):
```sh
ollama serve                 # leave this running
```
On Linux with the service install, use `systemctl status ollama` to check it, and `sudo systemctl start ollama` to start it.

**Download a model:**
```sh
ollama pull qwen2.5:1.5b
```

**Check it works:**
```sh
ollama list                                   # your downloaded models
ollama run qwen2.5:1.5b "Say hello in five words."
curl http://localhost:11434/api/tags          # what the extension talks to
```

**Then in the panel's ⚙:** enter the model name exactly as `ollama list` shows it (for example `qwen2.5:1.5b`), and choose one of:
- **"Gemini Flash-Lite (local Ollama if Gemini fails)"** to use Ollama as a fallback.
- **"Local Ollama only"** to never use Gemini.

**Which model:**

| Model | Download | Memory needed (about) | Notes |
|---|---|---|---|
| `qwen2.5:1.5b` | ~1 GB | 2–3 GB | **The one this project was tested with.** Runs on most laptops. Answers are fine, but it often skips [n] citations (the panel then lists the sources it was given) and may answer off-topic questions from memory. |
| `qwen2.5:3b` | ~2 GB | 4 GB | Noticeably better at following the rules, still laptop-friendly. |
| `llama3.2:3b` | ~2 GB | 4 GB | A comparable alternative. |
| `qwen2.5:7b` | ~4.7 GB | 8 GB+ | Much better answers and citations. Slow without a good GPU or a fast CPU. |

Only `qwen2.5:1.5b` has been tested with this extension. The others are general suggestions in the same family, so check the line under an answer and see how it does. Newer model families (for example `gemma3`) may need a recent Ollama: if `ollama pull` fails with a 412 error, update Ollama first.

**Good to know:**
- The extension talks to Ollama at `http://localhost:11434`. It needs **no `OLLAMA_ORIGINS` setting**: it removes the browser's `Origin` header from its own requests to Ollama only, so websites still can't use your Ollama.
- Chat asks Ollama for an 8k-token context: the question, 5–8 page sections and recent chat turns.
- On a laptop CPU, expect 10–30 s before the first words. Chat waits up to 120 s for Ollama to start answering, then shows an error.
- **Generate headings & summaries** with Ollama takes a few minutes on a long page (it labels about 30 sections per request).
- Ollama can't use a model it hasn't downloaded. "Ollama has no model …" means: run the `ollama pull` it shows, or fix the name in ⚙.

### 5. Site access

The first time you press **Start scan** on a site, Chrome asks to let the extension read sites. It asks once for all sites, at runtime; nothing is granted at install. You can revoke it any time in the extension's settings in `chrome://extensions`. If you decline, clicking the toolbar icon on a page still lets you scan that one tab.

---

## How to use it

### Scan a page
1. Open an article or a docs page, then click the toolbar icon to open the side panel.
2. Press **Start scan**. The page's sections appear in the top half of the panel.
3. Each section card has **Show on page**, which scrolls to the section and flashes it briefly.

The first scan takes longer while the embedding model downloads. A page you've already scanned **loads by itself** when you come back to it, without reading or embedding anything again. Use **⟳ (Rescan)** if the page has changed.

**Headings & summaries** are generated only when you press **Generate headings & summaries**. This saves your free AI quota. Until then, sections show their page heading or their first words.

Some pages are handled differently:
- **Google Docs** are read from the doc's own export. Citations use **Jump to section** instead of a highlight.
- **Raw Markdown files** are parsed and highlighted like normal pages.
- **Pages with little text, or mostly links** (home pages, search results) get a notice with a **Force scan** option.
- **Sites that block extensions** say so clearly.

### Ask questions
- Type in the box at the bottom and press **Enter** (Shift+Enter adds a new line). The answer streams in; **■** stops it and keeps what was written.
- **Citations:** click **[2]** to highlight the supporting sentence on the page, and click again to clear it. **Esc** on the page, your next question, or closing the panel also clears it. If the source is on another page in the thread, that page is opened (or switched to) and highlighted there.
- **Sources (n)** under an answer folds out the cards for each source: page, section, snippet and the same show/open action.
- **Explain selected text:** select text on the page, then ask, for example "explain this in simple words" or "what does this word mean?". With a selection, the answer can use general knowledge to explain it (meanings, background), shown as "From your selection · explained".
  - Questions have to be about the selection; anything else is politely refused.
  - To attach a selection without pasting it, **drag it onto the chat**, or press **Ctrl+Esc** on the page (pages the panel has read; not on Windows, where Ctrl+Esc opens Start). It appears above the box as a short quote.
  - In your sent question, the quote is a link: click it to highlight that text on the page.
  - This works in **Google Docs** too: selecting text there and Ctrl+Esc both work. A Doc can't be highlighted, so its quotes stay plain text.
- **When the page doesn't cover it:** you'll see "The sources don't cover this." If no part of the page was close to your question, the model wasn't asked at all. Two buttons may appear:
  - **Ask anyway** sends it to the model regardless.
  - **Search the web** opens a search tab for the question.
- **Underlined sentences** in an answer couldn't be found in its sources. Check them before relying on them.
- **Typos** in questions are tolerated: the search also tries the closest words that actually appear on the page.
- **Clear** (top of the chat) deletes the thread's conversation. The pages stay.
- Drag the **handle between the sections and the chat** to resize them. Double-click it to reset.

### Threads: research across pages
A **thread** is a set of pages you're researching together, plus the conversation about them.

- Your first scan starts a thread, named after the page.
- **Following a link** from a thread page (in the same tab or a new one) shows **"Continuing *thread*"**. **Start scan** there adds the page to the thread. **×** starts a fresh thread instead, and **reattach** undoes that.
- Chat searches **every page in the thread**, and citations from other pages show the page they came from.
- **Hover the thread name** to see all its pages: the path that led here, pages added later, and pages added from links.
- Coming back to any page of a thread puts you back in that thread.
- **🗑** deletes the thread, its saved pages and its conversation.
- Past **8 pages** the page count turns amber as a reminder that answers draw on many pages. Nothing is blocked.

### Add linked pages
After scanning, press **Add linked pages**:
- You get up to 20 suggested links from the page, mostly from the article text, each with the sentence it appears in.
- The **filter box** searches all of the page's links, not just the 20 suggestions.
- Pages already in the thread are shown ticked and marked **Added**.
- Tick the pages you want and press **Add *n* pages**. Only ticked pages are read: nothing else is fetched, and no tabs open. Progress is shown, **Stop** keeps what's done, and pages that couldn't be read are listed with the reason.

Pages that build their text with JavaScript can't be read this way. Open them and use Start scan instead.

---

## Troubleshooting

| Problem | What to do |
|---|---|
| Nothing gets embedded, or the scan fails at "embedding" | Run `npm run vendor`, then reload the extension. The first scan needs internet access to download the embedding model. |
| "Needs access to this site" / can't scan a tab | Press **Allow access** when asked, or click the toolbar icon while on that tab. |
| Answers are slow | Check the line under the answer: a local Ollama model on a laptop CPU can take 10–30 s to start. Gemini usually starts within a couple of seconds. |
| "Gemini's free quota was used up" | Chat has moved down the model ladder, or to Ollama. Quotas reset at midnight Pacific time. |
| "Couldn't reach Ollama" | Start Ollama, check the model name in ⚙ (`ollama list`), or clear the field to skip Ollama. |
| A highlight lands on the wrong text, or "isn't on the page any more" | The page has changed since it was scanned. Press ⟳ Rescan. |
| A linked page "couldn't be read" | It probably builds its text with JavaScript. Open it and use Start scan. |

**Logs:** `chrome://extensions` → Docent → **service worker** opens the background console. Lines are tagged by feature (`[Docent/E4]` for chat models, `[Docent/E1]` for retrieval, `[Docent/D6]` for linked pages, and so on).

---
