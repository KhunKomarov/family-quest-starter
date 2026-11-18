(() => {
  "use strict";
  // Draw our own coin: older Android fonts may not contain the coin emoji.
  const ns = "http://www.w3.org/2000/svg";
  function coin() {
    const svg = document.createElementNS(ns, "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: "1em", height: "1em", role: "img", "aria-label": "монет", class: "quest-coin", focusable: "false" })) svg.setAttribute(key, value);
    for (const [tag, attrs] of [
      ["circle", { cx: 12, cy: 12, r: 10, fill: "#f8c74b", stroke: "#a9660d", "stroke-width": 1.7 }],
      ["circle", { cx: 12, cy: 12, r: 7, fill: "none", stroke: "#fff0a8", "stroke-width": 1.5 }],
      ["path", { d: "M12 6.5 13.7 10l3.8.5-2.7 2.7.6 3.8-3.4-1.8L8.6 17l.6-3.8-2.7-2.7 3.8-.5Z", fill: "#b97613" }]
    ]) {
      const part = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) part.setAttribute(key, value);
      svg.appendChild(part);
    }
    return svg;
  }
  function decorate(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.parentElement || node.parentElement.closest("script, style, textarea, svg, [contenteditable]")) return;
      const parts = node.data.split(/฿|жет\./g);
      if (parts.length === 1) return;
      const fragment = document.createDocumentFragment();
      parts.forEach((part, index) => { if (index) fragment.appendChild(coin()); fragment.appendChild(document.createTextNode(part)); });
      node.replaceWith(fragment);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      Array.from(node.childNodes).forEach(decorate);
    }
  }
  function start() {
    decorate(document.body);
    new MutationObserver(records => records.forEach(record => {
      if (record.type === "characterData") decorate(record.target);
      else record.addedNodes.forEach(decorate);
    })).observe(document.body, { childList: true, characterData: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
