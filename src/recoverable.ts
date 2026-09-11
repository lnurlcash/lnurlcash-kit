import {secp256k1} from '@noble/curves/secp256k1.js'
import {hmac} from '@noble/hashes/hmac.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {bech32m} from '@scure/base'
import {deriveCashChild, deriveCashDomainNode, deriveCashRoot, type CashNode} from './cash.js'
import {hashK1, isPreimage} from './secrets.js'

// ---- LUD-25 Part 2: recoverable signatures ----
//
// A Part 2 note is keyed by a public key rather than a hash. The holder keeps
// `sk`, discloses `pk` as `cp1<pk>`, and spends the note with `ck1`, a
// recoverable signature by `sk` over a fixed message: the SERVICE recovers
// `pk` from it and looks the note up. The SERVICE certifies each note with
// `cs1`, the same signature it has always made, over `hex(pk)` instead of a
// hash, so a recipient can check issuance offline.
//
// The names and signatures below match lnurl-wallet's `src/lib`
// (recoverableNotes.ts and signature.ts), which is expected to become the
// shared TypeScript kit, so moving to it is an import change. Where the spec
// and that code disagree, this follows the code: see `deriveCashAddressNode`.
// test/vectors/part2.json was generated from lnurl-wallet and checked
// against lnurl-mint.

// ---- bech32m ----
//
// Each type has a fixed payload length, so there is no length limit to pick:
// `ck1`, `cs1` and `cx1` all exceed BIP-173's 90 characters, which the spec
// deliberately does not adopt. Mixed case is refused, as BIP-350 requires and
// lnurl-mint does.

const encodeFixed = (hrp: string, bytes: Uint8Array, length: number): string => {
  if (bytes.length !== length) {
    throw new RangeError(`A ${hrp}1 payload is ${length} bytes, not ${bytes.length}.`)
  }
  return bech32m.encode(hrp, bech32m.toWords(bytes), false)
}

const decodeFixed = (hrp: string, value: string, length: number): Uint8Array | null => {
  if (typeof value !== 'string') return null
  try {
    const decoded = bech32m.decode(value.trim() as `${string}1${string}`, false)
    if (decoded.prefix !== hrp) return null
    const bytes = bech32m.fromWords(decoded.words)
    return bytes.length === length ? bytes : null
  } catch {
    return null
  }
}

// A note's public key: 32-byte x-only, BIP-340.
export const encodeCp1 = (pubkeyXOnly: Uint8Array): string => encodeFixed('cp', pubkeyXOnly, 32)
export const decodeCp1 = (value: string): Uint8Array | null => decodeFixed('cp', value, 32)
export const isCp1 = (value: string): boolean => decodeCp1(value) !== null

// A note's bearer secret: 65-byte r || s || recovery-id ownership signature.
export const encodeCk1 = (signature: Uint8Array): string => encodeFixed('ck', signature, 65)
export const decodeCk1 = (value: string): Uint8Array | null => decodeFixed('ck', value, 65)
export const isCk1 = (value: string): boolean => decodeCk1(value) !== null

// A SERVICE's issuance certificate: the same 65-byte layout, signed by the mint.
export const encodeCs1 = (signature: Uint8Array): string => encodeFixed('cs', signature, 65)
export const decodeCs1 = (value: string): Uint8Array | null => decodeFixed('cs', value, 65)
export const isCs1 = (value: string): boolean => decodeCs1(value) !== null

// A watch-only branch export: the branch's x-only public key and chain code.
// Anyone holding it can enumerate every note key on the branch, and link
// them, but cannot spend any.
export type Cx1 = {pubkeyXOnly: Uint8Array; chainCode: Uint8Array}

export const encodeCx1 = (pubkeyXOnly: Uint8Array, chainCode: Uint8Array): string => {
  if (pubkeyXOnly.length !== 32 || chainCode.length !== 32) {
    throw new RangeError('A cx1 is a 32-byte x-only public key and a 32-byte chain code.')
  }
  return encodeFixed('cx', new Uint8Array([...pubkeyXOnly, ...chainCode]), 64)
}

export const decodeCx1 = (value: string): Cx1 | null => {
  const bytes = decodeFixed('cx', value, 64)
  return bytes ? {pubkeyXOnly: bytes.slice(0, 32), chainCode: bytes.slice(32)} : null
}

export const isCx1 = (value: string): boolean => decodeCx1(value) !== null

