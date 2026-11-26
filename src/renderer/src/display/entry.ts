// THE PAGE A SCREEN ON THE NETWORK OPENS (0.17.0): the web bridge goes in first, so the app's
// modules, which read window.tastytunes as they load, find it; then the page itself. A browser
// below the floor has the guard's notice instead (public/display-guard.js), and no page drawn
// under it. A part of the page that didn't arrive (the network dropped, the app restarted between
// its files) loads again after a wait (display/reload).
import { webBridge } from "./webBridge";
import { reloadSoon, runningCleanly } from "./reload";

const tooOld = document.getElementById("display-old-browser")?.hidden === false;
if (!tooOld) {
  window.tastytunes = webBridge();
  void import("./page").then(runningCleanly, reloadSoon);
}
