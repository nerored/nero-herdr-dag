import { t } from './i18n.mjs';

// Command palette entries. Labels are resolved on open so a language change
// cannot leave stale English rows in the overlay.
export function commandItems(language) {
  return [
    { id: 'overview', label: t(language, 'cmdOverview') },
    { id: 'find', label: t(language, 'cmdFind') },
    { id: 'filter-failed', label: t(language, 'cmdFilterFailed') },
    { id: 'filter-blocked', label: t(language, 'cmdFilterBlocked') },
    { id: 'filter-running', label: t(language, 'cmdFilterRunning') },
    { id: 'filter-critical', label: t(language, 'cmdFilterCritical') },
    { id: 'filter-clear', label: t(language, 'cmdFilterClear') },
    { id: 'focus', label: t(language, 'cmdFocus') },
    { id: 'scope', label: t(language, 'cmdScope') },
    { id: 'completed', label: t(language, 'cmdCompleted') },
    { id: 'verbose', label: t(language, 'cmdVerbose') },
    { id: 'tour', label: t(language, 'cmdTour') },
    { id: 'undo', label: t(language, 'cmdUndo') },
    { id: 'help', label: t(language, 'helpTitle') },
    { id: 'settings', label: t(language, 'settings') },
    { id: 'quit', label: t(language, 'helpQuit') },
  ];
}

export function filterCommands(items, query) {
  const tokens = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return items;
  return items.filter(item => {
    const haystack = `${item.id} ${item.label ?? ''}`.toLowerCase();
    return tokens.every(token => haystack.includes(token));
  });
}
