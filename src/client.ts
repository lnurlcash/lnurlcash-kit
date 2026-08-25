import {
  AmbiguousMintError,
  AmbiguousMutationError,
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  ProtocolError,
  RequestRefusedError,
  ServiceRejectedError,
  classifyNoteError
} from './errors.js'
import {lnurlFetch, resolveOptions, type LnurlcashOptions} from './transport.js'
import {hashK1, isPreimage} from './secrets.js'
import {buildNoteInfoUrlByHash, buildNoteUrl, noteK1, withNewK1} from './note.js'
import {decodeBolt11AmountMsat, sameInvoice} from './bolt11.js'
import {parseMintFee, type MintFee} from './fees.js'
import {verifyNoteSignatureHashAgainst} from './signature.js'

// ---- the informational GET ----

// What a lookup by hash returns: a withdrawRequest with no echoed k1.
export type NoteInfoByHash = Omit<WithdrawRequestInfo, 'k1'> & {k1?: string}

export type WithdrawRequestInfo = {
  tag: 'withdrawRequest'
  callback: string
  k1: string
  minWithdrawable: number
  maxWithdrawable: number
  defaultDescription?: string
  mintPubkey?: string
  // The way home. A payRequest advertises `withdrawLink`; this is the other
  // direction, so a holder who has nothing but a note can still reach the
  // document publishing this SERVICE's terms and its retired signing keys.
  //
  // Without it, a WALLET that only ever received notes cannot tell an
  // announced key rotation from a substituted key: the discovery document
  // lives under a username the note never mentions, so it cannot be guessed
  // from the callback.
  //
  // Only ever accepted on the note's own origin. Whoever controls the host
  // controls the pin anyway, which is TOFU's own argument, but a payLink
  // pointing somewhere else would let a SERVICE nominate a THIRD party to
  // vouch for its key history, and refusing that costs nothing.
  payLink?: string
}

// Shared by both informational lookups. `k1` is required on a lookup by
// secret, where the spec makes the echo a MUST, and absent on a lookup by
// hash, where the spec omits it: a WALLET asking by hash already holds the
// value it hashed, so there is nothing for the SERVICE to hand back.
const assertWithdrawRequestShape = (body: any, {requireK1}: {requireK1: boolean}): void => {
  if (
    body?.tag !== 'withdrawRequest' ||
    typeof body.callback !== 'string' ||
    (requireK1 && typeof body.k1 !== 'string') ||
    typeof body.maxWithdrawable !== 'number' ||
    !Number.isSafeInteger(body.maxWithdrawable) ||
    body.maxWithdrawable < 0 ||
    (body.minWithdrawable !== undefined &&
      (typeof body.minWithdrawable !== 'number' ||
        !Number.isSafeInteger(body.minWithdrawable) ||
        body.minWithdrawable < 0 ||
        body.minWithdrawable > body.maxWithdrawable))
  ) {
    throw new ProtocolError('Not a withdrawRequest (unexpected response).')
  }
}

// LUD-03 step one. Never burns, rotates or alters the note. maxWithdrawable
// is the only authoritative statement of what the note is worth; the URL's
// own `amount` is a claim the SERVICE ignores here.
//
// This necessarily puts k1 on the wire, so a caller still holding the note
// afterwards SHOULD rotate it.
export const fetchNoteInfo = async (
  url: string,
  options: LnurlcashOptions = {}
): Promise<WithdrawRequestInfo> => {
  const opts = resolveOptions(options)
  // `sig` is only meaningful to a holder inspecting the note locally - the
  // SERVICE already knows what it signed - so it is dropped rather than
  // sent along for nothing. k1 and amount are left as they are.
  const reqUrl = new URL(url)
  reqUrl.searchParams.delete('sig')
  let body: any
  try {
    body = await lnurlFetch(reqUrl, opts)
  } catch (err) {
    if (err instanceof ServiceRejectedError) throw classifyNoteError(err.reason)
    throw err
  }
  assertWithdrawRequestShape(body, {requireK1: true})
  // Spec MUST: the response's k1 is the bearer secret itself, never a
  // derived or opaque id. A SERVICE returning something else for the k1 it
  // was queried with is non-compliant - or the note was rotated by
  // somebody else, which matters even more.
  const queried = noteK1(url)
  if (queried && body.k1.toLowerCase() !== queried) {
    throw new ProtocolError(
      "The service echoed back a different k1 than was queried - the note may have been redeemed elsewhere, or the service isn't spec-compliant."
    )
  }
  // Dropped rather than passed on if it is not a URL on this note's own
  // origin, so a caller can treat its presence as the fact it looks like.
  const info = body as WithdrawRequestInfo
  const payLink = sameOriginPayLink(body.payLink, reqUrl)
  if (payLink === undefined) delete info.payLink
  else info.payLink = payLink
  return info
}

