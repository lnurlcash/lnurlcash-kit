// Accepting a note as payment: the decision table a server makes on every
// request, and the rotate that is the settlement.
//
// The stub mint here is deliberately not the conformance mock: a server's
// decisions depend on states the mock cannot be told to hold at once (a
// signature from the wrong key over a note that is also under value), so
// the table drives a stub, and the section below it proves the same
// function against a real mint doing a real rotate.

import {afterEach, describe, expect, it} from 'vitest'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {
  AmbiguousMutationError,
  buildNoteUrl,
  hashK1,
  InsufficientValueError,
  isPreimage,
  NoteSpentError,
  noteK1,
  noteSignatureDigest,
  PendingNoteError,
  RequestRefusedError,
  newSecretsOf,
  ServiceRejectedError,
  settleNote,
  settleNoteForValue,
  verifyNoteSignature
} from '../src/index.js'

const require = createRequire(import.meta.url)
const loadIfPublished = (name: string): any | null => {
  try {
    return JSON.parse(
      readFileSync(require.resolve(`lnurlcash-conformance/vectors/${name}`), 'utf8')
    )
  } catch {
    return null
  }
}

// ---- a stub mint ----

const MINT_KEY = hexToBytes('22'.repeat(32))
const IMPOSTOR_KEY = hexToBytes('33'.repeat(32))
const MINT_PUBKEY = bytesToHex(secp256k1.getPublicKey(MINT_KEY, true))

const LIGHTNING_PREFIX = utf8ToBytes('Lightning Signed Message:')

// A mint signs over the note's ID, which is all it holds - so it can sign a
// rotate's output knowing only the h it was handed.
const digestForNoteId = (noteId: string, amountMsat: number): Uint8Array =>
  sha256(
    sha256(
      new Uint8Array([
        ...LIGHTNING_PREFIX,
        ...utf8ToBytes(`LNURLcash:${amountMsat}:${noteId}`)
      ])
    )
  )

const signDigest = (digest: Uint8Array, key = MINT_KEY): string => {
  // @noble emits recovery-id-leading; LUD-25 puts it last
  const lead = secp256k1.sign(digest, key, {format: 'recovered', prehash: false})
  return bytesToHex(new Uint8Array([...lead.subarray(1), lead[0]!]))
}

const signNote = (k1: string, amountMsat: number, key = MINT_KEY): string =>
  signDigest(noteSignatureDigest(k1, amountMsat), key)

type StubState = 'live' | 'spent' | 'pending'

type Stub = {
  fetch: typeof fetch
  seen: string[]
  rotated: boolean
}

const stubMint = ({
  host,
  amountMsat,
  state = 'live' as StubState,
  confirmRotate = true,
  rotateRefuses
}: {
  host: string
  amountMsat: number
  state?: StubState
  confirmRotate?: boolean
  // A rotate the SERVICE definitively refuses: it answered, and nothing was
  // burned. Distinct from confirmRotate:false, where the request landed and
  // the answer is what went missing.
  rotateRefuses?: string
}): Stub => {
  const stub: Stub = {seen: [], rotated: false, fetch: null as never}
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: {'content-type': 'application/json'}
    })
  stub.fetch = async input => {
    const url = new URL(input.toString())
    stub.seen.push(url.toString())
    if (url.pathname === '/w') {
      if (state === 'spent') return json({status: 'ERROR', reason: 'Note already spent.'})
      if (state === 'pending') return json({status: 'ERROR', reason: 'pending'})
      return json({
        tag: 'withdrawRequest',
        callback: `${url.protocol}//${host}/w/cb`,
        k1: url.searchParams.get('k1'),
        minWithdrawable: 0,
        maxWithdrawable: amountMsat,
        mintPubkey: MINT_PUBKEY
      })
    }
    if (url.pathname === '/w/cb') {
      if (rotateRefuses) return json({status: 'ERROR', reason: rotateRefuses})
      stub.rotated = true
      const h = url.searchParams.get('h')!
      // a mutation the caller cannot confirm, though it landed all the same
      if (!confirmRotate) return json({acknowledged: true})
      return json({status: 'OK', sig: signDigest(digestForNoteId(h, amountMsat))})
    }
    return json({status: 'ERROR', reason: 'Unknown note.'})
  }
  return stub
}

