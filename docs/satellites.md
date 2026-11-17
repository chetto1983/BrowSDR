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
- **ORBCOMM** passes and orbits appear on the satellite map. **Track on VFO** opens its Digital Modes decoder on the chosen example frequency; checksum-valid packet fragments appear in hex in the log. Check the spectrum for the active downlink, since Celestrak orbital data does not identify the satellite's current transmit channel.
- Dongle frequency error: an RTL-SDR off by 1 ppm is 435 Hz off at 435 MHz.
  Correct the dongle first, or retune by ear (the tracker keeps the correction).
