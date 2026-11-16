import { describe, expect, it } from 'vitest';
import { aesCtr, aesEcbDecrypt, aesEcbEncrypt, base64Decode, hexEncode, hmacSha256, sha256 } from '@/worker/decoders/digimode/lora/crypto';
import { ed25519ExpandSeed, ed25519PublicFromPrivate, ed25519Sign, ed25519Verify, sha512 } from '@/worker/decoders/digimode/lora/ed25519';

const hex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));
const ascii = (s) => new TextEncoder().encode(s);

// The known answers of OnAir's tests/mesh/test_mesh_crypto_kat.cpp: FIPS 197, SP 800-38A, FIPS 180-4, RFC 4231, RFC 8032.
describe('LoRa mesh crypto', () => {
	it('encrypts and decrypts AES-128 and AES-256 blocks (FIPS 197 C.1, C.3)', () => {
		const plain = hex('00112233445566778899aabbccddeeff');
		const k128 = hex('000102030405060708090a0b0c0d0e0f');
		expect(hexEncode(aesEcbEncrypt(k128, plain))).toBe('69c4e0d86a7b0430d8cdb78070b4c55a');
		expect(hexEncode(aesEcbDecrypt(k128, hex('69c4e0d86a7b0430d8cdb78070b4c55a')))).toBe('00112233445566778899aabbccddeeff');
		const k256 = hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
		expect(hexEncode(aesEcbEncrypt(k256, plain))).toBe('8ea2b7ca516745bfeafc49904b496089');
		expect(hexEncode(aesEcbDecrypt(k256, hex('8ea2b7ca516745bfeafc49904b496089')))).toBe('00112233445566778899aabbccddeeff');
	});
	it('runs AES-CTR with a big-endian counter (SP 800-38A F.5.1)', () => {
		const d = hex('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51');
		aesCtr(hex('2b7e151628aed2a6abf7158809cf4f3c'), hex('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff'), d);
		expect(hexEncode(d)).toBe('874d6191b620e3261bef6864990db6ce9806f66b7970fdff8617187bb9fffdff');
	});
	it('hashes with SHA-256, HMAC-SHA256 and SHA-512', () => {
		expect(hexEncode(sha256(ascii('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		expect(hexEncode(sha256(ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
			'248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
		);
		expect(hexEncode(hmacSha256(hex('0b'.repeat(20)), ascii('Hi There')))).toBe(
			'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
		);
		expect(hexEncode(sha512(ascii('abc')))).toBe(
			'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
		);
		expect(Array.from(base64Decode('izOH6cXN6mrJ5e26oRXNcg=='))).toEqual(Array.from(hex('8b3387e9c5cdea6ac9e5edbaa115cd72')));
	});
	it('signs and verifies Ed25519 (RFC 8032 7.1 test 1)', () => {
		const seed = hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
		const pub = ed25519PublicFromPrivate(ed25519ExpandSeed(seed));
		expect(hexEncode(pub)).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
		const sig = ed25519Sign(seed, new Uint8Array(0));
		expect(hexEncode(sig)).toBe(
			'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
		);
		expect(ed25519Verify(sig, new Uint8Array(0), pub)).toBe(true);
		sig[5] ^= 1;
		expect(ed25519Verify(sig, new Uint8Array(0), pub)).toBe(false);
		expect(ed25519Verify(ed25519Sign(seed, ascii('advert')), ascii('advert'), pub)).toBe(true);
	});
});
