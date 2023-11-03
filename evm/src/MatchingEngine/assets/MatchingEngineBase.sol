// SPDX-License-Identifier: Apache 2

pragma solidity ^0.8.19;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IWormhole} from "wormhole-solidity/IWormhole.sol";
import {ICircleIntegration} from "wormhole-solidity/ICircleIntegration.sol";
import {BytesParsing} from "wormhole-solidity/WormholeBytesParsing.sol";
import {Messages} from "../../shared/Messages.sol";

import "./Errors.sol";
import {State} from "./State.sol";
import {getRouterEndpointState, LiveAuctionData, getLiveAuctionInfo, InitialAuctionData, getInitialAuctionInfo, AuctionStatus} from "./Storage.sol";

abstract contract MatchingEngine is State {
    using BytesParsing for bytes;
    using Messages for *;

    event AuctionStarted(
        bytes32 indexed auctionId, 
        uint256 transferAmount, 
        uint256 startingBid, 
        address bidder
    );
    event NewBid(bytes32 indexed auctionId, uint256 newBid, uint256 oldBid, address bidder);

    // TODO: Do we need to protect against reentrancy, even though the `_token` is allow listed?
    // TODO: Should there be a minTickSize for new bids? 
    function placeInitialBid(bytes calldata fastTransferVaa, uint128 feeBid) external {
        IWormhole.VM memory vm = _verifyWormholeMessage(fastTransferVaa);   

        Messages.FastMarketOrder memory order = fastTransferVaa.decodeFastMarketOrder(); 

        _verifyRouterPath(vm.emitterChainId, vm.emitterAddress, order.targetChain);

        // Confirm the auction hasn't started yet. 
        LiveAuctionData storage auction = getLiveAuctionInfo().auctions[vm.hash];
        if (auction.startBlock != 0) {
            revert ErrAuctionAlreadyStarted();
        }
        if (feeBid > order.maxFee) {
            revert ErrBidPriceTooHigh(feeBid, order.maxFee);
        }

        /**
         * Transfer the funds to the contract. The amount that is transfered includes:
         * - The amount being transferred. 
         * - A "security deposit" to entice the relayer to initiate the transfer in a timely manner.
         * 
         * - @Note we do this before setting state in case the transfer fails.
         */  
        SafeERC20.safeTransferFrom(
            _token, 
            msg.sender, 
            address(this), 
            order.amountIn - feeBid + order.maxFee
        );

        // Set the live auction data.
        auction.status = AuctionStatus.Active;
        auction.startBlock = uint88(block.number);
        auction.highestBidder = msg.sender;
        auction.amount = order.amountIn;
        auction.maxFee = order.maxFee;
        auction.bidPrice = feeBid;
        
        /**
         * Set the initial auction data. The initial bidder will receive an 
         * additional fee once the auction is completed for initializing the auction
         * and incurring the gas costs of verifying the VAA and setting initial state. 
         */
        InitialAuctionData storage initialAuction = getInitialAuctionInfo().auctions[vm.hash];
        initialAuction.initialBidder = msg.sender;
        initialAuction.sourceChain = vm.emitterChainId;
        initialAuction.sourceRouter = vm.emitterAddress;
        initialAuction.slowSequence = order.slowSequence;

        emit AuctionStarted(vm.hash, order.amountIn, feeBid, msg.sender);
    }

    function improveBid(bytes32 auctionId, uint128 feeBid) public { 
        // Fetch auction information, if it exists.
        LiveAuctionData storage auction = getLiveAuctionInfo().auctions[auctionId];

        if (auction.status != AuctionStatus.Active) {
            revert ErrAuctionNotActive(auctionId);
        }
        if (uint88(block.number) - auction.startBlock > AUCTION_DURATION) {
            revert ErrAuctionPeriodExpired();
        }
        if (feeBid >= auction.bidPrice) {
            revert ErrBidPriceTooHigh(feeBid, auction.bidPrice);
        }

        // Transfer the funds to the contract from the new higher bidder.
        SafeERC20.safeTransferFrom(
            _token, 
            msg.sender, 
            address(this), 
            auction.amount - feeBid + auction.maxFee
        );

        // Refund the previous bidder.
        SafeERC20.safeTransfer(
            _token, 
            auction.highestBidder, 
            auction.amount - auction.bidPrice + auction.maxFee
        );

        // Update the auction data. 
        auction.bidPrice = feeBid;
        auction.highestBidder = msg.sender;

        emit NewBid(auctionId, feeBid, auction.bidPrice, msg.sender);
    }

    function executeFastOrder(
        bytes calldata fastTransferVaa
    ) external payable returns (uint64 sequence) {
        IWormhole.VM memory vm = _verifyWormholeMessage(fastTransferVaa);

        // Fetch auction information, if it exists.
        LiveAuctionData storage auction = getLiveAuctionInfo().auctions[vm.hash];

        if (auction.status != AuctionStatus.Active) {
            revert ErrAuctionNotActive(vm.hash);
        }

        uint256 blocksElapsed = uint88(block.number) - auction.startBlock;
        if (blocksElapsed <= AUCTION_DURATION) {
            revert ErrAuctionPeriodNotComplete();
        }

        Messages.FastMarketOrder memory order = fastTransferVaa.decodeFastMarketOrder();  

        if (blocksElapsed > AUCTION_GRACE_PERIOD) {
            // SLASHER NO SLASHING
        } else {
            if (auction.highestBidder != msg.sender) {
                revert ErrNotHighestBidder();
            }

            // Send fill to the recipient. 
            uint256 transferAmount = auction.amount - auction.bidPrice - order.initAuctionFee;
            SafeERC20.safeIncreaseAllowance(_token, address(_wormholeCctp), transferAmount);

            sequence = _wormholeCctp.transferTokensWithPayload{value: msg.value}(
                ICircleIntegration.TransferParameters({
                    token: address(_token),
                    amount: transferAmount,
                    targetChain: order.targetChain,
                    mintRecipient: getRouterEndpointState().endpoints[order.targetChain]
                }),
                NONCE,
                Messages
                    .Fill({
                        sourceChain: vm.emitterChainId,
                        orderSender: order.sender,
                        redeemer: order.redeemer,
                        redeemerMessage: order.redeemerMessage
                    })
                    .encode()
            ); 

            // Return the security deposit to the highest bidder.
            SafeERC20.safeTransfer(
                _token, 
                auction.highestBidder, 
                auction.maxFee
            );
        }

        // Refund the initial bidder. 
        SafeERC20.safeTransfer(
            _token, 
            getInitialAuctionInfo().auctions[vm.hash].initialBidder,
            order.initAuctionFee 
        ); 

        auction.status = AuctionStatus.Completed;
    }

    // ------------------------------- Private ---------------------------------

    function _verifyRouterPath(uint16 chain, bytes32 fromRouter, uint16 targetChain) private view {
        bytes32 expectedRouter = getRouterEndpointState().endpoints[chain];
        if (fromRouter != expectedRouter) {
            revert ErrInvalidSourceRouter(fromRouter, expectedRouter);
        }

        if (getRouterEndpointState().endpoints[targetChain] == bytes32(0)) {
            revert ErrInvalidTargetRouter(targetChain);
        }
    }

    function _verifyWormholeMessage(bytes calldata vaa) private view returns (IWormhole.VM memory) {
        (IWormhole.VM memory vm, bool valid, string memory reason) = 
            _wormhole.parseAndVerifyVM(vaa);

        if (!valid) {
            revert ErrInvalidWormholeMessage(reason);
        } 

        return vm;
    }
}