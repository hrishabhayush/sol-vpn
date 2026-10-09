//! sol-vpn payment ledger: public USDC vault + Arcium-encrypted per-slot balances.
//!
//! Encrypted state lives in `Ledger` as MXE ciphertexts; every computation reads it via
//! `ArgBuilder::account` and the callback writes the new ciphertexts back. A `busy` lock
//! serializes computations so no update is lost.
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

const COMP_DEF_OFFSET_INIT_LEDGER: u32 = comp_def_offset("init_ledger");
const COMP_DEF_OFFSET_DEPOSIT: u32 = comp_def_offset("deposit");
const COMP_DEF_OFFSET_RESERVE: u32 = comp_def_offset("reserve");
const COMP_DEF_OFFSET_REDEEM: u32 = comp_def_offset("redeem");
const COMP_DEF_OFFSET_SETTLE: u32 = comp_def_offset("settle");

pub const PRICE_PER_MINUTE: u64 = 10_000; // USDC base units
pub const FEE_BPS: u64 = 1_200; // 12% to treasury
pub const MAX_DEPOSIT_MINUTES: u64 = 1_000_000;
// Must match encrypted-ixs: Pack<[Slot; 16]> = 12 field elements, Pack<[u32; 16]> = 3.
pub const NODES: usize = 16;
pub const SLOT_CTS: usize = 12;
pub const EARN_CTS: usize = 3;
// Byte offsets of the ciphertext arrays inside the Ledger account (8-byte discriminator first).
const SLOTS_OFFSET: u32 = 8 + 16;
const EARN_OFFSET: u32 = SLOTS_OFFSET + 32 * SLOT_CTS as u32 + 16;

declare_id!("3QuVNKcmcHcHcirr3u4c8a8wCT9g2bWR4CaSdQwgwvnw");

#[arcium_program]
pub mod ledger {
    use super::*;

