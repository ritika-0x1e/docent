// Panel state → DOM. Page-derived text is untrusted and the panel runs with extension privileges,
// so everything is built with createElement/textContent — never innerHTML.

const STAGE_TEXT = {
  starting: () => "Starting…",
  loading: () => "Loading the saved scan…",
  extracting: () => "Reading the page…",
  sectioning: () => "Finding topic breaks…",
  sectioned: (tab) => `Found ${tab.sections.length} sections`,
  embedding: (tab) => `Embedding ${tab.detail?.sections ?? ""} sections…`,
  saving: (tab) => `Saving ${tab.detail?.chunks ?? ""} chunks…`,
};

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else node[key] = value;
  }
  for (const child of children) node.append(child);
  return node;
}

// savedIn: the tab's thread, when it already holds this page (Start scan is then a cache hit).
function statusText(tab, savedIn) {
  switch (tab.status) {
    case "idle":
      return savedIn ? "Saved in this thread. Start scan loads it." : "Not scanned yet";
    case "scanning":
      return (STAGE_TEXT[tab.stage] ?? (() => "Scanning…"))(tab);
    case "ready":
      return `${tab.sections.length} sections ready${tab.cacheHit ? " (saved scan)" : ""}`;
    case "needs-force":
      return tab.detail?.classification === "link-list" ? "Mostly links, not an article" : "Not enough text detected";
    case "no-access":
      return "Needs access to this site";
    case "blocked":
      return "Can't scan this page";
    case "source-error":
      return "Couldn't read this source";
    case "error":
      return "Scan failed";
    default:
      return "";
  }
}

// Banners for the non-ok outcomes. A3/B3 wording is finished in build step 4.
function bannerFor(tab, { onForceScan, onAllowAccess, onOpenSettings }) {
  if (tab.status === "needs-force") {
    const words = tab.detail?.wordCount;
    const message =
      tab.detail?.classification === "link-list"
        ? `This looks like a list of links rather than an article (${Math.round(100 * tab.detail.linkDensity)}% of its text is links).`
        : `Not enough text detected on this page${words !== undefined ? ` (${words} words)` : ""}.`;
    return {
      kind: "warn",
      nodes: [
        el("p", { text: message }),
        el("button", { type: "button", text: "Force scan anyway", onclick: onForceScan }),
      ],
    };
  }
  if (tab.status === "no-access") {
    return {
      kind: "warn",
      nodes: [
        el("p", { text: "Docent doesn't have access to this site yet." }),
        el("p", { text: "Allow it once for all sites, or click the Docent icon in the toolbar to allow just this tab." }),
        el("button", { type: "button", text: "Allow access", onclick: onAllowAccess }),
      ],
    };
  }
  // A4: pages Chrome never lets extensions read, or a content script that couldn't start.
  if (tab.status === "blocked") {
    return {
      kind: "error",
      nodes: [
        el("p", { text: "This page restricts extension access, so it can't be scanned." }),
        el("p", {}, [el("code", { text: `${tab.detail?.reason}${tab.detail?.message ? `: ${tab.detail.message}` : ""}` })]),
      ],
    };
  }
  if (tab.status === "source-error") {
    return {
      kind: "error",
      nodes: [el("p", { text: `Couldn't read this ${tab.detail?.source ?? ""} source (${tab.detail?.reason}): ${tab.detail?.message ?? ""}` })],
    };
  }
  if (tab.status === "error") {
    return { kind: "error", nodes: [el("p", { text: tab.detail?.message ?? "Unknown error" })] };
  }
  if (tab.status === "ready" && tab.detail?.storeError) {
    return { kind: "error", nodes: [el("p", { text: `Sections are shown but weren't saved: ${tab.detail.storeError}` })] };
  }
  // B3: skipped without a key, or some batches failed. Never blocks the scan; fallback headings are used.
  // B3 (on demand) went wrong. Generate stays available in the row below for another try.
  if (tab.status === "ready" && tab.detail?.relabelError) {
    return { kind: "warn", nodes: [el("p", { text: `Couldn't generate headings: ${tab.detail.relabelError}` })] };
  }
  if (tab.status === "ready" && (tab.detail?.b3Skipped === "no-key" || tab.detail?.b3Skipped === "no-ollama-model")) {
    return {
      kind: "warn",
      nodes: [
        el("p", {}, [
          tab.detail.b3Skipped === "no-key" ? "No Gemini key or local model set. " : "Ollama is selected but no model is set. ",
          el("button", { type: "button", class: "link", text: "Open ⚙ settings", onclick: onOpenSettings }),
        ]),
      ],
    };
  }
  if (tab.status === "ready" && tab.detail?.b3Errors > 0) {
    return {
      kind: "warn",
      nodes: [el("p", { text: "Some headings and summaries couldn't be generated. The service-worker console has the details; Generate retries just those." })],
    };
  }
  return null;
}

