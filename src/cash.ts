import {secp256k1} from '@noble/curves/secp256k1.js'
import {hmac} from '@noble/hashes/hmac.js'
import {sha256, sha512} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import type {RandomSecret} from './secrets.js'

// ---- LUD-25 seed-recoverable note secrets, the specified scheme ----
//
// LUD-25's "Seed-recoverable note secrets" section, in full:
//
//   cashHashingKey   = derive(masterKey, m/139'/0)
//   domainMaterial   = hmacSha256(cashHashingKey, full SERVICE domain)
//   (d1, d2, d3, d4) = first 16 bytes of domainMaterial as 4 uint32
//   secret_i         = derive(masterKey, m/139'/d1/d2/d3/d4/i')
//
// "exactly as LUD-05", says the draft of the middle two lines, and that
// reference is what settles the one thing the path shape leaves open.
// `d1..d4` are raw uint32 drawn from a hash, and BIP-32 already reads any
// index >= 2^31 as hardened, so roughly half of any given mint's four
// levels are hardened by magnitude alone. They are used exactly as they
// fall: nothing is masked, and nothing is forced hardened. That is what
// LUD-05's own corpus does with the same four longs, and it is what the
// reference wallet does (lnurl-wallet's `keys.ts`, "whether each level ends
// up hardened depends solely on its own magnitude (>= 2^31), never
// forced"). Only `i` is deliberately hardened, by the spec's own `i'`.
//
// The consequence, and it is the reason this module exists rather than a
// shorter one: an unhardened level needs `serP(point(kpar))`, a secp256k1
// point multiply. A wallet cannot know in advance whether a mint's domain
// will need one, so it needs the curve either way. That cost is real for a
// hardware signer with no EC code, and `deriveCashDomainNode` is the answer
// to it - see its comment.
//
// This is NOT the scheme in `secrets.ts`. That one (HMAC-SHA256 under
// `lnurlcash-note-v1`) shipped four days before this section existed and is
// now the legacy scheme: still derived, still scanned on restore forever, so
// nothing already minted goes missing, but no longer what a new wallet
// should mint under. One convention is the whole point of writing either of
// them down, and this is the one the draft and its reference implementation
// agree on.

// A BIP-32 extended private key, reduced to the two things deriving a child
// actually needs. Deliberately a plain object rather than a library type:
// it crosses a USB wire to a hardware signer (see `cashNodeToHex`), and a
// consumer should not have to install this kit's BIP-32 dependency to hold
// one. It is bearer material for every note derived beneath it.
export type CashNode = {
  privateKey: Uint8Array
  chainCode: Uint8Array
}

const HARDENED = 0x80000000
const CURVE_N = secp256k1.Point.Fn.ORDER
const MASTER_KEY_DOMAIN = utf8ToBytes('Bitcoin seed')
const CASH_PURPOSE = 139

const numberOf = (bytes: Uint8Array): bigint =>
  bytes.length === 0 ? 0n : BigInt(`0x${bytesToHex(bytes)}`)

const to32Bytes = (value: bigint): Uint8Array =>
  hexToBytes(value.toString(16).padStart(64, '0'))

const readUint32BE = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset]! << 24) |
    (bytes[offset + 1]! << 16) |
    (bytes[offset + 2]! << 8) |
    bytes[offset + 3]!) >>>
  0

// BIP-32 CKDpriv. Hardened when `index >= 2^31`, by the index's own
// magnitude and nothing else, which is the whole of the convention question
// above: the caller passes the raw uint32 and this decides.
//
// Exported because it is the one step everything else here is built from,
// so a consumer can check this kit against BIP-32's own published test
// vectors rather than taking the derivation on trust, and because a host
// provisioning a hardware signer walks the intermediate levels with it.
export const deriveCashChild = (node: CashNode, index: number): CashNode => {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) {
    throw new RangeError(`A BIP-32 child index must be a uint32, not ${index}.`)
  }
  const data = new Uint8Array(37)
  if (index >= HARDENED) {
    // 0x00 || ser256(kpar): the leading zero pads the 32-byte scalar out to
    // the 33 bytes a serialised point occupies, so the two legs hash over
    // the same length and can never collide.
    data.set(node.privateKey, 1)
  } else {
    data.set(
      secp256k1.Point.BASE.multiply(numberOf(node.privateKey)).toBytes(true),
      0
    )
  }
  data[33] = (index >>> 24) & 0xff
  data[34] = (index >>> 16) & 0xff
  data[35] = (index >>> 8) & 0xff
  data[36] = index & 0xff

  const material = hmac(sha512, node.chainCode, data)
  const left = numberOf(material.subarray(0, 32))
  const key = (left + numberOf(node.privateKey)) % CURVE_N
  // BIP-32's own escape hatch. Both conditions are ~2^-127 events and no
  // wallet will ever see one, but a silent wrong answer here is a note
  // nobody can spend, so it is checked rather than assumed.
  if (left >= CURVE_N || key === 0n) {
    throw new Error(
      `BIP-32 derivation at index ${index} produced an invalid key. Use the next index.`
    )
  }
  return {privateKey: to32Bytes(key), chainCode: material.slice(32)}
}

const masterFrom = (seed: Uint8Array): CashNode => {
  if (seed.length < 16 || seed.length > 64) {
    throw new RangeError(
      `A BIP-32 seed must be 16 to 64 bytes, not ${seed.length}.`
    )
  }
  const material = hmac(sha512, MASTER_KEY_DOMAIN, seed)
  const key = numberOf(material.subarray(0, 32))
  if (key === 0n || key >= CURVE_N) {
    throw new Error('This seed does not produce a valid BIP-32 master key.')
  }
  return {privateKey: material.slice(0, 32), chainCode: material.slice(32)}
}

