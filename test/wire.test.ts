// The vectors describe what goes on the wire and what comes back. This
// suite holds the library to both, with no real network involved: a stub
// fetch stands in for the SERVICE, so a case can be exactly as hostile as
// the vector says it is.

import {describe, expect, it} from 'vitest'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {
  AmbiguousMintError,
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  ProtocolError,
  RequestRefusedError,
  ServiceRejectedError,
  UnverifiableNoteError,
  fetchInvoiceVerification,
  fetchMintAddress,
  fetchNoteInfo,
  fetchPayRequest,
  meltNote,
  mergeBatches,
  mergeNotes,
  mergeNotesWithHash,
  requestInvoice,
  requireBoundMintQuote,
  rotateNote,
  rotateNoteWithHash,
  splitNote,
  splitNoteWithHash,
  validateBoundMintReceipt
} from '../src/index.js'

const require = createRequire(import.meta.url)
const load = (name: string): any =>
  JSON.parse(
    readFileSync(require.resolve(`lnurlcash-conformance/vectors/${name}`), 'utf8')
  )

const jsonFetch = (body: unknown, status = 200): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: {'content-type': 'application/json'}
    })

const rawFetch = (body: string, status = 200): typeof fetch =>
  async () => new Response(body, {status})

// A conforming mutation answer. Both signatures are present because the
// same stub answers a split, and LUD-25 requires one over each output; a
// bare {"status":"OK"} is the unverifiable case, which has its own tests.
const MUTATION_OK = {status: 'OK', sig: 'ab'.repeat(65), sig2: 'cd'.repeat(65)}

const capturingFetch = (seen: string[]): typeof fetch => async input => {
  seen.push(input.toString())
  return new Response(JSON.stringify(MUTATION_OK), {
    headers: {'content-type': 'application/json'}
  })
}

const params = (url: string): [string, string][] =>
  [...new URL(url).searchParams.entries()].sort()

