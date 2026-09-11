# Changelog

## Unreleased

- `deriveNostrCashSeed(secretKey)` and `deriveNostrAddressNode(secretKey,
  host)`: a Part 2 address branch rooted in a Nostr identity key, for a holder
  with no BIP-39 words. The seed is `HMAC-SHA256(key, "LNURLcash/nostr-seed")`
  and the path from it is the reference wallet's. heartwood-esp32 derives the
  same branch on the device, and `test/vectors/nostr-seed.json` is the file
  both grade against.
- `deriveCashMaster(seed)`: the BIP-32 master node, exported beside
  `deriveCashChild` for walking a path the kit does not name, such as
  nsec-tree's `m/44'/1237'/727'/0'/0'`.

## 0.11.0 - 2026-09-11

**The wire calls take LUD-25 Part 2 notes.**

- A `ck1` goes anywhere a `k1` does. `resolveNoteInput` accepts a note URL
  carrying one, and rotate, split, merge, melt and `fetchNoteInfo` pass it
  through.
- A `cp1` goes anywhere an output does. `requestInvoice` sends it as the
  comment alone. The `*WithHash` calls send it as `p1`/`p2`, while a hash
  keeps `h`/`h2`, which every mint understands. That is lnurl-wallet's rule.
- `fetchNoteInfoByHash` and `buildNoteInfoUrlByHash` take a `cp1`, sent as
  `p`.
- `noteIdOf(k1)` is the id a mint files a note under, for either kind.
  `noteLookupOf(k1)` is what to look it up by without disclosing it.
- `noteSignatureMessage` and `noteSignatureDigest` build the message over the
  key for a `ck1`.

## 0.10.0 - 2026-09-11

**LUD-25 Part 2 building blocks.** Notes keyed by a public key and spent by a
recoverable signature. The wire calls come next; this is the part every one of
them rests on.

- The four encodings: `cp1` (a note's public key), `ck1` (its bearer secret),
  `cs1` (the mint's certificate) and `cx1` (a watch-only branch), with
  `encode*`, `decode*` and `is*` for each. Decoders return null rather than
  throw, and refuse mixed case as BIP-350 does.
- `deriveNotePubkey` and `deriveNoteSecretKey`, the per-note key tweak.
- `signNoteOwnership` and `recoverNoteOwnershipPubkey`.
- `deriveCashAddressNode` and `cashNodeToCx1`. The branch sits at
  `m/139'/1'/d1..d4`, which is what lnurl-wallet derives, not the
  `m/139'/d1..d4` the spec text gives.
- `verifyNoteSignature` now takes a `ck1` note and a `cs1` certificate, so a
  Part 2 note verifies offline the same way a Part 1 note does.

Names and signatures match lnurl-wallet's `src/lib`. Every value is graded
against `test/vectors/part2.json`, generated from lnurl-wallet and checked
against lnurl-mint.

## 0.9.0 - 2026-09-09

**`fetchMintAddress` reads three more fields.** The reference mint publishes
them and this dropped all three on the floor, because the parser maps field by
field and an unrecognised name is discarded by design.

- `nodeUris` - every address the SERVICE's node announces. `nodeUri` is the
  first of them; a node behind Tor as well as clearnet has more, and a caller
  that can only reach the other one needs the list. Undefined rather than `[]`
  when there are none, so `nodeUris?.length` and `'nodeUris' in info` agree.
- `sunsetDate` - the day the SERVICE plans to close, ISO-8601. Advance warning
  while there is still time to spend, deliberately not the same thing as a mint
  that has already stopped minting. Validated as a real calendar day and
  dropped otherwise: the one thing a WALLET does with this is put it in front
  of a holder, and a wrong date there is worse than no date.
- `outstandingNotesMsat` - what the SERVICE says it owes. Its own claim about
  its own database, with nothing to check it against, so read it next to what
  the node holds rather than on its own.

## 0.8.1 - 2026-09-04

**`settleNote` could report a burned note as settled, losing it outright.**
Settling reads what a split's change or a merge's output is really worth, which
puts `k1` on the wire, so a rotate follows to replace the secret it just
exposed. That rotate is best-effort by design: a SERVICE that refuses it has
burned nothing, so keeping the exposed `k1` beats failing the whole settle.

The fallback was a bare `catch`, which also covered a rotate that MAY HAVE
LANDED - an ambiguous one, an unverifiable one, or a spent-or-unknown refusal,
which is exactly what a mutation the SERVICE already applied looks like asked a
second time. In every one of those the SERVICE had burned the `k1` being
returned and minted a note under `h`, and the fresh secret `rotateNote()`
attaches to the error was the only copy of it anywhere. Discarding it handed
back a dead secret shaped like a success and dropped the live one.

- `settleNote` now rethrows anything that could describe an applied mutation:
  `AmbiguousMintError`, and any error carrying `newSecretsOf(err)`. Only a
  refusal that burned nothing still returns the exposed `k1`.
- It also rethrows anything that is not an `LnurlcashError`. The bare `catch`
  swallowed `TypeError` and friends alongside the protocol errors the fallback
  was for, so a bug in this library was reported as a settled note too.
- **Behavioural change, no API change.** A caller that treated `settleNote` as
  something that never throws now sees these errors. That is the point: each
  one carries secrets that must be persisted before anything else.