// ---- the per-note key tweak ----
//
//   t    = tagged_hash("LNURLcash/derive", P || chainCode || ser32_be(i))
//   pk_i = x(lift_x(P) + t*G)
//   sk_i = (P has even y ? p : n - p) + t   (mod n)
//
// BIP-341's taproot tweak, so a watcher holding only `cx1` computes the same
// `pk_i` the holder does. `i` is any uint32 and is never hardened. The 4-byte
// big-endian width is what lnurl-wallet and lnurl-mint both use; the spec
// text does not pin it.

const CURVE_N = secp256k1.Point.Fn.ORDER
const NOTE_DERIVE_TAG = sha256(utf8ToBytes('LNURLcash/derive'))

const numberOf = (bytes: Uint8Array): bigint => BigInt(`0x${bytesToHex(bytes)}`)
const to32Bytes = (value: bigint): Uint8Array => hexToBytes(value.toString(16).padStart(64, '0'))

const requireUint32 = (index: number): number => {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) {
    throw new RangeError(`A note index must be a uint32, not ${index}.`)
  }
  return index
}

const tweakFor = (pubkeyXOnly: Uint8Array, chainCode: Uint8Array, index: number): bigint => {
  if (pubkeyXOnly.length !== 32 || chainCode.length !== 32) {
    throw new RangeError('A branch is a 32-byte x-only public key and a 32-byte chain code.')
  }
  const i = requireUint32(index)
  const ser = new Uint8Array([(i >>> 24) & 0xff, (i >>> 16) & 0xff, (i >>> 8) & 0xff, i & 0xff])
  const t = numberOf(
    sha256(new Uint8Array([...NOTE_DERIVE_TAG, ...NOTE_DERIVE_TAG, ...pubkeyXOnly, ...chainCode, ...ser]))
  )
  // BIP-341 refuses t >= n rather than reducing it, and so does lnurl-mint.
  // A ~2^-128 event, but a wrong key here is a note nobody can find.
  if (t >= CURVE_N) {
    throw new Error(`Note index ${index} is unusable on this branch. Use the next index.`)
  }
  return t
}

// Watch-only: needs no private key, which is what lets a SERVICE holding a
// registered `cx1` mint straight to the holder's next key.
export const deriveNotePubkey = (
  branchPubkeyXOnly: Uint8Array,
  chainCode: Uint8Array,
  index: number
): Uint8Array => {
  const t = tweakFor(branchPubkeyXOnly, chainCode, index)
  const branch = secp256k1.Point.fromBytes(new Uint8Array([0x02, ...branchPubkeyXOnly]))
  const note = t === 0n ? branch : branch.add(secp256k1.Point.BASE.multiply(t))
  if (note.is0()) {
    throw new Error(`Note index ${index} is unusable on this branch. Use the next index.`)
  }
  return note.toBytes(true).slice(1)
}

// The holder's half. The branch key's own point may have odd y, and `cx1`
// only carries x, which names the even-y point, so the key is negated first
// or its note keys would not match what a watcher derives.
export const deriveNoteSecretKey = (
  branchPrivateKey: Uint8Array,
  chainCode: Uint8Array,
  index: number
): Uint8Array => {
  const p = numberOf(branchPrivateKey)
  if (branchPrivateKey.length !== 32 || p === 0n || p >= CURVE_N) {
    throw new RangeError('A branch private key is a 32-byte scalar in [1, n).')
  }
  const branch = secp256k1.Point.BASE.multiply(p)
  const t = tweakFor(branch.toBytes(true).slice(1), chainCode, index)
  const even = branch.y % 2n === 0n ? p : CURVE_N - p
  const key = (even + t) % CURVE_N
  if (key === 0n) {
    throw new Error(`Note index ${index} is unusable on this branch. Use the next index.`)
  }
  return to32Bytes(key)
}

// ---- ownership proofs ----
//
//   message = "LNURLcash"
//   digest  = sha256(sha256("Lightning Signed Message:" || message))
//
// One fixed message for every note, so a note has exactly one `ck1`: the
// value submitted to spend it is the value shown to prove it. RFC6979 makes
// it deterministic, so re-deriving a key reproduces the same `ck1`.

const NOTE_OWNERSHIP_DIGEST = sha256(
  sha256(new Uint8Array([...utf8ToBytes('Lightning Signed Message:'), ...utf8ToBytes('LNURLcash')]))
)

