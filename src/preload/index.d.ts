import type { TastyTunesApi } from "@shared/ipc";

declare global {
  interface Window {
    tastytunes: TastyTunesApi;
  }
}

export {};
