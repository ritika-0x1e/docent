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
        el("p", { text: "Summarizer doesn't have access to this site yet." }),
        el("p", { text: "Allow it once for all sites, or click the Summarizer icon in the toolbar to allow just this tab." }),
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
  "no-gemini-key": "no Gemini key set",
};

// B3 on demand: a scan never calls the LLM. Shown on a ready tab while any section lacks a summary,
// plus a note on which model did the last run.
function genRowNodes(tab, { onGenerateHeadings, onStopGenerating }) {
  if (tab?.status !== "ready" || !tab.sections?.length) return [];
  const done = tab.sections.filter((s) => s.summary !== null).length;
  const nodes = [];
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
// matched the way the check split them: per line, at sentence ends, without bullets, bold or numbering.
const SENTENCE_END = /(?<=[.!?](?:\*\*)?)\s+(?=(?:\*\*)?[A-Z0-9"“(])/;
const sentenceKey = (segment) => segment.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/\*\*/g, "").trim();

function lineNodes(line, onCite, valid, unsupported) {
  if (!unsupported?.size) return inlineNodes(line, onCite, valid);
  const nodes = [];
  line.split(SENTENCE_END).forEach((segment, i) => {
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

// A cited section: number, page badge when it's from another page, heading, snippet, and Show on page
// when it's from this tab's scan (F2 adds "open page and highlight" for the others in phase 7).
function sourceCard(source, tab, { onShowSection }) {
  const here = tab?.status === "ready" && tab.corpusId === source.corpusId;
  const live = here ? tab.sections?.[source.order] : null;
  const action = live && showAction(live);
  const kids = [el("span", { class: "source-n", text: String(source.n) })];
  const body = [];
  if (!here && source.pageTitle) body.push(el("div", { class: "page-badge", text: source.pageTitle, title: source.pageUrl ?? source.pageTitle }));
  body.push(el("div", { class: "source-heading", text: source.heading ?? "Untitled section" }));
  if (source.snippet) body.push(el("p", { class: "snippet", text: source.snippet }));
  if (action) body.push(el("button", { type: "button", class: "link small", text: action, onclick: () => onShowSection(source.order) }));
  kids.push(el("div", { class: "source-body" }, body));
  const card = el("li", { class: "source" }, kids);
  card.dataset.n = String(source.n);
  return card;
}

// question: the user message this answers (for Ask anyway); last: the newest message in the log.
function chatMessage(message, tab, handlers, { question = null, last = false } = {}) {
  if (message.role === "user") return el("div", { class: "msg user" }, [el("p", { text: message.content })]);
  const node = el("div", { class: "msg assistant" });
  const onCite = (n) => {
    const card = node.querySelector(`.source[data-n="${n}"]`);
    if (!card) return;
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    card.classList.remove("flash");
    void card.offsetWidth; // restart the animation
    card.classList.add("flash");
  };
  const unsupported = message.grounding?.verdict === "partly" ? new Set(message.grounding.unsupported.map((s) => sentenceKey(s.text))) : null;
  if (message.pending && !message.content) node.append(el("p", { class: "muted typing", text: message.status ?? "Thinking…" }));
  else node.append(answerBody(message.content, onCite, new Set((message.citedSections ?? []).map((s) => s.n)), unsupported));
  if (message.pending && message.checking) node.append(el("p", { class: "muted typing small", text: "Checking the answer against the sources…" }));
  if (message.error) node.append(el("p", { class: "msg-error", text: message.error }));

  // Hallucination control (lib/grounding.js), said plainly under the answer.
  if (message.gated) {
    const kids = [el("span", { text: "No part of the pages is close to this question, so the model wasn't asked." })];
    if (last && question && handlers.onAskAnyway) kids.push(el("button", { type: "button", class: "link small", text: "Ask anyway", onclick: () => handlers.onAskAnyway(question) }));
    node.append(el("div", { class: "grounding-note" }, kids));
  } else if (message.rejected) {
    node.append(
      el("details", { class: "rejected" }, [
        el("summary", { text: "The model answered, but none of it is in the sources" }),
        el("p", { class: "muted small", text: "Probably from its own memory, possibly wrong. Hidden for that reason:" }),
        el("p", { class: "rejected-text", text: message.rejected }),
      ])
    );
  } else if (unsupported) {
    const n = message.grounding.unsupported.length;
    node.append(el("div", { class: "grounding-note" }, [el("span", { text: `${n} sentence${n === 1 ? "" : "s"} not found in the sources (underlined). Check before relying on ${n === 1 ? "it" : "them"}.` })]));
  }

  const notes = [];
  if (message.mode === "selection") notes.push("From your selection");
  if (message.stopped) notes.push("Stopped");
  const label = modelLabel(message);
  if (label) notes.push(`${label}${FALLBACK_TEXT[message.fallback] ? ` (${FALLBACK_TEXT[message.fallback]})` : ""}`);
  if (notes.length) node.append(el("div", { class: "msg-meta", text: notes.join(" · ") }));

  if (message.citedSections?.length) {
    const cards = el("ol", { class: "sources" }, message.citedSections.map((s) => sourceCard(s, tab, handlers)));
    // No [n] in the answer (small local models often skip them): the sections it was given, folded.
    if (message.uncited) {
      node.append(el("details", { class: "uncited", title: "The answer didn't cite its sources" }, [el("summary", { text: `Sources it was given (${message.citedSections.length}), not cited` }), cards]));
    } else node.append(cards);
  }
  return node;
}

/**
 * @param {{pending, failed}} live  the answer in progress, or the last one that failed (not saved);
 *   each {threadId, question, text, mode, status, error} or null (panel.js)
 */
function renderChat(state, { pending, failed }, dom, handlers) {
  const tab = activeTab(state);
  const { thread } = threadView(state);
  const chatThread = tab?.threadId ? thread : null; // detached: a new thread starts on the next scan
  const busy = Boolean(pending);
  const canAsk = Boolean(chatThread) && !busy;

  dom.chatInput.disabled = !chatThread;
  dom.chatSend.disabled = !canAsk;
  dom.chatSend.hidden = busy;
  dom.chatStop.hidden = !busy;
  dom.chatInput.placeholder = chatThread ? `Ask about ${chatThread.pages.length > 1 ? "this thread's pages" : "this page"}…` : "Scan this page to start chatting";

  const nearBottom = dom.chatLog.scrollHeight - dom.chatLog.scrollTop - dom.chatLog.clientHeight < 40;
  let messages = [...(chatThread?.messages ?? [])];
  // Ask anyway replaces the gated turn it came from: hide that turn while the new answer runs.
  if (pending?.force && messages.at(-1)?.gated && messages.at(-2)?.content === pending.question) messages = messages.slice(0, -2);
  const shown = pending ?? failed;
  if (shown && shown.threadId === chatThread?.id) {
    messages.push({ role: "user", content: shown.question });
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
    ...messages.map((m, i) => chatMessage(m, tab, m.role === "assistant" ? askAnyway : handlers, { question: messages[i - 1]?.role === "user" ? messages[i - 1].content : null, last: i === messages.length - 1 }))
  );
  if (nearBottom || pending) dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
}

// Hover card for the thread name: the path to this page, i.e. the thread's pages in the order they
// joined, up to and including this one (pages that joined after it aren't shown; user, 2026-11-07),
// each arrow leading to the next. A page that's continuing the thread but isn't scanned yet hangs
// off the end on a dashed arrow. Only scanned pages are in a thread (user, 2026-11-07);
// pages passed through unscanned aren't kept. Shown on hover and on keyboard focus (CSS).
function threadTrail(thread, tab, mode) {
  let steps = thread.pages.map((p) => ({
    title: p.title || p.url,
    here: mode === "in" && Boolean(tab?.url) && normalizeUrl(p.url) === normalizeUrl(tab.url),
    pending: false,
  }));
  const here = steps.findIndex((step) => step.here);
  if (here !== -1) steps = steps.slice(0, here + 1); // URL unknown (no access yet): the whole thread
  if (mode === "continued") steps.push({ title: tab?.title || "This page", here: true, pending: true });

  const items = [];
  steps.forEach((step, i) => {
    if (i > 0) items.push(el("li", { class: `trail-arrow${step.pending ? " pending" : ""}`, ariaHidden: "true" }, [icon("arrowDown", 14)]));
    const label = [el("span", { class: "trail-title", text: step.title })];
    if (step.here) label.push(el("span", { class: "trail-tag", text: step.pending ? "this page · not scanned yet" : "this page" }));
    items.push(el("li", { class: `trail-step${step.here ? " here" : ""}${step.pending ? " pending" : ""}` }, [el("span", { class: "trail-dot" }), el("span", { class: "trail-label" }, label)]));
  });

  return el("div", { class: "thread-pop", role: "tooltip" }, [
    el("div", { class: "pop-head", text: steps.some((step) => step.here) ? "Path to this page" : "Pages in this thread" }),
    el("ol", { class: "trail" }, items),
  ]);
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
  const hover = el("span", { class: "thread-hover", tabIndex: 0 }, [
    el("span", { class: "thread-icon" }, [icon(mode === "continued" ? "continues" : "pages", 14)]),
    name,
    // The count is the thread's saved pages: this page joins it (and the count) once its scan is done.
    el("span", { class: "thread-count", text: pages }),
    threadTrail(thread, tab, mode),
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
