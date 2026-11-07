# Docent privacy policy

*Last updated: 2026-11-07*

Docent is a browser extension that answers questions about the web page you're reading. It has no server of its own: the developer does not collect, receive or store any of your data.

## What Docent stores, and where

Everything below stays in your own browser profile, on your own device:

- **Pages you scan:** their text, sections and search index (IndexedDB).
- **Threads and conversations:** the pages in each thread and your chat history with it (IndexedDB).
- **Settings:** your model choice, Ollama model name, search engine, and your Gemini API key, if you enter one (`chrome.storage.local`).

You can delete a thread (with its pages and conversation) from the side panel at any time. Removing the extension deletes everything it stored.

## What leaves your browser, and only when

| When | What is sent | Sent to |
|---|---|---|
| You ask a question | Your question, the 5–8 page sections most relevant to it, and recent turns of that conversation | The model you chose: Google's Gemini API (using your own API key), or Ollama on your own computer (`localhost`) |
| You press **Generate headings & summaries** | The text of the page's sections | The same model |
| You press **Search the web** | Your question, as a normal search in a new tab | The search engine you chose (DuckDuckGo, Google, Bing or Brave) |
| You add linked pages | Ordinary page requests to the links you ticked | Those websites |
| Your first scan | A download request for the embedding model | Hugging Face (model files only; no page content) |

When you use Gemini, Google's own terms and privacy policy apply to what is sent to it. With Ollama, nothing about your question leaves your computer.

Docent does not use analytics, tracking, advertising or cookies, does not sell or share data, and does not send anything in the background.

## Permissions

- **Read the page you open Docent on** (`activeTab`, `scripting`): to extract and highlight text. Access to all sites is optional and is asked for once, at runtime, when you first press Start scan. You can revoke it in Chrome's extension settings.
- **Side panel, storage, offscreen document:** to show the panel, keep the data described above, and run the local embedding model.
- **`localhost:11434`:** to talk to Ollama on your own machine, if you use it.

## Contact

Questions about this policy: open an issue on the project's repository.
