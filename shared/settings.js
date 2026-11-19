// The plugin's settings: one record, `settings/global` in plugin_records, written by the Concepts Settings panel.
// Stored values are partial; everything missing falls back to the defaults.
export const SETTINGS_DEFAULTS = { proposals: true };
/** Where they are kept: `data.get(SETTINGS_COLLECTION, SETTINGS_ID)`. */
export const SETTINGS_COLLECTION = "settings";
export const SETTINGS_ID = "global";
export const settingsOf = (stored) => ({
  ...SETTINGS_DEFAULTS,
  ...stored,
});
