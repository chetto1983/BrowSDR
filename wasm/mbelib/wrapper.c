/*
 * Thin WASM wrapper for mbelib voice codec library.
 * Exposes AMBE 3600x2450 and IMBE 7200x4400 decoding for DSD, and AMBE 2450
 * parameter decoding for 49 bits whose error correction was done by the caller
 * (Yaesu System Fusion V/D mode 2).
 *
 * Build: emcc -O3 -s WASM=1 -s MODULARIZE=1 -s EXPORT_NAME='MbelibModule' \
 *        -s EXPORTED_FUNCTIONS='[...]' -s EXPORTED_RUNTIME_METHODS='[...]' \
 *        -o mbelib.js wrapper.c mbelib/*.c
 */

#include <string.h>
#include "mbelib/mbelib.h"

/* Persistent decoder state — one instance for the entire worker */
static mbe_parms curMp;
static mbe_parms prevMp;
static mbe_parms prevMpEnhanced;
static int initialized = 0;

/* Scratch buffers */
static short audio_out[160]; /* 160 samples per frame @ 8 kHz */
static int errs;
static int errs2;
static char err_str[64];

void mbelib_init(void) {
    mbe_initMbeParms(&curMp, &prevMp, &prevMpEnhanced);
    initialized = 1;
}

void mbelib_reset(void) {
    mbe_initMbeParms(&curMp, &prevMp, &prevMpEnhanced);
}

/*
 * Decode an AMBE 3600x2450 voice frame (DMR, D-STAR, NXDN).
 *
 * ambe_fr: 4x24 bit matrix (96 bytes, row-major)
 * audio:   output buffer for 160 float samples
 *
 * Returns error count.
 */
int mbelib_decode_ambe(const char *ambe_fr_flat, float *audio) {
    if (!initialized) mbelib_init();

    char ambe_fr[4][24];
    for (int i = 0; i < 4; i++)
        memcpy(ambe_fr[i], ambe_fr_flat + i * 24, 24);

    char ambe_d[49];
    memset(ambe_d, 0, sizeof(ambe_d));

    errs = 0;
    errs2 = 0;

    mbe_processAmbe3600x2450Frame(audio_out, &errs, &errs2, err_str,
                                   ambe_fr, ambe_d,
                                   &curMp, &prevMp, &prevMpEnhanced, 3);

    /* Convert int16 to float */
    for (int i = 0; i < 160; i++)
        audio[i] = (float)audio_out[i] / 32768.0f;

    return errs + errs2;
}

/*
 * Decode an IMBE 7200x4400 voice frame (P25 Phase 1).
 *
 * imbe_fr: 8x23 bit matrix (184 bytes, row-major)
 * audio:   output buffer for 160 float samples
 *
 * Returns error count.
 */
int mbelib_decode_imbe(const char *imbe_fr_flat, float *audio) {
    if (!initialized) mbelib_init();

    char imbe_fr[8][23];
    for (int i = 0; i < 8; i++)
        memcpy(imbe_fr[i], imbe_fr_flat + i * 23, 23);

    char imbe_d[88];
    memset(imbe_d, 0, sizeof(imbe_d));

    errs = 0;
    errs2 = 0;

    mbe_processImbe7200x4400Frame(audio_out, &errs, &errs2, err_str,
                                    imbe_fr, imbe_d,
                                    &curMp, &prevMp, &prevMpEnhanced, 3);

    /* Convert int16 to float */
    for (int i = 0; i < 160; i++)
        audio[i] = (float)audio_out[i] / 32768.0f;

    return errs + errs2;
}

/*
 * Decode 49 AMBE 3600x2450 parameter bits (mbelib's ambe_d order: 12 C0 data
 * bits, 12 C1 data bits, 11 C2 bits, 14 C3 bits) that the caller has already
 * error-corrected, e.g. Yaesu System Fusion V/D mode 2 voice after its
 * majority vote.
 *
 * ambe_d: 49 bytes, one bit each
 * errors: bit errors the caller found; above 3 mbelib repeats the last frame
 * audio:  output buffer for 160 float samples
 *
 * Returns the error count used.
 */
int mbelib_decode_ambe2450_data(const char *ambe_d_in, int errors, float *audio) {
    if (!initialized) mbelib_init();

    char ambe_d[49];
    memcpy(ambe_d, ambe_d_in, 49);

    /* err_str receives one character per error: keep it inside its 64 bytes. */
    if (errors < 0) errors = 0;
    if (errors > 48) errors = 48;
    errs = errors;
    errs2 = errors;

    mbe_processAmbe2450Data(audio_out, &errs, &errs2, err_str, ambe_d,
                            &curMp, &prevMp, &prevMpEnhanced, 3);

    /* Convert int16 to float */
    for (int i = 0; i < 160; i++)
        audio[i] = (float)audio_out[i] / 32768.0f;

    return errs2;
}

/*
 * Get the last error string from mbelib (up to 64 chars).
 */
const char *mbelib_get_err_str(void) {
    return err_str;
}

/*
 * Get the last error counts.
 */
int mbelib_get_errs(void) { return errs; }
int mbelib_get_errs2(void) { return errs2; }
