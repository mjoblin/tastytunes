import { useMemo } from "react";
import { useStore } from "@/store";
import type { SceneSettingValue } from "@shared/model";
import { resolveSettings, type SceneDef } from "./scenes";
import type { SceneSettings } from "./scenes/types";

/**
 * A scene's declared settings, merged over its defaults and persisted per
 * scene (settings.displaySceneSettings). A scene never sees a missing or
 * out-of-range value: resolveSettings guarantees every declared key is
 * present and valid, so it can index directly. Takes the definition, not an
 * id (packscape's lesson: a hook that looks its scene up in the registry
 * makes a cycle through every scene and breaks hot reload). `only` scopes
 * `dirty` and `reset` to those keys: the tile's picker shows a scene's
 * everywhere settings alone, and its Reset must not quietly clear the
 * fullscreen-only ones with them.
 */
export function useSceneSettings(
  def: SceneDef,
  only?: readonly string[],
): {
  values: SceneSettings;
  dirty: boolean;
  set(key: string, value: SceneSettingValue): void;
  reset(): void;
} {
  const persisted = useStore((s) => s.settings.displaySceneSettings[def.id]);
  const saveSettings = useStore((s) => s.saveSettings);
  const values = useMemo(() => resolveSettings(def, persisted), [def, persisted]);
  const keyList = (only ?? (def.settings ?? []).map((s) => s.key)).join("\u0000");
  return useMemo(
    () => ({
      values,
      dirty: persisted != null && keyList.split("\u0000").some((k) => persisted[k] !== undefined),
      set: (key, value) => {
        const all = useStore.getState().settings.displaySceneSettings;
        void saveSettings({
          displaySceneSettings: { ...all, [def.id]: { ...(all[def.id] ?? {}), [key]: value } },
        });
      },
      reset: () => {
        const all = { ...useStore.getState().settings.displaySceneSettings };
        const rest = { ...(all[def.id] ?? {}) };
        for (const k of keyList.split("\u0000")) delete rest[k];
        if (Object.keys(rest).length > 0) all[def.id] = rest;
        else delete all[def.id];
        void saveSettings({ displaySceneSettings: all });
      },
    }),
    [values, persisted, def.id, keyList, saveSettings],
  );
}
