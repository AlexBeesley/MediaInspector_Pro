//!HOOK MAIN
//!BIND HOOKED
//!DESC Deband (removes banding in gradients)

// Kills the concentric "contour lines" that show up in skies, fades and any
// slow gradient once 8-bit quantisation is stretched by scaling or a bright
// display. Same idea as mpv's built-in --deband, kept as a shader so it can
// be ticked per-session from the panel and so it also reaches photos.
//
// How it works: four neighbours are sampled a long way out (RADIUS px) on a
// randomly rotated cross. If all four are within THRESHOLD of the centre -
// which is what a band is, a wide plateau one code value from its
// neighbours - the pixel is replaced by their average, and the step
// dissolves into a slope. Anything with real detail fails that test and is
// left completely alone, per colour channel.
//
// Filename starts with 01 on purpose: the panel applies shaders in the
// order it lists them, which is alphabetical, and debanding has to happen
// before sharpening or CAS will simply sharpen the band edges.

// Max difference (0-1) still considered flat. 0.004 is about one 8-bit step.
#define THRESHOLD 0.004
// How far out to look, in pixels. Must exceed the width of a band.
#define RADIUS    18.0
// Dither amplitude, added everywhere. Breaks up whatever banding survives.
#define GRAIN     0.0016

// Deterministic per-pixel noise. A hash of the coordinate rather than the
// `random` uniform, so the pattern is stable frame to frame - on a paused
// frame or a photo, which is most of what this player is used for, a
// shimmering dither pattern is worse than a fixed one.
float mi_hash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}

vec4 hook() {
    vec4 col = HOOKED_texOff(vec2(0.0));
    vec2 px  = HOOKED_pos * HOOKED_size;

    float ang = mi_hash(px) * 6.2831853;
    float rad = RADIUS * (0.6 + 0.4 * mi_hash(px + 17.31));
    vec2  o1  = vec2(cos(ang), sin(ang)) * rad;
    vec2  o2  = vec2(-o1.y, o1.x);

    vec3 s1 = HOOKED_texOff( o1).rgb;
    vec3 s2 = HOOKED_texOff(-o1).rgb;
    vec3 s3 = HOOKED_texOff( o2).rgb;
    vec3 s4 = HOOKED_texOff(-o2).rgb;

    vec3 avg  = (s1 + s2 + s3 + s4) * 0.25;
    vec3 diff = max(max(abs(col.rgb - s1), abs(col.rgb - s2)),
                    max(abs(col.rgb - s3), abs(col.rgb - s4)));

    // step(diff, T) is 1 where diff <= T, i.e. where the area is flat.
    vec3 res = mix(col.rgb, avg, step(diff, vec3(THRESHOLD)));

    res += (mi_hash(px * 1.7 + 3.14) - 0.5) * GRAIN;
    return vec4(clamp(res, 0.0, 1.0), col.a);
}
