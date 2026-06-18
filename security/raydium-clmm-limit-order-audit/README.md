# Raydium CLMM — Limit-Order Engine Solvency Audit

**Scope:** Raydium Immunefi bug bounty (`raydium-io/raydium-clmm`), in-scope impacts
limited to **direct theft of user funds** and **freezing of user funds**. PoC required.

**Result: no exploitable theft/freeze vulnerability found.** This is a negative result
(evidence, not proof), plus a reusable randomized harness. Nothing here has been or
should be submitted as a finding — the only residue observed is sub-unit dust *retained
by the pool*, which is explicitly out of scope.

## Why this target

CP-Swap (CPMM) core paths were reviewed first and are guarded by the
`constant_after >= constant_before` k-invariant with correct rounding discipline —
clean. In CLMM, the **limit-order engine** is the freshest surface: custom code
(`states/limit_order.rs`, `instructions/limit_order/*`, `TickState::match_limit_order`)
layered on the core AMM and *outside* the OtterSec review scope that the program
excludes from rewards. That is where a theft/freeze bug would most plausibly live.

## Method

Manual review established the intended solvency model:

- Output owed to order owners is always **floored**; input charged to swappers is
  always **ceiled** (`get_price_at_tick(tick, round_up)` — `false` for payout, `true`
  for charge). The pool keeps the dust on both conversions.
- The floor on `ideal_remaining` biases an order toward claiming *more* filled, but the
  per-order `effective_filled = total_filled - 1` (non-exact) dust deduction
  over-compensates, and the `settled_output`-diff scheme caps cumulative error at O(1)
  per segment.
- `require_gte!(orders_amount, amount_out_continue_to_consume)` and the
  `.min(part_filled_orders_remaining)` cap on decrease prevent vault underflow.

To stress that model, a **randomized property harness** drives the real source through
random sequences of `open → match(swap) → settle → decrease` on a single tick, tracking
both token vaults as physical running balances and asserting the in-scope invariant:

> **Neither vault may ever go negative** (negative == paid out more than deposited == theft).

### Coverage (all green)

- **84,000 randomized episodes** total.
- Ticks from `-5000` to `23028` (prices ~0.6×–10×).
- Fee paths: `fee_rate ∈ {0, 1bp, 5bp, 25bp, 1%}`, both `is_fee_on_input` directions,
  both `is_base_input` modes; fees modeled as real vault balances.
- A dust-stress variant (size 1–4 orders, size 1–6 matches) — the regime where
  per-order floor error is maximal and cumulative over-crediting would first appear.
- Multi-cohort phase transitions, interleaved partial decreases, full final drain.

## How to reproduce

1. Clone the in-scope source:
   `git clone https://github.com/raydium-io/raydium-clmm`
2. Append the two `#[test]` functions in `solvency_harness.rs.txt` into the existing
   `#[cfg(test)] mod tests` in `programs/amm/src/states/limit_order.rs` (it reuses the
   module's `create_mock_tick_state` / `open_order` helpers).
3. Run:
   ```
   cargo test -p raydium-clmm --lib randomized_limit_order -- --nocapture
   ```
   Expected: both properties hold; the pre-existing 54 limit-order tests still pass.

A negative vault at any step prints the seed + full operation trace — that failing
sequence would itself be the PoC. None occurred.

## Unexplored surface (where to look next)

- Cross-tick swap routing in `swap.rs` (~6.6k lines): how `match_limit_order` composes
  with concentrated-liquidity steps as one swap walks multiple ticks.
- Limit orders + CLMM liquidity active at the **same** tick (model assumed a pure
  limit-order tick).
- Instruction-level account validation: the `init_if_needed` nonce PDA and tick-array
  `get_or_create` in `open_limit_order`; bitmap flip/deinit paths.
- Reward-growth accounting on tick crossing.

## Disclosure posture

Independent analysis of public open-source code only; any real finding would go through
the official Immunefi report flow with a PoC — never exploited against the live
deployment.
