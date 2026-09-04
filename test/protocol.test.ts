// Everything here runs against the conformance repo's mock mint - a real
// HTTP server that can be told to misbehave. The happy paths matter, but
// the adversarial modes are the reason this suite exists: a library that
// only works against a well-behaved SERVICE has not been tested at all.

import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {bytesToHex} from '@noble/hashes/utils.js'
import {sha256} from '@noble/hashes/sha2.js'
import {hexToBytes} from '@noble/hashes/utils.js'
import {
  AmbiguousMintError,
  AmbiguousMutationError,
  buildNoteUrl,
  claimMintedNote,
  deriveNoteRoot,
  deriveNoteSecret,
  derivedSecretSource,
  fetchInvoiceVerification,
  fetchMintAddress,
  fetchNoteInfo,
  fetchPayRequest,
  fromLud17,
  hashK1,
  HashLookupUnsupportedError,
  meltNote,
  mergeBatches,
  mergeNotes,
  namesMintOutput,
  newSecretsOf,
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  probeBurnedNote,
  ProtocolError,
  requestInvoice,
  RequestRefusedError,
  restoreNotes,
  rotateNote,
  ServiceRejectedError,
  UnverifiableNoteError,
  serverOf,
  settleNote,
  splitNote,
  verifyNoteSignature,
} from '../src/index.js'

type Mint = Awaited<ReturnType<typeof createMockMint>>

const mints: Mint[] = []
const mint = async (options: Record<string, unknown> = {}): Promise<Mint> => {
  const m = await createMockMint(options)
  mints.push(m)
  return m
}

afterEach(async () => {
  await Promise.all(mints.splice(0).map(m => m.close()))
})

describe('current-draft mint capability', () => {
  it('requires room for the mandatory comment and never accepts mintToHash alone', () => {
    expect(namesMintOutput({commentAllowed: 64})).toBe(true)
    expect(namesMintOutput({commentAllowed: 128, mintToHash: true})).toBe(true)
    expect(namesMintOutput({mintToHash: true})).toBe(false)
    expect(namesMintOutput({commentAllowed: 63, mintToHash: true})).toBe(false)
  })
})

const secret = (seed: string) => bytesToHex(sha256(hexToBytes('00'.repeat(31) + seed)))
const noteUrl = (m: Mint, k1: string, amountMsat?: number) =>
  buildNoteUrl(`${m.url}/w`, k1, amountMsat)

describe('the informational GET', () => {
  it('reports what a note is worth, and never burns it', async () => {
    const m = await mint()
    const k1 = secret('01')
    m.state.creditNote(k1, 21000)

    const info = await fetchNoteInfo(noteUrl(m, k1))
    expect(info.maxWithdrawable).toBe(21000)
    expect(info.k1).toBe(k1)
    expect(m.state.noteState(k1)).toBe('outstanding')

    // and again - an informational GET is idempotent
    expect((await fetchNoteInfo(noteUrl(m, k1))).maxWithdrawable).toBe(21000)
  })

  // The way home. A note's informational response is all a bearer-note
  // wallet may ever have of a mint, and it carries no link to the discovery
  // document - which lives under a username the note never mentions. So a
  // wallet that only ever received notes cannot reach the mint's retired
  // signing keys, and an announced key rotation looks exactly like a
  // substituted key. `payLink` is the reverse of `withdrawLink` and closes
  // that.
  it('carries the way home when the service publishes one', async () => {
    const m = await mint()
    const k1 = secret('0a')
    m.state.creditNote(k1, 21000)

    const info = await fetchNoteInfo(noteUrl(m, k1))
    expect(info.payLink).toBe(`${m.url}/.well-known/lnurlp/mint`)
  })

  it('is silent about it when the service publishes none', async () => {
    const m = await mint({noteInfoPayLink: false})
    const k1 = secret('0b')
    m.state.creditNote(k1, 21000)

    expect((await fetchNoteInfo(noteUrl(m, k1))).payLink).toBeUndefined()
  })

  it('drops a way home that points at somebody else', async () => {
    // A SERVICE nominating a THIRD party to vouch for its key history.
    // Whoever controls the host controls the pin anyway, but that argument
    // does not stretch to another origin, and refusing costs nothing.
    const m = await mint({payLinkOffOrigin: true})
    const k1 = secret('0c')
    m.state.creditNote(k1, 21000)

    const info = await fetchNoteInfo(noteUrl(m, k1))
    expect(info.payLink).toBeUndefined()
  })

  it('treats maxWithdrawable as authoritative over the URL\'s own claim', async () => {
    const m = await mint()
    const k1 = secret('02')
    m.state.creditNote(k1, 21000)
    // the note URL claims a hundred times its real value
    const info = await fetchNoteInfo(noteUrl(m, k1, 2_100_000))
    expect(info.maxWithdrawable).toBe(21000)
  })

  it('does not send the signature back to the service', async () => {
    const m = await mint()
    const k1 = secret('03')
    m.state.creditNote(k1, 21000)
    const seen: string[] = []
    const spyFetch: typeof fetch = (input, init) => {
      seen.push(input.toString())
      return fetch(input as string, init)
    }
    await fetchNoteInfo(`${noteUrl(m, k1, 21000)}&sig=${'ab'.repeat(65)}`, {
      fetch: spyFetch
    })
    expect(seen[0]).not.toContain('sig=')
    expect(seen[0]).toContain(`k1=${k1}`)
  })

  it('refuses a service that echoes back a different k1', async () => {
    const m = await mint({echoWrongK1: true})
    const k1 = secret('04')
    m.state.creditNote(k1, 21000)
    await expect(fetchNoteInfo(noteUrl(m, k1))).rejects.toBeInstanceOf(ProtocolError)
  })

  it('distinguishes an unknown note from a spent one', async () => {
    const m = await mint()
    const known = secret('05')
    m.state.creditNote(known, 21000)
    await expect(fetchNoteInfo(noteUrl(m, secret('06')))).rejects.toBeInstanceOf(
      NoteUnknownError
    )

    const info = await fetchNoteInfo(noteUrl(m, known))
    await rotateNote(info.callback, known)
    await expect(fetchNoteInfo(noteUrl(m, known))).rejects.toBeInstanceOf(
      NoteSpentError
    )
  })
})

