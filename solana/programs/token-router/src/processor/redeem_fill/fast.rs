use crate::{
    composite::*,
    state::{Custodian, FillType, PreparedFill, PreparedFillInfo},
};
use anchor_lang::{prelude::*, system_program};
use common::messages::raw::{LiquidityLayerMessage, MessageToVec};

#[derive(Accounts)]
struct CompleteFastFill<'info> {
    /// CHECK: Seeds must be \["emitter"] (Matching Engine program).
    #[account(mut)]
    custodian: UncheckedAccount<'info>,

    /// CHECK: Mutable. Seeds must be \["redeemed", vaa_digest\] (Matching Engine program).
    #[account(mut)]
    redeemed_fast_fill: UncheckedAccount<'info>,

    /// Seeds must be \["endpoint", fill.source_chain().to_be_bytes()\] (Matching Engine program).
    from_router_endpoint: Account<'info, matching_engine::state::RouterEndpoint>,

    /// Seeds must be \["endpoint", SOLANA_CHAIN.to_be_bytes()\] (Matching Engine program).
    to_router_endpoint: Account<'info, matching_engine::state::RouterEndpoint>,

    /// CHECK: Mutable. Seeds must be \["local-custody", source_chain.to_be_bytes()\]
    /// (Matching Engine program).
    #[account(mut)]
    local_custody_token: UncheckedAccount<'info>,

    program: Program<'info, matching_engine::program::MatchingEngine>,
}

/// Accounts required for [redeem_fast_fill].
#[derive(Accounts)]
pub struct RedeemFastFill<'info> {
    custodian: CheckedCustodian<'info>,

    prepared_fill: InitIfNeededPrepareFill<'info>,

    matching_engine: CompleteFastFill<'info>,
}

/// This instruction reconciles a Wormhole CCTP deposit message with a CCTP message to mint tokens
/// for the [mint_recipient](RedeemFastFill::mint_recipient) token account.
///
/// See [verify_vaa_and_mint](wormhole_cctp_solana::cpi::verify_vaa_and_mint) for more details.
pub fn redeem_fast_fill(ctx: Context<RedeemFastFill>) -> Result<()> {
    match ctx.accounts.prepared_fill.fill_type {
        FillType::Unset => handle_redeem_fast_fill(ctx),
        _ => super::redeem_fill_noop(),
    }
}

fn handle_redeem_fast_fill(ctx: Context<RedeemFastFill>) -> Result<()> {
    matching_engine::cpi::complete_fast_fill(CpiContext::new_with_signer(
        ctx.accounts.matching_engine.program.to_account_info(),
        matching_engine::cpi::accounts::CompleteFastFill {
            payer: ctx.accounts.prepared_fill.payer.to_account_info(),
            custodian: matching_engine::cpi::accounts::CheckedCustodian {
                custodian: ctx.accounts.matching_engine.custodian.to_account_info(),
            },
            fast_fill_vaa: matching_engine::cpi::accounts::LiquidityLayerVaa {
                vaa: ctx.accounts.prepared_fill.fill_vaa.to_account_info(),
            },
            redeemed_fast_fill: ctx
                .accounts
                .matching_engine
                .redeemed_fast_fill
                .to_account_info(),
            token_router_emitter: ctx.accounts.custodian.to_account_info(),
            token_router_custody_token: ctx.accounts.prepared_fill.custody_token.to_account_info(),
            router_path: matching_engine::cpi::accounts::LiveRouterPath {
                from_endpoint: matching_engine::cpi::accounts::LiveRouterEndpoint {
                    endpoint: ctx
                        .accounts
                        .matching_engine
                        .from_router_endpoint
                        .to_account_info(),
                },
                to_endpoint: matching_engine::cpi::accounts::LiveRouterEndpoint {
                    endpoint: ctx
                        .accounts
                        .matching_engine
                        .to_router_endpoint
                        .to_account_info(),
                },
            },
            local_custody_token: ctx
                .accounts
                .matching_engine
                .local_custody_token
                .to_account_info(),
            token_program: ctx.accounts.prepared_fill.token_program.to_account_info(),
            system_program: ctx.accounts.prepared_fill.system_program.to_account_info(),
        },
        &[Custodian::SIGNER_SEEDS],
    ))?;

    let fill_vaa = &ctx.accounts.prepared_fill.fill_vaa.load_unchecked();
    let fast_fill = LiquidityLayerMessage::try_from(fill_vaa.payload())
        .unwrap()
        .to_fast_fill_unchecked();

    let fill = fast_fill.fill();

    {
        let data_len = PreparedFill::compute_size(fill.redeemer_message_len().try_into().unwrap());
        let acc_info: &AccountInfo = ctx.accounts.prepared_fill.as_ref();
        let lamport_diff = Rent::get().map(|rent| {
            rent.minimum_balance(data_len)
                .saturating_sub(acc_info.lamports())
        })?;
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.prepared_fill.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.prepared_fill.payer.to_account_info(),
                    to: ctx.accounts.prepared_fill.to_account_info(),
                },
            ),
            lamport_diff,
        )?;
        acc_info.realloc(data_len, false)?;
    }

    // Set prepared fill data.
    ctx.accounts
        .prepared_fill
        .prepared_fill
        .set_inner(PreparedFill {
            info: PreparedFillInfo {
                vaa_hash: fill_vaa.digest().0,
                bump: ctx.bumps.prepared_fill.prepared_fill,
                prepared_custody_token_bump: ctx.bumps.prepared_fill.custody_token,
                redeemer: Pubkey::from(fill.redeemer()),
                prepared_by: ctx.accounts.prepared_fill.payer.key(),
                fill_type: FillType::FastFill,
                source_chain: fill.source_chain(),
                order_sender: fill.order_sender(),
            },
            redeemer_message: fill.message_to_vec(),
        });

    // Done.
    Ok(())
}