describe('callback request vectors', () => {
  const vectors = load('callbacks.json')

  for (const c of vectors.cases) {
    it(`builds the request for: ${c.name}`, async () => {
      const seen: string[] = []
      const opts = {fetch: capturingFetch(seen)}
      const p = c.params

      if (c.op === 'melt') {
        await meltNote(c.callback, p.k1[0], p.pr, opts)
      } else if (c.op === 'rotate') {
        await rotateNoteWithHash(c.callback, p.k1[0], p.h, opts)
      } else if (c.op === 'split') {
        await splitNoteWithHash(c.callback, p.k1, p.amountMsat, p.h, p.h2, opts)
      } else if (c.op === 'merge') {
        await mergeNotesWithHash(c.callback, p.k1, p.h, opts)
      }

      expect(seen).toHaveLength(1)
      expect(params(seen[0]!)).toEqual(
        [...c.expectQuery].sort((a: string[], b: string[]) =>
          a[0]! === b[0]! ? a[1]!.localeCompare(b[1]!) : a[0]!.localeCompare(b[0]!)
        )
      )
    })
  }

  // The replay rule is matched on the k1 set, h, h2 and amount, so a retry
  // is only a retry if it repeats them exactly. Regenerating a secret
  // between attempts would make the second request a DIFFERENT mutation,
  // and against a mint that had already applied the first it would be a
  // second real burn - the one outcome retrying must never produce.
  it('re-sends a mutation byte for byte, never a fresh one', async () => {
    const seen: string[] = []
    let attempts = 0
    await rotateNote('https://mint.example/w/cb', 'a'.repeat(64), {
      fetch: async input => {
        seen.push(input.toString())
        if (++attempts === 1) throw new TypeError('connection reset')
        return new Response(JSON.stringify(MUTATION_OK), {
          headers: {'content-type': 'application/json'}
        })
      }
    })
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe(seen[0])
  })

  // A melt is the one mutation the replay rule does not cover: it carries
  // `pr`, it is paid out asynchronously after the OK, and a SERVICE has
  // made no promise about what a second identical request means. Re-sending
  // one could ask for a second payment, so it is never retried whatever
  // mutationRetries says.
  it('never re-sends a melt', async () => {
    const seen: string[] = []
    const err = await meltNote(
      'https://mint.example/w/cb',
      'a'.repeat(64),
      'lnbc210n1pjq',
      {
        fetch: async input => {
          seen.push(input.toString())
          throw new TypeError('connection reset')
        },
        mutationRetries: 5
      }
    ).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMintError)
    expect(seen).toHaveLength(1)
  })

  // The retry is for lost answers, not for answers the caller dislikes. A
  // SERVICE that has considered the request and refused it will refuse it
  // again, and asking repeatedly is just noise on somebody's mint.
  it('never re-sends a mutation the service definitively refused', async () => {
    const seen: string[] = []
    const err = await rotateNote('https://mint.example/w/cb', 'a'.repeat(64), {
      fetch: async input => {
        seen.push(input.toString())
        return new Response(
          JSON.stringify({status: 'ERROR', reason: 'Note already spent.'}),
          {headers: {'content-type': 'application/json'}}
        )
      },
      mutationRetries: 5
    }).catch(e => e)
    expect(err).toBeInstanceOf(NoteSpentError)
    expect(seen).toHaveLength(1)
  })

  // The remaining rejected vectors - a melt with several k1, a melt with an
  // amount, a rotate with no h, a split with no h2 - are not expressible
  // through this library at all: meltNote takes exactly one k1 and no
  // amount, and the hash arguments are required parameters. The one case
  // that IS expressible is an empty note list, so it gets a real assertion.
  it('refuses a mutation naming no note', async () => {
    const seen: string[] = []
    const opts = {fetch: capturingFetch(seen)}
    await expect(
      mergeNotes('https://mint.example/w/cb', [], opts)
    ).rejects.toBeInstanceOf(RequestRefusedError)
    await expect(
      splitNote('https://mint.example/w/cb', [], 1000, opts)
    ).rejects.toBeInstanceOf(RequestRefusedError)
    expect(seen).toHaveLength(0)
  })

  // URL length is not the only bound. No LUD-25 field advertises a mint's
  // own k1 cap, and the caps in the wild are tighter than 2000 characters
  // allows: moneyer defaults to 21, lnurl-mint to 100. Batching by URL
  // alone builds a 28-note request that a moneyer refuses outright, so the
  // count is bounded too - and a caller who knows the mint's real cap can
  // say so.
  it('bounds a batch by note count as well as URL length', async () => {
    const cb = 'https://mint.example/w/cb'
    const k1s = Array.from({length: 60}, (_, i) => i.toString(16).padStart(64, '0'))
    for (const batch of mergeBatches(cb, k1s)) {
      expect(batch.length).toBeLessThanOrEqual(20)
    }
    // and a caller that knows better can narrow it further
    for (const batch of mergeBatches(cb, k1s, {maxNotes: 5})) {
      expect(batch.length).toBeLessThanOrEqual(5)
    }
    expect(mergeBatches(cb, k1s, {maxNotes: 5}).flat()).toEqual(k1s)
  })

  // A merge of 2+ notes plans its batches before the request layer is ever
  // reached, and that planning parses the callback URL. It must not be the
  // one place a caller sees a raw TypeError instead of this library's own
  // error taxonomy.
  it('refuses an invalid callback the same way whatever the note count', async () => {
    const opts = {fetch: (() => { throw new Error('must not be called') }) as unknown as typeof fetch}
    await expect(mergeNotes('not a valid url', ['a'.repeat(64)], opts)).rejects.toBeInstanceOf(
      RequestRefusedError
    )
    await expect(
      mergeNotes('not a valid url', ['a'.repeat(64), 'b'.repeat(64)], opts)
    ).rejects.toBeInstanceOf(RequestRefusedError)
  })
})