describe('rotate', () => {
  it('burns the old secret and mints a new one the service never saw', async () => {
    const m = await mint()
    const k1 = secret('10')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))

    const rotated = await rotateNote(info.callback, k1)
    expect(rotated.k1).not.toBe(k1)
    expect(m.state.noteState(k1)).toBe('burned')
    // the service stored the new note under the hash it was given, and
    // cannot have learned the secret behind it
    expect(m.state.noteState(rotated.k1)).toBe('outstanding')
    expect(m.state.notes.has(hashK1(rotated.k1))).toBe(true)

    const after = await fetchNoteInfo(noteUrl(m, rotated.k1))
    expect(after.maxWithdrawable).toBe(21000)
  })

  it('verifies the signature the service issues for the new note', async () => {
    const m = await mint()
    const k1 = secret('11')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))
    const rotated = await rotateNote(info.callback, k1)

    expect(rotated.signature).toBeTruthy()
    expect(
      verifyNoteSignature(rotated.k1, 21000, rotated.signature!, m.state.pubkey)
    ).toBe(true)
    // and does not verify for a value the mint never signed
    expect(
      verifyNoteSignature(rotated.k1, 21001, rotated.signature!, m.state.pubkey)
    ).toBe(false)
  })

  it('verifies a signature whose recovery id is at the other end', async () => {
    const m = await mint({signatureLayout: 'leading'})
    const k1 = secret('12')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))
    const rotated = await rotateNote(info.callback, k1)
    expect(
      verifyNoteSignature(rotated.k1, 21000, rotated.signature!, m.state.pubkey)
    ).toBe(true)
  })

  // Offline verification stopped being optional in the current draft, so a
  // SERVICE that issues no signatures is non-compliant rather than merely
  // basic. The refusal has to be the loud kind - but the rotate LANDED, and
  // the fresh secret is the only key to the note it minted, so the error
  // carries it out. Discarding it here would be the library destroying real
  // money to make a point about conformance.
  it('refuses an unsigned rotate without losing the note it minted', async () => {
    const m = await mint({signatures: false})
    const k1 = secret('13')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))
    const err = await rotateNote(info.callback, k1).catch(e => e)
    expect(err).toBeInstanceOf(UnverifiableNoteError)
    const kept = newSecretsOf(err)
    expect(kept).toHaveLength(1)
    // the note the caller was refused is real, outstanding, and reachable
    // with nothing but the secret the error handed back
    expect(m.state.noteState(kept[0]!)).toBe('outstanding')
  })

  // The same mint, for a caller who has decided to deal with it anyway.
  // One option, stated once, and the note comes back unsigned - which is
  // exactly what it is.
  it('still works against an unsigned service when the caller opts out', async () => {
    const m = await mint({signatures: false})
    const k1 = secret('15')
    m.state.creditNote(k1, 21000)
    const opts = {requireSignatures: false}
    const info = await fetchNoteInfo(noteUrl(m, k1), opts)
    const rotated = await rotateNote(info.callback, k1, opts)
    expect(rotated.signature).toBeUndefined()
    expect(m.state.noteState(rotated.k1)).toBe('outstanding')
  })

  it('ignores a secret a non-compliant service tries to hand back', async () => {
    const m = await mint({serverGeneratedSecrets: true})
    const k1 = secret('14')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))
    const rotated = await rotateNote(info.callback, k1)
    // the mint offered 'aaaa...' as the new secret. Taking it would hand
    // the mint a permanent copy of the note it just issued.
    expect(rotated.k1).not.toBe('a'.repeat(64))
    expect(m.state.notes.has(hashK1(rotated.k1))).toBe(true)
  })
})

describe('split and merge', () => {
  it('splits a note into an amount and its change', async () => {
    const m = await mint()
    const k1 = secret('20')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))

    const result = await splitNote(info.callback, [k1], 5000)
    expect(m.state.noteState(k1)).toBe('burned')
    expect((await fetchNoteInfo(noteUrl(m, result.k1))).maxWithdrawable).toBe(5000)
    expect((await fetchNoteInfo(noteUrl(m, result.change))).maxWithdrawable).toBe(
      16000
    )
    expect(verifyNoteSignature(result.k1, 5000, result.signature!, m.state.pubkey)).toBe(true)
    expect(
      verifyNoteSignature(result.change, 16000, result.changeSignature!, m.state.pubkey)
    ).toBe(true)
  })

  it('splits several notes at once, with no prior merge', async () => {
    const m = await mint()
    const a = secret('21')
    const b = secret('22')
    m.state.creditNote(a, 21000)
    m.state.creditNote(b, 9000)
    const info = await fetchNoteInfo(noteUrl(m, a))

    const result = await splitNote(info.callback, [a, b], 25000)
    expect(m.state.noteState(a)).toBe('burned')
    expect(m.state.noteState(b)).toBe('burned')
    expect((await fetchNoteInfo(noteUrl(m, result.k1))).maxWithdrawable).toBe(25000)
    expect((await fetchNoteInfo(noteUrl(m, result.change))).maxWithdrawable).toBe(5000)
  })

  it('merges notes into their sum', async () => {
    const m = await mint()
    const parts = ['30', '31', '32'].map(secret)
    parts.forEach((k1, i) => m.state.creditNote(k1, 1000 * (i + 1)))
    const info = await fetchNoteInfo(noteUrl(m, parts[0]!))

    const merged = await mergeNotes(info.callback, parts)
    for (const part of parts) expect(m.state.noteState(part)).toBe('burned')
    expect((await fetchNoteInfo(noteUrl(m, merged.k1))).maxWithdrawable).toBe(6000)
  })

  it('folds a large merge in batches rather than one over-long URL', async () => {
    const m = await mint()
    const parts = Array.from({length: 40}, (_, i) =>
      secret((i + 100).toString(16).padStart(2, '0'))
    )
    parts.forEach(k1 => m.state.creditNote(k1, 1000))
    const info = await fetchNoteInfo(noteUrl(m, parts[0]!))
    const seen: string[] = []
    const spyFetch: typeof fetch = (input, init) => {
      seen.push(input.toString())
      return fetch(input as string, init)
    }

    const merged = await mergeNotes(info.callback, parts, {fetch: spyFetch})

    expect(Math.max(...seen.map(u => u.length))).toBeLessThanOrEqual(2000)
    for (const part of parts) expect(m.state.noteState(part)).toBe('burned')
    expect((await fetchNoteInfo(noteUrl(m, merged.k1))).maxWithdrawable).toBe(40000)
  })

  it('hands back the carried note when a fold fails partway', async () => {
    const m = await mint()
    const parts = Array.from({length: 40}, (_, i) =>
      secret((i + 100).toString(16).padStart(2, '0'))
    )
    parts.forEach(k1 => m.state.creditNote(k1, 1000))
    const info = await fetchNoteInfo(noteUrl(m, parts[0]!))
    const batches = mergeBatches(info.callback, parts)
    expect(batches.length).toBeGreaterThan(1)

    let calls = 0
    // The first batch lands; the network then drops. The value of that
    // first batch is now sitting at a secret only the kit generated.
    const flakyFetch: typeof fetch = (input, init) => {
      if (++calls > 1) return Promise.reject(new TypeError('network down'))
      return fetch(input as string, init)
    }

    const err = await mergeNotes(info.callback, parts, {fetch: flakyFetch}).catch(
      e => e
    )

    const rescued = newSecretsOf(err)
    expect(rescued.length).toBeGreaterThan(0)
    const live = await Promise.all(
      rescued.map(k1 =>
        fetchNoteInfo(noteUrl(m, k1))
          .then(i => i.maxWithdrawable)
          .catch(() => 0)
      )
    )
    expect(Math.max(...live)).toBe(batches[0]!.length * 1000)
  })

  it('hands back the carried note when a later batch is refused outright', async () => {
    const m = await mint()
    const parts = Array.from({length: 40}, (_, i) =>
      secret((i + 100).toString(16).padStart(2, '0'))
    )
    parts.forEach(k1 => m.state.creditNote(k1, 1000))
    const info = await fetchNoteInfo(noteUrl(m, parts[0]!))
    const batches = mergeBatches(info.callback, parts)
    expect(batches.length).toBeGreaterThan(1)

    // The first batch lands. The second is refused definitively - a mint
    // with a tighter k1 cap than our URL budget, or an input mid-melt
    // elsewhere. Nothing of THIS request was burned, but the note carried
    // from the first batch is live and exists nowhere else.
    let calls = 0
    const refusingFetch: typeof fetch = (input, init) => {
      if (++calls > 1) {
        return Promise.resolve(
          new Response(JSON.stringify({status: 'ERROR', reason: 'Too many k1s (max 21).'}), {
            headers: {'content-type': 'application/json'}
          })
        )
      }
      return fetch(input as string, init)
    }

    const err = await mergeNotes(info.callback, parts, {fetch: refusingFetch}).catch(e => e)

    const rescued = newSecretsOf(err)
    expect(rescued.length).toBeGreaterThan(0)
    const live = await Promise.all(
      rescued.map(k1 =>
        fetchNoteInfo(noteUrl(m, k1))
          .then(i => i.maxWithdrawable)
          .catch(() => 0)
      )
    )
    expect(Math.max(...live)).toBe(batches[0]!.length * 1000)
  })

  it('refuses to send a mutation with no note named', async () => {
    const m = await mint()
    await expect(mergeNotes(`${m.url}/w/cb`, [])).rejects.toBeInstanceOf(
      RequestRefusedError
    )
    await expect(splitNote(`${m.url}/w/cb`, [], 1000)).rejects.toBeInstanceOf(
      RequestRefusedError
    )
  })

  it('settles an output against what it is actually worth', async () => {
    const m = await mint()
    const k1 = secret('33')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))
    const result = await splitNote(info.callback, [k1], 5000)

    // the caller does not know the change is 16000 - only the service does
    const settled = await settleNote(noteUrl(m, k1), result.change, 0, result.changeSignature)
    expect(settled.amountMsat).toBe(16000)
    // and it was rotated on the way, so the GET-exposed secret is gone
    expect(settled.k1).not.toBe(result.change)
    expect(m.state.noteState(result.change)).toBe('burned')
  })
})

