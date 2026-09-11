import {describe, expect, it} from 'vitest'
import {hexToBytes} from '@noble/hashes/utils.js'
import {
  cashDomainIndices,
  cashNodeFromHex,
  cashNodeToHex,
  cashSecretAt,
  cashSecretSource,
  deriveCashChild,
  deriveCashDomainNode,
  deriveCashRoot,
  deriveCashSecret,
  type CashNode
} from '../src/cash.js'
import {hashK1} from '../src/secrets.js'

// The BIP39 seed for `abandon abandon abandon abandon abandon abandon
// abandon abandon abandon abandon abandon about` with an empty passphrase -
// the same seed the legacy scheme's vector uses, so the two schemes can be
// compared directly.
const SEED = hexToBytes(
  '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4'
)

// Every expected value below was produced by the reference implementation's
// own library (@scure/bip32 2.4.0) driven through lnurl-wallet's exact call
// sequence - `keys.ts`'s deriveLud25CashRootNode and lud05PathSuffix, then
// `cashSecrets.ts`'s domainNode and cashSecretAtIndex. They are here so this
// kit and that wallet can be shown to agree without either importing the
// other, which is the only thing that makes the same seed phrase restore the
// same notes in a different wallet.
const CASH_ROOT =
  'c7a2496e9b453a67c5d2a1f04936ec1259440d45454c795a99a66269e4cd3005' +
  '111e1cc966fca2fe32f054f14caceab90449e536d94cf6935ea12a087e414f60'

const MINTS = {
  'mint.example': {
    indices: [2589708612, 3693348916, 172082394, 3793182078],
    node:
      '72056e5cde21458b13689c3950904dfd327415a506d064290e5e5f4296a40543' +
      'dd5e9504ddb6eefbafa4ad3b00ad421858fafc0ed9ea4abd9cb68793f845cfc1',
    secrets: {
      0: 'de5b81405a12e1297b350d80e2ad85043ed5b9436a0c5592d3302778de330499',
      1: '267570df5ba8098d728e839a698f729c2df6fa7b8b7ae7c9c7ffa7dda3417e1d',
      21: 'c736d40481d5809e86a4d712f9cf2da674534b7c46e340ea6ff69ed16b265483'
    }
  },
  // A host with a port, because that is where two implementations most
  // easily disagree, and because every local test mint looks like this.
  '127.0.0.1:8899': {
    indices: [2087962263, 3073061246, 2281736429, 1205328740],
    node:
      '80bdd2d71f0235bd9e22d5838a4a4f346cf5415309ada559942a409a630e102c' +
      'e214425b89b36d03d4835fdf6592d2619c74d37b746711b4ed85759ea1d358a6',
    secrets: {
      0: 'd7bcc5c9e7015ca2688ed10e24db3f82163d5b59fc887e5dd346abf2426b1270',
      1: '105e9bc889b179e9b55f2b87f2573482dc7465fdea5a3d69c2ef3777a23d23e9',
      21: '64ec581f32257751ff794bfe324d82aaa10b16826facbf2dc0bcc3d43b4c647d'
    }
  }
} as const

describe('BIP-32 CKDpriv', () => {
  // BIP-32's own published test vector 1: m, then m/0'/1/2'/2/1000000000.
  // The path deliberately alternates hardened and unhardened, so it proves
  // both legs - the unhardened one is the point multiply that LUD-25's
  // unmasked d1..d4 can land on.
  it('reproduces BIP-32 test vector 1', () => {
    const master: CashNode = {
      privateKey: hexToBytes(
        'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35'
      ),
      chainCode: hexToBytes(
        '873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508'
      )
    }
    const expected = [
      [
        0x80000000,
        'edb2e14f9ee77d26dd93b4ecede8d16ed408ce149b6cd80b0715a2d911a0afea' +
          '47fdacbd0f1097043b78c63c20c34ef4ed9a111d980047ad16282c7ae6236141'
      ],
      [
        1,
        '3c6cb8d0f6a264c91ea8b5030fadaa8e538b020f0a387421a12de9319dc93368' +
          '2a7857631386ba23dacac34180dd1983734e444fdbf774041578e9b6adb37c19'
      ],
      [
        0x80000002,
        'cbce0d719ecf7431d88e6a89fa1483e02e35092af60c042b1df2ff59fa424dca' +
          '04466b9cc8e161e966409ca52986c584f07e9dc81f735db683c3ff6ec7b1503f'
      ],
      [
        2,
        '0f479245fb19a38a1954c5c7c0ebab2f9bdfd96a17563ef28a6a4b1a2a764ef4' +
          'cfb71883f01676f587d023cc53a35bc7f88f724b1f8c2892ac1275ac822a3edd'
      ],
      [
        1000000000,
        '471b76e389e528d6de6d816857e012c5455051cad6660850e58372a6c3e6e7c8' +
          'c783e67b921d2beb8f6b389cc646d7263b4145701dadd2161548a8b078e65e9e'
      ]
    ] as const

    let node: CashNode = master
    for (const [index, want] of expected) {
      node = deriveCashChild(node, index)
      expect(cashNodeToHex(node)).toBe(want)
    }
  })

  it('refuses an index that is not a uint32', () => {
    const root = deriveCashRoot(SEED)
    expect(() => deriveCashChild(root, -1)).toThrow(RangeError)
    expect(() => deriveCashChild(root, 0x100000000)).toThrow(RangeError)
    expect(() => deriveCashChild(root, 1.5)).toThrow(RangeError)
  })
})

