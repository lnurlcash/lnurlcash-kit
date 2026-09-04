// lnurlcash-kit - LNURLcash (LUD-25) bearer notes for TypeScript.
//
// A bearer note is an ordinary LUD-03 withdrawRequest link whose k1 IS the
// asset:
//
//   lnurlw://mint.example/w?k1=<secret>&amount=<msat>
//
// Whoever knows the k1 controls the sats behind it, like a banknote. The
// `amount` alongside it is only a claim by whoever encoded the note; the
// authoritative value is always maxWithdrawable from an informational GET.
// No new endpoint and no new encoding, so a wallet that has never heard of
// LNURLcash sees a normal withdraw link and can still cash it out.
//
// Every mutating operation is a GET on the `callback` from that
// withdrawRequest:
//
//   callback?k1=X&pr=<bolt11>              melt
//   callback?k1=X&h=<sha256(X')>           rotate
//   callback?k1=X&amount=<msat>&h=..&h2=.. split
//   callback?k1=X&k1=Y&h=<sha256(Z)>       merge
//
// Draft spec: https://github.com/lnurl/luds/pull/301
//
// Reference implementations, both by dni and both MIT:
//   mint   https://github.com/dni/lnurl-mint
//   wallet https://github.com/dni/lnurl-wallet
//
// This library was extracted from that wallet's protocol layer.

export {
  isBech32Lnurl,
  toBech32Lnurl,
  fromBech32Lnurl,
  isAllowedServiceUrl,
  fromLud17,
  toLud17w,
  isLightningAddress,
  resolveMintInput,
  resolveLnurlInput,
  mintAddressUrl,
  lightningAddressUsername,
  serverOf
} from './urls.js'

export {
  noteK1,
  requireNoteK1,
  noteDeclaredAmount,
  noteSignature,
  resolveNoteInput,
  isValidNoteInput,
  buildNoteUrl,
  buildNoteInfoUrlByHash,
  withNewK1,
  withoutK1
} from './note.js'

export {
  hashK1,
  isPreimage,
  defaultRandomSecret,
  deriveNoteRoot,
  deriveNoteSecret,
  derivedSecretSource,
  type RandomSecret
} from './secrets.js'

export {
  deriveCashRoot,
  deriveCashChild,
  deriveCashDomainNode,
  deriveCashSecret,
  cashDomainIndices,
  cashSecretAt,
  cashSecretSource,
  cashNodeToHex,
  cashNodeFromHex,
  type CashNode
} from './cash.js'

export {
  PAYMENT_REQUEST_PREFIX,
  encodePaymentRequest,
  decodePaymentRequest,
  isPaymentRequest,
  paymentRequestAmountMsat,
  type PaymentRequest,
  type PaymentRequestMethodDetails,
  type DecodeOptions
} from './request.js'

export {
  settleNoteForValue,
  type SettleForValueOptions,
  type SettledForValue
} from './settle.js'

export {
  restoreNotes,
  restoreFromSeed,
  type NoteScheme,
  type RestoredNote,
  type RestoreResult,
  type RestoreOptions,
  type SeedRestoreOptions,
  type SeedRestoreResult,
  type UnresolvedIndex
} from './restore.js'

export {
  verifyNoteSignature,
  verifyNoteSignatureAgainst,
  verifyNoteSignatureHash,
  verifyNoteSignatureHashAgainst,
  noteSignatureMessage,
  noteSignatureMessageForHash,
  noteSignatureDigest,
  noteSignatureDigestForHash,
  type SignatureCheck
} from './signature.js'

export {
  parseMintFee,
  applyMintFee,
  mintFeeBand,
  withinMintFeeBand,
  grossUpForMintFee,
  formatFeePercent,
  describeMintFee,
  type MintFee,
  type MintFeeBand
} from './fees.js'

export {
  isBolt11Invoice,
  sameInvoice,
  decodeBolt11AmountMsat
} from './bolt11.js'

export {
  LnurlcashError,
  RequestRefusedError,
  ProtocolError,
  ServiceRejectedError,
  PendingNoteError,
  NoteSpentError,
  NoteUnknownError,
  InsufficientValueError,
  HashLookupUnsupportedError,
  AmbiguousMintError,
  AmbiguousMutationError,
  UnverifiableNoteError,
  classifyNoteError,
  newSecretsOf
} from './errors.js'

export {type LnurlcashOptions} from './transport.js'