describe('melt', () => {
  it('reports OK while the payment is still in flight', async () => {
    const m = await mint({meltNeverSettles: true})
    const k1 = secret('40')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))

    const result = await meltNote(info.callback, k1, 'lnbc210n1pjqrstuvwxyz')
    expect(result.pr).toBe('lnbc210n1pjqrstuvwxyz')
    // OK does NOT mean spent - the note is reserved, not burned
    expect(m.state.noteState(k1)).toBe('pending')
  })

  it('locks every other operation out until the melt resolves', async () => {
    const m = await mint({meltNeverSettles: true})
    const k1 = secret('41')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))
    await meltNote(info.callback, k1, 'lnbc210n1pjqrstuvwxyz')

    await expect(rotateNote(info.callback, k1)).rejects.toBeInstanceOf(PendingNoteError)
    await expect(
      meltNote(info.callback, k1, 'lnbc210n1pjqrstuvwxyz')
    ).rejects.toBeInstanceOf(PendingNoteError)
  })

  it('restores the note when the payment fails', async () => {
    const m = await mint({meltAlwaysFails: true})
    const k1 = secret('42')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))
    await meltNote(info.callback, k1, 'lnbc210n1pjqrstuvwxyz')

    await new Promise(r => setTimeout(r, 60))
    // a failed melt is never reported through the callback - it is only
    // observable as the note becoming spendable again
    expect(m.state.noteState(k1)).toBe('outstanding')
    expect((await fetchNoteInfo(noteUrl(m, k1))).maxWithdrawable).toBe(21000)
  })

  it('burns the note once the payment settles, and proves it', async () => {
    const m = await mint()
    const k1 = secret('43')
    m.state.creditNote(k1, 21000)
    const info = await fetchNoteInfo(noteUrl(m, k1))
    const result = await meltNote(info.callback, k1, 'lnbc210n1pjqrstuvwxyz')

    await new Promise(r => setTimeout(r, 60))
    expect(m.state.noteState(k1)).toBe('burned')

    const proof = await fetchInvoiceVerification(result.verify!)
    expect(proof.settled).toBe(true)
    // the melt's preimage is not the note secret: the note that funded this
    // payment was already burned by the time the proof existed
    expect(proof.preimage).not.toBe(k1)
  })
})

describe('minting', () => {
  it('mints directly at a wallet-chosen secret', async () => {
    const m = await mint()
    const pay = await fetchPayRequest(`${m.url}/.well-known/lnurlp/mint`)
    // Either legal spelling (plain URL as lnurl-mint, lnurlw:// per LUD-17)
    // resolves to the same fetchable endpoint; that is what matters here.
    expect(fromLud17(pay.withdrawLink!)).toBe(`http://127.0.0.1:${m.port}/w`)

    const k1 = secret('44')
    const invoice = await requestInvoice(pay.callback, 21000, {h: hashK1(k1)})
    expect(invoice.disposable).toBe(false)

    // pay it - the mock settles on demand, since nothing here is payable
    const paymentHash = [...m.state.invoices.keys()].at(-1)!
    const pending = m.state.invoices.get(paymentHash)!
    pending.settled = true
    m.state.creditNote(k1, pending.amountMsat)

    const verified = await fetchInvoiceVerification(invoice.verify!)
    expect(verified.settled).toBe(true)
    expect(verified.preimage).not.toBe(k1)

    const info = await fetchNoteInfo(buildNoteUrl(pay.withdrawLink!, k1))
    expect(info.maxWithdrawable).toBe(21000)
    expect(m.state.noteState(k1)).toBe('outstanding')
  })

  it('reads an advertised mint fee', async () => {
    const m = await mint({baseFeeMsat: 1000, feePpm: 2000})
    const pay = await fetchPayRequest(`${m.url}/.well-known/lnurlp/mint`)
    expect(pay.mintFee).toEqual({baseFeeMsat: 1000, feePpm: 2000})
  })

  it('reads no fee from a mint that advertises none', async () => {
    const m = await mint()
    const pay = await fetchPayRequest(`${m.url}/.well-known/lnurlp/mint`)
    expect(pay.mintFee).toBeUndefined()
  })

  it('refuses an invoice for an amount it did not ask for', async () => {
    const m = await mint()
    const pay = await fetchPayRequest(`${m.url}/.well-known/lnurlp/mint`)
    const spyFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input as string, init)
      const body = await res.json()
      // the service swaps in an invoice for a hundredth of the amount
      return new Response(JSON.stringify({...body, pr: 'lnbc21n1pjqrstuvwxyz'}), {
        headers: {'content-type': 'application/json'}
      })
    }
    await expect(
      requestInvoice(pay.callback, 21000, {
        h: hashK1(secret('45')),
        fetch: spyFetch
      })
    ).rejects.toBeInstanceOf(ProtocolError)
  })

  it('finds the experimental mint address', async () => {
    const m = await mint()
    const address = await fetchMintAddress(`${m.url}/.well-known/lnurlw/mint`)
    expect(address.mintPubkey).toBe(m.state.pubkey)
    // the deprecated alias carries the same value for one release
    expect(address.nodePubkey).toBe(m.state.pubkey)
    expect(address.payLink).toBe(`${m.url}/.well-known/lnurlp/mint`)
    // Against the real mock, unstubbed: the conformance mint advertises
    // nodeCapacity on the wire, so the rename has to survive a round trip
    // nobody here controls. The spied tests below prove the mapping in
    // isolation; this one proves it against what a mint actually sends.
    expect(address.nodeCapacityMsat).toBe(500_000_000)
    expect(address.nodeNumChannels).toBe(4)
    expect(address.nodeNumPeers).toBe(6)
  })

  it('reads the node stats a mint address advertises', async () => {
    const m = await mint()
    // lnurl-mint answers with nodeCapacity (msat), which this side exposes
    // as nodeCapacityMsat - a rename that only happens if it is mapped
    const spyFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input as string, init)
      const body = await res.json()
      return new Response(
        JSON.stringify({
          ...body,
          nodeCapacity: 210_000_000,
          nodeNumChannels: 12,
          nodeNumPeers: 9
        }),
        {headers: {'content-type': 'application/json'}}
      )
    }
    const address = await fetchMintAddress(`${m.url}/.well-known/lnurlw/mint`, {
      fetch: spyFetch
    })
    expect(address.nodeCapacityMsat).toBe(210_000_000)
    expect(address.nodeNumChannels).toBe(12)
    expect(address.nodeNumPeers).toBe(9)
  })

  it('leaves the node stats undefined when a mint address omits them', async () => {
    const m = await mint()
    const spyFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input as string, init)
      const {nodeCapacity, nodeNumChannels, nodeNumPeers, ...body} = await res.json()
      return new Response(JSON.stringify(body), {
        headers: {'content-type': 'application/json'}
      })
    }
    const address = await fetchMintAddress(`${m.url}/.well-known/lnurlw/mint`, {
      fetch: spyFetch
    })
    expect(address.nodeCapacityMsat).toBeUndefined()
    expect(address.nodeNumChannels).toBeUndefined()
  })

  it('reports a sunsetting mint\'s refusal as definitive', async () => {
    const m = await mint({sunset: true})
    const pay = await fetchPayRequest(`${m.url}/.well-known/lnurlp/mint`)
    await expect(requestInvoice(pay.callback, 21000)).rejects.toBeInstanceOf(
      ServiceRejectedError
    )
  })
})

