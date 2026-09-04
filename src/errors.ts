// The error taxonomy is the safety-critical part of this library, so it is
// worth stating plainly what each class means for the money involved.
//
//   RequestRefusedError   nothing was sent. The note is untouched.
//   ServiceRejectedError  the SERVICE processed the request and refused it.
//                         Definitive.
//   AmbiguousMintError    the outcome is unknown. The request MAY have been
//                         processed. Nothing may be assumed either way.
//   ProtocolError         a non-mutating response did not match the spec.
//   UnverifiableNoteError a MUTATION landed, and the SERVICE returned no
//                         signature over it. The note exists; it just
//                         cannot be verified offline.
//
// Treating an ambiguous failure as a definitive one is how wallets lose
// money: a rotate that times out after the SERVICE burned the input has
// already minted the output, and the fresh secret the caller generated is
// the only copy of it in existence.

export class LnurlcashError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

// The request never left: offline, a URL this library will not fetch, or a
// callback URL that does not parse. Safe to treat as "nothing happened".
export class RequestRefusedError extends LnurlcashError {}

// A non-mutating response that does not match the protocol - a
// withdrawRequest that is not one, a verify response missing its fields.
export class ProtocolError extends LnurlcashError {}

// The SERVICE answered {"status":"ERROR"}: it processed the request and
// declined it. Definitive - the operation did not happen.
export class ServiceRejectedError extends LnurlcashError {
  readonly reason: string
  // The WALLET-generated secrets a MUTATION disclosed the hashes of, when
  // this refusal is one that could describe a mutation the SERVICE had
  // already applied - see newSecretsOf. Absent on every other refusal, and
  // absent on every non-mutating call.
  newSecrets?: string[]
  constructor(reason: string) {
    super(reason || 'The service rejected the request.')
    this.reason = reason
  }
}

// The exact {"status":"ERROR","reason":"pending"} case: this k1 has a melt
// in flight, and every other operation on it is refused until that
// resolves. Retry shortly - never read this as spent.
export class PendingNoteError extends ServiceRejectedError {
  constructor(reason = 'pending') {
    super(reason)
    this.message =
      'This note has another operation in progress - try again in a moment.'
  }
}

// The SERVICE reports the k1 as already burned. At the informational GET
// ("Note already spent.") that statement is unambiguous and authoritative,
// so a holder may lock the note as spent without asking anything further.
// At the mutating callback the picture is weaker: the atomic refusal string
// ("Invalid or already spent k1.") covers an unknown or malformed k1 and an
// output-id collision just as much as a genuinely spent input. Before
// locking a note on the strength of a CALLBACK refusal, probe it with
// probeBurnedNote.
//
// Worse than weak: it may be a description of something that DID happen.
// Every mutation is a GET, and HTTP stacks retry a GET whose connection
// dropped - browsers on a stale keep-alive connection, Go's net/http on a
// reused idle one, the JDK's HttpClient on any idempotent method with no
// switch to stop it. The retry is byte-identical, so the SERVICE sees the
// same request twice and answers the second one with exactly this refusal,
// its inputs having been burned by the first. The caller is told the
// mutation never happened while a note sits at the hash it disclosed.
//
// So when this error comes from a mutation it carries `newSecrets`, and
// discarding them without checking is how the money becomes unspendable by
// anyone at all. Read them with newSecretsOf, persist them, then ask the
// SERVICE what the note at each one is worth: a live note means the
// mutation landed.
export class NoteSpentError extends ServiceRejectedError {
  constructor(reason: string) {
    super(reason)
    this.message = `This note has already been spent (service says: "${reason}").`
  }
}

// The SERVICE does not recognise the k1 at all - never minted there,
// minted somewhere else, or corrupted. Distinct from NoteSpentError
// because nothing here proves the holder's copy was ever real, so it is
// surfaced rather than silently locked as spent.
export class NoteUnknownError extends ServiceRejectedError {
  constructor(reason: string) {
    super(reason)
    this.message = `The service doesn't recognise this note (service says: "${reason}").`
  }
}

// The outcome is unknown. The failure happened in a window where the
// request may already have reached and been processed by the SERVICE: a
// timeout, a dropped connection, an unparseable response, or a 200 that
// did not carry the expected confirmation.
// A hash-only walk that never got a single positive answer. LUD-25 makes
// the informational GET's `h` OPTIONAL and gives it no capability flag, so
// a SERVICE that cannot answer by hash is indistinguishable from one that
// can and simply holds none of the notes asked about: both answer every
// lookup exactly as they answer an unknown note.
//
// Thrown rather than reported as an empty restore because those two cases
// call for opposite responses from a wallet - "you have nothing here" and
// "ask again a different way" - and quietly picking the first is how a
// wallet tells someone their money is gone when it is not.
export class HashLookupUnsupportedError extends LnurlcashError {}

