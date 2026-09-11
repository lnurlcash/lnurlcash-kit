# lnurlcash-kit

LNURLcash ([LUD-25 draft](https://github.com/lnurl/luds/pull/301)) bearer
notes for TypeScript: mint, rotate, split, merge, melt, and verify a note
offline.

```bash
npm install lnurlcash-kit
```

This is an early `0.x` release tracking a **draft** spec. Pin an exact
version.

## What a bearer note is

An ordinary [LUD-03](https://github.com/lnurl/luds/blob/luds/03.md)
withdrawRequest link whose `k1` **is** the asset:

```
lnurlw://mint.example/w?k1=<secret>&amount=<msat>
```

Whoever knows the `k1` controls the sats behind it, like a banknote. The
`amount` alongside it is only a claim by whoever encoded the note; the
authoritative value is always `maxWithdrawable` from an informational GET.

No new endpoint and no new encoding, so a wallet that has never heard of
LNURLcash sees a normal withdraw link and can still cash it out. Every
mutating operation is a GET on the `callback` from that withdrawRequest:

| Request | Result |
| --- | --- |
| `callback?k1=X&pr=<bolt11>` | **melt**: X burned once `pr` settles |
| `callback?k1=X&h=<sha256(X')>` | **rotate**: X burned, a note keyed by `h` minted |
| `callback?k1=X&amount=<msat>&h=..&h2=..` | **split**: X burned, notes keyed by `h` and `h2` minted |
| `callback?k1=X&k1=Y&h=<sha256(Z)>` | **merge**: all burned, one note keyed by `h` minted |

## Usage

```ts
import {
  resolveNoteInput,
  fetchNoteInfo,
  rotateNote,
  splitNote,
  meltNote,
  verifyNoteSignature
} from 'lnurlcash-kit'

// accepts a bech32 LNURL, an lnurlw:// URL, or a plain https one
const url = resolveNoteInput(scanned)
if (!url) throw new Error('not a note')

// what is it actually worth? Only the service can say.
const info = await fetchNoteInfo(url)
console.log(info.maxWithdrawable, 'msat')

// that GET put the secret on the wire, so rotate it
const fresh = await rotateNote(info.callback, info.k1)

// and check the mint really issued it, without asking anyone. Both fields
// are guaranteed here: LUD-25 requires the mint to publish mintPubkey and
// to sign what it mints, and this library refuses a mint that does neither.
verifyNoteSignature(fresh.k1, info.maxWithdrawable, fresh.signature!, info.mintPubkey)
```

Every request function takes options last — `fetch`, `timeoutMs`, `offline`,
`randomSecret`, `requireSignatures`, `mutationRetries`.
`createClient(options)` binds one set once:

```ts
const client = createClient({timeoutMs: 10_000})
await client.rotateNote(callback, k1)
```

## The five things that will cost you money

Everything below is a bug class this library exists to close. If you write
your own client instead, write these first.

**1. Never let the service generate a replacement secret.** On rotate, split
and merge the *wallet* draws a fresh 32 bytes and discloses only
`sha256(secret)` as `h`. A service-issued replacement has, structurally,
been seen by that service — so a "rotate" that accepts one closes no
exposure at all. This library generates them and ignores any `k1` a
non-compliant service tries to hand back.

**2. A failed mutation is not a failure.** If a rotate times out, the
service may already have burned your input and minted the output. The fresh
secret in your process is then the only copy of that money in existence.
Every mutating call raises `AmbiguousMutationError` carrying `newSecrets` —
**persist them before doing anything else**, then use `probeBurnedNote` to
find out what happened:

```ts
try {
  const {k1} = await rotateNote(callback, oldK1)
} catch (err) {
  if (err instanceof AmbiguousMutationError) {
    await save(err.newSecrets)                    // first. always.
    const fate = await probeBurnedNote(noteUrl)
    // 'live'    -> nothing landed, the saved secrets are worthless
    // 'gone'    -> the burn landed, the saved secrets ARE the note
    // 'unknown' -> keep everything and try again later
  }
}
```

`RequestRefusedError` is the opposite and safe: nothing left the process.

**3. A retried mutation is now a replay, not a double spend.** Every mutation
is a GET, HTTP treats GET as idempotent, and an LNURLcash mutation is not —
the first attempt burns the input. For most of this draft's life that was the
sharpest edge in the protocol: a stack that resent a dropped GET got "already
spent" for the second attempt, which reads as a *definitive* rejection, so the
fresh secret got discarded along with the note the service had just minted.
Node's `fetch` does not retry on its own, but a browser resends an idempotent
request that failed on a stale pooled connection, and Go and the JDK do the
same by their own routes — the hazard broke the
[Kotlin](https://github.com/lnurlcash/lnurlcash-kotlin) and
[Go](https://github.com/lnurlcash/lnurlcash-go) siblings during
development, by two different mechanisms.

LUD-25 closed it. A service MUST answer a byte-identical rotate, split or
merge with the success it already returned, signature and all. So this library
re-sends one whose answer was lost, and an unstoppable transport retry is now
simply invisible:

```ts
// the connection dropped after the mint applied this. It completes anyway.
const fresh = await rotateNote(callback, oldK1)
```

`mutationRetries` sets how many times (default 1; `0` restores the old
give-up-at-once behaviour). Only rotate, split and merge are re-sent — never a
melt, which carries `pr`, is paid asynchronously and has no replay guarantee —
and only an ambiguous failure, never a refusal the service actually
considered. The re-sent request is byte-identical, because the replay is
matched on the k1 set, `h`, `h2` and `amount`.

A service that has not implemented the rule answers the second attempt as
already spent, exactly as before. So the old defence stays: a mutation refused
with the input already spent or unknown carries its outputs anyway:

```ts
try {
  await rotateNote(callback, oldK1)
} catch (err) {
  const secrets = newSecretsOf(err)   // works on both error families
  if (secrets.length) {
    await save(secrets)               // first. always.
    // then ask: is there a note at that secret?
    const fate = await probeBurnedNote(buildNoteUrl(base, secrets[0]))
    // 'live' -> the mutation landed and you own the output
    // 'gone' -> the refusal was honest, discard
  }
}
```

The class does not change: at the wire a retry and a genuine double spend are
the same answer, and whether your input was live when the request went out is
something you know and this library does not. So it hands back the secret
rather than a verdict. A refusal that cannot be a landed mutation, such as a
mint refusing on policy grounds, carries nothing, and you can discard your
staged records at once.

**4. A melt's `OK` means "in flight", not "spent".** The service pays
asynchronously and only burns the note once the payment settles, restoring
it if the payment fails. A failed melt is never reported back through the
callback — it is only observable as the note becoming spendable again. Other
operations on that `k1` raise `PendingNoteError` meanwhile; retry, never
read it as spent.

**5. Persist the mint secret before requesting the invoice.** Current
LUD-25 requires `comment=hex(sha256(secret))`; there is no preimage-backed
creation fallback. If the payRequest cannot carry that 64-character comment,
do not mint. Existing notes still redeem through ordinary LUD-03.

## Offline verification

Mandatory, and enforced here. A service MUST publish `mintPubkey` and MUST
sign every note a rotate, split or merge mints, so a holder can confirm
issuer and amount with nothing but the note:

```
message = "LNURLcash:" || amount_msat || ":" || hex(sha256(k1))
digest  = sha256(sha256("Lightning Signed Message:" || message))
sig     = 65 bytes, r || s || recovery_id
```

A `withdrawRequest` publishing no `mintPubkey`, or one that is not a 33-byte
compressed secp256k1 key, is refused with a `ProtocolError`. A mutation the
service confirms but does not sign raises `UnverifiableNoteError` — which
**carries the fresh secrets**, because the mutation landed and the note it
minted is real; read them with `newSecretsOf` and persist them before
anything else. Pass `requireSignatures: false` to deal with a mint that
predates the requirement.

`verifyNoteSignature` recovers the pubkey and compares it to `mintPubkey`.
It accepts the recovery id at either end, because lnurl-mint once emitted
the reverse layout and other implementations may still; trying both is safe,
since the wrong ordering recovers an unrelated key that cannot match.

The signature commits to the note's *hash*, not its secret — so you can
prove a mint issued a note, to expose one that will not honour it, without
handing over what would let anyone spend it.

### When a mint rotates its signing key

Rotating invalidates nothing. The notes already issued are still genuine and
their signatures still verify, but only against the key that made them, so a
wallet holding the new key alone would suddenly read every outstanding note
as forged. A mint publishes the keys it has retired as `previousPubkeys` on
its mint address, and verification takes the whole set:

```ts
const {mintPubkey, previousPubkeys = []} = await fetchMintAddress(addressUrl)
const check = verifyNoteSignatureAgainst(k1, amountMsat, sig, [
  mintPubkey,
  ...previousPubkeys
])
// check.pubkey names the key that signed. A note that verifies only against
// a retired one is worth rotating: the mint re-signs it under the current key.
```

`verifyNoteSignature` takes the same one-or-many argument and returns a plain
boolean. An empty list is a rejection, not a pass.

### What else a mint says about itself

`mintPubkey` is the key note signatures verify against, and it is *not* the
Lightning node's key: that one is embedded in `nodeUri`, and every other
`node*` field really is about the node. Verifying a note against the key
pulled out of `nodeUri` fails, and the failure says nothing about why.
`nodePubkey` is a deprecated alias for the same value, kept for one release.

`fetchMintAddress` reads the experimental discovery endpoint, and a mint may
publish a `name`, a `description`, `contact` details, a `tosUrl`, a `motd`,
its structured `fees` and its software `version` there. All optional, all
absent on most mints, and none of it is needed to spend a note. Surface the
MOTD when it changes: it is how an operator announces maintenance, a fee
change or a sunset date, and there is no other channel to a bearer holder.
The endpoint carries no LUD number, so treat a rejection as "no extra
information" and fall back to `fetchPayRequest`.

## Secrets

A note's `k1` is generated by the wallet. Draw it from a CSPRNG and the note
lives only in your wallet file: the mint holds `sha256(k1)` and cannot tell
you apart from a stranger, so a lost file is lost money. Derive it from a
seed instead and the wallet restores from words alone, and the same words
restore the same notes in a *different* wallet.

LUD-25 specifies how, and this is the scheme to mint under:

```
cashHashingKey   = m/139'/0
(d1, d2, d3, d4) = HMAC-SHA256(key = cashHashingKey, msg = utf8(host))[0..16] as 4 uint32
k1_i             = m/139'/d1/d2/d3/d4/i'
```

`d1..d4` are used **exactly as they fall**. BIP-32 reads any index `>= 2^31`
as hardened, so which of the four levels are hardened is decided by the
mint's own host name, and half of them will be. Do not mask the top bit and
do not harden all four: either one derives a different tree, and a wallet
restoring against it finds nothing, silently. Only `i` is always hardened.

`seed` is raw bytes. A 64-byte BIP39 seed is what wallets use in practice,
but nothing here depends on BIP39, so a device with its own entropy store
derives the same way and no consumer carries a wordlist it does not need.
`host` is the mint host exactly as `serverOf` spells it, lowercase and with
the port where there is one, so `127.0.0.1:8899` and `mint.example` never
collide. `index` counts from 0. The output is 32 bytes of hex, the size of a
payment preimage, and the mint sees nothing different: it only ever receives
`sha256(k1)`.

```ts
import {deriveCashRoot, cashSecretSource, restoreFromSeed} from 'lnurlcash-kit'

const root = deriveCashRoot(seed)          // seed: Uint8Array, yours to keep safe
const source = cashSecretSource(root, 'mint.example', counter)
```

### The hardware-signer path

Every unhardened level sits at or above the per-mint node, so a signer given
`m/139'/d1/d2/d3/d4` rather than the seed needs **no elliptic curve at all**:
each `i'` beneath it is HMAC-SHA512 and one modular addition. That is the
difference between a device that can do LUD-25 recovery and one that would
need secp256k1 added to its firmware.

```ts
import {deriveCashDomainNode, cashNodeToHex, cashNodeFromHex, cashSecretAt} from 'lnurlcash-kit'

const node = deriveCashDomainNode(root, 'mint.example')
provision(cashNodeToHex(node))             // 64 bytes: privateKey || chainCode

// on the device, or anywhere holding only that node
cashSecretAt(cashNodeFromHex(hex), index)
```

Whoever derives that node can derive every note secret the wallet will ever
hold **at that mint**. It is provisioning material: one mint's subtree, not
the wallet.

### The legacy scheme

This kit shipped its own derivation in 0.2.0, four days before LUD-25 had a
section on one:

```
root = HMAC-SHA256(key = utf8("lnurlcash-note-v1"), msg = seed)
k1_i = HMAC-SHA256(key = root,                      msg = utf8(host + ":" + index))
```

`deriveNoteRoot`, `deriveNoteSecret` and `derivedSecretSource` still
implement it and are not going anywhere, because notes minted under it are
still money. Do not mint under it. `restoreFromSeed` walks it alongside the
specified scheme so none of those notes goes missing.

Both schemes ship with
[conformance vectors](https://github.com/lnurlcash/lnurlcash-conformance)
for the ports.

```ts
import {deriveNoteRoot, derivedSecretSource, restoreNotes} from 'lnurlcash-kit'

const root = deriveNoteRoot(seed)          // legacy: existing notes only
const source = derivedSecretSource(root, 'mint.example', counter)

// hand it to any mutating call and the fresh secrets come from the seed
const {k1, change} = await splitNote(callback, [note], 40_000, {randomSecret: source})
saveCounter('mint.example', source.index())  // a split consumed two indices
```

Persist that counter in the **same write that stages the new records**, and
do it **before** the hash goes on the wire. A crash between the bump and the
request wastes an index, which costs nothing. A crash the other way round
re-derives a secret the mint has already seen, and the second note minted at
it collides with the first. This is the rule wallets get wrong.

### Restoring

Restoring walks the indices and asks the mint what each derived secret is
worth. From a seed it walks both schemes at once:

```ts
const {found, next} = await restoreFromSeed('https://mint.example/w', seed, 'mint.example')
// found[].scheme is 'bip32' or 'hmac'; next is {bip32, hmac}
```

A live note is recorded, an unknown index counts towards the gap, and the
walk stops after 20 consecutive unknowns. A restored note carries no
signature, so rotate each one straight after: that closes the exposure and
gets the signature in the same call.

**The scan is the fallback, not the backup.** LUD-25 requires a hash lookup
to answer for a burned note exactly as it answers for one that never existed,
so a by-hash walk cannot see a spent index at all. A rotate burns the *old*
index, which means a wallet's spent indices sit below its live ones: rotate
more than `gap` times and a scan from 0 finds nothing whatever. The counter
`next` gives you is the thing that makes recovery work, so **persist it and
back it up**. It is not secret - an index reveals nothing without the root -
so it belongs in an ordinary backup, and a restore should merge counters
upwards only, never down.

Only a walk that discloses raw secrets (`allowSecretDisclosure`) sees "spent"
at all, because only a `k1` lookup gets that answer. It costs the whole
window it walked: every index it touched is burned whether or not a note was
ever minted there, since the secret is in someone's log now. `next` skips
them for you.

The seed is bearer material for every note the wallet will ever hold. Store
it the way you store the notes, and never log it.

## Notes keyed by a public key (LUD-25 Part 2)

A Part 2 note swaps the hash for a key pair. The wallet keeps `sk`. The mint
only ever sees `pk`, written `cp1…`. To spend the note you hand over `ck1…`,
a recoverable signature by `sk` over the fixed message `LNURLcash`, and the
mint recovers `pk` from it to find the note. The mint's certificate, `cs1…`,
is the same signature mints already make, over `hex(pk)` instead of a hash.
So a recipient can check a note offline with nothing but `ck1` and `cs1`.

The wire calls take both kinds. A `ck1` goes anywhere a `k1` does: a note
URL, `fetchNoteInfo`, rotate, split, merge and melt. A `cp1` goes anywhere an
output does: `requestInvoice`'s `h`, and the output of every `*WithHash` call,
where it is sent as `p1`/`p2` while a hash keeps `h`/`h2`, the same rule as
lnurl-wallet. `noteIdOf(k1)` gives the id a mint files either kind under, and
`noteLookupOf(k1)` what to pass `fetchNoteInfoByHash` to check a note without
disclosing it. The names match lnurl-wallet's `src/lib`, so moving to it
later is an import change.

```ts
import {
  deriveCashRoot, deriveCashAddressNode, cashNodeToCx1, encodeCx1,
  deriveNotePubkey, deriveNoteSecretKey, signNoteOwnership, encodeCk1,
  verifyNoteSignature
} from 'lnurlcash-kit'

const node = deriveCashAddressNode(deriveCashRoot(seed), 'mint.example')
const {pubkeyXOnly, chainCode} = cashNodeToCx1(node)
const cx1 = encodeCx1(pubkeyXOnly, chainCode)             // watch-only

const pk = deriveNotePubkey(pubkeyXOnly, chainCode, i)     // what a watcher derives
const sk = deriveNoteSecretKey(node.privateKey, node.chainCode, i)
const ck1 = encodeCk1(signNoteOwnership(sk))              // the bearer secret

verifyNoteSignature(ck1, amountMsat, cs1, mintPubkey)     // offline
```

Three things worth knowing:

- **The branch path follows the reference wallet, not the spec text.** It is
  `m/139'/1'/d1/d2/d3/d4`, with the hashing key at `m/139'/1'/0`. The spec
  says `m/139'/d1..d4`, which is the node the Part 1 ladder already uses, and
  a wallet following it finds none of lnurl-wallet's notes.
- **A `cx1` links every note on its branch.** It cannot spend anything, but
  whoever holds it can list every key on the branch and ask the mint about
  each one. Register it with a mint and that mint sees everything paid to the
  address. Use the branch for receiving and rotate off it.
- **`i` is any uint32**, serialised as 4 bytes big-endian, never hardened.
  lnurl-wallet and lnurl-mint agree on that; the spec does not say.

The tests grade against lnurlcash-conformance's `vectors/part2.json`, built
from the primitives there and identical to vectors generated from lnurl-wallet
and checked against lnurl-mint.

**A branch rooted in a Nostr key.** A holder with no BIP-39 words, such as a
hardware signer that keeps only its identity key, or a wallet that never made
any, can still be paid to keys of its own. `deriveNostrAddressNode(secretKey,
host)` takes the branch from the key that owns the lightning address:
`HMAC-SHA256(key = secret key, msg = "LNURLcash/nostr-seed")`, then the path
above unchanged. heartwood-esp32 derives exactly this on the device, graded
against the same values as conformance's `vectors/nostr-seed.json`, so its notes come back from
its nsec (or the phrase the nsec came from) without the device. This is ours,
not LUD-25's; a mint sees an ordinary `cx1` either way.

## Minting a note you named yourself

By default the secret of a freshly minted note is the invoice's payment
preimage, which means the money is a thing two sets of people learn without
being trusted. Every routing node on the payment path sees it, because that
is how HTLC settlement works. And anyone who merely saw the unpaid invoice
can poll LUD-21 `verify` with the payment hash inside it and take the
preimage the moment it settles, which is what a QR code on a desktop screen
hands out.

A current-draft mint binds the note to the hash supplied in the mandatory
LUD-12 comment. The kit repeats the same value as `h` for the additive
Moneyer/ForgeSworn receipt extension. You chose the secret, nobody else ever
had it, and the preimage is ordinary payment proof.

```ts
import {
  fetchPayRequest, requestInvoice, claimMintedNote,
  deriveCashRoot, deriveCashSecret, hashK1, namesMintOutput
} from 'lnurlcash-kit'

const pay = await fetchPayRequest(payUrl)      // a Lightning Address resolves here
if (!namesMintOutput(pay)) throw new Error('mint lacks commentAllowed: 64')

const root = deriveCashRoot(seed)
const k1 = deriveCashSecret(root, 'mint.example', nextIndex)
await persist({k1, index: nextIndex})          // BEFORE the invoice. always.

const {pr} = await requestInvoice(pay.callback, 21_000, {h: hashK1(k1)})

// pay `pr`, then poll. No verify, because you already know the secret.
const claim = await claimMintedNote(pay.withdrawLink!, k1)
// 'unminted' -> not settled yet, ask again
// 'minted'   -> claim.amountMsat is what it is worth, claim.callback melts it
```

Ask before you buy. `commentAllowed >= 64` is the normative minting
capability. `mintToHash` describes only the additive `h` and receipt fields:

| Where | What it means |
| --- | --- |
| `PayRequestInfo.commentAllowed` | room for the mandatory hash comment; required for minting |
| `PayRequestInfo.mintToHash` | "I also accept the matching `h` extension." |
| `MintAddressInfo.mintToHash` | the same fact on the experimental discovery document |
| `InvoiceResult.mintToHash` | "I bound *this quote* to the hash you named" |

Decide whether minting is possible from `commentAllowed` on the payRequest;
never substitute the mint-address extension field. Anything other than
boolean `true` is no for `mintToHash`, but that affects only extension receipt
handling. The note remains comment-bound either way.

**Persist the secret before you ask for the invoice.** Paying for a note and
then losing the secret is the one way this is worse than the preimage scheme,
and persisting first removes it. Derive it rather than drawing it at random
and there is a second reason: the note is then seed-derived *from birth*, so
`restoreNotes` finds it without any rotate having happened. Under the preimage
scheme a minted note lives outside your derivation until the immediate rotate
pulls it in, and a wallet that crashes in that window cannot recover the note
from its words.

No rotate follows a bound claim. The preimage scheme needs one because the
mint made the secret and hands it out; here the mint never had it, so the note
is yours from the moment it exists. The claim GET does show the secret to the
mint it is a claim on, which is a different thing from showing it to whoever
scanned the QR, and you can still rotate if you want the offline signature.

### A sealed signer: confirm without exporting the secret

A hardware vault cannot use the claim GET above without handing `k1` to its
companion. A receipt-capable mint can instead commit the quote to the requested
`h` and exact net amount, then place the ordinary LUD-25 note signature on its
settled LUD-21 response. The extension is optional; absence means use the
unchanged preimage-import-and-rotate flow before showing an invoice.

```ts
import {
  requestInvoice, fetchInvoiceVerification,
  requireBoundMintQuote, validateBoundMintReceipt
} from 'lnurlcash-kit'

const staged = await vault.newSecret() // {id, h}; k1 stays in the vault
const expectedNetMsat = 21_000
const quote = await requestInvoice(pay.callback, 21_000, {h: staged.h})

// Do this before displaying or paying quote.pr.
requireBoundMintQuote(quote, staged.h, expectedNetMsat)
if (!quote.verify) throw new Error('No settlement receipt offered')

// After payment, poll quote.verify until settled.
const verification = await fetchInvoiceVerification(quote.verify)
const receipt = validateBoundMintReceipt(
  quote,
  verification,
  staged.h,
  expectedNetMsat,
  pinnedMintPubkeys
)
await vault.confirm(staged.id, receipt.amountMsat, mintHost, receipt.signature)
```

`quote.mint` is `{h, amountMsat}` in the typed API (`amount` on the wire).
The settled response must repeat that commitment and add `signature` (`sig`
on the wire). Validation matches the invoice, output and amount, refuses a
pre-settlement signature, and recovers the signer against the pinned current
or previous mint keys. The payment preimage remains proof of payment; it never
replaces the vault's staged secret.

## Asking to be paid

"Send me 500 sat" today means handing over a Lightning Address, which is a
mint-and-zap round trip through the mint's node for something neither party
needed a node for. A payment request names the amount, the mints the payee
will accept and where to deliver, and the payer's wallet splits a note and
sends it straight across. Wallet to wallet; the mint only ever sees a split.

```ts
import {encodePaymentRequest, decodePaymentRequest, paymentRequestAmountMsat} from 'lnurlcash-kit'

const encoded = encodePaymentRequest({
  v: 1,
  id: '0123456789abcdef',            // 8 random bytes, hex
  amount: '500',                     // whole sats, decimal string
  currency: 'sat',
  methodDetails: {mints: ['mint.example']},
  to: 'npub1...',                    // or alice@mint.example
  memo: 'lunch'
})
// lnurlcashreq1eyJhbW91bnQiOiI1MDAiLCJjdXJyZW5jeSI6InNhdCIsImlkIjoiMDEy...

const request = decodePaymentRequest(scanned)   // throws ProtocolError if it is not one
const owed = paymentRequestAmountMsat(request)  // 500_000
```

The encoding is `lnurlcashreq1` followed by base64url of the request as
[JCS](https://www.rfc-editor.org/rfc/rfc8785)-canonical JSON, which is
NUT-18's `creqA` idiom with our own prefix. Canonical because a request is a
thing people copy, quote back and match against a record of what they asked
for: two encodings of the same request must be the same string, or none of
that works. It stays short enough for one static QR.

The object is the same charge request an HTTP 402 lnurlcash rail serves,
plus the transport fields a wallet-to-wallet send needs, so one encoder
covers both. Validation is strict in both directions, including an
unrecognised field: quietly paying a request you did not fully understand is
how you pay the wrong person.

`amount` is in **sat**, and it is the one exception to this library's
msat-everywhere rule. That is deliberate: the field is shared with the 402
rail and the Cashu payment method, both of which count in whole units. Use
`paymentRequestAmountMsat` rather than multiplying by hand.

An expired request will not decode, because paying one is always wrong. At
the expiry counts as expired, not merely past it, so a payer whose clock is a
second behind the payee's does not send a note against a request the payee
has already written off. `isPaymentRequest` still returns true for it, so a
scanner routes it to the pay screen and the user is told it lapsed rather
than that their input was gibberish; `decodePaymentRequest(input, {now: 0})`
returns it for display.

`to` is checked, not merely shape-matched: an npub has to survive its bech32
checksum, because a request naming a destination nobody can route to is a
request nobody can pay.

**`lnurlcashreq1` means this schema and nothing else.** An earlier HTTP 402
rail emitted a shorter object under the same prefix (`{"a": 21, "m":
["mint.example"], "u": "sat"}`: amount as a number, no version, no id). Two
schemas under one prefix cannot both be right, and this is the one the
vectors pin. The decoder reads the short form anyway, because refusing a
string it can plainly understand helps nobody, and gives it a deterministic
id derived from its own bytes. Nothing here ever emits it.

## Taking a note as payment

A server that accepts bearer notes for something makes the same decisions
every time, in this order, and `settleNoteForValue` is that order written
once:

```ts
import {settleNoteForValue, InsufficientValueError} from 'lnurlcash-kit'

try {
  const {note, newUrl} = await settleNoteForValue(offered, {
    mints: ['mint.example'],   // hosts this server accepts. An empty list accepts nothing.
    minMsat: 21_000,           // the price
    requireSignature: false    // demand offline proof of issuance first
  })
  grantAccess()                // note.k1 is yours now; newUrl is a note to store or melt
} catch (err) {
  if (err instanceof InsufficientValueError) refuse(err.amountMsat, err.minMsat)
  else refuse()
}
```

1. the input parses as a note at all
2. its mint is one this server accepts (checked before any round trip, so an
   unaccepted mint is never contacted)
3. an informational GET for the **authoritative** value and the mint's key
4. the signature, where the server demands one, over the value the mint
   stated rather than the one the URL claims
5. that value covers the price
6. **rotate**

Step 6 is the settlement, not bookkeeping after it. Rotating burns the
secret the payer handed over and mints a replacement only this server knows,
in one atomic request: it transfers ownership and rejects a replay in the
same call, because a second presentation of the same note finds it spent. A
server that checks a note's value and grants access without rotating has
verified a photograph of a banknote.

Refusals are typed, and nothing is burned by any of them: `ServiceRejectedError`
for an unaccepted mint or a signature that will not verify,
`InsufficientValueError` (carrying both amounts) for a note worth too
little, `NoteSpentError` for one already spent or presented twice,
`PendingNoteError` for one with a melt in flight, which is worth retrying
rather than refusing outright. `AmbiguousMutationError` from the rotate is
the case to handle with care: persist `err.newSecrets` before anything else,
because if the request landed then that secret is the money and it is now
this server's.

## Scope

This library speaks the protocol. It does not store notes, hold keys, manage
a balance, pay invoices, or decide anything about your UI. Storage and key
management are yours, and they are where most of the remaining risk lives —
see [THREAT-MODEL.md](THREAT-MODEL.md).

Amounts are integers in **milli-satoshis**, everywhere, with no exceptions.

## Provenance

The protocol layer was extracted from
[lnurl-wallet](https://github.com/dni/lnurl-wallet), the LNURLcash reference
wallet by dni, rather than reimplemented — that code has been exercised
against a real mint and an adversarial mock, and a fresh rewrite would have
thrown that away to no one's benefit.

The reference implementations, both dni's, both MIT:

- [lnurl-mint](https://github.com/dni/lnurl-mint) — the reference service
- [lnurl-wallet](https://github.com/dni/lnurl-wallet) — the reference wallet

Everything else built on LNURLcash — the other wallets and mints, the
hardware vault, the sibling language ports — is indexed in
[awesome-lnurlcash](https://github.com/lnurlcash/awesome-lnurlcash).

Changes made on extraction are listed in [CHANGELOG.md](CHANGELOG.md); two
are behavioural fixes worth reading if you are porting from that code.

## Conformance

Tested against [lnurlcash-conformance](https://github.com/lnurlcash/lnurlcash-conformance):
language-neutral vectors plus a mock mint that can be told to misbehave —
drop a connection mid-mutation, sign in the wrong byte order, lie about a
note's value, never settle a melt. If you are writing an LNURLcash
implementation in any language, run those vectors before you run real sats
through it.

```bash
npm test
```

## License

MIT. See [LICENSE](LICENSE) for the attribution.
