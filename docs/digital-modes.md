# Digital Modes

Open **Tools → Digital Modes**, pick a VFO and a decoder, press **Tune** for the
usual frequency of the mode (or tune by hand), then start reception. Each VFO
runs at most one Digital Modes decoder; audio can stay muted. Decoded calls,
messages and frames go to one log (newest first, search, details on click,
JSON export); decoders that make pictures draw them beside the log, with
**Save PNG**.

The decoders are ported from [OnAir](https://github.com/adswill/OnAir)
(GPL-3.0-or-later with an attribution term): see
[third_party/onair](../third_party/onair/README.md) for the list of ported files
and the About dialog for the credits.

| Decoder                              | Frequencies                                                                                                    | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DSC (VHF channel 70)                 | 156.525 MHz                                                                                                    | Digital selective calls (ITU-R M.493): distress alerts and relays (highlighted), safety, urgency and routine calls, positions, proposed channels, MMSI kinds. DX/RX time diversity and the check character repair damaged symbols.                                                                                                                                                                                                                |
| CubeSat AX.25 telemetry              | 437.825 MHz (ISS APRS, ARISS November 2026), 145.825 MHz alternate, satellite downlinks                        | AX.25 frames at 1200 bd AFSK and 9600 / 4800 bd G3RUH FSK at once; binary telemetry as bytes with a hex dump. Pair with Tools → Satellites for Doppler.                                                                                                                                                                                                                                                                                           |
| LoRa satellites (TinyGS)             | 137–905 MHz presets (SatNOGS DB, OnAir); one entry per bandwidth: 125, 250, 500, 62.5, 41.7 kHz                | LoRa frames of satellites: SF7 to SF12, any sync word, normal and inverted IQ at once, the Doppler shift and its rate followed through each frame; Doppler, rate, SF, bandwidth, coding rate, sync word, IQ, SNR, level, the payload in hex and as text. A pasted TinyGS modem configuration runs exactly; Tools → Satellites names the satellite and tells the decoder its Doppler.                                                              |
| ORBCOMM                              | 137.2–137.8 MHz; presets 137.2500, 137.2875, 137.3125, 137.4625, 137.6625, 137.7375 MHz                        | 4800 bit/s SDPSK downlinks: sync/satellite ID, checksum-checked message and system fragments, complete reassembled binary blocks, and two-slot ephemeris with satellite position, altitude, velocity and GPS week/time. Subscriber message contents remain binary hex. Each VFO decodes one downlink; the ORBCOMM station bookmark configures two VFOs in one passband.                                                                           |
| SSTV (FM, ISS)                       | 145.800 MHz                                                                                                    | Slow-scan TV pictures during ARISS events.                                                                                                                                                                                                                                                                                                                                                                                                        |
| SSTV (USB, HF)                       | 14.230, 7.171, 3.735 MHz                                                                                       | Slow-scan TV in the upper sideband; tune the VFO to the dial frequency.                                                                                                                                                                                                                                                                                                                                                                           |
| NAVTEX                               | 518, 490, 4209.5 kHz                                                                                           | Maritime safety broadcasts (SITOR-B, 100 bd FSK): station, subject, number and the text; both polarities, the FSK centre is found automatically. Tune the VFO to the assigned frequency.                                                                                                                                                                                                                                                          |
| Inmarsat-C (EGC)                     | Alphasat 25E 1537.10 MHz; 54W 1541.45, 98W 1537.70, 143.5E 1541.45 MHz                                         | SafetyNET and FleetNET broadcasts from the NCS channel: navigational and meteorological warnings, search and rescue, with priority, NAVAREA/METAREA and the full text; distress and urgency messages are highlighted. Needs an L-band patch antenna and an LNA.                                                                                                                                                                                   |
| HF weather fax                       | DWD Pinneberg 3855, 7880, 13882.5 kHz; Northwood 4610, 8040 kHz (presets tune the USB dial 1.9 kHz below)      | Radiofax charts at 120 or 60 lines per minute (IOC 576 / 288) from the start tone and phasing, or picked up midway; the chart builds up beside the log and saves as PNG.                                                                                                                                                                                                                                                                          |
| VDL Mode 2                           | 136.975 (CSC) and the other 136.6–136.9 MHz channels                                                           | D8PSK aircraft data link: one line per AVLC frame with aircraft and ground station, ACARS messages (registration, flight, label, text; messages of several blocks reassembled and read with the ACARS library: FANS-1/A CPDLC, ADS-C, airline formats), ATN frames read up to CM logons and contacts and CPDLC messages (plain, and protected PM-CPDLC without its integrity check), link-management frames; Reed-Solomon repairs damaged octets. |
| HFDL                                 | Two channels of each ground station, e.g. Shannon 8942 and 11384 kHz (the VFO on the published frequency, USB) | HF Data Link of aircraft over oceans and remote areas: ground station squitters, logons, performance and frequency data with positions, ACARS (messages of several blocks reassembled) read with the ACARS library, FANS-1/A CPDLC and ADS-C included; positions also on the ADS-B map (grey, tagged HFDL, kept 30 minutes). One VFO per channel.                                                                                                 |
| Inmarsat Aero (data)                 | Alphasat 25E 1545.1225, 1545.32125, 1546.02 MHz; 54W and 83.5E presets                                         | Aircraft satellite data link at 600, 1200 and 10500 bit/s: log-ons with ICAO address, ACARS (messages of several blocks reassembled by the decoder), ADS-C reports and positions, FANS-1/A CPDLC messages decoded. Voice (C-channel) is not decoded. Needs an L-band patch antenna and an LNA.                                                                                                                                                    |
| Tone signalling                      | PMR446, 2 m FM, any FM voice channel                                                                           | CTCSS tones, DCS codes (normal and inverted), DTMF digits, five-tone selcall (ZVEI, CCIR, EEA, EIA, DZVEI), SELCAL and two-tone pages, one line per tone or call.                                                                                                                                                                                                                                                                                 |
| Wireless M-Bus                       | 868.95 MHz (T1, C1), 868.3 MHz (S1)                                                                            | Utility meters (EN 13757-4): manufacturer, device type, ID, readings of unencrypted meters; encrypted telegrams are listed with their mode, not decrypted. Needs a 400 kHz channel.                                                                                                                                                                                                                                                               |
| Meshtastic                           | 869.525 MHz (EU_868), US, ANZ, EU_433 and IN LongFast slots                                                    | LoRa mesh packets of every 250 kHz modem preset (LongFast to ShortFast): sender, destination, channel hash, hop limit and port; text messages, positions, node info, telemetry and traceroutes on the default channel key, private channels listed as encrypted. Needs a 500 kHz channel.                                                                                                                                                         |
| MeshCore                             | 869.618 MHz (EU/UK Narrow) and the other 62.5 kHz presets                                                      | LoRa mesh packets at SF7 to SF9: adverts with names, roles, positions and the signature check, Public channel messages, acks and traces; other channels and direct messages stay encrypted.                                                                                                                                                                                                                                                       |
| LoRaWAN (headers)                    | 868.1, 868.3, 868.5 and 867.1–867.9 MHz (EU868), 903.9 MHz (US915)                                             | Uplinks at SF7 to SF12: message type, DevAddr and its network, frame counter, flags, MAC commands, FPort and payload length, join requests with JoinEUI and DevEUI. Payloads are never decrypted.                                                                                                                                                                                                                                                 |
| LoRa APRS                            | 433.775 MHz (EU), 434.855 (PL), 439.9125 (UK)                                                                  | APRS over LoRa at SF12 and SF9: positions, objects, messages, status, weather and telemetry.                                                                                                                                                                                                                                                                                                                                                      |
| MeshCom                              | 433.175 MHz (EU) and the other 250 kHz SF11 presets; 439.9125, 433.925 MHz (125 kHz SF10)                      | Amateur LoRa mesh: text messages to all, a call or a group, positions with battery and altitude, beacons and acks.                                                                                                                                                                                                                                                                                                                                |
| FLARM, OGN and ADS-L                 | 868.3 MHz VFO (868.2 + 868.4 MHz channels); 917 MHz (North America, partial)                                   | Gliders and light aircraft: FLARM's old protocol, OGN trackers and ADS-L (M-band). ID, aircraft type, position, altitude, climb, speed, track and distance from the station. Stealth, no-track and anonymous aircraft are only counted. Needs a 400 kHz channel and the station location.                                                                                                                                                         |
| FANET                                | 868.2 MHz (EU), 920.8 MHz (Americas, Australia), 125 kHz zones                                                 | Paragliders and gliders over LoRa: aircraft type, position, altitude, climb, speed, heading and turn rate, names, messages, weather stations, thermals and landmarks, with distance from the station. Positions with online tracking off are only counted.                                                                                                                                                                                        |
| MPT 1327 (control channel)           | The network's control channel                                                                                  | Trunked radio signalling (1200 bd FFSK): calls with calling and called unit and traffic channel, ahoys, acknowledgements, data headers, system identity and broadcasts. Traffic channels are not followed.                                                                                                                                                                                                                                        |
| FT8                                  | 1.840, 3.573, 7.074, 10.136, 14.074, 18.100, 21.074, 24.915, 28.074, 50.313 MHz (USB dial)                     | Every station in the passband in 15 s UTC slots: call, report or locator (free text, telemetry, contest and hashed calls too), SNR and time offset, a few seconds after each slot. The computer clock must be right to about a second.                                                                                                                                                                                                            |
| FT4                                  | 3.575, 7.0475, 14.080, 21.140, 28.180 MHz (USB dial)                                                           | As FT8 in 7.5 s slots; the clock must be right to about half a second.                                                                                                                                                                                                                                                                                                                                                                            |
| WSPR                                 | 3.5686, 7.0386, 10.1387, 14.0956, 21.0946, 28.1246 MHz (USB dial)                                              | Propagation beacons in two-minute slots from the even minutes: call, locator and power (types 1 to 3, hashed calls resolved), SNR, time offset and audio frequency, down to about −28 dB in 2500 Hz.                                                                                                                                                                                                                                              |
| CW (Morse)                           | Band CW segments (presets 7 kHz into each)                                                                     | Every Morse signal within ±7 kHz of the dial at 5–50 WPM, each with its own speed and keying rhythm; a model of amateur traffic settles doubtful characters. One line per signal with offset, speed and SNR.                                                                                                                                                                                                                                      |
| RTTY                                 | 14.080–14.083, 7.036, 3.576 MHz and the other band presets (USB dial)                                          | ITA2 Baudot, 45.45 Bd / 170 Hz by default; Auto finds other speeds (50, 75, 100 Bd), shifts (85–850 Hz) and the polarity.                                                                                                                                                                                                                                                                                                                         |
| RTTY weather (DWD)                   | 4583, 7646, 10100.8 kHz (50 Bd / 450 Hz); 147.3 kHz (50 Bd / 85 Hz)                                            | Deutscher Wetterdienst marine weather reports; presets tune the USB dial 2 kHz below the assigned frequency.                                                                                                                                                                                                                                                                                                                                      |
| PSK31, PSK63, PSK125, QPSK31, QPSK63 | 14.070, 7.040, 3.580 MHz and the other band presets (USB dial)                                                 | Every PSK signal between 100 and 3900 Hz above the dial, each with its own AFC; one line of text per signal.                                                                                                                                                                                                                                                                                                                                      |

SSTV modes: Robot 36 and 72, Martin M1 and M2, Scottie S1, S2 and DX, PD50,
PD90, PD120 and PD180, Wraase SC2-180, from the VIS header or, when it was
missed, from the line sync pulses. The decoder follows the sender's line period
(slant) and filters noise adaptively; a clean picture passes unchanged.

## LoRa satellites (TinyGS)

[TinyGS](https://tinygs.com) ground stations (an ESP32 with an SX127x or SX126x
radio) hear LoRa satellites. The **LoRa satellites** decoders do the same with
an SDR. Choose the entry of the satellite's LoRa bandwidth: **LoRa satellites
(TinyGS, 125 kHz)**, or the 250, 500, 62.5 or 41.7 kHz entry. Then tune its
frequency, from a preset or with Tools → Satellites → **Decode on VFO**.

Without more information the decoder searches:

- SF7 to SF12 at once;
- any sync word whose two nibbles are not 0 (225 of the 256), and the one
  found is shown;
- normal and inverted IQ;
- in each frame's explicit header: the coding rate, and whether there is a
  CRC (checked when there is one);
- the low data rate optimisation, by SF and bandwidth as the radios set it.

The carrier is followed through every frame, as OnAir does, so the Doppler shift
and its rate during a pass do not break long frames. Each record gives:

- the Doppler offset at the first data symbol, its rate and the frequency;
- SF, bandwidth, coding rate, sync word, IQ, header, LDRO and CRC;
- SNR and level (dBFS, not calibrated);
- the payload in hex, and as text when at least 80 % of it is printable.

The VFO channel passes a Doppler shift of up to ±37.5 kHz at 125 kHz,
±40 kHz at 250 kHz, ±60 kHz at 500 kHz, ±20.75 kHz at 62.5 kHz and ±14 kHz at
41.7 kHz. That is more than a satellite at 600 km gives at 436 MHz (±10 kHz) or
868 MHz (±21 kHz), with room for the radio's own error. The 62.5 and 41.7 kHz
entries are meant for 70 cm and below.

### A TinyGS station's configuration

When the exact settings are known, paste the TinyGS modem configuration into the
field under the description and press **Use configuration**. This is the JSON of
the station's **Modem startup** setting (`modem_startup` on its local
configuration page), or the configuration the TinyGS web dashboard shows for a
satellite, for example:

