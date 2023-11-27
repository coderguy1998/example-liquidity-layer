// SPDX-License-Identifier: Apache 2

pragma solidity ^0.8.19;

import "../../interfaces/IMatchingEngineTypes.sol";

// keccak256("FeeRecipient") - 1
bytes32 constant FEE_RECIPIENT_STORAGE_SLOT =
    0x8743f91cd3aa128615946fad71e2f5cfe95e4c35cccb2afbc7ecaa9a9b7f137f;

function getFeeRecipientState() pure returns (FeeRecipient storage state) {
    assembly ("memory-safe") {
        state.slot := FEE_RECIPIENT_STORAGE_SLOT
    }
}

// keccak256("RouterEndpoints") - 1
bytes32 constant ROUTER_ENDPOINT_STORAGE_SLOT =
    0x3627fcf6b5d29b232a423d0b586326756a413529bc2286eb687a1a7d4123d9ff;

function getRouterEndpointState() pure returns (RouterEndpoints storage state) {
    assembly ("memory-safe") {
        state.slot := ROUTER_ENDPOINT_STORAGE_SLOT
    }
}

// keccak256("LiveAuctionInfo") - 1
bytes32 constant LIVE_AUCTION_INFO_STORAGE_SLOT =
    0x18c32f0e31dd215bbecc21bc81c00cdff3cf52fdbe43432c8c0922334994dee1;

function getLiveAuctionInfo() pure returns (LiveAuctionInfo storage state) {
    assembly ("memory-safe") {
        state.slot := LIVE_AUCTION_INFO_STORAGE_SLOT
    }
}

// keccak256("FastFills") - 1
bytes32 constant TRANSFER_RECEIPTS_STORAGE_SLOT =
    0xe58c46ab8c228ca315cb45e78f52803122060218943a20abb9ffec52c71706cc;

function getFastFillsState() pure returns (FastFills storage state) {
    assembly ("memory-safe") {
        state.slot := TRANSFER_RECEIPTS_STORAGE_SLOT
    }
}

// keccak256("AuctionConfig") - 1
bytes32 constant AUCTION_CONFIG_STORAGE_SLOT =
    0xa320c769f09a94dd6faf0389ca772db7dfcc947c2488fc9922d32847a96d0c92;

function getAuctionConfig() pure returns (AuctionConfig storage state) {
    assembly ("memory-safe") {
        state.slot := AUCTION_CONFIG_STORAGE_SLOT
    }
}