const K1 = 'ab'.repeat(32)

const noteAt = (
  host: string,
  {k1 = K1, claimedMsat, sig}: {k1?: string; claimedMsat?: number; sig?: string} = {}
): string => {
  const url = new URL(buildNoteUrl(`https://${host}/w`, k1, claimedMsat))
  if (sig) url.searchParams.set('sig', sig)
  return url.toString()
}

describe('settleNoteForValue', () => {
  it('settles a note that clears every check', async () => {
    const stub = stubMint({host: 'mint.example', amountMsat: 21_000})
    const {note, newUrl} = await settleNoteForValue(
      noteAt('mint.example'),
      {mints: ['mint.example'], minMsat: 21_000},
      {fetch: stub.fetch}
    )
    // the replacement secret was generated here and never sent
    expect(isPreimage(note.k1)).toBe(true)
    expect(note.k1).not.toBe(K1)
    expect(stub.seen.some(u => u.includes(note.k1))).toBe(false)
    expect(stub.seen.some(u => u.includes(hashK1(note.k1)))).toBe(true)
    // the value is the mint's, and the new URL is a note in its own right
    expect(note.amountMsat).toBe(21_000)
    expect(noteK1(newUrl)).toBe(note.k1)
    expect(new URL(newUrl).searchParams.get('amount')).toBe('21000')
    expect(
      verifyNoteSignature(note.k1, 21_000, note.signature!, MINT_PUBKEY)
    ).toBe(true)
  })

  it('accepts overpayment, and reports what the note was really worth', async () => {
    const stub = stubMint({host: 'mint.example', amountMsat: 100_000})
    const {note} = await settleNoteForValue(
      noteAt('mint.example'),
      {mints: ['mint.example'], minMsat: 21_000},
      {fetch: stub.fetch}
    )
    expect(note.amountMsat).toBe(100_000)
  })

  it('refuses a mint it does not accept, without contacting anyone', async () => {
    const stub = stubMint({host: 'elsewhere.example', amountMsat: 21_000})
    await expect(
      settleNoteForValue(
        noteAt('elsewhere.example'),
        {mints: ['mint.example'], minMsat: 1000},
        {fetch: stub.fetch}
      )
    ).rejects.toBeInstanceOf(ServiceRejectedError)
    // a note from an unaccepted mint is not worth a round trip, and the
    // refusal leaks nothing to a mint this server has no relationship with
    expect(stub.seen).toEqual([])
  })

  it('accepts nothing when the accepted list is empty', async () => {
    const stub = stubMint({host: 'mint.example', amountMsat: 21_000})
    await expect(
      settleNoteForValue(
        noteAt('mint.example'),
        {mints: [], minMsat: 1000},
        {fetch: stub.fetch}
      )
    ).rejects.toBeInstanceOf(ServiceRejectedError)
    expect(stub.rotated).toBe(false)
  })

  it('normalises the accepted mints', async () => {
    for (const accepted of [
      'mint.example',
      '@mint.example',
      'MINT.EXAMPLE',
      'https://mint.example/.well-known/lnurlw/mint',
      ' mint.example '
    ]) {
      const stub = stubMint({host: 'mint.example', amountMsat: 21_000})
      const {note} = await settleNoteForValue(
        noteAt('mint.example'),
        {mints: [accepted], minMsat: 1000},
        {fetch: stub.fetch}
      )
      expect(note.amountMsat).toBe(21_000)
    }
  })

  it('refuses a note worth less than the price, and leaves it alone', async () => {
    const stub = stubMint({host: 'mint.example', amountMsat: 20_999})
    const err = await settleNoteForValue(
      noteAt('mint.example'),
      {mints: ['mint.example'], minMsat: 21_000},
      {fetch: stub.fetch}
    ).catch(e => e)
    expect(err).toBeInstanceOf(InsufficientValueError)
    expect(err.amountMsat).toBe(20_999)
    expect(err.minMsat).toBe(21_000)
    // nothing was burned: the note is still the payer's
    expect(stub.rotated).toBe(false)
  })

  it('judges the value the mint states, not the one the URL claims', async () => {
    const stub = stubMint({host: 'mint.example', amountMsat: 1000})
    // the URL claims a hundred times what the mint says it is worth
    await expect(
      settleNoteForValue(
        noteAt('mint.example', {claimedMsat: 100_000}),
        {mints: ['mint.example'], minMsat: 21_000},
        {fetch: stub.fetch}
      )
    ).rejects.toBeInstanceOf(InsufficientValueError)
    expect(stub.rotated).toBe(false)
  })

  it('passes a spent note straight through as spent', async () => {
    const stub = stubMint({host: 'mint.example', amountMsat: 21_000, state: 'spent'})
    await expect(
      settleNoteForValue(
        noteAt('mint.example'),
        {mints: ['mint.example'], minMsat: 1000},
        {fetch: stub.fetch}
      )
    ).rejects.toBeInstanceOf(NoteSpentError)
  })

  it('reports a note with a melt in flight as pending, not as spent', async () => {
    const stub = stubMint({host: 'mint.example', amountMsat: 21_000, state: 'pending'})
    const err = await settleNoteForValue(
      noteAt('mint.example'),
      {mints: ['mint.example'], minMsat: 1000},
      {fetch: stub.fetch}
    ).catch(e => e)
    expect(err).toBeInstanceOf(PendingNoteError)
    // a server that locked this as spent would be refusing money that is
    // about to come back
    expect(err).not.toBeInstanceOf(NoteSpentError)
  })

  it('refuses input that is not a note at all', async () => {
    for (const input of ['not a note', 'https://mint.example/w', '']) {
      await expect(
        settleNoteForValue(input, {mints: ['mint.example'], minMsat: 1000})
      ).rejects.toBeInstanceOf(RequestRefusedError)
    }
  })

  it('surfaces an unconfirmed rotate with the secret it minted', async () => {
    const stub = stubMint({
      host: 'mint.example',
      amountMsat: 21_000,
      confirmRotate: false
    })
    const err = await settleNoteForValue(
      noteAt('mint.example'),
      {mints: ['mint.example'], minMsat: 1000},
      {fetch: stub.fetch}
    ).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMutationError)
    // the rotate may well have landed, in which case this secret is the
    // only copy of the money and it now belongs to this server
    expect(err.newSecrets).toHaveLength(1)
    expect(isPreimage(err.newSecrets[0])).toBe(true)
  })

  describe('when a signature is required', () => {
    const terms = {mints: ['mint.example'], minMsat: 1000, requireSignature: true}

    it('accepts a note the mint really signed', async () => {
      const stub = stubMint({host: 'mint.example', amountMsat: 21_000})
      const {note} = await settleNoteForValue(
        noteAt('mint.example', {sig: signNote(K1, 21_000)}),
        terms,
        {fetch: stub.fetch}
      )
      expect(note.amountMsat).toBe(21_000)
    })

    it('refuses a note carrying no signature', async () => {
      const stub = stubMint({host: 'mint.example', amountMsat: 21_000})
      await expect(
        settleNoteForValue(noteAt('mint.example'), terms, {fetch: stub.fetch})
      ).rejects.toBeInstanceOf(ServiceRejectedError)
      expect(stub.rotated).toBe(false)
    })

    it('refuses a signature from somebody other than the mint', async () => {
      const stub = stubMint({host: 'mint.example', amountMsat: 21_000})
      await expect(
        settleNoteForValue(
          noteAt('mint.example', {sig: signNote(K1, 21_000, IMPOSTOR_KEY)}),
          terms,
          {fetch: stub.fetch}
        )
      ).rejects.toBeInstanceOf(ServiceRejectedError)
      expect(stub.rotated).toBe(false)
    })

    it('refuses a signature over an amount the mint did not state', async () => {
      const stub = stubMint({host: 'mint.example', amountMsat: 21_000})
      // signed for a hundred times the value, and the URL claims as much
      await expect(
        settleNoteForValue(
          noteAt('mint.example', {
            claimedMsat: 2_100_000,
            sig: signNote(K1, 2_100_000)
          }),
          terms,
          {fetch: stub.fetch}
        )
      ).rejects.toBeInstanceOf(ServiceRejectedError)
      expect(stub.rotated).toBe(false)
    })

    it('ignores a broken signature when none was demanded', async () => {
      const stub = stubMint({host: 'mint.example', amountMsat: 21_000})
      const {note} = await settleNoteForValue(
        noteAt('mint.example', {sig: signNote(K1, 21_000, IMPOSTOR_KEY)}),
        {mints: ['mint.example'], minMsat: 1000},
        {fetch: stub.fetch}
      )
      // the informational GET is authoritative either way
      expect(note.amountMsat).toBe(21_000)
    })
  })
})

