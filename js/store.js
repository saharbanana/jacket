// Everything the app remembers lives in this browser's localStorage. Nothing is sent
// to a server. Storage can be unavailable (private windows), so every call is guarded.
const PREFIX = 'jacket.';

export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // Storage is full or blocked: the app still works for this session.
    }
  },
};

// A US English phone in Israel should still get °C, so the timezone has to agree too.
const usesFahrenheit = () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  return /-US$/i.test(navigator.language || '') && /^(America|Pacific)\//.test(zone);
};

export const DEFAULT_PREFS = {
  onboarded: false,
  place: null,
  sensitivity: 'average',
  activity: 'walking',
  exposure: 'short',
  units: usesFahrenheit() ? 'F' : 'C',
  ageRange: null,
  sex: null,
  climate: null,
  ancestry: '',
  ancestryConsent: false,
  feedback: { tally: 0, offset: 0 },
  feedbackEnabled: true,
};

export const loadPrefs = () => ({ ...DEFAULT_PREFS, ...store.get('prefs', {}) });
export const savePrefs = prefs => store.set('prefs', prefs);
