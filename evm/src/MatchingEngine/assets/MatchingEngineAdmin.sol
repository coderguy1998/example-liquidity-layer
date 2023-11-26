// SPDX-License-Identifier: Apache 2

pragma solidity ^0.8.19;

import {Admin} from "../../shared/Admin.sol";

import "./Errors.sol";
import {State} from "./State.sol";
import {
    getRouterEndpointState,
    AuctionConfig,
    getAuctionConfig,
    getFeeRecipientState
} from "./Storage.sol";

import {IMatchingEngineAdmin} from "../../interfaces/IMatchingEngineAdmin.sol";

abstract contract MatchingEngineAdmin is IMatchingEngineAdmin, Admin, State {
    /// @inheritdoc IMatchingEngineAdmin
    function addRouterEndpoint(uint16 chain, bytes32 router) external onlyOwnerOrAssistant {
        if (chain == 0) {
            revert ErrChainNotAllowed(chain);
        }

        if (router == bytes32(0)) {
            revert ErrInvalidEndpoint(bytes32(0));
        }

        getRouterEndpointState().endpoints[chain] = router;
    }

    /// @inheritdoc IMatchingEngineAdmin
    function setAuctionConfig(AuctionConfig calldata newConfig) external onlyOwnerOrAssistant {
        if (newConfig.auctionDuration == 0) {
            revert ErrInvalidAuctionDuration();
        }

        if (newConfig.auctionGracePeriod <= newConfig.auctionDuration) {
            revert ErrInvalidAuctionGracePeriod(newConfig.auctionGracePeriod);
        }

        if (newConfig.userPenaltyRewardBps > MAX_BPS_FEE) {
            revert ErrInvalidUserPenaltyRewardBps();
        }

        if (newConfig.initialPenaltyBps > MAX_BPS_FEE) {
            revert ErrInvalidInitialPenaltyBps();
        }

        // Update the config with the new parameters.
        AuctionConfig storage config = getAuctionConfig();

        config.auctionDuration = newConfig.auctionDuration;
        config.auctionGracePeriod = newConfig.auctionGracePeriod;
        config.penaltyBlocks = newConfig.penaltyBlocks;
        config.userPenaltyRewardBps = newConfig.userPenaltyRewardBps;
        config.initialPenaltyBps = newConfig.initialPenaltyBps;
    }

    /// @inheritdoc IMatchingEngineAdmin
    function updateFeeRecipient(address newFeeRecipient) public onlyOwnerOrAssistant {
        if (newFeeRecipient == address(0)) {
            revert InvalidAddress();
        }

        getFeeRecipientState().recipient = newFeeRecipient;
    }
}
