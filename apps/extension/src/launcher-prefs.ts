import type { HideScope, LauncherPlacement } from './page-controls';

/** Where the page button sits and where the reader chose to hide it. Stored in chrome.storage.local. */
export interface LauncherPrefs { placement?: LauncherPlacement; hiddenSites?: string[]; hiddenEverywhere?: boolean }
export const LAUNCHER_KEY = 'launcher';
const MAX_SITES = 500;

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

export async function readLauncherPrefs(area: Area | undefined): Promise<LauncherPrefs> {
  if (!area) return {};
  try {
    const value = (await area.get(LAUNCHER_KEY))[LAUNCHER_KEY];
    return value && typeof value === 'object' ? value as LauncherPrefs : {};
  } catch { return {}; }
}

export function hiddenOn(prefs: LauncherPrefs, site: string): boolean {
  return prefs.hiddenEverywhere === true || (!!site && (prefs.hiddenSites ?? []).includes(site));
}

async function change(area: Area | undefined, update: (prefs: LauncherPrefs) => LauncherPrefs): Promise<void> {
  if (!area) return;
  await area.set({ [LAUNCHER_KEY]: update(await readLauncherPrefs(area)) });
}

export const savePlacement = (area: Area | undefined, placement: LauncherPlacement) => change(area, prefs => ({ ...prefs, placement }));

export function hideLauncher(area: Area | undefined, scope: Exclude<HideScope, 'page'>, site: string): Promise<void> {
  return change(area, prefs => scope === 'everywhere' ? { ...prefs, hiddenEverywhere: true }
    : { ...prefs, hiddenSites: [...new Set([...(prefs.hiddenSites ?? []), site])].slice(-MAX_SITES) });
}

/** Undo both a per-site and an everywhere hide, so the button returns on this site. */
export const showLauncher = (area: Area | undefined, site: string) => change(area, prefs => ({
  ...prefs, hiddenEverywhere: false, hiddenSites: (prefs.hiddenSites ?? []).filter(value => value !== site),
}));