const PROVIDER_TEXT = { gemini: "Gemini Flash-Lite", ollama: "local Ollama" };
const FALLBACK_TEXT = {
  "gemini-quota": "Gemini's free quota was used up",
  "gemini-overloaded": "Gemini was overloaded",
  "gemini-error": "Gemini failed",
  "gemini-timeout": "Gemini didn't respond",
  "no-gemini-key": "no Gemini key set",
};

// B3 on demand: a scan never calls the LLM. Shown on a ready tab while any section lacks a summary,
// plus a note on which model did the last run.
function genRowNodes(tab, { onGenerateHeadings, onStopGenerating, onOpenPicklist, isPicklistOpen }) {
  if (tab?.status !== "ready" || !tab.sections?.length) return [];
  const done = tab.sections.filter((s) => s.summary !== null).length;
  const nodes = [];
  // D5 (phase 9, decision 2): the picklist opens only from here, never by itself.
  // A toggle: clicking it again closes the picklist (user, 2026-11-07).
  if (tab.threadId && onOpenPicklist) {
    const open = Boolean(isPicklistOpen?.());
    const button = el("button", { type: "button", class: `toggle${open ? " pressed" : ""}`, text: "Add linked pages", title: open ? "Close the linked pages list" : "Pick pages linked from this one to add to the thread", onclick: onOpenPicklist });
    button.setAttribute("aria-pressed", String(open));
    nodes.push(button);
  }
  if (tab.relabeling || done < tab.sections.length) {
    nodes.push(
      el("button", {
        type: "button",
        text: tab.relabeling ? `Generating… ${done}/${tab.sections.length}` : done ? `Generate the remaining ${tab.sections.length - done}` : "Generate headings & summaries",
        disabled: tab.relabeling,
        onclick: onGenerateHeadings,
      })
    );
  }
  if (tab.relabeling) nodes.push(el("button", { type: "button", text: "Stop", onclick: onStopGenerating }));
  if (tab.detail?.b3Stopped && !tab.relabeling) nodes.push(el("span", { class: "muted small", text: "Stopped; finished sections were kept." }));
  const provider = PROVIDER_TEXT[tab.detail?.b3Provider];
  // Only when something was generated: a run stopped before its first batch names no model.
  if (provider && !tab.relabeling && done > 0) {
    const why = FALLBACK_TEXT[tab.detail.b3Fallback];
    nodes.push(el("span", { class: "muted small", text: `Generated with ${provider}${why ? ` (${why})` : ""}` }));
  }
  return nodes;
}

// I2: one card per section. Generated headings get an "auto" tag so they aren't mistaken for the
// page's own; fallback headings (the section's opening words) are muted.
function sectionCard(section, index, { onShowSection }, canShow) {
  const kids = [];
  if (section.headingPath?.length) kids.push(el("div", { class: "breadcrumb", text: section.headingPath.join(" › ") }));

  const heading = el("div", { class: `card-heading${section.headingSource === "fallback" ? " fallback" : ""}` }, [
    el("span", { class: "text", text: section.heading ?? "Untitled section" }),
  ]);
  if (section.headingSource === "generated") heading.append(el("span", { class: "tag", text: "auto", title: "Heading generated by Gemini" }));
  kids.push(heading);

  kids.push(section.summary ? el("p", { class: "summary", text: section.summary }) : el("p", { class: "summary none", text: "No summary" }));
  kids.push(
    el("details", {}, [el("summary", { text: `Full text · ${section.wordCount ?? ""} words` }), el("p", { class: "full-text", text: section.text })])
  );

  const action = canShow && showAction(section);
  if (action) {
    kids.push(el("div", { class: "card-actions" }, [el("button", { type: "button", class: "link", text: action, onclick: () => onShowSection(index) })]));
  }
  const card = el("article", { class: "card" }, kids);
  card.dataset.sectionId = section.id;
  return card;
}

