/**
 * Host half of the plugin-update-entry bundle.
 *
 * Intentionally empty: the entry point lives entirely in the Client module
 * (`./client`), which owns the card-level button, the version popover and the
 * hover notes. Nothing is registered on the Host, so this bundle never changes
 * what the runtime does — it only ships a browser module.
 */
export function apply() {}