// The same lookup, asked by hash. The SERVICE learns which note is being
// asked about but never the secret that spends it, so this is the form a
// WALLET should use for any lookup that is not immediately followed by a
// mutation: checking a balance, reconciling, and above all walking a
// derivation during a restore, where the lookup-by-secret form puts every
// note a wallet owns on the wire at once.
//
// Support is OPTIONAL in LUD-25 and there is no capability flag. A SERVICE
// that does not index by hash answers every hash lookup exactly as it
// answers an unknown note, so a NoteUnknownError here means "unknown, OR
// this SERVICE cannot answer hash lookups at all" and a caller MUST NOT
// read it as proof the note is gone. Only a successful answer is proof of
// anything; see restoreNotes, which tracks exactly that.
export const fetchNoteInfoByHash = async (
  withdrawLink: string,
  h: string,
  options: LnurlcashOptions = {}
): Promise<NoteInfoByHash> => {
  const opts = resolveOptions(options)
  const reqUrl = new URL(buildNoteInfoUrlByHash(withdrawLink, h))
  let body: any
  try {
    body = await lnurlFetch(reqUrl, opts)
  } catch (err) {
    if (err instanceof ServiceRejectedError) throw classifyNoteError(err.reason)
    throw err
  }
  assertWithdrawRequestShape(body, {requireK1: false})
  // No echo check to make: there is no queried k1 to compare against. A
  // SERVICE that sends one anyway is not refused - it is telling the caller
  // a secret the caller already holds, which costs nothing - but nothing
  // here relies on it either.
  const info = body as NoteInfoByHash
  const payLink = sameOriginPayLink(body.payLink, reqUrl)
  if (payLink === undefined) delete info.payLink
  else info.payLink = payLink
  return info
}

// A `payLink` is only meaningful, and only safe, on the origin the note
// itself lives on. Anything else is discarded silently: it is an optional
// field, and a WALLET that never sees it simply behaves as it did before.
const sameOriginPayLink = (value: unknown, noteUrl: URL): string | undefined => {
  if (typeof value !== 'string' || value.length === 0) return undefined
  let candidate: URL
  try {
    candidate = new URL(value, noteUrl)
  } catch {
    return undefined
  }
  if (candidate.origin !== noteUrl.origin) return undefined
  return candidate.toString()
}

// After an AmbiguousMutationError: did the burn actually happen? Probes one
// of the input k1s with an informational GET.
//
//   'live'    still outstanding. The request never landed, so the fresh
//             secrets minted nothing and can be discarded.
//   'gone'    the SERVICE reports it spent or unknown. The burn landed, and
//             the carried secrets are the only money left.
//   'unknown' the probe itself failed. No information - keep everything.
export const probeBurnedNote = async (
  url: string,
  options: LnurlcashOptions = {}
): Promise<'live' | 'gone' | 'unknown'> => {
  try {
    await fetchNoteInfo(url, options)
    return 'live'
  } catch (err) {
    if (err instanceof NoteSpentError || err instanceof NoteUnknownError) {
      return 'gone'
    }
    return 'unknown'
  }
}

// ---- the mint address (experimental) ----

export type MintContact = {
  // A Nostr npub, an email address, a URL: however the operator wants to be
  // reached. All optional, and a SERVICE that publishes none is normal.
  nostr?: string
  email?: string
  url?: string
}

export type MintAddressInfo = {
  tag: 'withdrawRequest'
  callback: string
  minWithdrawable: number
  maxWithdrawable: number
  defaultDescription?: string
  // The key a note's signature verifies against, straight from the wire
  // field of the same name. This is NOT the Lightning node's identity key:
  // that one is embedded in `nodeUri` below, and every other node* field on
  // this type really is about the node. Verifying a note against the key
  // pulled out of nodeUri fails, and the failure says nothing about why.
  mintPubkey?: string
  // Deprecated alias for `mintPubkey`, carrying the same value. Reach for
  // `mintPubkey`: it matches the wire, it matches what the same key is
  // called on a note's own info, and it does not read as the node key it
  // sits next to. Removed at the next breaking change.
  //
  // @deprecated use mintPubkey
  nodePubkey?: string
  payLink: string
  nodeAlias?: string
  nodeUri?: string
  nodeColor?: string
  // The wire field is `nodeCapacity`, denominated in msat like every other
  // amount here. Carries the ...Msat suffix on this side because a caller
  // reading a bare `capacity` off a Lightning node has no reason to assume
  // millisatoshis - see the mapping in fetchMintAddress.
  nodeCapacityMsat?: number
  nodeNumChannels?: number
  nodeNumPeers?: number

  // ---- who runs this mint (all optional) ----
  //
  // The human layer. A note is a bearer claim on one specific operator, and
  // a holder deciding whether to keep sats there wants to know who that is,
  // how to reach them, and what they have said lately. Absent means the
  // SERVICE published nothing, never that the answer is empty.
  name?: string
  description?: string
  contact?: MintContact
  tosUrl?: string
  // A message of the day: how an operator talks to holders between releases.
  // Maintenance windows, a fee change, a sunset date. Worth surfacing when
  // it changes rather than burying on a settings screen.
  motd?: string
  // The structured twin of the fee prose in a payRequest's metadata. Same
  // shape parseMintFee returns, so it feeds applyMintFee and mintFeeBand
  // directly. The metadata form remains the one a WALLET must handle: this
  // endpoint is experimental and optional, and the payRequest is not.
  fees?: MintFee
  // The SERVICE's own software version, for a holder reporting a bug.
  version?: string
  // Signing keys this SERVICE has retired. A note signed under one of them
  // is still genuine, and still verifies: rotating a signing key would
  // otherwise invalidate every outstanding signature at once. Pass this
  // list alongside the current key to verifyNoteSignature.
  previousPubkeys?: string[]
  // True when this SERVICE accepts an `h` on its LUD-06 pay callback and
  // credits the minted note at that hash instead of at the payment
  // preimage. The same fact PayRequestInfo carries, kept here alongside the
  // other capability fields; prefer the payRequest, which every mint has,
  // and fall back to this document for a SERVICE that only says it here.
  // Undefined means the SERVICE said nothing, which is the same as no. See
  // requestInvoice.
  mintToHash?: boolean
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const asContact = (value: unknown): MintContact | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const contact: MintContact = {
    nostr: asString(raw.nostr),
    email: asString(raw.email),
    url: asString(raw.url)
  }
  const any = contact.nostr ?? contact.email ?? contact.url
  return any === undefined ? undefined : contact
}

