// D5 (phase 9) + G4 (phase 10): the linked-pages picklist. It takes the reading view's place after
// "Add linked pages" until the pages are added or it's closed (decision 2). One list, best first:
// the top 20 (lib/links.js allocatePicklist), or, while the filter has text, every harvested link that
// matches. Ticking is the only way anything gets read (D6). Built once per opening; the list and
// footer update in place, so the filter box keeps its focus.

const FILTER_SHOWN_MAX = 60;

function linkPath(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname + u.search).replace(/_/g, " ");
  } catch {
    return url;
  }
}

/**
 * @param {{top, all, from, threadPages}} data  from "panel-links"
 * @param {{onAdd(links), onStop(), onClose()}} actions
 * @returns {{el: HTMLElement, setProgress(progress), setDone(result), setThreadPages(n)}}
 */
function createPicklist(data, actions) {
  const checked = new Map(); // url → link
  let filter = "";
  let busy = false;
  let threadPages = data.threadPages;

  const filterInput = el("input", { type: "search", class: "pick-filter", placeholder: `Filter all ${data.all.length} links on this page…`, ariaLabel: "Filter links" });
  const list = el("ul", { class: "pick-list" });
  const note = el("p", { class: "pick-note", hidden: true });
  const status = el("p", { class: "pick-status muted small", role: "status" });
  const addButton = el("button", { type: "button", class: "primary" });
  const stopButton = el("button", { type: "button", text: "Stop", hidden: true, onclick: () => actions.onStop() });
  const closeButton = el("button", { type: "button", text: "Cancel", onclick: () => actions.onClose() });
  const failures = el("ul", { class: "pick-failures", hidden: true });

  const shown = () => (filter.trim() ? filterLinks(data.all, filter).slice(0, FILTER_SHOWN_MAX) : data.top);

  // A link already in the thread: ticked, disabled, marked "Added".
  function row(link) {
    const box = el("input", { type: "checkbox", disabled: busy || link.inThread });
    box.checked = link.inThread || checked.has(link.url);
    box.addEventListener("change", () => {
      if (box.checked) checked.set(link.url, link);
      else checked.delete(link.url);
      updateFooter();
    });
    const title = [el("span", { class: "pick-text", text: link.anchorText })];
    if (link.inThread) title.push(el("span", { class: "tag added", text: "Added", title: "Already in this thread" }));
    else if (link.sourceType === "nav") title.push(el("span", { class: "tag", text: "nav", title: "From the page's navigation, not the article" }));
    return el("li", { class: link.inThread ? "in-thread" : "" }, [
      el("label", { class: "pick-row" }, [
        box,
        el("span", { class: "pick-body" }, [
          el("span", { class: "pick-title" }, title),
          link.surroundingText ? el("span", { class: "pick-context", text: link.surroundingText }) : null,
          el("span", { class: "pick-url", text: linkPath(link.url) }),
        ].filter(Boolean)),
      ]),
    ]);
  }

  function updateList() {
    const links = shown();
    list.replaceChildren(...(links.length ? links.map(row) : [el("li", { class: "muted small", text: filter.trim() ? "No links match." : "No linked pages found on this page." })]));
  }

  function updateFooter() {
    const n = checked.size;
    addButton.textContent = busy ? "Adding…" : n ? `Add ${n} page${n === 1 ? "" : "s"}` : "Add pages";
    addButton.disabled = busy || !n;
    stopButton.hidden = !busy;
    closeButton.textContent = busy ? "Hide" : "Cancel";
    const cap = n ? softCapNote(threadPages, n) : null; // G4: warn, never block
    note.hidden = !cap;
    note.textContent = cap ?? "";
  }

  filterInput.addEventListener("input", () => {
    filter = filterInput.value;
    updateList();
  });
  addButton.addEventListener("click", () => {
    if (!checked.size) return;
    busy = true;
    failures.hidden = true;
    failures.replaceChildren();
    status.textContent = "Starting…";
    updateList();
    updateFooter();
    actions.onAdd([...checked.values()].map(({ url, anchorText }) => ({ url, anchorText })));
  });

  const root = el("section", { class: "picklist", ariaLabel: "Linked pages" }, [
    el("div", { class: "pick-head" }, [
      el("h2", { text: "Add linked pages" }),
      el("p", { class: "muted small", text: `Links on "${data.from.title}". Only the pages you tick are read and added to this thread; nothing else is opened.` }),
    ]),
    filterInput,
    list,
    el("div", { class: "pick-foot" }, [note, status, failures, el("div", { class: "pick-actions" }, [addButton, stopButton, closeButton])]),
  ]);
  updateList();
  updateFooter();

  return {
    el: root,
    setThreadPages(n) {
      threadPages = n;
      updateFooter();
    },
    setProgress(p) {
      if (p.stage === "page") status.textContent = `Adding ${p.index + 1} of ${p.total}: ${p.anchorText || linkPath(p.url)}…`;
    },
    setDone(result) {
      busy = false;
      if (result.ok) {
        for (const url of [...checked.keys()]) if (!result.failed?.some((f) => f.url === url)) checked.delete(url);
        const parts = [`Added ${result.added} page${result.added === 1 ? "" : "s"} to the thread.`];
        if (result.stopped) parts.push("Stopped; pages already added were kept.");
        if (result.failed?.length) parts.push(`${result.failed.length} couldn't be read:`);
        status.textContent = parts.join(" ");
        failures.hidden = !result.failed?.length;
        failures.replaceChildren(...(result.failed ?? []).map((f) => el("li", {}, [el("strong", { text: f.anchorText || linkPath(f.url) }), document.createTextNode(` · ${f.error}`)])));
        // Added pages stay where they are, now ticked and disabled; failed ones stay ticked to retry.
        const added = new Set((result.thread?.pages ?? []).map((p) => normalizeUrl(p.url)));
        for (const l of [...data.all, ...data.top]) if (added.has(normalizeUrl(l.url))) l.inThread = true;
        if (result.thread) threadPages = result.thread.pages.length;
      } else status.textContent = result.error ?? "Couldn't add the pages.";
      updateList();
      updateFooter();
      closeButton.textContent = "Done";
    },
  };
}
