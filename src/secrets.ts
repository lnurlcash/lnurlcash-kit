import {hmac} from '@noble/hashes/hmac.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'

// A note's id: the `h`/`h2` a WALLET discloses on a rotate, split or merge,
// and the key a SERVICE stores the note under. Never the secret itself.
export const hashK1 = (k1: string): string => bytesToHex(sha256(hexToBytes(k1)))

// LUD-25: for a rotate, split or merge, the WALLET - never the SERVICE -
// generates the replacement note's secret and discloses only its hash. A
// fresh 32 bytes, the same size a Lightning payment preimage is, though
// nothing is ever paid for it: it is simply drawn at random. The SERVICE
// never sees, generates or persists it.
//
// Replaceable so a hardware wallet can supply secrets from its own RNG,
// and so tests can be deterministic. A caller substituting this is taking
// responsibility for an unpredictable 32 bytes: anything guessable is a
// note anyone can spend.
export type RandomSecret = () => string

export const defaultRandomSecret: RandomSecret = () =>
  bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

// The shared wire shape of a payment preimage or a note secret: 32 bytes
// hex. Current minting keeps those two values distinct.
export const isPreimage = (value: string): boolean =>
  /^[0-9a-fA-F]{64}$/.test(value.trim())

// ---- deterministic note secrets ----
//
// LUD-25 says a note's k1 is WALLET-generated and says nothing whatever
// about how, so a wallet that draws every secret from a CSPRNG has no way
// back once its file is gone: the mint holds only sha256(k1) and cannot
// tell a stranger's guess from the rightful holder. Deriving the secrets
// from a seed instead makes a wallet restorable from words alone, and -
// because the scheme is written down here rather than invented per wallet -
// makes the same words restore the same notes in a DIFFERENT wallet.
// That cross-wallet portability is the whole point; it is why the
// derivation lives in the kit with a conformance vector rather than inside
// any one application.
//
//   root = HMAC-SHA256(key = utf8("lnurlcash-note-v1"), msg = seed)
//   k1_i = HMAC-SHA256(key = root,                      msg = utf8(host + ":" + index))
//
// `seed` is raw bytes. A BIP39 64-byte seed is what wallets use in
// practice, but nothing here depends on BIP39 - a hardware device with its
// own entropy store, or a seed carried in some other format, derives the
// same way. Keeping the kit seed-format agnostic also keeps a mnemonic
// wordlist out of every consumer's bundle.
//
// `host` is the mint host exactly as `serverOf` produces it (lowercase,
// port included where there is one), so notes at 127.0.0.1:8899 and at
// mint.example never collide. `index` is decimal ASCII counting from 0.
// The output is 32 bytes of hex, the size of a payment preimage, so
// `hashK1` and every wire path treat it identically to a random one. The
// SERVICE sees nothing different: it only ever receives sha256(k1).
//
// The seed is bearer material for every note the wallet will ever hold.
// It must be stored the way the notes themselves are, and never logged.

const NOTE_DERIVATION_DOMAIN = utf8ToBytes('lnurlcash-note-v1')

export const deriveNoteRoot = (seed: Uint8Array): Uint8Array =>
  hmac(sha256, NOTE_DERIVATION_DOMAIN, seed)

const requireIndex = (index: number): number => {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError(
      `A note index must be a non-negative integer, not ${index}.`
    )
  }
  return index
}

export const deriveNoteSecret = (
  root: Uint8Array,
  host: string,
  index: number
): string =>
  bytesToHex(hmac(sha256, root, utf8ToBytes(`${host}:${requireIndex(index)}`)))

// A RandomSecret that walks a mint's indices in order, so a wallet can hand
// it straight to `LnurlcashOptions.randomSecret` and let rotate, split and
// merge draw derived secrets without knowing anything about derivation.
// `index()` reads back the next unused index afterwards - a split consumes
// two, a rotate one - which is the number the wallet persists as its
// counter for that host.
//
// Persist that counter in the SAME write that stages the new records, and
// do it BEFORE the hash goes on the wire. A crash between the bump and the
// request wastes an index, which costs nothing; a crash the other way round
// re-derives a secret the mint has already seen, and the second note minted
// at it collides with the first.
export const derivedSecretSource = (
  root: Uint8Array,
  host: string,
  start = 0
): RandomSecret & {index: () => number} => {
  let next = requireIndex(start)
  const source = (() =>
    deriveNoteSecret(root, host, next++)) as RandomSecret & {
    index: () => number
  }
  source.index = () => next
  return source
}
