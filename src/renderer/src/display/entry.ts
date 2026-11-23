// THE PAGE A SCREEN ON THE NETWORK OPENS (0.17.0): the web bridge goes in first, so the app's
// modules, which read window.tastytunes as they load, find it; then the page itself.
import { webBridge } from "./webBridge";

window.tastytunes = webBridge();
void import("./page");