describe('naming the note you are buying', () => {
  // A binding mint credits the note at the `h` the WALLET sent instead of
  // at the payment preimage. The published mock does not implement that
  // knob yet, so the mint half is spied here: what is under test is the
  // WALLET's side of the same wire contract.
  const spying = (
    seen: string[],
    body: (parsed: any, url: URL) => any = parsed => parsed
  ): typeof fetch =>
    async (input, init) => {
      const url = new URL(String(input))
      seen.push(url.toString())
      const res = await fetch(String(input), init)
      const parsed = await res.json()
      return new Response(JSON.stringify(body(parsed, url)), {
        headers: {'content-type': 'application/json'}
      })
    }

  const refusingFetch: typeof fetch = async () => {
    throw new Error('nothing should have been sent')
  }

  it('puts the wallet\'s own output hash on the pay callback', async () => {
    const m = await mint()
    const pay = await fetchPayRequest(`${m.url}/.well-known/lnurlp/mint`)
    const k1 = secret('60')
    const seen: string[] = []

    await requestInvoice(pay.callback, 21000, {h: hashK1(k1), fetch: spying(seen)})

    const sent = new URL(seen.at(-1)!)
    // LUD-25 names the output with a LUD-12 comment; `h` rides along for
    // services that took the parameter form before that was written
    expect(sent.searchParams.get('comment')).toBe(hashK1(k1))
    expect(sent.searchParams.get('h')).toBe(hashK1(k1))
    expect(sent.searchParams.get('amount')).toBe('21000')
  })

  it('does not invent a commitment when a non-minting caller supplies none', async () => {
    const m = await mint()
    const pay = await fetchPayRequest(`${m.url}/.well-known/lnurlp/mint`)
    const seen: string[] = []

    await expect(
      requestInvoice(pay.callback, 21000, {fetch: spying(seen)})
    ).rejects.toBeInstanceOf(ServiceRejectedError)

    const sent = new URL(seen.at(-1)!)
    expect(sent.searchParams.has('h')).toBe(false)
    // and no empty comment either: a service reading one would have to
    // decide what a blank commitment means
    expect(sent.searchParams.has('comment')).toBe(false)
  })

  it('normalises the output hash to lowercase before sending it', async () => {
    const m = await mint()
    const pay = await fetchPayRequest(`${m.url}/.well-known/lnurlp/mint`)
    const k1 = secret('61')
    const seen: string[] = []

    await requestInvoice(pay.callback, 21000, {
      h: hashK1(k1).toUpperCase(),
      fetch: spying(seen)
    })

    expect(new URL(seen.at(-1)!).searchParams.get('h')).toBe(hashK1(k1))
  })

  it('refuses a malformed output hash before anything is sent', async () => {
    const m = await mint()
    const pay = await fetchPayRequest(`${m.url}/.well-known/lnurlp/mint`)

    // A wallet that pays for a quote the mint was always going to reject
    // has burned an invoice for nothing, so this is refused on this side.
    for (const h of ['', 'not-hex', hashK1(secret('62')).slice(0, 63), 'zz'.repeat(32)]) {
      await expect(
        requestInvoice(pay.callback, 21000, {h, fetch: refusingFetch})
      ).rejects.toBeInstanceOf(RequestRefusedError)
    }
  })

  it('reports the binding when the mint confirms it on the quote', async () => {
    const m = await mint()
    const pay = await fetchPayRequest(`${m.url}/.well-known/lnurlp/mint`)
    const seen: string[] = []

    const invoice = await requestInvoice(pay.callback, 21000, {
      h: hashK1(secret('63')),
      fetch: spying(seen, parsed => ({...parsed, mintToHash: true}))
    })

    expect(invoice.mintToHash).toBe(true)
    expect(invoice.disposable).toBe(false)
  })

  it('reads mintToHash from the payRequest, which is where a wallet asks first', async () => {
    const m = await mint()
    const url = `${m.url}/.well-known/lnurlp/mint`

    // The payRequest is the one endpoint every mint has, and where a wallet
    // already is when it is about to mint. Asking the optional discovery
    // document first would be a round trip for a fact it could be told here.
    const advertised = await fetchPayRequest(url, {
      fetch: spying([], parsed => ({...parsed, mintToHash: true}))
    })
    expect(advertised.mintToHash).toBe(true)
    // and it sits alongside the withdrawLink it is about
    expect(advertised.withdrawLink).toBeTruthy()

    const silent = await fetchPayRequest(url)
    expect(silent.mintToHash).toBeUndefined()

    const refused = await fetchPayRequest(url, {
      fetch: spying([], parsed => ({...parsed, mintToHash: false}))
    })
    expect(refused.mintToHash).toBe(false)
  })

  it('reads anything that is not exactly true as no, on either document', async () => {
    const m = await mint()
    // The response is spread through on the payRequest, so a truthy string
    // would otherwise land on the typed field and read as a capability.
    for (const value of ['true', 1, 'yes', {}, [], null]) {
      const pay = await fetchPayRequest(`${m.url}/.well-known/lnurlp/mint`, {
        fetch: spying([], parsed => ({...parsed, mintToHash: value}))
      })
      expect(pay.mintToHash).toBeUndefined()

      const address = await fetchMintAddress(`${m.url}/.well-known/lnurlw/mint`, {
        fetch: spying([], parsed => ({...parsed, mintToHash: value}))
      })
      expect(address.mintToHash).toBeUndefined()
    }
  })

  it('falls back to the mint address for a mint that only says it there', async () => {
    const m = await mint()
    const advertised = await fetchMintAddress(`${m.url}/.well-known/lnurlw/mint`, {
      fetch: spying([], parsed => ({...parsed, mintToHash: true}))
    })
    expect(advertised.mintToHash).toBe(true)

    // silence is not a refusal on the wire, but a wallet reads it as one
    const silent = await fetchMintAddress(`${m.url}/.well-known/lnurlw/mint`)
    expect(silent.mintToHash).toBeUndefined()

    const refused = await fetchMintAddress(`${m.url}/.well-known/lnurlw/mint`, {
      fetch: spying([], parsed => ({...parsed, mintToHash: false}))
    })
    expect(refused.mintToHash).toBe(false)
  })

  it('claims the note at the wallet\'s own secret, with no verify poll', async () => {
    const m = await mint()
    // the whole flow, in the order a wallet performs it: the payRequest
    // says the mint accepts an `h`, so the wallet names its own note
    const pay = await fetchPayRequest(`${m.url}/.well-known/lnurlp/mint`, {
      fetch: spying([], parsed => ({...parsed, mintToHash: true}))
    })
    expect(pay.mintToHash).toBe(true)
    const withdrawLink = pay.withdrawLink!

    // the secret is drawn from the seed and persisted BEFORE the invoice is
    // asked for: paying and then losing it is the one way this is worse
    const root = deriveNoteRoot(hexToBytes('11'.repeat(32)))
    const k1 = deriveNoteSecret(root, serverOf(m.url), 0)

    const invoice = await requestInvoice(pay.callback, 21000, {
      h: hashK1(k1),
      fetch: spying([], parsed => ({...parsed, mintToHash: true}))
    })
    expect(invoice.mintToHash).toBe(true)

    // unpaid: the mint has an invoice bound to the hash and no note yet
    expect((await claimMintedNote(withdrawLink, k1)).state).toBe('unminted')

    // settlement, as a binding mint performs it: the note appears at `h`
    m.state.creditNote(k1, 21000)

    const claim = await claimMintedNote(withdrawLink, k1)
    expect(claim.state).toBe('minted')
    expect(claim.amountMsat).toBe(21000)
    expect(claim.k1).toBe(k1)
    expect(claim.callback).toBe(`${m.url}/w/cb`)
    // nothing was rotated, and the note is still outstanding and spendable
    expect(m.state.noteState(k1)).toBe('outstanding')

    // and the payment preimage names nothing: it is an ordinary payment
    // proof now, so anyone who saw the invoice and polled verify has it and
    // can do precisely nothing with it
    const paymentHash = [...m.state.invoices.keys()].at(-1)!
    const preimage = m.state.invoices.get(paymentHash)!.preimage
    expect(preimage).not.toBe(k1)
    expect((await claimMintedNote(withdrawLink, preimage)).state).toBe('unminted')
  })

  it('restore finds a note minted this way, without any rotate at all', async () => {
    const m = await mint()
    const host = serverOf(m.url)
    const root = deriveNoteRoot(hexToBytes('22'.repeat(32)))
    // the wallet named index 0 as the output of its mint, and the mint
    // credited it there. A preimage-keyed mint would have minted at a
    // secret nothing derives, leaving the note lost until a rotate.
    m.state.creditNote(deriveNoteSecret(root, host, 0), 21000)

    const {found, next} = await restoreNotes(`${m.url}/w`, root, host, {
      allowSecretDisclosure: true
    })
    expect(found).toEqual([
      {
        index: 0,
        k1: deriveNoteSecret(root, host, 0),
        scheme: 'hmac',
        amountMsat: 21000,
        state: 'live',
        callback: found[0]!.callback
      }
    ])
    // the walk disclosed indices 1..20 looking for more, so they are burned
    expect(next).toBe(21)
  })

  it('separates a burned note and one mid-melt from one not yet minted', async () => {
    const m = await mint()
    const withdrawLink = `${m.url}/w`

    const burned = secret('64')
    m.state.creditNote(burned, 21000)
    const info = await fetchNoteInfo(noteUrl(m, burned))
    await rotateNote(info.callback, burned)
    expect((await claimMintedNote(withdrawLink, burned)).state).toBe('spent')

    // 'pending' is the one reason string LUD-25 fixes verbatim, and the
    // mock's informational GET does not emit it, so it is stubbed here
    const melting = secret('65')
    const pending = await claimMintedNote(withdrawLink, melting, {
      fetch: async () =>
        new Response(JSON.stringify({status: 'ERROR', reason: 'pending'}), {
          headers: {'content-type': 'application/json'}
        })
    })
    expect(pending.state).toBe('pending')
    expect(pending.amountMsat).toBe(null)
    expect(pending.callback).toBe(null)

    expect((await claimMintedNote(withdrawLink, secret('66'))).state).toBe('unminted')
  })

  it('refuses to probe a malformed secret', async () => {
    const m = await mint()
    await expect(
      claimMintedNote(`${m.url}/w`, 'not-a-secret', {fetch: refusingFetch})
    ).rejects.toBeInstanceOf(RequestRefusedError)
  })

  it('throws rather than reporting "not yet" when the mint cannot be reached', async () => {
    const m = await mint()
    // 'unminted' is a claim about the mint's records. A failed request is
    // not one, and a caller polling would read it as one and give up.
    await expect(
      claimMintedNote(`${m.url}/w`, secret('67'), {offline: true})
    ).rejects.toBeInstanceOf(RequestRefusedError)
  })
})

