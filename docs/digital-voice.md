# Digital Voice (DSD mode)

Set a VFO to the DSD mode and it finds the protocol by itself: DMR, P25 Phase 1,
P25 Phase 2, D-STAR, NXDN, Yaesu System Fusion (YSF), dPMR mode 1 and M17. DMR,
P25 (both phases), D-STAR, NXDN, YSF and dPMR voice plays through mbelib (AMBE,
AMBE+2 and IMBE); M17 voice uses Codec2 3200 or 1600 in separate WebAssembly.
The VFO panel shows the protocol, the voice frame error bar and what each
protocol carries:

| Protocol | Shown                                                                                                                                                                                                                                                                                             | VFO bandwidth     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| DMR      | Colour code, slot, burst types, talkgroup or unit call (also when joined late), emergency, privacy; talker alias; GPS, LRRP and NMEA positions; short data and Motorola TMS texts; Tier III, Capacity Plus, Connect Plus and Hytera XPT grants and site; CACH slot activity; the 20 latest events | 12.5 kHz          |
| P25      | NAC, data unit, source, talkgroup, emergency, encryption algorithm                                                                                                                                                                                                                                | 12.5 kHz          |
| P25 Ph2  | Both time slots: source, talkgroup or unit, call state, emergency, encryption algorithm; WACN, system ID and NAC; last grant and site                                                                                                                                                             | 12.5 kHz          |
| D-STAR   | MY with suffix, YOUR, RPT1, RPT2, flags, 20-character message, D-PRS / NMEA position, code squelch, how the call ended; the 20 latest events                                                                                                                                                      | 6.25–12.5 kHz     |
| NXDN     | Frame type                                                                                                                                                                                                                                                                                        | 12.5 kHz (NXDN96) |
| YSF      | Source, destination, uplink and downlink callsigns, DG-ID, DN / VW / data mode, slow-data text, GPS position. Voice in DN and VW modes.                                                                                                                                                           | 12.5 kHz          |
| dPMR     | Own and called IDs, call type, colour code, communication mode, emergency flag, status and short messages, packet data, how the call ended                                                                                                                                                        | 6.25–8 kHz        |

M17 shows source and destination callsigns, CAN, stream type, encryption flag,
text and CRC-checked packet messages. It plays clear Codec2 voice.

D-STAR, YSF, dPMR, M17, P25 Phase 2 and the DMR link layer are ported from
[OnAir](https://github.com/adswill/OnAir) (GPL-3.0-or-later, see
`third_party/onair`).

## DMR

Every burst of both slots is read, including data on the other slot during a
voice superframe. The talker alias, positions, texts, trunking lines and the
event list stay after the carrier drops and are cleared on retune.

## P25 Phase 2

Phase 2 is a two-slot TDMA voice channel at 6000 symbols/s (H-DQPSK). Its
receiver runs on the complex channel beside the other DSD receivers and rests
while another protocol holds the lock. It finds the sync word, measures and
corrects the carrier offset itself (up to about ±4 kHz inside the 12.5 kHz
channel) and reads the slot of the superframe from the I-ISCH. Both slots are
shown; the first slot heard plays. Voice is AMBE+2 half rate through mbelib.

Each channel is scrambled with a sequence seeded by the system's WACN, system
ID and NAC. OnAir takes these from the Phase 1 control channel (its trunking
follower) or from the user. BrowSDR has neither, so it solves them from the
first error-free scrambled SACCH or FACCH burst: the scrambler and the MAC code
are both linear, so one burst gives the 44 seed bits, and the burst must then
pass its Reed-Solomon and CRC-12 checks. The panel then shows the WACN, system
ID and NAC with "seed found". Channels whose MAC bursts are sent unscrambled
need no seed.

## Limits

- DMR data and trunking were tested on OnAir's generator and captured code
  vectors, not on off-air recordings. Tier III grants show logical channel
  numbers, not frequencies; Hytera XPT layouts are experimental; MBC absolute
  channel parameters, reverse channel bursts and headers without a sync word are
  not decoded. Encrypted DMR voice still plays (as noise); only the flag is shown.
  DMR positions are listed in the panel, not on the APRS map.

- Tune within about 1.5 kHz of the channel; apart from P25 Phase 2 there is no
  automatic frequency correction.
- Only the latest transmission is shown, with a short list of recent events
  (D-STAR); there is no call log and no PMR446 channel scan.
- D-STAR positions (D-PRS and NMEA) are shown in the panel, not on the APRS
  map: the map takes the stations of a VFO's own APRS decoder only.
- D-STAR voice uses the AMBE 3600x2400 codec, which BrowSDR's mbelib build
  does not include: its voice frames reach the AMBE+2 decoder and do not sound
  right. D-STAR fast data is not decoded.
- Encrypted voice is not decrypted.
- YSF and dPMR were tested on signals from OnAir's generators, not yet on
  off-air recordings.
- M17 was compared with OnAir's frame generator and tested through the DSD
  symbol clock; it has not yet been validated on an off-air recording. A
  signal more than about 1.5 kHz off centre may not acquire.
- P25 Phase 2 was tested on signals from OnAir's generator, not yet on an
  off-air recording. Its MAC PDU layout is OnAir's reading of the standard: if a
  real system differs, its MAC messages (talkgroup, source, grants) are not
  decoded and the seed is not found. Without the seed the encryption sync cannot
  be read, so voice stays muted ("encryption unknown") instead of playing noise.
- P25 Phase 2 decodes voice channels only (4V and 2V voice, SACCH and FACCH).
  Phase 2 control channels (LCCH), the inbound H-CPM signal, talkgroup lists and
  adjacent sites are not decoded. The voice of a call joined late is held until
  its encryption sync says it is clear.