// ---- against a real mint ----

type Mint = Awaited<ReturnType<typeof createMockMint>>
const mints: Mint[] = []
afterEach(async () => {
  await Promise.all(mints.splice(0).map(m => m.close()))
})
const mint = async (options: Record<string, unknown> = {}): Promise<Mint> => {
  const m = await createMockMint(options)
  mints.push(m)
  return m
}

describe('settleNoteForValue against a mint', () => {
  it('takes ownership, and the same note cannot pay twice', async () => {
    const m = await mint()
    const host = new URL(m.url).host
    const k1 = 'cd'.repeat(32)
    const sig = m.state.creditNote(k1, 55_000)
    const offered = `${buildNoteUrl(`${m.url}/w`, k1, 55_000)}&sig=${sig}`

    const {note, newUrl} = await settleNoteForValue(offered, {
      mints: [host],
      minMsat: 55_000,
      requireSignature: true
    })
    expect(note.amountMsat).toBe(55_000)
    expect(m.state.noteState(k1)).toBe('burned')
    expect(m.state.noteState(note.k1)).toBe('outstanding')
    expect(verifyNoteSignature(note.k1, 55_000, note.signature!, m.state.pubkey)).toBe(
      true
    )
    expect(noteK1(newUrl)).toBe(note.k1)

    // the replay: the payer still holds the secret they presented, and the
    // rotate is what makes it worthless to them
    await expect(
      settleNoteForValue(offered, {mints: [host], minMsat: 55_000})
    ).rejects.toBeInstanceOf(NoteSpentError)
  })

  it('settles the note the mint minted, not the one the URL describes', async () => {
    const m = await mint()
    const host = new URL(m.url).host
    const k1 = 'ef'.repeat(32)
    m.state.creditNote(k1, 21_000)
    const {note} = await settleNoteForValue(
      buildNoteUrl(`${m.url}/w`, k1, 999_999_999),
      {mints: [host], minMsat: 21_000}
    )
    expect(note.amountMsat).toBe(21_000)
  })

  it('leaves a note it refuses spendable by its owner', async () => {
    const m = await mint()
    const host = new URL(m.url).host
    const k1 = '12'.repeat(32)
    m.state.creditNote(k1, 21_000)
    await expect(
      settleNoteForValue(buildNoteUrl(`${m.url}/w`, k1), {
        mints: [host],
        minMsat: 100_000
      })
    ).rejects.toBeInstanceOf(InsufficientValueError)
    expect(m.state.noteState(k1)).toBe('outstanding')
  })

  it('refuses a note from a mint the server does not accept', async () => {
    const m = await mint()
    const k1 = '34'.repeat(32)
    m.state.creditNote(k1, 21_000)
    await expect(
      settleNoteForValue(buildNoteUrl(`${m.url}/w`, k1), {
        mints: ['mint.example'],
        minMsat: 1000
      })
    ).rejects.toBeInstanceOf(ServiceRejectedError)
    expect(m.state.noteState(k1)).toBe('outstanding')
  })
})

