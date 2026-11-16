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

| Decoder                 | Frequencies                            | What it shows                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DSC (VHF channel 70)    | 156.525 MHz                            | Digital selective calls (ITU-R M.493): distress alerts and relays (highlighted), safety, urgency and routine calls, positions, proposed channels, MMSI kinds. DX/RX time diversity and the check character repair damaged symbols. |
| CubeSat AX.25 telemetry | 145.825 MHz (ISS), satellite downlinks | AX.25 frames at 1200 bd AFSK and 9600 / 4800 bd G3RUH FSK at once; binary telemetry as bytes with a hex dump. Pair with Tools → Satellites for Doppler.                                                                            |
| SSTV (FM, ISS)          | 145.800 MHz                            | Slow-scan TV pictures during ARISS events.                                                                                                                                                                                         |
| SSTV (USB, HF)          | 14.230, 7.171, 3.735 MHz               | Slow-scan TV in the upper sideband; tune the VFO to the dial frequency.                                                                                                                                                            |

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
- Remote clients do not receive Digital Modes output yet.
