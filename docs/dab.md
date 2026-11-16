# DAB+ digital radio

Choose **DAB+** as the VFO mode, pick the **Block** of your local ensemble (Band III,
5A–13F), start reception and choose a **Service**. The first DAB+ service plays
once the ensemble is locked; the panel shows the ensemble and service labels, the
now-playing text (dynamic label), the codec and the bit rate.

The radio needs at least **2.048 MS/s** (an RTL-SDR at 2.048 or 2.4 MS/s works)
and the whole 1.536 MHz block inside the received band: the block selector
re-centres the receiver when needed. Allow a few seconds to lock.

## How it works

- The DSP worker cuts the block to 2.048 MS/s and runs the DAB receiver ported
  from [OnAir](https://github.com/adswill/OnAir) (`src/client/worker/decoders/dab`):
  transmission mode I synchronisation (null symbol, carrier search over ±32 kHz,
  fine frequency and timing), differential QPSK demodulation, the fast information
  channel (ensemble, services, sub-channels, labels: FIG 0/0, 0/1, 0/2, 1/0, 1/1),
  the chosen sub-channel with time de-interleaving, EEP/UEP depuncturing and
  Viterbi decoding, and the DAB+ audio superframe (firecode, Reed-Solomon
  (120,110), access units, dynamic label).
- The access units are decoded by **faad2** compiled to WebAssembly
  (`wasm/faad2`): AAC with the 960-sample frames of DAB+, with SBR (HE-AAC) and
  parametric stereo (HE-AAC v2). Browser AAC decoders cannot apply SBR to
  960-sample frames.
- 32 kHz services are resampled to 48 kHz; lost access units are replaced by
  silence of the same length so the audio clock does not slip.
- Cost: about 100 ms of one CPU core per second of signal once locked. In tests
  the audio stays error-free down to about 4 dB carrier-to-noise.

## Not supported

- Classic DAB (MPEG-1 Layer II) services are listed but not played.
- Slideshow pictures (MOT), DL Plus tags, the programme guide (SPI), packet-mode
  data, Journaline, DMB and transmitter identification (TII).
- OnAir's coherent channel-estimate demodulation (about 3 dB more sensitive) is
  not ported; transmission modes II–IV (not used in Europe).