    // ---------- comp def init (once after deploy) ----------
    pub fn init_init_ledger_comp_def(ctx: Context<InitInitLedgerCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)
    }
    pub fn init_deposit_comp_def(ctx: Context<InitDepositCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)
    }
    pub fn init_reserve_comp_def(ctx: Context<InitReserveCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)
    }
    pub fn init_redeem_comp_def(ctx: Context<InitRedeemCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)
    }
    pub fn init_settle_comp_def(ctx: Context<InitSettleCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)
    }

    // ---------- setup ----------
    /// Creates config, vault and ledger accounts and queues encryption of the zeroed state.
    pub fn initialize(ctx: Context<Initialize>, computation_offset: u64) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.payer.key();
        c.mint = ctx.accounts.mint.key();
        c.treasury = ctx.accounts.treasury.key();
        c.bump = ctx.bumps.config;
        ctx.accounts.ledger.busy = true;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let ledger = ctx.accounts.ledger.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            ArgBuilder::new().build(),
            vec![InitLedgerCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[writable(ledger)],
            )?],
            1,
            0,
            0,
        )
    }

    #[arcium_callback(encrypted_ix = "init_ledger")]
    pub fn init_ledger_callback(
        ctx: Context<InitLedgerCallback>,
        output: SignedComputationOutputs<InitLedgerOutput>,
    ) -> Result<()> {
        let o = output
            .verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account)?
            .field_0;
        let l = &mut ctx.accounts.ledger;
        l.slots_nonce = o.field_0.nonce;
        l.slots = o.field_0.ciphertexts;
        l.earn_nonce = o.field_1.nonce;
        l.earn = o.field_1.ciphertexts;
        l.busy = false;
        Ok(())
    }

    /// Signer = node authority (also payout owner and redeem signer). node_id = registry index.
    pub fn register_node(
        ctx: Context<RegisterNode>,
        endpoint: String,
        tee: u8,
        expected_measurement: [u8; 48],
    ) -> Result<()> {
        require!(endpoint.len() <= 64, LedgerError::EndpointTooLong);
        let c = &mut ctx.accounts.config;
        let n = &mut ctx.accounts.node;
        n.authority = ctx.accounts.authority.key();
        n.id = c.node_count;
        n.tee = tee;
        n.expected_measurement = expected_measurement;
        n.endpoint = endpoint;
        c.node_count += 1;
        emit!(NodeRegistered { node_id: n.id, authority: n.authority });
        Ok(())
    }

    // ---------- deposit ----------
    pub fn deposit(
        ctx: Context<Deposit>,
        computation_offset: u64,
        amount: u64,
        ct_slot: [u8; 32],
        ct_secret: [u8; 32],
        pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        require!(
            amount > 0
                && amount % PRICE_PER_MINUTE == 0
                && amount / PRICE_PER_MINUTE <= MAX_DEPOSIT_MINUTES,
            LedgerError::BadAmount
        );
        let ledger = ctx.accounts.ledger.key();
        let l = &mut ctx.accounts.ledger;
        require!(!l.busy, LedgerError::Busy);
        l.busy = true;
        l.refund_to = ctx.accounts.user_token.key();
        l.refund_amount = amount;
        token::transfer(
            CpiContext::new(
                token::ID,
                Transfer {
                    from: ctx.accounts.user_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            amount,
        )?;
        let args = ArgBuilder::new()
            .x25519_pubkey(pubkey)
            .plaintext_u128(nonce)
            .encrypted_u8(ct_slot)
            .encrypted_u64(ct_secret)
            .plaintext_u32((amount / PRICE_PER_MINUTE) as u32)
            .plaintext_u128(ctx.accounts.ledger.slots_nonce)
            .account(ledger, SLOTS_OFFSET, 32 * SLOT_CTS as u32)
            .build();
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let cb = DepositCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[
                writable(ledger),
                readonly(ctx.accounts.config.key()),
                writable(ctx.accounts.vault.key()),
                writable(ctx.accounts.user_token.key()),
                readonly(token::ID),
            ],
        )?;
        queue_computation(ctx.accounts, computation_offset, args, vec![cb], 1, 0, 0)
    }

    /// On ok: store new state. On !ok or aborted computation: refund the deposit.
    #[arcium_callback(encrypted_ix = "deposit")]
    pub fn deposit_callback(
        ctx: Context<DepositCallback>,
        output: SignedComputationOutputs<DepositOutput>,
    ) -> Result<()> {
        let res = output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account);
        let ok = match res {
            Ok(DepositOutput { field_0: o }) if o.field_1 => {
                ctx.accounts.ledger.slots_nonce = o.field_0.nonce;
                ctx.accounts.ledger.slots = o.field_0.ciphertexts;
                true
            }
            _ => false,
        };
        ctx.accounts.ledger.busy = false;
        if !ok {
            require_keys_eq!(ctx.accounts.user_token.key(), ctx.accounts.ledger.refund_to);
            vault_pay(
                &ctx.accounts.vault,
                &ctx.accounts.user_token,
                &ctx.accounts.config,
                ctx.accounts.ledger.refund_amount,
            )?;
        }
        emit!(DepositResult { ok });
        Ok(())
    }

    // ---------- reserve ----------
    /// Any signer may pay; use a wallet unlinked to the depositor for privacy.
    pub fn reserve(
        ctx: Context<Reserve>,
        computation_offset: u64,
        node_id: u8,
        ct_slot: [u8; 32],
        ct_secret: [u8; 32],
        ct_minutes: [u8; 32],
        pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        require!(node_id < ctx.accounts.config.node_count, LedgerError::UnknownNode);
        let ledger = ctx.accounts.ledger.key();
        let l = &mut ctx.accounts.ledger;
        require!(!l.busy, LedgerError::Busy);
        l.busy = true;
        ctx.accounts.reservation.node_id = node_id;
        let args = ArgBuilder::new()
            .x25519_pubkey(pubkey)
            .plaintext_u128(nonce)
            .encrypted_u8(ct_slot)
            .encrypted_u64(ct_secret)
            .encrypted_u32(ct_minutes)
            .plaintext_u8(node_id)
            .plaintext_u128(ctx.accounts.ledger.slots_nonce)
            .account(ledger, SLOTS_OFFSET, 32 * SLOT_CTS as u32)
            .build();
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let cb = ReserveCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[writable(ledger), writable(ctx.accounts.reservation.key())],
        )?;
        queue_computation(ctx.accounts, computation_offset, args, vec![cb], 1, 0, 0)
    }

    #[arcium_callback(encrypted_ix = "reserve")]
    pub fn reserve_callback(
        ctx: Context<ReserveCallback>,
        output: SignedComputationOutputs<ReserveOutput>,
    ) -> Result<()> {
        let res = output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account);
        let r = &mut ctx.accounts.reservation;
        if let Ok(ReserveOutput { field_0: o }) = res {
            ctx.accounts.ledger.slots_nonce = o.field_0.nonce;
            ctx.accounts.ledger.slots = o.field_0.ciphertexts;
            r.ok = o.field_1;
            r.minutes = o.field_2;
        }
        r.done = true;
        ctx.accounts.ledger.busy = false;
        emit!(ReserveResult { reservation: r.key(), node_id: r.node_id, ok: r.ok, minutes: r.minutes });
        Ok(())
    }

    // ---------- redeem ----------
    /// Submitted by the node authority with the client's latest encrypted voucher.
    pub fn redeem(
        ctx: Context<Redeem>,
        computation_offset: u64,
        node_id: u8,
        ct: [[u8; 32]; 5],
        pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let ledger = ctx.accounts.ledger.key();
        let l = &mut ctx.accounts.ledger;
        require!(!l.busy, LedgerError::Busy);
        l.busy = true;
        let args = ArgBuilder::new()
            .x25519_pubkey(pubkey)
            .plaintext_u128(nonce)
            .encrypted_u8(ct[0])
            .encrypted_u64(ct[1])
            .encrypted_u32(ct[2])
            .encrypted_u32(ct[3])
            .encrypted_u8(ct[4])
            .plaintext_u8(node_id)
            .plaintext_u128(l.slots_nonce)
            .account(ledger, SLOTS_OFFSET, 32 * SLOT_CTS as u32)
            .plaintext_u128(l.earn_nonce)
            .account(ledger, EARN_OFFSET, 32 * EARN_CTS as u32)
            .build();
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let cb = RedeemCallback::callback_ix(computation_offset, &ctx.accounts.mxe_account, &[writable(ledger)])?;
        queue_computation(ctx.accounts, computation_offset, args, vec![cb], 1, 0, 0)
    }

    #[arcium_callback(encrypted_ix = "redeem")]
    pub fn redeem_callback(
        ctx: Context<RedeemCallback>,
        output: SignedComputationOutputs<RedeemOutput>,
    ) -> Result<()> {
        let res = output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account);
        let l = &mut ctx.accounts.ledger;
        let mut ok = false;
        if let Ok(RedeemOutput { field_0: o }) = res {
            l.slots_nonce = o.field_0.nonce;
            l.slots = o.field_0.ciphertexts;
            l.earn_nonce = o.field_1.nonce;
            l.earn = o.field_1.ciphertexts;
            ok = o.field_2;
        }
        l.busy = false;
        emit!(RedeemResult { ok });
        Ok(())
    }

    // ---------- settle + claim ----------
    /// Permissionless: reveals cumulative per-node earnings into Config.earned.
    pub fn settle(ctx: Context<Settle>, computation_offset: u64) -> Result<()> {
        let args = ArgBuilder::new()
            .plaintext_u128(ctx.accounts.ledger.earn_nonce)
            .account(ctx.accounts.ledger.key(), EARN_OFFSET, 32 * EARN_CTS as u32)
            .build();
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let cb = SettleCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[writable(ctx.accounts.config.key())],
        )?;
        queue_computation(ctx.accounts, computation_offset, args, vec![cb], 1, 0, 0)
    }

    #[arcium_callback(encrypted_ix = "settle")]
    pub fn settle_callback(
        ctx: Context<SettleCallback>,
        output: SignedComputationOutputs<SettleOutput>,
    ) -> Result<()> {
        let earned = output
            .verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account)?
            .field_0;
        let c = &mut ctx.accounts.config;
        for i in 0..NODES {
            // cumulative, so a stale (out-of-order) settle never lowers it
            c.earned[i] = c.earned[i].max(earned[i] as u64);
        }
        emit!(Settled { earned: c.earned });
        Ok(())
    }

    /// Pays a node its settled-but-unpaid minutes: 88% to node, 12% to treasury.
    pub fn claim(ctx: Context<Claim>, node_id: u8) -> Result<()> {
        let i = node_id as usize;
        let c = &mut ctx.accounts.config;
        let gross = (c.earned[i] - c.paid[i]) * PRICE_PER_MINUTE;
        c.paid[i] = c.earned[i];
        let fee = gross * FEE_BPS / 10_000;
        vault_pay(&ctx.accounts.vault, &ctx.accounts.node_token, c, gross - fee)?;
        vault_pay(&ctx.accounts.vault, &ctx.accounts.treasury, c, fee)?;
        emit!(Claimed { node_id, payout: gross - fee, fee });
        Ok(())
    }
}

