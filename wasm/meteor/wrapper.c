/*
 * BrowSDR's WebAssembly interface to meteor_decode (https://github.com/dbdexter-dev/meteor_decode).
 *
 * The upstream decoder pulls soft QPSK symbols through a read callback. BrowSDR pushes symbols as they
 * are demodulated, so this wrapper queues them and runs the decoder only while a whole CADU, plus the
 * resynchronisation slack the decoder may read on top of it, is waiting. The MPDU-to-image steps
 * (process_mpdu and preferred_channel) are adapted from upstream main.c, without the file output and
 * the APID 70 calibration dump.
 *
 * meteor_decode: Copyright (c) 2021 dbdexter-dev, MIT licence (see pkg/LICENSE).
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>
#include "channel.h"
#include "decode.h"
#include "parser/mcu_parser.h"
#include "protocol/cadu.h"
#include "protocol/mpdu.h"

#define NUM_CHANNELS 3
/* A CADU's worth of soft symbols, plus up to the same again that the correlator may ask for. */
#define READ_RESERVE (2 * CADU_SOFT_LEN)
#define QUEUE_SIZE (8 * CADU_SOFT_LEN)
#define INPUT_SIZE (4 * CADU_SOFT_LEN)

static Channel channels[NUM_CHANNELS];
static int8_t queue[QUEUE_SIZE];
static size_t queue_len, queue_pos;
static int8_t input[INPUT_SIZE];
static uint64_t first_time, last_time;
static int first, mpdus;

static int
read_queue(int8_t *dst, size_t len)
{
	if (queue_len - queue_pos < len) return 0;
	memcpy(dst, queue + queue_pos, len);
	queue_pos += len;
	return 1;
}

static int
preferred_channel(int apid)
{
	switch (apid) {
		case 64: return 2;
		case 65: return 1;
		case 66: return 0;
		case 67: return 1;
		case 68: return 0;
		case 69: return 2;
		default: return 0;
	}
}

/* Pick the image channel for an AVHRR APID: its own, else its preferred one if free, else any free one. */
static int
channel_for(int apid)
{
	int i;

	for (i = 0; i < NUM_CHANNELS; i++) if (channels[i].apid == apid) return i;
	i = preferred_channel(apid);
	if (channels[i].apid < 0) {
		channels[i].apid = apid;
		return i;
	}
	for (i = 0; i < NUM_CHANNELS; i++) {
		if (channels[i].apid < 0) {
			channels[i].apid = apid;
			return i;
		}
	}
	return -1;
}

static void
process_mpdu(Mpdu *mpdu)
{
	uint8_t strip[MCU_PER_MPDU][8][8];
	unsigned int seq = mpdu_seq(mpdu), apid = mpdu_apid(mpdu), lines_lost;
	uint64_t time = mpdu_raw_time(mpdu);
	int i;

	if (first) first_time = time;
	first = 0;
	/* After a satellite reboot its clock can jump backwards: discard those packets. */
	if (time < first_time && first_time - time < US_PER_DAY / 2) return;
	last_time = time;
	if (apid < 64 || apid > 69) return;
	if ((i = channel_for(apid)) < 0) return;

	avhrr_decode(strip, &mpdu->data.mcu.avhrr, mpdu_len(mpdu));
	/* Estimate the lines this channel missed compared with the others from the timestamps. */
	if (channels[i].mpdu_seq < 0) {
		lines_lost = (last_time - first_time) / MPDU_US_PER_LINE;
		channels[i].mpdu_seq = (seq - MPDU_PER_PERIOD * lines_lost - 1 + MPDU_MAX_SEQ) % MPDU_MAX_SEQ;
	}
	channel_append_strip(&channels[i], strip, mpdu->data.mcu.avhrr.seq, seq);
}

EMSCRIPTEN_KEEPALIVE int
meteor_rows(void)
{
	unsigned long offset = 0;
	int i;

	for (i = 0; i < NUM_CHANNELS; i++) if (channels[i].offset > offset) offset = channels[i].offset;
	return offset / (MCU_PER_LINE * 8);
}

EMSCRIPTEN_KEEPALIVE void
meteor_init(void)
{
	int i;

	for (i = 0; i < NUM_CHANNELS; i++) channel_init(&channels[i], -1);
	decode_init(0, 0);
	queue_len = queue_pos = 0;
	first = 1;
	mpdus = 0;
	first_time = last_time = 0;
}

EMSCRIPTEN_KEEPALIVE void
meteor_reset(void)
{
	int i;

	for (i = 0; i < NUM_CHANNELS; i++) channel_close(&channels[i]);
	meteor_init();
}

/* Where the caller writes up to INPUT_SIZE soft symbols before meteor_push(). */
EMSCRIPTEN_KEEPALIVE int8_t *
meteor_input(void)
{
	return input;
}

EMSCRIPTEN_KEEPALIVE int
meteor_input_size(void)
{
	return INPUT_SIZE;
}

/* Queue n symbols from meteor_input() and decode what the queue allows; returns the new image rows. */
EMSCRIPTEN_KEEPALIVE int
meteor_push(int n)
{
	int rows = meteor_rows();
	Mpdu mpdu;

	if (n < 0 || n > INPUT_SIZE) return -1;
	if (queue_pos) {
		memmove(queue, queue + queue_pos, queue_len - queue_pos);
		queue_len -= queue_pos;
		queue_pos = 0;
	}
	memcpy(queue + queue_len, input, n);
	queue_len += n;
	while (queue_len - queue_pos >= READ_RESERVE) {
		if (decode_soft_cadu(&mpdu, read_queue) == MPDU_READY) {
			process_mpdu(&mpdu);
			mpdus++;
		}
	}
	return meteor_rows() - rows;
}

EMSCRIPTEN_KEEPALIVE int meteor_width(void) { return MCU_PER_LINE * 8; }
EMSCRIPTEN_KEEPALIVE uint8_t *meteor_channel(int i) { return i >= 0 && i < NUM_CHANNELS ? channels[i].pixels : NULL; }
EMSCRIPTEN_KEEPALIVE int meteor_apid(int i) { return i >= 0 && i < NUM_CHANNELS ? channels[i].apid : -1; }
EMSCRIPTEN_KEEPALIVE int meteor_rs(void) { return decode_get_rs(); }
EMSCRIPTEN_KEEPALIVE int meteor_vit(void) { return decode_get_vit(); }
EMSCRIPTEN_KEEPALIVE uint32_t meteor_vcdu_seq(void) { return decode_get_vcdu_seq(); }
EMSCRIPTEN_KEEPALIVE int meteor_mpdus(void) { return mpdus; }