const asFees = (value: unknown): MintFee | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const baseFeeMsat = asNumber(raw.baseFeeMsat)
  const feePpm = asNumber(raw.feePpm)
  // A SERVICE that states one component and omits the other means zero for
  // the one it omitted, the same reading parseMintFee gives the prose form.
  if (baseFeeMsat === undefined && feePpm === undefined) return undefined
  return {baseFeeMsat: baseFeeMsat ?? 0, feePpm: feePpm ?? 0}
}

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

const asPubkeyList = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter(item => typeof item === 'string') : undefined

// Best-effort discovery only. This endpoint is experimental and carries no
// LUD number, so most SERVICEs - including ones this library otherwise
// works with perfectly - simply will not have it. Treat a rejection as "no
// extra information available" and fall back to fetchPayRequest, which is
// the only functional path to actually mint.
export const fetchMintAddress = async (
  url: string,
  options: LnurlcashOptions = {}
): Promise<MintAddressInfo> => {
  const body = await lnurlFetch(url, resolveOptions(options))
  if (
    body?.tag !== 'withdrawRequest' ||
    typeof body.callback !== 'string' ||
    typeof body.payLink !== 'string' ||
    typeof body.maxWithdrawable !== 'number'
  ) {
    throw new ProtocolError('Not a mint address response (unexpected shape).')
  }
  // Mapped field by field rather than spread through. A spread carries wire
  // names into the typed object unchecked, which is how nodeCapacityMsat
  // came to read undefined forever while the value sat there under its wire
  // name; it also means whatever a SERVICE decides to add lands on the
  // object with no type behind it. An unrecognised field is dropped here
  // instead, and the version of this library that understands it will map
  // it deliberately.
  return {
    tag: 'withdrawRequest',
    callback: body.callback,
    minWithdrawable: asNumber(body.minWithdrawable) ?? 0,
    maxWithdrawable: body.maxWithdrawable,
    defaultDescription: asString(body.defaultDescription),
    mintPubkey: asString(body.mintPubkey),
    // the same value under both names for one release, so nothing breaks
    nodePubkey: asString(body.mintPubkey),
    payLink: body.payLink,
    nodeAlias: asString(body.nodeAlias),
    nodeUri: asString(body.nodeUri),
    nodeColor: asString(body.nodeColor),
    // `nodeCapacity` is the wire name the reference mint, the mock and
    // every implementation that copied them use. One live mint emits
    // `nodeCapacityMsat` instead, so both are accepted and the bare name
    // wins where a SERVICE sends both.
    nodeCapacityMsat: asNumber(body.nodeCapacity) ?? asNumber(body.nodeCapacityMsat),
    nodeNumChannels: asNumber(body.nodeNumChannels),
    nodeNumPeers: asNumber(body.nodeNumPeers),
    name: asString(body.name),
    description: asString(body.description),
    contact: asContact(body.contact),
    tosUrl: asString(body.tosUrl),
    motd: asString(body.motd),
    fees: asFees(body.fees),
    version: asString(body.version),
    previousPubkeys: asPubkeyList(body.previousPubkeys),
    mintToHash: asBoolean(body.mintToHash)
  }
}

// ---- the mutating callback ----

export type WithdrawSuccessResponse = {
  status: 'OK'
  sig?: string
  sig2?: string
  // LUD-25 melt proof (optional): present only on a melt, and only where
  // the SERVICE advertises it
  pr?: string
  verify?: string
}

