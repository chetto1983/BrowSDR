/* Codec2 1.2.0 WASM bridge for M17. Codec2 is LGPL-2.1, separately built. */
#include <stdint.h>
#include <codec2.h>

static struct CODEC2 *c3200;
static struct CODEC2 *c1600;
static short pcm[320];

int browsdr_codec2_init(void) {
    c3200 = codec2_create(CODEC2_MODE_3200);
    c1600 = codec2_create(CODEC2_MODE_1600);
    return c3200 && c1600 && codec2_samples_per_frame(c3200) == 160 &&
           codec2_samples_per_frame(c1600) == 320 &&
           codec2_bits_per_frame(c3200) == 64 && codec2_bits_per_frame(c1600) == 64;
}

int browsdr_codec2_decode(int rate, const uint8_t *bits, float *output) {
    struct CODEC2 *decoder = rate == 1600 ? c1600 : rate == 3200 ? c3200 : 0;
    if (!decoder || !bits || !output) return 0;
    codec2_decode(decoder, pcm, bits);
    const int count = codec2_samples_per_frame(decoder);
    for (int i = 0; i < count; i++) output[i] = (float)pcm[i] / 32768.f;
    return count;
}

void browsdr_codec2_reset(void) {
    if (c3200) codec2_destroy(c3200);
    if (c1600) codec2_destroy(c1600);
    c3200 = c1600 = 0;
    browsdr_codec2_init();
}
