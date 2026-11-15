"""Streaming adapter around TetraEar's actual lower MAC and protocol modules.

The upstream GUI, USB capture and speculative decryption path aren't imported.
The browser supplies signed int8 soft bits, positive for zero, at 36 kbit/s.
"""
from dataclasses import asdict
import numpy as np
from tetraear.core.lower_mac import (
    BlockType, LowerMacDecoder, TrainSeq, Y_BITS, detect_training_sequence,
)
from tetraear.core.protocol import TetraProtocolParser


class Decoder:
    def __init__(self, voice=None, slot=1):
        self.voice = voice
        self.voice_slot = slot
        self.mac = LowerMacDecoder()
        self.parser = TetraProtocolParser()
        self.buffer = np.empty(0, dtype=np.int16)
        self.locked = False
        self.slot = None
        self.misses = 0
        self.bursts = self.valid = self.rejected = 0

    def feed(self, payload):
        if not payload or len(payload) % 2 or len(payload) > 8192:
            raise ValueError('Expected an even packet of at most 8192 signed soft bits')
        incoming = np.frombuffer(payload, dtype=np.int8).astype(np.int16)
        self.buffer = np.concatenate((self.buffer, incoming))
        records, audio = [], []
        offset = 0
        while len(self.buffer) - offset >= 510:
            if not self.locked:
                candidate = self._find_sync(offset)
                if candidate is None:
                    offset = max(offset, len(self.buffer) - 508)
                    break
                offset = candidate
            burst = self.buffer[offset:offset + 510]
            sequence, correlation = detect_training_sequence((burst < 0).astype(np.uint8))
            if sequence == TrainSeq.UNKNOWN or correlation < 0.9:
                self.misses += 1
                if self.misses >= 8:
                    self.locked = False
                    self.slot = None
                offset += 510 if self.locked else 2
                self._next_slot()
                continue
            old_cell = (self.mac.mcc, self.mac.mnc, self.mac.colour_code)
            blocks = self.mac.decode_burst(burst, sequence)
            sync = next((b for b in blocks if b.block_type == BlockType.SB1 and b.crc_ok), None)
            if sync is not None:
                if old_cell != (self.mac.mcc, self.mac.mnc, self.mac.colour_code):
                    self.parser = TetraProtocolParser()
                self.locked = True
                self.slot = int(sync.type1_bits[10]) * 2 + int(sync.type1_bits[11]) + 1
            if not self.locked:
                offset += 2
                continue
            self.misses = 0
            self.bursts += 1
            self.parser.mcc, self.parser.mnc = self.mac.mcc, self.mac.mnc
            for block in blocks:
                record = self._record(block)
                if record:
                    records.append(record)
                if self.voice and self.slot == self.voice_slot and block.codec_input:
                    pcm = self.voice.decode_frame(block.codec_input)
                    if len(pcm) and np.isfinite(pcm).all():
                        audio.append(np.clip(pcm, -1, 1).astype('<f4').tobytes())
            offset += 510
            self._next_slot()
        self.buffer = self.buffer[offset:].copy()
        return {'type': 'batch', 'frames': records, 'bursts': self.bursts,
                'valid': self.valid, 'rejected': self.rejected}, audio

    def _find_sync(self, offset):
        hard = self.buffer < 0
        # Only symbol boundaries, preserving a partially received burst across packets.
        starts = np.arange(offset, len(hard) - 509, 2)
        if not len(starts):
            return None
        windows = hard[starts[:, None] + 214 + np.arange(len(Y_BITS))]
        matches = starts[np.count_nonzero(windows != Y_BITS, axis=1) <= 3]
        return int(matches[0]) if len(matches) else None

    def _next_slot(self):
        if self.slot is not None:
            self.slot = self.slot % 4 + 1

    def _record(self, block):
        # BBK has no CRC in the upstream implementation. Never count it as validated.
        if block.block_type == BlockType.BBK or block.codec_input:
            return None
        if not block.crc_ok:
            self.rejected += 1
            return None
        self.valid += 1
        record = {'kind': block.block_type.value, 'slot': self.slot,
                  'mcc': self.mac.mcc, 'mnc': self.mac.mnc,
                  'colour': self.mac.colour_code, 'encrypted': None,
                  'address': None, 'text': '', 'call': None}
        if block.block_type not in (BlockType.NDB, BlockType.SCH_F, BlockType.SB2):
            return record
        try:
            return self._parse_record(block, record)
        except (ValueError, TypeError, IndexError, KeyError, AttributeError):
            # A malformed/unsupported upper-layer PDU must not end reception.
            return record

    def _parse_record(self, block, record):
        bits = block.type1_bits
        # EN 300 392-2 21.4.3.1: null MAC-RESOURCE ends at the address-type
        # field. Its spare bits and encryption flags carry no payload meaning.
        # Do this before upstream parsing, which otherwise consumes the padding.
        if len(bits) >= 16 and not np.any(bits[:2]) and not np.any(bits[13:16]):
            record['kind'] = 'MAC_NULL'
            return record
        if (len(self.parser._llc_defrag) > 128 or len(self.parser._ssi_votes) > 4096 or
                (self.parser._mac_frag_bits is not None and len(self.parser._mac_frag_bits) > 65536)):
            self.parser = TetraProtocolParser()
            self.parser.mcc, self.parser.mnc = self.mac.mcc, self.mac.mnc
        pdu = self.parser.parse_mac_pdu(block.type1_bits, crc_ok=True)
        if pdu is None:
            return record
        record.update(kind=pdu.pdu_type.name, encrypted=bool(pdu.encrypted), address=pdu.address)
        if pdu.encrypted:
            return record
        # Require identified CMCE signalling. The upstream public parser falls
        # back to interpreting arbitrary MAC-RESOURCE bytes as a voice call.
        call = self.parser._parse_cmce_metadata(pdu)
        if call:
            record['call'] = asdict(call)
        payload = pdu.reassembled_data or pdu.data
        # The upstream text parser guesses GSM7 for arbitrary binary input. Only
        # run it for an identified SDS PDU, never for SYSINFO or other broadcasts.
        text = self.parser.parse_sds_data(payload) if payload and call and call.call_type == 'SDS' else None
        if text and not text.startswith('[BIN]'):
            record['text'] = text[:2048]
        return record