const callbackRequest = async (
  callback: string,
  params: [string, string][],
  options: LnurlcashOptions
): Promise<WithdrawSuccessResponse> => {
  const opts = resolveOptions(options)
  let cbUrl: URL
  try {
    cbUrl = new URL(callback)
  } catch {
    throw new RequestRefusedError('The service provided an invalid callback URL.')
  }
  // Nothing to operate on. Worth refusing here rather than letting it
  // become a callback with no k1, whose meaning is entirely up to the
  // SERVICE - and which, if a SERVICE chose to read it generously, could
  // burn something the caller never named.
  if (!params.some(([key]) => key === 'k1')) {
    throw new RequestRefusedError(
      'At least one k1 is required - there is no note to operate on.'
    )
  }
  // append, never set: a merge repeats the k1 parameter, and a callback may
  // already carry parameters of its own
  for (const [key, value] of params) cbUrl.searchParams.append(key, value)
  let body: any
  try {
    body = await lnurlFetch(cbUrl, opts)
  } catch (err) {
    if (err instanceof ServiceRejectedError) {
      // a k1 already mid-melt rejects every other callback naming it with
      // this exact reason string, verbatim per spec
      if (err.reason === 'pending') throw new PendingNoteError(err.reason)
      throw classifyNoteError(err.reason)
    }
    // an ambiguous transport failure must reach callers with its type
    // intact, never reclassified from its message text
    throw err
  }
  if (body?.status !== 'OK') {
    throw new AmbiguousMintError(
      'The service did not confirm the operation - it may still have been applied.'
    )
  }
  return body as WithdrawSuccessResponse
}

export type MeltResult = {
  // LUD-25 melt proof (optional): a LUD-21 style URL proving this exact
  // outgoing payment settled. Absent unless the SERVICE advertises it.
  verify?: string
  // the invoice being paid, echoed back alongside the proof, so a later
  // settled report can be bound to THIS melt rather than another payment
  pr?: string
}

// Melt: burn a single note, the SERVICE pays `pr` of exactly its value.
// Merge several notes first to melt them together - LUD-25 dropped
// multi-k1 melt.
//
// {"status":"OK"} here means the payment is now IN FLIGHT. It does not mean
// the note is spent. The SERVICE pays asynchronously and only finalises the
// burn once the payment settles, restoring the note to outstanding if it
// fails. A melt failure is therefore never reported through this call - it
// is only observable as the note becoming spendable again. Callers should
// treat this as "melt requested".
export const meltNote = async (
  callback: string,
  k1: string,
  pr: string,
  options: LnurlcashOptions = {}
): Promise<MeltResult> => {
  const body = await callbackRequest(
    callback,
    [
      ['k1', k1],
      ['pr', pr.trim()]
    ],
    options
  )
  return {
    verify: body.verify,
    pr: typeof body.pr === 'string' ? body.pr : undefined
  }
}

// ---- hash-parameterised primitives ----
//
// The mint call behind rotate, split and merge, taking a hash the caller
// already holds rather than generating one. This is what a hardware wallet
// drives: the device's own RNG produces the secret and the hash, and the
// secret never enters the calling process at all. The generating variants
// below are simply the software-wallet case of these.

export type HashedMutationResult = {signature?: string}

export const rotateNoteWithHash = async (
  callback: string,
  k1: string,
  h: string,
  options: LnurlcashOptions = {}
): Promise<HashedMutationResult> => {
  const body = await callbackRequest(
    callback,
    [
      ['k1', k1],
      ['h', h]
    ],
    options
  )
  return {signature: body.sig}
}

export type HashedSplitResult = {
  signature?: string
  changeSignature?: string
}

export const splitNoteWithHash = async (
  callback: string,
  k1s: string[],
  amountMsat: number,
  h: string,
  h2: string,
  options: LnurlcashOptions = {}
): Promise<HashedSplitResult> => {
  const body = await callbackRequest(
    callback,
    [
      ...k1s.map((k1): [string, string] => ['k1', k1]),
      ['amount', String(amountMsat)],
      ['h', h],
      ['h2', h2]
    ],
    options
  )
  return {signature: body.sig, changeSignature: body.sig2}
}

export const mergeNotesWithHash = async (
  callback: string,
  k1s: string[],
  h: string,
  options: LnurlcashOptions = {}
): Promise<HashedMutationResult> => {
  const body = await callbackRequest(
    callback,
    [...k1s.map((k1): [string, string] => ['k1', k1]), ['h', h]],
    options
  )
  return {signature: body.sig}
}

// ---- the generating primitives ----
//
// A definitive refusal that names an input as spent or unknown is also what
// a mutation the SERVICE already applied looks like when an HTTP stack
// retries the GET it was carried on. The library cannot tell those apart -
// at the wire they are the same answer, and whether the input was live when
// the request went out is knowledge the caller has and this layer does not -
// so it hands back the secrets rather than a verdict. See NoteSpentError.
//
// Only those two classes. PendingNoteError means the input is alive and
// untouched; a refusal on policy grounds (dust, a fee, a sunsetting mint)
// burned nothing. Neither can be a landed mutation, so neither carries
// anything and a caller may discard its staged records at once.
const keepingOutputs = <T,>(err: T, newSecrets: string[]): T => {
  if (err instanceof NoteSpentError || err instanceof NoteUnknownError) {
    err.newSecrets = newSecrets
  }
  return err
}


