# Satellite map and Doppler tracking

Open **Tools → Satellites**. The panel shows a world map with every tracked
satellite, a live table, the selected satellite's details and the pass list.
Set the station with **Lat/Lon → Set** or **My position**; the Meteor panel
uses the same location.

## Satellites and downlinks

Frequencies follow the AMSAT FM and linear frequency tables (November 2026).
Linear transponders are tuned to the middle of the passband in USB; inverting
means the uplink is LSB and moves the opposite way to the downlink.

| Satellite          | Downlinks in BrowSDR                                                                                          | Uplink (for stations that transmit)                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| ISS                | 145.800 FM voice and SSTV · 437.800 FM repeater · 437.825 APRS (ARISS November 2026) · 145.825 APRS alternate | 145.990 FM, CTCSS 67 Hz · check ARISS for APRS         |
| SO-50              | 436.795 FM                                                                                                    | 145.850 FM, CTCSS 67 Hz; arm with 2 s of 74.4 Hz       |
| AO-123             | 435.400 FM                                                                                                    | 145.850 FM, CTCSS 67 Hz                                |
| RS-44              | 435.610–435.670 USB/CW · beacon 435.605                                                                       | 145.935–145.995 LSB/CW, inverting                      |
| FO-29              | 435.800–435.900 USB/CW · beacon 435.795                                                                       | 145.900–146.000 LSB/CW, inverting                      |
| AO-7               | mode B 145.925–145.975 USB · mode A 29.400–29.500 USB · beacon 29.502                                         | mode B 432.125–432.175 LSB, inverting · mode A 2 m USB |
| JO-97              | 145.855–145.875 USB/CW                                                                                        | 435.100–435.120 LSB/CW, inverting                      |
| Meteor-M2 3 / M2 4 | 137.900 LRPT (Meteor panel)                                                                                   | —                                                      |
| ORBCOMM group      | 137.2500, 137.2875, 137.3125, 137.4625, 137.6625, 137.7375 MHz (Digital Modes)                                | —                                                      |

