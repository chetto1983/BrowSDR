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
| `src/client/worker/decoders/digimode/dsc/slicers.ts` | `core/src/marine/marine_dsp.cpp` (ToneSlicer, VhfSlicer) |
| `src/client/worker/decoders/digimode/dsc/symbols.ts` | `core/src/marine/marine_dsc.cpp` (symbols, number fields, builders), `marine_mmsi.cpp` (MMSI kinds) |
| `src/client/worker/decoders/digimode/dsc/call.ts` | `core/src/marine/marine_dsc.cpp` (dscCallKind, dscParseCall) |
| `src/client/worker/decoders/digimode/dsc/decoder.ts` | `core/src/marine/marine_dsc.cpp` (DscDecoder) |
| `src/client/worker/decoders/digimode/dsc/types.ts` | `core/include/dect2/marine/marine_tel.h` (DscCall) |
| `src/client/worker/decoders/digimode/dsc/index.ts` | `core/src/marine/marine_rx.cpp` (VHF DSC path) |
