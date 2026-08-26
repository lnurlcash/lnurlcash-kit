import {
  HashLookupUnsupportedError,
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  ServiceRejectedError
} from './errors.js'
import {fetchNoteInfo, fetchNoteInfoByHash} from './client.js'
import {buildNoteUrl} from './note.js'
import {deriveNoteSecret, hashK1} from './secrets.js'
import type {LnurlcashOptions} from './transport.js'

// ---- restore from a seed ----
//
// A wallet whose secrets are derived (see secrets.ts) can rebuild itself
// from the seed and the mint alone: walk the indices, ask the SERVICE what
// each derived secret is worth, and stop once a run of them is unknown.
// The SERVICE is not told anything it does not already hold - it stores
// every note under sha256(k1) and is simply being asked about its own
// records, one note at a time.
//
// The walk asks by HASH (LUD-25, "Checking a note without exposing it").
// Asking by secret is what the obvious implementation does and it is a bad
// idea here in a way that is easy to miss: a walk queries every index up to
// `gap` PAST the last one in use, and those are precisely the indices the
// wallet is about to mint into next. Asking by secret therefore publishes
// the next `gap` note secrets the wallet will ever use, in cleartext query
// strings, to every log between it and the SERVICE - and then goes and
// mints notes under them. `disclosesSecrets` on the result says whether
// that happened, and `next` skips the disclosed window when it did.
//
// Two things this is not. It is not a way to discover which mints a wallet
// used: the caller supplies the host, because a mint cannot be guessed from
// a seed. And it is not free of exposure even by hash - the SERVICE still
// learns that one party is asking about this run of notes at this moment,
// which links them to each other and puts a floor under how private a
// restore can be.

export type RestoredNote = {
  index: number
  k1: string
  // What the SERVICE says the note is worth, in msat. `null` for a pending
  // note: a melt is in flight on it and the SERVICE will not state a value
  // until that resolves. The note may yet come back, and it may not.
  amountMsat: number | null
  state: 'live' | 'pending'
  // The callback the lookup returned, carried so a caller does not have to
  // ask a second time with the raw secret. Re-querying by secret to fetch
  // this would undo the whole point of a hash-only walk.
  callback?: string
}

// An index the SERVICE rejected for a reason this version does not
// recognise. Not a note and not recoverable here, but the SERVICE said
// something about it, which is not the same as never having heard of it.
export type UnresolvedIndex = {
  index: number
  k1: string
  reason: string
}

export type RestoreResult = {
  found: RestoredNote[]
  unresolved: UnresolvedIndex[]
  // The next unused index for this host. One past the highest index the
  // SERVICE recognised - it deliberately counts SPENT indices as used,
  // since re-deriving a burned note's secret would mint a duplicate id -
  // or, if the walk disclosed secrets, one past the highest index it
  // walked, because a disclosed secret is spent whether or not a note was
  // ever minted under it.
  next: number
  // Whether any lookup in this walk came back with a note. It is the ONLY
  // positive proof the SERVICE answers lookups by hash: one that does not
  // index by hash answers every such lookup exactly as it answers an
  // unknown note. An empty `found` with this false is INCONCLUSIVE, not a
  // statement that the wallet holds nothing - pass `probeK1`, or allow
  // disclosure, to get an answer that means something.
  hashLookupsConfirmed: boolean
  // Whether any raw secret went on the wire during this walk.
  disclosesSecrets: boolean
}

export type RestoreOptions = {
  // How many consecutive unknown indices end the walk. Cashu's NUT-13 uses
  // 20 and wallets have been built against that number for years; a gap
  // only appears when a wallet bumped its counter and then failed before
  // the wire call, which is rare and never happens twenty times in a row.
  gap?: number
  // Where to resume from. A wallet that already restored to index 40 passes
  // 40 rather than walking those forty again.
  start?: number
  // A secret the caller already knows this SERVICE holds a note for, used
  // once as a positive control on whether it answers lookups by hash. Worth
  // passing whenever the caller has one: without it, a wallet that really
  // is empty and a SERVICE that cannot answer by hash look identical.
  probeK1?: string
  // Permit a fallback walk that asks by secret, when asking by hash proved
  // nothing. OFF by default, and deliberately not automatic: falling back
  // quietly would put every secret on the wire in exactly the case the
  // caller was trying to avoid. Turning it on costs the next `gap` indices
  // at this host, which `next` then skips.
  allowSecretDisclosure?: boolean
}

type WalkOutcome = {
  found: RestoredNote[]
  unresolved: UnresolvedIndex[]
  lastUsed: number | null
  highestWalked: number | null
}

