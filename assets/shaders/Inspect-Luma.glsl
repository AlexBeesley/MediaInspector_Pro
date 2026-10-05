//!HOOK MAIN
//!BIND HOOKED
//!DESC Inspect: luma only (chroma discarded)

// Throws away colour and shows the Rec.709 luminance the picture is built
// on. Useful because colour dominates perception: noise, softness,
// compression blocking and banding are all far easier to see once hue and
// saturation stop competing for attention. Pair with Inspect-ChromaBoost to
// look at the other half separately.
//
// Rec.709 weights rather than a flat average - the eye is roughly seven
// times more sensitive to green than to blue, and an unweighted mean makes
// a saturated blue read far brighter here than it does in the picture.

#define LUMA vec3(0.2126, 0.7152, 0.0722)

vec4 hook() {
    vec4 c = HOOKED_texOff(vec2(0.0));
    return vec4(vec3(dot(c.rgb, LUMA)), c.a);
}
