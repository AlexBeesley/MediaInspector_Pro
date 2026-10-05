//!HOOK MAIN
//!BIND HOOKED
//!DESC Inspect: clipping zebras (blown highlights / crushed blacks)

// The broadcast-monitor zebra pattern. Anywhere a channel has hit the top
// of the scale - detail that no grade will ever bring back - gets red
// diagonal stripes; anywhere every channel has hit the bottom gets blue
// ones. Everything in range passes through untouched, so this can be left
// on while scrubbing.
//
// Stripes rather than a flat tint on purpose: a solid overlay hides which
// way the clipped region is shaped, and on a still frame a flat red patch
// is easy to mistake for red content. The stripes let the picture show
// through between them.
//
// Tested per channel for highlights (a blown red channel is clipped even if
// the pixel is not white) but on all channels for blacks (one channel at
// zero is normal in saturated colour; all three at zero is crushed).

#define HI      0.98   // at or above this = blown
#define LO      0.02   // at or below this = crushed
#define PERIOD  14.0   // stripe spacing in pixels
#define MIX     0.65   // how opaque the stripe is

vec4 hook() {
    vec4 c  = HOOKED_texOff(vec2(0.0));
    vec2 px = HOOKED_pos * HOOKED_size;

    float stripe = step(0.5, fract((px.x + px.y) / PERIOD));

    float hi = step(HI, max(max(c.r, c.g), c.b));
    float lo = 1.0 - step(LO, max(max(c.r, c.g), c.b));

    vec3 res = c.rgb;
    res = mix(res, vec3(1.0, 0.10, 0.10), hi * stripe * MIX);
    res = mix(res, vec3(0.20, 0.45, 1.0), lo * stripe * MIX);
    return vec4(res, c.a);
}
