// The browser floor for Display on other screens: the page's styles need what Safari 16.4 and
// Chrome 111 brought (color-mix, cascade layers, nesting). Below that the page would be blank, so
// this plain script, run before the page, says so instead. No module syntax, nothing newer.
(function () {
  var ok =
    typeof CSS !== "undefined" &&
    CSS.supports &&
    CSS.supports("color", "color-mix(in srgb, red, blue)") &&
    CSS.supports("selector(&)") &&
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
