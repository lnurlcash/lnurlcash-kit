import {isAllowedServiceUrl} from './urls.js'
import {AmbiguousMintError, RequestRefusedError, ServiceRejectedError} from './errors.js'
import {defaultRandomSecret, type RandomSecret} from './secrets.js'

export type LnurlcashOptions = {
  // Replaces the global fetch. Useful for tests, for a proxy, or for a
  // runtime whose fetch needs configuring (a Tor agent, say).
  fetch?: typeof globalThis.fetch
  // Bounded wait. Without one a hung SERVICE freezes whatever flow called
  // in, forever. Defaults to 30 seconds.
  timeoutMs?: number
  // Refuse to make any request at all. A caller holding notes offline
  // deliberately can set this to be certain nothing reaches the network,
  // rather than trusting that it happens not to.
  offline?: boolean
  // Where replacement note secrets come from. Substitute for a hardware
  // RNG, or for deterministic tests. See secrets.ts.
  randomSecret?: RandomSecret
  // LUD-25 Part 2 certifies cp1 notes only: a rotate, split or merge to a
  // cp1 output MUST return its cs1 in `sig` (and `sig2` on a split), and
  // this library always insists on that. A plain hash output has nothing
  // to attest to without disclosing the secret, so it comes back unsigned
  // by design, and `signature` is undefined.
  //
  // Set true to also demand the old Part 1 signature over a hash output,
  // as every mint issued before the Part 2 rewrite. Off by default since
  // 0.13: a mint that follows the current draft answers a plain rotate
  // with a bare OK, and refusing that would refuse the spec.
  requireSignatures?: boolean
  // A SERVICE publishes `mintPubkey` on its withdrawRequest so a cp1 note's
  // certificate can be checked offline. Required by default; set false only
  // for a Part 1-only mint that publishes none, knowing that nothing it
  // issues can then be verified offline.
  requireMintPubkey?: boolean
  // How many times to re-send a rotate, split or merge whose outcome the
  // transport lost. LUD-25 requires a SERVICE to answer a byte-identical
  // retry with the original success ("Retrying a mutation"), so re-sending
  // resolves the ambiguity rather than compounding it: a compliant SERVICE
  // replays, and one that refuses leaves the caller exactly where an
  // un-retried failure would have.
  //
  // Only ever applied to the hash-disclosing mutations, which are the ones
  // the replay rule covers. A melt is never retried: it carries `pr`, is
  // paid out asynchronously, and has no replay guarantee at all.
  //
  // Defaults to 1. Zero restores the pre-0.7 behaviour of giving up on the
  // first ambiguous answer.
  mutationRetries?: number
}

export type ResolvedOptions = Required<Omit<LnurlcashOptions, 'fetch'>> & {
  fetch: typeof globalThis.fetch
}

export const resolveOptions = (options: LnurlcashOptions = {}): ResolvedOptions => ({
  // Wrapped, never referenced bare: in a browser window.fetch is a method
  // that demands its receiver, and calling a detached copy throws
  // 'Illegal invocation'. Node and DOM test environments never enforce
  // that, so only a REAL browser catches the bare form - the worst
  // possible place to find out.
  fetch: options.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args)),
  timeoutMs: options.timeoutMs ?? 30_000,
  offline: options.offline ?? false,
  randomSecret: options.randomSecret ?? defaultRandomSecret,
  requireSignatures: options.requireSignatures ?? false,
  requireMintPubkey: options.requireMintPubkey ?? true,
  // A negative or non-finite count is read as none rather than thrown on:
  // this is a resilience knob, and refusing the whole operation over it
  // would be a worse answer than not retrying.
  mutationRetries: normaliseRetries(options.mutationRetries)
})

const normaliseRetries = (value: number | undefined): number => {
  if (value === undefined) return 1
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

// Followed by hand, never by fetch itself. Fetch's own redirect handling
// would treat the first URL's admission check as covering the whole chain,
// which it does not: nothing stops an https endpoint redirecting to http
// cleartext on another host, and a k1-bearing callback URL would ride along
// in the clear. Every hop is re-admitted against the same rule instead.
// Bounded, so a redirect loop is an error rather than a hang.
const MAX_REDIRECTS = 5

// LNURL payloads are small - a payRequest with an inlined image is the large
// end. A SERVICE may answer with a body of unlimited size, and reading it
// without a cap lets one response exhaust the caller's memory.
const MAX_BODY_BYTES = 1_048_576

const fetchFollowingRedirects = async (
  startUrl: string,
  options: ResolvedOptions
): Promise<Response> => {
  let current = startUrl
  for (let redirects = 0; ; redirects++) {
    let res: Response
    try {
      res = await options.fetch(current, {
        signal: AbortSignal.timeout(options.timeoutMs),
        redirect: 'manual'
      })
    } catch (err) {
      // Transport failures are ambiguous for a mutating request: the request
      // may well have arrived, and only the answer was lost.
      if ((err as Error).name === 'TimeoutError') {
        throw new AmbiguousMintError(
          'The service took too long to respond - its answer, if any, was lost.'
        )
      }
      throw new AmbiguousMintError(
        'Failed to reach the service - it may be offline, or may not allow cross-origin requests.'
      )
    }
    const location = res.headers.get('location')
    if (!REDIRECT_STATUSES.has(res.status) || !location) return res
    if (redirects >= MAX_REDIRECTS) {
      throw new AmbiguousMintError('The service redirected too many times.')
    }
    let next: string | null
    try {
      next = new URL(location, current).toString()
    } catch {
      next = null
    }
    // The first request was already sent deliberately; refusing to follow is
    // a statement about the answer, not about whether anything happened.
    if (!next || !isAllowedServiceUrl(next)) {
      throw new AmbiguousMintError(
        'The service tried to redirect somewhere this library will not fetch - the original request may already have been processed.'
      )
    }
    current = next
  }
}

const readBodyText = async (res: Response): Promise<string> => {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new AmbiguousMintError('The service returned an oversized response.')
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const {done, value} = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      throw new AmbiguousMintError('The service returned an oversized response.')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

// The single request primitive. Every failure it raises is already
// classified by whether the request could have been processed, which is
// the distinction the rest of the library depends on.
export const lnurlFetch = async (
  url: string | URL,
  options: ResolvedOptions
): Promise<any> => {
  if (options.offline) {
    throw new RequestRefusedError(
      'Offline mode is on - no request was made.'
    )
  }
  if (!isAllowedServiceUrl(url.toString())) {
    throw new RequestRefusedError(
      'Refusing to fetch that URL - only https, or http to a loopback or .onion host, is allowed.'
    )
  }
  const res = await fetchFollowingRedirects(url.toString(), options)
  const text = await readBodyText(res)
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    throw new AmbiguousMintError('The service returned an unreadable response.')
  }
  if (body?.status === 'ERROR') {
    // The reason is carried through EXACTLY as the SERVICE sent it, empty
    // string included. Substituting a friendly default here would be read
    // back by classifyNoteError as though the SERVICE had said it: a
    // reasonless error becomes "Unknown service error", which matches the
    // rule for "unknown note" and reports a note as unrecognised on no
    // evidence at all. Via probeBurnedNote that reads as "the burn landed",
    // which is a conclusion about somebody's money drawn from a blank.
    throw new ServiceRejectedError(
      typeof body.reason === 'string' ? body.reason : ''
    )
  }
  return body
}