// Live highlight where the text is anchored; Google Docs jump through the outline; else snippet only.
function showAction(section) {
  if (section.blocks?.some((b) => b.anchored)) return "Show on page";
  if (section.jump) return "Jump to section";
  return null;
}

function idleHint(tab, threadMode) {
  if (!tab) return "Open a tab to scan it.";
  if (tab.status === "idle") {
    if (threadMode === "in") return "This page is saved in the thread. Press Start scan to load it, or search the thread below.";
    if (threadMode === "continued") return "Press Start scan to add this page to the thread, or search the thread below without scanning.";
    return "Press Start scan to read this page into a new thread.";
  }
  if (tab.status === "scanning") return "Reading the page…";
  return "";
}

// Re-renders the cards only when the tab or its sections array changed. The reducer replaces the
// array on every real change, including each B3 batch, so when the same tab re-renders, open
// "Full text" sections and the scroll position are carried over instead of resetting.
function renderReadingView(tabId, tab, container, handlers, threadMode = "none") {
  const sections = tab?.sections ?? null;
  const prev = container.__rendered;
  if (sections && prev?.tabId === tabId && prev.sections === sections) return;
  container.__rendered = { tabId, sections };

  if (!sections) {
    const hint = idleHint(tab, threadMode);
    container.replaceChildren(...(hint ? [el("p", { class: "muted", text: hint })] : []));
    return;
  }

  const sameTab = prev?.tabId === tabId && prev.sections;
  const open = sameTab ? new Set([...container.querySelectorAll(".card")].filter((c) => c.querySelector("details")?.open).map((c) => c.dataset.sectionId)) : new Set();
  const scrollTop = sameTab ? container.scrollTop : 0;

  // Show/jump read the saved scan, which only exists once the scan is done.
  const cards = sections.map((s, i) => sectionCard(s, i, handlers, tab.status === "ready"));
  for (const card of cards) if (open.has(card.dataset.sectionId)) card.querySelector("details").open = true;
  container.replaceChildren(...cards);
  container.scrollTop = scrollTop;
}

// I3 (phase 6): the conversation for the tab's thread. Answers are plain text with **bold**, "- "
// bullets and [n] citations; they're built as DOM nodes (never innerHTML), [n] as chips that jump
// to their source card.
const CITE_OR_BOLD = /(\*\*[^*\n]+\*\*|\[\d+(?:\s*,\s*\d+)*\])/;

// Only numbers with a source card become chips; any other [n] (e.g. a copied footnote) stays text.
function inlineNodes(text, onCite, valid) {
  const nodes = [];
  for (const part of text.split(CITE_OR_BOLD)) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) nodes.push(el("strong", { text: part.slice(2, -2) }));
    else if (/^\[\d/.test(part)) {
      const numbers = part.slice(1, -1).split(",").map((x) => Number(x.trim()));
      if (!numbers.every((n) => valid.has(n))) nodes.push(document.createTextNode(part));
      else for (const n of numbers) nodes.push(el("button", { type: "button", class: "cite", text: String(n), title: `Source ${n}`, onclick: () => onCite(n) }));
    } else nodes.push(document.createTextNode(part));
  }
  return nodes;
}

// Sentences the grounding check didn't find in the sources (lib/grounding.js) are underlined. They're
// matched the way the check split them (lib/grounding.js splitSentences): per line, at sentence ends,
// without bullets, bold or numbering.
const sentenceKey = (segment) => segment.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/\*\*/g, "").trim();

function lineNodes(line, onCite, valid, unsupported) {
  if (!unsupported?.size) return inlineNodes(line, onCite, valid);
  const nodes = [];
  splitSentences(line).forEach((segment, i) => {
    if (i > 0) nodes.push(document.createTextNode(" "));
    const inner = inlineNodes(segment, onCite, valid);
    if (unsupported.has(sentenceKey(segment))) nodes.push(el("span", { class: "unsupported", title: "Not found in the sources" }, inner));
    else nodes.push(...inner);
  });
  return nodes;
}

function answerBody(text, onCite, valid, unsupported = null) {
  const blocks = [];
  let list = null;
  for (const line of text.split("\n")) {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      list ??= el("ul");
      list.append(el("li", {}, lineNodes(bullet[1], onCite, valid, unsupported)));
      continue;
    }
    if (list) {
      blocks.push(list);
      list = null;
    }
    if (line.trim()) blocks.push(el("p", {}, lineNodes(line, onCite, valid, unsupported)));
  }
  if (list) blocks.push(list);
  return el("div", { class: "answer" }, blocks);
}

