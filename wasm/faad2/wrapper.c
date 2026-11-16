/*
 * DAB+ AAC decoding for BrowSDR: a thin wrapper around faad2 (GPL-2.0-or-later) for the access units of a DAB+
 * audio superframe (ETSI TS 102 563): AAC-LC with 960-sample frames, with SBR (HE-AAC) and parametric stereo
 * (HE-AAC v2) signalled in the AudioSpecificConfig. The configuration follows OnAir's DAB receiver
 * (core/src/dab/dab_audio.cpp): float output, no down-matrix, implicit SBR upsampled.
 *
 * Output is interleaved stereo float at the decoder's output rate (32 or 48 kHz; mono is duplicated).
 */
#include <neaacdec.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    NeAACDecHandle handle;
    unsigned long rate;
    unsigned char channels;
    unsigned char sbr;
    unsigned char ps;
    unsigned char error;
} dab_aac;

dab_aac *dab_aac_open(unsigned char *asc, int length) {
    dab_aac *d = (dab_aac *)calloc(1, sizeof(dab_aac));
    if (!d) return 0;
    d->handle = NeAACDecOpen();
    if (!d->handle) {
        free(d);
        return 0;
    }
    NeAACDecConfigurationPtr config = NeAACDecGetCurrentConfiguration(d->handle);
    config->outputFormat = FAAD_FMT_FLOAT;
    config->downMatrix = 0;
    config->dontUpSampleImplicitSBR = 0;
    NeAACDecSetConfiguration(d->handle, config);
    if (NeAACDecInit2(d->handle, asc, (unsigned long)length, &d->rate, &d->channels) < 0) {
        NeAACDecClose(d->handle);
        free(d);
        return 0;
    }
    return d;
}

/* Decodes one access unit into `out` (room for `max_frames` stereo frames). Returns the stereo frames written,
 * or -1 on a decoder error (the error code is kept for dab_aac_error). */
int dab_aac_decode(dab_aac *d, unsigned char *au, int length, float *out, int max_frames) {
    NeAACDecFrameInfo info;
    memset(&info, 0, sizeof info);
    float *pcm = (float *)NeAACDecDecode(d->handle, &info, au, (unsigned long)length);
    d->error = info.error;
    if (info.error || !pcm || info.channels == 0) return -1;
    d->rate = info.samplerate;
    d->sbr = info.sbr;
    d->ps = info.ps;
    d->channels = info.channels;
    int frames = (int)(info.samples / info.channels);
    if (frames > max_frames) frames = max_frames;
    for (int i = 0; i < frames; i++) {
        float left = pcm[i * info.channels];
        float right = info.channels > 1 ? pcm[i * info.channels + 1] : left;
        out[2 * i] = left;
        out[2 * i + 1] = right;
    }
    return frames;
}

int dab_aac_rate(dab_aac *d) { return (int)d->rate; }
int dab_aac_channels(dab_aac *d) { return d->channels; }
int dab_aac_error(dab_aac *d) { return d->error; }
int dab_aac_sbr(dab_aac *d) { return d->sbr; }
int dab_aac_ps(dab_aac *d) { return d->ps; }

void dab_aac_close(dab_aac *d) {
    if (!d) return;
    NeAACDecClose(d->handle);
    free(d);
}
