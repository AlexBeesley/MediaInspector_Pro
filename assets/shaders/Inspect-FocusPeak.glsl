//!HOOK MAIN
//!BIND HOOKED
//!DESC Inspect: focus peaking (Sobel edge highlight)

// Answers "is this frame actually sharp?" without pixel-peeping at 400%.
// A Sobel operator measures the luma gradient at every pixel; wherever it
// exceeds THRESHOLD the pixel is painted acid green. In-focus subjects
// light up with a dense green rim, out-of-focus ones stay bare - which is
// far easier to judge across a burst of frames than comparing crops.
//
// The picture underneath is desaturated first. That is not decoration: with
// the source at full saturation, green foliage and green overlay are
// indistinguishable, and the whole point is a signal you can trust.
//
// Gradient is computed on luma only, so it responds to detail rather than
// to colour boundaries at equal brightness - which is what a lens is doing.

#define THRESHOLD 0.055   // gradient magnitude where peaking starts
#define KNEE      2.0     // fully green at THRESHOLD * KNEE
#define DESAT     0.75    // 0 = keep colour, 1 = fully grey backdrop
#define PEAK_COL  vec3(0.15, 1.0, 0.20)

#define LUMA vec3(0.2126, 0.7152, 0.0722)

float lum(vec2 o) { return dot(HOOKED_texOff(o).rgb, LUMA); }

vec4 hook() {
    vec4 c = HOOKED_texOff(vec2(0.0));

    float tl = lum(vec2(-1.0, -1.0)), tc = lum(vec2(0.0, -1.0)), tr = lum(vec2(1.0, -1.0));
    float ml = lum(vec2(-1.0,  0.0)),                            mr = lum(vec2(1.0,  0.0));
    float bl = lum(vec2(-1.0,  1.0)), bc = lum(vec2(0.0,  1.0)), br = lum(vec2(1.0,  1.0));

    float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
    float gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
    float g  = length(vec2(gx, gy));

    float k    = smoothstep(THRESHOLD, THRESHOLD * KNEE, g);
    vec3  base = mix(c.rgb, vec3(dot(c.rgb, LUMA)), DESAT);

    return vec4(mix(base, PEAK_COL, k), c.a);
}