describe('ambiguous outcomes', () => {
  // The mutation landed and the answer was lost on the way back. LUD-25
  // now requires the SERVICE to answer the identical request again with the
  // success it already gave, so simply asking a second time turns this from
  // an unresolved maybe into a completed rotate. The caller never sees an
  // error at all.
  it('completes a rotate whose answer was lost, by asking again', async () => {
    const m = await mint({dropAfterMutation: true})
    const k1 = secret('50')
    m.state.creditNote(k1, 21000)

    const rotated = await rotateNote(`${m.url}/w/cb`, k1)
    expect(m.state.noteState(k1)).toBe('burned')
    expect(m.state.noteState(rotated.k1)).toBe('outstanding')
    expect((await fetchNoteInfo(noteUrl(m, rotated.k1))).maxWithdrawable).toBe(21000)
    // the replay carries the same signature the lost answer did, so the
    // recovered note is as verifiable as one whose first answer arrived
    expect(rotated.signature).toBeDefined()
  })

  it('completes a split whose answer was lost, both outputs intact', async () => {
    const m = await mint({dropAfterMutation: true})
    const k1 = secret('51')
    m.state.creditNote(k1, 21000)

    const split = await splitNote(`${m.url}/w/cb`, [k1], 5000)
    expect((await fetchNoteInfo(noteUrl(m, split.k1))).maxWithdrawable).toBe(5000)
    expect((await fetchNoteInfo(noteUrl(m, split.change))).maxWithdrawable).toBe(16000)
    expect(split.signature).toBeDefined()
    expect(split.changeSignature).toBeDefined()
  })

  // The same dropped answer, with the retry turned off: this is the shape
  // every caller saw before the replay rule, and it still has to work.
  // Nothing about asking again removes the obligation to carry the secrets
  // when the library stops asking.
  it('preserves the fresh secret when a rotate\'s answer is lost and nothing retries', async () => {
    const m = await mint({dropAfterMutation: true})
    const k1 = secret('80')
    m.state.creditNote(k1, 21000)

    const err = await rotateNote(`${m.url}/w/cb`, k1, {mutationRetries: 0}).catch(
      e => e
    )
    expect(err).toBeInstanceOf(AmbiguousMutationError)
    expect(err.newSecrets).toHaveLength(1)

    // the mutation did land: the input is burned and the output exists,
    // keyed by the hash of a secret only the caller holds
    expect(m.state.noteState(k1)).toBe('burned')
    const rescued = err.newSecrets[0]
    expect(m.state.noteState(rescued)).toBe('outstanding')
    expect((await fetchNoteInfo(noteUrl(m, rescued))).maxWithdrawable).toBe(21000)
  })

  it('preserves both secrets when a split\'s answer is lost, in output order', async () => {
    const m = await mint({dropAfterMutation: true})
    const k1 = secret('81')
    m.state.creditNote(k1, 21000)

    const err = await splitNote(`${m.url}/w/cb`, [k1], 5000, {
      mutationRetries: 0
    }).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMutationError)
    expect(err.newSecrets).toHaveLength(2)
    const [split, change] = err.newSecrets
    expect((await fetchNoteInfo(noteUrl(m, split))).maxWithdrawable).toBe(5000)
    expect((await fetchNoteInfo(noteUrl(m, change))).maxWithdrawable).toBe(16000)
  })

  // A SERVICE that refuses to replay leaves the caller exactly where not
  // retrying would have: the same secrets, the same instruction to go and
  // ask what the note at each hash is worth. Retrying costs nothing against
  // a mint that has not caught up.
  it('leaves the caller no worse off against a mint that will not replay', async () => {
    const m = await mint({dropAfterMutation: true, retriedMutation: 'refuse'})
    const k1 = secret('82')
    m.state.creditNote(k1, 21000)

    const err = await rotateNote(`${m.url}/w/cb`, k1).catch(e => e)
    const rescued = newSecretsOf(err)
    expect(rescued).toHaveLength(1)
    expect(m.state.noteState(rescued[0]!)).toBe('outstanding')
  })

  it('probes a burned input to resolve the ambiguity', async () => {
    const m = await mint({dropAfterMutation: true})
    const k1 = secret('52')
    m.state.creditNote(k1, 21000)
    await rotateNote(`${m.url}/w/cb`, k1).catch(() => {})
    // gone: the burn landed, so the rescued secret is the only money left
    expect(await probeBurnedNote(noteUrl(m, k1))).toBe('gone')

    const live = await mint()
    const alive = secret('53')
    live.state.creditNote(alive, 21000)
    expect(await probeBurnedNote(noteUrl(live, alive))).toBe('live')

    // a probe that cannot reach the service resolves nothing
    expect(await probeBurnedNote(noteUrl(live, alive), {offline: true})).toBe(
      'unknown'
    )
  })

  it('treats a 200 that confirms nothing as ambiguous', async () => {
    const m = await mint({unconfirmedMutation: true})
    const k1 = secret('54')
    m.state.creditNote(k1, 21000)
    const err = await rotateNote(`${m.url}/w/cb`, k1, {
      mutationRetries: 0
    }).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMutationError)
    expect(m.state.noteState(k1)).toBe('burned')
  })

  // The same mint, asked twice. An unconfirmed answer is ambiguous, and the
  // replay branch answers a repeat before it ever reaches the code that
  // would decline to confirm - so the retry resolves it.
  it('resolves an unconfirmed mutation by asking again', async () => {
    const m = await mint({unconfirmedMutation: true})
    const k1 = secret('83')
    m.state.creditNote(k1, 21000)
    const rotated = await rotateNote(`${m.url}/w/cb`, k1)
    expect(m.state.noteState(k1)).toBe('burned')
    expect(m.state.noteState(rotated.k1)).toBe('outstanding')
  })

  it('treats an unreadable response as ambiguous', async () => {
    const m = await mint({malformedJson: true})
    const k1 = secret('55')
    m.state.creditNote(k1, 21000)
    const err = await rotateNote(`${m.url}/w/cb`, k1).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMutationError)
  })

  it('treats a timeout as ambiguous, not as failure', async () => {
    const m = await mint({slowMs: 200})
    const k1 = secret('56')
    m.state.creditNote(k1, 21000)
    const err = await rotateNote(`${m.url}/w/cb`, k1, {timeoutMs: 30}).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMutationError)
  })

  it('treats a refused request as definitely not sent', async () => {
    const m = await mint()
    const k1 = secret('57')
    m.state.creditNote(k1, 21000)
    // offline mode is not ambiguity: nothing left the process
    const err = await rotateNote(`${m.url}/w/cb`, k1, {offline: true}).catch(e => e)
    expect(err).toBeInstanceOf(RequestRefusedError)
    expect(err).not.toBeInstanceOf(AmbiguousMintError)
    expect(m.state.noteState(k1)).toBe('outstanding')
  })

  it('refuses a callback URL it would not fetch', async () => {
    const m = await mint()
    const k1 = secret('58')
    m.state.creditNote(k1, 21000)
    await expect(
      rotateNote('http://evil.example/cb', k1)
    ).rejects.toBeInstanceOf(RequestRefusedError)
  })
})

