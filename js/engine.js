// Jacket decision engine. Pure functions: no DOM, no network, no storage.
// All temperatures are °C and all wind speeds km/h. Display units are handled by `fmt`.
//
// The numbers below are PRODUCT HYPOTHESES from section 5.3 of the report, chosen
// to bootstrap testing. They are not measured physiological cutoffs.

export const BASE_THRESHOLD = { easily: 21, average: 18, warm: 15 };
export const ACTIVITY_SHIFT = { standing: 2, walking: 0, running: -6 };
export const EXPOSURE_SHIFT = { indoors: -3, short: 0, long: 1 };

// Optional demographic nudges, in °C. These are small product guesses based on the
// AVERAGE differences the report cites (sections 2.2–2.4), not validated coefficients.
// Together they are capped at ±2 °C, and outing feedback can outweigh them over time.
export const SEX_SHIFT = { female: 1, male: 0, other: 0 };
export const AGE_SHIFT = { '18-39': 0, '40-64': 0, '65+': 1 };
export const ANCESTRY_SHIFT = { african: 1, arctic: -1 };
export const ANCESTRY_OPTIONS = [
  ['african', 'Black African or African descent'],
  ['east_asian', 'East Asian'],
  ['south_asian', 'South Asian'],
  ['mena', 'Middle Eastern or North African'],
  ['european', 'European or white'],
  ['latino', 'Hispanic or Latino'],
  ['arctic', 'Inuit or other Arctic Indigenous'],
  ['mixed', 'Mixed or multiple'],
  ['other', 'Another background'],
];
const DEMOGRAPHIC_LIMIT = 2;

const WET_PENALTY = 2;        // Apparent temperature ignores rain, so this is not double counted.
const FIRM_DEFICIT = 3;       // Clearly below the comfort threshold.
const SEVERE_DEFICIT = 6;     // Cold enough that even a single forecast hour counts.
const COLD_SHARE = 1 / 3;     // Share of the outing below threshold that justifies a jacket.
const BORDERLINE = 1.5;       // Within this many degrees, the result is a close call.
const CAUTION_MARGIN = 3;     // 65+: how close to the threshold wet or windy weather counts.
const WINDY_SPEED = 30;
const WINDY_GUST = 50;
const FEEDBACK_LIMIT = 3;     // Learned adjustment can never exceed ±3 °C.
const FEEDBACK_VOTES = 2;     // Outings needed before the threshold moves.

const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const STORM_CODES = new Set([95, 96, 99]);
const ICE_CODES = new Set([56, 57, 66, 67]);
const HEAVY_SNOW_CODES = new Set([75, 86]);

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Each piece of the personal "jacket point", so the app can explain it. */
export function thresholdParts(profile = {}) {
  const sex = SEX_SHIFT[profile.sex] ?? 0;
  const age = AGE_SHIFT[profile.ageRange] ?? 0;
  const ancestry = ANCESTRY_SHIFT[profile.ancestry] ?? 0;
  return {
    base: BASE_THRESHOLD[profile.sensitivity] ?? BASE_THRESHOLD.average,
    activity: ACTIVITY_SHIFT[profile.activity] ?? 0,
    exposure: EXPOSURE_SHIFT[profile.exposure] ?? 0,
    sex, age, ancestry,
    demographic: clamp(sex + age + ancestry, -DEMOGRAPHIC_LIMIT, DEMOGRAPHIC_LIMIT),
    learned: clamp(profile.feedbackOffset ?? 0, -FEEDBACK_LIMIT, FEEDBACK_LIMIT),
  };
}

/** Personal "jacket point", in apparent °C. Wind is deliberately absent: Open-Meteo's
 *  apparent temperature already includes it, so adding it again would double count. */
export function comfortThreshold(profile = {}) {
  const p = thresholdParts(profile);
  return p.base + p.activity + p.exposure + p.demographic + p.learned;
}

const isSnowy = p => SNOW_CODES.has(p.code) && (p.precipProb ?? 100) >= 40;
const isRainy = p =>
  !isSnowy(p) && (
    ((p.precipMm ?? 0) >= 0.2 && (p.precipProb ?? 100) >= 40) ||
    (RAIN_CODES.has(p.code) && (p.precipProb ?? 0) >= 50)
  );
const isWet = p => isRainy(p) || isSnowy(p);
const isWindy = p => (p.wind ?? 0) >= WINDY_SPEED || (p.gusts ?? 0) >= WINDY_GUST;

/** Conditions where the binary icon must not read as "you're fine". These come from
 *  forecast values, so they point people to official warnings and do not replace them. */
export function safetyNotices(points) {
  const notices = new Set();
  for (const p of points) {
    if (STORM_CODES.has(p.code)) notices.add('Thunderstorms possible.');
    if (ICE_CODES.has(p.code)) notices.add('Freezing rain possible.');
    if (HEAVY_SNOW_CODES.has(p.code)) notices.add('Heavy snow possible.');
    if ((p.gusts ?? 0) >= 75) notices.add('Very strong wind gusts.');
    if ((p.apparent ?? 0) <= -15) notices.add('Dangerously cold.');
    if ((p.apparent ?? 0) >= 38) notices.add('Dangerous heat.');
  }
  return [...notices];
}

/**
 * Should this person bring a jacket for these forecast hours?
 * Returns status 'take' | 'none' | 'unknown'. Missing data is never turned into a yes/no.
 * Sex, age and ancestry shift the threshold slightly (see thresholdParts). Age 65+ also
 * tips close calls and rough weather toward a jacket. Climate background is not used.
 */