function modelLabel(message) {
  if (message.provider === "gemini" && message.model) {
    return message.model.replace(/^gemini-/, "Gemini ").replace(/-flash-lite$/, " Flash-Lite").replace(/-flash$/, " Flash");
  }
  if (message.provider === "ollama") return `local ${message.model}`;
  return null;
}

// What clicking citation [n] (or its card's button) does (phase 7): highlight it on this tab, open
// (or focus) its page and highlight there (F3), or jump to it in a Google Doc. The number goes straight
// to the page (user, 2026-11-07); the cards sit in a closed fold. Messages saved before phase 7 lack highlightable/jump, so they're read
// off the live section when there is one.
// "Here": this tab shows the source's page, scanned or not; its saved anchors are found on the page
// again when highlighting (user, 2026-11-07).
function isHere(source, tab) {
  if (tab?.status === "ready" && source.corpusId && tab.corpusId === source.corpusId) return true;
  return Boolean(tab?.url && source.pageUrl) && normalizeUrl(tab.url) === normalizeUrl(source.pageUrl);
}

function citationAction(source, tab, active) {
  const here = isHere(source, tab);
  const live = here ? tab.sections?.[source.order] : null;
  const highlightable = source.highlightable ?? (live ? live.blocks?.some((b) => b.anchored) : true);
  const jump = source.jump ?? Boolean(live?.jump);
  if (here) {
    if (highlightable) return { label: active ? "Clear highlight" : "Show on page", open: false, toggle: true };
    if (jump) return { label: "Jump to section", open: false };
    return null;
  }
  if (!source.pageUrl) return null;
  if (highlightable) return { label: active ? "Clear highlight" : "Open page and highlight", open: true, toggle: true };
  if (jump) return { label: "Open and jump to section", open: true };
  return null;
}


// A source card (inside the closed "Sources" fold): number, page badge when it's from another page,
// heading, snippet, and the same action as its [n] chip.
function sourceCard(source, tab, handlers, { messageKey, activeKey }) {
  const key = `${messageKey}:${source.n}`;
  const active = activeKey === key;
  const action = citationAction(source, tab, active);
  const body = [];
  if (!isHere(source, tab) && source.pageTitle) body.push(el("div", { class: "page-badge", text: source.linkedFrom ? `${source.pageTitle} (linked from ${source.linkedFrom})` : source.pageTitle, title: source.pageUrl ?? source.pageTitle }));
  body.push(el("div", { class: "source-heading", text: source.heading ?? "Untitled section" }));
  if (source.snippet) body.push(el("p", { class: "snippet", text: source.snippet }));
  // The action floats in the corner on hover, like the section cards' (user, 2026-11-07).
  const actions = action ? [el("div", { class: "card-actions" }, [el("button", { type: "button", class: "link", text: action.label, onclick: () => handlers.onCitation(key, source, action) })])] : [];
  const card = el("li", { class: `source${active ? " active" : ""}` }, [el("span", { class: "source-n", text: String(source.n) }), el("div", { class: "source-body" }, body), ...actions]);
  card.dataset.n = String(source.n);
  return card;
}

// Which answers' source folds are open, so a re-render (every streamed piece, every click) keeps them.
const openSourceFolds = new Set();

// A chip's tooltip: which section, on which page, and what a click does.
function citeTitle(source, tab, action) {
  const where = [isHere(source, tab) ? null : source.pageTitle, source.heading].filter(Boolean).join(" › ");
  const does = action ? ` · click: ${action.label.toLowerCase()}` : "";
  return `${source.n}. ${where || "Source"}${does}`;
}

// A quote's short form: its first words, then "…". Shown as a link; clicking highlights it on the page.
const QUOTE_WORDS = 14;
function shortQuote(text) {
  // Footnote markers ("style.[4]") are dropped from what's shown; the full text, used to find the
  // quote on the page, keeps them.
  const words = text.replace(/\[(?:\d+|[a-z]{1,2})\]/gi, "").replace(/\s+/g, " ").trim().split(" ");
  return words.length > QUOTE_WORDS ? `${words.slice(0, QUOTE_WORDS).join(" ")}…` : words.join(" ");
}