export {
  fetchNoteInfo,
  fetchNoteInfoByHash,
  namesMintOutput,
  probeBurnedNote,
  fetchMintAddress,
  meltNote,
  rotateNote,
  rotateNoteWithHash,
  splitNote,
  splitNoteWithHash,
  mergeBatches,
  mergeNotes,
  mergeNotesWithHash,
  settleNote,
  fetchPayRequest,
  requestInvoice,
  fetchInvoiceVerification,
  requireBoundMintQuote,
  validateBoundMintReceipt,
  claimMintedNote,
  type WithdrawRequestInfo,
  type NoteInfoByHash,
  type MintAddressInfo,
  type MintContact,
  type WithdrawSuccessResponse,
  type MeltResult,
  type HashedMutationResult,
  type HashedSplitResult,
  type RotateResult,
  type SplitResult,
  type SettledNote,
  type PayRequestInfo,
  type InvoiceResult,
  type InvoiceRequestOptions,
  type BoundMintCommitment,
  type ValidatedBoundMintReceipt,
  type MintClaim,
  type VerifyResult
} from './client.js'

import type {LnurlcashOptions} from './transport.js'
import * as client from './client.js'
import {
  restoreNotes,
  restoreFromSeed,
  type RestoreOptions,
  type SeedRestoreOptions
} from './restore.js'
import {settleNoteForValue, type SettleForValueOptions} from './settle.js'

// Every request function takes options as its last argument, so they can be
// used directly. createClient binds one set of options once, for callers
// who would otherwise thread the same object through every call site.
export const createClient = (options: LnurlcashOptions = {}) => ({
  fetchNoteInfo: (url: string) => client.fetchNoteInfo(url, options),
  fetchNoteInfoByHash: (withdrawLink: string, h: string) =>
    client.fetchNoteInfoByHash(withdrawLink, h, options),
  probeBurnedNote: (url: string) => client.probeBurnedNote(url, options),
  fetchMintAddress: (url: string) => client.fetchMintAddress(url, options),
  meltNote: (callback: string, k1: string, pr: string) =>
    client.meltNote(callback, k1, pr, options),
  rotateNote: (callback: string, k1: string) =>
    client.rotateNote(callback, k1, options),
  rotateNoteWithHash: (callback: string, k1: string, h: string) =>
    client.rotateNoteWithHash(callback, k1, h, options),
  splitNote: (callback: string, k1s: string[], amountMsat: number) =>
    client.splitNote(callback, k1s, amountMsat, options),
  splitNoteWithHash: (
    callback: string,
    k1s: string[],
    amountMsat: number,
    h: string,
    h2: string
  ) => client.splitNoteWithHash(callback, k1s, amountMsat, h, h2, options),
  mergeNotes: (callback: string, k1s: string[]) =>
    client.mergeNotes(callback, k1s, options),
  mergeNotesWithHash: (callback: string, k1s: string[], h: string) =>
    client.mergeNotesWithHash(callback, k1s, h, options),
  settleNote: (
    baseUrl: string,
    k1: string,
    expectedAmountMsat: number,
    signature?: string
  ) => client.settleNote(baseUrl, k1, expectedAmountMsat, signature, options),
  fetchPayRequest: (url: string) => client.fetchPayRequest(url, options),
  // `h` names the note the invoice will mint - see requestInvoice. The
  // bound transport options are merged under it, so a caller can still
  // reach for a one-off override.
  requestInvoice: (payCallback: string, amountMsat: number, h?: string) =>
    client.requestInvoice(payCallback, amountMsat, {...options, h}),
  fetchInvoiceVerification: (verifyUrl: string) =>
    client.fetchInvoiceVerification(verifyUrl, options),
  claimMintedNote: (withdrawLink: string, k1: string) =>
    client.claimMintedNote(withdrawLink, k1, options),
  restoreNotes: (
    baseUrl: string,
    root: Uint8Array,
    host: string,
    restoreOptions: RestoreOptions = {}
  ) => restoreNotes(baseUrl, root, host, restoreOptions, options),
  restoreFromSeed: (
    baseUrl: string,
    seed: Uint8Array,
    host: string,
    restoreOptions: SeedRestoreOptions = {}
  ) => restoreFromSeed(baseUrl, seed, host, restoreOptions, options),
  settleNoteForValue: (noteUrl: string, terms: SettleForValueOptions) =>
    settleNoteForValue(noteUrl, terms, options)
})

export type LnurlcashClient = ReturnType<typeof createClient>
