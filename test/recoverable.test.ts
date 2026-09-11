import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {cashNodeToHex, deriveCashDomainNode, deriveCashRoot} from '../src/cash.js'
import {
  cashNodeToCx1,
  decodeCk1,
  decodeCp1,
  decodeCs1,
  decodeCx1,
  deriveCashAddressNode,
  deriveNotePubkey,
  deriveNoteSecretKey,
  encodeCk1,
  encodeCp1,
  encodeCs1,
  encodeCx1,
  isCk1,
  isCp1,
  isCs1,
  isCx1,
  recoverNoteOwnershipPubkey,
  signNoteOwnership
} from '../src/recoverable.js'
import {verifyNoteSignature, verifyNoteSignatureHash} from '../src/signature.js'

// Generated from lnurl-wallet's own code and checked against lnurl-mint's;
// see the file's `source` and `conventions`.
const vectors = JSON.parse(
  readFileSync(new URL('./vectors/part2.json', import.meta.url), 'utf8')
)

type NoteVector = {
  index: number
  notePubkey: string
  cp1: string
  noteSecretKey: string
  ownershipSignature: string
  ck1: string
}
type BranchVector = {
  seed: string
  cashRoot: string
  host: string
  addressNode: string
  branchPubkey: string
  branchParity: 'even' | 'odd'
  chainCode: string
  cx1: string
  notes: NoteVector[]
}

const branches = vectors.branches as BranchVector[]
const hex = (bytes: Uint8Array | null) => (bytes ? bytesToHex(bytes) : null)

describe('the address branch', () => {
  it('covers both branch parities', () => {
    expect(new Set(branches.map(b => b.branchParity))).toEqual(new Set(['even', 'odd']))
  })

  for (const b of branches) {
    it(`derives lnurl-wallet's branch for ${b.host}`, () => {
      const root = deriveCashRoot(hexToBytes(b.seed))
      expect(cashNodeToHex(root)).toBe(b.cashRoot)
      const node = deriveCashAddressNode(root, b.host)
      expect(cashNodeToHex(node)).toBe(b.addressNode)
      const cx1 = cashNodeToCx1(node)
      expect(bytesToHex(cx1.pubkeyXOnly)).toBe(b.branchPubkey)
      expect(bytesToHex(cx1.chainCode)).toBe(b.chainCode)
      expect(encodeCx1(cx1.pubkeyXOnly, cx1.chainCode)).toBe(b.cx1)
    })
  }

  it('never shares a node with the Part 1 ladder', () => {
    const b = branches[0]!
    const root = deriveCashRoot(hexToBytes(b.seed))
    expect(cashNodeToHex(deriveCashAddressNode(root, b.host))).not.toBe(
      cashNodeToHex(deriveCashDomainNode(root, b.host))
    )
  })
})

describe('note keys and ownership signatures', () => {
  for (const b of branches) {
    it(`matches every vector on ${b.host} (${b.branchParity} branch)`, () => {
      const branchKey = hexToBytes(b.addressNode.slice(0, 64))
      const chainCode = hexToBytes(b.chainCode)
      const branchPubkey = hexToBytes(b.branchPubkey)
      for (const n of b.notes) {
        const pk = deriveNotePubkey(branchPubkey, chainCode, n.index)
        expect(bytesToHex(pk)).toBe(n.notePubkey)
        const sk = deriveNoteSecretKey(branchKey, chainCode, n.index)
        expect(bytesToHex(sk)).toBe(n.noteSecretKey)
        expect(encodeCp1(pk)).toBe(n.cp1)
        // RFC6979: re-deriving the key reproduces the same ck1, byte for byte
        const signature = signNoteOwnership(sk)
        expect(bytesToHex(signature)).toBe(n.ownershipSignature)
        expect(encodeCk1(signature)).toBe(n.ck1)
        expect(hex(recoverNoteOwnershipPubkey(signature))).toBe(n.notePubkey)
        expect(hex(decodeCk1(n.ck1))).toBe(n.ownershipSignature)
        expect(hex(decodeCp1(n.cp1))).toBe(n.notePubkey)
      }
    })
  }

  it('treats the index as a plain uint32, never hardened', () => {
    const b = branches[0]!
    const indices = b.notes.map(n => n.index)
    expect(indices).toContain(2 ** 31)
    expect(indices).toContain(2 ** 32 - 1)
  })

  it('refuses an index outside uint32', () => {
    const b = branches[0]!
    const p = hexToBytes(b.branchPubkey)
    const c = hexToBytes(b.chainCode)
    for (const bad of [-1, 2 ** 32, 1.5, Number.NaN]) {
      expect(() => deriveNotePubkey(p, c, bad)).toThrow(RangeError)
    }
  })

  it('does not recover a truncated or corrupted signature to the note', () => {
    const n = branches[0]!.notes[0]!
    const signature = hexToBytes(n.ownershipSignature)
    expect(recoverNoteOwnershipPubkey(signature.slice(0, 64))).toBeNull()
    const corrupted = signature.slice()
    corrupted[10]! ^= 0xff
    expect(hex(recoverNoteOwnershipPubkey(corrupted))).not.toBe(n.notePubkey)
  })
})