```
{"mode":"LoRa","freq":436.703,"bw":250.0,"sf":10,"cr":5,"sw":18,"pl":8,"crc":true,"fldro":1,"sat":"Norbi","NORAD":46494}
```

It is read as the TinyGS firmware reads it:

- `freq` is in MHz and `bw` in kHz;
- `sw` is the sync word in decimal (18 is 0x12);
- `pl` is the preamble length;
- `crc` is true or false;
- `fldro` is 0 off, 1 on or 2 automatic;
- `iIQ` is inverted IQ;
- `len` is 0 for an explicit header, or the length of implicit-header frames.

A missing key reads as 0 or false, as on the station. JSON without `mode` is
refused, so is a frequency no TinyGS LoRa radio tunes (137 to 1020 MHz), and so
are the bandwidths, spreading factors and coding rates that RadioLib refuses.
The VFO then moves to the entry of that bandwidth and to `freq`, and the decoder
runs exactly those settings: one SF, its sync word, its IQ, its preamble, its
LDRO and, with `len`, the implicit header. Only a configuration can read
implicit-header frames. Bandwidths from 7.8 to 31.25 kHz run in the 41.7 kHz
entry's channel. **Blind search** goes back to the search.

An FSK configuration (`mode` other than `LoRa`) is named as such, with its bit
rate, deviation and sync word, and is not decoded. Of the 114 satellites in
TinyGS's list, SatNOGS DB lists only FSK, GFSK or GMSK transmitters for 31, and
both LoRa and FSK for 8 more. Decoding them would need TinyGS's FSK packet
format: an FSK demodulator at the configuration's bit rate, the sync word of
`fsw`, fixed or variable length, NRZ, Manchester or the SX126x whitening (`enc`,
`ws`), and the software CRC of `cSw`, `cB`, `cI`, `cP`, `cF`, `cRI` and `cRO`.
The CubeSat decoder only covers AX.25 at 1200 bd AFSK and 9600 bd G3RUH.

