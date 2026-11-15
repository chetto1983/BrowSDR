"""Run after the JS TetraEar tests with the setup:tetraear virtualenv."""
import json
from pathlib import Path
import re
import socket
import subprocess
import sys
import unittest
from unittest.mock import Mock
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / '.cache/TetraEar'), str(ROOT / 'scripts/tetraear')]
from adapter import Decoder
from bridge import read_config
from tetraear.core.lower_mac import BlockType
from websockets.sync.client import connect
from websockets.exceptions import InvalidStatus

BURSTS = re.findall(r"'([01]{510})'", (ROOT / 'test/decoders/tetra/real-bursts.js').read_text())
def soft(bits):
    return bytes(127 if bit == '0' else 129 for bit in bits)


class DecoderTests(unittest.TestCase):
    def test_real_sync_split_across_packets(self):
        decoder = Decoder()
        payload = soft(BURSTS[0])
        self.assertEqual(decoder.feed(payload[:400])[0]['valid'], 0)
        batch, audio = decoder.feed(payload[400:])
        self.assertEqual(batch['valid'], 2)
        self.assertEqual(batch['frames'][0]['mcc'], 222)
        self.assertEqual(batch['frames'][0]['mnc'], 55)
        self.assertEqual(batch['frames'][0]['slot'], 4)
        self.assertTrue(all(frame['text'] == '' for frame in batch['frames']))
        self.assertEqual(audio, [])

    def test_reset_drops_partial_burst(self):
        first = Decoder()
        first.feed(soft(BURSTS[0])[:400])
        second = Decoder()
        self.assertEqual(second.feed(soft(BURSTS[0])[400:])[0]['valid'], 0)

    def test_noise_and_input_bounds(self):
        import numpy as np
        decoder = Decoder()
        random = np.random.default_rng(42)
        for _ in range(20):
            batch, _ = decoder.feed(random.integers(-127, 128, 2040, dtype=np.int8).tobytes())
            self.assertEqual(batch['valid'], 0)
            self.assertLessEqual(len(decoder.buffer), 508)
        for payload in (b'', b'x', b'0' * 8194):
            with self.assertRaises(ValueError):
                decoder.feed(payload)

    def test_ciphertext_never_goes_to_text_or_call_parsers(self):
        decoder = Decoder()
        decoder.parser = Mock()
        decoder.parser._llc_defrag = {}
        decoder.parser._ssi_votes = {}
        decoder.parser._mac_frag_bits = None
        decoder.parser.parse_mac_pdu.return_value = SimpleNamespace(
            pdu_type=SimpleNamespace(name='MAC_RESOURCE'), encrypted=True, address=123)
        block = SimpleNamespace(block_type=BlockType.NDB, codec_input=None, crc_ok=True, type1_bits=[])
        record = decoder._record(block)
        self.assertTrue(record['encrypted'])
        decoder.parser.parse_sds_data.assert_not_called()
        decoder.parser.parse_call_metadata.assert_not_called()
        decoder.parser._parse_cmce_metadata.assert_not_called()

    def test_upstream_call_metadata_parser(self):
        from tetraear.core.protocol import MacPDU, PDUType
        decoder = Decoder()
        pdu = MacPDU(PDUType.MAC_RESOURCE, False, 1234, 8, bytes(8))
        call = decoder.parser.parse_call_metadata(pdu)
        self.assertEqual(call.talkgroup_id, 1234)
        self.assertEqual(call.duplex_mode, 'simplex')

    def test_null_resource_does_not_become_a_call(self):
        import numpy as np
        # The live null PDU used length indication 62 (second half-slot stolen).
        # ETSI EN 300 392-2 21.4.3.1: address type 000 ends the PDU at bit 16.
        for encryption_mode in ('00', '11'):
            with self.subTest(encryption_mode=encryption_mode):
                bits = np.array([int(bit) for bit in
                                 '0000' + encryption_mode + '0' + '111110' + '000' + '0' * 108], dtype=np.uint8)
                block = SimpleNamespace(block_type=BlockType.NDB, codec_input=None, crc_ok=True, type1_bits=bits)
                decoder = Decoder()
                record = decoder._record(block)
                self.assertEqual(record['kind'], 'MAC_NULL')
                self.assertIsNone(record['address'])
                self.assertIsNone(record['encrypted'])
                self.assertIsNone(record['call'])
                self.assertEqual(record['text'], '')
                self.assertEqual(decoder.valid, 1)

    def test_non_call_signalling_does_not_become_a_call(self):
        import numpy as np
        # Captured broadcast-addressed BL-UDATA, with MLE discriminator 101,
        # rather than CMCE (010). Upstream's fallback invents an Individual call.
        payload = np.unpackbits(np.frombuffer(bytes.fromhex('2aaf888a6a0e1d8835a9800084000000'), dtype=np.uint8))
        header = np.array([int(bit) for bit in '0000000' + '010000' + '001' + '1' * 24 + '000'], dtype=np.uint8)
        block = SimpleNamespace(block_type=BlockType.SCH_F, codec_input=None, crc_ok=True,
                                type1_bits=np.concatenate((header, payload)))
        record = Decoder()._record(block)
        self.assertEqual(record['kind'], 'MAC_RESOURCE')
        self.assertEqual(record['address'], 0xFFFFFF)
        self.assertIsNone(record['call'])

    def test_cmce_connect_keeps_the_call_identifier(self):
        import numpy as np
        # Clear MAC-RESOURCE, SSI 1234; BL-UDATA, CMCE, D-CONNECT, call ID 42.
        bits = '0000000' + '010000' + '001' + format(1234, '024b') + '000'
        bits += '0010' + '010' + '00010' + format(42, '014b') + '0' * 16
        block = SimpleNamespace(block_type=BlockType.SCH_F, codec_input=None, crc_ok=True,
                                type1_bits=np.array([int(bit) for bit in bits], dtype=np.uint8))
        record = Decoder()._record(block)
        self.assertEqual(record['address'], 1234)
        self.assertEqual(record['call']['call_type'], 'Connect')
        self.assertEqual(record['call']['call_identifier'], 42)

    def test_wasm_and_browser_demodulator_output(self):
        for name in ('int8', 'float'):
            with self.subTest(name=name):
                path = ROOT / f'.cache/tetraear-test/{name}.soft'
                self.assertTrue(path.exists(), 'Run the JS stream tests first')
                data, decoder = path.read_bytes(), Decoder()
                for offset in range(0, len(data), 2040):
                    batch, _ = decoder.feed(data[offset:offset + 2040])
                self.assertGreater(batch['valid'], 0)
                self.assertEqual(decoder.mac.mcc, 222)
                self.assertEqual(decoder.mac.mnc, 55)

    def test_configuration_validation(self):
        config = {'type': 'configure', 'protocol': 1, 'frequency': 391, 'audio': False, 'slot': 1}
        self.assertEqual(read_config(json.dumps(config)), config)
        for change in ({'frequency': float('nan')}, {'frequency': True}, {'slot': True}, {'audio': 'yes'}, {'protocol': 2}):
            with self.assertRaises(ValueError):
                read_config(json.dumps(config | change))


class WebSocketTests(unittest.TestCase):
    def test_real_service_and_origin_rejection(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        process = subprocess.Popen([sys.executable, '-u', str(ROOT / 'scripts/tetraear/bridge.py'),
                                    '--port', str(port)], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertIn(b'TetraEar bridge:', process.stdout.readline())
            address = f'ws://127.0.0.1:{port}'
            with self.assertRaises(InvalidStatus):
                connect(address, origin='https://untrusted.example', proxy=None)
            with connect(address, origin='http://localhost:5173', proxy=None) as client:
                client.send(json.dumps({'type': 'configure', 'protocol': 1, 'frequency': 391}))
                self.assertEqual(json.loads(client.recv(timeout=5))['type'], 'ready')
                client.send(soft(BURSTS[0]))
                batch = json.loads(client.recv(timeout=5))
                self.assertEqual(batch['valid'], 2)
                client.send(json.dumps({'type': 'reset'}))
                client.send(soft(BURSTS[1]))
                self.assertEqual(json.loads(client.recv(timeout=5))['bursts'], 1)
        finally:
            process.terminate()
            process.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