// `m/139'` - the wallet's own root for note secrets, under its own purpose
// so it never shares key material with LUD-05's `m/138'` linking-key branch.
//
// `seed` is raw bytes. A 64-byte BIP39 seed is the interop case, and what
// the reference wallet feeds in, but nothing here depends on BIP39 - keeping
// this seed-format agnostic is also what keeps a mnemonic wordlist out of
// every consumer's bundle.
export const deriveCashRoot = (seed: Uint8Array): CashNode =>
  deriveCashChild(masterFrom(seed), CASH_PURPOSE + HARDENED)

// The four raw uint32 levels this mint's subtree hangs off. Exported
// because they are the whole of what a conformance vector has to pin, and
// because a wallet debugging a restore that finds nothing wants to see them.
export const cashDomainIndices = (root: CashNode, host: string): number[] => {
  const hashingKey = deriveCashChild(root, 0).privateKey
  const material = hmac(sha256, hashingKey, utf8ToBytes(host))
  return [0, 4, 8, 12].map(offset => readUint32BE(material, offset))
}

// `m/139'/d1/d2/d3/d4` for one mint: everything above a note's own index.
//
// Worth having as its own step, and not only to derive it once for a run of
// secrets. Every unhardened level in the path is at or above this node, so a
// signer given THIS rather than the seed needs no elliptic curve at all -
// each `i'` beneath it is HMAC-SHA512 plus one modular addition. That is the
// difference between a hardware wallet that can do LUD-25 recovery and one
// that would need a secp256k1 implementation added to its firmware for it.
// The cost is that whoever derives it can derive every note secret this
// wallet will ever hold AT THIS MINT, so it is provisioning material, not
// something to hand out: one mint's subtree, not the wallet.
//
// `host` is the mint host exactly as `serverOf` produces it - lowercase,
// port included where there is one - which is byte-identical to what the
// reference wallet passes, so the two derive the same tree.
export const deriveCashDomainNode = (root: CashNode, host: string): CashNode =>
  cashDomainIndices(root, host).reduce(deriveCashChild, root)

const requireIndex = (index: number): number => {
  if (!Number.isSafeInteger(index) || index < 0 || index >= HARDENED) {
    throw new RangeError(
      `A note index must be an integer in [0, 2^31), not ${index}.`
    )
  }
  return index
}

// The i-th note secret beneath a mint's domain node, as 32 bytes of hex -
// the size of a payment preimage, so `hashK1` and every wire path treat it
// exactly as they treat a randomly drawn one. The SERVICE sees no
// difference: it only ever receives sha256(k1).
export const cashSecretAt = (domainNode: CashNode, index: number): string =>
  bytesToHex(
    deriveCashChild(domainNode, requireIndex(index) + HARDENED).privateKey
  )

// The convenience form, from the root. Re-derives the domain node on every
// call, which is up to four point multiplies - fine for one secret, wasteful
// for a run of them. Use `cashSecretSource` or hold the domain node for those.
export const deriveCashSecret = (
  root: CashNode,
  host: string,
  index: number
): string => cashSecretAt(deriveCashDomainNode(root, host), index)

// privateKey || chainCode, 64 bytes of hex. Not a BIP-32 extended key: no
// version bytes, no depth, no parent fingerprint, no base58check. This is
// the same 64 bytes the reference wallet persists for its own root, and the
// same shape a hardware signer is provisioned with, and nothing here is ever
// meant to leave a wallet as a portable xprv.
export const cashNodeToHex = (node: CashNode): string =>
  bytesToHex(node.privateKey) + bytesToHex(node.chainCode)

export const cashNodeFromHex = (hex: string): CashNode => {
  const bytes = hexToBytes(hex.trim().toLowerCase())
  if (bytes.length !== 64) {
    throw new RangeError(
      `A cash node is 64 bytes - a 32-byte key and a 32-byte chain code - not ${bytes.length}.`
    )
  }
  return {privateKey: bytes.slice(0, 32), chainCode: bytes.slice(32)}
}

// A `RandomSecret` that walks a mint's indices in order, so a wallet can
// hand it straight to `LnurlcashOptions.randomSecret` and let rotate, split
// and merge draw derived secrets without knowing anything about derivation.
// `index()` reads back the next unused index afterwards - a split consumes
// two, a rotate one - which is the number the wallet persists as its counter
// for that host. The domain node is derived once, here, rather than per
// secret.
//
// Persist that counter in the SAME write that stages the new records, and do
// it BEFORE the hash goes on the wire. A crash between the bump and the
// request wastes an index, which costs nothing; a crash the other way round
// re-derives a secret the mint has already seen, and the second note minted
// at it collides with the first.
//
// The counter is not secret - an index reveals nothing without the root -
// so it belongs in an ordinary backup, and a restore should merge counters
// upwards only, never down. It is also not optional: a gap scan cannot see a
// burned index (LUD-25 requires a hash lookup to answer for a spent note
// exactly as it answers for one that never existed), so a wallet that has
// rotated more times than its gap limit cannot rediscover its own position
// from the mint alone.
export const cashSecretSource = (
  root: CashNode,
  host: string,
  start = 0
): RandomSecret & {index: () => number} => {
  const domainNode = deriveCashDomainNode(root, host)
  let next = requireIndex(start)
  const source = (() =>
    cashSecretAt(domainNode, next++)) as RandomSecret & {
    index: () => number
  }
  source.index = () => next
  return source
}
