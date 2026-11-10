# Jacket?

One screen, one answer: should you bring a jacket for where you're going and when?
Built from `Jacket_or_No_Jacket_Research_and_Product_Report.md`.

It is an installable mobile web app (PWA) with no build step or dependencies.

## Run it

```bash
python -m http.server 5173 --bind 127.0.0.1
```

Then open http://localhost:5173. Engine tests are at http://localhost:5173/tests/.

## Put it on a phone

Upload this folder to any static HTTPS host, such as Netlify, Cloudflare Pages or GitHub Pages.
Phones only allow location access over HTTPS. Then open the link and choose
**Add to Home Screen** (iPhone: Share menu; Android: browser menu).

## Layout

| Path | Purpose |
|---|---|
| `js/engine.js` | Decision rules, thresholds and forecast windows. Pure and tested. |
| `js/weather.js` | Open-Meteo forecast and geocoding, with the on-device cache. |
| `js/store.js` | Saved preferences (localStorage only). |
| `js/app.js` | Screens, sheets and onboarding. |
| `sw.js` | Offline app shell. Bump `CACHE` when releasing. |

## Before a public or paid launch

- **Weather license:** the free Open-Meteo API is non-commercial. Move to a paid plan or
  another provider before monetizing. All provider code is in `js/weather.js`.
- **Thresholds:** 21 / 18 / 17 °C and the other numbers in `js/engine.js` are hypotheses to pilot.
- **Severe weather:** notices come from forecast values, not an official alert feed.
- **Demographics:** sex (female +1 °C), age (65+ +1 °C, plus cautious close calls) and
  background (African descent +1 °C, Arctic Indigenous −1 °C) nudge the jacket point, capped at
  ±2 °C together (`SEX_SHIFT`, `AGE_SHIFT`, `ANCESTRY_SHIFT` in `js/engine.js`). These are
  unvalidated guesses from research averages; the report recommends testing them in a pilot.
  Climate is stored but unused. All of it stays on the device.
- **Privacy:** get a privacy policy and legal review before release, especially for the
  ancestry field.
- **Ads:** none are included. The report rules out a timed full-screen ad, so start with a
  reserved banner at monetization.
