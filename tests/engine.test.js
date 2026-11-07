// Scenario tests for the decision engine, mirroring sections 5.5, 5.6 and 11.1 of the report.
// Open tests/index.html through the local server to run them.
import {
  decide, comfortThreshold, reasonText, precipNote, applyFeedback, selectWindow, safetyNotices,
} from '../js/engine.js';

const T0 = Date.UTC(2026, 10, 7, 10) / 1000;
const hour = (i, apparent, extra = {}) => ({ t: T0 + i * 3600, apparent, temp: apparent, precipProb: 0, precipMm: 0, wind: 5, gusts: 10, code: 0, ...extra });
const series = (...temps) => temps.map((a, i) => hour(i, a));
const fmt = {
  value: c => c, num: c => String(Math.round(c)), temp: c => `${Math.round(c)}°C`,
  time: t => `${new Date(t * 1000).getUTCHours()}:00`,
};

export const tests = {
  'threshold follows sensitivity (21 / 18 / 15)': eq => {
    eq(comfortThreshold({ sensitivity: 'easily' }), 21);
    eq(comfortThreshold({}), 18);
    eq(comfortThreshold({ sensitivity: 'warm' }), 15);
  },
  'activity and exposure move the threshold': eq => {
    eq(comfortThreshold({ activity: 'standing' }), 20);
    eq(comfortThreshold({ activity: 'running' }), 12);
    eq(comfortThreshold({ exposure: 'indoors' }), 15);
  },
  '12°C feels-like for 90 minutes of walking: jacket': eq => {
    eq(decide(series(12, 12, 12)).status, 'take');
  },
  '22°C midday short walk: no jacket': eq => {
    eq(decide(series(22, 22)).status, 'none');
  },
  '21°C by day, 10°C after dark: jacket, with the time it turns cold': eq => {
    const r = decide(series(21, 21, 20, 19, 19, 14, 11, 10, 10));
    eq(r.status, 'take');
    eq(r.onset, T0 + 5 * 3600);
    eq(reasonText(r, fmt), 'Mild at first, then feels like 10°C by 15:00.');
  },
  'one isolated cool hour does not decide a long outing': eq => {
    const r = decide(series(24, 24, 24, 24, 24, 24, 14, 24, 24, 24, 24, 24));
    eq(r.status, 'none');
  },
  'a single seriously cold hour still counts': eq => {
    eq(decide(series(24, 24, 24, 24, 24, 24, 11, 24, 24, 24, 24, 24)).status, 'take');
  },
  'warm rain: no warm jacket, but rain protection': eq => {
    const r = decide([hour(0, 23, { precipProb: 80, precipMm: 2, code: 63 }), hour(1, 23)]);
    eq(r.status, 'none');
    eq(precipNote(r, fmt), 'Rain now. Bring rain protection, not a warm jacket.');
  },
  'cool rain tips a dry-weather "no" into a jacket': eq => {
    const wet = { precipProb: 80, precipMm: 2, code: 63 };
    eq(decide(series(19, 19, 19)).status, 'none');
    eq(decide([hour(0, 19, wet), hour(1, 19, wet), hour(2, 19, wet)]).status, 'take');
  },
  'wind does not change the decision on top of apparent temperature': eq => {
    const windy = decide([hour(0, 19, { wind: 45, gusts: 70 }), hour(1, 19, { wind: 45, gusts: 70 })]);
    eq(windy.status, decide(series(19, 19)).status);
    eq(reasonText(windy, fmt).includes('windy'), true);
  },
  'short hop between heated buildings is treated differently': eq => {
    eq(decide(series(16, 16)).status, 'take');
    eq(decide(series(16, 16), { exposure: 'indoors' }).status, 'none');
  },
  '65+ in cold rain: leans to a jacket and shows a caveat': eq => {
    const wet = { precipProb: 80, precipMm: 1, code: 61 };
    const points = [hour(0, 22, wet), hour(1, 22, wet)];
    eq(decide(points).status, 'none');
    const r = decide(points, { ageRange: '65+' });
    eq(r.status, 'take');
    eq(r.leanedCautious, true);
    eq(r.ageCaveat, true);
  },
  '65+ does not get a fixed offset on a clear warm day': eq => {
    eq(decide(series(24, 24), { ageRange: '65+' }).status, 'none');
  },
  'sex, climate and ancestry never change the decision': eq => {
    const plain = decide(series(18.5, 18.5));
    const withDemo = decide(series(18.5, 18.5), { sex: 'female', climate: 'hot', ancestry: 'anything' });
    eq(withDemo.status, plain.status);
    eq(withDemo.threshold, plain.threshold);
  },
  'near the threshold it flags a close call': eq => {
    const r = decide(series(18.5, 18.5));
    eq(r.borderline, true);
    eq(reasonText(r, fmt).startsWith('Close call.'), true);
  },
  'missing data gives unknown, never a guess': eq => {
    eq(decide([]).status, 'unknown');
    eq(decide(null).status, 'unknown');
    eq(decide([hour(0, null), hour(1, null), hour(2, 12)]).status, 'unknown');
  },
  'severe conditions are surfaced whichever way the verdict goes': eq => {
    const r = decide([hour(0, 25, { code: 95, precipProb: 90, precipMm: 5 }), hour(1, 25)]);
    eq(r.status, 'none');
    eq(r.safety, ['Thunderstorms possible.']);
    eq(safetyNotices([hour(0, -20)]), ['Dangerously cold.']);
    eq(safetyNotices([hour(0, 40)]), ['Dangerous heat.']);
  },
  'one odd outing does not change the threshold; two do': eq => {
    const once = applyFeedback({}, { tookJacket: false, feeling: 'cold' });
    eq(once.offset, 0);
    eq(applyFeedback(once, { tookJacket: false, feeling: 'cold' }).offset, 1);
  },
  'feedback ignored when it says nothing about the advice': eq => {
    eq(applyFeedback({}, { tookJacket: true, feeling: 'cold' }), { tally: 0, offset: 0 });
    eq(applyFeedback({}, { tookJacket: false, feeling: 'warm' }), { tally: 0, offset: 0 });
    eq(applyFeedback({}, { tookJacket: true, feeling: 'right' }), { tally: 0, offset: 0 });
  },
  'learned adjustment is bounded to ±3': eq => {
    let s = { tally: 0, offset: 3 };
    s = applyFeedback(s, { tookJacket: false, feeling: 'cold' });
    s = applyFeedback(s, { tookJacket: false, feeling: 'cold' });
    eq(s.offset, 3);
    eq(comfortThreshold({ feedbackOffset: 99 }), 21);
  },
  'windows use destination local time': eq => {
    const start = Date.UTC(2026, 10, 7, 0) / 1000;
    const hourly = Array.from({ length: 72 }, (_, i) => ({ t: start + i * 3600 }));
    const now = Date.UTC(2026, 10, 7, 14, 20) / 1000; // 16:20 in Jerusalem, 09:20 in New York
    eq(selectWindow(hourly, 'next3', now, 'Asia/Jerusalem').points.length, 4);
    eq(selectWindow(hourly, 'now', now, 'Asia/Jerusalem').points.length, 2);
    eq(selectWindow(hourly, 'evening', now, 'Asia/Jerusalem').points[0].t, Date.UTC(2026, 10, 7, 16) / 1000);
    eq(selectWindow(hourly, 'evening', now, 'America/New_York').points[0].t, Date.UTC(2026, 10, 7, 23) / 1000);
    eq(selectWindow(hourly, 'today', now, 'Asia/Jerusalem').points.at(-1).t, Date.UTC(2026, 10, 7, 21) / 1000);
  },
  'late at night, "evening" rolls to tomorrow': eq => {
    const start = Date.UTC(2026, 10, 7, 0) / 1000;
    const hourly = Array.from({ length: 72 }, (_, i) => ({ t: start + i * 3600 }));
    const now = Date.UTC(2026, 10, 7, 21, 30) / 1000; // 23:30 in Jerusalem
    const w = selectWindow(hourly, 'evening', now, 'Asia/Jerusalem');
    eq(w.label, 'Tomorrow evening');
    eq(w.points[0].t, Date.UTC(2026, 10, 8, 16) / 1000);
  },
  'windows survive a daylight-saving change': eq => {
    // US clocks go back on 1 Nov 2026: that local day has 25 hours.
    const start = Date.UTC(2026, 10, 1, 4) / 1000;
    const hourly = Array.from({ length: 48 }, (_, i) => ({ t: start + i * 3600 }));
    const w = selectWindow(hourly, 'today', start, 'America/New_York');
    eq(w.points.length, 25);
  },
};