describe('bound mint settlement receipts', () => {
  const signatures = load('signature.json')
  const signed = signatures.cases.find((c: any) => c.valid && c.amountMsat === 21000)
  const pr = 'lnbc210n1pjqrstuvwxyz'

  it('maps the additive wire fields and validates the settled receipt', async () => {
    const quote = await requestInvoice('https://mint.example/p/cb', 21000, {
      h: signed.noteId,
      fetch: jsonFetch({
        pr,
        verify: 'https://mint.example/verify/ab',
        mintToHash: true,
        mint: {h: signed.noteId.toUpperCase(), amount: 21000}
      })
    })
    expect(requireBoundMintQuote(quote, signed.noteId, 21000)).toEqual({
      h: signed.noteId,
      amountMsat: 21000
    })

    const verification = await fetchInvoiceVerification('https://mint.example/verify/ab', {
      fetch: jsonFetch({
        status: 'OK',
        settled: true,
        preimage: '06'.repeat(32),
        pr,
        mint: {h: signed.noteId, amount: 21000, sig: signed.signature}
      })
    })
    expect(
      validateBoundMintReceipt(quote, verification, signed.noteId, 21000, signed.mintPubkey)
    ).toEqual({
      h: signed.noteId,
      amountMsat: 21000,
      signature: signed.signature,
      pubkey: signed.mintPubkey
    })
  })

  it('refuses a receipt that changes the quote commitment', async () => {
    const quote = await requestInvoice('https://mint.example/p/cb', 21000, {
      h: signed.noteId,
      fetch: jsonFetch({
        pr,
        verify: 'https://mint.example/verify/ab',
        mintToHash: true,
        mint: {h: signed.noteId, amount: 21000}
      })
    })
    const verification = await fetchInvoiceVerification('https://mint.example/verify/ab', {
      fetch: jsonFetch({
        settled: true,
        preimage: '06'.repeat(32),
        pr,
        mint: {h: signed.noteId, amount: 20999, sig: signed.signature}
      })
    })
    expect(() =>
      validateBoundMintReceipt(quote, verification, signed.noteId, 21000, signed.mintPubkey)
    ).toThrow(ProtocolError)
  })

  it('refuses a quote for a different net amount before payment', async () => {
    const quote = await requestInvoice('https://mint.example/p/cb', 21000, {
      h: signed.noteId,
      fetch: jsonFetch({
        pr,
        verify: 'https://mint.example/verify/ab',
        mintToHash: true,
        mint: {h: signed.noteId, amount: 20999}
      })
    })
    expect(() => requireBoundMintQuote(quote, signed.noteId, 21000)).toThrow(
      'different mint amount'
    )
  })

  it('refuses a pre-settlement signature on the quote', async () => {
    const quote = await requestInvoice('https://mint.example/p/cb', 21000, {
      h: signed.noteId,
      fetch: jsonFetch({
        pr,
        mintToHash: true,
        mint: {h: signed.noteId, amount: 21000, sig: signed.signature}
      })
    })
    expect(() => requireBoundMintQuote(quote, signed.noteId, 21000)).toThrow(ProtocolError)
  })
})

