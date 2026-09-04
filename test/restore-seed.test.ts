import {describe, expect, it} from 'vitest'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {restoreFromSeed} from '../src/restore.js'
import {deriveNoteRoot, deriveNoteSecret, hashK1} from '../src/secrets.js'
import {deriveCashRoot, deriveCashSecret} from '../src/cash.js'

// A wallet that has minted under both derivations: the kit's own HMAC scheme
// before LUD-25 had one, and LUD-25's m/139' scheme since. One seed, one
// host, two sets of indices that know nothing about each other.
const SEED = hexToBytes('44'.repeat(32))
const HOST = 'mint.example'
const BASE = 'https://mint.example/w'
const MINT_PUBKEY = bytesToHex(
  secp256k1.getPublicKey(hexToBytes('11'.repeat(32)), true)
)

const legacyRoot = deriveNoteRoot(SEED)
const cashRoot = deriveCashRoot(SEED)

const legacyAt = (index: number): string =>
  deriveNoteSecret(legacyRoot, HOST, index)
const cashAt = (index: number): string => deriveCashSecret(cashRoot, HOST, index)

// The same by-hash SERVICE the hash-only restore tests use: it answers `h`,
// never echoes a k1, and knows nothing about which scheme minted what - to a
// mint, a derived secret is 32 bytes like any other.
const service = (
  notes: Map<string, number>,
  seenK1s: string[],
  {answersByHash = true} = {}
): typeof fetch =>
  (async input => {
    const u = new URL(input.toString())
    const k1 = u.searchParams.get('k1')
    const h = u.searchParams.get('h')
    if (k1) seenK1s.push(k1)
    const key = h ? (answersByHash ? h : null) : k1 ? hashK1(k1) : null
    const amount = key === null ? undefined : notes.get(key)
    const body =
      amount === undefined
        ? {status: 'ERROR', reason: 'Unknown note.'}
        : {
            tag: 'withdrawRequest',
            callback: `${BASE}/cb`,
            maxWithdrawable: amount,
            minWithdrawable: 0,
            mintPubkey: MINT_PUBKEY,
            ...(k1 ? {k1} : {})
          }
    return new Response(JSON.stringify(body), {
      headers: {'content-type': 'application/json'}
    })
  }) as typeof fetch

describe('restoreFromSeed', () => {
  it('finds notes from both schemes in one pass, and says which is which', async () => {
    const notes = new Map<string, number>()
    notes.set(hashK1(cashAt(0)), 21_000)
    notes.set(hashK1(cashAt(1)), 42_000)
    // Money minted before the spec had a derivation. A wallet that walked
    // only the new scheme would leave this at a mint it can no longer name.
    notes.set(hashK1(legacyAt(0)), 7_000)
    const seen: string[] = []

    const result = await restoreFromSeed(
      BASE,
      SEED,
      HOST,
      {},
      {fetch: service(notes, seen)}
    )

    expect(
      result.found.map(note => [note.scheme, note.index, note.amountMsat])
    ).toEqual([
      ['bip32', 0, 21_000],
      ['bip32', 1, 42_000],
      ['hmac', 0, 7_000]
    ])
    expect(result.next).toEqual({bip32: 2, hmac: 1})
    expect(result.hashLookupsConfirmed).toBe(true)
    expect(result.disclosesSecrets).toBe(false)
    // The whole point of walking by hash: not one spendable secret went out.
    expect(seen).toEqual([])
  })

  it('finds a wallet that only ever used the legacy scheme', async () => {
    const notes = new Map<string, number>()
    notes.set(hashK1(legacyAt(0)), 21_000)

    const result = await restoreFromSeed(
      BASE,
      SEED,
      HOST,
      {},
      {fetch: service(notes, [])}
    )

    expect(result.found.map(note => note.scheme)).toEqual(['hmac'])
    // The new scheme found nothing, so its counter has not moved: the next
    // note this wallet mints is still index 0 under LUD-25's derivation.
    expect(result.next).toEqual({bip32: 0, hmac: 1})
  })

  it('resumes each scheme from its own persisted counter', async () => {
    const notes = new Map<string, number>()
    notes.set(hashK1(cashAt(40)), 21_000)
    notes.set(hashK1(legacyAt(3)), 5_000)
    const seen: string[] = []

    const result = await restoreFromSeed(
      BASE,
      SEED,
      HOST,
      {start: {bip32: 40, hmac: 3}},
      {fetch: service(notes, seen)}
    )

    expect(
      result.found.map(note => [note.scheme, note.index])
    ).toEqual([
      ['bip32', 40],
      ['hmac', 3]
    ])
    expect(result.next).toEqual({bip32: 41, hmac: 4})
  })

  it('never hands back an index whose secret it disclosed', async () => {
    // A SERVICE that cannot answer by hash forces the fallback walk, which
    // puts every probed secret in a query string - including the ones past
    // the last note, which are exactly the indices the wallet would mint
    // into next. Both counters have to skip the whole disclosed window.
    const notes = new Map<string, number>()
    notes.set(hashK1(cashAt(0)), 21_000)
    const seen: string[] = []

    const result = await restoreFromSeed(
      BASE,
      SEED,
      HOST,
      {gap: 5, allowSecretDisclosure: true},
      {fetch: service(notes, seen, {answersByHash: false})}
    )

    expect(result.found.map(note => [note.scheme, note.index])).toEqual([
      ['bip32', 0]
    ])
    expect(result.disclosesSecrets).toBe(true)
    // bip32 walked 0..5, hmac walked 0..4, and every one of those secrets is
    // in a log now, whether or not a note was ever minted under it.
    expect(result.next).toEqual({bip32: 6, hmac: 5})
    for (const [scheme, next] of [
      ['bip32', result.next.bip32],
      ['hmac', result.next.hmac]
    ] as const) {
      const at = scheme === 'bip32' ? cashAt : legacyAt
      expect(seen).not.toContain(at(next))
    }
  })

  it('refuses to guess when the SERVICE never answered by hash', async () => {
    await expect(
      restoreFromSeed(
        BASE,
        SEED,
        HOST,
        {gap: 2},
        {fetch: service(new Map(), [], {answersByHash: false})}
      )
    ).rejects.toThrow(/never answered a lookup by hash/)
  })

  it('rejects a negative start for either scheme', async () => {
    await expect(
      restoreFromSeed(BASE, SEED, HOST, {start: {bip32: -1}})
    ).rejects.toThrow(RangeError)
    await expect(
      restoreFromSeed(BASE, SEED, HOST, {start: {hmac: -1}})
    ).rejects.toThrow(RangeError)
  })
})
