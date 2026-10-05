//!HOOK MAIN
//!BIND HOOKED
//!DESC Inspect: false colour exposure map

// The exposure tool from a cinema monitor. Luma is bucketed into bands and
// each band is painted a flat colour, so a glance tells you where the frame
// sits on the scale instead of guessing from a picture your eyes have
// already adapted to.
//
//   purple  clipped / crushed black - nothing recoverable below here
//   blue    deep shadow, close to the floor
//   grey    ordinary shadow and midtone (the image's own luma, so shape
//           and detail stay readable between the marked zones)
//   green   18% middle grey - park a grey card or a lit face's key side here
//   pink    caucasian skin tone zone, roughly 55-70 IRE
//   yellow  one stop from clipping - the warning band
//   red     clipped white
//
// Read on the encoded signal, not on scene light: the bands line up with
// IRE on ordinary SDR material, but on an HDR source (or with a LUT ahead
// of it) the numbers mean something else and only the red/purple ends stay
// meaningful.

#define LUMA vec3(0.2126, 0.7152, 0.0722)

vec4 hook() {
    vec4  c = HOOKED_texOff(vec2(0.0));
    float l = dot(c.rgb, LUMA);

    vec3 grey = vec3(l);
    vec3 res;

    if      (l < 0.025) res = vec3(0.45, 0.00, 0.60);   // clipped black
    else if (l < 0.100) res = vec3(0.00, 0.30, 1.00);   // deep shadow
    else if (l < 0.380) res = grey;
    else if (l < 0.450) res = vec3(0.00, 0.85, 0.20);   // 18% grey
    else if (l < 0.560) res = grey;
    else if (l < 0.700) res = vec3(1.00, 0.45, 0.70);   // skin tone
    else if (l < 0.900) res = grey;
    else if (l < 0.975) res = vec3(1.00, 0.90, 0.00);   // near clip
    else                res = vec3(1.00, 0.05, 0.05);   // clipped white

    return vec4(res, c.a);
}
