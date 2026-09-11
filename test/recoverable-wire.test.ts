import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {
  RequestRefusedError,
  buildNoteInfoUrlByHash,
  fetchNoteInfoByHash,
  hashK1,
  mergeNotesWithHash,
  noteIdOf,
  noteLookupOf,
  noteSignatureMessage,
  requestInvoice,
  resolveNoteInput,
  rotateNoteWithHash,
  splitNoteWithHash
} from '../src/index.js'

// The Part 2 wire: a ck1 wherever a k1 goes, a cp1 wherever an output goes.
const vectors = JSON.parse(readFileSync(new URL('./vectors/part2.json', import.meta.url), 'utf8'))
const [a, b, c] = vectors.branches[0].notes as {notePubkey: string; cp1: string; ck1: string}[]
const cs1 = vectors.certificates[0].cs1 as string
const K1 = '11'.repeat(32)
const CB = 'https://mint.example/w/cb'

// Records every request and answers each with `body`.
const capture = (body: unknown) => {
  const urls: URL[] = []
  const fetch: typeof globalThis.fetch = async input => {
    urls.push(new URL(String(input instanceof Request ? input.url : input)))
    return new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}})
  }
  return {urls, fetch}
}

describe('noteIdOf and noteLookupOf', () => {
  it('file a Part 1 secret under its hash, and look it up by that hash', () => {
    expect(noteIdOf(K1)).toBe(hashK1(K1))
    expect(noteLookupOf(K1)).toBe(hashK1(K1))
  })

  it('file a Part 2 note under the key its ck1 recovers to, and look it up by its cp1', () => {
    expect(noteIdOf(a!.ck1)).toBe(a!.notePubkey)
    expect(noteIdOf(a!.ck1.toUpperCase())).toBe(a!.notePubkey)
    expect(noteLookupOf(a!.ck1)).toBe(a!.cp1)
  })

  it('refuse anything else', () => {
    const corrupted = a!.ck1.slice(0, -1) + (a!.ck1.endsWith('q') ? 'p' : 'q')
    for (const bad of ['', 'zz', '11'.repeat(31), a!.cp1, cs1, corrupted]) {
      expect(noteIdOf(bad)).toBeNull()
      expect(noteLookupOf(bad)).toBeNull()
    }
  })

  it('build the signed message over the key for a ck1', () => {
    expect(noteSignatureMessage(a!.ck1, 21000)).toBe(`LNURLcash:21000:${a!.notePubkey}`)
    expect(() => noteSignatureMessage('not a k1', 21000)).toThrow()
  })
})

describe('note URLs and lookups', () => {
  it('take a note URL carrying a ck1', () => {
    const url = `https://mint.example/w?k1=${a!.ck1}&amount=21000&sig=${cs1}`
    expect(resolveNoteInput(url)).toBe(url)
    expect(resolveNoteInput(`https://mint.example/w?k1=${a!.cp1}&amount=21000`)).toBeNull()
  })

  it('look a Part 2 note up by p, and a hash by h', async () => {
    expect(new URL(buildNoteInfoUrlByHash('https://mint.example/w', a!.cp1)).searchParams.get('p')).toBe(a!.cp1)
    const byHash = new URL(buildNoteInfoUrlByHash('https://mint.example/w', hashK1(K1)))
    expect(byHash.searchParams.get('h')).toBe(hashK1(K1))
    expect(byHash.searchParams.has('p')).toBe(false)
    expect(() => buildNoteInfoUrlByHash('https://mint.example/w', a!.ck1)).toThrow()

    const {urls, fetch} = capture({
      tag: 'withdrawRequest',
      callback: CB,
      minWithdrawable: 21000,
      maxWithdrawable: 21000,
      mintPubkey: vectors.mint.mintPubkey,
      sig: cs1
    })
    const info = await fetchNoteInfoByHash('https://mint.example/w', noteLookupOf(a!.ck1)!, {fetch})
    expect(urls[0]!.searchParams.get('p')).toBe(a!.cp1)
    expect(urls[0]!.searchParams.has('k1')).toBe(false)
    expect(info.maxWithdrawable).toBe(21000)
  })
})

describe('mutations', () => {
  it('rotate a ck1 into a cp1, sent as p1, keeping the cs1 it gets back', async () => {
    const {urls, fetch} = capture({status: 'OK', sig: cs1})
    const result = await rotateNoteWithHash(CB, a!.ck1, b!.cp1, {fetch})
    expect(urls[0]!.searchParams.get('k1')).toBe(a!.ck1)
    expect(urls[0]!.searchParams.get('p1')).toBe(b!.cp1)
    expect(urls[0]!.searchParams.has('h')).toBe(false)
    expect(result.signature).toBe(cs1)
  })

  it('keep h for a hash output, which every mint understands', async () => {
    const {urls, fetch} = capture({status: 'OK', sig: '00'.repeat(65)})
    await rotateNoteWithHash(CB, a!.ck1, hashK1(K1), {fetch})
    expect(urls[0]!.searchParams.get('h')).toBe(hashK1(K1))
    expect(urls[0]!.searchParams.has('p1')).toBe(false)
  })

  it('split into a key and a hash, each under its own name', async () => {
    const {urls, fetch} = capture({status: 'OK', sig: cs1, sig2: '00'.repeat(65)})
    await splitNoteWithHash(CB, [a!.ck1], 5000, b!.cp1, hashK1(K1), {fetch})
    const q = urls[0]!.searchParams
    expect([q.get('p1'), q.get('h2'), q.has('h'), q.has('p2')]).toEqual([b!.cp1, hashK1(K1), false, false])
  })

  it('merge a Part 1 secret and a Part 2 note in one request', async () => {
    const {urls, fetch} = capture({status: 'OK', sig: cs1})
    await mergeNotesWithHash(CB, [K1, a!.ck1], c!.cp1, {fetch})
    expect(urls[0]!.searchParams.getAll('k1')).toEqual([K1, a!.ck1])
    expect(urls[0]!.searchParams.get('p1')).toBe(c!.cp1)
  })
})

describe('minting to a key', () => {
  const pr = 'lnbc210n1pjqrstuvwxyz'

  it('sends a cp1 as the comment alone', async () => {
    const {urls, fetch} = capture({pr})
    await requestInvoice('https://mint.example/p/cb', 21000, {h: a!.cp1, fetch})
    expect(urls[0]!.searchParams.get('comment')).toBe(a!.cp1)
    expect(urls[0]!.searchParams.has('h')).toBe(false)
  })

  it('sends a hash as both comment and h, as before', async () => {
    const {urls, fetch} = capture({pr})
    await requestInvoice('https://mint.example/p/cb', 21000, {h: hashK1(K1), fetch})
    expect(urls[0]!.searchParams.get('comment')).toBe(hashK1(K1))
    expect(urls[0]!.searchParams.get('h')).toBe(hashK1(K1))
  })

  it('refuses anything else before asking for an invoice', async () => {
    const {urls, fetch} = capture({pr})
    await expect(requestInvoice('https://mint.example/p/cb', 21000, {h: a!.ck1, fetch})).rejects.toThrow(
      RequestRefusedError
    )
    expect(urls).toHaveLength(0)
  })
})