describe('response classification vectors', () => {
  const vectors = load('responses.json')
  const K1 = 'a'.repeat(64)
  const H = 'b'.repeat(64)
  const CB = 'https://mint.example/w/cb'

  // The vectors say which call each case is driven through, and it matters:
  // a melt mints nothing, so it has no signature to return and none is
  // required, while a rotate answering without one is its own outcome.
  // Retries are off so one case is one request - the replay behaviour has
  // its own tests.
  const call = (c: any, fetch: typeof globalThis.fetch) => {
    const opts = {fetch, mutationRetries: 0}
    if (c.op === 'melt') return meltNote(CB, K1, 'lnbc210n1pjq', opts)
    if (c.op === 'split') {
      return splitNoteWithHash(CB, [K1], 5000, H, 'c'.repeat(64), opts)
    }
    return rotateNoteWithHash(CB, K1, H, opts)
  }

  const drive = (c: any) => {
    if (c.transportError) {
      return call(c, async () => {
        throw new TypeError('network error')
      })
    }
    if (c.timeout) {
      return call(c, async () => {
        const err = new Error('timed out')
        err.name = 'TimeoutError'
        throw err
      })
    }
    return call(
      c,
      c.bodyRaw !== undefined
        ? rawFetch(c.bodyRaw, c.http)
        : jsonFetch(c.body, c.http)
    )
  }

  for (const c of vectors.cases) {
    it(`classifies as ${c.expect}: ${c.name}`, async () => {
      if (c.expect === 'ok') {
        const result: any = await drive(c)
        if (c.signature) expect(result.signature).toBe(c.signature)
        if (c.changeSignature) {
          expect(result.changeSignature).toBe(c.changeSignature)
        }
        return
      }
      const err = await drive(c).catch(e => e)
      // A landed mutation nobody can verify. Its own class, because the
      // note exists: treating it as a refusal is how the secret gets
      // thrown away.
      if (c.expect === 'unverifiable') {
        expect(err).toBeInstanceOf(UnverifiableNoteError)
        return
      }
      if (c.expect === 'pending') expect(err).toBeInstanceOf(PendingNoteError)
      else if (c.expect === 'spent') expect(err).toBeInstanceOf(NoteSpentError)
      else if (c.expect === 'unknown') expect(err).toBeInstanceOf(NoteUnknownError)
      else if (c.expect === 'ambiguous') expect(err).toBeInstanceOf(AmbiguousMintError)
      else if (c.expect === 'error') {
        expect(err).toBeInstanceOf(ServiceRejectedError)
        // a definitive refusal for some other reason must not be mistaken
        // for one of the note-specific outcomes a holder acts on
        expect(err).not.toBeInstanceOf(PendingNoteError)
        expect(err).not.toBeInstanceOf(NoteSpentError)
        expect(err).not.toBeInstanceOf(NoteUnknownError)
      }
    })
  }

  it('returns both signatures from a split', async () => {
    const c = vectors.cases.find((v: any) => v.body?.sig2)
    const result = await splitNoteWithHash(
      CB,
      [K1],
      5000,
      H,
      'c'.repeat(64),
      {fetch: jsonFetch(c.body)}
    )
    expect(result.signature).toBe(c.signature)
    expect(result.changeSignature).toBe(c.changeSignature)
  })

  it('returns a melt proof when the service offers one', async () => {
    const c = vectors.cases.find((v: any) => v.body?.verify && v.body?.pr)
    const result = await meltNote(CB, K1, 'lnbc210n1pjq', {
      fetch: jsonFetch(c.body)
    })
    expect(result.verify).toBe(c.body.verify)
    expect(result.pr).toBe(c.body.pr)
  })
})

describe('withdrawRequest response vectors', () => {
  const vectors = load('withdraw-info.json')

  for (const c of vectors.accepted) {
    it(`accepts: ${c.name}`, async () => {
      const info = await fetchNoteInfo(vectors.queriedUrl, {
        fetch: jsonFetch(c.body)
      })
      expect(info.maxWithdrawable).toBe(c.maxWithdrawable)
    })
  }

  for (const c of vectors.rejected) {
    it(`rejects: ${c.name}`, async () => {
      await expect(
        fetchNoteInfo(vectors.queriedUrl, {fetch: jsonFetch(c.body)})
      ).rejects.toBeInstanceOf(ProtocolError)
    })
  }

  it('never puts the signature on the wire', async () => {
    const seen: string[] = []
    await fetchNoteInfo(vectors.queriedUrl, {
      fetch: async input => {
        seen.push(input.toString())
        return new Response(JSON.stringify(vectors.accepted[0].body), {
          headers: {'content-type': 'application/json'}
        })
      }
    })
    for (const field of vectors.requestMustNotSend) {
      expect(seen[0]).not.toContain(`${field}=`)
    }
    for (const field of vectors.requestMustSendUnchanged) {
      expect(seen[0]).toContain(`${field}=`)
    }
  })
})