### Presets

Two sources give the presets:

- OnAir's ten LoRa satellite presets, each marked uncertain or plausible as in
  OnAir;
- the 25 LoRa transmitters that
  [SatNOGS DB](https://db.satnogs.org) (CC BY-SA 4.0) lists for 22 of TinyGS's
  satellites, read on 21 November 2026. The bandwidth comes from SatNOGS's
  `baud` field where it is set; a transmitter without one is under 125 kHz.

`scripts/tinygs/satnogs-lora.mjs` writes the SatNOGS table from a dump of its
transmitters and TinyGS's element file. None of the presets was checked against
a real signal.

The CPU cost of listening, all six SFs, any sync word and both IQ at once,
measured in noise in Node: about 4 % of one core at 125 kHz, 7.5 % at 250 kHz,
15 % at 500 kHz, 2 % at 62.5 kHz and 1 % at 41.7 kHz. Frames add a little
(5 % at 125 kHz during a pass, 11 % at 250 kHz with SF12).

## How it works

The DSP worker cuts a channel of the decoder's sample rate and width around the
VFO (for upper-sideband modes, a fixed offset above the dial) and hands the
decoder complex baseband. Records and picture rows go to the app a few times a
second. The decoder restarts when the VFO frequency changes, so modes that
tolerate the offset (FM SSTV, AX.25 with its AFC) are not Doppler-retuned by the
satellite tracker.

## Limits

- One decoder per VFO; add VFOs to run several.
- ORBCOMM needs a VFO on the actual downlink. Its presets are examples, not a channel scan; the current channel assignment can differ. Tools → Satellites shows TLE-based ORBCOMM passes and orbits. The decoder locked to a live pass at Cuneo on 17 November 2026 near 137.462 MHz and recovered Fletcher-valid packets from satellite ID 38. Complete 1F ephemeris blocks are decoded only when their combined 24-byte checksum and orbital range checks pass. Other blocks are reassembled by fragment number and shown as binary hex; their application fields and subscriber messages are not guessed from synthetic packet layouts.
- HF modes need HF reception (RTL-SDR direct sampling, an upconverter or an HF
  receiver).
- Wireless M-Bus loses about one telegram in twenty from meters that send only
  the shortest preamble the standard allows (as OnAir does).
- The LoRa decoders search every spreading factor of their bandwidth at once but
  only that bandwidth: Meshtastic's 125 and 500 kHz presets, MeshCore's 125 and
  250 kHz presets, LoRaWAN downlinks and MeshCom are not decoded.
- The LoRa satellite decoders were tested on OnAir's pass generator only:
  - straight-line passes;
  - the symbol clock stretched by the Doppler shift;
  - noise.

  No real satellite recording was available. Real passes add things the tests
  do not have: oscillator drift, fading, interference and framing. SF12 at
  868 MHz near the closest approach (about 280 Hz/s) is the edge of what the
  carrier loop follows. SF5 and SF6 are searched only from a configuration. The
  2.4 GHz TinyGS radio (SX1280) is not decoded.

- RTTY, PSK and CW emit one record per line of text (a newline, 80 characters
  or a pause); the line still being received is shown in the status.
- FT8, FT4 and WSPR read the slot timing from the computer clock, so keep it
  synchronised (NTP). They decode a slot in small steps while the next one
  arrives, so FT8 results appear 2–3 s into the next slot. Upside-down
  (lower-sideband) signals are not searched for, as in WSJT-X. FT2, early
  decodes, the JT65/JT9/Q65/FST4 family and spotting to PSK Reporter or WSPRnet
  are not included.
- FLARM decodes only the old protocol, with the publicly documented key scheme
  that follows the computer clock; the newer protocol is counted, not decoded.
  ADS-L on the O-band (869.525 MHz) is outside the channel.
- HFDL decodes one channel per VFO; OnAir's wide multi-channel capture, its ADS-C
  reader and its live ground-station list are not included.
- ACARS on VDL2 and HFDL is reassembled and read in the app with the ACARS
  library it already loads, so the DSP workers stay small: one decoder session
  per VFO, each aircraft and direction apart (by 24-bit address on VDL2, by
  registration on HFDL), started again when the VFO's decoder or frequency
  changes. Only blocks whose check sequence is good are used; a message is put
  together only when its blocks arrive in order within the library's window (at
  most two minutes between downlink blocks, 90 s between uplink blocks, five
  minutes in all), and a missing block is never filled in: the message then stays
  in parts. FANS-1/A CPDLC and ADS-C are read only when
  their ARINC 622 CRC is good. Aero reassembles its own messages and sends the
  CPDLC bodies to the app the same way.