// The quote as a link-styled button: highlights the text on its page (opening the page if needed),
// and clears it on a second click, like a citation.
function quoteLink(quote, key, tab, handlers, activeKey) {
  const pageUrl = quote.pageUrl ?? tab?.url ?? null;
  // Google Docs draws its text on a canvas, so a quote from one can't be highlighted: plain text.
  if (/^https:\/\/docs\.google\.com\/document\//.test(pageUrl ?? "")) {
    return el("span", { class: "quote-link plain", text: `“${shortQuote(quote.text)}”`, title: "From a Google Doc: it can't be highlighted on the page" });
  }
  const source = { n: 0, selection: true, highlightable: true, quote: quote.text, pageUrl, pageTitle: quote.pageTitle ?? null };
  const active = activeKey === key;
  const action = citationAction(source, tab, active);
  const button = el("button", { type: "button", class: `quote-link${active ? " active" : ""}`, text: `“${shortQuote(quote.text)}”`, title: action ? `${action.label}` : "Selected text" });
  if (action && handlers.onCitation) button.addEventListener("click", () => handlers.onCitation(key, source, action));
  return button;
}

// question: the user message this answers (for Ask anyway); last: the newest message in the log.
function chatMessage(message, tab, handlers, { question = null, last = false, activeKey = null } = {}) {
  if (message.role === "user") {
    const kids = [];
    if (message.quote?.text) kids.push(quoteLink(message.quote, `${message.createdAt ?? "pending"}:quote`, tab, handlers, activeKey));
    kids.push(el("p", { text: message.content }));
    return el("div", { class: "msg user" }, kids);
  }
  const node = el("div", { class: "msg assistant" });
  const messageKey = message.createdAt ?? "pending";
  // An [n] chip goes straight to the page (user, 2026-11-07): it highlights the source there, opening
  // or focusing its page if it's another one, and a second click clears it.
  const onCite = (n) => {
    const source = message.citedSections?.find((s) => s.n === n);
    const action = source && !message.pending && citationAction(source, tab, activeKey === `${messageKey}:${n}`);
    if (action) handlers.onCitation(`${messageKey}:${n}`, source, action);
  };
  const unsupported = message.grounding?.verdict === "partly" ? new Set(message.grounding.unsupported.map((s) => sentenceKey(s.text))) : null;
  if (message.pending && !message.content) node.append(el("p", { class: "muted typing", text: message.status ?? "Thinking…" }));
  else node.append(answerBody(message.content, onCite, new Set((message.citedSections ?? []).map((s) => s.n)), unsupported));
  const markChips = () => {
    for (const chip of node.querySelectorAll(".cite")) {
      const n = Number(chip.textContent);
      const source = message.citedSections?.find((s) => s.n === n);
      chip.classList.toggle("active", activeKey === `${messageKey}:${n}`);
      if (source) chip.title = citeTitle(source, tab, citationAction(source, tab, activeKey === `${messageKey}:${n}`));
    }
  };
  markChips();
  if (message.pending && message.checking) node.append(el("p", { class: "muted typing small", text: "Checking the answer against the sources…" }));
  if (message.error) node.append(el("p", { class: "msg-error", text: message.error }));

  // E2 (phase 8): on an answer the pages don't cover, search the web in a new tab. Nothing is sent
  // anywhere until it's clicked.
  const webButton = () =>
    message.webQuery && handlers.onWebSearch
      ? el("button", { type: "button", class: "link small web-search", text: "Search the web", title: `Opens a search for: ${message.webQuery}`, onclick: () => handlers.onWebSearch(message.webQuery) })
      : null;

  // Hallucination control (lib/grounding.js), said plainly under the answer.
  if (message.explainGated) {
    // Explain mode's gate: no Ask anyway, which would let any question through with general knowledge.
    const kids = [el("span", { text: "With text selected, questions have to be about that text, so the model wasn't asked. Clear the selection to ask about the pages." })];
    const web = webButton();
    if (web) kids.push(web);
    node.append(el("div", { class: "grounding-note" }, kids));
  } else if (message.gated) {
    const kids = [el("span", { text: "No part of the pages is close to this question, so the model wasn't asked." })];
    if (last && question && handlers.onAskAnyway) kids.push(el("button", { type: "button", class: "link small", text: "Ask anyway", onclick: () => handlers.onAskAnyway(question) }));
    const web = webButton();
    if (web) kids.push(web);
    node.append(el("div", { class: "grounding-note" }, kids));
  } else if (message.notCovered && webButton()) {
    node.append(el("div", { class: "web-row" }, [webButton()]));
  }
  if (message.rejected) {
    node.append(
      el("details", { class: "rejected" }, [
        el("summary", { text: message.drifted ? "The model's answer wasn't about your selection" : "The model answered, but none of it is in the sources" }),
        el("p", { class: "muted small", text: "Probably from its own memory, possibly wrong. Hidden for that reason:" }),
        el("p", { class: "rejected-text", text: message.rejected }),
      ])
    );
  } else if (unsupported) {
    const n = message.grounding.unsupported.length;
    node.append(el("div", { class: "grounding-note" }, [el("span", { text: `${n} sentence${n === 1 ? "" : "s"} not found in the sources (underlined). Check before relying on ${n === 1 ? "it" : "them"}.` })]));
  }

  const notes = [];
  if (message.mode === "selection") notes.push(message.explainGated ? "From your selection" : "From your selection · explained");
  if (message.stopped) notes.push(message.cutOff ? "Cut off: the model stopped responding" : "Stopped");
  const label = modelLabel(message);
  if (label) notes.push(`${label}${FALLBACK_TEXT[message.fallback] ? ` (${FALLBACK_TEXT[message.fallback]})` : ""}`);
  if (notes.length) node.append(el("div", { class: "msg-meta", text: notes.join(" · ") }));

  // The sources, folded and closed by default (user, 2026-11-07): the [n] chips go straight to the
  // page; the cards are there when wanted. An answer with no [n] (small models), or a "not covered"
  // from the model, lists the sections it was given.
  if (message.citedSections?.length && !message.pending) {
    const n = message.citedSections.length;
    const label = message.uncited ? `Sources it was given (${n}), not cited` : `Sources (${n})`;
    const fold = el("details", { class: "source-fold" }, [
      el("summary", { text: label }),
      el("ol", { class: "sources" }, message.citedSections.map((src) => sourceCard(src, tab, handlers, { messageKey, activeKey }))),
    ]);
    fold.open = openSourceFolds.has(messageKey);
    fold.addEventListener("toggle", () => (fold.open ? openSourceFolds.add(messageKey) : openSourceFolds.delete(messageKey)));
    node.append(fold);
  }
  return node;
}

