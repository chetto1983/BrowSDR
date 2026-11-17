# OnAir code in BrowSDR

Some BrowSDR decoders are ported from **OnAir**, https://github.com/adswill/OnAir
(revision `a9b7e87583674f2d11a941487f0644a95fef938c`, 16 November 2026).

> Based on OnAir by Kristijonas Adomaitis - https://on-air.dev
>
> OnAir contributors: https://github.com/adswill/OnAir/blob/main/CONTRIBUTORS.md

## Licence

OnAir is GPL-3.0-or-later with the attribution terms of [ADDITIONAL-TERMS.md](ADDITIONAL-TERMS.md)
(GPL section 7(b)). The ported files keep that licence and carry these notices:

```
SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
SPDX-License-Identifier: GPL-3.0-or-later
```

plus the OnAir file they come from. BrowSDR as a whole is AGPL-3.0; GPL-3.0 section 13 allows
combining the two, and each part keeps its own licence. The attribution above is shown in
BrowSDR's About dialog, as the additional terms require. [NOTICE.md](NOTICE.md),
[ADDITIONAL-TERMS.md](ADDITIONAL-TERMS.md) and [CONTRIBUTORS.md](CONTRIBUTORS.md) are verbatim
copies from that revision.

The OnAir name and logo are not part of the licence and are not used by BrowSDR.

## Ported files

The C++ and Rust code was translated to TypeScript for the browser (changes are noted in each
file). Algorithms and protocol tables follow the OnAir source.