- Fixed in the sibling implementations the same day - Rust, Go, Python and
  Kotlin all carried it.

## 0.8.0 - 2026-09-04

**LUD-25's own derivation, and it is now the one to mint under.** The draft's
"Seed-recoverable note secrets" section specifies a BIP-32 scheme under
`m/139'`, and the reference wallet implements it. This kit had shipped its own
HMAC scheme four days before that section existed. One convention is the whole
point of writing either of them down, so the specified one wins.

- `deriveCashRoot(seed)`, `deriveCashDomainNode(root, host)`,
  `deriveCashSecret(root, host, index)`, `cashSecretAt(domainNode, index)`,
  `cashSecretSource(root, host, start)`, `cashNodeToHex` / `cashNodeFromHex`
  and `deriveCashChild` in a new `cash.ts`. Additive - nothing existing
  changes shape.
- The scheme, in full, so this entry alone is enough to reimplement it:

  ```
  cashHashingKey   = m/139'/0
  (d1, d2, d3, d4) = HMAC-SHA256(key = cashHashingKey, msg = utf8(host))[0..16]
                     as 4 big-endian uint32
  k1_i             = m/139'/d1/d2/d3/d4/i'
  ```

  `d1..d4` are used **exactly as they fall**. BIP-32 already reads any index
  `>= 2^31` as hardened, so which of the four levels are hardened is decided
  by the mint's host name and roughly half of them will be. Masking the top
  bit, or hardening all four, derives a different tree and restores nothing,
  silently. Only `i` is always hardened. `host` is what `serverOf` produces -
  lowercase, port included - byte-identical to the reference wallet's.

  Worked example. The BIP39 mnemonic `abandon abandon abandon abandon abandon
  abandon abandon abandon abandon abandon abandon about` with an empty
  passphrase gives `m/139'` as
  `c7a2496e9b453a67c5d2a1f04936ec1259440d45454c795a99a66269e4cd3005111e1cc966fca2fe32f054f14caceab90449e536d94cf6935ea12a087e414f60`
  (privateKey || chainCode). At `mint.example` the four levels are
  `[2589708612, 3693348916, 172082394, 3793182078]`, of which the third is
  the only unhardened one, and index 0 is
  `de5b81405a12e1297b350d80e2ad85043ed5b9436a0c5592d3302778de330499`.
- **The hardware-signer path.** Every unhardened level sits at or above the
  per-mint node, so a signer provisioned with `deriveCashDomainNode`'s output
  rather than the seed needs no elliptic curve at all: each `i'` beneath it is
  HMAC-SHA512 and one modular addition. Whoever derives that node can derive
  every note secret the wallet will hold at that mint, so it is provisioning
  material - one mint's subtree, not the wallet.
- BIP-32 is implemented here from its own primitives rather than pulled in as
  a dependency, and tested against BIP-32's published test vector 1. Every
  LUD-25 value above is checked against output from the reference
  implementation's own library.

**`restoreFromSeed` walks both schemes.** Notes minted under the old scheme
are still money and a wallet that walked only the new one would leave them at
a mint it can no longer name.

- `restoreFromSeed(baseUrl, seed, host, {gap?, start?, probeK1?,
  allowSecretDisclosure?}, opts?)`. `RestoredNote.scheme` is `bip32` or
  `hmac`, `next` is `{bip32, hmac}`, and `start` takes one per scheme.
- `restoreNotes` is unchanged in signature and behaviour, and still walks the
  legacy scheme alone. `RestoredNote` and `UnresolvedIndex` gain a `scheme`
  field.
- `deriveNoteRoot`, `deriveNoteSecret` and `derivedSecretSource` are not
  deprecated and are not going anywhere. Do not mint under them.

**Say plainly what a restore can and cannot do.** LUD-25 requires a hash
lookup to answer for a burned note exactly as it answers for one that never
existed, and both reference mints do. So a by-hash walk cannot see a spent
index at all; and since a rotate burns the *old* index, a wallet's spent
indices sit below its live ones, and one that has rotated more than `gap`
times scans as completely empty. The persisted per-host counter is what makes
recovery work - the scan is the fallback. That counter is not secret, so it
belongs in an ordinary backup, and a restore should merge counters upwards
only. Documented on `RestoreOptions.start`, in the README and in `llms.txt`.

Graded against `lnurlcash-conformance` 0.7.0, whose `cash-derivation.json`
cases this suite now runs: the LUD-25 path, the four domain levels per host,
the hardened-by-magnitude flags, and BIP-32's own published test vector 1.

## 0.7.0 - 2026-09-04

**Offline verification is mandatory, and this library now insists on it.**
LUD-25 stopped treating a note signature as optional: a SERVICE MUST
publish `mintPubkey` and MUST sign every note a rotate, split or merge
mints. A wallet that quietly accepted unsigned notes was handing its holder
something nobody downstream could check, which is exactly the gap offline
verification exists to close.

- `fetchNoteInfo` and `fetchNoteInfoByHash` refuse a `withdrawRequest` that
  publishes no `mintPubkey`, or one that is not a 33-byte compressed
  secp256k1 key. `WithdrawRequestInfo.mintPubkey` is typed as present.