fn writable(pubkey: Pubkey) -> CallbackAccount {
    CallbackAccount { pubkey, is_writable: true }
}
fn readonly(pubkey: Pubkey) -> CallbackAccount {
    CallbackAccount { pubkey, is_writable: false }
}

fn vault_pay<'info>(
    vault: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    config: &Account<'info, Config>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer(
        CpiContext::new_with_signer(
            token::ID,
            Transfer {
                from: vault.to_account_info(),
                to: to.to_account_info(),
                authority: config.to_account_info(),
            },
            &[&[b"config", &[config.bump]]],
        ),
        amount,
    )
}

// ---------- state ----------
#[account]
pub struct Config {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub treasury: Pubkey,
    pub bump: u8,
    pub node_count: u8,
    pub earned: [u64; NODES], // cumulative minutes revealed by settle
    pub paid: [u64; NODES],   // cumulative minutes paid by claim
}
impl Config {
    pub const SPACE: usize = 8 + 32 * 3 + 2 + 8 * NODES * 2;
}

/// Field order is load-bearing: SLOTS_OFFSET / EARN_OFFSET index into it.
#[account]
pub struct Ledger {
    pub slots_nonce: u128,
    pub slots: [[u8; 32]; SLOT_CTS],
    pub earn_nonce: u128,
    pub earn: [[u8; 32]; EARN_CTS],
    pub busy: bool,
    pub refund_to: Pubkey,
    pub refund_amount: u64,
}
impl Ledger {
    pub const SPACE: usize = 8 + 16 + 32 * SLOT_CTS + 16 + 32 * EARN_CTS + 1 + 32 + 8;
}