/**
 * @param {{pending, failed}} live  the answer in progress, or the last one that failed (not saved);
 *   each {threadId, question, text, mode, status, error} or null (panel.js)
 */
// The quote waiting above the composer, for the active tab only.
function renderComposerQuote(quote, tab, dom, handlers, activeKey) {
  const box = dom.chatQuote;
  if (!quote || quote.tabId !== tab?.tabId) {
    box.hidden = true;
    return box.replaceChildren();
  }
  box.hidden = false;
  const remove = el("button", { type: "button", class: "icon quote-remove", onclick: handlers.onRemoveQuote });
  setIcon(remove, "close", "Remove the selected text");
  box.replaceChildren(el("span", { class: "quote-label", text: "About" }), quoteLink({ text: quote.text, pageUrl: tab?.url }, "composer:quote", tab, handlers, activeKey), remove);
}

function renderChat(state, { pending, failed, activeCitation, confirmingClear, quote }, dom, handlers) {
  const tab = activeTab(state);
  const { thread } = threadView(state);
  const chatThread = tab?.threadId ? thread : null; // detached: a new thread starts on the next scan
  const busy = Boolean(pending);
  const canAsk = Boolean(chatThread) && !busy;

  // Before anything that returns early (an empty chat still shows an attached quote).
  renderComposerQuote(quote, tab ? { ...tab, tabId: state.activeTabId } : null, dom, handlers, activeCitation?.key ?? null);
  dom.chatInput.disabled = !chatThread;
  dom.chatSend.disabled = !canAsk;
  dom.chatSend.hidden = busy;
  dom.chatStop.hidden = !busy;
  dom.chatInput.placeholder = chatThread ? `Ask about ${chatThread.pages.length > 1 ? "this thread's pages" : "this page"}…` : "Scan this page to start chatting";

  // Clear chat: in the chat's header, shown only when there's a conversation and no answer running.
  document.getElementById("chat-head").hidden = !chatThread?.messages?.length || busy;
  dom.chatClear.classList.toggle("confirm", Boolean(confirmingClear));
  dom.chatClear.replaceChildren(icon("erase", 13), document.createTextNode(confirmingClear ? "Click again to clear" : "Clear"));
  dom.chatClear.title = confirmingClear ? "Deletes this thread's conversation; its pages stay" : "Clear chat (the thread's pages stay)";

  const nearBottom = dom.chatLog.scrollHeight - dom.chatLog.scrollTop - dom.chatLog.clientHeight < 40;
  let messages = [...(chatThread?.messages ?? [])];
  // Ask anyway replaces the gated turn it came from: hide that turn while the new answer runs.
  if (pending?.force && messages.at(-1)?.gated && messages.at(-2)?.content === pending.question) messages = messages.slice(0, -2);
  const shown = pending ?? failed;
  if (shown && shown.threadId === chatThread?.id) {
    messages.push({ role: "user", content: shown.question, ...(shown.quote && { quote: shown.quote }) });
    messages.push({ role: "assistant", content: shown.text, pending: Boolean(pending), checking: shown.checking, status: shown.status, error: shown.error, mode: shown.mode });
  }
  if (!messages.length) {
    dom.chatLog.replaceChildren(
      el("p", { class: "muted chat-empty", text: chatThread ? "Ask anything about the pages in this thread. Answers cite their sources." : "Chat starts once this page is scanned." })
    );
    return;
  }
  const askAnyway = busy ? {} : handlers; // no Ask anyway while an answer is running
  dom.chatLog.replaceChildren(
    ...messages.map((m, i) => chatMessage(m, tab, m.role === "assistant" ? askAnyway : handlers, { question: messages[i - 1]?.role === "user" ? messages[i - 1].content : null, last: i === messages.length - 1, activeKey: activeCitation?.key ?? null }))
  );
  if (nearBottom || pending) dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
}

