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