// Raw 65 bytes, r || s || recovery-id. Encode with `encodeCk1` for the wire.
export const signNoteOwnership = (secretKey: Uint8Array): Uint8Array => {
  const signature = secp256k1.sign(NOTE_OWNERSHIP_DIGEST, secretKey, {
    format: 'recovered',
    prehash: false
  })
  // the library puts the recovery id first; the wire puts it last
  return new Uint8Array([...signature.subarray(1), signature[0]!])
}

// The note's x-only public key, recovered offline from its ownership
// signature, or null if the signature does not recover.
export const recoverNoteOwnershipPubkey = (signature: Uint8Array): Uint8Array | null => {
  if (!(signature instanceof Uint8Array) || signature.length !== 65) return null
  try {
    const recoveryIdFirst = new Uint8Array([signature[64]!, ...signature.subarray(0, 64)])
    return secp256k1
      .recoverPublicKey(recoveryIdFirst, NOTE_OWNERSHIP_DIGEST, {prehash: false})
      .slice(1)
  } catch {
    return null
  }
}

// ---- a note's k1, either kind ----

// The id a SERVICE files a note under: sha256(k1) for a Part 1 secret, and
// the recovered public key for a Part 2 `ck1`. Null for anything else,
// including a `ck1` that does not recover. Two different `ck1` strings can
// share an id, so compare notes by this, never by k1.
export const noteIdOf = (k1: string): string | null => {
  if (typeof k1 !== 'string') return null
  const value = k1.trim().toLowerCase()
  if (isPreimage(value)) return hashK1(value)
  const signature = decodeCk1(value)
  const pubkey = signature ? recoverNoteOwnershipPubkey(signature) : null
  return pubkey ? bytesToHex(pubkey) : null
}

// What to look a note up by without disclosing it: the hash for a Part 1
// secret, and for a Part 2 note its `cp1`, which also brings its certificate
// back. Pass it to `fetchNoteInfoByHash`.
export const noteLookupOf = (k1: string): string | null => {
  const id = noteIdOf(k1)
  if (id === null) return null
  return isCk1(k1.trim().toLowerCase()) ? encodeCp1(hexToBytes(id)) : id
}

// ---- the address branch ----
//
// `m/139'/1'/d1/d2/d3/d4` for one mint, with `d1..d4` from
// HMAC-SHA256(m/139'/1'/0, host) exactly as LUD-05. This is lnurl-wallet's
// path (cashSecrets.ts), and it is the one to use: the spec text roots the
// branch at `m/139'/d1..d4`, the very node the Part 1 ladder
// (`deriveCashDomainNode`) already uses, so a wallet following the text
// would find none of the reference wallet's notes.
//
// Bearer material for every note on the branch. Hand out `cashNodeToCx1` of
// it, never the node.
export const deriveCashAddressNode = (root: CashNode, host: string): CashNode =>
  deriveCashDomainNode(deriveCashChild(root, 1 + 0x80000000), host)

export const cashNodeToCx1 = (node: CashNode): Cx1 => ({
  pubkeyXOnly: secp256k1.getPublicKey(node.privateKey, true).slice(1),
  chainCode: node.chainCode.slice()
})

// ---- a branch rooted in a Nostr key ----
//
// A lightning address on a Nostr-native mint belongs to an npub, and a holder
// with no BIP-39 words - a hardware signer that keeps only its identity key,
// or a wallet that never made any - can still be paid to keys of its own:
//
//   seed = HMAC-SHA256(key = the identity's secret key, msg = "LNURLcash/nostr-seed")
//
// then lnurl-wallet's address path from that seed, unchanged. heartwood-esp32
// derives exactly this on the device (common/src/cash_key.rs), and
// test/vectors/nostr-seed.json is the same file its tests grade against. The
// identity key rebuilds every note paid to the branch, so whoever can restore
// that key - from an nsec or the phrase it came from - can recover the notes,
// with or without the device that received them. Not part of LUD-25.

export const NOSTR_CASH_SEED_LABEL = 'LNURLcash/nostr-seed'

export const deriveNostrCashSeed = (secretKey: Uint8Array): Uint8Array => {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32) {
    throw new RangeError('A Nostr secret key is 32 bytes.')
  }
  return hmac(sha256, secretKey, utf8ToBytes(NOSTR_CASH_SEED_LABEL))
}

// One mint's address branch for a Nostr identity. Bearer material, like any
// address node: hand out `cashNodeToCx1` of it.
export const deriveNostrAddressNode = (secretKey: Uint8Array, host: string): CashNode =>
  deriveCashAddressNode(deriveCashRoot(deriveNostrCashSeed(secretKey)), host)