describe('a service that lies about value', () => {
  it('cannot inflate a note past what it signed', async () => {
    const m = await mint({lieAboutValue: 1_000_000})
    const k1 = secret('60')
    const signature = m.state.creditNote(k1, 21000)

    const info = await fetchNoteInfo(noteUrl(m, k1))
    expect(info.maxWithdrawable).toBe(1_021_000)
    // the signature was issued over the true amount, so the inflated one
    // does not verify - an offline holder can catch this without asking
    expect(verifyNoteSignature(k1, info.maxWithdrawable, signature!, m.state.pubkey)).toBe(false)
    expect(verifyNoteSignature(k1, 21000, signature!, m.state.pubkey)).toBe(true)
  })
})

describe('restore from a seed', () => {
  // any 32 bytes will do as a seed here; the derivation's own known answers
  // live in derivation.test.ts
  const root = deriveNoteRoot(hexToBytes('7e'.repeat(32)))

  it('finds every derived note and reports the next free index', async () => {
    const m = await mint()
    const host = new URL(m.url).host
    for (const index of [0, 1, 2]) {
      m.state.creditNote(deriveNoteSecret(root, host, index), 21000 * (index + 1))
    }

    const result = await restoreNotes(`${m.url}/w`, root, host, {
      allowSecretDisclosure: true
    })
    expect(result.found.map(n => n.index)).toEqual([0, 1, 2])
    expect(result.found.map(n => n.amountMsat)).toEqual([21000, 42000, 63000])
    expect(result.found.every(n => n.state === 'live')).toBe(true)
    expect(result.next).toBe(23)
  })

  it('finds nothing at a mint the seed never minted at', async () => {
    const m = await mint()
    const host = new URL(m.url).host
    expect(
      await restoreNotes(`${m.url}/w`, root, host, {allowSecretDisclosure: true})
    ).toEqual({
      found: [],
      unresolved: [],
      // every index the walk touched had its secret disclosed, so none of
      // them can be minted into later
      next: 20,
      hashLookupsConfirmed: false,
      disclosesSecrets: true
    })
  })

  it('walks over a gap left by an index that was never spent', async () => {
    const m = await mint()
    const host = new URL(m.url).host
    // index 1 was drawn and the wallet died before the wire call - the
    // counter moved, the mint never heard of it
    m.state.creditNote(deriveNoteSecret(root, host, 0), 1000)
    m.state.creditNote(deriveNoteSecret(root, host, 5), 2000)

    const result = await restoreNotes(`${m.url}/w`, root, host, {
      allowSecretDisclosure: true
    })
    expect(result.found.map(n => n.index)).toEqual([0, 5])
    expect(result.next).toBe(26)
  })

  it('stops after `gap` consecutive unknown indices', async () => {
    const m = await mint()
    const host = new URL(m.url).host
    m.state.creditNote(deriveNoteSecret(root, host, 0), 1000)
    m.state.creditNote(deriveNoteSecret(root, host, 5), 2000)

    // a gap of three never reaches index 5
    const result = await restoreNotes(`${m.url}/w`, root, host, {
      gap: 3,
      allowSecretDisclosure: true
    })
    expect(result.found.map(n => n.index)).toEqual([0])
    expect(result.next).toBe(4)
  })

  it('counts a spent index as used, and does not report it as a note', async () => {
    const m = await mint()
    const host = new URL(m.url).host
    const spent = deriveNoteSecret(root, host, 0)
    m.state.creditNote(spent, 21000)
    const info = await fetchNoteInfo(noteUrl(m, spent))
    await rotateNote(info.callback, spent)

    const result = await restoreNotes(`${m.url}/w`, root, host, {
      allowSecretDisclosure: true
    })
    expect(result.found).toEqual([])
    // re-deriving index 0 would mint a note the service already burned, and
    // 1..20 had their secrets disclosed by the walk that looked for more
    expect(result.next).toBe(21)
  })

  it('resumes from a start index without re-walking what came before', async () => {
    const m = await mint()
    const host = new URL(m.url).host
    m.state.creditNote(deriveNoteSecret(root, host, 0), 1000)
    m.state.creditNote(deriveNoteSecret(root, host, 7), 2000)

    const result = await restoreNotes(`${m.url}/w`, root, host, {
      start: 7,
      allowSecretDisclosure: true
    })
    expect(result.found.map(n => n.index)).toEqual([7])
    expect(result.next).toBe(28)
  })

  it('records a note the service reports as pending, with no amount', async () => {
    const host = 'mint.example'
    const k1 = deriveNoteSecret(root, host, 0)
    const stub: typeof fetch = async input => {
      // asked by hash, so match the hash - the secret never goes out
      const queried = new URL(input.toString()).searchParams.get('h')
      const body =
        queried === hashK1(k1)
          ? {status: 'ERROR', reason: 'pending'}
          : {status: 'ERROR', reason: 'Unknown note.'}
      return new Response(JSON.stringify(body), {
        headers: {'content-type': 'application/json'}
      })
    }
    const result = await restoreNotes(
      'https://mint.example/w',
      root,
      host,
      {gap: 2},
      {fetch: stub}
    )
    expect(result.found).toEqual([
      {index: 0, k1, scheme: 'hmac', amountMsat: null, state: 'pending'}
    ])
    expect(result.next).toBe(1)
  })

  it('throws rather than reporting a short walk when the mint goes away', async () => {
    await expect(
      restoreNotes('https://mint.example/w', root, 'mint.example', {}, {offline: true})
    ).rejects.toBeInstanceOf(RequestRefusedError)
  })

  it('restores what a derived-secret wallet actually minted', async () => {
    const m = await mint()
    const host = new URL(m.url).host
    // the wallet's whole life: one credited note, rotated twice, then split
    const source = derivedSecretSource(root, host, 0)
    const options = {randomSecret: source}
    const first = deriveNoteSecret(root, host, 99)
    m.state.creditNote(first, 100_000)

    const {callback} = await fetchNoteInfo(noteUrl(m, first))
    const rotated = await rotateNote(callback, first, options)
    const again = await rotateNote(callback, rotated.k1, options)
    const split = await splitNote(callback, [again.k1], 40_000, options)
    // rotate, rotate, split: four indices consumed
    expect(source.index()).toBe(4)

    const result = await restoreNotes(`${m.url}/w`, root, host, {
      allowSecretDisclosure: true
    })
    expect(result.found.map(n => n.index)).toEqual([2, 3])
    expect(result.found.map(n => n.k1)).toEqual([split.k1, split.change])
    expect(result.found.map(n => n.amountMsat)).toEqual([40_000, 60_000])
    expect(result.next).toBe(24)
  })
})

