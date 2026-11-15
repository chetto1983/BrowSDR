"""Loopback WebSocket bridge. Run --help for setup and TLS options."""
import argparse
import asyncio
import json
import logging
from pathlib import Path
import ssl
import sys


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path('.cache/TetraEar'))
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--origin', action='append', help='Allowed browser Origin; repeat for multiple origins')
    parser.add_argument('--cert', type=Path, help='TLS certificate for wss://127.0.0.1')
    parser.add_argument('--key', type=Path, help='TLS private key')
    parser.add_argument('--codec-dir', type=Path, help='Optional directory with native cdecoder and sdecoder')
    return parser.parse_args()


def load_decoder(source):
    source = source.resolve()
    if not (source / 'tetraear/core/lower_mac.py').is_file():
        raise ValueError(f'TetraEar not found in {source}; run npm run setup:tetraear first')
    sys.path.insert(0, str(source))
    from adapter import Decoder
    return Decoder


def read_config(message):
    if not isinstance(message, str):
        raise ValueError('Send a JSON configure message before symbols')
    config = json.loads(message)
    if not isinstance(config, dict) or config.get('type') != 'configure' or config.get('protocol') != 1:
        raise ValueError('Unsupported TetraEar bridge protocol')
    frequency = config.get('frequency')
    if isinstance(frequency, bool) or not isinstance(frequency, (int, float)) or not 1 <= frequency <= 6000:
        raise ValueError('Invalid frequency in MHz')
    if type(config.get('audio', False)) is not bool or type(config.get('slot', 1)) is not int or config.get('slot', 1) not in range(1, 5):
        raise ValueError('Invalid audio or timeslot setting')
    return config


def create_voice(codec_dir):
    import os
    from tetraear.audio.voice import VoiceProcessor
    voice = VoiceProcessor(codec_dir=codec_dir)
    # Upstream's working flag also accepts Windows EXEs on Linux; don't advertise these.
    if os.name != 'nt':
        for path in (voice.cdecoder_path, voice.sdecoder_path):
            if path.exists() and path.read_bytes()[:2] == b'MZ':
                voice.working = False
    return voice if voice.working else None


async def serve(args):
    from websockets.asyncio.server import serve as websocket_serve
    from websockets.exceptions import ConnectionClosed
    Decoder = load_decoder(args.source)
    origins = args.origin or ['http://localhost:5173', 'http://127.0.0.1:5173']
    tls = None
    if args.cert:
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(args.cert, args.key)
    clients = set()

    async def session(socket):
        if len(clients) >= 4:
            await socket.close(1013, 'At most four decoder sessions')
            return
        clients.add(socket)
        try:
            config = read_config(await asyncio.wait_for(socket.recv(), timeout=10))
            voice = create_voice(args.codec_dir) if config.get('audio') else None
            decoder = Decoder(voice, config.get('slot', 1))
            await socket.send(json.dumps({'type': 'ready', 'protocol': 1, 'audio': voice is not None,
                                          'message': 'TetraEar connected' if not config.get('audio') or voice else 'Connected; native speech codec unavailable'}))
            async for message in socket:
                if isinstance(message, str):
                    if json.loads(message) != {'type': 'reset'}:
                        raise ValueError('Unexpected control message')
                    decoder = Decoder(voice, config.get('slot', 1))
                    continue
                batch, audio = await asyncio.to_thread(decoder.feed, message)
                await socket.send(json.dumps(batch, allow_nan=False))
                for pcm in audio:
                    await socket.send(pcm)
        except ConnectionClosed:
            pass
        except (ValueError, asyncio.TimeoutError) as error:
            await socket.close(1008, str(error)[:120])
        except Exception:
            logging.exception('TetraEar decoding failed')
            await socket.close(1011, 'TetraEar decoder failed; see bridge log')
        finally:
            clients.discard(socket)

    async with websocket_serve(session, '127.0.0.1', args.port, origins=origins, ssl=tls,
                               max_size=8192, max_queue=4, compression=None):
        print(f'TetraEar bridge: {"wss" if tls else "ws"}://127.0.0.1:{args.port} (origins: {", ".join(origins)})', flush=True)
        await asyncio.Future()


if __name__ == '__main__':
    try:
        asyncio.run(serve(arguments()))
    except KeyboardInterrupt:
        pass
