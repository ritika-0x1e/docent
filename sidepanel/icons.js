// Small stroke icons for the panel's icon buttons, built as SVG nodes (never innerHTML).
// 24×24 viewBox, drawn in currentColor so they follow the button's colour in light and dark.

const ICON_PATHS = {
  close: ["M6 6l12 12", "M18 6L6 18"],
  link: ["M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5", "M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"],
  trash: ["M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"],
  rescan: ["M20 11a8 8 0 1 0-2.2 6.5", "M20 4v7h-7"],
  // Labels, not actions: drawn muted beside the thread name.
  continues: ["M6 4v7a4 4 0 0 0 4 4h9", "M15 11l4 4-4 4"], // this page continues a thread
  pages: ["M8 3h10v14", "M5 7h10v14H5z"], // the thread's saved pages
  arrowDown: ["M12 4v15", "M6 13l6 6 6-6"],
  send: ["M5 12h14", "M13 6l6 6-6 6"],
  stop: ["M7 7h10v10H7z"],
  settings: [
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  ],
};

const SVG_NS = "http://www.w3.org/2000/svg";

function icon(name, size = 16) {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
    svg.setAttribute(k, String(v));
  }
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// An icon-only button: the label is both the hover tooltip and what a screen reader says.
function setIcon(button, name, label) {
  button.replaceChildren(icon(name));
  if (label) {
    button.title = label;
    button.setAttribute("aria-label", label);
  }
}