- ATN on VDL2 (CPDLC in Europe) is also read in the app, with the ACARS
  library's passive stack, from the X.25 packets of frames whose check sequence
  is good: X.25 reassembly per circuit and direction, CLNP (only PDUs whose
  header checksum verifies, as the library requires; compressed CLNP only after
  the PDU that set up its local reference was received), COTP class 4 (a
  connection is followed from its CR and CC; a data TPDU of a connection whose
  set-up was not followed, or that waits for one not received, is read on its
  own when it ends its message and its own checksum verifies), the ATN session,
  presentation and ACSE, then CM and CPDLC. The application comes from the AE
  qualifier of the connection's AARQ or AARE (1 CM, 2 CPDLC, 22 PM-CPDLC);
  without one, a message is shown only when exactly one of CM, CPDLC and
  PM-CPDLC reads it completely in its direction, and the record says which way
  was used. Protected CPDLC (PM-CPDLC, the LINK2000+ form): the library keeps the
  protected message opaque because it cannot verify the integrity check (bound to
  the aircraft address, flight and ground facility); its bits are an ATC
  message's PER encoding, which is read with the library's plain CPDLC reader and
  marked "ATN integrity check not verified", as dumpvdl2 shows it. X.25 has no
  start-of-message mark, so a circuit is read from its call (or reset), from the
  packet after one that ended a message, or from a packet that is a whole
  uncompressed CLNP PDU: the first packets heard from an aircraft already
  connected, and the one after a lost packet, can be skipped. IDRP and ES-IS
  are shown briefly (type, sequence or holding time, addresses); ATN ADS-C and
  the Mobile SNDCF Deflate compression are not decoded. The ATN part was tested
  on frames built from the protocol definitions only: no real ATN capture was
  available.
- Inmarsat-C and Aero were tested on OnAir's generator only, not on a real
  capture. Both search the carrier within about ±18–20 kHz of the VFO, which
  covers an RTL-SDR's typical error at 1.5 GHz.
- Remote clients do not receive Digital Modes output yet.

ORBCOMM packet layout references: [public downlink packet examples](https://www.emitters.space/Orbcomm.pdf) and the
[ORBCOMM-receiver packet reader](https://github.com/fbieberly/ORBCOMM-receiver/blob/master/orbcomm_packet.py).
