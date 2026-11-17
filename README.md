# GTA 6 Twitch Forecast — make.fun gta6-twitch-ccu-forecast-01

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/mamamuda-wikwik/gta6-twitch-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/mamamuda-wikwik/gta6-twitch-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Forecast how many people watch Grand Theft Auto VI live on Twitch in each hour
of its release day (2026-11-19 UTC), after the first hour — five quantiles
(5%, 25%, 50%, 75%, 95%) per hour, hours 2–24.

## How it works

`main.ts` (Node 22, standard library only) reads one case from `/input` and
writes the forecast to `/output`. The model is a **launch-day shape**
forecaster in log space:

- Every big game launch has the same launch-day shape — an overnight dip,
  then a ramp into the US evening — but how steep the ramp is depends almost
  entirely on how big hour 1 already is. Across the 38 comparable launches
  in the case file, log(hour-1 viewers) predicts the hour-19 log-ratio with
  correlation −0.93: a launch whose first hour is already huge stays flat,
  one that starts small explodes.
- For each forecast hour it takes the comparables' log-ratios
  ln(viewers_h / viewers_1) and reads off their kernel-weighted quantiles,
  weighted by closeness in log(hour-1 viewers) (Gaussian kernel, bandwidth
  0.75), so median and spread both adapt to the launch's own scale.
  Spreads are shrunk 0.9× toward the median. Curves are computed at run time
  from the case file's own comparables, so the final case's 42 comparables
  (including the four practice launches) are used automatically.

Backtest (mean pinball loss on the log scale, the contest's own formula):
practice cases p00–p03 score **0.2359** vs the house persistence baseline
**0.3871** (−39%). Leave-one-out over the 38 comparables: 0.405 vs
persistence 0.930; on big launches (hour 1 ≥ 50k) 0.208 vs 0.251.

## How to run

Requires Node.js 22+ (no external dependencies).

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Deterministic: two runs write byte-identical output. Runs in ~0.4s per case.

Referral code: tdgxqn9n

Built by @mamamuda-wikwik for
[make.fun's GTA VI Twitch forecast bounty](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
($250 USDC).
