# Digital Voice (DSD mode)

Set a VFO to the DSD mode and it finds the protocol by itself: DMR, P25 Phase 1,
D-STAR, NXDN, Yaesu System Fusion (YSF) and dPMR mode 1. Voice plays through
mbelib (AMBE, AMBE+2 and IMBE) in WebAssembly. The VFO panel shows the
protocol, the voice frame error bar and what each protocol carries:

| Protocol | Shown                                                                                                                                      | VFO bandwidth     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| DMR      | Colour code, slot, burst types, talkgroup or unit call, privacy flag                                                                       | 12.5 kHz          |
| P25      | NAC, data unit, source, talkgroup, emergency, encryption algorithm                                                                         | 12.5 kHz          |
| D-STAR   | Callsign from the header                                                                                                                   | 6.25–12.5 kHz     |
| NXDN     | Frame type                                                                                                                                 | 12.5 kHz (NXDN96) |
| YSF      | Source, destination, uplink and downlink callsigns, DG-ID, DN / VW / data mode, slow-data text, GPS position. Voice in DN and VW modes.    | 12.5 kHz          |
| dPMR     | Own and called IDs, call type, colour code, communication mode, emergency flag, status and short messages, packet data, how the call ended | 6.25–8 kHz        |

YSF and dPMR are ported from [OnAir](https://github.com/adswill/OnAir)
(GPL-3.0-or-later, see `third_party/onair`).

## Limits

- Tune within about 1.5 kHz of the channel; there is no automatic frequency
  correction.
- Only the latest transmission is shown; there is no call log and no PMR446
  channel scan.
- Encrypted voice is not decrypted.
- YSF and dPMR were tested on signals from OnAir's generators, not yet on
  off-air recordings.
