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
 * makes a cycle through every scene and breaks hot reload).
 */
export function useSceneSettings(def: SceneDef): {
  values: SceneSettings;
  dirty: boolean;
  set(key: string, value: SceneSettingValue): void;
  reset(): void;
} {
  const persisted = useStore((s) => s.settings.displaySceneSettings[def.id]);
  const saveSettings = useStore((s) => s.saveSettings);
  const values = useMemo(() => resolveSettings(def, persisted), [def, persisted]);
  return useMemo(
    () => ({
      values,
      dirty: persisted != null && Object.keys(persisted).length > 0,
      set: (key, value) => {
        const all = useStore.getState().settings.displaySceneSettings;
        void saveSettings({
          displaySceneSettings: { ...all, [def.id]: { ...(all[def.id] ?? {}), [key]: value } },
        });
      },
      reset: () => {
        const all = { ...useStore.getState().settings.displaySceneSettings };
        delete all[def.id];
        void saveSettings({ displaySceneSettings: all });
      },
    }),
    [values, persisted, def.id, saveSettings],
  );
}
