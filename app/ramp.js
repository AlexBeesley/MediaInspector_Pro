'use strict';
// Speed ramp: the curve, and turning it into a clip.
//
// evaluate() is the same curve the player follows live (fx.ramp_eval in
// config/scripts/mediainspector.lua): smoothstep between points in log-speed,
// flat outside them. The two have to agree, or the export would not be the
// ramp that was previewed.
//
// The export retimes the source with one setpts expression. Each piece of the
// range contributes clip(T - start, 0, length) / speed to the output time, so
// the sum is the ramped clock with no nesting, however many pieces there are.
// Flat stretches are one piece; the eased transitions are cut finely enough
// that the steps are below a frame.

const MIN_SPEED = 0.05;
const MAX_SPEED = 8;

function normalise(points) {
  return (points || [])
    .map((p) => [Number(p[0]), Math.max(MIN_SPEED, Math.min(MAX_SPEED, Number(p[1])))])
    .filter((p) => isFinite(p[0]) && isFinite(p[1]))
    .sort((a, b) => a[0] - b[0]);
}

function evaluate(pts, t) {
  const n = pts.length;
  if (!n) return 1;
  if (t <= pts[0][0]) return pts[0][1];
  if (t >= pts[n - 1][0]) return pts[n - 1][1];
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (t < b[0]) {
      let u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      u = u * u * (3 - 2 * u);
      return Math.exp(Math.log(a[1]) + (Math.log(b[1]) - Math.log(a[1])) * u);
    }
  }
  return pts[n - 1][1];
}

// Seconds of output a stretch of source occupies: the integral of 1/speed,
// by Simpson's rule, which is exact for the flat parts and closer than a
// frame for the eased ones at these lengths.
function outputSeconds(pts, t0, t1) {
  const h = (t1 - t0) / 2;
  return (h / 3) * (1 / evaluate(pts, t0) + 4 / evaluate(pts, t0 + h) + 1 / evaluate(pts, t1));
}

// [{ t0, len, speed }] covering [a, b], where speed is the effective speed of
// that piece - its length over the output time it takes.
function segments(points, a, b, step = 1 / 48) {
  const pts = normalise(points);
  const cuts = [a, ...pts.map((p) => p[0]).filter((t) => t > a && t < b), b];
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const s0 = cuts[i];
    const s1 = cuts[i + 1];
    if (s1 - s0 < 1e-6) continue;
    const flat = Math.abs(evaluate(pts, s0) - evaluate(pts, s1)) < 1e-4
      && Math.abs(evaluate(pts, (s0 + s1) / 2) - evaluate(pts, s0)) < 1e-4;
    const n = flat ? 1 : Math.max(1, Math.ceil((s1 - s0) / step));
    for (let k = 0; k < n; k++) {
      const t0 = s0 + ((s1 - s0) * k) / n;
      const t1 = s0 + ((s1 - s0) * (k + 1)) / n;
      out.push({ t0, len: t1 - t0, speed: (t1 - t0) / outputSeconds(pts, t0, t1) });
    }
  }
  return out;
}

const f6 = (v) => String(Math.round(v * 1e6) / 1e6);

// mpv applies --start and --end to the timestamps coming OUT of the filters,
// and drops anything before --start as part of its exact seek. So the ramped
// clock starts at `a` rather than zero, frames decoded from before `a` (the
// run-up from the keyframe) are pushed below it to be dropped, and frames
// past `b` keep moving at 1x so they cross --end and stop the decode, instead
// of all piling onto the last timestamp until the end of the file.
function setptsExpr(segs, a, b) {
  const terms = segs.map((s) => `clip(T-${f6(s.t0)},0,${f6(s.len)})/${f6(s.speed)}`);
  return `(${f6(a)}+min(T-${f6(a)},0)+${terms.join('+')}+max(T-${f6(b)},0))/TB`;
}

function plan(points, a, b) {
  const segs = segments(points, a, b);
  const out = segs.reduce((s, g) => s + g.len / g.speed, 0);
  return { segs, outSeconds: out, expr: setptsExpr(segs, a, b) };
}

module.exports = { evaluate, normalise, segments, setptsExpr, plan, MIN_SPEED, MAX_SPEED };
