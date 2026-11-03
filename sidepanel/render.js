// Panel state → DOM. Page-derived text is untrusted and the panel runs with extension privileges,
// so everything is built with createElement/textContent — never innerHTML.

const STAGE_TEXT = {
  starting: () => "Starting…",
  extracting: () => "Reading the page…",
  sectioning: () => "Finding topic breaks…",
  sectioned: (tab) => `Found ${tab.sections.length} sections`,
  labelling: (tab) => `Embedding ${tab.detail?.sections ?? ""} sections and writing headings…`,
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

function statusText(tab) {
  switch (tab.status) {
    case "idle":
      return "Not scanned yet";
    case "scanning":
      return (STAGE_TEXT[tab.stage] ?? (() => "Scanning…"))(tab);
    case "ready":
      return `${tab.sections.length} sections ready`;
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
  if (tab.status === "ready" && tab.detail?.b3Skipped === "no-key") {
    return {
      kind: "warn",
      nodes: [
        el("p", {}, [
          "No Gemini key set, so headings and summaries were skipped. ",
          el("button", { type: "button", class: "link", text: "Add a key in ⚙", onclick: onOpenSettings }),
        ]),
      ],
    };
  }
  if (tab.status === "ready" && tab.detail?.b3Errors > 0) {
    return { kind: "warn", nodes: [el("p", { text: "Some headings and summaries couldn't be generated. The service-worker console has the details." })] };
  }
  return null;
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
  return el("article", { class: "card" }, kids);
}

// Live highlight where the text is anchored; Google Docs jump through the outline; else snippet only.
function showAction(section) {
  if (section.blocks?.some((b) => b.anchored)) return "Show on page";
  if (section.jump) return "Jump to section";
  return null;
}

function idleHint(tab) {
  if (!tab) return "Open a tab to scan it.";
  if (tab.status === "idle") return "Press Start scan to read this page into sections.";
  if (tab.status === "scanning") return "Reading the page…";
  return "";
}

// Re-renders the cards only when the tab or its sections array changed, so open <details> and the
// scroll position survive status-line updates. The reducer replaces the array on every real change.
function renderReadingView(tabId, tab, container, handlers) {
  const sections = tab?.sections ?? null;
  if (sections && container.__rendered?.tabId === tabId && container.__rendered.sections === sections) return;
  container.__rendered = { tabId, sections };

  if (!sections) {
    const hint = idleHint(tab);
    container.replaceChildren(...(hint ? [el("p", { class: "muted", text: hint })] : []));
    return;
  }
  // Show/jump read the saved scan, which only exists once the scan is done.
  container.replaceChildren(...sections.map((s, i) => sectionCard(s, i, handlers, tab.status === "ready")));
}

// Decision 2: find-sections results — score, heading, best-chunk snippet, and a show/jump action.
function renderFindResults(result, container, { onShowSection }) {
  if (!result) return container.replaceChildren();
  if (result.pending) return container.replaceChildren(el("p", { class: "muted", text: "Searching…" }));
  if (!result.ok) return container.replaceChildren(el("p", { class: "muted", text: result.error }));
  if (!result.hits.length) return container.replaceChildren(el("p", { class: "muted", text: "No sections found." }));

  container.replaceChildren(
    ...result.hits.map((hit) => {
      const kids = [];
      if (hit.headingPath?.length) kids.push(el("div", { class: "breadcrumb", text: hit.headingPath.join(" › ") }));
      kids.push(
        el("div", { class: "hit-head" }, [el("span", { class: "text", text: hit.heading ?? "Untitled section" }), el("span", { class: "score", text: hit.score.toFixed(3) })])
      );
      kids.push(el("p", { class: "snippet", text: hit.snippet }));
      const label = hit.action === "highlight" ? "Show on page" : hit.action === "jump" ? "Jump to section" : null;
      kids.push(
        label
          ? el("div", { class: "card-actions" }, [el("button", { type: "button", class: "link", text: label, onclick: () => onShowSection(hit.index) })])
          : el("div", { class: "card-actions muted", text: "Snippet only" })
      );
      return el("div", { class: "hit" }, kids);
    })
  );
}

function renderHeader(tab, dom, handlers) {
  dom.tabTitle.textContent = tab ? tab.title || "This tab" : "No tab";
  dom.status.textContent = tab ? statusText(tab) : "";
  dom.startScan.disabled = !tab || tab.status === "scanning";
  dom.findInput.disabled = dom.findSubmit.disabled = tab?.status !== "ready" || !tab.corpusId;

  const banner = tab && bannerFor(tab, handlers);
  dom.banner.hidden = !banner;
  dom.banner.className = banner?.kind === "error" ? "banner error" : "banner";
  dom.banner.replaceChildren(...(banner?.nodes ?? []));
}