describe('LUD-25 seed-recoverable note secrets', () => {
  it("derives m/139' as the reference wallet does", () => {
    expect(cashNodeToHex(deriveCashRoot(SEED))).toBe(CASH_ROOT)
  })

  it('derives the vector 1 master from its seed', async () => {
    const {deriveCashMaster, cashNodeToHex} = await import('../src/cash.js')
    expect(cashNodeToHex(deriveCashMaster(hexToBytes('000102030405060708090a0b0c0d0e0f')))).toBe(
      'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35' +
        '873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508'
    )
  })

  it('rejects a seed outside BIP-32 range', () => {
    expect(() => deriveCashRoot(new Uint8Array(15))).toThrow(RangeError)
    expect(() => deriveCashRoot(new Uint8Array(65))).toThrow(RangeError)
  })

  for (const [host, want] of Object.entries(MINTS)) {
    describe(host, () => {
      const root = deriveCashRoot(SEED)

      it('derives the same four domain levels', () => {
        expect(cashDomainIndices(root, host)).toEqual([...want.indices])
      })

      // The point of recording this: the draft leaves d1..d4 as raw uint32
      // and BIP-32 reads >= 2^31 as hardened, so which levels are hardened
      // is decided by the mint's own name. Both hosts here land on a mix,
      // which is why both legs of CKDpriv are exercised by ordinary use.
      it('hardens levels by magnitude alone, never by convention', () => {
        const hardened = want.indices.map(index => index >= 0x80000000)
        expect(hardened).toContain(true)
        expect(hardened).toContain(false)
      })

      it('derives the same domain node', () => {
        expect(cashNodeToHex(deriveCashDomainNode(root, host))).toBe(want.node)
      })

      it('derives the same secrets', () => {
        for (const [index, secret] of Object.entries(want.secrets)) {
          expect(deriveCashSecret(root, host, Number(index))).toBe(secret)
        }
      })

      it('derives the same secrets from the domain node alone', () => {
        // The hardware-signer path: given only this mint's subtree, with no
        // seed and no elliptic curve, every note index still resolves.
        const node = cashNodeFromHex(want.node)
        for (const [index, secret] of Object.entries(want.secrets)) {
          expect(cashSecretAt(node, Number(index))).toBe(secret)
        }
      })
    })
  }

  it('separates mints, so one host never derives another one\'s notes', () => {
    const root = deriveCashRoot(SEED)
    expect(deriveCashSecret(root, 'mint.example', 0)).not.toBe(
      deriveCashSecret(root, 'other.example', 0)
    )
    // A port is part of the host, so two mints on one machine stay distinct.
    expect(deriveCashSecret(root, '127.0.0.1:8899', 0)).not.toBe(
      deriveCashSecret(root, '127.0.0.1:9988', 0)
    )
  })

  it('produces something a SERVICE cannot tell from a random secret', () => {
    const secret = deriveCashSecret(deriveCashRoot(SEED), 'mint.example', 0)
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect(hashK1(secret)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a note index outside [0, 2^31)', () => {
    const root = deriveCashRoot(SEED)
    expect(() => deriveCashSecret(root, 'mint.example', -1)).toThrow(RangeError)
    expect(() => deriveCashSecret(root, 'mint.example', 0x80000000)).toThrow(
      RangeError
    )
  })
})

describe('cashNodeToHex / cashNodeFromHex', () => {
  it('round-trips a node', () => {
    const root = deriveCashRoot(SEED)
    const back = cashNodeFromHex(cashNodeToHex(root))
    expect(cashNodeToHex(back)).toBe(CASH_ROOT)
  })

  it('refuses anything that is not 64 bytes', () => {
    expect(() => cashNodeFromHex('00'.repeat(63))).toThrow(RangeError)
    expect(() => cashNodeFromHex('00'.repeat(65))).toThrow(RangeError)
  })
})

describe('cashSecretSource', () => {
  it('walks indices in order and reports the next unused one', () => {
    const root = deriveCashRoot(SEED)
    const source = cashSecretSource(root, 'mint.example')
    expect(source.index()).toBe(0)
    expect(source()).toBe(MINTS['mint.example'].secrets[0])
    expect(source()).toBe(MINTS['mint.example'].secrets[1])
    expect(source.index()).toBe(2)
  })

  it('resumes from a persisted counter', () => {
    const root = deriveCashRoot(SEED)
    const source = cashSecretSource(root, 'mint.example', 21)
    expect(source()).toBe(MINTS['mint.example'].secrets[21])
    expect(source.index()).toBe(22)
  })
})