describe('mint certificates', () => {
  const mintPubkey = vectors.mint.mintPubkey as string
  const ck1Of = (pk: string) => branches[0]!.notes.find(n => n.notePubkey === pk)!.ck1

  for (const c of vectors.certificates as {notePubkey: string; amountMsat: number; signature: string; cs1: string}[]) {
    it(`verifies the certificate for ${c.amountMsat} msat`, () => {
      expect(encodeCs1(hexToBytes(c.signature))).toBe(c.cs1)
      expect(hex(decodeCs1(c.cs1))).toBe(c.signature)
      expect(verifyNoteSignatureHash(c.notePubkey, c.amountMsat, c.signature, mintPubkey)).toBe(true)
      // the recipient's check: a ck1 note and its cs1, offline
      expect(verifyNoteSignature(ck1Of(c.notePubkey), c.amountMsat, c.cs1, mintPubkey)).toBe(true)
      expect(verifyNoteSignature(ck1Of(c.notePubkey), c.amountMsat + 1, c.cs1, mintPubkey)).toBe(false)
    })
  }
})

describe('encodings', () => {
  const decoders = {cp1: decodeCp1, ck1: decodeCk1, cx1: decodeCx1} as const

  for (const bad of vectors.invalid as {type: keyof typeof decoders; value: string; why: string}[]) {
    it(`refuses ${bad.type}: ${bad.why}`, () => {
      expect(decoders[bad.type](bad.value)).toBeNull()
    })
  }

  for (const good of vectors.valid as {type: 'cp1'; value: string; bytes: string; why: string}[]) {
    it(`accepts ${good.type}: ${good.why}`, () => {
      expect(hex(decodeCp1(good.value))).toBe(good.bytes)
    })
  }

  it('tells the four types apart', () => {
    const b = branches[0]!
    const n = b.notes[0]!
    const cs1 = (vectors.certificates[0] as {cs1: string}).cs1
    expect([isCp1(n.cp1), isCk1(n.cp1), isCs1(n.cp1), isCx1(n.cp1)]).toEqual([true, false, false, false])
    expect([isCp1(n.ck1), isCk1(n.ck1), isCs1(n.ck1), isCx1(n.ck1)]).toEqual([false, true, false, false])
    expect([isCp1(cs1), isCk1(cs1), isCs1(cs1), isCx1(cs1)]).toEqual([false, false, true, false])
    expect([isCp1(b.cx1), isCk1(b.cx1), isCs1(b.cx1), isCx1(b.cx1)]).toEqual([false, false, false, true])
  })

  it('refuses to encode a payload of the wrong length', () => {
    expect(() => encodeCp1(new Uint8Array(33))).toThrow(RangeError)
    expect(() => encodeCk1(new Uint8Array(64))).toThrow(RangeError)
    expect(() => encodeCx1(new Uint8Array(32), new Uint8Array(31))).toThrow(RangeError)
  })

  it('never treats a plain hex k1 as a Part 2 value', () => {
    const k1 = '11'.repeat(32)
    expect([isCp1(k1), isCk1(k1), isCs1(k1), isCx1(k1)]).toEqual([false, false, false, false])
  })
})

describe('a branch rooted in a Nostr key', () => {
  // The same file heartwood-esp32's cash_key.rs grades against: the device
  // and this kit have to derive one branch from one identity key.
  const nostrVectors = JSON.parse(readFileSync(new URL('./vectors/nostr-seed.json', import.meta.url), 'utf8')) as {
    cases: {
      identity: string
      host: string
      seed: string
      addressNode: string
      cx1: string
      notes: {index: number; noteSecretKey: string; notePubkey: string; cp1: string; ck1: string}[]
    }[]
  }

  it('matches the vectors the heartwood derives', async () => {
    const {deriveNostrAddressNode, deriveNostrCashSeed} = await import('../src/recoverable.js')
    expect(nostrVectors.cases.length).toBeGreaterThan(0)
    for (const c of nostrVectors.cases) {
      const identity = hexToBytes(c.identity)
      expect(bytesToHex(deriveNostrCashSeed(identity))).toBe(c.seed)
      const node = deriveNostrAddressNode(identity, c.host)
      expect(cashNodeToHex(node)).toBe(c.addressNode)
      const {pubkeyXOnly, chainCode} = cashNodeToCx1(node)
      expect(encodeCx1(pubkeyXOnly, chainCode)).toBe(c.cx1)
      for (const n of c.notes) {
        const sk = deriveNoteSecretKey(node.privateKey, node.chainCode, n.index)
        expect(bytesToHex(sk)).toBe(n.noteSecretKey)
        expect(encodeCp1(deriveNotePubkey(pubkeyXOnly, chainCode, n.index))).toBe(n.cp1)
        expect(encodeCk1(signNoteOwnership(sk))).toBe(n.ck1)
      }
    }
  })

  it('refuses a key that is not 32 bytes', async () => {
    const {deriveNostrCashSeed} = await import('../src/recoverable.js')
    expect(() => deriveNostrCashSeed(new Uint8Array(31))).toThrow(RangeError)
  })
})
