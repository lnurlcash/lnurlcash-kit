// Every assertion here comes from lnurlcash-conformance. Nothing in this
// file states what the protocol is - the vectors do, and this suite only
// binds them to the library's functions. A disagreement means one of the
// two is wrong, which is the entire point of keeping them separate.

import {describe, expect, it} from 'vitest'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {
  applyMintFee,
  cashDomainIndices,
  cashNodeToHex,
  deriveCashChild,
  deriveCashDomainNode,
  deriveCashRoot,
  deriveCashSecret,
  type CashNode,
  decodePaymentRequest,
  deriveNoteRoot,
  deriveNoteSecret,
  encodePaymentRequest,
  isPaymentRequest,
  PAYMENT_REQUEST_PREFIX,
  ProtocolError,
  mintFeeBand,
  withinMintFeeBand,
  decodeBolt11AmountMsat,
  formatFeePercent,
  fromBech32Lnurl,
  grossUpForMintFee,
  hashK1,
  isAllowedServiceUrl,
  isBolt11Invoice,
  isPreimage,
  buildNoteUrl,
  lightningAddressUsername,
  mintAddressUrl,
  noteDeclaredAmount,
  noteK1,
  noteSignature,
  noteSignatureDigest,
  noteSignatureMessage,
  parseMintFee,
  resolveLnurlInput,
  resolveMintInput,
  resolveNoteInput,
  sameInvoice,
  toBech32Lnurl,
  verifyNoteSignature,
  verifyNoteSignatureAgainst,
  withNewK1,
  withoutK1
} from '../src/index.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'

const require = createRequire(import.meta.url)
const load = (name: string): any =>
  JSON.parse(
    readFileSync(require.resolve(`lnurlcash-conformance/vectors/${name}`), 'utf8')
  )

// A vector file this library is already written against, but which the
// installed conformance release predates. Binding it conditionally is what
// lets the two repos ship in either order: the suite runs the cases the
// moment the vectors are published, and says plainly that it is not running
// them until then. It never passes by pretending the file was empty.
const loadIfPublished = (name: string): any | null => {
  try {
    return load(name)
  } catch {
    return null
  }
}

describe('signature vectors', () => {
  const vectors = load('signature.json')

  it('has cases to run', () => {
    expect(vectors.cases.length).toBeGreaterThan(5)
  })

  for (const c of vectors.cases) {
    it(`${c.valid ? 'accepts' : 'rejects'}: ${c.name}`, () => {
      expect(
        verifyNoteSignature(c.k1, c.amountMsat, c.signature, c.mintPubkey)
      ).toBe(c.valid)
    })
  }

  for (const c of vectors.cases.filter((c: any) => c.message !== null)) {
    it(`derives the signed message and digest for: ${c.name}`, () => {
      expect(noteSignatureMessage(c.k1, c.amountMsat)).toBe(c.message)
      expect(bytesToHex(noteSignatureDigest(c.k1, c.amountMsat))).toBe(c.digest)
    })
  }

  // A SERVICE that rotates its signing key publishes the retired ones as
  // `previousPubkeys`. Notes signed under those keys are still genuine, so
  // verification takes the current key and the history together.
  describe('against a key history', () => {
    const valid = vectors.cases.find((c: any) => c.valid)
    const rotated = `02${'cd'.repeat(32)}`

    it('accepts a note signed under any key in the list', () => {
      expect(
        verifyNoteSignature(valid.k1, valid.amountMsat, valid.signature, [
          rotated,
          valid.mintPubkey
        ])
      ).toBe(true)
    })

    it('reports which key signed', () => {
      expect(
        verifyNoteSignatureAgainst(valid.k1, valid.amountMsat, valid.signature, [
          rotated,
          valid.mintPubkey
        ])
      ).toEqual({valid: true, pubkey: valid.mintPubkey.toLowerCase()})
    })

    it('rejects when no key in the list signed it', () => {
      expect(
        verifyNoteSignature(valid.k1, valid.amountMsat, valid.signature, [
          rotated,
          `03${'ef'.repeat(32)}`
        ])
      ).toBe(false)
      expect(
        verifyNoteSignatureAgainst(valid.k1, valid.amountMsat, valid.signature, [
          rotated
        ])
      ).toEqual({valid: false, pubkey: null})
    })

    it('rejects an empty list rather than reading it as no objection', () => {
      expect(
        verifyNoteSignature(valid.k1, valid.amountMsat, valid.signature, [])
      ).toBe(false)
    })

    it('takes a single key exactly as before', () => {
      expect(
        verifyNoteSignatureAgainst(
          valid.k1,
          valid.amountMsat,
          valid.signature,
          valid.mintPubkey
        )
      ).toEqual({valid: true, pubkey: valid.mintPubkey.toLowerCase()})
    })
  })

  it('rejects a signature from the right key over the wrong note', () => {
    const valid = vectors.cases.find((c: any) => c.valid)
    expect(
      verifyNoteSignature(
        'c'.repeat(64),
        valid.amountMsat,
        valid.signature,
        valid.mintPubkey
      )
    ).toBe(false)
  })
})