describe('payRequest vectors', () => {
  const vectors = load('pay-request.json')

  for (const c of vectors.accepted) {
    it(`accepts: ${c.name}`, async () => {
      const pay = await fetchPayRequest('https://mint.example/.well-known/lnurlp/mint', {
        fetch: jsonFetch(c.body)
      })
      expect(pay.withdrawLink ?? null).toBe(c.withdrawLink)
      expect(pay.mintFee ?? null).toEqual(c.mintFee)
    })
  }

  for (const c of vectors.rejected) {
    it(`rejects: ${c.name}`, async () => {
      await expect(
        fetchPayRequest('https://mint.example/.well-known/lnurlp/mint', {
          fetch: jsonFetch(c.body)
        })
      ).rejects.toBeInstanceOf(ProtocolError)
    })
  }

  for (const c of vectors.invoice.accepted) {
    it(`accepts an invoice: ${c.name}`, async () => {
      const result = await requestInvoice('https://mint.example/p/cb', c.requestedMsat, {
        fetch: jsonFetch(c.body)
      })
      expect(result.pr).toBe(c.body.pr)
      expect(result.disposable).toBe(c.disposable)
      expect(result.verify ?? null).toBe(c.verify ?? null)
    })
  }

  for (const c of vectors.invoice.rejected) {
    it(`rejects an invoice: ${c.name}`, async () => {
      await expect(
        requestInvoice('https://mint.example/p/cb', c.requestedMsat, {
          fetch: jsonFetch(c.body)
        })
      ).rejects.toBeInstanceOf(ProtocolError)
    })
  }

  for (const c of vectors.verify.accepted) {
    it(`accepts a verify response: ${c.name}`, async () => {
      const result = await fetchInvoiceVerification('https://mint.example/verify/ab', {
        fetch: jsonFetch(c.body)
      })
      expect(result.settled).toBe(c.settled)
      expect(result.preimage).toBe(c.preimage)
    })
  }

  for (const c of vectors.verify.rejected) {
    it(`rejects a verify response: ${c.name}`, async () => {
      await expect(
        fetchInvoiceVerification('https://mint.example/verify/ab', {
          fetch: jsonFetch(c.body)
        })
      ).rejects.toBeInstanceOf(ProtocolError)
    })
  }
})


describe('transport discipline', () => {
  const K1 = 'a'.repeat(64)
  const H = 'b'.repeat(64)
  const CB = 'https://mint.example/w/cb'
  const OK = JSON.stringify(MUTATION_OK)
  // These cases are about which URLs the library will follow, and the count
  // of requests is the assertion. Retrying a mutation is a separate
  // behaviour with its own tests, and leaving it on here would make every
  // count a statement about both.
  const noRetry = {mutationRetries: 0}

  // First request 302s to `target`; anything reached afterwards answers OK.
  const redirectFetch = (target: string, seen: string[]): typeof fetch =>
    async input => {
      seen.push(input.toString())
      if (seen.length === 1) {
        return new Response(null, {status: 302, headers: {location: target}})
      }
      return new Response(OK, {headers: {'content-type': 'application/json'}})
    }

  it('follows a redirect that stays on an allowed URL', async () => {
    const seen: string[] = []
    await rotateNoteWithHash(CB, K1, H, {
      fetch: redirectFetch('https://mint2.example/w/cb', seen)
    })
    expect(seen).toHaveLength(2)
    expect(seen[1]).toContain('mint2.example')
  })

  it('resolves a relative redirect against the URL that issued it', async () => {
    const seen: string[] = []
    await rotateNoteWithHash(CB, K1, H, {fetch: redirectFetch('/w/cb2', seen)})
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe('https://mint.example/w/cb2')
  })

  it('refuses to follow a redirect onto cleartext', async () => {
    const seen: string[] = []
    const err = await rotateNoteWithHash(CB, K1, H, {
      fetch: redirectFetch('http://mint2.example/w/cb', seen),
      ...noRetry
    }).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMintError)
    expect(seen).toHaveLength(1)
  })

  it('refuses to follow a redirect to a non-http scheme', async () => {
    const seen: string[] = []
    const err = await rotateNoteWithHash(CB, K1, H, {
      fetch: redirectFetch('data:application/json,{"status":"OK"}', seen),
      ...noRetry
    }).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMintError)
    expect(seen).toHaveLength(1)
  })

  it('gives up on a redirect loop', async () => {
    const seen: string[] = []
    const err = await rotateNoteWithHash(CB, K1, H, {
      fetch: async input => {
        seen.push(input.toString())
        return new Response(null, {
          status: 302,
          headers: {location: 'https://mint.example/loop'}
        })
      },
      ...noRetry
    }).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMintError)
    expect(seen.length).toBeLessThanOrEqual(7)
  })

  it('refuses a body that declares itself oversized', async () => {
    const err = await rotateNoteWithHash(CB, K1, H, {
      fetch: async () =>
        new Response(OK, {
          headers: {'content-type': 'application/json', 'content-length': '99999999'}
        })
    }).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMintError)
    expect(err.message).toContain('oversized')
  })

  it('refuses a body that streams past the cap', async () => {
    const err = await rotateNoteWithHash(CB, K1, H, {
      fetch: async () =>
        new Response(' '.repeat(1_100_000), {
          headers: {'content-type': 'application/json'}
        })
    }).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMintError)
    expect(err.message).toContain('oversized')
  })

  it('rejects a non-integer maxWithdrawable', async () => {
    await expect(
      fetchNoteInfo(`https://mint.example/w?k1=${K1}`, {
        fetch: jsonFetch({
          tag: 'withdrawRequest',
          callback: CB,
          k1: K1,
          minWithdrawable: 0,
          maxWithdrawable: 1000.5
        })
      })
    ).rejects.toBeInstanceOf(ProtocolError)
  })
})

