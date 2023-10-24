// SPDX-License-Identifier: Apache 2

pragma solidity 0.8.19;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICircleIntegration} from "wormhole-solidity/ICircleIntegration.sol";
import {IMatchingEngine} from "../../interfaces/IMatchingEngine.sol";
import {BytesParsing} from "wormhole-solidity/WormholeBytesParsing.sol";

import {Admin} from "../../shared/Admin.sol";
import {Messages} from "../../shared/Messages.sol";
import {fromUniversalAddress, toUniversalAddress, normalizeAmount, getDecimals} from "../../shared/Utils.sol";

import "./Errors.sol";
import {State} from "./State.sol";

import "../../interfaces/IPlaceMarketOrder.sol";
import {RouterInfo} from "../../interfaces/Types.sol";

abstract contract PlaceMarketOrder is IPlaceMarketOrder, Admin, State {
    using BytesParsing for bytes;
    using Messages for *;

    uint256 public constant MAX_NUM_RELAYERS = 8;

    function placeMarketOrder(
        PlaceMarketOrderArgs calldata args
    ) external payable notPaused returns (uint64 sequence) {
        sequence = _placeMarketOrder(args, defaultRelayerFee(), new bytes32[](0));
    }

    function placeMarketOrder(
        PlaceMarketOrderArgs calldata args,
        uint256 relayerFee,
        bytes32[] memory allowedRelayers
    ) external payable notPaused returns (uint64 sequence) {
        if (allowedRelayers.length > MAX_NUM_RELAYERS) {
            revert ErrTooManyRelayers(allowedRelayers.length, MAX_NUM_RELAYERS);
        }
        sequence = _placeMarketOrder(args, relayerFee, allowedRelayers);
    }

    function _placeMarketOrder(
        PlaceMarketOrderArgs calldata args,
        uint256 relayerFee,
        bytes32[] memory allowedRelayers
    ) private returns (uint64 sequence) {
        if (
            args.minAmountOut == 0 ||
            normalizeAmount(args.minAmountOut, getDecimals(address(_orderToken))) == 0
        ) {
            revert ErrZeroMinAmountOut();
        }

        RouterInfo memory dst = getRouterInfo(args.targetChain);

        // Transfer the order token to this contract.
        SafeERC20.safeTransferFrom(_orderToken, msg.sender, address(this), args.amountIn);

        // We either need to encode an order message for the matching engine or directly encode
        // a fill message for the target chain.
        if (
            (_wormholeChainId == _canonicalTokenChain || _tokenType == TokenType.Canonical) &&
            (args.targetChain == _canonicalTokenChain || dst.tokenType == TokenType.Canonical)
        ) {
            sequence = _handleCanonicalToCanonical(args, dst.endpoint);
        } else if (_tokenType == TokenType.Cctp) {
            if (dst.tokenType == TokenType.Cctp) {
                sequence = _handleCctpToCctp(args, dst.endpoint);
            } else {
                sequence = _handleCctpToMatchingEngine(
                    args,
                    dst.slippage,
                    relayerFee,
                    allowedRelayers
                );
            }
        } else {
            sequence = _handleBridgeToMatchingEngine(
                args,
                dst.slippage,
                relayerFee,
                allowedRelayers
            );
        }
    }

    function _handleCctpToCctp(
        PlaceMarketOrderArgs calldata args,
        bytes32 dstEndpoint
    ) private returns (uint64 sequence) {
        if (args.amountIn < args.minAmountOut) {
            revert ErrInsufficientAmount(args.amountIn, args.minAmountOut);
        }

        SafeERC20.safeIncreaseAllowance(_orderToken, address(_wormholeCctp), args.amountIn);

        sequence = _wormholeCctp.transferTokensWithPayload{value: msg.value}(
            ICircleIntegration.TransferParameters({
                token: address(_orderToken),
                amount: args.amountIn,
                targetChain: args.targetChain,
                mintRecipient: dstEndpoint
            }),
            0, // nonce
            Messages
                .Fill({
                    sourceChain: _wormholeChainId,
                    orderSender: toUniversalAddress(msg.sender),
                    redeemer: args.redeemer,
                    redeemerMessage: args.redeemerMessage
                })
                .encode()
        );
    }

    function _handleCanonicalToCanonical(
        PlaceMarketOrderArgs calldata args,
        bytes32 dstEndpoint
    ) private returns (uint64 sequence) {
        if (args.amountIn < args.minAmountOut) {
            revert ErrInsufficientAmount(args.amountIn, args.minAmountOut);
        }

        SafeERC20.safeIncreaseAllowance(_orderToken, address(_tokenBridge), args.amountIn);

        sequence = _tokenBridge.transferTokensWithPayload{value: msg.value}(
            address(_orderToken),
            args.amountIn,
            args.targetChain,
            dstEndpoint,
            0, // nonce
            Messages
                .Fill({
                    sourceChain: _wormholeChainId,
                    orderSender: toUniversalAddress(msg.sender),
                    redeemer: args.redeemer,
                    redeemerMessage: args.redeemerMessage
                })
                .encode()
        );
    }

    function _handleCctpToMatchingEngine(
        PlaceMarketOrderArgs calldata args,
        uint24 dstSlippage,
        uint256 relayerFee,
        bytes32[] memory allowedRelayers
    ) private returns (uint64 sequence) {
        if (_wormholeChainId == _matchingEngineChain) {
            sequence = _executeMatchingEngineOrder(args, dstSlippage);
        } else {
            _validateForMatchingEngine(args, dstSlippage, relayerFee);

            // Create market order.
            Messages.MarketOrder memory order = Messages.MarketOrder({
                minAmountOut: args.minAmountOut,
                targetChain: args.targetChain,
                redeemer: args.redeemer,
                sender: toUniversalAddress(msg.sender),
                refundAddress: toUniversalAddress(args.refundAddress),
                redeemerMessage: args.redeemerMessage,
                relayerFee: relayerFee,
                allowedRelayers: allowedRelayers
            });

            SafeERC20.safeIncreaseAllowance(_orderToken, address(_wormholeCctp), args.amountIn);

            sequence = _wormholeCctp.transferTokensWithPayload{value: msg.value}(
                ICircleIntegration.TransferParameters({
                    token: address(_orderToken),
                    amount: args.amountIn,
                    targetChain: _matchingEngineChain,
                    mintRecipient: _matchingEngineEndpoint
                }),
                0, // nonce
                order.encode()
            );
        }
    }

    function _handleBridgeToMatchingEngine(
        PlaceMarketOrderArgs calldata args,
        uint24 dstSlippage,
        uint256 relayerFee,
        bytes32[] memory allowedRelayers
    ) private returns (uint64 sequence) {
        if (_wormholeChainId == _matchingEngineChain) {
            sequence = _executeMatchingEngineOrder(args, dstSlippage);
        } else {
            _validateForMatchingEngine(args, dstSlippage, relayerFee);

            // Create market order.
            Messages.MarketOrder memory order = Messages.MarketOrder({
                minAmountOut: args.minAmountOut,
                targetChain: args.targetChain,
                redeemer: args.redeemer,
                sender: toUniversalAddress(msg.sender),
                refundAddress: toUniversalAddress(args.refundAddress),
                redeemerMessage: args.redeemerMessage,
                relayerFee: relayerFee,
                allowedRelayers: allowedRelayers
            });

            SafeERC20.safeIncreaseAllowance(_orderToken, address(_tokenBridge), args.amountIn);

            sequence = _tokenBridge.transferTokensWithPayload{value: msg.value}(
                address(_orderToken),
                args.amountIn,
                _matchingEngineChain,
                _matchingEngineEndpoint,
                0, // nonce
                order.encode()
            );
        }
    }

    function _validateForMatchingEngine(
        PlaceMarketOrderArgs memory args,
        uint256 dstSlippage,
        uint256 relayerFee
    ) private pure {
        unchecked {
            if (args.amountIn <= relayerFee) {
                revert ErrInsufficientAmount(args.amountIn, relayerFee);
            }

            // Slippage should be computed by adjusting out the relayer fee.
            uint256 amountMinusFee = args.amountIn - relayerFee;

            if (amountMinusFee > MAX_AMOUNT) {
                revert ErrAmountTooLarge(amountMinusFee, MAX_AMOUNT);
            }

            // MAX_AMOUNT * MAX_SLIPPAGE < max uint256, so we can do this unchecked.
            uint256 totalSlippage = (amountMinusFee * dstSlippage) / MAX_SLIPPAGE;

            // The minimum amount out must not exceed the amount in less the fees less the computed
            // slippage.
            if (args.minAmountOut > amountMinusFee - totalSlippage) {
                revert ErrMinAmountOutExceedsLimit(
                    args.minAmountOut,
                    amountMinusFee - totalSlippage
                );
            }
        }
    }

    function _executeMatchingEngineOrder(
        PlaceMarketOrderArgs calldata args,
        uint24 dstSlippage
    ) private returns (uint64) {
        _validateForMatchingEngine(args, dstSlippage, 0);

        // Create market order.
        Messages.MarketOrder memory order = Messages.MarketOrder({
            minAmountOut: args.minAmountOut,
            targetChain: args.targetChain,
            redeemer: args.redeemer,
            sender: toUniversalAddress(msg.sender),
            refundAddress: toUniversalAddress(args.refundAddress),
            redeemerMessage: args.redeemerMessage,
            relayerFee: 0,
            allowedRelayers: new bytes32[](0)
        });

        address _matchingEngine = fromUniversalAddress(_matchingEngineEndpoint);
        SafeERC20.safeIncreaseAllowance(_orderToken, _matchingEngine, args.amountIn);

        return IMatchingEngine(_matchingEngine).executeOrder(args.amountIn, order);
    }
}
