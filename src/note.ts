import {fromLud17, resolveLnurlInput} from './urls.js'
import {isCp1, noteIdOf} from './recoverable.js'

// A note is its withdraw LNURL with the secret as the k1 query parameter.
// k1 is normalised to lowercase hex: it is bytes, not text, so casing
// carries no meaning, and normalising keeps duplicate detection and the
// echo check on an informational GET from treating the same secret in two
// casings as two different notes.
export const noteK1 = (url: string): string | null => {
  try {
    return new URL(url).searchParams.get('k1')?.toLowerCase() ?? null
  } catch {
    return null
  }
}

// Like noteK1 but throws rather than returning null. A hardware-backed
// note deliberately carries no secret in its URL (see withoutK1), so a
// caller about to use one for a mutation should use this: it fails loudly
// instead of quietly sending a blank k1 to a SERVICE.
export const requireNoteK1 = (url: string): string => {
  const k1 = noteK1(url)
  if (!k1) {
    throw new Error(
      'This note carries no secret in its URL - it may be held on a device.'
    )
  }
  return k1
}

// What a note CLAIMS to carry, straight from its URL. Only a claim by
// whoever encoded it - a SERVICE ignores it at the informational endpoint -
// so it is safe to display before contacting the SERVICE but must not be
// trusted without either a matching signature or a fresh online GET.
export const noteDeclaredAmount = (url: string): number | null => {
  try {
    const raw = new URL(url).searchParams.get('amount')
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export const noteSignature = (url: string): string | null => {
  try {
    return new URL(url).searchParams.get('sig')
  } catch {
    return null
  }
}

// Input only qualifies as a note if it resolves to a URL carrying a
// well-formed k1: 32 bytes hex, or a Part 2 `ck1` that recovers to a key.
// Anything else would throw during hashing later - in offline signature
// verification while rendering, say - so it is refused at the door.
export const resolveNoteInput = (value: string): string | null => {
  const url = resolveLnurlInput(value)
  const k1 = url ? noteK1(url) : null
  if (!url || !k1 || noteIdOf(k1) === null) return null
  return url
}

export const isValidNoteInput = (value: string): boolean =>
  resolveNoteInput(value) !== null

// withdrawLink (the raw LUD-17 URL of a SERVICE's withdraw endpoint) plus a
// secret makes a note. Omit `amountMsat` when the real value is not known
// yet - claiming a preimage that arrived from outside, with no invoice of
// one's own to read it from. The spec has a SERVICE ignore `amount` here
// regardless, but some implementations validate it strictly, and a
// placeholder like 0 risks being rejected rather than ignored.
// The informational GET asked by hash rather than by secret (LUD-25,
// "Checking a note without exposing it"). Same endpoint and same response,
// minus the echoed k1: the SERVICE matches sha256(k1) against the key it
// already files every note under, and never sees the secret at all.
//
// `amount` and `sig` are dropped rather than carried. Neither is read on an
// informational GET, and both would narrow a lookup whose whole purpose is
// to disclose as little as possible.
//
// `h` may also be a Part 2 `cp1` key, sent as `p`, the name LUD-25 now uses.
// A hash keeps the older `h`, which every mint that ever took a hash lookup
// understands. Same rule as lnurl-wallet.
export const buildNoteInfoUrlByHash = (withdrawLink: string, h: string): string => {
  const value = h.trim().toLowerCase()
  const key = isCp1(value)
  if (!key && !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('A note hash must be 32 bytes of hex, or a cp1 key.')
  }
  const url = new URL(fromLud17(withdrawLink.trim()))
  url.searchParams.delete('k1')
  url.searchParams.delete('amount')
  url.searchParams.delete('sig')
  url.searchParams.set(key ? 'p' : 'h', value)
  return url.toString()
}

export const buildNoteUrl = (
  withdrawLink: string,
  k1: string,
  amountMsat?: number
): string => {
  const url = new URL(fromLud17(withdrawLink.trim()))
  url.searchParams.set('k1', k1.trim().toLowerCase())
  if (amountMsat !== undefined) {
    url.searchParams.set('amount', String(amountMsat))
  }
  return url.toString()
}

// The same note with its secret swapped out, after a rotate, split or
// merge. A signature only carries over when the response actually returned
// a fresh one: a mutation at a SERVICE without offline verification drops
// any stale sig, since it no longer matches the new secret.
export const withNewK1 = (
  url: string,
  k1: string,
  amountMsat: number,
  signature?: string
): string => {
  const newUrl = new URL(url)
  newUrl.searchParams.set('k1', k1.toLowerCase())
  newUrl.searchParams.set('amount', String(amountMsat))
  if (signature) newUrl.searchParams.set('sig', signature)
  else newUrl.searchParams.delete('sig')
  return newUrl.toString()
}

// Like withNewK1 but removes k1 rather than setting it - for re-deriving a
// hardware-backed note's blank URL template from an existing note's own,
// after a mutation whose fresh secret now lives on the device rather than
// in the calling process.
export const withoutK1 = (
  url: string,
  amountMsat: number,
  signature?: string
): string => {
  const newUrl = new URL(url)
  newUrl.searchParams.delete('k1')
  newUrl.searchParams.set('amount', String(amountMsat))
  if (signature) newUrl.searchParams.set('sig', signature)
  else newUrl.searchParams.delete('sig')
  return newUrl.toString()
}