// Hover card for the thread name: every page in the thread, so it always matches the page count
// (user, 2026-11-07). Pages you visited, in the order they joined, joined by arrows: up to this one
// as the path, the ones added after it muted under "Later in this thread". A page continuing the
// thread but not scanned yet hangs off the path on a dashed arrow. Pages added from the link
// picklist (phase 9) are listed apart, since you didn't travel through them. Shown on hover and on
// keyboard focus (CSS), when the thread has two or more pages.
function threadTrail(thread, tab, mode) {
  const isHere = (p) => mode === "in" && Boolean(tab?.url) && normalizeUrl(p.url) === normalizeUrl(tab.url);
  const visited = thread.pages.filter((p) => !p.crawled);
  const linked = thread.pages.filter((p) => p.crawled);
  const hereAt = visited.findIndex(isHere);
  const path = (hereAt === -1 ? visited : visited.slice(0, hereAt + 1)).map((p) => ({ title: p.title || p.url, here: isHere(p), pending: false }));
  if (mode === "continued") path.push({ title: tab?.title || "This page", here: true, pending: true });
  const later = hereAt === -1 ? [] : visited.slice(hereAt + 1);
  if (path.length + later.length + linked.length < 2) return null; // one page: nothing to show

  const step = (title, cls, tag) =>
    el("li", { class: `trail-step${cls}` }, [el("span", { class: "trail-dot" }), el("span", { class: "trail-label" }, [el("span", { class: "trail-title", text: title }), ...(tag ? [el("span", { class: "trail-tag", text: tag })] : [])])]);
  const arrow = (cls = "") => el("li", { class: `trail-arrow${cls}`, ariaHidden: "true" }, [icon("arrowDown", 14)]);

  const items = [];
  path.forEach((p, i) => {
    if (i > 0) items.push(arrow(p.pending ? " pending" : ""));
    items.push(step(p.title, `${p.here ? " here" : ""}${p.pending ? " pending" : ""}`, p.here ? (p.pending ? "this page · not scanned yet" : "this page") : null));
  });
  const groups = [el("ol", { class: "trail" }, items)];
  if (later.length) {
    const laterItems = [];
    later.forEach((p, i) => {
      if (i > 0) laterItems.push(arrow(" later"));
      laterItems.push(step(p.title || p.url, " later", null));
    });
    groups.push(el("div", { class: "trail-group", text: "Later in this thread" }), el("ol", { class: "trail" }, laterItems));
  }
  if (linked.length) {
    groups.push(
      el("div", { class: "trail-group", text: "Added from links" }),
      el("ul", { class: "trail linked" }, linked.map((p) => step(p.title || p.url, " later", p.linkedFrom?.title ? `linked from ${p.linkedFrom.title}` : null)))
    );
  }
  return el("div", { class: "thread-pop", role: "tooltip" }, [el("div", { class: "pop-head", text: `Pages in this thread (${thread.pages.length})` }), ...groups]);
}