export type RotateResult = {k1: string; signature?: string}

// Rotate: burn k1, receive a fresh secret of the same value. This closes
// the window in which any previous holder - or a logged URL, or a SERVICE
// that generated the original preimage - could still redeem the note. It is
// also how a caller obtains a compact, offline-verifiable copy of a note
// that does not have one yet, such as immediately after minting.
//
// Per LUD-25 the WALLET generates that fresh secret and discloses only its
// hash. The SERVICE never sees, generates or persists it, which is what
// closes the prior-holder exposure a SERVICE-generated replacement would
// otherwise reopen on every single rotate.
export const rotateNote = async (
  callback: string,
  k1: string,
  options: LnurlcashOptions = {}
): Promise<RotateResult> => {
  const opts = resolveOptions(options)
  const newK1 = opts.randomSecret()
  try {
    const result = await rotateNoteWithHash(callback, k1, hashK1(newK1), options)
    return {k1: newK1, signature: result.signature}
  } catch (err) {
    // the request may have landed - the fresh secret is then the only copy
    // of the rotated note, so it rides the error rather than vanishing
    if (err instanceof AmbiguousMintError) {
      throw new AmbiguousMutationError((err as Error).message, [newK1])
    }
    throw keepingOutputs(err, [newK1])
  }
}

export type SplitResult = {
  k1: string
  signature?: string
  change: string
  changeSignature?: string
}

// Split: burn one or many notes, mint one worth `amountMsat` and one
// carrying the remainder of their combined value. Both secrets are
// generated here and disclosed as h and h2. Splitting several notes at
// once needs no prior merge - they are all burned in the one request.
export const splitNote = async (
  callback: string,
  k1s: string[],
  amountMsat: number,
  options: LnurlcashOptions = {}
): Promise<SplitResult> => {
  const opts = resolveOptions(options)
  const newK1 = opts.randomSecret()
  const changeK1 = opts.randomSecret()
  try {
    const result = await splitNoteWithHash(
      callback,
      k1s,
      amountMsat,
      hashK1(newK1),
      hashK1(changeK1),
      options
    )
    return {
      k1: newK1,
      signature: result.signature,
      change: changeK1,
      changeSignature: result.changeSignature
    }
  } catch (err) {
    // both fresh secrets are the only copies of both outputs
    if (err instanceof AmbiguousMintError) {
      throw new AmbiguousMutationError((err as Error).message, [newK1, changeK1])
    }
    throw keepingOutputs(err, [newK1, changeK1])
  }
}

// Merge: burn all given notes, mint one worth their sum.
export const mergeNotes = async (
  callback: string,
  k1s: string[],
  options: LnurlcashOptions = {}
): Promise<RotateResult> => {
  const opts = resolveOptions(options)
  const newK1 = opts.randomSecret()
  try {
    const result = await mergeNotesWithHash(callback, k1s, hashK1(newK1), options)
    return {k1: newK1, signature: result.signature}
  } catch (err) {
    if (err instanceof AmbiguousMintError) {
      throw new AmbiguousMutationError((err as Error).message, [newK1])
    }
    throw keepingOutputs(err, [newK1])
  }
}

export type SettledNote = {
  k1: string
  amountMsat: number
  signature?: string
  callback: string
}

// Resolves what a split's change note or a merge's output is ACTUALLY
// worth, then rotates it before further use.
//
// Neither response carries an amount - the spec's only source of truth for
// a note's value is an informational GET - and a SERVICE that charges fees
// may have deducted from a split's change or refunded into a merge's
// result. Using a naively computed pre-fee amount instead pairs a wrong
// `amount` with a signature the SERVICE issued for the true one, so the
// note looks unsigned even though it is not.
//
// That GET puts k1 on the wire in turn, so a rotate follows, best-effort: a
// SERVICE that cannot rotate keeps the exposed k1 and its original
// signature rather than failing the whole operation.
export const settleNote = async (
  baseUrl: string,
  k1: string,
  expectedAmountMsat: number,
  signature: string | undefined,
  options: LnurlcashOptions = {}
): Promise<SettledNote> => {
  const info = await fetchNoteInfo(
    withNewK1(baseUrl, k1, expectedAmountMsat, signature),
    options
  )
  try {
    const rotated = await rotateNote(info.callback, k1, options)
    return {
      k1: rotated.k1,
      amountMsat: info.maxWithdrawable,
      signature: rotated.signature,
      callback: info.callback
    }
  } catch {
    return {
      k1,
      amountMsat: info.maxWithdrawable,
      signature,
      callback: info.callback
    }
  }
}

// ---- minting via LUD-06 payRequest ----