describe('a mutation the transport retried', () => {
  // Exactly what a browser does with a stale keep-alive connection, and what
  // Go and the JDK do with an idempotent method: send it again, byte for
  // byte, and hand back the second answer. The mint applied the first one.
  //
  // This used to be the sharpest edge in the whole protocol: the second
  // answer said "already spent", the library had to report a definitive
  // refusal for a mutation that had definitely happened, and the only
  // defence was to carry the secrets out on the error and make the caller
  // go and check. LUD-25 closed it - a SERVICE MUST answer the identical
  // request with the success it already gave - so an unstoppable transport
  // retry is now simply invisible.
  const retryingFetch: typeof fetch = async (input, init) => {
    await fetch(input as string, init)
    return fetch(input as string, init)
  }

  it('is invisible to a rotate: the retry replays the original success', async () => {
    const m = await mint()
    const k1 = secret('70')
    m.state.creditNote(k1, 21_000)
    const {callback} = await fetchNoteInfo(noteUrl(m, k1))

    const rotated = await rotateNote(callback, k1, {fetch: retryingFetch})
    expect(m.state.noteState(k1)).toBe('burned')
    expect(m.state.noteState(rotated.k1)).toBe('outstanding')
    expect((await fetchNoteInfo(noteUrl(m, rotated.k1))).maxWithdrawable).toBe(21_000)
    // and it is signed: the replay repeats the signature, so a note
    // recovered this way is as verifiable as any other
    expect(rotated.signature).toBeDefined()
  })

  it('is invisible to a split, both outputs and both signatures', async () => {
    const m = await mint()
    const k1 = secret('71')
    m.state.creditNote(k1, 100_000)
    const {callback} = await fetchNoteInfo(noteUrl(m, k1))

    const split = await splitNote(callback, [k1], 40_000, {fetch: retryingFetch})
    expect((await fetchNoteInfo(noteUrl(m, split.k1))).maxWithdrawable).toBe(40_000)
    expect((await fetchNoteInfo(noteUrl(m, split.change))).maxWithdrawable).toBe(60_000)
    expect(split.signature).toBeDefined()
    expect(split.changeSignature).toBeDefined()
  })

  it('is invisible to a merge, whatever order the k1 arrive in', async () => {
    const m = await mint()
    const a = secret('72')
    const b = secret('73')
    m.state.creditNote(a, 21_000)
    m.state.creditNote(b, 34_000)
    const {callback} = await fetchNoteInfo(noteUrl(m, a))

    const merged = await mergeNotes(callback, [a, b], {fetch: retryingFetch})
    expect((await fetchNoteInfo(noteUrl(m, merged.k1))).maxWithdrawable).toBe(55_000)
  })

  // The old world, kept as a fixture: a mint that has not implemented the
  // replay rule still answers the second attempt as an already-spent input.
  // The library cannot tell that from a genuine double spend - at the wire
  // they are the same answer - so it does what it always did and hands the
  // secrets back rather than a verdict.
  it('hands the secrets back against a mint that will not replay', async () => {
    const m = await mint({retriedMutation: 'refuse'})
    const k1 = secret('84')
    m.state.creditNote(k1, 21_000)
    const {callback} = await fetchNoteInfo(noteUrl(m, k1))

    const err = await rotateNote(callback, k1, {fetch: retryingFetch}).catch(e => e)
    expect(err).toBeInstanceOf(NoteSpentError)

    // it really did mint against the hash the first attempt disclosed, and
    // this is the only copy of that secret in existence
    const recovered = newSecretsOf(err)
    expect(recovered).toHaveLength(1)
    expect(m.state.noteState(recovered[0]!)).toBe('outstanding')
    const info = await fetchNoteInfo(noteUrl(m, recovered[0]!))
    expect(info.maxWithdrawable).toBe(21_000)
  })

  it('carries a secret from a genuine double spend too, which probes as gone', async () => {
    const m = await mint()
    const k1 = secret('74')
    m.state.creditNote(k1, 21_000)
    const {callback} = await fetchNoteInfo(noteUrl(m, k1))
    await rotateNote(callback, k1)

    // the same note offered again, long after: an honest refusal
    const err = await rotateNote(callback, k1).catch(e => e)
    expect(err).toBeInstanceOf(NoteSpentError)
    const [orphan] = newSecretsOf(err)
    // the secrets ride the error either way, because the library cannot tell
    // the two apart - which is why a caller must ASK rather than assume
    expect(orphan).toBeDefined()
    expect(await probeBurnedNote(noteUrl(m, orphan!))).toBe('gone')
  })

  it('carries nothing when the refusal cannot be a landed mutation', async () => {
    const m = await mint({sunset: true})
    const k1 = secret('75')
    m.state.creditNote(k1, 100_000)
    const {callback} = await fetchNoteInfo(noteUrl(m, k1))

    const err = await splitNote(callback, [k1], 40_000).catch(e => e)
    expect(err).toBeInstanceOf(ServiceRejectedError)
    expect(err).not.toBeInstanceOf(NoteSpentError)
    // a mint refusing on policy burned nothing, so there is nothing to keep
    // and the caller may discard its staged records at once
    expect(newSecretsOf(err)).toEqual([])
    expect(m.state.noteState(k1)).toBe('outstanding')
  })

  it('reads the secrets off an ambiguous mutation the same way', async () => {
    const m = await mint({dropAfterMutation: true})
    const k1 = secret('76')
    m.state.creditNote(k1, 21_000)
    const {callback} = await fetchNoteInfo(noteUrl(m, k1))

    const err = await rotateNote(callback, k1, {mutationRetries: 0}).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMutationError)
    // one helper, both error families: persist whatever it returns
    expect(newSecretsOf(err)).toEqual(err.newSecrets)
    expect(newSecretsOf(err)).toHaveLength(1)
  })

  it('returns nothing for an error that carries no secrets at all', () => {
    expect(newSecretsOf(new Error('something else'))).toEqual([])
    expect(newSecretsOf(undefined)).toEqual([])
    expect(newSecretsOf('not an error')).toEqual([])
  })
})