describe('bech32 vectors', () => {
  const vectors = load('bech32.json')

  for (const c of vectors.encode) {
    it(`round-trips ${c.url.slice(0, 48)}`, () => {
      expect(toBech32Lnurl(c.url)).toBe(c.lnurl)
      expect(fromBech32Lnurl(c.lnurl)).toBe(c.url)
    })
  }

  for (const c of vectors.decodeInvalid) {
    it(`refuses to decode (${c.why})`, () => {
      expect(fromBech32Lnurl(c.input)).toBeNull()
    })
  }

  it('decodes either casing to the same URL', () => {
    const {lower, upper, url} = vectors.caseInsensitive
    expect(fromBech32Lnurl(lower)).toBe(url)
    expect(fromBech32Lnurl(upper)).toBe(url)
  })
})

describe('url admission vectors', () => {
  const vectors = load('url-admission.json')

  for (const url of vectors.allowed) {
    it(`allows ${url}`, () => {
      expect(isAllowedServiceUrl(url)).toBe(true)
    })
  }

  for (const c of vectors.rejected) {
    it(`rejects ${c.url || '(empty)'} - ${c.why}`, () => {
      expect(isAllowedServiceUrl(c.url)).toBe(false)
    })
  }
})

describe('input resolution vectors', () => {
  const vectors = load('input-resolution.json')

  for (const c of vectors.lnurl) {
    it(`resolves lnurl input ${JSON.stringify(c.input).slice(0, 56)}`, () => {
      expect(resolveLnurlInput(c.input)).toBe(c.expect)
    })
  }

  for (const c of vectors.mint) {
    it(`resolves mint input ${JSON.stringify(c.input).slice(0, 56)}`, () => {
      expect(resolveMintInput(c.input)).toBe(c.expect)
    })
  }

  for (const c of vectors.note) {
    it(`resolves note input ${JSON.stringify(c.input).slice(0, 56)}`, () => {
      expect(resolveNoteInput(c.input)).toBe(c.expect)
    })
  }

  for (const c of vectors.mintAddressUrl) {
    it(`mirrors ${c.payUrl} to the withdraw side`, () => {
      expect(mintAddressUrl(c.payUrl)).toBe(c.expect)
    })
  }

  for (const c of vectors.lightningAddressUsername) {
    it(`extracts the username from ${c.payUrl}`, () => {
      expect(lightningAddressUsername(c.payUrl)).toBe(c.expect)
    })
  }
})

describe('note url vectors', () => {
  const vectors = load('note-url.json')

  for (const c of vectors.parse) {
    it(`parses ${c.url.slice(0, 56)}`, () => {
      expect(noteK1(c.url)).toBe(c.k1)
      expect(noteDeclaredAmount(c.url)).toBe(c.declaredAmountMsat)
      expect(noteSignature(c.url)).toBe(c.signature)
    })
  }

  for (const c of vectors.build) {
    it(`builds a note on ${c.withdrawLink}`, () => {
      expect(
        c.amountMsat === null
          ? buildNoteUrl(c.withdrawLink, c.k1)
          : buildNoteUrl(c.withdrawLink, c.k1, c.amountMsat)
      ).toBe(c.expect)
    })
  }

  for (const c of vectors.withNewK1) {
    it('swaps in a new secret', () => {
      expect(withNewK1(c.url, c.k1, c.amountMsat, c.signature ?? undefined)).toBe(
        c.expect
      )
    })
  }

  for (const c of vectors.withoutK1) {
    it('blanks the secret for a device-held note', () => {
      expect(withoutK1(c.url, c.amountMsat, c.signature ?? undefined)).toBe(
        c.expect
      )
    })
  }
})