// ---- the conformance decision table ----
//
// Bound here rather than in vectors.test.ts because a case needs a mint
// holding a stated value in a stated state with a stated signature, which is
// the stub above. Skips itself until the vectors are published, so the two
// repos can ship in either order.

const table = loadIfPublished('settle-for-value.json')

describe.skipIf(!table)('settle-for-value vectors', () => {
  for (const c of table?.cases ?? []) {
    it(`${c.outcome}: ${c.name}`, async () => {
      const state: StubState =
        c.noteState === 'spent' ? 'spent' : c.noteState === 'pending' ? 'pending' : 'live'
      const stub = stubMint({
        host: c.noteHost,
        amountMsat: c.maxWithdrawableMsat,
        state
      })
      const sig = c.hasSig
        ? signNote(K1, c.maxWithdrawableMsat, c.sigValid ? MINT_KEY : IMPOSTOR_KEY)
        : undefined
      const attempt = settleNoteForValue(
        noteAt(c.noteHost, {sig}),
        {
          mints: c.acceptedMints,
          minMsat: c.minMsat,
          requireSignature: c.requireSignature
        },
        {fetch: stub.fetch}
      )
      if (c.outcome === 'accept') {
        const {note} = await attempt
        expect(note.amountMsat).toBe(c.maxWithdrawableMsat)
        return
      }
      const err = await attempt.then(() => null).catch(e => e)
      expect(err).not.toBeNull()
      const expected = {
        'wrong-host': ServiceRejectedError,
        insufficient: InsufficientValueError,
        'bad-signature': ServiceRejectedError,
        'missing-signature': ServiceRejectedError,
        spent: NoteSpentError,
        pending: PendingNoteError
      }[c.outcome as string]
      expect(err).toBeInstanceOf(expected)
      // nothing a server refuses may have been burned on the way
      expect(stub.rotated).toBe(false)
    })
  }
})