export type PayRequestInfo = {
  tag: 'payRequest'
  callback: string
  minSendable: number
  maxSendable: number
  metadata: string
  // LUD-25: present when paying this mints a bearer note. This is the raw
  // LUD-17 withdraw endpoint the note lives at. By default the payment
  // preimage of the invoice becomes its k1; where the SERVICE advertises
  // mintToHash and the WALLET sent an `h`, the note is keyed by that hash
  // instead and the preimage is not a valid k1 at all
  withdrawLink?: string
  // Rarely present here in practice: a WALLET that pays the invoice can
  // recover the SERVICE's node id from its own BOLT-11 signature, so the
  // spec only has a SERVICE publish mintPubkey where there is no invoice to
  // recover it from. Nothing forbids including it anyway.
  mintPubkey?: string
  // parsed from metadata - absent means the SERVICE advertised none, which
  // the spec says to read as fee-free rather than unknown
  mintFee?: MintFee
  // True when this SERVICE accepts an `h` on its pay callback and credits
  // the minted note at that hash instead of at the payment preimage. This
  // is THE place to read the capability: the payRequest is the one endpoint
  // every mint has, it is where a WALLET already is at the moment it is
  // about to mint, and it sits alongside withdrawLink, which the draft
  // already hangs here for LNURLcash's sake. The same field on
  // MintAddressInfo says the same thing and is the fallback for a SERVICE
  // that only advertises there. Undefined means the SERVICE said nothing,
  // which is the same as no. See requestInvoice.
  mintToHash?: boolean
}

export const fetchPayRequest = async (
  url: string,
  options: LnurlcashOptions = {}
): Promise<PayRequestInfo> => {
  const body = await lnurlFetch(url, resolveOptions(options))
  if (body?.tag !== 'payRequest' || typeof body.callback !== 'string') {
    throw new ProtocolError('Not a payRequest (unexpected response).')
  }
  const mintFee =
    typeof body.metadata === 'string' ? parseMintFee(body.metadata) : null
  // The spread is how this one has always been built, so a field a SERVICE
  // adds still rides through untyped. mintToHash is mapped explicitly after
  // it, because anything that is not exactly the boolean true has to read
  // as no rather than as a truthy string.
  return {
    ...body,
    mintFee: mintFee ?? undefined,
    mintToHash: asBoolean(body.mintToHash)
  } as PayRequestInfo
}

export type InvoiceResult = {
  pr: string
  // LUD-21 (optional): a URL to poll for this invoice's settlement
  verify?: string
  // LUD-11: false means the SERVICE wants the payRequest LNURL or Lightning
  // Address itself kept and reused - not this one invoice, which is spent
  // once paid regardless. Per spec, absent MUST be read as true, so only an
  // explicit false counts.
  disposable: boolean
  // The SERVICE confirmed that THIS quote is bound to the `h` that was
  // sent, so the note it mints will be keyed by that hash rather than by
  // the payment preimage. Per quote, and the statement that matters at the
  // moment money moves.
  //
  // False means the quote said nothing about `h`, which is NOT the same as
  // a refusal: the advertisement a WALLET decides from is `mintToHash` on
  // the payRequest, read before asking, and a SERVICE is free to accept the
  // parameter without echoing it back here. So treat this as a
  // confirmation when it arrives, and claim by probing either way.
  mintToHash: boolean
  // Optional receipt commitment. Its presence means a sealed signer can
  // require authenticated LUD-21 settlement without exporting k1. `amount`
  // on the wire is mapped to an explicitly-denominated property here.
  mint?: BoundMintCommitment
}

export type BoundMintCommitment = {
  h: string
  amountMsat: number
  signature?: string
}

export type ValidatedBoundMintReceipt = Required<BoundMintCommitment> & {
  pubkey: string
}

const asBoundMintCommitment = (value: unknown): BoundMintCommitment | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (
    typeof raw.h !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(raw.h) ||
    typeof raw.amount !== 'number' ||
    !Number.isSafeInteger(raw.amount) ||
    raw.amount <= 0 ||
    (raw.sig !== undefined && typeof raw.sig !== 'string')
  ) {
    return undefined
  }
  return {
    h: raw.h.toLowerCase(),
    amountMsat: raw.amount,
    ...(typeof raw.sig === 'string' ? {signature: raw.sig} : {})
  }
}

