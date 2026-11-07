// Light / dark for the panel (user, 2026-11-07). The sun/moon button beside ⚙ picks one and it's
// remembered; until then the panel follows the system's mode, live. The result is a data-theme
// attribute on <html>, which panel.css's dark tokens key off. Loaded in <head>, before the page
// paints, so it never flashes the wrong theme. The choice is a per-browser convenience, so it lives
// in localStorage (read synchronously here); if storage is blocked, the system's mode is used.

const THEME_KEY = "docent.theme"; // "light" | "dark" | absent (follow the system)
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function savedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function currentTheme() {
  return savedTheme() ?? (systemDark.matches ? "dark" : "light");
}

function applyTheme() {
  document.documentElement.dataset.theme = currentTheme();
}

// The button: switches to the other theme and remembers it.
function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* not remembered; still applied below */
  }
  document.documentElement.dataset.theme = next;
  return next;
}

applyTheme();
systemDark.addEventListener("change", () => savedTheme() || applyTheme());