| BrowSDR file | From OnAir |
| ------------ | ---------- |
| `src/client/worker/decoders/digimode/dsc/slicers.ts` | `core/src/marine/marine_dsp.cpp` (ToneSlicer, VhfSlicer, FskSlicer, lowpass) |
| `src/client/worker/decoders/digimode/dsc/symbols.ts` | `core/src/marine/marine_dsc.cpp` (symbols, number fields, builders), `marine_mmsi.cpp` (MMSI kinds) |
| `src/client/worker/decoders/digimode/dsc/call.ts` | `core/src/marine/marine_dsc.cpp` (dscCallKind, dscParseCall) |
| `src/client/worker/decoders/digimode/dsc/decoder.ts` | `core/src/marine/marine_dsc.cpp` (DscDecoder) |
| `src/client/worker/decoders/digimode/dsc/types.ts` | `core/include/dect2/marine/marine_tel.h` (DscCall) |
| `src/client/worker/decoders/digimode/dsc/index.ts` | `core/src/marine/marine_rx.cpp` (VHF DSC path) |
| `src/client/worker/decoders/digimode/cubesat/g3ruh.ts` | `core/include/dect2/packet/packet_demod.h` (FskSlicer) |
| `src/client/worker/decoders/digimode/cubesat/index.ts` | `core/src/cubesat/cubesat_rx.cpp` (receiver layout), `packet_demod.h` (FM front channel filter) |
| `src/client/worker/decoders/digimode/orbcomm/protocol.ts` | `core/include/dect2/orbcomm/orbcomm.h` (packet framing, Fletcher check, fields, ephemeris) |
| `src/client/worker/decoders/digimode/orbcomm/types.ts` | `core/include/dect2/orbcomm/orbcomm.h` (packet shapes) |
| `src/client/worker/decoders/digimode/orbcomm/demodulator.ts` | `core/src/orbcomm/orbcomm_rx.cpp` (RRC filter, SDPSK, Gardner timing); streaming carrier estimate adapted for one VFO |
| `src/client/worker/decoders/digimode/orbcomm/receiver.ts` | `core/src/orbcomm/orbcomm_rx.cpp` (sync, packet checks, message assembly) |
| `src/client/worker/decoders/dsd/p25p2/data.ts` | `core/src/p25p2/p25p2_proto.cpp` (ISCH words, DUID table, AMBE bit order, MAC message lengths) |
| `src/client/worker/decoders/dsd/p25p2/protocol.ts` | `core/src/p25p2/p25p2_proto.cpp` (ISCH, DUID, superframe scrambler and AMBE bit order; ISCH and DUID encoders, ESS, MAC PDU codewords as on the air, message lengths), `core/include/dect2/p25p2/p25p2_proto.h` (burst layout, opcodes, field offsets, rrcImpulse) |
| `src/client/worker/decoders/dsd/m17/protocol.ts` | `core/src/m17/m17_proto.cpp` (CRC, callsigns, Golay, convolutional code, puncturing, randomizer and interleaver) |
| `src/client/worker/decoders/dsd/m17/receiver.ts` | `core/src/m17/m17_rx.cpp` (symbol sync, LSF/stream/packet assembly) |
| `test/digimode/orbcomm/fixtures.js` | `core/src/orbcomm/orbcomm_gen.cpp` (test signal and packet builders) |
| `src/client/worker/decoders/digimode/sstv/modes.ts`, `types.ts` | `core/src/hfdig/hfdig_sstv_modes.h` |
| `src/client/worker/decoders/digimode/sstv/phase.ts` | `core/src/hfdig/hfdig_sstv.cpp` (front end), `hfdig_usb.h` (lowpass) |
| `src/client/worker/decoders/digimode/sstv/vis.ts` | `core/src/hfdig/hfdig_sstv.cpp` (VIS header and pulse log) |
| `src/client/worker/decoders/digimode/sstv/receiver.ts` | `core/src/hfdig/hfdig_sstv.cpp` (sync, slant fit, lines) |
| `src/client/worker/decoders/digimode/sstv/picture.ts` | `core/src/hfdig/hfdig_sstv.cpp` (picture noise filter) |
| `src/client/worker/decoders/digimode/sstv/index.ts` | after `core/src/hfdig/hfdig_sstv.cpp` (FM and USB audio for the decoder) |
| `src/client/worker/decoders/digimode/navtex/code.ts` | `core/src/marine/marine_navtex.cpp` (CCIR 476 code, subject names, encoder, SITOR-B slots) |
| `src/client/worker/decoders/digimode/navtex/decoder.ts` | `core/src/marine/marine_navtex.cpp` (NavtexDecoder) |
| `src/client/worker/decoders/digimode/navtex/spectrum.ts` | `core/src/marine/marine_dsp.cpp` (Spectrum, FSK centre finder) |
| `src/client/worker/decoders/digimode/navtex/types.ts` | `core/include/dect2/marine/marine_tel.h` (NavtexMessage), `marine_navtex.h`, `marine_dsp.h` |
| `src/client/worker/decoders/digimode/navtex/index.ts` | `core/src/marine/marine_rx.cpp` (NAVTEX path) |
| `src/client/worker/decoders/digimode/vdl2/bits.ts` | `rust/onair_vdl2/src/bits.rs` (scrambler, header code, burst layout), `core/src/vdl2/vdl2_proto.cpp` (training sequence, Gray map) |
| `src/client/worker/decoders/digimode/vdl2/rs.ts` | `rust/onair_vdl2/src/rs.rs` (Reed-Solomon (255,249) with erasures) |
| `src/client/worker/decoders/digimode/vdl2/burst.ts` | `rust/onair_vdl2/src/burst.rs` (interleaving, HDLC deframer, FCS), `core/src/vdl2/vdl2_proto_rs.cpp` |
| `src/client/worker/decoders/digimode/vdl2/avlc.ts` | `rust/onair_vdl2/src/avlc.rs` (addresses, control, parse_frame), `core/src/vdl2/vdl2_proto.cpp` (vdl2Frame) |
| `src/client/worker/decoders/digimode/vdl2/proto.ts` | `rust/onair_vdl2/src/proto.rs` (X.25, CLNP, COTP) |
| `src/client/worker/decoders/digimode/vdl2/xid.ts` | `rust/onair_vdl2/src/xid.rs` (XID parameters, GSIF) |
| `src/client/worker/decoders/digimode/vdl2/acars.ts` | `rust/onair_acars/src/block.rs`, `crc.rs`, `label.rs`, `core/src/vdl2/vdl2_proto.cpp` (readAcars) |
| `src/client/worker/decoders/digimode/vdl2/demod.ts` | `core/src/vdl2/vdl2_rx.cpp` (lowpass, interp, D8PSK demod) |
| `src/client/worker/decoders/digimode/vdl2/receiver.ts` | `core/src/vdl2/vdl2_rx.cpp` (Vdl2Receiver: mixer, burst search, burst state machine) |
| `src/client/worker/decoders/digimode/vdl2/types.ts` | `rust/onair_vdl2/src/bits.rs`, `avlc.rs`, `proto.rs`, `core/include/dect2/vdl2/vdl2_tel.h` (Vdl2Message), `rust/onair_acars/src/block.rs` |
| `src/client/worker/decoders/digimode/vdl2/index.ts` | after `core/src/vdl2/vdl2_rx.cpp` (one record per AVLC frame) |
| `test/digimode/vdl2-fixtures.js` | `core/src/vdl2/vdl2_gen.cpp` (burst waveform), `vdl2_proto.cpp` (builders), `core/src/acars/acars_proto.cpp` (acarsBuildFrame) |
| `src/client/worker/decoders/digimode/hfdl/types.ts` | `rust/onair_hfdl/src/phy.rs` (Rate), `stations.rs` (Station), `parse.rs` (Msg), `core/include/dect2/hfdl/hfdl_tel.h` (HfdlMessage, the burst and "why" counters), `core/src/hfdl/hfdl_rx.cpp` (the channel state) |
| `src/client/worker/decoders/digimode/hfdl/phy.ts` | `rust/onair_hfdl/src/phy.rs` (rates, A and M sequences, preamble, scrambler, interleaver, convolutional code, Viterbi decoder, FCS), `core/src/hfdl/hfdl_proto.cpp` (PSK maps, decisions, soft bits, hfdlDecodeSoft), `core/include/dect2/hfdl/hfdl_proto.h` (constants); protocol facts as credited there: [dumphfdl](https://github.com/szpajder/dumphfdl) (szpajder, GPL-3.0; read for reference, no code used) |
| `src/client/worker/decoders/digimode/hfdl/stations.ts` | `rust/onair_hfdl/src/stations.rs` (OnAir's built-in ground station table, frequency masks) |
| `src/client/worker/decoders/digimode/hfdl/parse.ts` | `rust/onair_hfdl/src/parse.rs` (SPDU, MPDU, LPDU, parse_pdu), `core/src/hfdl/hfdl_proto_rs.cpp` (hfdlParsePdu); protocol facts as credited there: dumphfdl (read for reference) |
| `src/client/worker/decoders/digimode/hfdl/hfnpdu.ts` | `rust/onair_hfdl/src/parse.rs` (HFNPDUs: performance and frequency data, positions, system table parts), `core/src/hfdl/hfdl_proto.cpp` (hfdlReadAcars, on the ACARS reader of `vdl2/acars.ts`) |
| `src/client/worker/decoders/digimode/hfdl/front.ts` | `core/src/hfdl/hfdl_rx.cpp` (matched filter, sample store, noise floor, cubicAt, trim), `core/include/dect2/dsp/rrc.h` (rrc) |
| `src/client/worker/decoders/digimode/hfdl/coarse.ts` | `core/src/hfdl/hfdl_rx.cpp` (coarseRefs, coarse: the burst search, computed with kept chunk magnitudes) |
| `src/client/worker/decoders/digimode/hfdl/search.ts` | `core/src/hfdl/hfdl_rx.cpp` (refProducts, corrAt, burst(): carrier, timing, A1 / A2 phase step, coherence check, M1) |
| `src/client/worker/decoders/digimode/hfdl/equalizer.ts` | `core/src/hfdl/hfdl_rx.cpp` (burst(): half-symbol samples, the equaliser and the gain / phase tracker) |
| `src/client/worker/decoders/digimode/hfdl/pilots.ts` | `core/src/hfdl/hfdl_rx.cpp` (burst(): the known-symbol decoder with its timing fit) |
| `src/client/worker/decoders/digimode/hfdl/burst.ts` | `core/src/hfdl/hfdl_rx.cpp` (burst(): the three modes in turn, soft bits, level, SNR, why a burst failed) |
| `src/client/worker/decoders/digimode/hfdl/receiver.ts` | `core/src/hfdl/hfdl_rx.cpp` (process, the search position rules, trim, the counters; one channel) |
| `src/client/worker/decoders/digimode/hfdl/report.ts` | `core/src/hfdl/hfdl_rx.cpp` (note, expire: the logon table, aircraft and ground stations), `core/include/dect2/limits.h` (kAeroStaleSec) |
| `src/client/worker/decoders/digimode/hfdl/index.ts` | `core/src/hfdl/hfdl_rx.cpp` (feed, the telemetry state, hfdlTuning), `core/include/dect2/hfdl/hfdl_tel.h` (hfdlSummary) |
| `test/digimode/hfdl/fixtures.js` | `core/src/hfdl/hfdl_gen.cpp` (waveform, HF channel, render, traffic), `core/src/hfdl/hfdl_proto.cpp` (hfdlBurst, PDU builders), `tests/hfdl/test_hfdl_rx.cpp` (play) |
| `test/digimode/hfdl/real-burst.txt` | `tests/data/hfdl/real_burst.h` (a real 600 bit/s burst received near Sydney) |
| `test/digimode/hfdl/proto.spec.js` | `tests/hfdl/test_hfdl_proto.cpp`, `test_hfdl_table.cpp`, `rust/onair_hfdl/src/tests.rs` |
| `test/digimode/hfdl/rx.spec.js` | `tests/hfdl/test_hfdl_rx.cpp`, `test_hfdl_weak.cpp`, `test_hfdl_why.cpp` |
| `test/digimode/hfdl/worker.spec.js` | `tests/hfdl/test_hfdl_real.cpp`, `test_hfdl_offset.cpp`, `test_hfdl_rx.cpp` (traffic) |
| `src/client/worker/decoders/digimode/tones/proto.ts` | `core/src/tones/tones_proto.cpp`, `core/include/dect2/tones/tones_proto.h` (CTCSS, DCS, DTMF, five-tone and SELCAL tables), `dtmf_numbers.h` (key group kinds) |
| `src/client/worker/decoders/digimode/tones/types.ts` | `core/include/dect2/tones/tones_proto.h` (SeqSet, DcsHit), `tones_tel.h` (ToneEvent) |
| `src/client/worker/decoders/digimode/tones/dsp.ts` | `core/src/tones/tones_rx.cpp` (Biquad, Goertzel, FFT, Hann windows), `core/include/dect2/dmr/dmr_dsp.h` (lowpassTaps) |
| `src/client/worker/decoders/digimode/tones/audio.ts` | `core/src/tones/tones_rx.cpp` (8 kHz and 1 kHz audio history) |
| `src/client/worker/decoders/digimode/tones/front.ts` | `core/src/packet/packet_demod.cpp` (FmFront discriminator), `core/src/tones/tones_rx.cpp` (audio filter to 8 kHz) |
| `src/client/worker/decoders/digimode/tones/subaudible.ts` | `core/src/tones/tones_rx.cpp` (CTCSS and DCS detectors) |
| `src/client/worker/decoders/digimode/tones/voice.ts` | `core/src/tones/tones_rx.cpp` (DTMF and five-tone sequential detectors) |
| `src/client/worker/decoders/digimode/tones/selcal.ts` | `core/src/tones/tones_rx.cpp` (SELCAL detector) |
| `src/client/worker/decoders/digimode/tones/twotone.ts` | `core/src/tones/tones_rx.cpp` (pure tone tracker, two-tone paging detector) |
| `src/client/worker/decoders/digimode/tones/receiver.ts` | `core/src/tones/tones_rx.cpp` (TonesReceiver: audio stream and hop schedule) |
| `src/client/worker/decoders/digimode/tones/index.ts` | `core/src/tones/tones_rx.cpp` (FM path, events), `core/include/dect2/tones/tones_tel.h` (kind names, summary) |
| `test/digimode/tones/fixtures.js` | `core/src/tones/tones_gen.cpp` (ToneScene, toneSceneFm) |
| `src/client/worker/decoders/digimode/wmbus/types.ts` | `core/include/dect2/wmbus/wmbus_proto.h` (Phy, Coding, PhySpec, Record, Frame) |
| `src/client/worker/decoders/digimode/wmbus/proto.ts` | `core/src/wmbus/wmbus_proto.cpp` (CRC, 3-out-of-6 code, frame formats A and B, link layer, application header, phySpec) |
| `src/client/worker/decoders/digimode/wmbus/records.ts` | `core/src/wmbus/wmbus_proto.cpp` (parseRecords, VIF tables, data lengths, number formatting) |
| `src/client/worker/decoders/digimode/wmbus/receiver.ts` | `core/src/wmbus/wmbus_live.cpp` (channel filter, FM discriminator, chip clock recovery, sync search, T / C format marker, Manchester, 3-out-of-6 and NRZ symbols) |
| `src/client/worker/decoders/digimode/wmbus/report.ts` | `core/src/wmbus/wmbus_live.cpp` (WmbusLiveReceiver::finish: frame summary and log) |
| `src/client/worker/decoders/digimode/wmbus/index.ts` | `core/src/wmbus/wmbus_live.cpp` (WmbusLiveReceiver: the 868 MHz channels) |
| `test/digimode/wmbus/fixtures.js` | `core/src/wmbus/wmbus_gen.cpp` (simulated meters, GFSK bursts), `core/src/wmbus/wmbus_proto.cpp` (buildFrame, encodeChips) |
| `src/client/worker/decoders/digimode/wefax/types.ts` | `core/include/dect2/marine/marine_fax.h` (FaxStatus), `core/src/marine/marine_fax.cpp` (decoder data shapes), `marine_wefax_stations.h` |
| `src/client/worker/decoders/digimode/wefax/audio.ts` | `core/src/marine/marine_dsp.cpp` (FaxAudio) |
| `src/client/worker/decoders/digimode/wefax/front.ts` | `core/src/marine/marine_fax.cpp` (FaxDecoder front end: mixer, low passes, discriminator, running sums) |
| `src/client/worker/decoders/digimode/wefax/tones.ts` | `core/src/marine/marine_fax.cpp` (FaxDecoder start and stop tone detector) |
| `src/client/worker/decoders/digimode/wefax/pulses.ts` | `core/src/marine/marine_fax.cpp` (FaxDecoder phasing pulse detector and pulse chain) |
| `src/client/worker/decoders/digimode/wefax/picture.ts` | `core/src/marine/marine_fax.cpp` (FaxImage, row moves of applyManual and alignLines) |
| `src/client/worker/decoders/digimode/wefax/core.ts` | `core/src/marine/marine_fax.cpp` (faxImageWidth; line fit, picture rows, row filter, slant, tone row trim) |
| `src/client/worker/decoders/digimode/wefax/free.ts` | `core/src/marine/marine_fax.cpp` (chart joined midway: line rate search, levels, line start roll, slant follow-up) |
| `src/client/worker/decoders/digimode/wefax/decoder.ts` | `core/src/marine/marine_fax.cpp` (FaxDecoder: setup, tone and pulse events, phasing lock, line state machine), `marine_fax.h` |
| `src/client/worker/decoders/digimode/wefax/stations.ts` | `core/src/marine/marine_wefax_stations.cpp`, `core/include/dect2/marine/marine_wefax_stations.h` |
| `src/client/worker/decoders/digimode/wefax/index.ts` | after `core/src/marine/marine_rx.cpp` (fax path: FaxAudio into the decoder, one message per chart) |
| `test/digimode/wefax/fixtures.js` | `core/src/marine/marine_fax.cpp` (FaxAudioSource), `core/src/marine/marine_gen.cpp` (FaxSource) |
| `src/client/worker/decoders/dab/constants.ts` | `core/include/dect2/dab/dab.h` (mode I geometry) |
| `src/client/worker/decoders/dab/receiver.ts` | `core/src/dab/dab_rx.cpp` (DabReceiver: feed, run, processFrame, decodeFic, CIF gaps, applySelection, decodeMain, publish, reset) |
| `src/client/worker/decoders/dab/ofdm/buffer.ts` | `core/src/dab/dab_rx.cpp` (sample buffer, input conditioning, impulse blanker) |
| `src/client/worker/decoders/dab/ofdm/demod.ts` | `core/src/dab/dab_rx.cpp` (processFrame: DQPSK cells, common phase error, soft bits, SNR) |
| `src/client/worker/decoders/dab/ofdm/fft.ts` | `core/include/dect2/dsp/fftutil.h` (Fft) |
| `src/client/worker/decoders/dab/ofdm/spectrum.ts` | `core/src/dab/dab_rx.cpp` (windowFft, cirFast, cirOf, placeWindow) |
| `src/client/worker/decoders/dab/ofdm/sync.ts` | `core/src/dab/dab_rx.cpp` (searchSync, processFrame timing, clock and carrier tracking) |
| `src/client/worker/decoders/dab/ofdm/tables.ts` | `core/src/dab/dab_fec.cpp` (freqInterleaver, phaseReference) |
| `src/client/worker/decoders/dab/ofdm/types.ts` | `core/src/dab/dab_rx.cpp` (search and frame outcomes) |
| `src/client/worker/decoders/dab/fec/crc.ts` | `core/src/dab/dab_fec.cpp` (crc16, fireCode, descramble), `rust/onair_dab/src/crc.rs` |
| `src/client/worker/decoders/dab/fec/puncture.ts` | `core/src/dab/dab_fec.cpp` (puncturing vectors, FIC, EEP and UEP profiles, table 6) |
| `src/client/worker/decoders/dab/fec/rs.ts` | `rust/onair_fec/src/rs.rs`, `gf.rs` (RS(120,110)), `core/src/dab/dab_fec.cpp` |
| `src/client/worker/decoders/dab/fec/types.ts` | `core/src/dab/dab_fec.cpp`, `core/include/dect2/dab/dab.h` (puncturing geometry) |
| `src/client/worker/decoders/dab/fec/viterbi.ts` | `core/src/dab/dab_fec.cpp` (Trellis, vitForwardBody, viterbiDecode, convEncode) |
| `src/client/worker/decoders/dab/fic/charset.ts` | `rust/onair_dvbsi/src/charset.rs`, `tables.rs` (DAB charsets, EBU Latin, clean) |
| `src/client/worker/decoders/dab/fic/ensemble.ts` | `core/src/dab/dab_rx.cpp` (parseFib, parseFig0 0/0 to 0/2, parseFig1) |
| `src/client/worker/decoders/dab/fic/fic.ts` | `core/src/dab/dab_rx.cpp` (decodeFic) |
| `src/client/worker/decoders/dab/fic/figs.ts` | `rust/onair_dab/src/fig.rs` (FIB walk, FIG 0/0, 0/1, 0/2, 1), `core/src/dab/dab_fig_0a.cpp`, `dab_fig_label.cpp` |
| `src/client/worker/decoders/dab/fic/types.ts` | `core/include/dect2/dab/dab_proto.h` (FIG records), `dab_tel.h` |
| `src/client/worker/decoders/dab/msc/subchannel.ts` | `core/src/dab/dab_rx.cpp` (SubDec: time de-interleaver and sub-channel decoding) |
| `src/client/worker/decoders/dab/msc/types.ts` | `core/src/dab/dab_rx.cpp` (SubDec output) |
| `src/client/worker/decoders/dab/audio/pad.ts` | `rust/onair_dab/src/pad.rs`, `core/src/dab/dab_pad.cpp` (PAD split, dynamic label) |
| `src/client/worker/decoders/dab/audio/superframe.ts` | `core/src/dab/dab_audio.cpp` (dabAacParams, makeAsc, DAB+ superframe) |
| `src/client/worker/decoders/dab/audio/types.ts` | `core/include/dect2/dab/dab_proto.h` (PadSub, DlsStep, DlSegment) |
| `test/dab/transmitter.js` | `core/src/dab/dab_gen.cpp` (test transmitter) |
| `test/dab/gen-coding.js` | `core/src/dab/dab_gen_coding.cpp` (test transmitter channel coding) |
| `test/dab/gen-pad.js` | `core/src/dab/dab_gen_pad.cpp` (dynamic label in the PAD) |
| `test/dab/aac-encoder.js` | `core/src/dab/dab_gen_aac.cpp` (AAC-LC 960 encoder, DAB+ superframe) |
| `test/dab/aac-tables.js` | `core/src/drm/drm_aactab.cpp` (AAC Huffman tables, from FFmpeg), `drm_aac.cpp` (cbInfo, cbIndex) |
| `test/dab/drm-fft.js` | `core/src/drm/drm_fft.cpp` (DrmFft) |
| `src/client/worker/decoders/digimode/lora/types.ts` | `core/include/dect2/mesh/mesh_lora.h` (Params, Header, RxFrame, DemodStats), `core/include/dect2/lorawan/lora_bank.h` (Channel, Decoded), `core/include/dect2/mesh/mesh_proto.h` (MeshLoraSettings), `core/src/mesh/mesh_lora_demod.cpp` (SFD candidates), `mesh_crypto_ed25519.cpp` (Fe, Point) |
| `src/client/worker/decoders/digimode/lora/code.ts` | `core/src/mesh/mesh_lora_code.cpp` (whitening, Hamming code, header checksum, CRC, Gray mapping, interleaver, encode, dataSymbols, airSeconds), `core/include/dect2/mesh/mesh_lora.h` |
| `src/client/worker/decoders/digimode/lora/frame.ts` | `core/src/mesh/mesh_lora_code.cpp` (FrameDecoder: header, hard and soft Hamming decoding, list decoding on the CRC) |
| `src/client/worker/decoders/digimode/lora/jumps.ts` | `core/src/mesh/mesh_lora_code.cpp` (JumpSearch, recoverJumps) |
| `src/client/worker/decoders/digimode/lora/chips.ts` | `core/src/mesh/mesh_lora_demod.cpp` (ChanBuf, ChipStream) |
| `src/client/worker/decoders/digimode/lora/demod.ts` | `core/src/mesh/mesh_lora_demod.cpp` (Demod: preamble search, resampler, soft symbols, timing loop, CRC retries) |
| `src/client/worker/decoders/digimode/lora/sfd.ts` | `core/src/mesh/mesh_lora_demod.cpp` (Demod::Impl::sfd: down-chirp, sync word, carrier and timing estimates) |
| `src/client/worker/decoders/digimode/lora/bank.ts` | `core/src/lorawan/lora_bank.cpp` (Bank: one chip stream, a demodulator per spreading factor, duplicate frames), `core/src/mesh/mesh_rx.cpp` |
| `src/client/worker/decoders/digimode/lora/crypto.ts` | `core/src/mesh/mesh_crypto.cpp` (AES ECB / CTR, SHA-256, HMAC-SHA256, base64, hex), `mesh_crypto_tables.cpp` |
| `src/client/worker/decoders/digimode/lora/ed25519.ts` | `core/src/mesh/mesh_crypto_ed25519.cpp` (Ed25519 sign and verify), `mesh_crypto.cpp` (SHA-512), `mesh_crypto_tables.cpp` |
| `src/client/worker/decoders/digimode/lora/presets.ts` | `core/src/mesh/mesh_proto.cpp` (Meshtastic presets, regions and slots, default keys), `mesh_presets.cpp`, `mesh_presets_data.cpp` (MeshCore presets), `mesh_proto_aprs.cpp` (loraAprsPresets, meshcomPresets), `mesh_proto_lorawan.cpp` (lorawanPresets) |
| `src/client/worker/decoders/digimode/lora/mesh.types.ts` | `core/include/dect2/mesh/mesh_proto.h` (MeshPacketInfo, MeshNodeUpdate, MeshTextMessage, MeshDecodeResult), `rust/onair_mesh/src/abi.rs` |
| `src/client/worker/decoders/digimode/lora/mesh.ts` | `rust/onair_mesh/src/abi.rs` (record defaults), `rust/onair_mesh/src/meshtastic.rs` (clean_text, clip), `core/src/mesh/mesh_report.cpp` (packet, node and message columns) |
| `src/client/worker/decoders/digimode/lora/decoder.ts` | `core/src/mesh/mesh_rx.cpp` (MeshReceiver::onFrame: packet row, radio fields, CRC notes), `rust/onair_mesh/src/aprs.rs` (printable) |
| `src/client/worker/decoders/digimode/meshtastic/pb.ts` | `rust/onair_mesh/src/pb.rs` (protobuf reader) |
| `src/client/worker/decoders/digimode/meshtastic/names.ts` | `rust/onair_mesh/src/names.rs` (hardware models, ports, roles, routing errors), `rust/onair_mesh/src/tables.rs` (channel hash) |
| `src/client/worker/decoders/digimode/meshtastic/types.ts` | `rust/onair_mesh/src/pb.rs` (Field), `rust/onair_mesh/src/meshtastic.rs` (Header, Data, Ctx, Decoded) |
| `src/client/worker/decoders/digimode/meshtastic/ports.ts` | `rust/onair_mesh/src/meshtastic.rs` (decode_port and the port payloads) |
| `src/client/worker/decoders/digimode/meshtastic/proto.ts` | `core/src/mesh/mesh_proto_rs.cpp` (decodeMeshtastic), `core/src/mesh/mesh_proto.cpp` (default channels), `rust/onair_mesh/src/meshtastic.rs` (parse_header, parse_data) |
| `src/client/worker/decoders/digimode/meshtastic/index.ts` | `core/src/mesh/mesh_rx.cpp` (Meshtastic decoders with the preset search, packet row) |
| `test/digimode/lora/phy.js` | `core/src/mesh/mesh_lora_code.cpp` (TxFrame: the LoRa frame waveform), `core/include/dect2/dsp/gen_util.h` (noise) |
| `test/digimode/lora/builders.js` | `core/src/mesh/mesh_pb.cpp` (Writer), `mesh_proto_meshtastic.cpp`, `mesh_proto_meshcore.cpp`, `mesh_proto_aprs.cpp`, `mesh_proto_lorawan.cpp` (packet builders) |
| `test/digimode/lora/scene.js` | `core/src/mesh/mesh_gen.cpp` (the mesh test scene), `core/src/lorawan/lorawan_gen.cpp` (lorawanTestSchedule) |
| `src/client/worker/decoders/digimode/meshcore/types.ts` | `rust/onair_mesh/src/meshcore.rs` (Parsed, Out, GroupOut), `core/src/mesh/mesh_proto_internal.h` (MeshCoreChannel) |
| `src/client/worker/decoders/digimode/meshcore/proto.ts` | `rust/onair_mesh/src/meshcore.rs` (header, key-free payloads, group text), `core/src/mesh/mesh_proto_rs.cpp` (decodeMeshCore), `mesh_proto_meshcore.cpp` (meshcoreMacThenDecrypt), `mesh_proto.cpp` (meshcoreMakeChannel) |
| `src/client/worker/decoders/digimode/meshcore/index.ts` | `core/src/mesh/mesh_rx.cpp` (MeshCore decoders of the region plan, packet row) |
| `src/client/worker/decoders/digimode/lorawan/types.ts` | `rust/onair_mesh/src/lorawan.rs` (Lorawan), `rust/onair_mesh/src/lorawan_names.rs` (MacDef, Network) |
| `src/client/worker/decoders/digimode/lorawan/names.ts` | `rust/onair_mesh/src/lorawan_names.rs` (MAC commands, MType names, networks, OUIs, EUI text) |
| `src/client/worker/decoders/digimode/lorawan/proto.ts` | `rust/onair_mesh/src/lorawan.rs` (MHDR, FHDR, MAC commands, join and rejoin requests), `core/src/mesh/mesh_proto_lora_rs.cpp` (meshDecodeLorawan) |
| `src/client/worker/decoders/digimode/lorawan/index.ts` | `core/src/lorawan/lorawan_rx.cpp` (LoRaWAN monitor channel and frame row), `core/src/mesh/mesh_rx.cpp` (onLorawan) |
| `src/client/worker/decoders/digimode/lora-aprs/proto.ts` | `rust/onair_mesh/src/aprs.rs` (lora_aprs: prefix, TNC2 split, call checks), `core/src/mesh/mesh_proto_lora_rs.cpp` (meshDecodeLoraAprs) |
| `src/client/worker/decoders/digimode/lora-aprs/index.ts` | `core/src/mesh/mesh_rx.cpp` (LoRa APRS decoders, onAprs), `core/src/mesh/mesh_proto_lora_rs.cpp` |
| `src/client/worker/decoders/digimode/meshcom/types.ts` | `rust/onair_mesh/src/aprs.rs` (MeshCom), `core/include/dect2/mesh/mesh_proto.h` (MeshCom fields of MeshDecodeResult); protocol facts as credited there: [MeshCom firmware](https://github.com/icssw-org/MeshCom-Firmware) (icssw-org, MIT) |
| `src/client/worker/decoders/digimode/meshcom/proto.ts` | `rust/onair_mesh/src/aprs.rs` (clean_text, battery, meshcom: ack, frame split, byte sum, trailer and flags) |
| `src/client/worker/decoders/digimode/meshcom/index.ts` | `core/src/mesh/mesh_proto_lora_rs.cpp` (meshDecodeMeshCom), `core/src/mesh/mesh_rx.cpp` (MeshCom decoders, onAprs) |
| `test/digimode/meshcom/fixtures.js` | `core/src/mesh/mesh_proto_aprs.cpp` (meshcomBuild), `core/src/mesh/mesh_gen.cpp` (kMcom: the 70 cm scene's MeshCom nodes) |
| `test/digimode/meshcom/proto.spec.js` | `tests/mesh/test_mesh_loraaprs.cpp` (packetLayer: MeshCom), `rust/onair_mesh/src/tests.rs` (lora_aprs_and_meshcom) |
| `test/digimode/meshcom/meshcom.spec.js` | `tests/mesh/test_mesh_loraaprs.cpp` (scene: MeshCom at -15 dB, +22 kHz, +100 ppm), `core/src/mesh/mesh_gen.cpp` |
| `test/digimode/meshcom/worker.spec.js` | `tests/mesh/test_mesh_loraaprs.cpp` (scene), `core/src/mesh/mesh_gen.cpp` (kMcom) |
| `src/client/worker/decoders/digimode/ftx/tables.ts` | `core/src/hfdig/hfdig_ftx_tables.cpp` (LDPC generator and checks, Costas arrays, Gray maps, FT4 scrambling, WSPR sync vector, ARRL sections, RTTY multipliers; the FT8 / FT4 tables are ft8_lib's, MIT) |
| `src/client/worker/decoders/digimode/ftx/ldpc.ts` | `core/src/hfdig/hfdig_ftx_tables.cpp` (crc14, encode174, ldpcDecode, osdDecode) |
| `src/client/worker/decoders/digimode/ftx/pack.ts` | `core/src/hfdig/hfdig_ftx_msg.cpp` (pack77 and its message types, CallHash) |
| `src/client/worker/decoders/digimode/ftx/unpack.ts` | `core/src/hfdig/hfdig_ftx_msg.cpp` (unpack77, callAndGrid, gridToLatLon) |
| `src/client/worker/decoders/digimode/ftx/wave.ts` | `core/src/hfdig/hfdig_ftx.cpp` (spec, ftxTones, addWaveIQ) |
| `src/client/worker/decoders/digimode/ftx/layout.ts` | `core/src/hfdig/hfdig_ftx.cpp` (Resampler, streams, layoutOf, logI0), `hfdig_usb.h` (lowpass) |
| `src/client/worker/decoders/digimode/ftx/memory.ts` | `core/src/hfdig/hfdig_ftx.cpp` (XMem, SlotDecoder::buildAp) |
| `src/client/worker/decoders/digimode/ftx/search.ts` | `core/src/hfdig/hfdig_ftx.cpp` (SlotDecoder: bigFft, spectrogram, toneSums, score, candidates, nearDecoded) |
| `src/client/worker/decoders/digimode/ftx/fit.ts` | `core/src/hfdig/hfdig_ftx.cpp` (SlotDecoder: baseband, symbol, twiddles, syncMetric, fine fit, tone amplitudes) |
| `src/client/worker/decoders/digimode/ftx/soft.ts` | `core/src/hfdig/hfdig_ftx.cpp` (SlotDecoder: soft bits, coherentLlr, OSD, a-priori CQ and QSO, soft bits across slots) |
| `src/client/worker/decoders/digimode/ftx/slot.ts` | `core/src/hfdig/hfdig_ftx.cpp` (SlotDecoder: run, tryCandidate, subtract, wsprCallGrid) |
| `src/client/worker/decoders/digimode/ftx/clock.ts` | `core/src/hfdig/hfdig_ftx.cpp` (HfdigFtx::Impl: feed, schedule, window), `core/include/dect2/hfdig/clock_comp.h` (ClockComp) |
| `src/client/worker/decoders/digimode/ftx/types.ts` | `core/src/hfdig/hfdig_ftx_int.h` (Spec, OsdStats), `core/include/dect2/hfdig/hfdig_ftx.h` (FtxDecode), `hfdig_ftx.cpp` (Layout, Job, XMem) |
| `src/client/worker/decoders/digimode/ftx/index.ts` | after `core/src/hfdig/hfdig_ftx.cpp` (HfdigFtx: slot queue, decodes per slot, clock statistics), `hfdig_rx.cpp` (USB audio) |
| `src/client/worker/decoders/digimode/wspr/codec.ts` | `core/src/hfdig/hfdig_wspr.cpp` (nhash, wsprPack, wsprUnpack, convolutional code, interleaver, wsprSymbols) |
| `src/client/worker/decoders/digimode/wspr/fano.ts` | `core/src/hfdig/hfdig_wspr.cpp` (wsprFano) |
| `src/client/worker/decoders/digimode/wspr/index.ts` | after `core/src/hfdig/hfdig_ftx.cpp` (the WSPR mode of the slot decoder, decode records) |
| `test/digimode/ftx/fixtures.js` | `core/src/hfdig/hfdig_ftx_gen.cpp` (ftxTestStations), `hfdig_ftx.cpp` (addWave), `hfdig_gen.cpp` (USB test signal), `tests/hfdig/hfdig_ftx_testutil.h` (ampFor) |
| `test/digimode/ftx/messages.spec.js` | `tests/hfdig/test_hfdig_ftx_tables.cpp` |
| `test/digimode/ftx/ft8.spec.js` | `tests/hfdig/test_hfdig_ft8.cpp` |
| `test/digimode/ftx/modes.spec.js` | `tests/hfdig/test_hfdig_ft4.cpp`, `test_hfdig_wspr.cpp` |
| `src/client/worker/decoders/digimode/rtty/types.ts` | `core/include/dect2/hfdig/hfdig_rtty.h` (RttyAutoHyp, HfdigRttyTelemetry), `core/include/dect2/autoparam/autoparam.h` (FskPair, FskBaud) |
| `src/client/worker/decoders/digimode/rtty/decoder.ts` | `core/src/hfdig/hfdig_rtty.cpp` (HfdigRtty::Impl: pair search, lock, matched filters, ATC, start / stop bits, ITA2), `hfdig_rtty.h` (speed and shift tables) |
| `src/client/worker/decoders/digimode/rtty/auto.ts` | `core/src/hfdig/hfdig_rtty_auto.cpp` (rttyAutoAnalyse, textScore), `core/src/autoparam/autoparam.cpp` (powerSpectrum, findFskPairs, measureFskBaud) |
| `src/client/worker/decoders/digimode/rtty/index.ts` | `core/src/hfdig/hfdig_rtty.cpp` (HfdigRtty: feedAudio, the Auto rule), `hfdig_rx.cpp` (USB audio, RTTY with Auto on) |
| `test/digimode/rtty/fixtures.js` | `core/src/hfdig/hfdig_rtty.cpp` (RttyTestAudio, makeRttyTxAudio), `tests/hfdig/test_hfdig_rtty.cpp` (noise of an SNR, textOk) |
| `test/digimode/rtty/rtty.spec.js` | `tests/hfdig/test_hfdig_rtty.cpp` |
| `test/digimode/rtty/auto.spec.js` | `tests/hfdig/test_hfdig_rttyauto.cpp` |
| `src/client/worker/decoders/digimode/cw/types.ts` | `core/include/dect2/cw/cw_decoder.h` (DecTok, FistStats), `core/src/cw/cw_decoder.cpp` (Ev, Prior), `cw_lm.cpp` (Model), `core/include/dect2/cw/cw_tel.h` (CwSignal) |
| `src/client/worker/decoders/digimode/cw/morse.ts` | `core/src/cw/cw_morse.cpp` (code table, decodeSymbol, encodeSymbol, tokenize, isCallsign, callsigns) |
| `src/client/worker/decoders/digimode/cw/lm.ts` | `core/src/cw/cw_lm.cpp` (word list, sentences, character trigram, lmSymbol, lmLogP, lmWordBonus, callShape) |
| `src/client/worker/decoders/digimode/cw/model.ts` | `core/src/cw/cw_decoder.cpp` (FistDecoder::Impl, the sender model: lpGauss, learnMark, learnGap, gmm, dashFit, fitGaps, twoMeans, relock, checkSpeed, fromBacklog, misfit; FistTune) |
| `src/client/worker/decoders/digimode/cw/beam.ts` | `core/src/cw/cw_decoder.cpp` (Morse trie, Hyp, the beam search, commit, the queue of committed characters) |
| `src/client/worker/decoders/digimode/cw/fist.ts` | `core/src/cw/cw_decoder.cpp` (FistDecoder: lock, events, soft merges, the check after a pause, idle flush) |
| `src/client/worker/decoders/digimode/cw/skimmer.ts` | `core/src/cw/cw_rx.cpp` (CwReceiver::Impl: window spectrum, carrier search, per-signal mixer and filters, detector, fistKeyer) |
| `src/client/worker/decoders/digimode/cw/index.ts` | `core/src/cw/cw_rx.cpp` (CwReceiver: feed, the report of every signal, cwBands), `core/include/dect2/cw/cw_tel.h` (cwSummary) |
| `test/digimode/cw/fixtures.js` | `core/src/cw/cw_gen.cpp` (cwKeying, CwGenerator, cwTestSignals), `tests/cw/test_cw_fistrx.cpp` (decode, norm, editDistance) |
| `test/digimode/cw/fist.spec.js` | `tests/cw/test_cw_morse.cpp`, `tests/cw/test_cw_fistrx.cpp` (the decoder alone) |
| `test/digimode/cw/rx.spec.js` | `tests/cw/test_cw_rx.cpp`, `tests/cw/test_cw_fistrx.cpp` (the receiver) |
| `src/client/worker/decoders/digimode/psk/types.ts` | `core/include/dect2/psk/psk_tel.h` (kPskModes, pskModeName, pskBaud, pskQpsk) |
| `src/client/worker/decoders/digimode/psk/varicode.ts` | `core/src/psk/psk_varicode.cpp` (varicode, VaricodeRx, ConvEncoder, Viterbi, QPSK mapping), `core/include/dect2/psk/psk_varicode.h` |
| `src/client/worker/decoders/digimode/psk/channel.ts` | `core/src/psk/psk_rx.cpp` (Chan, chanSample, sample1k, symbol) |
| `src/client/worker/decoders/digimode/psk/receiver.ts` | `core/src/psk/psk_rx.cpp` (PskReceiver::Impl: setupMode, window spectrum, peak search, new signals and their replay, drop and merge) |
| `src/client/worker/decoders/digimode/psk/index.ts` | `core/src/psk/psk_rx.cpp` (PskReceiver: feed, the report of every signal, pskPresets), `core/include/dect2/psk/psk_tel.h` |
| `test/digimode/psk/fixtures.js` | `core/src/psk/psk_gen.cpp` (PskGenerator, pskTestSignals), `tests/psk/test_psk_rx.cpp` (sig, run) |
| `test/digimode/psk/varicode.spec.js` | `tests/psk/test_psk_proto.cpp` |
| `test/digimode/psk/psk.spec.js` | `tests/psk/test_psk_rx.cpp` |
| `src/client/worker/decoders/dsd/ysf/types.ts` | `core/include/dect2/fusion/fusion_proto.h` (Fich, VoiceUnit, FrameContent), `fusion_gps.h` (YsfGps) |
| `src/client/worker/decoders/dsd/ysf/proto.ts` | `core/src/fusion/fusion_proto.cpp`, `core/include/dect2/fusion/fusion_proto.h` (sync, CRC-16, Golay (24,12), convolutional code and Viterbi, interleaver, whitening, FICH, DCH, V/D mode 2 voice, callsign fields) |
| `src/client/worker/decoders/dsd/ysf/frame.ts` | `core/src/fusion/fusion_proto.cpp` (buildFrameBits, parseFrameBits), `core/src/fusion/fusion_rx.cpp` (tryFrame: level fit, slicing, SNR) |
| `src/client/worker/decoders/dsd/ysf/gps.ts` | `core/include/dect2/fusion/fusion_gps.h` (ysfRadioName, ysfGpsParse) |
| `src/client/worker/decoders/dsd/ysf/receiver.ts` | `core/src/fusion/fusion_rx.cpp` (onFrame, beginTx, endTx, csd1, csd2, csd3, slow, remText, voice) |
| `src/client/worker/decoders/dsd/ambe.ts` | `rust/onair_nxdn/src/msg.rs` (ambe_frame), `core/src/nxdn/nxdn_ambe.cpp` (NxdnAmbe::decode) |
| `test/decoders/dsd/ysf/fixtures.js` | `core/src/fusion/fusion_gen.cpp` (genVoiceBytes, genTransmissionBits, modulateC4fm), `tests/fusion/fusion_test_util.h` (signal), `tests/fusion/test_fusion_gps.cpp` (block) |
| `test/decoders/dsd/ysf/proto.spec.js` | `tests/fusion/test_fusion_proto.cpp` |
| `test/decoders/dsd/ysf/interop.spec.js` | `tests/fusion/test_fusion_interop.cpp` (MMDVMHost frames as data), `tests/fusion/test_fusion_gps.cpp` |
| `test/decoders/dsd/ysf/stream.spec.js` | `tests/fusion/test_fusion_rx.cpp`, `test_fusion_codec.cpp`, `test_fusion_sweep.cpp` |
| `src/client/worker/decoders/dsd/dstar/types.ts` | `core/include/dect2/dstar/dstar_proto.h` (Header, Fix), `core/include/dect2/dstar/dstar_tel.h` (DstarPosition, DstarCall) |
| `src/client/worker/decoders/dsd/dstar/header.ts` | `rust/onair_dstar/src/header.rs` (CRC, header fields, flag text), `rust/onair_dstar/src/fec.rs` (convolutional code, Viterbi, interleaver, scrambler, header FEC), `core/src/dstar/dstar_proto.cpp` (sync and end patterns, slow data scrambler) |
| `src/client/worker/decoders/dsd/dstar/gps.ts` | `rust/onair_dstar/src/gps.rs` (NMEA and D-PRS parsers, checksums) |
| `src/client/worker/decoders/dsd/dstar/call.ts` | `core/src/dstar/dstar_rx.cpp` (level fit and tracking, header, frames, weak frames, data sync, slow data, GPS lines, call state) |
| `test/decoders/dsd/dstar/fixtures.js` | `core/src/dstar/dstar_gen.cpp` (known voice, NMEA and D-PRS lines, transmission bits, test schedule, GMSK) |
| `test/decoders/dsd/dstar/proto.spec.js` | `tests/dstar/test_dstar_proto.cpp`, `rust/onair_dstar/src/tests.rs` |
| `test/decoders/dsd/dstar/stream.spec.js` | `tests/dstar/test_dstar_rx.cpp`, `tests/dstar/test_dstar_sens.cpp` |
| `src/client/worker/decoders/dsd/dpmr/types.ts` | `core/include/dect2/dpmr/dpmr_proto.h` (Header, Cch, End), `dpmr_tel.h` (DpmrCall) |
| `src/client/worker/decoders/dsd/dpmr/proto.ts` | `core/src/dpmr/dpmr_proto.cpp`, `core/include/dect2/dpmr/dpmr_proto.h` (frame syncs, colour code, CRC-8/7/16, Hamming (12,8), PN9, block interleaving, soft decoding, header / CCH / end / data blocks, names, ids) |
| `src/client/worker/decoders/dsd/dpmr/call.ts` | `core/src/dpmr/dpmr_rx.cpp` (fresh, startCall, endCall, endData, lost, header and CCH call bookkeeping), `core/include/dect2/dpmr/dpmr_tel.h` (DpmrCall) |
| `src/client/worker/decoders/dsd/dpmr/receiver.ts` | `core/src/dpmr/dpmr_rx.cpp` (symbol filter, sync search, frame state machine, level fits, header / CCH / TCH / end decoding, voice frames) |
| `test/decoders/dsd/dpmr/fixtures.js` | `core/src/dpmr/dpmr_gen.cpp` (Builder, dpmrKnownVoice, dpmrTxSymbols, dpmrTestSchedule, DpmrGenerator), `core/include/dect2/dpmr/dpmr_gen.h` |
| `test/decoders/dsd/dpmr/proto.spec.js` | `tests/dpmr/test_dpmr_proto.cpp` |
| `test/decoders/dsd/dpmr/stream.spec.js` | `tests/dpmr/test_dpmr_rx.cpp`, `tests/dpmr/test_dpmr_sens.cpp` |
| `src/client/worker/decoders/dsd/nxdn/types.ts` | `core/include/dect2/nxdn/nxdn_proto.h` (Lich, Msg), `core/include/dect2/nxdn/nxdn_tel.h` (NxdnCall, NxdnSite) |
| `src/client/worker/decoders/dsd/nxdn/proto.ts` | `rust/onair_nxdn/src/lich.rs` (PN9, LICH), `crc.rs`, `chan.rs` (SACCH, FACCH1, CAC: convolutional code, Viterbi, puncturing, interleaving), `msg.rs` (layer 3 messages, names), `core/src/nxdn/nxdn_proto.cpp` (frame sync word), `core/include/dect2/nxdn/nxdn_proto.h` (frame geometry) |
| `src/client/worker/decoders/dsd/nxdn/calls.ts` | `core/src/nxdn/nxdn_rx.cpp` (frame decoding from the LICH on, SACCH superframe, calls, cipher trust, status, short data, site, voice) |
| `src/client/worker/decoders/dsd/nxdn/receiver.ts` | `core/src/nxdn/nxdn_rx.cpp` (NXDN48 chain: symbol filter, frame sync search and tracking, frame levels) |
| `src/client/worker/decoders/dsd/frame-timing.ts` | `core/src/p25/p25_rx.cpp` (frame timing search and level refit), `core/src/nxdn/nxdn_rx.cpp` (level refit) |
| `test/decoders/dsd/nxdn/fixtures.js` | `core/src/nxdn/nxdn_gen.cpp` (frame builder, known voice, transmissions, test schedule, raised cosine 4FSK) |
| `test/decoders/dsd/nxdn/proto.spec.js` | `tests/nxdn/test_nxdn_proto.cpp`, `rust/onair_nxdn/src/tests.rs` |
| `test/decoders/dsd/nxdn/stream.spec.js` | `tests/nxdn/test_nxdn_rx.cpp`, `tests/nxdn/test_nxdn_sens.cpp` |
| `src/client/worker/decoders/dsd/p25p2/types.ts` | `core/include/dect2/p25p2/p25p2_tel.h` (P25p2Call, P25p2Telemetry), `core/include/dect2/p25/p25_tel.h` (P25Site, P25IdenRow), `core/src/p25p2/p25p2_rx.cpp` (Ess) |
| `src/client/worker/decoders/dsd/p25p2/rs.ts` | `rust/onair_p25/src/gf.rs`, `rust/onair_p25/src/rs.rs` (GF(64), Reed-Solomon encoder and decoder), `core/src/p25p2/p25p2_proto.cpp` (rs63Decode with erasures, crc12) |
| `src/client/worker/decoders/dsd/p25p2/demod.ts` | `core/src/p25p2/p25p2_rx.cpp` (carrier search and AFC, spectrum look, matched filter, parallel differential demodulators, sync search, symbol clock, ISCH framing) |
| `src/client/worker/decoders/dsd/p25p2/calls.ts` | `core/src/p25p2/p25p2_rx.cpp` (startCall, endCall, userMsg, PTT, voiceFrame, keyed, essKnown, ESS-A / ESS-B, play, call expiry) |
| `src/client/worker/decoders/dsd/p25p2/mac.ts` | `core/src/p25p2/p25p2_rx.cpp` (macPdu, controlMsg, grant, freqOf) |
| `src/client/worker/decoders/dsd/p25p2/seed.ts` | `core/src/p25p2/p25p2_rx.cpp` (setSystem, applySystem), `core/src/p25p2/p25p2_proto.cpp` (scrambler, MAC coding); the seed solver is BrowSDR's |
| `src/client/worker/decoders/dsd/p25p2/receiver.ts` | `core/src/p25p2/p25p2_rx.cpp` (processBurst, applySystem, setSystem, setListenSlot, resetState), `core/include/dect2/p25p2/p25p2_rx.h` |
| `test/decoders/dsd/p25p2/fixtures.js` | `core/src/p25p2/p25p2_gen.cpp` (p25p2VoiceBits, p25p2Dibits, p25p2Modulate, p25p2VoiceFrames), `core/include/dect2/p25p2/p25p2_gen.h`, `core/src/p25p2/p25p2_proto.cpp` (MAC PDU builders), `tests/p25p2/test_p25p2_impair.cpp` (impairments) |
| `test/decoders/dsd/p25p2/helpers.js` | `tests/p25p2/test_p25p2_rx.cpp` (baseConfig, run, findCall, checkDecode) |
| `test/decoders/dsd/p25p2/proto.spec.js` | `tests/p25p2/test_p25p2_proto.cpp`, `tests/p25p2/test_p25p2_audit.cpp` (message lengths) |
| `test/decoders/dsd/p25p2/stream.spec.js` | `tests/p25p2/test_p25p2_rx.cpp` |
| `test/decoders/dsd/p25p2/impair.spec.js` | `tests/p25p2/test_p25p2_impair.cpp`, `tests/p25p2/test_p25p2_audit.cpp` |
| `src/client/worker/decoders/dsd/p25/types.ts` | `core/include/dect2/p25/p25_proto.h` (Tsbk, Lc, Crypto, Iden), `core/include/dect2/p25/p25_cc.h` (CcItem, PduData), `core/include/dect2/p25/p25_tel.h` (P25Call, P25Site, P25IdenRow) |
| `src/client/worker/decoders/dsd/p25/proto.ts` | `rust/onair_p25/src/nid.rs` (BCH NID), `golay.rs`, `trellis.rs` (trellis code, CRC-CCITT), `msg.rs` (data units, TSBK, link control, encryption sync, header, names), `core/src/p25/p25_proto.cpp` (frame sync), `core/src/p25/p25_proto_rs.cpp` (NID with a known NAC), `core/src/p25/p25_rx.cpp` (soft hexbit decision) |
| `src/client/worker/decoders/dsd/p25/cc.ts` | `core/src/p25/p25_cc.cpp` (patches, affiliation, registration, deny / queue / acknowledge, data grants, MBT, unconfirmed data; layouts from OP25, reason codes and PDU fields from SDRTrunk as OnAir credits them) |
| `src/client/worker/decoders/dsd/p25/tsbk.ts` | `core/src/p25/p25_rx.cpp` (onTsbk: voice grants, identifier updates, network, RFSS and adjacent site status, freqOf) |
| `src/client/worker/decoders/dsd/p25/calls.ts` | `core/src/p25/p25_rx.cpp` (NID, HDU, LDU link control and encryption sync, TDU / TDULC, TSBK and PDU blocks, calls, events) |
| `test/decoders/dsd/p25/fixtures.js` | `core/src/p25/p25_gen.cpp` (frame builder, LDU hexbits, TSBK frames, known voice, test schedule, C4FM), `rust/onair_p25/src/imbe.rs` (interleave) |
| `test/decoders/dsd/p25/proto.spec.js` | `tests/p25/test_p25_proto.cpp`, `tests/p25/test_p25_cc.cpp`, `rust/onair_p25/src/tests.rs` |
| `test/decoders/dsd/p25/stream.spec.js` | `tests/p25/test_p25_rx.cpp`, `tests/p25/test_p25_sens.cpp` |
| `src/client/worker/decoders/dsd/dmr/types.ts` | `core/include/dect2/dmr/dmr_proto.h` (FullLc, Csbk, DataHeader, DataBlock, TalkerAlias), `dmr_tel.h` (DmrMessage, DmrLocation), `dmr_vendor.h`, `dmr_xpt.h`, `core/include/dect2/p25/trunk.h` (Grant) |
| `src/client/worker/decoders/dsd/dmr/codes.ts` | `rust/onair_dmr/src/codes.rs` (Golay (20,8), QR (16,7,6), Hamming codes, Reed-Solomon (12,9), CRC-CCITT, CRC-8, CRC-9, CRC-32, checksum5), `rust/onair_dmr/src/bits.rs` |
| `src/client/worker/decoders/dsd/dmr/product.ts` | `rust/onair_dmr/src/product.rs` (BPTC (196,96), embedded LC, short LC, CACH, rate 3/4 trellis, rate 1) |
| `src/client/worker/decoders/dsd/dmr/burst.ts` | `rust/onair_dmr/src/burst.rs` (sync patterns, burst builders, slot type, EMB), `core/src/dmr/dmr_proto.cpp` (burstDataPayload), `core/src/dmr/dmr_link.cpp` (bptcAssisted, payloadReliability, symbol fit) |
| `src/client/worker/decoders/dsd/dmr/lc.ts` | `rust/onair_dmr/src/lc.rs` (full LC, header / terminator Reed-Solomon, CRC blocks, CSBK); the GPS info LC is BrowSDR's after TS 102 361-2 |
| `src/client/worker/decoders/dsd/dmr/data.ts` | `rust/onair_dmr/src/data.rs` (data headers, data blocks of rate 1/2, 3/4 and 1, CRC-9) |
| `src/client/worker/decoders/dsd/dmr/text.ts` | `rust/onair_dmr/src/text.rs` (defined data formats, text clean-up, TalkerAlias) |
| `src/client/worker/decoders/dsd/dmr/position.ts` | `core/src/dmr/dmr_lrrp.cpp` (LRRP parser, IPv4 check, compressed header), `core/src/dmr/dmr_nmea.cpp` (parseDmrNmea) |
| `src/client/worker/decoders/dsd/dmr/vendor.ts` | `core/src/dmr/dmr_vendor.cpp` (Capacity Plus, Connect Plus, ARS, TMS; layouts DSD-FME's, credited there to OP25 and Eric Cottrell) |
| `src/client/worker/decoders/dsd/dmr/xpt.ts` | `core/src/dmr/dmr_xpt.cpp` (Hytera XPT; field positions DSD-FME's) |
| `src/client/worker/decoders/dsd/dmr/control.ts` | `core/src/p25/trunk_ctrl.cpp` (DmrModel::onCsbk, onCsbkVendor), `core/src/dmr/dmr_link.cpp` (activityName, short LC of handleCach); Tier III layouts per TS 102 361-4 as DSD-FME reads them |
| `src/client/worker/decoders/dsd/dmr/message.ts` | `core/src/dmr/dmr_link.cpp` (Link::finishMessage) |
| `src/client/worker/decoders/dsd/dmr/link.ts` | `core/src/dmr/dmr_link.cpp` (Link::decodeBurst classification, decodeData, voiceBurst, startCall, endCall, handleCach) |
| `test/decoders/dsd/dmr/fixtures.js` | `core/src/dmr/dmr_gen.cpp` (SlotScript, DmrSignal, Shaper), `core/src/dmr/dmr_lrrp.cpp` (encoders), `core/src/dmr/dmr_proto.cpp` (talkerAliasPdus), `core/include/dect2/dmr/dmr_dsp.h` (rrcTaps) |
| `test/decoders/dsd/dmr/codes.spec.js` | `tests/dmr/test_dmr_fec.cpp`, `rust/onair_dmr/src/tests.rs` |
| `test/decoders/dsd/dmr/proto.spec.js` | `tests/dmr/test_dmr_lrrp.cpp`, `tests/dmr/test_dmr_nmea.cpp`, `tests/dmr/test_dmr_vendor.cpp`, `tests/dmr/test_dmr_xpt.cpp`, `rust/onair_dmr/src/tests.rs` |
| `test/decoders/dsd/dmr/stream.spec.js` | `tests/dmr/test_dmr_rx.cpp`, `tests/dmr/test_dmr_xpt.cpp`, `tests/dmr/test_dmr_lrrp_air.cpp` |
| `src/client/worker/decoders/digimode/flarm/types.ts` | `core/include/dect2/flarm/flarm_proto.h` (V6), `core/include/dect2/avroad/avroad_proto.h` (OgnPacket), `core/include/dect2/adsl/adsl_proto.h` (Traffic, Status, Parsed), `core/src/flarm/flarm_rx.cpp` (Cand, Pending) |
| `src/client/worker/decoders/digimode/flarm/flarm-proto.ts` | `core/src/flarm/flarm_proto.cpp` (CRC, XXTEA, V6 key and packet, position and velocity fields, frame chips) |
| `src/client/worker/decoders/digimode/flarm/ogn-proto.ts` | `core/src/avroad/avroad_air.cpp` (OGN whitening, LDPC check and repair, ognParse), `core/src/avroad/ogn_ldpc.inc` (parity checks; OGN-Tracker by Pawel Jalocha via SoftRF, GPL-3.0) |
| `src/client/worker/decoders/digimode/flarm/adsl-rs.ts` | `core/src/adsl/adsl_proto.cpp` (GF(256), Reed-Solomon encoder and decoder) |
| `src/client/worker/decoders/digimode/flarm/adsl-proto.ts` | `core/src/adsl/adsl_proto.cpp` (CRC-24, scrambling, exponential fields, Traffic, Status, network packet, CRC repair, names) |
| `src/client/worker/decoders/digimode/flarm/dsp.ts` | `core/include/dect2/dsp/fast_phase.h` (fastAtan2) |
| `src/client/worker/decoders/digimode/flarm/front.ts` | `core/src/flarm/flarm_rx.cpp` (channel mixers and low-pass) |
| `src/client/worker/decoders/digimode/flarm/channel.ts` | `core/src/flarm/flarm_rx.cpp` (processChan, blockEnd, commitGroup), `core/src/adsl/adsl_rx.cpp` (M-band processChan, readByte, packetLevel) |
| `src/client/worker/decoders/digimode/flarm/ogn.ts` | `core/src/avroad/avroad_air.cpp` (OgnDec: process, chip, finish) |
| `src/client/worker/decoders/digimode/flarm/flarm.ts` | `core/src/flarm/flarm_rx.cpp` (tryJob with Chase decoding, onFrame, apply) |
| `src/client/worker/decoders/digimode/flarm/adsl.ts` | `core/src/adsl/adsl_rx.cpp` (tryJob, tryNet, onPacket, applyTraffic) |
| `src/client/worker/decoders/digimode/flarm/report.ts` | `core/src/geo/maidenhead.cpp` (greatCircle), `core/src/flarm/flarm_rx.cpp`, `core/src/adsl/adsl_rx.cpp` (aircraft expiry) |
| `src/client/worker/decoders/digimode/flarm/index.ts` | `core/src/flarm/flarm_rx.cpp` (FlarmReceiver), `core/src/adsl/adsl_rx.cpp` (AdslReceiver, M-band), `core/src/avroad/avroad_air.cpp` (OgnDec) |
| `test/digimode/flarm/fixtures.js` | `core/src/flarm/flarm_gen.cpp` (flarmBurst, flarmScene), `core/src/adsl/adsl_gen.cpp` (adslBurst, adslScene, adslTrafficNet), `core/src/adsl/adsl_proto.cpp` (frameChips), `tests/flarm/test_flarm_rx.cpp` (mk, twice) |
| `test/digimode/flarm/ogn-fixtures.js` | `core/src/avroad/avroad_air.cpp` (ognParity), `core/src/avroad/ogn_ldpc.inc` (generator table), `tests/avroad/test_avroad_air.cpp` (ognPacket, ognChips, ognScene), `tests/avroad/avroad_gen.h` (appendFsk, addNoise) |
| `test/digimode/flarm/proto.spec.js` | `tests/flarm/test_flarm_proto.cpp`, `tests/avroad/test_avroad_air.cpp` (OGN format), `tests/adsl/test_adsl_proto.cpp` |
| `test/digimode/flarm/flarm.spec.js` | `tests/flarm/test_flarm_rx.cpp`, `test_flarm_impair.cpp`, `test_flarm_chase.cpp` |
| `test/digimode/flarm/ogn.spec.js` | `tests/avroad/test_avroad_air.cpp` (testOgn) |
| `test/digimode/flarm/adsl.spec.js` | `tests/adsl/test_adsl_rx.cpp`, `test_adsl_tone.cpp` |
| `src/client/worker/decoders/digimode/fanet/types.ts` | `core/include/dect2/avroad/avroad_proto.h` (FanetFrame), `core/src/avroad/avroad_air.cpp` (FanetDec settings); thermal, landmark and service fields from the FANET protocol description (protocol.txt of Skytraxx's [fanet-stm32](https://github.com/3s1d/fanet-stm32), format only) |
| `src/client/worker/decoders/digimode/fanet/names.ts` | `core/src/avroad/avroad_air.cpp` (fanetParse: aircraft types, ground states; FanetDec::feed: sender); manufacturers, frame types and landmark names from the FANET protocol description |
| `src/client/worker/decoders/digimode/fanet/proto.ts` | `core/src/avroad/avroad_air.cpp` (s24, fanetParse); turn rate, QNE offset, thermals, landmarks and compressed coordinates from the FANET protocol description |
| `src/client/worker/decoders/digimode/fanet/report.ts` | `core/src/avroad/avroad_air.cpp` (FanetDec::feed: the row of a frame) |
| `src/client/worker/decoders/digimode/fanet/index.ts` | `core/src/avroad/avroad_air.cpp` (FanetDec), `avroad_dec.cpp` (FANET tuning), `core/src/loraraw/loraraw_rx.cpp` (LoRa receiver defaults) |
| `test/digimode/fanet/fixtures.js` | `tests/avroad/test_avroad_air.cpp` (fanetTrack, fanetIq) |
| `test/digimode/fanet/proto.spec.js` | `tests/avroad/test_avroad_air.cpp` (testFanet: formats) |
| `test/digimode/fanet/fanet.spec.js` | `tests/avroad/test_avroad_air.cpp` (testFanet: offsets, 500 kHz zone, SNR sweep, three frames, noise) |
| `test/digimode/fanet/worker.spec.js` | `tests/avroad/test_avroad_air.cpp` (testFanet) |
| `src/client/worker/decoders/digimode/mpt1327/types.ts` | `core/include/dect2/mpt1327/mpt1327_proto.h` (Address, Message), `mpt1327_rx.h` (SyncMode, Event, Stats) |
| `src/client/worker/decoders/digimode/mpt1327/proto.ts` | `core/src/mpt1327/mpt1327_proto.cpp` (check bits, single-error repair, fields, special idents, CCSC, address codeword messages) |
| `src/client/worker/decoders/digimode/mpt1327/rx.ts` | `core/src/mpt1327/mpt1327_rx.cpp` (FFSK demodulator, sync search, standard and tolerant framing) |
| `src/client/worker/decoders/digimode/mpt1327/index.ts` | `core/src/mpt1327/mpt1327_engine.cpp` (FM audio into the decoder, message rows, summary; no call following) |
| `test/digimode/mpt1327/fixtures.js` | `core/src/mpt1327/mpt1327_gen.cpp` (codeword builders, CCSC, control channel bits, FFSK audio, FM), `tests/mpt1327/test_mpt1327.cpp` (sampleMessages) |
| `test/digimode/mpt1327/mpt1327.spec.js` | `tests/mpt1327/test_mpt1327.cpp`, `test_mpt1327_std.cpp` |
| `src/client/worker/decoders/digimode/inmarsat-c/types.ts` | `core/include/dect2/inmc/inmc_tel.h` (InmcMessage, InmcNcsInfo), `inmc_code.h` (FrameDecode), `inmc_pkt.h` (FrameParser slots), `inmc_egc.h` (EgcInfo) |
| `src/client/worker/decoders/digimode/inmarsat-c/code.ts` | `core/src/inmc/inmc_code.cpp` (unique word, scrambler, convolutional code, interleaver, soft Viterbi, unique word fit with a polarity flip, packet check bytes) |
| `src/client/worker/decoders/digimode/inmarsat-c/tables.ts` | `core/src/inmc/inmc_pkt.cpp` (ocean regions, stations, services, descriptors, ITA2, text presentation) |
| `src/client/worker/decoders/digimode/inmarsat-c/egc.ts` | `core/src/inmc/inmc_egc.cpp` (NAVAREA / METAREA, warning number and subject of an EGC message) |
| `src/client/worker/decoders/digimode/inmarsat-c/packets.ts` | `core/src/inmc/inmc_pkt.cpp` (FrameParser: bulletin board, signalling channel, EGC assembly, multiframe packets) |
| `src/client/worker/decoders/digimode/inmarsat-c/demod.ts` | `core/src/inmc/inmc_rx.cpp` (carrier search by squaring, carrier mixer, RRC matched filter, Gardner timing, Costas loop, Es/N0); no channel mixer or CIC (BrowSDR's channel filter) |
| `src/client/worker/decoders/digimode/inmarsat-c/framer.ts` | `core/src/inmc/inmc_rx.cpp` (frame sync on the unique word, polarity slips, decodeAt) |
| `src/client/worker/decoders/digimode/inmarsat-c/report.ts` | `app/inmc/inmc_ui.cpp` (what is shown of an EGC message), `core/include/dect2/inmc/inmc_tel.h` (inmcSummary) |
| `src/client/worker/decoders/digimode/inmarsat-c/index.ts` | `core/src/inmc/inmc_rx.cpp` (InmcReceiver: one channel, reports, log lines; no band search) |
| `test/digimode/inmarsat-c/fixtures.js` | `core/src/inmc/inmc_gen.cpp` (InmcFrameSource, RRC modulator), `core/src/inmc/inmc_pkt.cpp` (packet builders) |
| `test/digimode/inmarsat-c/code.spec.js` | `tests/inmc/test_inmc_code.cpp` |
| `test/digimode/inmarsat-c/packets.spec.js` | `tests/inmc/test_inmc_pkt.cpp`, `test_inmc_egc.cpp` |
| `test/digimode/inmarsat-c/receiver.spec.js` | `tests/inmc/test_inmc_rx.cpp`, `test_inmc_impair.cpp`, `test_inmc_basic.cpp` |
| `test/digimode/inmarsat-c/worker.spec.js` | `tests/inmc/test_inmc_engine.cpp` |
| `src/client/worker/decoders/digimode/aero/types.ts` | `core/include/dect2/aero/aero_phy.h`, `aero_demod.h`, `aero_su.h`, `aero_acars.h`, `aero_adsc.h`, `aero_cpdlc.h`, `aero_pos.h` (frame, SU, ACARS, ADS-C, CPDLC and position shapes), `core/include/dect2/inmsat/inmsat_satid.h` (SatDef) |
| `src/client/worker/decoders/digimode/aero/phy.ts` | `core/src/aero/aero_phy.cpp` (frame formats, unique word, header, scrambler, interleaver, convolutional code, continuous soft Viterbi, SU CRC, frame encoder and decoder; constants from JAERO, Jonti Olds, MIT) |
| `src/client/worker/decoders/digimode/aero/framer.ts` | `core/src/aero/aero_demod.cpp` (AeroFramer: unique word search on one or both arms, flywheel, false syncs, data carrier detect) |
| `src/client/worker/decoders/digimode/aero/demod.ts` | `core/src/aero/aero_demod.cpp` (AeroDemod: squared-signal carrier search, MSK and OQPSK matched filters, carrier and timing loops, soft bits; no 8400 bit/s C channel) |
| `src/client/worker/decoders/digimode/aero/search.ts` | `core/src/aero/aero_rx.cpp` (band search: spectra, carrier regions), limited to the VFO's channel |
| `src/client/worker/decoders/digimode/aero/su.ts` | `core/src/aero/aero_su.cpp` (SU types, split, system table reading, description; after JAERO) |
| `src/client/worker/decoders/digimode/aero/isu.ts` | `core/src/aero/aero_su.cpp` (AeroSuDecoder: ISU / SSU assembly, ACARS reassembly, log-ons), `core/src/aero/aero_acars.cpp` (block framing, parity, label names); the block fields by BrowSDR's VDL2 ACARS parser |
| `src/client/worker/decoders/digimode/aero/arinc.ts` | `core/src/aero/aero_adsc.cpp` (ARINC 622 CRC, ground address), `core/src/aero/aero_cpdlc.cpp` (CPDLC envelope; the libacars ASN.1 body decoder is not ported) |
| `src/client/worker/decoders/digimode/aero/adsc.ts` | `core/src/aero/aero_adsc.cpp` (ADS-C downlink groups, contract requests, descriptions; layouts after libacars, Tomasz Lemiech, MIT) |
| `src/client/worker/decoders/digimode/aero/pos.ts` | `core/src/aero/aero_pos.cpp` (positions from ADS-C and text reports; no general ACARS text interpreter) |
| `src/client/worker/decoders/digimode/aero/satellites.ts` | `core/src/inmsat/inmsat_satid.cpp` (satellite table, geoLook, the satellite named by the system table) |
| `src/client/worker/decoders/digimode/aero/receiver.ts` | `core/src/aero/aero_rx.cpp` (carrier table, rate per carrier, frames into the SU layer, system table facts), `core/include/dect2/aero/aero_front.h` (mixer) |
| `src/client/worker/decoders/digimode/aero/report.ts` | `core/src/aero/aero_rx.cpp` (what a message, log-on and position say), `app/aero/aero_ui.cpp` (the message detail) |
| `src/client/worker/decoders/digimode/aero/index.ts` | `core/src/aero/aero_rx.cpp` (AeroReceiver reports, aircraft names), `core/include/dect2/aero/aero_tel.h` (aeroSummary) |
| `test/digimode/aero/fixtures.js` | `core/src/aero/aero_su.cpp`, `aero_acars.cpp`, `aero_adsc.cpp`, `aero_cpdlc.cpp` (the builders of the test signal) |
| `test/digimode/aero/signal.js` | `core/src/aero/aero_demod.cpp` (AeroModulator), `core/src/aero/aero_gen.cpp` (AeroSynth: aircraft, script, positions, schedule, interpolator) |
| `test/digimode/aero/phy.spec.js` | `tests/aero/test_aero_phy.cpp`, `test_aero_demod.cpp` |
| `test/digimode/aero/su.spec.js` | `tests/aero/test_aero_su_layers.cpp`, `test_aero_acars_real.cpp`, `test_aero_adsc.cpp`, `test_aero_cpdlc.cpp` |
| `test/digimode/aero/receiver.spec.js` | `tests/aero/test_aero_rx.cpp`, `test_aero_rates.cpp`, `test_aero_map.cpp`, `test_aero_basic.cpp` |
| `test/digimode/aero/worker.spec.js` | `tests/aero/test_aero_engine.cpp` |