describe('fee vectors', () => {
  const vectors = load('fees.json')

  for (const c of vectors.parse) {
    it(`parses metadata ${c.metadata.slice(0, 56)}`, () => {
      expect(parseMintFee(c.metadata)).toEqual(c.expect)
    })
  }

  for (const c of vectors.apply) {
    it(`applies ${JSON.stringify(c.fee)} to ${c.grossMsat}`, () => {
      expect(applyMintFee(c.grossMsat, c.fee)).toBe(c.expect)
    })
  }

  for (const c of vectors.grossUp) {
    it(`grosses ${c.netMsat} up through ${JSON.stringify(c.fee)}`, () => {
      expect(grossUpForMintFee(c.netMsat, c.fee)).toBe(c.expect)
    })
  }

  it('grosses up to the exact minimum, for every fee and amount', () => {
    const {fees, netAmountsMsat} = vectors.grossUpRoundTrip
    for (const fee of fees) {
      for (const net of netAmountsMsat) {
        const gross = grossUpForMintFee(net, fee)
        expect(applyMintFee(gross, fee)).toBe(net)
        expect(applyMintFee(gross - 1, fee)).toBeLessThan(net)
      }
    }
  })

  for (const c of vectors.formatPercent) {
    it(`formats ${c.ppm} ppm`, () => {
      expect(formatFeePercent(c.ppm)).toBe(c.expect)
    })
  }
})

describe('bolt11 vectors', () => {
  const vectors = load('bolt11.json')

  for (const c of vectors.decodeAmountMsat) {
    it(`decodes the amount from ${c.pr || '(empty)'}`, () => {
      expect(decodeBolt11AmountMsat(c.pr)).toBe(c.expect)
    })
  }

  for (const c of vectors.isInvoice) {
    it(`${c.expect ? 'recognises' : 'rejects'} ${c.pr || '(empty)'}`, () => {
      expect(isBolt11Invoice(c.pr)).toBe(c.expect)
    })
  }

  for (const c of vectors.sameInvoice) {
    it(`compares ${c.a} with ${c.b}`, () => {
      expect(sameInvoice(c.a, c.b)).toBe(c.expect)
    })
  }

  for (const c of vectors.isPreimage) {
    it(`${c.expect ? 'accepts' : 'rejects'} preimage ${c.value.slice(0, 12) || '(empty)'}`, () => {
      expect(isPreimage(c.value)).toBe(c.expect)
    })
  }
})


describe('fee parsing beyond the vectors', () => {
  it('refuses fee digits past the safe-integer range', () => {
    const huge = '9'.repeat(20)
    expect(
      parseMintFee(JSON.stringify([['text/plain', `Mint fees: ${huge},0`]]))
    ).toBeNull()
    expect(
      parseMintFee(JSON.stringify([['text/plain', `Mint fees: 0,${huge}`]]))
    ).toBeNull()
  })
})

// The fee band. LUD-25 does not say whether the fee rounds, and the two
// live implementations disagree, so a wallet that predicts one number
// warns spuriously against the other. Both numbers below were measured on
// real sats on 2026-08-21.
describe('the mint fee band', () => {
  it('spans the reference mint and moneyer, which disagree', () => {
    // mint.forgesworn.dev (dni's lnurl-mint): 40_000 gross at 1000 + 1000ppm
    // credited 38_000, because it ceilings a 1_040 msat fee to 2_000.
    const fee = {baseFeeMsat: 1000, feePpm: 1000}
    const band = mintFeeBand(40_000, fee)
    expect(band.maxNetMsat).toBe(38_960) // the msat-exact formula
    expect(band.minNetMsat).toBe(38_000) // the sat-ceilinged fee
    expect(withinMintFeeBand(40_000, 38_000, fee)).toBe(true)
    expect(withinMintFeeBand(40_000, 38_960, fee)).toBe(true)
    // A msat past either edge is not explained by the rounding question.
    expect(withinMintFeeBand(40_000, 37_999, fee)).toBe(false)
    expect(withinMintFeeBand(40_000, 38_961, fee)).toBe(false)
  })

  it('collapses to a point when the fee already lands on a whole sat', () => {
    // moneyer.dev: 100_000 gross at 5000 + 1000ppm is exactly 5_100 msat,
    // so ceilinging gives 6_000 and the band is a real range...
    const moneyer = {baseFeeMsat: 5000, feePpm: 1000}
    expect(mintFeeBand(100_000, moneyer)).toEqual({minNetMsat: 94_000, maxNetMsat: 94_900})
    // ...but a fee that is already whole leaves nothing to round.
    const whole = {baseFeeMsat: 2000, feePpm: 0}
    expect(mintFeeBand(50_000, whole)).toEqual({minNetMsat: 48_000, maxNetMsat: 48_000})
  })

  it('never reports a negative net', () => {
    const fee = {baseFeeMsat: 10_000, feePpm: 0}
    expect(mintFeeBand(1_000, fee)).toEqual({minNetMsat: 0, maxNetMsat: 0})
  })

  it('agrees with applyMintFee at the generous edge', () => {
    for (const gross of [12_000, 55_055, 100_000, 21_000_000]) {
      for (const fee of [{baseFeeMsat: 0, feePpm: 0}, {baseFeeMsat: 1000, feePpm: 1000}, {baseFeeMsat: 5000, feePpm: 2500}]) {
        expect(mintFeeBand(gross, fee).maxNetMsat).toBe(applyMintFee(gross, fee))
      }
    }
  })
})