export type InvoiceRequestOptions = LnurlcashOptions & {
  // Name the note you are buying. `h` is the sha256 of a secret the WALLET
  // chose, exactly as `h` means on the withdraw callback, and a SERVICE
  // that accepts it credits the minted note at `h` on settlement. The
  // payment preimage is then no longer a valid k1 for that note.
  //
  // Why it matters: without `h` the preimage IS the money, and two sets of
  // people learn it without being trusted - every routing node on the
  // payment path, because that is how HTLC settlement works, and anyone
  // who merely saw the invoice, because they can poll LUD-21 verify with
  // its payment hash and take the preimage the moment it settles. A QR on
  // a desktop screen is exactly that. Rotating the instant you claim is a
  // race against a thief in a tight polling loop; choosing the secret
  // yourself is not a race at all.
  //
  // Persist the secret BEFORE calling this. Paying for a note and then
  // losing the secret is the one way this is worse than the preimage
  // scheme, and persisting first removes it. Drawing it from
  // deriveNoteSecret rather than a CSPRNG makes the note seed-derived from
  // birth, so restoreNotes finds it without any rotate at all.
  //
  // Read `mintToHash` off the payRequest before sending this, falling back
  // to the mint address document. A SERVICE that advertises neither ignores
  // the parameter and keys the note by the preimage as it always has.
  //
  // Malformed input is refused here rather than sent, so a WALLET never
  // pays for a quote a SERVICE was going to reject.
  h?: string
}

export const requestInvoice = async (
  payCallback: string,
  amountMsat: number,
  options: InvoiceRequestOptions = {}
): Promise<InvoiceResult> => {
  const cbUrl = new URL(payCallback)
  cbUrl.searchParams.set('amount', String(amountMsat))
  if (options.h !== undefined) {
    if (!isPreimage(options.h)) {
      throw new RequestRefusedError(
        'An output hash must be 32 bytes of hex - no invoice was requested.'
      )
    }
    // lowercase for the same reason a note's k1 is normalised: it is
    // bytes, not text, and a SERVICE storing notes under the hash it was
    // given should be given one spelling of it
    cbUrl.searchParams.set('h', options.h.trim().toLowerCase())
  }
  const body = await lnurlFetch(cbUrl, resolveOptions(options))
  if (typeof body?.pr !== 'string') {
    throw new ProtocolError('The service did not return an invoice.')
  }
  // A SERVICE answering an amount request with an invoice for a DIFFERENT
  // amount is broken or hostile. An amountless invoice passes through:
  // there is nothing to check it against here, and the SERVICE judges it
  // later.
  const invoiceMsat = decodeBolt11AmountMsat(body.pr)
  if (invoiceMsat !== null && invoiceMsat !== amountMsat) {
    throw new ProtocolError(
      `The service returned an invoice for ${invoiceMsat} msat, not the ${amountMsat} requested.`
    )
  }
  return {
    pr: body.pr,
    verify: typeof body.verify === 'string' ? body.verify : undefined,
    disposable: body.disposable !== false,
    mintToHash: body.mintToHash === true,
    mint: asBoundMintCommitment(body.mint)
  }
}

export type VerifyResult = {
  settled: boolean
  preimage: string | null
  pr: string
  mint?: BoundMintCommitment
}

// LUD-21: polls whether an invoice has settled, via the URL requestInvoice
// optionally returned.
//
// For LNURLcash specifically, a settled invoice's preimage IS the bearer
// note's spend secret. A verify GET proves nothing about who is asking -
// only that they know the payment hash embedded in the URL, which travels
// inside the invoice itself. Anyone who saw the unpaid invoice can poll
// this and take the note the moment it settles. A caller that receives a
// preimage here MUST rotate immediately, and must not treat verify as
// having closed that exposure.
//
// That whole race only exists because the SERVICE chose the secret. A
// WALLET that sent an `h` with requestInvoice chose its own, and claims
// with claimMintedNote instead; verify is then an ordinary payment proof
// that leaks nothing. Keep this path for mints that do not offer
// mintToHash.
export const fetchInvoiceVerification = async (
  verifyUrl: string,
  options: LnurlcashOptions = {}
): Promise<VerifyResult> => {
  const body = await lnurlFetch(verifyUrl, resolveOptions(options))
  if (typeof body?.settled !== 'boolean' || typeof body?.pr !== 'string') {
    throw new ProtocolError('The service returned an unexpected verify response.')
  }
  return {
    settled: body.settled,
    preimage: typeof body.preimage === 'string' ? body.preimage : null,
    pr: body.pr,
    mint: asBoundMintCommitment(body.mint)
  }
}

// Refuse a bound invoice before it is shown or paid unless the SERVICE has
// committed this exact quote to the output the WALLET named. A signature at
// this stage is invalid: the value has not settled and does not yet exist.
export const requireBoundMintQuote = (
  invoice: InvoiceResult,
  expectedH: string,
  expectedAmountMsat: number
): BoundMintCommitment => {
  const h = expectedH.trim().toLowerCase()
  if (!isPreimage(h)) throw new ProtocolError('The expected mint output hash is malformed.')
  if (!Number.isSafeInteger(expectedAmountMsat) || expectedAmountMsat <= 0) {
    throw new ProtocolError('The expected mint amount must be positive integer millisatoshis.')
  }
  if (!invoice.mintToHash || !invoice.mint) {
    throw new ProtocolError('The service did not commit this quote to a bound mint output.')
  }
  if (invoice.mint.h !== h) {
    throw new ProtocolError('The service committed the quote to a different mint output.')
  }
  if (invoice.mint.amountMsat !== expectedAmountMsat) {
    throw new ProtocolError('The service committed the quote to a different mint amount.')
  }
  if (invoice.mint.signature !== undefined) {
    throw new ProtocolError('The service signed a mint output before the invoice settled.')
  }
  return invoice.mint
}

