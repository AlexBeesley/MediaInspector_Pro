//!HOOK MAIN
//!BIND HOOKED
//!DESC Inspect: chroma boost (exaggerated saturation)

// Pushes saturation hard while leaving brightness alone, which exposes
// everything that hides in the colour channels at normal saturation:
//
//   * chroma noise - coloured speckle in shadows, the first thing a high
//     ISO gives up, invisible until amplified
//   * 4:2:0 subsampling - colour carried at quarter resolution, so it
//     smears across sharp edges; red-on-black text is the classic tell
//   * chroma banding and blocking from a low bitrate encode
//   * white balance drift across a clip, and any tint in what should be
//     neutral grey
//
// Deliberately not a "make it prettier" filter - at BOOST 4 the output is
// not meant to be watchable. Luma is preserved exactly so the boost cannot
// be confused with an exposure change.

#define BOOST 4.0

#define LUMA vec3(0.2126, 0.7152, 0.0722)

vec4 hook() {
    vec4  c = HOOKED_texOff(vec2(0.0));
    float l = dot(c.rgb, LUMA);
    vec3  res = vec3(l) + (c.rgb - vec3(l)) * BOOST;
    return vec4(clamp(res, 0.0, 1.0), c.a);
}
