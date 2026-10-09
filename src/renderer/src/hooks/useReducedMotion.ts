import { useSyncExternalStore } from "react";

// the class useMotionPreference stamps on :root is the one source of truth (the app's Motion
// setting resolved against the OS preference); this follows it as it changes
const read = (): boolean => document.documentElement.classList.contains("reduce-motion");
const subscribe = (changed: () => void): (() => void) => {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
};

/** Whether motion is reduced, for a component that must render differently under it. */
export const useReducedMotion = (): boolean => useSyncExternalStore(subscribe, read);
