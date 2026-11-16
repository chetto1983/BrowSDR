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

| Decoder                 | Frequencies                                                                                               | What it shows                                                                                                                                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DSC (VHF channel 70)    | 156.525 MHz                                                                                               | Digital selective calls (ITU-R M.493): distress alerts and relays (highlighted), safety, urgency and routine calls, positions, proposed channels, MMSI kinds. DX/RX time diversity and the check character repair damaged symbols.                                                        |
| CubeSat AX.25 telemetry | 145.825 MHz (ISS), satellite downlinks                                                                    | AX.25 frames at 1200 bd AFSK and 9600 / 4800 bd G3RUH FSK at once; binary telemetry as bytes with a hex dump. Pair with Tools → Satellites for Doppler.                                                                                                                                   |
| SSTV (FM, ISS)          | 145.800 MHz                                                                                               | Slow-scan TV pictures during ARISS events.                                                                                                                                                                                                                                                |
| SSTV (USB, HF)          | 14.230, 7.171, 3.735 MHz                                                                                  | Slow-scan TV in the upper sideband; tune the VFO to the dial frequency.                                                                                                                                                                                                                   |
| NAVTEX                  | 518, 490, 4209.5 kHz                                                                                      | Maritime safety broadcasts (SITOR-B, 100 bd FSK): station, subject, number and the text; both polarities, the FSK centre is found automatically. Tune the VFO to the assigned frequency.                                                                                                  |
| HF weather fax          | DWD Pinneberg 3855, 7880, 13882.5 kHz; Northwood 4610, 8040 kHz (presets tune the USB dial 1.9 kHz below) | Radiofax charts at 120 or 60 lines per minute (IOC 576 / 288) from the start tone and phasing, or picked up midway; the chart builds up beside the log and saves as PNG.                                                                                                                  |
| VDL Mode 2              | 136.975 (CSC) and the other 136.6–136.9 MHz channels                                                      | D8PSK aircraft data link: one line per AVLC frame with aircraft and ground station, ACARS messages (registration, flight, label, text), ATN and link-management frames; Reed-Solomon repairs damaged octets.                                                                              |
| Tone signalling         | PMR446, 2 m FM, any FM voice channel                                                                      | CTCSS tones, DCS codes (normal and inverted), DTMF digits, five-tone selcall (ZVEI, CCIR, EEA, EIA, DZVEI), SELCAL and two-tone pages, one line per tone or call.                                                                                                                         |
| Wireless M-Bus          | 868.95 MHz (T1, C1), 868.3 MHz (S1)                                                                       | Utility meters (EN 13757-4): manufacturer, device type, ID, readings of unencrypted meters; encrypted telegrams are listed with their mode, not decrypted. Needs a 400 kHz channel.                                                                                                       |
| Meshtastic              | 869.525 MHz (EU_868), US, ANZ, EU_433 and IN LongFast slots                                               | LoRa mesh packets of every 250 kHz modem preset (LongFast to ShortFast): sender, destination, channel hash, hop limit and port; text messages, positions, node info, telemetry and traceroutes on the default channel key, private channels listed as encrypted. Needs a 500 kHz channel. |
| MeshCore                | 869.618 MHz (EU/UK Narrow) and the other 62.5 kHz presets                                                 | LoRa mesh packets at SF7 to SF9: adverts with names, roles, positions and the signature check, Public channel messages, acks and traces; other channels and direct messages stay encrypted.                                                                                               |
| LoRaWAN (headers)       | 868.1, 868.3, 868.5 and 867.1–867.9 MHz (EU868), 903.9 MHz (US915)                                        | Uplinks at SF7 to SF12: message type, DevAddr and its network, frame counter, flags, MAC commands, FPort and payload length, join requests with JoinEUI and DevEUI. Payloads are never decrypted.                                                                                         |
| LoRa APRS               | 433.775 MHz (EU), 434.855 (PL), 439.9125 (UK)                                                             | APRS over LoRa at SF12 and SF9: positions, objects, messages, status, weather and telemetry.                                                                                                                                                                                              |

SSTV modes: Robot 36 and 72, Martin M1 and M2, Scottie S1, S2 and DX, PD50,
PD90, PD120 and PD180, Wraase SC2-180, from the VIS header or, when it was
missed, from the line sync pulses. The decoder follows the sender's line period
(slant) and filters noise adaptively; a clean picture passes unchanged.

## How it works

The DSP worker cuts a channel of the decoder's sample rate and width around the
VFO (for upper-sideband modes, a fixed offset above the dial) and hands the
decoder complex baseband. Records and picture rows go to the app a few times a
second. The decoder restarts when the VFO frequency changes, so modes that
tolerate the offset (FM SSTV, AX.25 with its AFC) are not Doppler-retuned by the
satellite tracker.

## Limits

- One decoder per VFO; add VFOs to run several.
- HF modes need HF reception (RTL-SDR direct sampling, an upconverter or an HF
  receiver).
- Wireless M-Bus loses about one telegram in twenty from meters that send only
  the shortest preamble the standard allows (as OnAir does).
- The LoRa decoders search every spreading factor of their bandwidth at once but
  only that bandwidth: Meshtastic's 125 and 500 kHz presets, MeshCore's 125 and
  250 kHz presets, LoRaWAN downlinks and MeshCom are not decoded.
- Remote clients do not receive Digital Modes output yet.
