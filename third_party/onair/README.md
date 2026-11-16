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
| `src/client/worker/decoders/digimode/lora/presets.ts` | `core/src/mesh/mesh_proto.cpp` (Meshtastic presets, regions and slots, default keys), `mesh_presets.cpp`, `mesh_presets_data.cpp` (MeshCore presets), `mesh_proto_aprs.cpp` (loraAprsPresets), `mesh_proto_lorawan.cpp` (lorawanPresets) |
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