// Reads only. Nothing here rotates, melts or otherwise touches a note, so a
// restore that is interrupted has changed nothing and can simply be run
// again. An unexpected failure - the mint down, a response that is not a
// withdrawRequest - is thrown rather than swallowed: a half-walked run that
// reported `next` as though it had finished would leave the wallet
// re-deriving secrets the mint has already issued notes at.
export const restoreNotes = async (
  baseUrl: string,
  root: Uint8Array,
  host: string,
  {gap = 20, start = 0, probeK1, allowSecretDisclosure = false}: RestoreOptions = {},
  options: LnurlcashOptions = {}
): Promise<RestoreResult> => {
  if (!Number.isSafeInteger(gap) || gap < 1) {
    throw new RangeError(`The gap limit must be a positive integer, not ${gap}.`)
  }
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new RangeError(`The start index must be a non-negative integer, not ${start}.`)
  }

  let hashLookupsConfirmed = false

  // One request settles what a whole walk otherwise cannot. Only a positive
  // answer counts: a rejection here says nothing, since it is what an
  // unsupported SERVICE and a spent probe note both look like.
  if (probeK1) {
    try {
      await fetchNoteInfoByHash(baseUrl, hashK1(probeK1), options)
      hashLookupsConfirmed = true
    } catch (err) {
      if (!(err instanceof ServiceRejectedError)) throw err
    }
  }

  // Ask by hash: nothing spendable goes on the wire.
  const byHash = await walk(
    start,
    gap,
    async k1 => {
      const info = await fetchNoteInfoByHash(baseUrl, hashK1(k1), options)
      hashLookupsConfirmed = true
      return info
    },
    root,
    host
  )

  if (byHash.found.length > 0 || byHash.unresolved.length > 0) hashLookupsConfirmed = true

  if (hashLookupsConfirmed) {
    return {
      found: byHash.found,
      unresolved: byHash.unresolved,
      next: byHash.lastUsed === null ? start : byHash.lastUsed + 1,
      hashLookupsConfirmed: true,
      disclosesSecrets: false
    }
  }

  // Nothing came back, and nothing proved this SERVICE answers by hash. The
  // walk may have been a long conversation about nothing, or the wallet may
  // genuinely hold nothing here, and there is no way to tell the two apart
  // from the outside. Returning an empty result would pick one.
  if (!allowSecretDisclosure) {
    throw new HashLookupUnsupportedError(
      'This service never answered a lookup by hash, so a restore cannot tell an empty wallet from a service that only accepts raw secrets. Pass a probeK1 for a note known to exist here, or allowSecretDisclosure to walk by secret instead.'
    )
  }

  // Only now, and only because the caller explicitly asked for it, fall
  // back to the form that reveals the secrets.
  const bySecret = await walk(
    start,
    gap,
    k1 => fetchNoteInfo(buildNoteUrl(baseUrl, k1), options),
    root,
    host
  )
  const walkedThrough = bySecret.highestWalked === null ? start - 1 : bySecret.highestWalked
  const used = bySecret.lastUsed === null ? start - 1 : bySecret.lastUsed
  return {
    found: bySecret.found,
    unresolved: bySecret.unresolved,
    // Every index this walk touched is burned, whether or not a note was
    // ever minted under it: its secret is in a log somewhere now, so
    // minting into it later would be minting a note a stranger can spend.
    next: Math.max(used, walkedThrough) + 1,
    hashLookupsConfirmed: false,
    disclosesSecrets: true
  }
}

const walk = async (
  start: number,
  gap: number,
  lookup: (k1: string) => Promise<{callback: string; maxWithdrawable: number}>,
  root: Uint8Array,
  host: string
): Promise<WalkOutcome> => {
  const found: RestoredNote[] = []
  const unresolved: UnresolvedIndex[] = []
  let lastUsed: number | null = null
  let highestWalked: number | null = null
  let unknownRun = 0
  for (let index = start; unknownRun < gap; index++) {
    const k1 = deriveNoteSecret(root, host, index)
    highestWalked = index
    try {
      const info = await lookup(k1)
      found.push({
        index,
        k1,
        amountMsat: info.maxWithdrawable,
        state: 'live',
        callback: info.callback
      })
      lastUsed = index
      unknownRun = 0
    } catch (err) {
      if (err instanceof PendingNoteError) {
        // Alive, value unstated. Recorded so the caller can reconcile it
        // later rather than losing the index to the gap counter.
        found.push({index, k1, amountMsat: null, state: 'pending'})
        lastUsed = index
        unknownRun = 0
      } else if (err instanceof NoteSpentError) {
        // Spent is still used. The note is gone, but the index is not free.
        lastUsed = index
        unknownRun = 0
      } else if (err instanceof NoteUnknownError) {
        unknownRun++
      } else if (err instanceof ServiceRejectedError) {
        // The SERVICE refused for a reason this version has no name for -
        // a state added since it was written, most likely. It knows
        // something about this index, which is the opposite of never
        // having issued it, so the index counts as used and the gap
        // counter resets. Advancing it here is how a walk terminates
        // early and silently abandons live notes beyond the run.
        unresolved.push({index, k1, reason: err.reason})
        lastUsed = index
        unknownRun = 0
      } else {
        // Not a statement about this index at all: the SERVICE is down, or
        // answering with something that is not a withdrawRequest. Throwing
        // beats reporting a `next` that was never really established.
        throw err
      }
    }
  }
  return {found, unresolved, lastUsed, highestWalked}
}