// Cross-implementation derivation cases. The library's own known answers
// live in derivation.test.ts; these are the same scheme as the conformance
// repo states it, which is what a Kotlin, Python or Go port checks itself
// against.
const derivation = loadIfPublished('derivation.json')

describe.skipIf(!derivation)('derivation vectors', () => {
  it('states the scheme this library implements', () => {
    expect(derivation.scheme.rootKey).toBe('lnurlcash-note-v1')
    expect(derivation.scheme.rootMsg).toBe('seed bytes')
    expect(derivation.scheme.secretMsg).toBe('host:index')
  })

  for (const c of derivation?.cases ?? []) {
    it(`derives ${c.host}:${c.index} - ${c.name}`, () => {
      const root = deriveNoteRoot(hexToBytes(c.seedHex))
      expect(deriveNoteSecret(root, c.host, c.index)).toBe(c.k1)
      expect(hashK1(c.k1)).toBe(c.noteId)
    })
  }
})

// LUD-25's own derivation, the m/139' BIP-32 scheme. Skipped until the
// conformance package publishes the file, like every other vector here.
const cashDerivation = loadIfPublished('cash-derivation.json')

describe.skipIf(!cashDerivation)('cash derivation vectors', () => {
  it('states the scheme this library implements', () => {
    expect(cashDerivation.scheme.purpose).toBe("m/139'")
    expect(cashDerivation.scheme.secretPath).toBe("m/139'/d1/d2/d3/d4/i'")
    // The one thing an implementation can silently get wrong: d1..d4 are raw
    // uint32 and hardened only when they happen to land >= 2^31.
    expect(cashDerivation.scheme.hardenedByMagnitudeOnly).toBe(true)
  })

  // BIP-32's own published vector, so a failure here says the CKDpriv step is
  // wrong rather than the LUD-25 path above it.
  it('agrees with BIP-32 test vector 1', () => {
    const steps = cashDerivation.bip32Vector1
    let node: CashNode = {
      privateKey: hexToBytes(steps[0].node.slice(0, 64)),
      chainCode: hexToBytes(steps[0].node.slice(64))
    }
    for (const step of steps.slice(1)) {
      node = deriveCashChild(node, step.index)
      expect(cashNodeToHex(node)).toBe(step.node)
    }
  })

  for (const c of cashDerivation?.cases ?? []) {
    it(`derives ${c.host} index ${c.index} - ${c.name}`, () => {
      const root = deriveCashRoot(hexToBytes(c.seedHex))
      expect(cashNodeToHex(root)).toBe(c.cashRoot)
      expect(cashDomainIndices(root, c.host)).toEqual(c.domainIndices)
      expect(cashNodeToHex(deriveCashDomainNode(root, c.host))).toBe(c.domainNode)
      expect(deriveCashSecret(root, c.host, c.index)).toBe(c.k1)
      expect(hashK1(c.k1)).toBe(c.noteId)
    })
  }
})

// Payment requests. The encoding is canonical, so a vector can state the
// exact string a request must produce and any implementation in any language
// has to produce it too.
const paymentRequests = loadIfPublished('payment-request.json')

describe.skipIf(!paymentRequests)('payment request vectors', () => {
  // The vector's clock, so an expiry case means the same thing every day.
  const now = paymentRequests?.evaluatedAt

  it('agrees on the prefix', () => {
    expect(paymentRequests.prefix).toBe(PAYMENT_REQUEST_PREFIX)
  })

  for (const c of paymentRequests?.encode ?? []) {
    it(`encodes: ${c.name}`, () => {
      expect(encodePaymentRequest(c.request)).toBe(c.encoded)
      // and back again, unchanged
      expect(decodePaymentRequest(c.encoded, {now: 0})).toEqual(c.request)
    })
  }

  for (const c of paymentRequests?.decode ?? []) {
    it(`${c.valid ? 'accepts' : `refuses (${c.reason})`}: ${c.name}`, () => {
      if (c.valid) {
        expect(decodePaymentRequest(c.input, {now})).toEqual(c.request)
        return
      }
      expect(() => decodePaymentRequest(c.input, {now})).toThrow(ProtocolError)
      // an expired request is still recognisably a payment request; a
      // malformed one is not
      if (c.reason !== 'expired') expect(isPaymentRequest(c.input)).toBe(false)
    })
  }
})
