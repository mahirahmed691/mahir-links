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