/// NodeRegistry entry, PDA ["node", node_id].
#[account]
pub struct Node {
    pub authority: Pubkey,
    pub id: u8,
    pub tee: u8, // 0 mock, 1 tdx, 2 sev-snp
    pub expected_measurement: [u8; 48],
    pub endpoint: String,
}
impl Node {
    pub const SPACE: usize = 8 + 32 + 2 + 48 + 4 + 64;
}

/// Public reserve result, PDA ["resv", computation_offset LE]. Node reads it via the reserve tx.
#[account]
pub struct Reservation {
    pub node_id: u8,
    pub done: bool,
    pub ok: bool,
    pub minutes: u32,
}
impl Reservation {
    pub const SPACE: usize = 8 + 3 + 4;
}

// ---------- accounts ----------
#[queue_computation_accounts("init_ledger", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: checked by the arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_LEDGER))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(init, payer = payer, space = Config::SPACE, seeds = [b"config"], bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = payer, space = Ledger::SPACE, seeds = [b"ledger"], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    pub mint: Box<Account<'info, anchor_spl::token::Mint>>,
    #[account(init, payer = payer, seeds = [b"vault"], bump, token::mint = mint, token::authority = config)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(token::mint = mint)]
    pub treasury: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[callback_accounts("init_ledger")]
#[derive(Accounts)]
pub struct InitLedgerCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_LEDGER))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"ledger"], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
}

#[derive(Accounts)]
pub struct RegisterNode<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init, payer = authority, space = Node::SPACE,
        seeds = [b"node".as_ref(), &[config.node_count]], bump,
        constraint = (config.node_count as usize) < NODES @ LedgerError::RegistryFull,
    )]
    pub node: Box<Account<'info, Node>>,
    pub system_program: Program<'info, System>,
}

#[queue_computation_accounts("deposit", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: checked by the arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_DEPOSIT))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"ledger"], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.mint, token::authority = payer)]
    pub user_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[callback_accounts("deposit")]
