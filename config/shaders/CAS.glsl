//!HOOK MAIN
//!BIND HOOKED
//!DESC Contrast Adaptive Sharpening (moderate)

// AMD FidelityFX CAS, ported for mpv/libplacebo user shaders.
//
// Why this and not a plain unsharp mask: CAS measures the local contrast
// around every pixel and sharpens *in inverse proportion* to it. Flat sky
// gets almost nothing, edges get a lot, and already-blown highlights get
// none - so upscaled footage picks up definition without the white halos an
// unsharp mask leaves along every high-contrast border.
//
// Runs on MAIN, i.e. after the scaler has done its work, which is where CAS
// is designed to sit: it restores the detail scaling softened, rather than
// pre-sharpening detail that scaling would then smear.

// 0.0 = gentlest, 1.0 = strongest. See CAS-Strong.glsl for the other end.
#define SHARPNESS 0.6

vec4 hook() {
    vec4 ec = HOOKED_texOff(vec2( 0.0,  0.0));

    vec3 a = HOOKED_texOff(vec2(-1.0, -1.0)).rgb;
    vec3 b = HOOKED_texOff(vec2( 0.0, -1.0)).rgb;
    vec3 c = HOOKED_texOff(vec2( 1.0, -1.0)).rgb;
    vec3 d = HOOKED_texOff(vec2(-1.0,  0.0)).rgb;
    vec3 e = ec.rgb;
    vec3 f = HOOKED_texOff(vec2( 1.0,  0.0)).rgb;
    vec3 g = HOOKED_texOff(vec2(-1.0,  1.0)).rgb;
    vec3 h = HOOKED_texOff(vec2( 0.0,  1.0)).rgb;
    vec3 i = HOOKED_texOff(vec2( 1.0,  1.0)).rgb;

    // Soft min/max: the cross first, then folded together with the corners.
    // Both end up on a 0..2 scale, which is what the 2.0 - mx below assumes.
    vec3 mn = min(min(min(d, e), min(f, b)), h);
    mn += min(mn, min(min(a, c), min(g, i)));

    vec3 mx = max(max(max(d, e), max(f, b)), h);
    mx += max(mx, max(max(a, c), max(g, i)));

    // Headroom on both ends - whichever side is closer to clipping wins, so
    // the filter never pushes a pixel past black or white.
    vec3 amp = clamp(min(mn, 2.0 - mx) / max(mx, vec3(1.0 / 65536.0)), 0.0, 1.0);
    amp = sqrt(amp);

    float peak = -1.0 / mix(8.0, 5.0, clamp(SHARPNESS, 0.0, 1.0));
    vec3 w = amp * peak;
    vec3 rcp_w = 1.0 / (1.0 + 4.0 * w);

    vec3 o = (b * w + d * w + f * w + h * w + e) * rcp_w;
    return vec4(clamp(o, 0.0, 1.0), ec.a);
}
