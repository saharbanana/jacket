import { decide, reasonText, precipNote, selectWindow, applyFeedback, WINDOWS } from './engine.js';
import { loadPrefs, savePrefs, store } from './store.js';
import { cachedForecast, fetchForecast, locate, searchPlaces } from './weather.js';

const $ = id => document.getElementById(id);

/** Small DOM builder. Text always goes in as text nodes, so API data can't inject markup. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (value === true) el.setAttribute(key, '');
    else if (value !== false && value != null) el.setAttribute(key, value);
  }
  el.append(...children.flat().filter(c => c != null && c !== false));
  return el;
}

const prefs = loadPrefs();
let windowKey = 'next3';              // Back to the default on each launch, as the spec asks.
let forecast = null;
let phase = 'loading';                // loading | ready | stale | error | noplace
let result = null;
let selection = null;
let refreshId = 0;

const persist = () => savePrefs(prefs);

// Formatting ------------------------------------------------------------------

function formatter() {
  const f = prefs.units === 'F';
  const value = c => (f ? c * 9 / 5 + 32 : c);
  const num = c => String(Math.round(value(c)));
  const time = new Intl.DateTimeFormat(navigator.language, { hour: 'numeric', timeZone: forecast?.timeZone });
  return { value, num, temp: c => `${num(c)}°${prefs.units}`, time: t => time.format(new Date(t * 1000)) };
}

const ageOf = ms => {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
};

// Main screen -----------------------------------------------------------------

function profile() {
  return {
    sensitivity: prefs.sensitivity,
    activity: prefs.activity,
    exposure: prefs.exposure,
    ageRange: prefs.ageRange,
    feedbackOffset: prefs.feedback.offset,
  };
}

function setScene(verdict, heading, ariaLabel, reason = '', note = '') {
  document.body.dataset.verdict = verdict;
  document.body.dataset.loading = String(phase === 'loading');
  $('verdict').textContent = heading;
  $('jacket').setAttribute('aria-label', ariaLabel);
  $('reason').textContent = reason;
  $('note').textContent = note;
  const color = getComputedStyle(document.body).getPropertyValue(`--bg-${verdict}`).trim();
  document.querySelector('meta[name=theme-color]').content = color;
}

function notice(text, action) {
  return h('div', { class: 'notice', role: 'status' }, h('span', {}, text),
    action && h('button', { type: 'button', onclick: action.run }, action.label));
}

function render() {
  $('placeName').textContent = prefs.place?.name ?? 'Choose a place';
  $('placeBtn').setAttribute('aria-label', `${$('placeName').textContent}. Change location`);
  const fmt = formatter();
  const notices = [];
  const retry = { label: 'Retry', run: () => refresh({ force: true }) };

  selection = forecast ? selectWindow(forecast.hourly, windowKey, Date.now() / 1000, forecast.timeZone) : null;
  result = selection ? decide(selection.points, profile()) : null;

  if (selection?.points.length) {
    const { points, label } = selection;
    const range = points.length > 1 ? `${fmt.time(points[0].t)}–${fmt.time(points.at(-1).t)}` : '';
    $('windowLabel').textContent = range ? `${label} · ${range}` : label;
  } else {
    $('windowLabel').textContent = WINDOWS[windowKey];
  }

  $('updated').replaceChildren();
  if (forecast) {
    const at = new Intl.DateTimeFormat(navigator.language, { hour: 'numeric', minute: '2-digit' }).format(forecast.fetchedAt);
    $('updated').append(`Updated ${at} · `, h('a', { href: 'https://open-meteo.com/', target: '_blank', rel: 'noopener' }, 'Weather by Open-Meteo'));
  }

  if (!result) {
    if (phase === 'loading') setScene('neutral', 'Checking the forecast…', 'Jacket, loading');
    else if (phase === 'noplace') {
      setScene('neutral', 'Where are you going?', 'Jacket', 'Choose a place to get your answer.');
      notices.push(notice('No location selected.', { label: 'Choose', run: () => openPlaces() }));
    } else {
      setScene('neutral', 'Weather unavailable', 'Jacket, no result', 'We can’t give an answer without a forecast.');
      notices.push(notice('Couldn’t reach the weather service.', retry));
    }
  } else if (result.status === 'unknown') {
    setScene('neutral', 'Can’t determine right now', 'Jacket, no result', reasonText(result, fmt));
    notices.push(notice('Forecast data is incomplete.', retry));
  } else {
    const take = result.status === 'take';
    setScene(
      take ? 'take' : 'none',
      take ? 'TAKE A JACKET' : 'NO JACKET NEEDED',
      take ? 'Jacket' : 'Jacket crossed out with a red prohibition sign',
      reasonText(result, fmt),
      precipNote(result, fmt),
    );
    rememberOuting();
  }

  if (phase === 'stale' && forecast) {
    notices.push(notice(`Couldn’t refresh. This forecast is ${ageOf(forecast.fetchedAt)} old.`, retry));
  }
  if (result?.safety?.length) {
    notices.push(notice(`${result.safety.join(' ')} Check official weather warnings.`));
  }
  if (result?.ageCaveat) {
    notices.push(notice('Cold can be harder to notice with age, so this leans cautious. It isn’t a safety assessment.'));
  }
  $('notices').replaceChildren(...notices);
  renderFeedbackPrompt();
}

// Data flow -------------------------------------------------------------------

async function refresh({ force = false } = {}) {
  const id = ++refreshId;
  const place = prefs.place;
  if (!place) {
    phase = 'noplace';
    forecast = null;
    render();
    return;
  }

  // Show whatever is cached at once, so a repeat open has no spinner.
  if (place.lat != null) forecast = cachedForecast(place.lat, place.lon);
  phase = forecast ? 'ready' : 'loading';
  render();

  if (place.type === 'current') {
    try {
      const coords = await locate();
      if (id !== refreshId) return;
      Object.assign(place, coords);
      persist();
      forecast = cachedForecast(place.lat, place.lon) ?? forecast;
    } catch (err) {
      if (id !== refreshId) return;
      if (err?.code === 1 || place.lat == null) {
        prefs.place = null;
        persist();
        phase = 'noplace';
        forecast = null;
        render();
        openPlaces('Location access is off. Search for a city instead.');
        return;
      }
    }
  }

  if (forecast?.fresh && !force) return;

  try {
    const next = await fetchForecast(place.lat, place.lon);
    if (id !== refreshId) return;
    forecast = next;
    phase = 'ready';
  } catch {
    if (id !== refreshId) return;
    phase = forecast ? 'stale' : 'error';
  }
  render();
}

function choosePlace(place) {
  prefs.place = place;
  if (place.type === 'city') {
    const recents = store.get('recents', []).filter(r => r.lat !== place.lat || r.lon !== place.lon);
    store.set('recents', [place, ...recents].slice(0, 5));
  }
  persist();
  forecast = null;
  $('placeSheet').close();
  return refresh();
}

// Sheets ----------------------------------------------------------------------

function radios(legend, name, options, value, onChange, inline = false) {
  return h('fieldset', { class: `options${inline ? ' inline' : ''}` },
    legend && h('legend', {}, legend),
    options.map(([val, label]) => h('label', { class: 'option' },
      h('input', { type: 'radio', name, value: val, checked: val === value, onchange: () => onChange(val) }),
      h('span', {}, label))));
}

function pick(label, options, value, onChange, hint) {
  return h('label', { class: 'field' }, h('span', {}, label),
    h('select', { onchange: e => onChange(e.target.value || null) },
      options.map(([val, text]) => h('option', { value: val, selected: val === (value ?? '') }, text))),
    hint && h('span', { class: 'hint' }, hint));
}

// Places

function placeButton(place) {
  return h('button', { class: 'place-item', type: 'button', onclick: () => choosePlace(place) },
    h('strong', {}, place.name), place.region && h('span', {}, place.region));
}

function showRecents() {
  const recents = store.get('recents', []);
  $('placeResults').replaceChildren(...(recents.length ? [h('h3', {}, 'Recent'), ...recents.map(placeButton)] : []));
}

function openPlaces(message = '') {
  $('placeMessage').hidden = !message;
  $('placeMessage').textContent = message;
  $('placeSearch').value = '';
  showRecents();
  if (!$('placeSheet').open) $('placeSheet').showModal();
}

let searchTimer;
let searchId = 0;
$('placeSearch').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const query = e.target.value.trim();
  const id = ++searchId;
  if (query.length < 2) return showRecents();
  searchTimer = setTimeout(async () => {
    try {
      const places = await searchPlaces(query);
      if (id !== searchId) return;
      $('placeResults').replaceChildren(...(places.length ? places.map(placeButton) : [h('p', { class: 'hint' }, 'No places found.')]));
    } catch {
      if (id === searchId) $('placeResults').replaceChildren(h('p', { class: 'hint' }, 'Search is unavailable. Check your connection and try again.'));
    }
  }, 250);
});

function useCurrentLocation() {
  // Ask here, directly from the tap, so a refusal can stay on the place sheet.
  return locate().then(
    coords => choosePlace({ type: 'current', name: 'My location', ...coords }),
    () => openPlaces('Location isn’t available. Search for a city instead.'),
  );
}
$('useLocation').addEventListener('click', useCurrentLocation);

// Time and exposure

function openTime() {
  $('timeOptions').replaceChildren(radios(null, 'window', Object.entries(WINDOWS), windowKey, key => {
    windowKey = key;
    render();
  }));
  $('exposureOptions').replaceChildren(radios(null, 'exposure',
    [['indoors', 'Mostly indoors'], ['short', 'Short walk'], ['long', 'Outdoors for a while']],
    prefs.exposure, value => { prefs.exposure = value; persist(); render(); }));
  $('timeSheet').showModal();
}

// Why

const ACTIVITY_TEXT = {
  standing: 'Mostly standing, so you’ll feel the cold sooner.',
  running: 'Running makes plenty of its own heat.',
};
const EXPOSURE_TEXT = {
  indoors: 'Mostly indoors, so short cold spells matter less.',
  long: 'Outdoors for a while, so we allow a little extra.',
};

function openWhy() {
  const fmt = formatter();
  const body = [];
  if (!result || result.status === 'unknown') {
    body.push(h('p', {}, 'There’s no forecast to judge yet, so we’re not guessing.'));
  } else {
    const { coldHours, totalHours, threshold, hours } = result;
    const lead = coldHours
      ? `${coldHours} of ${totalHours} forecast hours feel colder than your jacket point.`
      : 'Every forecast hour stays above your jacket point.';
    const points = [];
    if (ACTIVITY_TEXT[prefs.activity]) points.push(ACTIVITY_TEXT[prefs.activity]);
    if (EXPOSURE_TEXT[prefs.exposure]) points.push(EXPOSURE_TEXT[prefs.exposure]);
    if (hours.some(x => x.wet)) points.push('Rain or snow makes it feel colder, so wet hours count as 2° cooler.');
    if (prefs.feedback.offset) points.push('Your outing feedback has adjusted your jacket point.');
    if (result.leanedCautious) points.push('For age 65+, close calls and wet or windy weather lean toward a jacket.');
    body.push(
      h('p', { class: 'why-lead' }, lead),
      h('ul', { class: 'why-list' },
        h('li', {}, `Your jacket point is about ${fmt.temp(threshold)} feels-like. It’s a starting estimate we’re still testing, not a scientific cutoff.`),
        points.map(text => h('li', {}, text))),
      h('ul', { class: 'hours', 'aria-label': 'Forecast by hour' }, hours.map(x =>
        h('li', { class: x.deficit > 0 ? 'cold' : '' },
          fmt.time(x.t), h('strong', {}, fmt.temp(x.apparent)),
          x.deficit > 0 ? 'Cold' : 'OK',
          x.wet ? ` · ${x.precipProb ?? '–'}%` : ''))),
      h('p', { class: 'hint' }, 'Feels-like temperature, which already includes wind and humidity. Hours marked Cold are below your jacket point.'),
    );
  }
  $('whyBody').replaceChildren(...body);
  $('whySheet').showModal();
}

// Settings

function clearProfile() {
  Object.assign(prefs, {
    ageRange: null, sex: null, climate: null, ancestry: '', ancestryConsent: false,
    feedback: { tally: 0, offset: 0 },
  });
  persist();
  render();
  renderSettings();
  $('deletedNote').hidden = false;
}

function renderSettings(openAdvanced = false) {
  const set = key => value => { prefs[key] = value; persist(); render(); };
  const ancestryInput = h('input', {
    type: 'text', maxlength: 80, autocomplete: 'off', value: prefs.ancestry, disabled: !prefs.ancestryConsent,
    oninput: e => set('ancestry')(e.target.value),
  });
  const consent = h('input', {
    type: 'checkbox', checked: prefs.ancestryConsent,
    onchange: e => {
      prefs.ancestryConsent = e.target.checked;
      ancestryInput.disabled = !e.target.checked;
      if (!e.target.checked) { prefs.ancestry = ''; ancestryInput.value = ''; }
      persist();
    },
  });

  $('settingsBody').replaceChildren(
    radios('How easily do you get cold?', 'sensitivity',
      [['easily', 'I get cold easily'], ['average', 'About average'], ['warm', 'I’m usually warm']],
      prefs.sensitivity, set('sensitivity')),
    h('div', { class: 'group' }, radios('Usual activity', 'activity',
      [['standing', 'Standing'], ['walking', 'Walking'], ['running', 'Running']],
      prefs.activity, set('activity'), true)),
    h('div', { class: 'group' }, radios('Temperature units', 'units',
      [['C', '°C'], ['F', '°F']], prefs.units, set('units'), true)),

    h('details', { class: 'advanced', id: 'advanced', open: openAdvanced },
      h('summary', {}, 'Advanced personalization (optional)'),
      h('p', { class: 'hint' }, 'Everything here is optional and stays on this device. Only age range changes your result for now. The other answers do nothing yet: research doesn’t support turning them into a jacket rule without testing first.'),
      pick('Age range', [['', 'Prefer not to say'], ['18-39', '18–39'], ['40-64', '40–64'], ['65+', '65+']],
        prefs.ageRange, set('ageRange'), 'At 65+, close calls lean toward a jacket.'),
      pick('Sex for temperature personalization', [['', 'Prefer not to say'], ['male', 'Male'], ['female', 'Female'], ['other', 'Other or not represented']],
        prefs.sex, set('sex')),
      pick('What climate did you mostly grow up in?', [['', 'Prefer not to say'], ['hot', 'Hot, tropical or hot desert'], ['mild', 'Mild or temperate'], ['cold', 'Cold, long winters'], ['mixed', 'Mixed or moved often']],
        prefs.climate, set('climate')),
      h('label', { class: 'check' }, consent, h('span', {}, 'I choose to save my ethnic or ancestral background on this device.')),
      h('label', { class: 'field' }, h('span', {}, 'Ethnic or ancestral background, in your own words'), ancestryInput,
        h('span', { class: 'hint' }, 'Sensitive information. It’s never sent anywhere or used for ads, and it doesn’t change your result.')),
    ),

    h('div', { class: 'group' },
      h('h3', {}, 'Learning from your outings'),
      h('p', { class: 'hint' }, prefs.feedback.offset
        ? `Your jacket point is adjusted by ${prefs.feedback.offset > 0 ? '+' : ''}${prefs.feedback.offset}°C from feedback.`
        : 'No adjustment yet. It takes more than one outing to change anything.'),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: prefs.feedbackEnabled, onchange: e => { prefs.feedbackEnabled = e.target.checked; persist(); render(); } }),
        h('span', {}, 'Ask how my outing went')),
    ),

    h('div', { class: 'group' },
      h('h3', {}, 'Privacy'),
      h('p', { class: 'hint' }, 'No account and no ads. Your settings stay on this device. To get a forecast, your place is sent to Open-Meteo, rounded to about 1 km. Location is only read while the app is open.'),
      h('button', { class: 'link danger', type: 'button', onclick: clearProfile }, 'Delete my optional profile data'),
      h('p', { class: 'hint', id: 'deletedNote', hidden: true, role: 'status' }, 'Deleted age, sex, climate, background and learned adjustment.'),
    ),

    h('div', { class: 'settings-foot' },
      h('p', {}, 'For adults. A jacket suggestion isn’t a safety assessment. In severe weather, follow official warnings.'),
      h('p', {}, 'Weather data by ', h('a', { href: 'https://open-meteo.com/', target: '_blank', rel: 'noopener' }, 'Open-Meteo.com'), ' (CC BY 4.0).'),
    ),
  );
}

function openSettings(openAdvanced = false) {
  renderSettings(openAdvanced);
  $('settingsSheet').showModal();
}

// Feedback

function rememberOuting() {
  const pending = store.get('outing', null);
  if (pending && pending.endsAt * 1000 < Date.now()) return;      // Waiting for an answer.
  store.set('outing', { endsAt: selection.points.at(-1).t, place: prefs.place.name, advice: result.status });
}

const outingToAskAbout = () => {
  const outing = store.get('outing', null);
  return prefs.feedbackEnabled && outing && outing.endsAt * 1000 < Date.now() ? outing : null;
};

function renderFeedbackPrompt() {
  $('feedbackBtn').hidden = !outingToAskAbout();
}

function openFeedback() {
  const outing = outingToAskAbout();
  if (!outing) return;
  let tookJacket = null;
  const finish = () => {
    store.set('outing', null);
    $('feedbackSheet').close();
    render();
  };
  const feelings = radios('How did you feel?', 'feeling',
    [['cold', 'Too cold'], ['right', 'Just right'], ['warm', 'Too warm']], null, feeling => {
      prefs.feedback = applyFeedback(prefs.feedback, { tookJacket, feeling });
      persist();
      finish();
    }, true);
  feelings.hidden = true;
  $('feedbackBody').replaceChildren(
    h('p', { class: 'hint' }, `In ${outing.place}. Skip this if you stayed in.`),
    h('div', { class: 'group' }, radios('Did you take a jacket?', 'took', [['yes', 'Yes'], ['no', 'No']], null, value => {
      tookJacket = value === 'yes';
      feelings.hidden = false;
    }, true)),
    h('div', { class: 'group' }, feelings),
    h('div', { class: 'group' }, h('button', { class: 'link', type: 'button', onclick: finish }, 'Skip this outing'),
      h('button', {
        class: 'link', type: 'button',
        onclick: () => { prefs.feedbackEnabled = false; persist(); finish(); },
      }, 'Don’t ask again')),
  );
  $('feedbackSheet').showModal();
}

// Onboarding ------------------------------------------------------------------

function startApp() {
  prefs.onboarded = true;
  persist();
  $('welcome').hidden = true;
  $('app').hidden = false;
}

function toSensitivityStep() {
  $('welcomeLocation').hidden = true;
  $('welcomeSensitivity').hidden = false;
}

function runOnboarding() {
  $('welcome').hidden = false;

  // Draw the same artwork into the welcome screen without duplicating it.
  const art = document.querySelector('#jacket .jk').cloneNode(true);
  document.querySelector('.jacket-small').replaceChildren(art);

  $('welcomeLocate').addEventListener('click', async () => {
    $('welcomeLocate').disabled = true;
    try {
      const coords = await locate();
      prefs.place = { type: 'current', name: 'My location', ...coords };
      persist();
      refresh();
      toSensitivityStep();
    } catch {
      openPlaces('Location isn’t available. Search for a city instead.');
    } finally {
      $('welcomeLocate').disabled = false;
    }
  });
  $('welcomeCity').addEventListener('click', () => openPlaces());
  document.querySelectorAll('[data-sensitivity]').forEach(btn => btn.addEventListener('click', () => {
    prefs.sensitivity = btn.dataset.sensitivity;
    startApp();
    render();
  }));
  $('welcomeSkip').addEventListener('click', () => { startApp(); render(); });
  $('welcomeAdvanced').addEventListener('click', () => { startApp(); render(); openSettings(true); });
}

// Wiring ----------------------------------------------------------------------

$('placeBtn').addEventListener('click', () => openPlaces());
$('settingsBtn').addEventListener('click', () => openSettings());
$('timeBtn').addEventListener('click', openTime);
$('whyBtn').addEventListener('click', openWhy);
$('feedbackBtn').addEventListener('click', openFeedback);

document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('click', e => {
    if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
  });
});

// Reopening from the background: move the window on, and refresh if the data has aged.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && prefs.onboarded) refresh();
});
window.addEventListener('online', () => { if (phase === 'stale' || phase === 'error') refresh({ force: true }); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

if (prefs.onboarded) {
  $('app').hidden = false;
  refresh();
} else {
  // Choosing a city during onboarding happens in the shared place sheet.
  $('placeSheet').addEventListener('close', () => {
    if (!prefs.onboarded && prefs.place) toSensitivityStep();
  });
  runOnboarding();
}
