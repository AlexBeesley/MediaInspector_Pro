//!HOOK MAIN
//!BIND HOOKED
//!DESC Bilateral denoise (edge-preserving)

// Cleans sensor noise and low-bitrate mosquito noise without turning the
// picture to plastic. A plain blur averages a 5x5 neighbourhood regardless
// of content, so edges go with the noise; a bilateral filter weights each
// tap twice - once by how far away it is (spatial), once by how different
// its brightness is (range). A neighbour across an edge is bright-different,
// gets a near-zero weight, and never bleeds across. Inside a flat noisy
// patch every tap is similar, so the full 25-tap average applies.
//
// Range weighting is on luma alone rather than per channel: chroma noise is
// the part worth crushing hardest, and judging similarity by luma lets the
// filter average colour freely inside an area of constant brightness.
//
// Prefixed 02 so it runs after deband and before CAS - denoise then
// sharpen, never the other way round.

// Spatial falloff in pixels. Larger = softer.
#define SIGMA_S 2.0
// Brightness tolerance, 0-1. Larger = more aggressive, softer edges.
// 0.075 is roughly "ignore differences under 19/255".
#define SIGMA_R 0.075
// Half window. 2 = 5x5 = 25 taps.
#define RADIUS  2

#define LUMA vec3(0.2126, 0.7152, 0.0722)

vec4 hook() {
    vec4  c   = HOOKED_texOff(vec2(0.0));
    float lc  = dot(c.rgb, LUMA);

    vec3  sum  = vec3(0.0);
    float wsum = 0.0;

    for (int y = -RADIUS; y <= RADIUS; y++) {
        for (int x = -RADIUS; x <= RADIUS; x++) {
            vec3  s  = HOOKED_texOff(vec2(float(x), float(y))).rgb;
            float ls = dot(s, LUMA);
            float d2 = float(x * x + y * y);
            float dl = ls - lc;

            float w = exp(-d2 / (2.0 * SIGMA_S * SIGMA_S))
                    * exp(-(dl * dl) / (2.0 * SIGMA_R * SIGMA_R));

            sum  += s * w;
            wsum += w;
        }
    }

    return vec4(sum / max(wsum, 1e-6), c.a);
}