describe('a restore that does not put the money on the wire', () => {
  // Any valid compressed secp256k1 point. Nothing here verifies a
  // signature - the restore walk only reads amounts - but the response has
  // to be a conforming one to be read at all.
  const MINT_PUBKEY =
    '034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa'
  const root = deriveNoteRoot(hexToBytes('44'.repeat(32)))
  const HOST = 'mint.example'
  const BASE = 'https://mint.example/w'

  // A SERVICE that answers the informational GET by hash, as LUD-25's
  // "Checking a note without exposing it" describes: same response, no
  // echoed k1, and the secret never on the wire.
  const service = (
    notes: Map<string, number>,
    seenK1s: string[],
    {answersByHash = true, reasonFor = (_key: string): string => 'Unknown note.'} = {}
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
          ? {status: 'ERROR', reason: reasonFor(key ?? '')}
          : {
              tag: 'withdrawRequest',
              callback: `${BASE}/cb`,
              maxWithdrawable: amount,
              minWithdrawable: 0,
              // Mandatory since offline verification stopped being
              // optional: a restore reads the same informational GET every
              // other lookup does, and a SERVICE that publishes no key is
              // refused there like anywhere else.
              mintPubkey: MINT_PUBKEY,
              ...(k1 ? {k1} : {})
            }
      return new Response(JSON.stringify(body), {
        headers: {'content-type': 'application/json'}
      })
    }) as typeof fetch

  const noteAt = (index: number, msat: number, into: Map<string, number>) => {
    const k1 = deriveNoteSecret(root, HOST, index)
    into.set(hashK1(k1), msat)
    return k1
  }

  it('finds the notes without disclosing a single secret', async () => {
    const notes = new Map<string, number>()
    const first = noteAt(0, 21_000, notes)
    const second = noteAt(1, 42_000, notes)
    const seen: string[] = []

    const result = await restoreNotes(BASE, root, HOST, {}, {fetch: service(notes, seen)})

    expect(result.found.map(n => n.k1)).toEqual([first, second])
    expect(result.found.map(n => n.amountMsat)).toEqual([21_000, 42_000])
    expect(result.disclosesSecrets).toBe(false)
    expect(result.hashLookupsConfirmed).toBe(true)
    expect(seen).toEqual([])
    // nothing was disclosed, so the very next index is still safe to mint into
    expect(result.next).toBe(2)
  })

  // The reason the walk asks by hash at all. It queries `gap` indices PAST
  // the last note in use, and those are exactly the ones the wallet is about
  // to mint into: asking by secret publishes the next twenty secrets the
  // wallet will ever use, and then it goes and uses them.
  it('never hands back an index whose secret it disclosed', async () => {
    const notes = new Map<string, number>()
    noteAt(0, 21_000, notes)
    const seen: string[] = []

    const result = await restoreNotes(
      BASE,
      root,
      HOST,
      {gap: 5, allowSecretDisclosure: true},
      {fetch: service(notes, seen, {answersByHash: false})}
    )

    expect(result.disclosesSecrets).toBe(true)
    expect(seen.length).toBe(6)
    const nextSecret = deriveNoteSecret(root, HOST, result.next)
    expect(seen).not.toContain(nextSecret)
    expect(result.next).toBe(6)
  })

  it('refuses to call a wallet empty when it never proved the service answers by hash', async () => {
    const seen: string[] = []
    await expect(
      restoreNotes(
        BASE,
        root,
        HOST,
        {gap: 3},
        {fetch: service(new Map(), seen, {answersByHash: false})}
      )
    ).rejects.toBeInstanceOf(HashLookupUnsupportedError)
    // and it did not quietly fall back to the disclosing form
    expect(seen).toEqual([])
  })

  it('accepts a probe as proof, so a genuinely empty wallet reports empty', async () => {
    const notes = new Map<string, number>()
    // a note this seed does not derive: the caller knows it exists, which
    // is the whole point of a positive control
    const probe = 'ab'.repeat(32)
    notes.set(hashK1(probe), 1000)

    const result = await restoreNotes(
      BASE,
      root,
      HOST,
      {gap: 3, probeK1: probe},
      {fetch: service(notes, [])}
    )
    expect(result.found).toEqual([])
    expect(result.hashLookupsConfirmed).toBe(true)
    expect(result.next).toBe(0)
  })

  // The gap counter is what decides where a walk stops, so anything that
  // advances it wrongly abandons live notes beyond the run - silently, and
  // with a `next` that looks perfectly reasonable.
  it('does not spend the gap on a refusal it has no name for', async () => {
    const notes = new Map<string, number>()
    const zero = deriveNoteSecret(root, HOST, 0)
    const beyond = noteAt(2, 7_000, notes)
    const seen: string[] = []

    const result = await restoreNotes(
      BASE,
      root,
      HOST,
      {gap: 2},
      {
        fetch: service(notes, seen, {
          reasonFor: key => (key === hashK1(zero) ? 'note expired' : 'Unknown note.')
        })
      }
    )

    // index 0 was refused for a reason this version has never heard of. It
    // is not a note, but the service plainly knows the index, so the gap
    // counter resets and the walk reaches the live note at 2. Advance it
    // instead and the walk stops at index 1, and that note is lost.
    expect(result.unresolved).toEqual([
      {index: 0, k1: zero, scheme: 'hmac', reason: 'note expired'}
    ])
    expect(result.found.map(n => n.k1)).toEqual([beyond])
    expect(result.next).toBe(3)
  })

  it('still throws when the service itself fails, rather than reporting a next it never established', async () => {
    const failing: typeof fetch = async () =>
      new Response('nope', {status: 500, headers: {'content-type': 'text/plain'}})
    await expect(
      restoreNotes(BASE, root, HOST, {gap: 2}, {fetch: failing})
    ).rejects.toBeTruthy()
  })
})