describe('the default fetch and browser method semantics', () => {
  it('never calls the global fetch detached - a browser would throw Illegal invocation', async () => {
    // A stand-in for window.fetch: a method that, like every DOM method,
    // demands its receiver. Node and DOM test environments do not enforce
    // this, which is exactly why it must be simulated here.
    const original = globalThis.fetch
    class BrowserWindow {
      async fetch(this: unknown, _input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
        // WebIDL receiver rules: undefined/null coerces to the global,
        // the global itself is fine, ANY other object fails the brand
        // check - which is what `options.fetch(...)` used to hand it.
        if (this !== undefined && this !== null && this !== globalThis && !(this instanceof BrowserWindow)) {
          throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
        }
        return new Response(
          JSON.stringify({tag: 'payRequest', callback: 'https://mint.example/cb', minSendable: 1000, maxSendable: 2000, metadata: '[]'}),
          {status: 200, headers: {'content-type': 'application/json'}}
        )
      }
    }
    const fakeWindow = new BrowserWindow()
    globalThis.fetch = fakeWindow.fetch as typeof fetch
    try {
      const info = await fetchPayRequest('https://mint.example/.well-known/lnurlp/mint')
      expect(info.tag).toBe('payRequest')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('mint address fields', () => {
  const address = (extra: Record<string, unknown> = {}) => ({
    tag: 'withdrawRequest',
    callback: 'https://mint.example/w/cb',
    minWithdrawable: 1000,
    maxWithdrawable: 100_000_000,
    payLink: 'https://mint.example/.well-known/lnurlp/mint',
    mintPubkey: '02' + 'ab'.repeat(32),
    ...extra
  })

  const fetchAddress = (extra: Record<string, unknown> = {}) =>
    fetchMintAddress('https://mint.example/.well-known/lnurlw/mint', {
      fetch: jsonFetch(address(extra))
    })

  it('reads the operator fields a mint publishes', async () => {
    const info = await fetchAddress({
      name: 'Example Mint',
      description: 'A mint for examples.',
      contact: {
        nostr: 'npub1example',
        email: 'operator@mint.example',
        url: 'https://mint.example/about'
      },
      tosUrl: 'https://mint.example/terms',
      motd: 'Fees change on 1 September.',
      fees: {baseFeeMsat: 1000, feePpm: 2500},
      version: '1.4.0',
      previousPubkeys: ['02' + 'cd'.repeat(32)]
    })
    expect(info.name).toBe('Example Mint')
    expect(info.description).toBe('A mint for examples.')
    expect(info.contact).toEqual({
      nostr: 'npub1example',
      email: 'operator@mint.example',
      url: 'https://mint.example/about'
    })
    expect(info.tosUrl).toBe('https://mint.example/terms')
    expect(info.motd).toBe('Fees change on 1 September.')
    expect(info.fees).toEqual({baseFeeMsat: 1000, feePpm: 2500})
    expect(info.version).toBe('1.4.0')
    expect(info.previousPubkeys).toEqual(['02' + 'cd'.repeat(32)])
  })

  it('leaves every operator field undefined when a mint publishes none', async () => {
    const info = await fetchAddress()
    expect(info.name).toBeUndefined()
    expect(info.description).toBeUndefined()
    expect(info.contact).toBeUndefined()
    expect(info.tosUrl).toBeUndefined()
    expect(info.motd).toBeUndefined()
    expect(info.fees).toBeUndefined()
    expect(info.version).toBeUndefined()
    // absent is not the same as "no keys have ever been retired" - a wallet
    // must not read a missing list as an authoritative empty one
    expect(info.previousPubkeys).toBeUndefined()
  })

  it('keeps an explicitly empty key history', async () => {
    expect((await fetchAddress({previousPubkeys: []})).previousPubkeys).toEqual([])
  })

  it('drops fields whose types are wrong rather than passing them on', async () => {
    const info = await fetchAddress({
      name: 42,
      contact: 'operator@mint.example',
      tosUrl: {href: 'https://mint.example/terms'},
      fees: {baseFeeMsat: 'free'},
      previousPubkeys: ['02' + 'cd'.repeat(32), 7, null]
    })
    expect(info.name).toBeUndefined()
    expect(info.contact).toBeUndefined()
    expect(info.tosUrl).toBeUndefined()
    expect(info.fees).toBeUndefined()
    expect(info.previousPubkeys).toEqual(['02' + 'cd'.repeat(32)])
  })

  it('reads a partial contact, and a fee that states only one component', async () => {
    const info = await fetchAddress({
      contact: {email: 'operator@mint.example', nostr: 12},
      fees: {baseFeeMsat: 1000}
    })
    expect(info.contact).toEqual({
      nostr: undefined,
      email: 'operator@mint.example',
      url: undefined
    })
    // the component a mint omits is zero, the same reading the fee prose gets
    expect(info.fees).toEqual({baseFeeMsat: 1000, feePpm: 0})
  })

  it('accepts either spelling of the node capacity', async () => {
    expect((await fetchAddress({nodeCapacity: 500_000_000})).nodeCapacityMsat).toBe(
      500_000_000
    )
    // one live mint sends the suffixed name; it used to survive only by
    // riding the spread this mapping replaced
    expect(
      (await fetchAddress({nodeCapacityMsat: 210_000_000})).nodeCapacityMsat
    ).toBe(210_000_000)
    // the bare wire name wins where a mint emits both
    expect(
      (
        await fetchAddress({
          nodeCapacity: 500_000_000,
          nodeCapacityMsat: 210_000_000
        })
      ).nodeCapacityMsat
    ).toBe(500_000_000)
  })

  it('does not carry unrecognised wire fields onto the typed object', async () => {
    const info: Record<string, unknown> = (await fetchAddress({
      somethingNew: 'a field this version has never heard of'
    })) as never
    expect(info.somethingNew).toBeUndefined()
    expect(info.payLink).toBe('https://mint.example/.well-known/lnurlp/mint')
  })

  it('names the note-signing key mintPubkey, with nodePubkey as the old alias', async () => {
    const info = await fetchAddress()
    expect(info.mintPubkey).toBe('02' + 'ab'.repeat(32))
    // deprecated, same value, gone at the next breaking change
    expect(info.nodePubkey).toBe(info.mintPubkey)
  })

  it('leaves both names undefined when a mint publishes no signing key', async () => {
    const info = await fetchMintAddress(
      'https://mint.example/.well-known/lnurlw/mint',
      {
        fetch: jsonFetch({
          tag: 'withdrawRequest',
          callback: 'https://mint.example/w/cb',
          maxWithdrawable: 100_000_000,
          payLink: 'https://mint.example/.well-known/lnurlp/mint'
        })
      }
    )
    expect(info.mintPubkey).toBeUndefined()
    expect(info.nodePubkey).toBeUndefined()
  })

  it('does not confuse the signing key with the node in nodeUri', async () => {
    const nodeKey = '03' + '11'.repeat(32)
    const info = await fetchAddress({nodeUri: `${nodeKey}@127.0.0.1:9735`})
    // two different keys in one document: this is the trap the rename exists
    // to close
    expect(info.mintPubkey).not.toBe(nodeKey)
    expect(info.nodeUri).toContain(nodeKey)
  })

  it('reads every address the node announces, with nodeUri still the first', async () => {
    const nodeKey = '03' + '11'.repeat(32)
    const clearnet = `${nodeKey}@2.29.14.244:9735`
    const onion = `${nodeKey}@abcdefghijklmnop.onion:9735`
    const info = await fetchAddress({nodeUri: clearnet, nodeUris: [clearnet, onion]})
    expect(info.nodeUris).toEqual([clearnet, onion])
    expect(info.nodeUri).toBe(clearnet)
  })

  it('says undefined rather than [] for a mint that announces no address', async () => {
    // A caller checking `nodeUris?.length` and one checking `'nodeUris' in
    // info` have to reach the same conclusion.
    expect((await fetchAddress({nodeUris: []})).nodeUris).toBeUndefined()
    expect((await fetchAddress()).nodeUris).toBeUndefined()
    expect((await fetchAddress({nodeUris: 'not a list'})).nodeUris).toBeUndefined()
    expect((await fetchAddress({nodeUris: [1, 'a', '', null]})).nodeUris).toEqual(['a'])
  })

  it('reads a closing date, and drops anything that is not one', async () => {
    // The one thing a WALLET does with this is show it to a holder, so a
    // wrong date is worse than no date.
    expect((await fetchAddress({sunsetDate: '2026-12-31'})).sunsetDate).toBe('2026-12-31')
    expect((await fetchAddress()).sunsetDate).toBeUndefined()
    expect((await fetchAddress({sunsetDate: '31/12/2026'})).sunsetDate).toBeUndefined()
    expect((await fetchAddress({sunsetDate: '2026-12-31T09:00:00Z'})).sunsetDate).toBeUndefined()
    // Date takes this one and rolls it forward to 3 March.
    expect((await fetchAddress({sunsetDate: '2026-02-31'})).sunsetDate).toBeUndefined()
    expect((await fetchAddress({sunsetDate: 20261231})).sunsetDate).toBeUndefined()
  })

  it('reads what the mint says it owes, zero included', async () => {
    // "Owes nothing" and "will not say" are different claims about a
    // custodian, and a holder needs to be able to tell them apart.
    expect((await fetchAddress({outstandingNotesMsat: 48_000})).outstandingNotesMsat).toBe(48_000)
    expect((await fetchAddress({outstandingNotesMsat: 0})).outstandingNotesMsat).toBe(0)
    expect((await fetchAddress()).outstandingNotesMsat).toBeUndefined()
    expect((await fetchAddress({outstandingNotesMsat: '48000'})).outstandingNotesMsat).toBeUndefined()
  })

  it('still refuses a response that is not a mint address', async () => {
    await expect(
      fetchMintAddress('https://mint.example/.well-known/lnurlw/mint', {
        fetch: jsonFetch({tag: 'payRequest', callback: 'https://mint.example/p/cb'})
      })
    ).rejects.toBeInstanceOf(ProtocolError)
  })
})