export function decide(points, profile = {}) {
  const usable = (points ?? []).filter(p => Number.isFinite(p.apparent));
  if (!usable.length || usable.length < points.length / 2) {
    return { status: 'unknown', safety: safetyNotices(usable) };
  }

  const threshold = comfortThreshold(profile);
  const hours = usable.map(p => {
    const wet = isWet(p);
    return { ...p, wet, windy: isWindy(p), deficit: threshold - (p.apparent - (wet ? WET_PENALTY : 0)) };
  });

  const coldHours = hours.filter(h => h.deficit > 0);
  const firmHours = hours.filter(h => h.deficit >= FIRM_DEFICIT);
  const maxDeficit = Math.max(...hours.map(h => h.deficit));
  const coldShare = coldHours.length / hours.length;

  // Duration AND severity, so that one odd forecast hour cannot decide a long outing.
  let take = firmHours.length >= 2 || coldShare >= COLD_SHARE || maxDeficit >= SEVERE_DEFICIT;
  const borderline = take ? maxDeficit < BORDERLINE : maxDeficit > -BORDERLINE;

  const older = profile.ageRange === '65+';
  const roughWeather = hours.some(h => (h.wet || h.windy) && h.deficit > -CAUTION_MARGIN);
  const leanedCautious = older && !take && (borderline || roughWeather);
  if (leanedCautious) take = true;

  const apparents = hours.map(h => h.apparent);
  const firstCold = hours.find(h => h.deficit > 0);
  const firstWet = hours.find(h => h.wet);
  const firstWindy = hours.find(h => h.windy);

  return {
    status: take ? 'take' : 'none',
    threshold,
    low: Math.min(...apparents),
    high: Math.max(...apparents),
    borderline,
    coldShare,
    coldHours: coldHours.length,
    totalHours: hours.length,
    onset: take && firstCold && firstCold !== hours[0] ? firstCold.t : null,
    precip: firstWet ? { kind: isSnowy(firstWet) ? 'snow' : 'rain', t: firstWet.t, now: firstWet === hours[0] } : null,
    windy: firstWindy ? { later: firstWindy !== hours[0] } : null,
    leanedCautious,
    ageCaveat: older && take && hours.some(h => h.wet || h.windy || h.deficit >= FIRM_DEFICIT),
    safety: safetyNotices(hours),
    hours,
  };
}

/** The one-sentence reason under the verdict. */
export function reasonText(r, fmt) {
  if (r.status === 'unknown') return 'There isn’t enough forecast data for this time.';
  const range = Math.round(fmt.value(r.low)) === Math.round(fmt.value(r.high))
    ? fmt.temp(r.low)
    : `${fmt.num(r.low)}–${fmt.temp(r.high)}`;
  let text = r.onset
    ? `Mild at first, then feels like ${fmt.temp(r.low)} by ${fmt.time(r.onset)}`
    : `Feels like ${range}`;
  if (r.windy) text += r.windy.later ? '; windy later' : '; windy';
  return r.borderline ? `Close call. ${text}.` : `${text}.`;
}

/** Secondary line: rain gear is separate advice from warmth. */
export function precipNote(r, fmt) {
  if (!r.precip) return '';
  const when = r.precip.now ? 'now' : `around ${fmt.time(r.precip.t)}`;
  if (r.precip.kind === 'snow') return `Snow ${when}. Choose something warm and waterproof.`;
  return r.status === 'take'
    ? `Rain ${when}. Make it a waterproof one.`
    : `Rain ${when}. Bring rain protection, not a warm jacket.`;
}

/**
 * Bounded, slow personal learning (section 5.6). Only outcomes that show the advice
 * should have been different count: cold without a jacket, or too warm with one.
 * It takes repeated outings in one direction to move the threshold by 1 °C.
 */
export function applyFeedback(state, { tookJacket, feeling }) {
  let { tally = 0, offset = 0 } = state ?? {};
  if (!tookJacket && feeling === 'cold') tally += 1;
  else if (tookJacket && feeling === 'warm') tally -= 1;
  if (Math.abs(tally) >= FEEDBACK_VOTES) {
    offset = clamp(offset + Math.sign(tally), -FEEDBACK_LIMIT, FEEDBACK_LIMIT);
    tally = 0;
  }
  return { tally, offset };
}

// Forecast window selection -------------------------------------------------

const localParts = (epoch, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epoch * 1000));
  const get = type => parts.find(x => x.type === type).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
};

export const WINDOWS = {
  now: 'Right now',
  next3: 'Next 3 hours',
  today: 'Rest of today',
  evening: 'This evening',
};

/** Picks forecast hours for a window, using the DESTINATION's local time (DST-safe). */
export function selectWindow(hourly, key, nowEpoch, timeZone) {
  const startHour = Math.floor(nowEpoch / 3600) * 3600;
  const upcoming = hourly.filter(p => p.t >= startHour);
  const today = localParts(nowEpoch, timeZone);
  const onDate = date => upcoming.filter(p => localParts(p.t, timeZone).date === date);

  if (key === 'now') return { points: upcoming.filter(p => p.t <= startHour + 3600), label: WINDOWS.now };
  if (key === 'today') return { points: onDate(today.date), label: WINDOWS.today };
  if (key === 'evening') {
    const inEvening = p => localParts(p.t, timeZone).hour >= 18;
    const tonight = onDate(today.date).filter(inEvening);
    if (tonight.length && today.hour < 23) return { points: tonight, label: WINDOWS.evening };
    const first = upcoming.find(p => localParts(p.t, timeZone).date !== today.date);
    const nextDate = first && localParts(first.t, timeZone).date;
    return { points: nextDate ? onDate(nextDate).filter(inEvening) : [], label: 'Tomorrow evening' };
  }
  return { points: upcoming.filter(p => p.t <= startHour + 3 * 3600), label: WINDOWS.next3 };
}