AO-7 works only in sunlight and a 24-hour timer alternates modes A and B; the
table marks each satellite as sunlit or in eclipse. FO-29 is switched on by
schedule. Check the [AMSAT status page](https://www.amsat.org/status/) before a
pass: a correct orbit does not mean the transponder is on.
The [ARISS station status](https://www.ariss.org/current-status-of-iss-stations.html)
reported ISS APRS on 437.825 MHz as of 4 November 2026. Its operating channel can
change; select 145.825 MHz only when ARISS reports the VHF packet station active.

## LoRa satellites (TinyGS)

Tick **LoRa satellites (TinyGS)** under the pass list to add the satellites of
TinyGS's element file. That is the list TinyGS
[documents for gpredict](https://api.tinygs.com/v1/tinygs_supported.txt): about
114 satellites, some with Alpha-5 NORAD numbers. The list is loaded only then:

- TinyGS sends no CORS header, so BrowSDR's server fetches the file at most every
  six hours and serves it at `/api/tinygs/tle`;
- the browser keeps it for two days, as it does the other orbits;
- TinyGS's own API is not used.

The satellites get pointing, passes and the map like the others, and
**LoRa satellites, TinyGS (map and passes)** in the pass filter shows only them.
A NORAD number listed twice appears once, with both names.
Predicting their passes takes about 0.7 s for 48 hours (2.3 s for 7 days) on a
fast computer.

Frequencies come from two places:

- the LoRa transmitters of [SatNOGS DB](https://db.satnogs.org) (CC BY-SA 4.0),
  with its description and bandwidth;
- OnAir's presets, for FOSSASAT and Tianqi satellites.

None of them is verified. A satellite with no known frequency is listed with
"No known frequency" and no button. To decode it, paste a TinyGS station's modem
configuration in Tools → Digital Modes.

**Decode on VFO**:

- tunes the active VFO to the downlink;
- chooses the LoRa satellite decoder of its bandwidth;
- does not retune during the pass. The Digital Modes decoder restarts on every
  frequency change, which would lose frames.

Instead, every second, the decoder is sent two things:

- the satellite's name;
- the Doppler offset and rate that SGP4 predicts from the VFO.

The decoder uses them in two ways:

- it centres its carrier search on that offset;
- it takes the predicted rate when the frame's preamble agrees with it.

Each record names the satellite and shows the expected Doppler and how far the
frame was from it. A difference that stays the same over the pass is the
radio's frequency error. A pasted configuration for the same NORAD number
stays in use; any other goes back to the blind search. **Stop** ends the hints.

## Map

Markers are green above your horizon, yellow in sunlight and grey in Earth's
shadow. The selected satellite shows its next orbit (cyan dashed), the visible
part of its next pass (orange), and the area that
can hear it now (0° elevation). The red dot is the station. Map tiles come from
OpenStreetMap and need internet; positions are computed locally.
The ORBCOMM satellites come from Celestrak's current ORBCOMM group. Choose
**ORBCOMM constellation (map and passes)** in the pass filter to see only their
markers and upcoming passes; selecting one draws its orbit and coverage area.
The map uses TLE predictions, not positions reported in decoded packets.
The satellite table has column filters for name/NORAD ID, horizon visibility and
next pass time. Click a column heading to sort it; the × button clears these
table filters.

## Passes

The list covers 48 hours or 7 days and keeps passes whose peak reaches the
chosen elevation (10°, 20°, 30° or 45°); rise and set are at 10°. Orbits are
Celestrak TLEs, cached in the browser and refreshed after two days, so the map
and passes keep working offline for about a week. Predictions use SGP4; the tests hold
rise times within 30 s and peaks within 0.5° of skyfield; ISS reboosts move its passes, so refresh
the day before a planned contact.

## Doppler tracking

**Track on VFO n** tunes the active VFO to the chosen downlink with the right
demodulator, unmutes it and corrects Doppler every second from the computed
range rate. A 435 MHz FM satellite moves by about ±10 kHz during a pass. With a
single VFO the receiver centre is set 150 kHz below the downlink (less at low
sample rates) to keep clear of the DC spike; with several VFOs the usual fitting
or conflict dialog applies.

Retuning the VFO by hand while tracking is kept: the tracker works out the
frequency at the satellite and follows from there, so you can move across a
linear transponder. Tracking continues after the panel closes and stops with
**Stop**, when the VFO disappears, or if Doppler would take the VFO outside the
received band.

Not corrected:

- **ISS APRS** enables the APRS decoder on the selected ISS packet channel without Doppler
  correction: the decoder restarts on every retune, and the ±3.5 kHz shift fits
  its channel. Packets appear in **Tools → APRS**.
- **Meteor** opens the Meteor panel; its demodulator locks onto the carrier.
  During a new LRPT capture, **Show on map** projects the timed image rows over
  OpenStreetMap using the satellite's TLE. **Tune** from the pass list normally
  identifies the satellite; choose M2 3 or M2 4 in the image toolbar if it was
  tuned manually. The map refreshes as more rows arrive. Keep the tab open:
  image pixels and row timestamps are held in browser memory, while **Save PNG**
  exports only the picture, without geographic metadata.
- **ORBCOMM** passes and orbits appear on the satellite map. **Track on VFO** opens its Digital Modes decoder on the chosen example frequency; checksum-valid packet fragments appear in hex in the log. Check the spectrum for the active downlink, since Celestrak orbital data does not identify the satellite's current transmit channel.
- **LoRa satellites (TinyGS)** are not Doppler-retuned either: the decoder follows the shift itself and is told the
  predicted Doppler (see above).
- Dongle frequency error: an RTL-SDR off by 1 ppm is 435 Hz off at 435 MHz.
  Correct the dongle first, or retune by ear (the tracker keeps the correction).
