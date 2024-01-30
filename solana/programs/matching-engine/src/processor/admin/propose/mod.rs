mod auction_parameters;
pub use auction_parameters::*;

use crate::state::{Custodian, Proposal, ProposalAction};
use anchor_lang::prelude::*;

struct Propose<'ctx, 'info> {
    custodian: &'ctx mut Account<'info, Custodian>,
    proposal: &'ctx mut Account<'info, Proposal>,
    by: &'ctx AccountInfo<'info>,
    epoch_schedule: &'ctx Sysvar<'info, EpochSchedule>,
}

fn propose(accounts: Propose, action: ProposalAction, proposal_bump_seed: u8) -> Result<()> {
    let Propose {
        custodian,
        proposal,
        by,
        epoch_schedule,
    } = accounts;

    let slot_proposed_at = Clock::get().map(|clock| clock.slot)?;

    // Create the proposal.
    proposal.set_inner(Proposal {
        id: custodian.next_proposal_id,
        bump: proposal_bump_seed,
        action,
        by: by.key(),
        owner: custodian.owner.key(),
        slot_proposed_at,
        slot_enact_by: slot_proposed_at + epoch_schedule.slots_per_epoch,
        slot_enacted_at: None,
    });

    // Uptick the next proposal ID.
    custodian.next_proposal_id += 1;

    // Done.
    Ok(())
}