#[derive(Accounts)]
pub struct DepositCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_DEPOSIT))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"ledger"], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub user_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[queue_computation_accounts("reserve", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct Reserve<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: checked by the arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_RESERVE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"ledger"], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(init, payer = payer, space = Reservation::SPACE, seeds = [b"resv".as_ref(), &computation_offset.to_le_bytes()], bump)]
    pub reservation: Box<Account<'info, Reservation>>,
}

#[callback_accounts("reserve")]
#[derive(Accounts)]
pub struct ReserveCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_RESERVE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"ledger"], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(mut)]
    pub reservation: Box<Account<'info, Reservation>>,
}

#[queue_computation_accounts("redeem", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, node_id: u8)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: checked by the arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REDEEM))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(mut, seeds = [b"ledger"], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(seeds = [b"node".as_ref(), &[node_id]], bump, constraint = node.authority == payer.key() @ LedgerError::NotNodeAuthority)]
    pub node: Box<Account<'info, Node>>,
}

#[callback_accounts("redeem")]
#[derive(Accounts)]
pub struct RedeemCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REDEEM))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"ledger"], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
}

#[queue_computation_accounts("settle", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct Settle<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, space = 9, payer = payer, seeds = [&SIGN_PDA_SEED], bump, address = derive_sign_pda!())]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: checked by the arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SETTLE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(seeds = [b"ledger"], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

#[callback_accounts("settle")]
#[derive(Accounts)]
pub struct SettleCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SETTLE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
#[instruction(node_id: u8)]
pub struct Claim<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [b"node".as_ref(), &[node_id]], bump, has_one = authority @ LedgerError::NotNodeAuthority)]
    pub node: Box<Account<'info, Node>>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = config.mint, token::authority = authority)]
    pub node_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.treasury)]
    pub treasury: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

macro_rules! init_comp_def_accounts {
    ($name:ident, $ix:literal) => {
        #[init_computation_definition_accounts($ix, payer)]
        #[derive(Accounts)]
        pub struct $name<'info> {
            #[account(mut)]
            pub payer: Signer<'info>,
            #[account(mut, address = derive_mxe_pda!())]
            pub mxe_account: Box<Account<'info, MXEAccount>>,
            #[account(mut)]
            /// CHECK: checked by arcium program.
            pub comp_def_account: UncheckedAccount<'info>,
            #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
            /// CHECK: checked by arcium program.
            pub address_lookup_table: UncheckedAccount<'info>,
            #[account(address = LUT_PROGRAM_ID)]
            /// CHECK: Address Lookup Table program.
            pub lut_program: UncheckedAccount<'info>,
            pub arcium_program: Program<'info, Arcium>,
            pub system_program: Program<'info, System>,
        }
    };
}
init_comp_def_accounts!(InitInitLedgerCompDef, "init_ledger");
init_comp_def_accounts!(InitDepositCompDef, "deposit");
init_comp_def_accounts!(InitReserveCompDef, "reserve");
init_comp_def_accounts!(InitRedeemCompDef, "redeem");
init_comp_def_accounts!(InitSettleCompDef, "settle");

// ---------- events / errors ----------
#[event]
pub struct NodeRegistered {
    pub node_id: u8,
    pub authority: Pubkey,
}
#[event]
pub struct DepositResult {
    pub ok: bool,
}
#[event]
pub struct ReserveResult {
    pub reservation: Pubkey,
    pub node_id: u8,
    pub ok: bool,
    pub minutes: u32,
}
#[event]
pub struct RedeemResult {
    pub ok: bool,
}
#[event]
pub struct Settled {
    pub earned: [u64; NODES],
}
#[event]
pub struct Claimed {
    pub node_id: u8,
    pub payout: u64,
    pub fee: u64,
}

#[error_code]
pub enum LedgerError {
    #[msg("Another ledger computation is in flight; retry")]
    Busy,
    #[msg("Amount must be a positive multiple of the per-minute price")]
    BadAmount,
    #[msg("Unknown node")]
    UnknownNode,
    #[msg("Signer is not the node authority")]
    NotNodeAuthority,
    #[msg("Node registry full")]
    RegistryFull,
    #[msg("Endpoint too long")]
    EndpointTooLong,
}