// Match the settled LUD-21 response to the exact pre-payment commitment and
// verify the ordinary LUD-25 signature over h and the net note amount. The
// payment preimage remains payment proof only; it is intentionally ignored.
export const validateBoundMintReceipt = (
  invoice: InvoiceResult,
  verification: VerifyResult,
  expectedH: string,
  expectedAmountMsat: number,
  mintPubkeys: string | string[]
): ValidatedBoundMintReceipt => {
  const quote = requireBoundMintQuote(invoice, expectedH, expectedAmountMsat)
  if (!verification.settled) {
    throw new ProtocolError('The invoice has not settled.')
  }
  if (!sameInvoice(invoice.pr, verification.pr)) {
    throw new ProtocolError('The settlement receipt names a different invoice.')
  }
  const receipt = verification.mint
  if (!receipt || receipt.h !== quote.h || receipt.amountMsat !== quote.amountMsat) {
    throw new ProtocolError('The settlement receipt does not match the mint quote.')
  }
  if (!receipt.signature) {
    throw new ProtocolError('The settled mint receipt has no note signature.')
  }
  const checked = verifyNoteSignatureHashAgainst(
    receipt.h,
    receipt.amountMsat,
    receipt.signature,
    mintPubkeys
  )
  if (!checked.valid) {
    throw new ProtocolError('The settled mint receipt has an invalid note signature.')
  }
  return {...receipt, signature: receipt.signature, pubkey: checked.pubkey}
}

// ---- claiming a note you named yourself ----

export type MintClaim = {
  // 'minted'   the note exists at the WALLET's own secret. The invoice was
  //            paid and the SERVICE credited it, so `amountMsat` and
  //            `callback` are populated and there is nothing left to do.
  // 'unminted' the SERVICE does not recognise the secret. Either the
  //            invoice has not settled yet - poll again - or the SERVICE
  //            ignored the `h` and keyed the note by the preimage after
  //            all, in which case the LUD-21 verify path is the way in.
  // 'pending'  the note exists with a melt in flight on it. Alive, value
  //            unstated. Retry, never read this as spent.
  // 'spent'    the note existed and is now burned. On a fresh mint that
  //            means the secret was reused rather than freshly derived.
  state: 'minted' | 'unminted' | 'pending' | 'spent'
  k1: string
  // What the SERVICE says the note is worth, in msat, and the callback to
  // melt or rotate it at. Both null unless the state is 'minted'.
  amountMsat: number | null
  callback: string | null
}

// The claim half of naming the note you are buying. A WALLET that sent `h`
// with requestInvoice already knows the secret, so there is nothing to
// fetch from the SERVICE and no reason to poll LUD-21 verify: it simply
// asks what the note at its own secret is worth, and a live answer is the
// claim.
//
// `withdrawLink` is the raw LUD-17 or https withdraw endpoint the
// payRequest advertised; `k1` is the secret whose hash was sent as `h`.
//
// No rotate follows, and that is the point. The preimage scheme needs one
// because the SERVICE generated the secret and verify hands it to anyone
// who saw the invoice; here the SERVICE never had it and no third party
// can learn it, so the note is the WALLET's from the moment it exists.
// This GET does disclose the secret to the SERVICE it is a claim on, which
// is not the same exposure at all, and a caller who wants a signature on
// the note can still rotate to get one.
//
// Poll this while the invoice is unpaid. Reads only: an 'unminted' answer
// has changed nothing and can simply be asked again.
export const claimMintedNote = async (
  withdrawLink: string,
  k1: string,
  options: LnurlcashOptions = {}
): Promise<MintClaim> => {
  const secret = k1.trim().toLowerCase()
  if (!isPreimage(secret)) {
    throw new RequestRefusedError(
      'A note secret must be 32 bytes of hex - nothing was sent.'
    )
  }
  const blank: Omit<MintClaim, 'state'> = {
    k1: secret,
    amountMsat: null,
    callback: null
  }
  try {
    const info = await fetchNoteInfo(buildNoteUrl(withdrawLink, secret), options)
    return {
      state: 'minted',
      k1: secret,
      amountMsat: info.maxWithdrawable,
      callback: info.callback
    }
  } catch (err) {
    if (err instanceof PendingNoteError) return {...blank, state: 'pending'}
    if (err instanceof NoteSpentError) return {...blank, state: 'spent'}
    if (err instanceof NoteUnknownError) return {...blank, state: 'unminted'}
    // The SERVICE unreachable, or answering with something that is not a
    // withdrawRequest, says nothing about whether the note exists. Thrown
    // rather than reported as 'unminted', which a caller would reasonably
    // read as "not yet" and give up on.
    throw err
  }
}