- `rotateNote`, `splitNote`, `mergeNotes` and their `*WithHash` forms throw
  the new `UnverifiableNoteError` when the SERVICE confirms the mutation but
  returns no `sig` (or no `sig2` on a split's change).
- **That error carries the secrets.** The mutation landed - `status` was OK -
  so the note exists at the hash the wallet disclosed and its secret is the
  only key to that value. `newSecretsOf()` reads them exactly as it reads
  them off an ambiguous mutation. Enforcing conformance must never be the
  thing that destroys the money.
- `requireSignatures: false` opts out, for a mint that predates the
  requirement. One option, stated once, at the call site that needs it.

**A mutation whose answer was lost is now re-sent, and usually completes.**
LUD-25 gained a "Retrying a mutation" section: a SERVICE MUST answer a
byte-identical rotate, split or merge with the success it already returned,
signature and all, rather than with the already-spent refusal its burned
inputs would otherwise earn.

That closes the sharpest edge in the protocol. Every mutation is a GET,
HTTP treats GET as idempotent, and stacks retry one whose connection
dropped - browsers on a stale keep-alive, Go's `net/http` on a reused
connection, the JDK's `HttpClient` with no way to switch it off. The mint
saw the request twice, answered the second as already spent, and the wallet
was told a mutation had not happened while a note sat at the hash it had
disclosed. Now the second answer is the first one.

- `mutationRetries` defaults to 1. Set 0 for the previous behaviour.
- Only rotate, split and merge. A melt is **never** retried: it carries
  `pr`, is paid out asynchronously, and the replay rule does not cover it.
- Only an ambiguous failure is retried. A definitive refusal is the
  SERVICE's considered answer and asking again cannot improve it.
- The retry re-sends the identical request rather than rebuilding it. The
  replay is matched on the k1 set, `h`, `h2` and `amount`, so a freshly
  generated secret would make the second attempt a different mutation - and
  a second real burn.

Against a SERVICE that has not implemented the replay rule, retrying leaves
a caller exactly where giving up would have: the same secrets on the same
error, and the same instruction to go and ask what the note at each hash is
worth.

Requires `lnurlcash-conformance` 0.6.0, whose vectors carry the same MUSTs.

## 0.6.0 - 2026-08-31

- `namesMintOutput()` now requires `commentAllowed >= 64`; the additive
  `mintToHash` advertisement alone no longer authorizes minting.
- `fetchPayRequest()` rejects a minting payRequest that cannot carry the
  mandatory 64-character commitment, so a caller cannot proceed into an
  invoice flow that has no conforming output name.
- Mint requests carrying an output hash continue to send identical
  `comment` and `h` fields. Documentation now treats the former as mandatory
  LUD-25 and the latter as the Moneyer/ForgeSworn receipt extension.

Semantic versioning. While the LUD-25 draft is unmerged, `0.x` minor bumps
may carry breaking changes; pin an exact version.

## 0.5.0 - 2026-08-29

**A large merge is folded in batches rather than sent as one over-long
URL.** LUD-25 bounds a merge by ordinary URL length, not by anything in the
protocol: every repeated `k1=` costs about 68 characters, and browsers,
servers and proxies commonly cap a whole URL near 2000. Past roughly 28
notes `mergeNotes` built a request that something upstream truncates,
turning a large merge into a malformed one rather than a clean refusal. It
now measures the URL this SERVICE's own callback actually produces and
folds the inputs batch into batch, each merge's output carried into the
next, as the draft advises.

A fold can fail with value already moved, which a single merge never could:
once a batch has landed, the carried note is one the SERVICE has already
minted, worth every batch folded so far, and the fold holds its only copy.
It is returned with the failure whatever the class of failure - a network
drop, a policy refusal, a k1 count the mint caps at, an input mid-melt
elsewhere - so a caller that persists what `newSecretsOf` hands it cannot
lose the fold's own output. The error's class is preserved, so a caller
telling pending apart from spent still can.

Batches are bounded by note count as well as URL length. No LUD-25 field
advertises a SERVICE's own limit on how many `k1` one request may name, and
the limits in the wild are tighter than 2000 characters allows - moneyer
defaults to 21, lnurl-mint to 100 - so batching on length alone built
requests a conforming mint refuses outright. The default is 20, under the
tightest cap known.

`mergeBatches(callback, k1s, options?)` is exported for callers that want to
plan the batches themselves - `{budget, maxNotes}`, or a bare number for the
budget as before. A caller that has learned a SERVICE's real limit should
pass it.

## 0.4.0 - 2026-08-26

**Breaking: `restoreNotes` asks by hash, and no longer discloses note
secrets by default.**

The walk queries every index up to `gap` past the last one in use, and those
are exactly the indices the wallet is about to mint into next. Asking by
secret therefore published the next `gap` secrets the wallet would ever use,
in cleartext query strings, and the returned `next` then pointed straight at
one of them. A five-note wallet put twenty-five live-or-future secrets on the
wire and resumed at an index it had just disclosed.

- The walk now uses the informational GET's `h` parameter (LUD-25, "Checking
  a note without exposing it"), so nothing spendable leaves the wallet.
  `fetchNoteInfoByHash` and `buildNoteInfoUrlByHash` expose it directly, and
  `RestoredNote.callback` carries the callback so a caller need not ask again
  with the raw secret.
- `RestoreOptions.allowSecretDisclosure` (default `false`) permits the old
  form as an explicit fallback, never automatically. When it is used,
  `RestoreResult.disclosesSecrets` is `true` and `next` skips every index the
  walk touched, because a disclosed secret is spent whether or not a note was
  ever minted under it.
- `h` support is OPTIONAL in LUD-25 with no capability flag, so a SERVICE
  that cannot answer by hash is indistinguishable from one holding none of
  the notes asked about. A walk that never gets a positive answer now throws
  `HashLookupUnsupportedError` rather than reporting an empty wallet.
  `RestoreOptions.probeK1` supplies a positive control, and
  `RestoreResult.hashLookupsConfirmed` reports what was established.

**`requestInvoice` names the mint output with a LUD-12 `comment`.**

LUD-25 specifies the mint-time output hash as `comment = hex(h)`, and that is
what a conforming SERVICE reads. The kit sent only `h`, a parameter one
implementation adopted before the comment form was written, so a wallet
naming an output against a conforming mint was silently ignored and its note
was keyed by the payment preimage instead.

- `comment` is now sent alongside `h`. A SERVICE reading either gets the same
  hash; one reading neither behaves exactly as before.
- This matters beyond conformance: an unnamed mint's `k1` **is** the payment
  preimage `P`, so a SERVICE offering LUD-21 `verify` on that payment hands
  the note to whoever holds the verify URL. Naming the output is what makes
  `verify` safe to offer at all.

- `PayRequestInfo.commentAllowed` is surfaced and `namesMintOutput()` decides
  the capability from either spelling: LUD-25 advertises it as
  `commentAllowed >= 64`, one mint shipped `mintToHash` first. One rule in
  one place, because both directions of a wrong answer cost a note - read it
  as no and the note is the payment preimage, published on the mint's verify
  URL; read it as yes and the wallet waits for a note minted elsewhere.

**Also breaking: an unrecognised refusal no longer aborts a restore, and no
longer counts toward the gap.**

`classifyNoteError` falls through to a bare `ServiceRejectedError` for any
reason string it has no pattern for, and the walk rethrew it, so a single
unfamiliar reason from a SERVICE ended the whole restore. Any new note state
- expiry being the obvious one - would have done it.

- Only `NoteUnknownError` advances the gap counter now. Every other refusal
  means the SERVICE knows the index, so it resets the counter and is reported
  in the new `RestoreResult.unresolved`. Advancing it was how a walk could
  terminate early and silently abandon live notes beyond the run.
- Transport and protocol failures still throw: a SERVICE being down is not a
  statement about an index.

## 0.3.0 - 2026-08-24

- Additive bound-mint receipt parsing and validation for sealed signers:
  `InvoiceResult.mint`, `VerifyResult.mint`, `requireBoundMintQuote` and
  `validateBoundMintReceipt`. The quote must commit the requested `h` and
  exact net amount before payment; the settled LUD-21 response must match the
  invoice and commitment and carry a valid ordinary LUD-25 note signature.
- `noteSignatureMessageForHash`, `noteSignatureDigestForHash`,
  `verifyNoteSignatureHash` and `verifyNoteSignatureHashAgainst` expose the
  existing signature construction when a signer deliberately retains `k1`.
  Existing secret-based helpers delegate to them unchanged.

## 0.2.1 - 2026-08-22

- `WithdrawRequestInfo` carries `payLink`, the way home a SERVICE may
  publish on a note's informational GET. It is the reverse of the
  `withdrawLink` a payRequest advertises, and it is the only route a
  bearer-note wallet has to a mint's discovery document: the document lives
  under a username the note never mentions and cannot be guessed from the
  callback. Without it, a WALLET that has only ever received notes cannot
  read the mint's `previousPubkeys`, so an announced key rotation is
  indistinguishable from a substituted key and gets refused.
- A `payLink` on any origin but the note's own is dropped rather than
  passed on, so a caller can treat its presence as the fact it looks like.
  Whoever controls the host controls the pin anyway, which is TOFU's own
  argument, but that argument does not stretch to letting a SERVICE
  nominate a THIRD party to vouch for its key history, and refusing costs
  nothing.

## 0.2.0 - 2026-08-22

### Deterministic note secrets and restore from a seed

- `deriveNoteRoot(seed)`, `deriveNoteSecret(root, host, index)` and
  `derivedSecretSource(root, host, start)` in `secrets.ts`, plus
  `restoreNotes(baseUrl, root, host, {gap, start}, opts)` in a new
  `restore.ts`. All additive; nothing existing changes shape.
- The scheme, in full, so this entry alone is enough to reimplement it:

  ```
  root = HMAC-SHA256(key = utf8("lnurlcash-note-v1"), msg = seed)
  k1_i = HMAC-SHA256(key = root,                      msg = utf8(host + ":" + index))
  ```

  `seed` is raw bytes of any length. A 64-byte BIP39 seed (12 words,
  English wordlist, no passphrase) is what wallets use in practice, but the
  kit is seed-format agnostic and depends on no wordlist. `host` is the
  mint host exactly as `serverOf` produces it: lowercase, port included
  where there is one, so `127.0.0.1:8899` and `mint.example` derive
  different secrets. `index` is decimal ASCII counting from 0, and the
  separator is a single colon. The HMAC output is 32 bytes, rendered
  lowercase hex, which is the size of a payment preimage and therefore
  indistinguishable from a randomly drawn `k1` on the wire. `hashK1`
  applies unchanged, so the mint only ever receives `sha256(k1)` and sees
  nothing different from before.

  Worked example. The BIP39 mnemonic `abandon abandon abandon abandon
  abandon abandon abandon abandon abandon abandon abandon about` with an
  empty passphrase gives the seed
  `5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4`.
  Its root is
  `948f8f49347549cf2726e8b53f673a4185379344d2d7ba8877d3ded45d34d127`, and
  index 0 at host `mint.example` is
  `1f6016c80339b45dfdd1b3877c1a97d74b063cad54c4ccb866be39ed25ee2ab0`.
- Why it is in the kit rather than in a wallet: because the derivation is
  written down once, the same words restore the same notes in a different
  wallet, and the Kotlin, Python and Go ports agree with this one. That
  cross-wallet portability is the point, and it is the reason the scheme
  ships with a conformance vector.
- Counters are the wallet's, one per mint host. `derivedSecretSource` is a
  `RandomSecret`, so it drops straight into
  `LnurlcashOptions.randomSecret` and rotate, split and merge draw derived
  secrets without knowing anything about derivation; `source.index()` reads
  back the next unused index afterwards. A rotate consumes one index, a
  split consumes two. Minting can draw from the same source where the mint
  advertises `mintToHash` - see "Name the note you are buying" below - and
  the note is then derived from birth rather than from its first rotate. Persist that counter in the SAME write that stages
  the new records, and do it BEFORE the hash goes on the wire: a crash
  between the bump and the request wastes an index, which costs nothing,
  while a crash the other way round re-derives a secret the mint has
  already seen and the second note minted at it collides with the first.
- `restoreNotes` walks indices from `start`, asking the mint what each
  derived secret is worth. A live note is recorded; a note the mint reports
  as spent still counts the index as used, since re-deriving it would mint
  a duplicate id; a note the mint reports as pending is recorded with a
  null amount for the caller to reconcile later; an unknown note counts
  towards the gap. The walk stops after `gap` consecutive unknowns,
  defaulting to 20, and `next` is one past the highest index the mint
  recognised. It reads only, so an interrupted restore has changed nothing.
  Any other failure is thrown rather than swallowed, because a short walk
  reported as a finished one would leave the wallet re-deriving live
  secrets.
- A restored note carries no signature and its `k1` has just been on the
  wire, so rotate each one straight after restoring. That closes the
  exposure and gets the signature in the same call.
- The seed is bearer material for every note the wallet will ever hold.
  Store it the way the notes are stored, and never log it.
- `classifyNoteError` now returns `PendingNoteError` for the exact reason
  string `pending`, which LUD-25 fixes verbatim. Previously only the
  mutating callback classified it, so an informational GET on a note with a
  melt in flight raised a bare `ServiceRejectedError` that callers had to
  re-parse. `PendingNoteError` extends `ServiceRejectedError`, so anything
  catching the parent is unaffected.

### Name the note you are buying

- `requestInvoice(payCallback, amountMsat, {h, ...opts})` takes an optional
  `h`: the sha256 of a secret the wallet chose, sent on the LUD-06 pay
  callback exactly as `h` is sent on the withdraw callback. A mint that
  accepts it credits the minted note at that hash on settlement, so the
  wallet names the note it is buying instead of being handed one. The
  options argument is the same object as before with one more optional
  field on it, so every existing call is unaffected.
- Why it matters. Without `h` the payment preimage IS the money, and two
  sets of people learn it without being trusted: every routing node on the
  payment path, because that is how HTLC settlement works, and anyone who
  merely saw the invoice, because they can poll LUD-21 `verify` with the
  payment hash that travels inside it and take the preimage the moment it
  settles. A QR on a desktop screen is exactly that. "Rotate immediately"
  is a race against a thief in a tight polling loop with a warm connection.
  Choosing the secret yourself is not a race at all.
- The capability appears in three places, and they say different things.
  `PayRequestInfo.mintToHash` is "I accept an `h`", and is the one to
  decide from: the payRequest is the only endpoint every mint has, it is
  where a wallet already is at the moment it is about to mint, and it sits
  alongside the `withdrawLink` the draft already hangs there for
  LNURLcash's sake. `MintAddressInfo.mintToHash` is the same statement on
  the experimental discovery document, kept for consistency with the other
  capability fields there and the fallback for a mint that only says it
  there. `InvoiceResult.mintToHash` is "I bound THIS quote to the hash you
  named": per quote, and the one that matters at the moment money moves.
- So the order is: read the payRequest, fall back to the mint address, and
  a mint that advertises in neither place ignores the `h`. Undefined means
  the mint said nothing, which a wallet reads as no. Anything that is not
  exactly the boolean `true` is no, everywhere, which matters on the
  payRequest because that response is spread through and a truthy string
  would otherwise land on the typed field.
- `InvoiceResult.mintToHash` being `false` is not a refusal: it means the
  quote said nothing about `h`, and a mint may accept the parameter without
  echoing it back. Decide from the advertisement, claim by probing.
- A malformed `h` is refused with `RequestRefusedError` before anything is
  sent, so a wallet never pays for a quote the mint was always going to
  reject. The hash is normalised to lowercase on the way out.
- Persist the secret BEFORE calling `requestInvoice`. Paying for a note and
  then losing the secret is the one way this is worse than the preimage
  scheme, and persisting first removes it.
- `claimMintedNote(withdrawLink, k1, opts)` is the claim half, returning
  `{state, k1, amountMsat, callback}` with `state` one of `'minted'`,
  `'unminted'`, `'pending'` or `'spent'`. A wallet that chose its own
  secret has nothing to fetch, so it asks the mint what the note at that
  secret is worth and a live answer is the claim. Poll it while the invoice
  is unpaid; it reads only, so an `'unminted'` answer has changed nothing.
  A mint that cannot be reached throws rather than reporting `'unminted'`,
  which a caller would fairly read as "not yet" and give up on.
- No rotate follows a bound claim, and that is the point. The preimage
  scheme needs one because the mint generated the secret and `verify` hands
  it to anyone who saw the invoice. Here the mint never had it and no third
  party can learn it, so the note belongs to the wallet from the moment it
  exists. The claim GET does disclose the secret to the mint it is a claim
  on, which is not the same exposure, and a wallet that wants an offline
  signature on the note can still rotate to get one.
- **This changes what the derivation section above says about minting.**
  Until now a freshly minted note was never derived: its secret was the
  mint's preimage, which nothing in a seed produces, so the note existed
  outside the wallet's derivation until the immediate rotate moved it back
  in. Draw the secret from `deriveNoteSecret` at the next index, send its
  hash as `h`, and the minted note is seed-derived from birth. `restoreNotes`
  finds it with no rotate having happened at all, which is what closes the
  window where a wallet that crashed between paying and rotating could not
  recover the note from its words. The counter rule is unchanged and applies
  to the mint too: persist the bumped index in the same write that stages the
  pending mint, before the hash goes on the wire.
- Purely additive on the wire. A mint that does not offer `mintToHash`
  ignores the parameter, keys the note by the preimage as it always has,
  and the LUD-21 verify path is unchanged and still the way in.
- `createClient(opts).requestInvoice(payCallback, amountMsat, h?)` takes the
  hash as a third argument, and `claimMintedNote` is bound alongside it.

### Mint info, and verifying against a key history

- `MintAddressInfo` gains the operator fields a mint may publish on the
  experimental discovery endpoint: `name`, `description`, `contact`
  (`{nostr?, email?, url?}`), `tosUrl`, `motd`, `fees` (`{baseFeeMsat,
  feePpm}`, the same shape `parseMintFee` returns, so it feeds
  `applyMintFee` and `mintFeeBand` directly), `version` and
  `previousPubkeys`. All optional, all absent on most mints, and none of
  them is needed to spend a note.
- `fetchMintAddress` now maps the response field by field instead of
  spreading it through. The spread is what hid `nodeCapacity` under its
  wire name until 0.1.1, and it also put whatever a mint decided to send on
  a typed object with no type behind it. An unrecognised wire field is now
  dropped rather than carried, so a caller reading one off the object with
  a cast will find it undefined; the version of this library that
  understands that field will map it deliberately.
- `nodeCapacityMsat` is now populated from either spelling. The bare
  `nodeCapacity` is what the reference mint, the mock and everything that
  copied them emit, and it wins where a mint sends both; one live mint
  emits `nodeCapacityMsat` instead, which previously survived only by
  riding the spread.
- `verifyNoteSignature(k1, amountMsat, sig, keys)` accepts a single pubkey
  or an array, and is true if any of them signed. New
  `verifyNoteSignatureAgainst(...)` returns `{valid, pubkey}` so a caller
  learns WHICH key signed. An empty array is a rejection, never a pass.
- Why: a mint that rotates its signing key would otherwise invalidate every
  outstanding signature at once, and a wallet holding only the new key would
  read every note it already had as forged. The mint publishes its retired
  keys as `previousPubkeys`, the wallet verifies against the current key and
  that history together, and a note that verifies only against a retired key
  is one to rotate so the mint re-signs it. Only one recovery is performed
  per signature layout, so a long key history costs a string comparison
  each, not a recovery each.

### Accepting a note as payment

- `settleNoteForValue(noteUrl, {mints, minMsat, requireSignature}, opts)`
  in a new `settle.ts`, returning `{note, newUrl}`. It is the decision
  sequence every server accepting a bearer note performs, written once:
  parse the input; check the note's mint is one the server accepts, before
  any round trip, so an unaccepted mint is never contacted; fetch the
  authoritative value and the mint's signing key; verify the signature over
  that value where the server demands one; compare against the price;
  rotate.
- The rotate is the settlement, not bookkeeping after it. It burns the
  secret the payer handed over and mints a replacement only the server
  knows, in one atomic request at the mint, so it transfers ownership and
  rejects a replay in the same call: a second presentation of the same note
  finds it spent. A server that checks a note's value and grants access
  without rotating has verified a photograph of a banknote.
- New `InsufficientValueError`, extending `ServiceRejectedError` and
  carrying `amountMsat` and `minMsat`, so a server can say how short a note
  was rather than "declined". An unaccepted mint or a signature that will
  not verify raises `ServiceRejectedError`; a spent note passes
  `NoteSpentError` through; a note with a melt in flight raises
  `PendingNoteError`, which is worth retrying rather than refusing. Nothing
  is burned by any refusal, so a rejected note is still the payer's, intact.
- `AmbiguousMutationError` from the rotate reaches the caller unchanged,
  carrying the fresh secret. If that request landed, the secret is the money
  and it belongs to the server: persist it before anything else.
- An empty `mints` list accepts nothing. A note is a claim on one specific
  operator, and "any mint" is not a policy a server should be able to hold
  by accident.
- The value compared against the price is always the one the mint states.
  A note URL's own `amount` is a claim by whoever encoded it, and a
  signature, where one is required, is checked over the mint's figure, so an
  inflated URL fails rather than passing on a signature issued for the true
  amount.

### A retried mutation no longer loses the secret it minted

- Every mutation is a GET, and HTTP stacks retry a GET whose connection
  dropped: browsers on a stale keep-alive connection, Go's `net/http` on a
  reused idle one, the JDK's `HttpClient` on any idempotent method with no
  switch to stop it. The retry is byte-identical, so the mint sees the same
  request twice and answers the second with its ordinary refusal for a
  burned input, its inputs having been burned by the first. The caller was
  told the mutation never happened while a note sat at the hash it had
  disclosed, and the only copy of that secret went out of scope with the
  call. The money was not stolen, it was made unspendable by anyone at all.
- `rotateNote`, `splitNote` and `mergeNotes` now attach the secrets they
  generated to a `NoteSpentError` or a `NoteUnknownError`, the way
  `AmbiguousMutationError` already carried them. New `newSecretsOf(err)`
  reads them off any error in one line, returning an empty array when there
  are none, so a caller's catch block does not have to know which family it
  is holding.
- Only those two classes carry anything. They are the refusals that mean
  "this input is not spendable", which is exactly what a landed-then-retried
  mutation looks like. `PendingNoteError` means the input is alive and
  untouched, and a refusal on policy grounds (dust, a fee, a sunsetting
  mint) burned nothing, so both carry nothing and a caller may discard its
  staged records at once.
- The classification itself is unchanged, deliberately. At the wire a retry
  and a genuine double spend are the same answer, and whether the input was
  live when the request went out is knowledge the caller has and this
  library does not. So it hands back the secret rather than a verdict:
  persist it, then ask the mint what the note at that secret is worth. A
  live note means the mutation landed.

### The mint's signing key is called mintPubkey

- `MintAddressInfo.mintPubkey` carries the wire value unchanged and is the
  name to reach for. `nodePubkey` remains, populated with the same value,
  and is deprecated: it will be removed at the next breaking change.
  Nothing breaks in this release.
- The two keys in a discovery document are different keys. `mintPubkey` is
  what a note's signature verifies against; the Lightning node's identity
  key is embedded in `nodeUri`. Every other `node*` field on the type
  really is about the node - alias, colour, capacity, channel and peer
  counts - so the signing key was the one exception, and its name said
  nothing about that. A reader who pulled the pubkey out of `nodeUri` and
  tried to verify a note with it got a failure that explained nothing.
- It also makes the package internally consistent: the same key is already
  called `mintPubkey` on a note's own info, so a reader moving between the
  two objects met one key under two names.

### Payment requests

- `encodePaymentRequest(request)`, `decodePaymentRequest(string, {now})`,
  `isPaymentRequest(string)` and `paymentRequestAmountMsat(request)` in a
  new `request.ts`, with the `PaymentRequest` type and the
  `PAYMENT_REQUEST_PREFIX` constant.
- A request names an amount, the mints the payee accepts and where to
  deliver, so a payer's wallet can split a note and send it straight across
  instead of doing a mint-and-zap round trip through the mint's node for
  something neither party needed a node for:

  ```json
  {"v": 1, "id": "0123456789abcdef", "amount": "500", "currency": "sat",
   "methodDetails": {"mints": ["mint.example"]},
   "to": "npub1...", "memo": "lunch", "expires": 1756000000}
  ```

  `id` is 16 lowercase hex characters, `amount` is whole sats as a decimal
  string with no leading zeros, `to` is a Nostr npub or a Lightning Address
  and is absent on a charge request served over HTTP, and `expires` is unix
  seconds. `methodDetails` also accepts an optional `mintPubkeys`.
- Encoded as `lnurlcashreq1` followed by base64url (unpadded) of the
  request serialised as RFC 8785 JCS-canonical JSON: keys sorted by UTF-16
  code unit at every level, no whitespace, integers only. Canonical because
  a request is a thing people copy, quote back and match against a record of
  what they asked for, so two encodings of the same request must be the same
  string. This is NUT-18's `creqA` idiom with our own prefix, and it stays
  short enough for a single static QR.
- The object is the same charge request an HTTP 402 lnurlcash rail serves,
  plus the transport fields a wallet-to-wallet send needs, so one encoder
  covers both.
- Validation is strict in both directions, an unrecognised field included:
  quietly paying a request one did not fully understand is how a payer pays
  the wrong person. Every refusal is a `ProtocolError`.
- `amount` is in sat, which is the one exception to this library's
  msat-everywhere rule, because the field is shared with the 402 rail and
  the Cashu payment method and both count in whole units.
  `paymentRequestAmountMsat` converts exactly, so nothing has to multiply by
  hand.
- An expired request does not decode, since paying one is always wrong. At
  the expiry counts as expired, not merely past it, so a payer whose clock
  is a second behind the payee's does not send a note against a request the
  payee has already written off. `isPaymentRequest` still returns true for
  it, so a scanner routes it to the pay screen and the holder is told it
  lapsed rather than that their input was gibberish, and
  `decodePaymentRequest(input, {now: 0})` returns it for display.
- `to` is checked rather than shape-matched: an npub must survive its bech32
  checksum. A request naming a destination nobody can route to is a request
  nobody can pay, and a mistyped npub passes any regex.
- **`lnurlcashreq1` means the schema above and nothing else.** An earlier
  HTTP 402 rail emitted a shorter object under the same prefix -
  `{"a": 21, "m": ["mint.example"], "u": "sat"}`, with the amount as a
  number, no version and no id - and two schemas under one prefix cannot
  both be right. This is the one the conformance vectors pin, so it is the
  definition. The decoder reads the short form anyway, because returning
  nothing for a string it can plainly understand helps no one, and gives it
  a deterministic id derived from its own canonical bytes so the same
  challenge always reads back as the same request. Nothing in this library
  ever emits the short form.

## 0.1.2 - 2026-08-21

- `mintFeeBand` and `withinMintFeeBand`. LUD-25 states the mint fee as
  `base_fee_msat` plus a ppm cut and says nothing about rounding, and the
  two live implementations read that differently: dni's lnurl-mint - the
  reference, and what every public mint on the awesome list except moneyer
  runs - ceilings the fee to a whole sat on purpose so the mint is "never
  short a sat", while moneyer withholds the msat-exact amount.
- So `applyMintFee` is right about exactly one of them, and a wallet
  comparing a credited note against it warns spuriously against the other.
  Measured on real sats: 40,000 msat at a 1000 + 1000 ppm mint credited
  38,000, not the 38,960 the formula gives.
- `mintFeeBand` returns the range - the formula is the most a holder can be
  credited, the sat-ceilinged fee the least - and `withinMintFeeBand` is
  what a caller should compare against. `applyMintFee` is unchanged and
  still means the formula; it is now documented as the generous edge rather
  than the answer.
- Nothing here decides which reading is correct. That is a question for
  lnurl/luds#301.

## 0.1.1 - 2026-08-20

- `fetchMintAddress` now populates `nodeCapacityMsat`. The wire field is
  `nodeCapacity`, and the response was spread through unmapped, so the typed
  field was always `undefined` - inherited from lnurl-wallet, where the same
  bug hides the mint's channel capacity in the UI. `nodeNumChannels` and
  `nodeNumPeers` were never affected: those names match the wire.
- The conformance vectors now come from the published
  `lnurlcash-conformance` package rather than a git ref, so the suite runs
  against a released, attested set of vectors. Test-only; nothing consumers
  install changes.

## 0.1.0 - 2026-08-20

First release. The protocol layer of
[lnurl-wallet](https://github.com/dni/lnurl-wallet) (MIT, dni), extracted as
a standalone library.

### Changes made on extraction

**No globals.** The wallet's `offlineMode()` global became an `offline`
option, and `fetch`, `timeoutMs` and `randomSecret` joined it. Nothing reads
ambient state, so a caller can be certain what a call will and will not do.
`createClient(options)` binds one set for callers who would otherwise thread
the same object everywhere.

**No DOM or storage assumptions.** Only `fetch`, `URL` and `crypto` are
required, all substitutable.

### Behavioural fixes

Both were found by the conformance vectors, and both exist in the source
this was extracted from.

**A reasonless service error is no longer reported as an unknown note.**
`{"status":"ERROR"}` with no `reason` had a friendly default substituted
before classification, and that default — "Unknown service error" — matched
the rule for "unknown note". A service that said nothing was therefore
reported as denying the note exists, and through `probeBurnedNote` that
reads as "the burn landed": a conclusion about somebody's money drawn from a
blank. The reason is now carried through exactly as sent, empty included.

**`grossUpForMintFee` returns the true minimum, and cannot be stalled.** It
estimated linearly then walked one msat at a time, bounded by a guard. At a
99.9999% fee the walk is around a million steps, so the guard tripped and
the answer came back non-minimal — and the fee is chosen by the service, so
that input is reachable on purpose. It is now a binary search, which is
exact and bounded for every fee.

**The proportional fee term no longer overflows.** `gross * ppm / 1_000_000`
exceeds 64-bit unsigned at realistic amounts — 21M BTC is 2.1e15 msat, times
999_999 ppm is about 2.1e21 — and exceeds a double's exact range too. It is
computed split. This changes nothing in TypeScript at ordinary amounts, and
matters a great deal to the ports.

### Additions

**A mutation naming no note is refused** before it reaches the network,
rather than sent as a callback with no `k1` for a service to interpret
generously.

**`mint@localhost:8000` resolves.** A Lightning Address needs a dot to be a
domain, so a bare local host was rejected even though the resolution below
it already handled the port and the cleartext scheme such a host needs. The
strict `isLightningAddress` is unchanged; only the resolvers are more
generous, and only for hosts that are already treated as insecure.
