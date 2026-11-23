// The browser floor for Display on other screens: the page's built styles use color-mix (Chrome
// 111, Safari 16.2), @property (Safari 16.4) and cascade layers, and no nested rules, so the
// floor is Safari 16.4 and Chrome 111. Below that the page would be blank, so this plain script,
// run before the page, says so instead. No module syntax, nothing newer.
(function () {
  var ok =
    typeof CSS !== "undefined" &&
    CSS.supports &&
    CSS.supports("color", "color-mix(in srgb, red, blue)") &&
    typeof CSSPropertyRule !== "undefined" &&
    typeof CSSLayerBlockRule !== "undefined" &&
    typeof Array.prototype.at === "function";
  if (ok) return;
  var note = document.getElementById("display-old-browser");
  if (!note) return;
  note.hidden = false;
  note.setAttribute(
    "style",
    "font:18px system-ui,sans-serif;color:#ddd;background:#111;position:fixed;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:2em",
  );
  note.textContent =
    "This browser is too old for TastyTunes' display. It needs Safari 16.4, Chrome 111 or newer.";
})();
