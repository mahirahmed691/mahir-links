function textOf(id) {
  const el = document.getElementById(id);
  return el ? el.innerText.replace(/\s+\n/g, "\n").trim() : "";
}

function selectText(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

async function copyFrom(id) {
  const el = document.getElementById(id);
  const text = textOf(id);
  if (!el || !text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    selectText(el);
    return false;
  }
}

document.querySelectorAll("[data-copy]").forEach((button) => {
  const label = button.textContent;
  button.addEventListener("click", async () => {
    const ok = await copyFrom(button.getAttribute("data-copy"));
    button.textContent = ok ? "Copied" : "Select the text";
    setTimeout(() => { button.textContent = label; }, 1600);
  });
});

document.querySelectorAll("[data-print]").forEach((button) => {
  button.addEventListener("click", () => window.print());
});

document.querySelectorAll("[data-filter]").forEach((input) => {
  const list = input.closest("section")?.querySelector(".rank");
  const empty = input.closest("section")?.querySelector("[data-filter-empty]");
  if (!list) return;
  input.addEventListener("input", () => {
    const query = input.value.trim().toLowerCase();
    let shown = 0;
    list.querySelectorAll("li").forEach((item) => {
      const name = item.querySelector(".rank-name")?.textContent.toLowerCase() || "";
      const hide = query.length > 0 && !name.includes(query);
      item.hidden = hide;
      if (!hide) shown += 1;
    });
    if (empty) empty.hidden = shown > 0;
  });
});

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  const range = { t: "today", "7": "7d", "3": "30d" }[event.key];
  if (!range) return;
  const link = document.querySelector(`nav[aria-label="Date range"] a[href*="range=${range}"]`);
  if (link) window.location.href = link.href;
});