export class AmbiguousMintError extends LnurlcashError {}

// The SERVICE confirmed a rotate, split or merge with {"status":"OK"} but
// returned no signature over the hash it was given. LUD-25 makes offline
// verification mandatory, so this is a non-compliant SERVICE - but the
// mutation LANDED. The note exists, at the hash the caller disclosed, and
// the WALLET-generated secret behind it is the only key to that value
// anywhere.
//
// So this is an error about the note's VERIFIABILITY, never about its
// existence, and it carries the secrets for the same reason
// AmbiguousMutationError does: throwing without them would strand real
// money to make a point about conformance. Persist them, then decide
// whether to keep dealing with a mint that issues notes nobody can check.
//
// Only ever raised when `requireSignatures` is on, which is the default.
export class UnverifiableNoteError extends LnurlcashError {
  newSecrets: string[]
  constructor(message: string, newSecrets: string[] = []) {
    super(message)
    this.newSecrets = newSecrets
  }
}

// An AmbiguousMintError from a rotate, split or merge, carrying the fresh
// WALLET-generated secrets whose hashes the uncertain request disclosed.
// If the request did land, these are the only copies of the outputs the
// SERVICE minted - so they ride the error rather than vanishing with the
// stack frame that made them.
//
// Order matches the operation's result shape: [rotated] for a rotate,
// [split-off, change] for a split, [merged] for a merge.
export class AmbiguousMutationError extends AmbiguousMintError {
  readonly newSecrets: string[]
  constructor(message: string, newSecrets: string[]) {
    super(message)
    this.newSecrets = newSecrets
  }
}

// A note offered as payment is worth less than the price asked. Definitive,
// and nothing was burned: the note is untouched and still belongs to
// whoever offered it. Carries both numbers so a server can say how short it
// was rather than "declined".
export class InsufficientValueError extends ServiceRejectedError {
  readonly amountMsat: number
  readonly minMsat: number
  constructor(amountMsat: number, minMsat: number) {
    super(`worth ${amountMsat} msat, needs ${minMsat} msat`)
    this.amountMsat = amountMsat
    this.minMsat = minMsat
    this.message = `This note is worth ${amountMsat} msat, and ${minMsat} msat is required.`
  }
}

// The secrets an error is carrying, or none.
//
// Two error families carry them. AmbiguousMutationError always does: the
// outcome is unknown and they may be the only copies of what the SERVICE
// minted. A definitive refusal does when it names an input as spent or
// unknown, because that is also what a mutation the SERVICE ALREADY applied
// looks like when the request is sent a second time - see the note on
// NoteSpentError. Either way the rule for a caller is the same, and it is
// the first thing to do: persist these before anything else.
export const newSecretsOf = (err: unknown): string[] => {
  if (err instanceof AmbiguousMutationError) return err.newSecrets
  if (err instanceof UnverifiableNoteError) return err.newSecrets
  if (err instanceof ServiceRejectedError) return err.newSecrets ?? []
  return []
}

// A SERVICE's wording for "this k1 is dead" varies by implementation and
// by endpoint. An informational GET can afford to distinguish "Note
// already spent." from "Unknown note.", while the mutating callback - an
// atomic, possibly multi-k1 request - can only say something like "Invalid
// or already spent k1.", since it cannot tell which case applies to which
// k1. Classified here so every call site gets a consistent typed error
// instead of re-parsing reason text.
export const classifyNoteError = (reason: string): ServiceRejectedError => {
  // "pending" is the one reason string LUD-25 fixes verbatim, and it is the
  // one case that is neither spent nor unknown: the note is alive with a
  // melt in flight. Classified first so an informational GET that reports it
  // reaches callers as PendingNoteError rather than a bare rejection they
  // would have to re-parse. PendingNoteError extends ServiceRejectedError,
  // so anything already catching the parent is unaffected.
  if (reason === 'pending') return new PendingNoteError(reason)
  if (/spent/i.test(reason)) return new NoteSpentError(reason)
  if (/unknown|not found/i.test(reason)) return new NoteUnknownError(reason)
  return new ServiceRejectedError(reason)
}