// settleNote's rotate is best-effort by design: a SERVICE that refuses it
// keeps the exposed k1 rather than failing the whole operation. What that
// must never cover is a rotate that MAY HAVE LANDED. Both used to return the
// old k1, shaped identically to a success -- and when the request had landed,
// that k1 was burned and the fresh secret riding the error was the only copy
// of the note the SERVICE had just minted.
describe('settleNote when the rotate does not succeed', () => {
  it('surfaces an unconfirmable rotate rather than returning the burned k1', async () => {
    const stub = stubMint({
      host: 'mint.example',
      amountMsat: 21_000,
      confirmRotate: false
    })
    const outcome = await settleNote(noteAt('mint.example'), K1, 0, undefined, {
      fetch: stub.fetch
    }).then(
      settled => settled,
      err => err
    )

    // the request did land, so this must not come back looking settled
    expect(stub.rotated).toBe(true)
    expect(outcome).toBeInstanceOf(AmbiguousMutationError)

    // and the fresh secret has to survive: it is the only copy of the note
    const {newSecrets} = outcome as AmbiguousMutationError
    expect(newSecrets).toHaveLength(1)
    expect(isPreimage(newSecrets[0]!)).toBe(true)
    expect(newSecrets[0]).not.toBe(K1)
  })

  it('still keeps the exposed k1 when the SERVICE definitively refuses', async () => {
    const stub = stubMint({
      host: 'mint.example',
      amountMsat: 21_000,
      rotateRefuses: 'rotate not supported'
    })
    const settled = await settleNote(noteAt('mint.example'), K1, 0, undefined, {
      fetch: stub.fetch
    })
    // the SERVICE answered and burned nothing, so the note is still the note
    expect(stub.rotated).toBe(false)
    expect(settled.k1).toBe(K1)
    expect(settled.amountMsat).toBe(21_000)
  })

  it('does not report a bug in this library as a settled note', async () => {
    const stub = stubMint({host: 'mint.example', amountMsat: 21_000})
    await expect(
      settleNote(noteAt('mint.example'), K1, 0, undefined, {
        fetch: stub.fetch,
        randomSecret: () => {
          throw new TypeError('not a protocol failure')
        }
      })
    ).rejects.toThrow(TypeError)
  })

  it('surfaces a spent-or-unknown refusal, which can describe a rotate that already applied', async () => {
    // A retried mutation the SERVICE already performed looks exactly like
    // this from the wire, so the fresh secret still matters (see the note on
    // NoteSpentError). Swallowing it returned the burned k1 as settled.
    const stub = stubMint({
      host: 'mint.example',
      amountMsat: 21_000,
      rotateRefuses: 'Invalid or already spent k1.'
    })
    const outcome = await settleNote(noteAt('mint.example'), K1, 0, undefined, {
      fetch: stub.fetch
    }).then(
      settled => settled,
      err => err
    )
    expect(outcome).toBeInstanceOf(NoteSpentError)
    expect(newSecretsOf(outcome)).toHaveLength(1)
    expect(newSecretsOf(outcome)[0]).not.toBe(K1)
  })
})