// G2 (revised 2026-11-06, user): no picker. The tab's thread shows only when there is one:
// "Continuing <name>" with × while this page isn't in it yet, or the name as a heading once it is.
function renderThreadRow(state, dom, { onDetachThread, onDeleteThread }, { confirmingDelete }) {
  const { mode, thread } = threadView(state);
  const tab = activeTab(state);
  const busy = tab?.status === "scanning";
  dom.threadRow.hidden = mode === "none" || mode === "detached";
  if (dom.threadRow.hidden) return dom.threadRow.replaceChildren();

  const pages = `${thread.pages.length} page${thread.pages.length === 1 ? "" : "s"}`;
  // Icon, name and count are one hover target; the trail card opens below it.
  const name =
    mode === "continued"
      ? el("span", { class: "thread-name continued" }, [el("span", { class: "muted", text: "Continuing " }), el("strong", { text: thread.title })])
      : el("h2", { class: "thread-name", text: thread.title });
  const trail = threadTrail(thread, tab, mode);
  const hover = el("span", { class: `thread-hover${trail ? " has-trail" : ""}`, ...(trail ? { tabIndex: 0 } : {}) }, [
    el("span", { class: "thread-icon" }, [icon(mode === "continued" ? "continues" : "pages", 14)]),
    name,
    // The count is the thread's saved pages: this page joins it (and the count) once its scan is done.
    el("span", { class: `thread-count${thread.pages.length > SOFT_CAP ? " over-cap" : ""}`, text: pages, ...(thread.pages.length > SOFT_CAP ? { title: `More than ${SOFT_CAP} pages: answers draw on more pages and citations get harder to follow` } : {}) }),
    ...(trail ? [trail] : []),
  ]);
  hover.setAttribute("aria-label", `${mode === "continued" ? "Continuing" : "Thread"} ${thread.title}, ${pages}`);
  const nodes = [hover];

  if (mode === "continued") {
    const close = el("button", { type: "button", class: "icon", disabled: busy, onclick: onDetachThread });
    setIcon(close, "close", `Don't continue "${thread.title}": scan this page into a new thread`);
    nodes.push(close);
  } else {
    const del = el("button", { type: "button", class: confirmingDelete ? "icon danger" : "icon", disabled: busy, onclick: onDeleteThread });
    setIcon(del, "trash", confirmingDelete ? "Click again to delete this thread and its saved scans" : "Delete this thread");
    if (confirmingDelete) del.append(el("span", { class: "small", text: "Delete?" }));
    nodes.push(del);
  }
  dom.threadRow.replaceChildren(...nodes);
}

function renderHeader(state, dom, handlers) {
  const tab = activeTab(state);
  const controls = scanControls(state);
  // × was pressed: only a reattach button, and only while that thread still exists.
  const view = threadView(state);
  dom.reattachThread.hidden = view.mode !== "detached" || tab?.status === "scanning";
  if (view.mode === "detached") setIcon(dom.reattachThread, "link", `Continue "${view.thread.title}" on this page`);
  dom.tabTitle.textContent = tab ? tab.title || "This tab" : "No tab";
  dom.status.textContent = tab ? statusText(tab, controls.savedIn) : "";
  dom.status.dataset.state = tab?.status ?? "none"; // theme.css: the coloured dot before the status
  dom.startScan.hidden = !controls.start;
  dom.startScan.disabled = !tab || tab.status === "scanning";
  dom.rescan.hidden = !controls.rescan;
  dom.rescan.disabled = tab?.relabeling ?? false;

  const genNodes = genRowNodes(tab, handlers);
  dom.genRow.hidden = genNodes.length === 0;
  dom.genRow.replaceChildren(...genNodes);

  const banner = tab && bannerFor(tab, handlers);
  dom.banner.hidden = !banner;
  dom.banner.className = banner?.kind === "error" ? "banner error" : "banner";
  dom.banner.replaceChildren(...(banner?.nodes ?? []));
}
