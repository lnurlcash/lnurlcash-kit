import {sha256} from '@noble/hashes/sha2.js'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {hashK1} from './secrets.js'
import {decodeCk1, decodeCs1, recoverNoteOwnershipPubkey} from './recoverable.js'

// ---- LUD-25 offline verification ----
//
// A SERVICE may sign each note it issues with its Lightning node identity
// key - the same key it signs BOLT-11 invoices with - so a holder can
// confirm a note's issuer and amount without contacting anyone. Signed via
// the node's own signmessage RPC (lnd's /v1/signmessage, cln's
// signmessage), which wraps the message with this prefix and
// double-sha256s it before signing. That is deliberate reuse: any tool
// that already verifies a Lightning node's signed messages can verify a
// note, and neither backend can produce a bespoke raw-digest scheme
// anyway.
//
//   message = "LNURLcash:" || amount_msat (decimal ASCII) || ":" || hex(sha256(k1))
//   digest  = sha256(sha256("Lightning Signed Message:" || message))
//
// The signature commits to the note's HASH, not its secret, so a holder can
// prove issuance - to expose a mint that will not honour its own note, say -
// without revealing what would let anyone spend it.

const LIGHTNING_SIGNED_MESSAGE_PREFIX = utf8ToBytes('Lightning Signed Message:')

export const noteSignatureMessage = (k1: string, amountMsat: number): string =>
  noteSignatureMessageForHash(hashK1(k1), amountMsat)

// The same message when the caller already has the note id rather than its
// secret. A bound mint quote deliberately discloses h, not k1, so its
// settlement receipt must be verifiable without asking a sealed signer to
// export the secret it just generated.
export const noteSignatureMessageForHash = (
  h: string,
  amountMsat: number
): string => `LNURLcash:${amountMsat}:${h.trim().toLowerCase()}`

export const noteSignatureDigest = (
  k1: string,
  amountMsat: number
): Uint8Array => noteSignatureDigestForHash(hashK1(k1), amountMsat)

export const noteSignatureDigestForHash = (
  h: string,
  amountMsat: number
): Uint8Array =>
  sha256(
    sha256(
      new Uint8Array([
        ...LIGHTNING_SIGNED_MESSAGE_PREFIX,
        ...utf8ToBytes(noteSignatureMessageForHash(h, amountMsat))
      ])
    )
  )

// ---- verification ----
//
// Recovers the signer's pubkey from (k1, amountMsat, signature) and checks
// it against the key, or keys, the caller trusts.
//
// The signature is 65 bytes, but which end carries the recovery id varies
// by implementation in practice: LUD-25 calls for r || s || recovery-id,
// the layout raw BOLT-11 signatures use, while lnurl-mint once forwarded
// its node's signmessage output unreordered as recovery-id || r || s. That
// is fixed upstream, but other implementations may still get it wrong.
// Trying both orderings costs nothing security-wise - recovering against
// the wrong one yields an unrelated pubkey that cannot match a trusted key -
// and means a note verifies regardless of which convention issued it.
//
// Several keys are accepted because a SERVICE may rotate the key it signs
// with. Rotating invalidates nothing: the notes already issued are still
// genuine, and their signatures still verify against the key that made
// them. A SERVICE publishes the retired keys as `previousPubkeys` on its
// mint address, and a holder passes the current key and that history
// together, so a legitimate rotation does not look like a forgery.

export type SignatureCheck =
  | {valid: true; pubkey: string}
  | {valid: false; pubkey: null}

const NO_MATCH = {valid: false, pubkey: null} as const

// Like verifyNoteSignature, but reports WHICH key signed. Worth knowing:
// a note that verifies only against a retired key is one a wallet should
// re-sign by rotating it, and a wallet tracking a SERVICE's key history
// needs to see the difference to do that.
export const verifyNoteSignatureAgainst = (
  k1: string,
  amountMsat: number,
  signatureHex: string,
  mintPubkeys: string | string[]
): SignatureCheck => {
  const h = signedNoteId(k1)
  if (h === null) return NO_MATCH
  return verifyNoteSignatureHashAgainst(h, amountMsat, signatureHex, mintPubkeys)
}

// What the SERVICE signed over: sha256(k1) for a Part 1 note, and for a
// Part 2 note (k1 is a ck1) the public key its ownership signature recovers
// to. Recovered locally, so checking a Part 2 note needs no network either.
const signedNoteId = (k1: string): string | null => {
  const ownership = decodeCk1(k1)
  if (ownership) {
    const pubkey = recoverNoteOwnershipPubkey(ownership)
    return pubkey ? bytesToHex(pubkey) : null
  }
  try {
    return hashK1(k1)
  } catch {
    return null
  }
}

export const verifyNoteSignatureHashAgainst = (
  h: string,
  amountMsat: number,
  signatureHex: string,
  mintPubkeys: string | string[]
): SignatureCheck => {
  const targets = (Array.isArray(mintPubkeys) ? mintPubkeys : [mintPubkeys])
    .filter(key => typeof key === 'string')
    .map(key => key.trim().toLowerCase())
  // Nothing to verify against is a "no", not a pass. A caller that reaches
  // here with an empty history has no trusted key at all.
  if (targets.length === 0) return NO_MATCH
  // a Part 2 note's certificate arrives as cs1, the same 65 bytes encoded
  let wireSig: Uint8Array
  const certificate = decodeCs1(signatureHex)
  if (certificate) {
    wireSig = certificate
  } else {
    try {
      wireSig = hexToBytes(signatureHex)
    } catch {
      return NO_MATCH
    }
  }
  if (wireSig.length !== 65) return NO_MATCH
  // a malformed k1 (non-hex) makes the hashing throw - an unverifiable
  // signature is a "no", never a crash
  let digest: Uint8Array
  try {
    if (!/^[0-9a-fA-F]{64}$/.test(h.trim())) return NO_MATCH
    digest = noteSignatureDigestForHash(h, amountMsat)
  } catch {
    return NO_MATCH
  }
  const recoveryIdFirst = new Uint8Array([
    wireSig[64]!,
    ...wireSig.subarray(0, 64)
  ])
  for (const candidate of [recoveryIdFirst, wireSig]) {
    try {
      // prehash: false because `digest` is already the final double-sha256
      // the signer put its pen to. The library default would hash it again,
      // recovering against a value nothing ever signed - which never
      // matches a real signer's key, and is invisible in a test suite whose
      // mock signer makes the same mistake in the same direction.
      const recovered = bytesToHex(
        secp256k1.recoverPublicKey(candidate, digest, {prehash: false})
      )
      // The recovery yields one key per ordering, so this is a membership
      // test against the trusted set, not a signature check per key: a long
      // key history costs a string comparison each, not a recovery each.
      if (targets.includes(recovered)) return {valid: true, pubkey: recovered}
    } catch {
      // not a valid recovery under this ordering - try the other
    }
  }
  return NO_MATCH
}

// True if the signature verifies against the key, or against any key in the
// list. Pass a SERVICE's current signing key together with the
// `previousPubkeys` it publishes to accept notes issued before a rotation.
export const verifyNoteSignature = (
  k1: string,
  amountMsat: number,
  signatureHex: string,
  mintPubkeys: string | string[]
): boolean => verifyNoteSignatureAgainst(k1, amountMsat, signatureHex, mintPubkeys).valid

export const verifyNoteSignatureHash = (
  h: string,
  amountMsat: number,
  signatureHex: string,
  mintPubkeys: string | string[]
): boolean =>
  verifyNoteSignatureHashAgainst(h, amountMsat, signatureHex, mintPubkeys).valid
