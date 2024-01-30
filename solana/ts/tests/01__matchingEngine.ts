import * as wormholeSdk from "@certusone/wormhole-sdk";
import { getPostedMessage } from "@certusone/wormhole-sdk/lib/cjs/solana/wormhole";
import * as splToken from "@solana/spl-token";
import {
    ComputeBudgetProgram,
    Connection,
    Keypair,
    PublicKey,
    SYSVAR_RENT_PUBKEY,
    SystemProgram,
    TransactionInstruction,
    VersionedTransactionResponse,
} from "@solana/web3.js";
import { use as chaiUse, expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import {
    CctpTokenBurnMessage,
    FastMarketOrder,
    Fill,
    LiquidityLayerDeposit,
    LiquidityLayerMessage,
} from "../src";
import {
    Auction,
    AuctionConfig,
    AuctionParameters,
    Custodian,
    MatchingEngineProgram,
    RouterEndpoint,
} from "../src/matchingEngine";
import { VaaAccount } from "../src/wormhole";
import {
    CircleAttester,
    ETHEREUM_USDC_ADDRESS,
    LOCALHOST,
    MOCK_GUARDIANS,
    OWNER_ASSISTANT_KEYPAIR,
    PAYER_KEYPAIR,
    USDC_MINT_ADDRESS,
    bigintToU64BN,
    expectIxErr,
    expectIxOk,
    expectIxOkDetails,
    getUsdcAtaBalance,
    numberToU64BN,
    postLiquidityLayerVaa,
    waitUntilSlot,
} from "./helpers";

chaiUse(chaiAsPromised);

describe("Matching Engine", function () {
    const connection = new Connection(LOCALHOST, "confirmed");

    // owner is also the recipient in all tests
    const payer = PAYER_KEYPAIR;
    const owner = Keypair.generate();
    const relayer = Keypair.generate();
    const ownerAssistant = OWNER_ASSISTANT_KEYPAIR;
    const feeRecipient = Keypair.generate().publicKey;
    const feeRecipientToken = splToken.getAssociatedTokenAddressSync(
        USDC_MINT_ADDRESS,
        feeRecipient
    );
    const newFeeRecipient = Keypair.generate().publicKey;
    const offerAuthorityOne = Keypair.generate();
    const offerAuthorityTwo = Keypair.generate();
    const liquidator = Keypair.generate();

    // Foreign endpoints.
    const ethChain = wormholeSdk.CHAINS.ethereum;
    const ethRouter = Array.from(Buffer.alloc(32, "deadbeef", "hex"));
    const ethDomain = 0;
    const arbChain = wormholeSdk.CHAINS.arbitrum;
    const arbRouter = Array.from(Buffer.alloc(32, "bead", "hex"));
    const arbDomain = 3;
    const solanaChain = wormholeSdk.CHAINS.solana;
    const solanaRouter = Array.from(Buffer.alloc(32, "c0ffee", "hex"));
    const solanaDomain = 5;

    // Matching Engine program.
    const engine = new MatchingEngineProgram(
        connection,
        "MatchingEngine11111111111111111111111111111",
        USDC_MINT_ADDRESS
    );

    describe("Admin", function () {
        describe("Initialize", function () {
            const auctionParams: AuctionParameters = {
                userPenaltyRewardBps: 250000,
                initialPenaltyBps: 250000,
                duration: 2,
                gracePeriod: 5,
                penaltySlots: 10,
            };

            const createInitializeIx = (opts?: {
                ownerAssistant?: PublicKey;
                feeRecipient?: PublicKey;
                mint?: PublicKey;
            }) =>
                engine.initializeIx(auctionParams, {
                    owner: payer.publicKey,
                    ownerAssistant: opts?.ownerAssistant ?? ownerAssistant.publicKey,
                    feeRecipient: opts?.feeRecipient ?? feeRecipient,
                    mint: opts?.mint ?? USDC_MINT_ADDRESS,
                });

            it("Cannot Initialize without USDC Mint", async function () {
                const mint = await splToken.createMint(connection, payer, payer.publicKey, null, 6);

                const ix = await engine.initializeIx(auctionParams, {
                    owner: payer.publicKey,
                    ownerAssistant: ownerAssistant.publicKey,
                    feeRecipient,
                    mint,
                });
                const unknownAta = splToken.getAssociatedTokenAddressSync(
                    mint,
                    engine.custodianAddress(),
                    true
                );
                await expectIxErr(
                    connection,
                    [ix],
                    [payer],
                    `Instruction references an unknown account ${unknownAta.toString()}`
                );
            });

            it("Cannot Initialize with Default Owner Assistant", async function () {
                await expectIxErr(
                    connection,
                    [
                        await createInitializeIx({
                            ownerAssistant: PublicKey.default,
                        }),
                    ],
                    [payer],
                    "Error Code: AssistantZeroPubkey"
                );
            });

            it("Cannot Initialize with Default Fee Recipient", async function () {
                await expectIxErr(
                    connection,
                    [
                        await createInitializeIx({
                            feeRecipient: PublicKey.default,
                        }),
                    ],
                    [payer],
                    "Error Code: FeeRecipientZeroPubkey"
                );
            });

            it("Cannot Initialize with Invalid Auction Duration", async function () {
                const newAuctionParams: AuctionParameters = { ...auctionParams };
                newAuctionParams.duration = 0;

                await expectIxErr(
                    connection,
                    [
                        await engine.initializeIx(newAuctionParams, {
                            owner: payer.publicKey,
                            ownerAssistant: ownerAssistant.publicKey,
                            feeRecipient,
                            mint: USDC_MINT_ADDRESS,
                        }),
                    ],
                    [payer],
                    "Error Code: InvalidAuctionDuration"
                );
            });

            it("Cannot Initialize with Invalid Auction Grace Period", async function () {
                const newAuctionParams: AuctionParameters = { ...auctionParams };
                newAuctionParams.gracePeriod = 0;

                await expectIxErr(
                    connection,
                    [
                        await engine.initializeIx(newAuctionParams, {
                            owner: payer.publicKey,
                            ownerAssistant: ownerAssistant.publicKey,
                            feeRecipient,
                            mint: USDC_MINT_ADDRESS,
                        }),
                    ],
                    [payer],
                    "Error Code: InvalidAuctionGracePeriod"
                );
            });

            it("Cannot Initialize with Invalid User Penalty", async function () {
                const newAuctionParams: AuctionParameters = { ...auctionParams };
                newAuctionParams.userPenaltyRewardBps = 4294967295;

                await expectIxErr(
                    connection,
                    [
                        await engine.initializeIx(newAuctionParams, {
                            owner: payer.publicKey,
                            ownerAssistant: ownerAssistant.publicKey,
                            feeRecipient,
                            mint: USDC_MINT_ADDRESS,
                        }),
                    ],
                    [payer],
                    "Error Code: UserPenaltyTooLarge"
                );
            });

            it("Cannot Initialize with Invalid Initial Penalty", async function () {
                const newAuctionParams: AuctionParameters = { ...auctionParams };
                newAuctionParams.initialPenaltyBps = 4294967295;

                await expectIxErr(
                    connection,
                    [
                        await engine.initializeIx(newAuctionParams, {
                            owner: payer.publicKey,
                            ownerAssistant: ownerAssistant.publicKey,
                            feeRecipient,
                            mint: USDC_MINT_ADDRESS,
                        }),
                    ],
                    [payer],
                    "Error Code: InitialPenaltyTooLarge"
                );
            });

            it("Finally Initialize Program", async function () {
                await expectIxOk(connection, [await createInitializeIx()], [payer]);

                const expectedAuctionConfigId = 0;
                const custodianData = await engine.fetchCustodian();
                expect(custodianData).to.eql(
                    new Custodian(
                        payer.publicKey,
                        null,
                        ownerAssistant.publicKey,
                        feeRecipientToken,
                        expectedAuctionConfigId,
                        bigintToU64BN(0n)
                    )
                );

                const auctionConfigData = await engine.fetchAuctionConfig(0);
                expect(auctionConfigData).to.eql(
                    new AuctionConfig(expectedAuctionConfigId, auctionParams)
                );
            });

            it("Cannot Call Instruction Again: initialize", async function () {
                await expectIxErr(
                    connection,
                    [await createInitializeIx({})],
                    [payer],
                    "already in use"
                );
            });

            before("Set up Token Accounts", async function () {
                await splToken.getOrCreateAssociatedTokenAccount(
                    connection,
                    payer,
                    USDC_MINT_ADDRESS,
                    feeRecipient
                );

                await splToken.getOrCreateAssociatedTokenAccount(
                    connection,
                    payer,
                    USDC_MINT_ADDRESS,
                    PublicKey.default
                );

                await splToken.getOrCreateAssociatedTokenAccount(
                    connection,
                    payer,
                    USDC_MINT_ADDRESS,
                    SystemProgram.programId
                );
            });

            after("Transfer Lamports to Owner and Owner Assistant", async function () {
                await expectIxOk(
                    connection,
                    [
                        SystemProgram.transfer({
                            fromPubkey: payer.publicKey,
                            toPubkey: owner.publicKey,
                            lamports: 1000000000,
                        }),
                        SystemProgram.transfer({
                            fromPubkey: payer.publicKey,
                            toPubkey: ownerAssistant.publicKey,
                            lamports: 1000000000,
                        }),
                    ],
                    [payer]
                );
            });
        });

        describe("Ownership Transfer Request", async function () {
            // Create the submit ownership transfer instruction, which will be used
            // to set the pending owner to the `relayer` key.
            const createSubmitOwnershipTransferIx = (opts?: {
                sender?: PublicKey;
                newOwner?: PublicKey;
            }) =>
                engine.submitOwnershipTransferIx({
                    owner: opts?.sender ?? owner.publicKey,
                    newOwner: opts?.newOwner ?? relayer.publicKey,
                });

            // Create the confirm ownership transfer instruction, which will be used
            // to set the new owner to the `relayer` key.
            const createConfirmOwnershipTransferIx = (opts?: { sender?: PublicKey }) =>
                engine.confirmOwnershipTransferIx({
                    pendingOwner: opts?.sender ?? relayer.publicKey,
                });

            // Instruction to cancel an ownership transfer request.
            const createCancelOwnershipTransferIx = (opts?: { sender?: PublicKey }) =>
                engine.cancelOwnershipTransferIx({
                    owner: opts?.sender ?? owner.publicKey,
                });

            it("Submit Ownership Transfer Request as Deployer (Payer)", async function () {
                await expectIxOk(
                    connection,
                    [
                        await createSubmitOwnershipTransferIx({
                            sender: payer.publicKey,
                            newOwner: owner.publicKey,
                        }),
                    ],
                    [payer]
                );

                // Confirm that the pending owner variable is set in the owner config.
                const custodianData = await engine.fetchCustodian();

                expect(custodianData.pendingOwner).to.eql(owner.publicKey);
            });

            it("Confirm Ownership Transfer Request as Pending Owner", async function () {
                await expectIxOk(
                    connection,
                    [await createConfirmOwnershipTransferIx({ sender: owner.publicKey })],
                    [payer, owner]
                );

                // Confirm that the owner config reflects the current ownership status.
                {
                    const custodianData = await engine.fetchCustodian();
                    expect(custodianData.owner).to.eql(owner.publicKey);
                    expect(custodianData.pendingOwner).to.eql(null);
                }
            });

            it("Cannot Submit Ownership Transfer Request (New Owner == Address(0))", async function () {
                await expectIxErr(
                    connection,
                    [
                        await createSubmitOwnershipTransferIx({
                            newOwner: PublicKey.default,
                        }),
                    ],
                    [payer, owner],
                    "InvalidNewOwner"
                );
            });

            it("Cannot Submit Ownership Transfer Request (New Owner == Owner)", async function () {
                await expectIxErr(
                    connection,
                    [
                        await createSubmitOwnershipTransferIx({
                            newOwner: owner.publicKey,
                        }),
                    ],
                    [payer, owner],
                    "AlreadyOwner"
                );
            });

            it("Cannot Submit Ownership Transfer Request as Non-Owner", async function () {
                await expectIxErr(
                    connection,
                    [
                        await createSubmitOwnershipTransferIx({
                            sender: ownerAssistant.publicKey,
                        }),
                    ],
                    [payer, ownerAssistant],
                    "OwnerOnly"
                );
            });

            it("Submit Ownership Transfer Request as Owner", async function () {
                await expectIxOk(
                    connection,
                    [await createSubmitOwnershipTransferIx()],
                    [payer, owner]
                );

                // Confirm that the pending owner variable is set in the owner config.
                const custodianData = await engine.fetchCustodian();
                expect(custodianData.pendingOwner).to.eql(relayer.publicKey);
            });

            it("Cannot Confirm Ownership Transfer Request as Non Pending Owner", async function () {
                await expectIxErr(
                    connection,
                    [
                        await createConfirmOwnershipTransferIx({
                            sender: ownerAssistant.publicKey,
                        }),
                    ],
                    [payer, ownerAssistant],
                    "NotPendingOwner"
                );
            });

            it("Confirm Ownership Transfer Request as Pending Owner", async function () {
                await expectIxOk(
                    connection,
                    [await createConfirmOwnershipTransferIx()],
                    [payer, relayer]
                );

                // Confirm that the owner config reflects the current ownership status.
                {
                    const custodianData = await engine.fetchCustodian();
                    expect(custodianData.owner).to.eql(relayer.publicKey);
                    expect(custodianData.pendingOwner).to.eql(null);
                }

                // Set the owner back to the payer key.
                await expectIxOk(
                    connection,
                    [
                        await createSubmitOwnershipTransferIx({
                            sender: relayer.publicKey,
                            newOwner: owner.publicKey,
                        }),
                    ],
                    [payer, relayer]
                );

                await expectIxOk(
                    connection,
                    [await createConfirmOwnershipTransferIx({ sender: owner.publicKey })],
                    [payer, owner]
                );

                // Confirm that the payer is the owner again.
                {
                    const custodianData = await engine.fetchCustodian();
                    expect(custodianData.owner).to.eql(owner.publicKey);
                    expect(custodianData.pendingOwner).to.eql(null);
                }
            });

            it("Cannot Cancel Ownership Request as Non-Owner", async function () {
                // First, submit the ownership transfer request.
                await expectIxOk(
                    connection,
                    [await createSubmitOwnershipTransferIx()],
                    [payer, owner]
                );

                // Confirm that the pending owner variable is set in the owner config.
                {
                    const custodianData = await engine.fetchCustodian();
                    expect(custodianData.pendingOwner).to.eql(relayer.publicKey);
                }

                // Confirm that the cancel ownership transfer request fails.
                await expectIxErr(
                    connection,
                    [await createCancelOwnershipTransferIx({ sender: ownerAssistant.publicKey })],
                    [payer, ownerAssistant],
                    "OwnerOnly"
                );
            });

            it("Cancel Ownership Request as Owner", async function () {
                await expectIxOk(
                    connection,
                    [await createCancelOwnershipTransferIx()],
                    [payer, owner]
                );

                // Confirm the pending owner field was reset.
                const custodianData = await engine.fetchCustodian();
                expect(custodianData.pendingOwner).to.eql(null);
            });
        });

        describe("Update Owner Assistant", async function () {
            // Create the update owner assistant instruction.
            const createUpdateOwnerAssistantIx = (opts?: {
                sender?: PublicKey;
                newAssistant?: PublicKey;
            }) =>
                engine.updateOwnerAssistantIx({
                    owner: opts?.sender ?? owner.publicKey,
                    newOwnerAssistant: opts?.newAssistant ?? relayer.publicKey,
                });

            it("Cannot Update Assistant (New Assistant == Address(0))", async function () {
                await expectIxErr(
                    connection,
                    [await createUpdateOwnerAssistantIx({ newAssistant: PublicKey.default })],
                    [payer, owner],
                    "InvalidNewAssistant"
                );
            });

            it("Cannot Update Assistant as Non-Owner", async function () {
                await expectIxErr(
                    connection,
                    [await createUpdateOwnerAssistantIx({ sender: ownerAssistant.publicKey })],
                    [payer, ownerAssistant],
                    "OwnerOnly"
                );
            });

            it("Update Assistant as Owner", async function () {
                await expectIxOk(
                    connection,
                    [await createUpdateOwnerAssistantIx()],
                    [payer, owner]
                );

                // Confirm the assistant field was updated.
                const custodianData = await engine.fetchCustodian();
                expect(custodianData.ownerAssistant).to.eql(relayer.publicKey);

                // Set the assistant back to the assistant key.
                await expectIxOk(
                    connection,
                    [
                        await createUpdateOwnerAssistantIx({
                            newAssistant: ownerAssistant.publicKey,
                        }),
                    ],
                    [payer, owner]
                );
            });
        });

        describe("Add Router Endpoint", function () {
            it("Cannot Add Router Endpoint as Non-Owner and Non-Assistant", async function () {
                const ix = await engine.addRouterEndpointIx(
                    { ownerOrAssistant: payer.publicKey },
                    {
                        chain: ethChain,
                        address: ethRouter,
                        mintRecipient: null,
                    }
                );

                await expectIxErr(connection, [ix], [payer], "OwnerOrAssistantOnly");
            });

            [wormholeSdk.CHAINS.unset, solanaChain].forEach((chain) =>
                it(`Cannot Register Chain ID == ${chain}`, async function () {
                    const chain = 0;

                    await expectIxErr(
                        connection,
                        [
                            await engine.addRouterEndpointIx(
                                { ownerOrAssistant: owner.publicKey },
                                { chain, address: ethRouter, mintRecipient: null }
                            ),
                        ],
                        [owner],
                        "ChainNotAllowed"
                    );
                })
            );

            it("Cannot Register Zero Address", async function () {
                const ix = await engine.addRouterEndpointIx(
                    { ownerOrAssistant: owner.publicKey },
                    {
                        chain: ethChain,
                        address: new Array(32).fill(0),
                        mintRecipient: null,
                    }
                );

                await expectIxErr(connection, [ix], [owner], "InvalidEndpoint");
            });

            it("Add Router Endpoint as Owner Assistant", async function () {
                const contractAddress = Array.from(Buffer.alloc(32, "fbadc0de", "hex"));
                const mintRecipient = Array.from(Buffer.alloc(32, "deadbeef", "hex"));
                const ix = await engine.addRouterEndpointIx(
                    { ownerOrAssistant: ownerAssistant.publicKey },
                    {
                        chain: ethChain,
                        address: contractAddress,
                        mintRecipient,
                    }
                );
                await expectIxOk(connection, [ix], [ownerAssistant]);

                const routerEndpointData = await engine.fetchRouterEndpoint(ethChain);
                expect(routerEndpointData).to.eql(
                    new RouterEndpoint(255, ethChain, contractAddress, mintRecipient)
                );
            });

            it("Update Router Endpoint as Owner", async function () {
                const ix = await engine.addRouterEndpointIx(
                    { ownerOrAssistant: owner.publicKey },
                    {
                        chain: ethChain,
                        address: ethRouter,
                        mintRecipient: null,
                    }
                );

                await expectIxOk(connection, [ix], [owner]);

                const routerEndpointData = await engine.fetchRouterEndpoint(ethChain);
                expect(routerEndpointData).to.eql(
                    new RouterEndpoint(255, ethChain, ethRouter, ethRouter)
                );
            });
        });

        describe("Add Local Router Endpoint", function () {
            it("Cannot Add Local Router Endpoint without Executable", async function () {
                const ix = await engine.addLocalRouterEndpointIx({
                    ownerOrAssistant: ownerAssistant.publicKey,
                    tokenRouterProgram: SYSVAR_RENT_PUBKEY,
                });

                const [bogusEmitter] = PublicKey.findProgramAddressSync(
                    [Buffer.from("emitter")],
                    SYSVAR_RENT_PUBKEY
                );
                await splToken.getOrCreateAssociatedTokenAccount(
                    connection,
                    payer,
                    USDC_MINT_ADDRESS,
                    bogusEmitter,
                    true
                );

                await expectIxErr(
                    connection,
                    [ix],
                    [ownerAssistant],
                    "Error Code: ConstraintExecutable"
                );
            });

            it("Cannot Add Local Router Endpoint using System Program", async function () {
                const ix = await engine.addLocalRouterEndpointIx({
                    ownerOrAssistant: ownerAssistant.publicKey,
                    tokenRouterProgram: SystemProgram.programId,
                });

                const [bogusEmitter] = PublicKey.findProgramAddressSync(
                    [Buffer.from("emitter")],
                    SystemProgram.programId
                );
                await splToken.getOrCreateAssociatedTokenAccount(
                    connection,
                    payer,
                    USDC_MINT_ADDRESS,
                    bogusEmitter,
                    true
                );

                await expectIxErr(
                    connection,
                    [ix],
                    [ownerAssistant],
                    "Error Code: InvalidEndpoint"
                );
            });
        });

        describe("Update Fee Recipient", async function () {
            const localVariables = new Map<string, any>();

            it("Cannot Update Fee Recipient with Non-Existent ATA", async function () {
                const ix = await engine.updateFeeRecipientIx({
                    ownerOrAssistant: ownerAssistant.publicKey,
                    newFeeRecipient,
                });

                await expectIxErr(
                    connection,
                    [ix],
                    [ownerAssistant],
                    "new_fee_recipient_token. Error Code: AccountNotInitialized"
                );

                localVariables.set("ix", ix);
            });

            it("Update Fee Recipient as Owner Assistant", async function () {
                const ix = localVariables.get("ix") as TransactionInstruction;
                expect(localVariables.delete("ix")).is.true;

                await splToken.getOrCreateAssociatedTokenAccount(
                    connection,
                    payer,
                    USDC_MINT_ADDRESS,
                    newFeeRecipient
                );

                await expectIxOk(connection, [ix], [ownerAssistant]);

                const custodianData = await engine.fetchCustodian();
                expect(custodianData.feeRecipientToken).to.eql(
                    splToken.getAssociatedTokenAddressSync(USDC_MINT_ADDRESS, newFeeRecipient)
                );
            });

            it("Cannot Update Fee Recipient without Owner or Assistant", async function () {
                const ix = await engine.updateFeeRecipientIx({
                    ownerOrAssistant: payer.publicKey,
                    newFeeRecipient: feeRecipient,
                });

                await expectIxErr(connection, [ix], [payer], "Error Code: OwnerOrAssistantOnly");
            });

            it("Cannot Update Fee Recipient to Default Pubkey", async function () {
                const ix = await engine.updateFeeRecipientIx({
                    ownerOrAssistant: ownerAssistant.publicKey,
                    newFeeRecipient: PublicKey.default,
                });

                await expectIxErr(connection, [ix], [ownerAssistant], "FeeRecipientZeroPubkey");
            });

            it("Update Fee Recipient as Owner", async function () {
                const ix = await engine.updateFeeRecipientIx({
                    ownerOrAssistant: owner.publicKey,
                    newFeeRecipient: feeRecipient,
                });
                await expectIxOk(connection, [ix], [owner]);

                const custodianData = await engine.fetchCustodian();
                expect(custodianData.feeRecipientToken).to.eql(feeRecipientToken);
            });
        });
    });

    describe("Business Logic", function () {
        let testCctpNonce = 2n ** 64n - 1n;

        // Hack to prevent math overflow error when invoking CCTP programs.
        testCctpNonce -= 10n * 6400n;

        let wormholeSequence = 0n;

        const baseFastOrder: FastMarketOrder = {
            amountIn: 50000000000n,
            minAmountOut: 0n,
            targetChain: arbChain,
            destinationCctpDomain: arbDomain,
            redeemer: Array.from(Buffer.alloc(32, "deadbeef", "hex")),
            sender: Array.from(Buffer.alloc(32, "beefdead", "hex")),
            refundAddress: Array.from(Buffer.alloc(32, "beef", "hex")),
            maxFee: 1000000n,
            initAuctionFee: 100n,
            deadline: 0,
            redeemerMessage: Buffer.from("All your base are belong to us."),
        };

        before("Register To Router Endpoints", async function () {
            await expectIxOk(
                connection,
                [
                    await engine.addRouterEndpointIx(
                        {
                            ownerOrAssistant: owner.publicKey,
                        },
                        {
                            chain: arbChain,
                            address: arbRouter,
                            mintRecipient: null,
                        }
                    ),
                ],
                [owner]
            );
        });

        before("Transfer Lamports to Offer Authorities", async function () {
            await expectIxOk(
                connection,
                [
                    SystemProgram.transfer({
                        fromPubkey: payer.publicKey,
                        toPubkey: offerAuthorityOne.publicKey,
                        lamports: 1000000000,
                    }),
                    SystemProgram.transfer({
                        fromPubkey: payer.publicKey,
                        toPubkey: offerAuthorityTwo.publicKey,
                        lamports: 1000000000,
                    }),
                    SystemProgram.transfer({
                        fromPubkey: payer.publicKey,
                        toPubkey: liquidator.publicKey,
                        lamports: 1000000000,
                    }),
                ],
                [payer]
            );
        });

        before("Create ATAs For Offer Authorities", async function () {
            for (const wallet of [offerAuthorityOne, offerAuthorityTwo, liquidator]) {
                const destination = await splToken.createAccount(
                    connection,
                    wallet,
                    USDC_MINT_ADDRESS,
                    wallet.publicKey
                );

                // Mint USDC.
                const mintAmount = 10_000_000n * 1_000_000n;

                await expect(
                    splToken.mintTo(
                        connection,
                        payer,
                        USDC_MINT_ADDRESS,
                        destination,
                        payer,
                        mintAmount
                    )
                ).to.be.fulfilled;

                const { amount } = await splToken.getAccount(connection, destination);
                expect(amount).equals(mintAmount);
            }
        });

        describe("Place Initial Offer", function () {
            for (const offerPrice of [0n, baseFastOrder.maxFee / 2n, baseFastOrder.maxFee]) {
                it(`Place Initial Offer (Price == ${offerPrice})`, async function () {
                    // Fetch the balances before.
                    const offerBalanceBefore = await getUsdcAtaBalance(
                        connection,
                        offerAuthorityOne.publicKey
                    );
                    const { amount: custodyBalanceBefore } =
                        await engine.fetchCustodyTokenAccount();

                    const { fastVaa, txDetails } = await placeInitialOfferForTest(
                        offerAuthorityOne,
                        wormholeSequence++,
                        baseFastOrder,
                        ethRouter,
                        offerPrice
                    );

                    // Validate balance changes.
                    const offerBalanceAfter = await getUsdcAtaBalance(
                        connection,
                        offerAuthorityOne.publicKey
                    );
                    const { amount: custodyBalanceAfter } = await engine.fetchCustodyTokenAccount();
                    const balanceChange = baseFastOrder.amountIn + baseFastOrder.maxFee;

                    expect(offerBalanceAfter).equals(offerBalanceBefore - balanceChange);
                    expect(custodyBalanceAfter).equals(custodyBalanceBefore + balanceChange);

                    await checkAfterEffects({ txDetails, fastVaa, offerPrice });
                });
            }

            it("Place Initial Offer (Offer == Max Fee; Max Fee == Amount Minus 1)", async function () {
                const fastOrder = { ...baseFastOrder } as FastMarketOrder;
                fastOrder.maxFee = fastOrder.amountIn - 1n;

                // Fetch the balances before.
                const offerBalanceBefore = await getUsdcAtaBalance(
                    connection,
                    offerAuthorityOne.publicKey
                );
                const { amount: custodyBalanceBefore } = await engine.fetchCustodyTokenAccount();

                const { fastVaa, txDetails } = await placeInitialOfferForTest(
                    offerAuthorityOne,
                    wormholeSequence++,
                    fastOrder,
                    ethRouter
                );

                // Validate balance changes.
                const offerBalanceAfter = await getUsdcAtaBalance(
                    connection,
                    offerAuthorityOne.publicKey
                );
                const { amount: custodyBalanceAfter } = await engine.fetchCustodyTokenAccount();
                const balanceChange = fastOrder.amountIn + fastOrder.maxFee;
                expect(offerBalanceAfter).equals(offerBalanceBefore - balanceChange);
                expect(custodyBalanceAfter).equals(custodyBalanceBefore + balanceChange);

                await checkAfterEffects({ txDetails, fastVaa, offerPrice: fastOrder.maxFee });
            });

            it("Place Initial Offer (With Deadline)", async function () {
                const fastOrder = { ...baseFastOrder } as FastMarketOrder;
                const { maxFee: offerPrice } = fastOrder;

                // Set the deadline to 10 slots from now.
                const currTime = await connection.getBlockTime(await connection.getSlot());
                if (currTime === null) {
                    throw new Error("Failed to get current block time");
                }
                fastOrder.deadline = currTime + 10;

                // Fetch the balances before.
                const offerBalanceBefore = await getUsdcAtaBalance(
                    connection,
                    offerAuthorityOne.publicKey
                );
                const { amount: custodyBalanceBefore } = await engine.fetchCustodyTokenAccount();

                const { fastVaa, txDetails } = await placeInitialOfferForTest(
                    offerAuthorityOne,
                    wormholeSequence++,
                    fastOrder,
                    ethRouter,
                    offerPrice
                );

                // Validate balance changes.
                const offerBalanceAfter = await getUsdcAtaBalance(
                    connection,
                    offerAuthorityOne.publicKey
                );
                const { amount: custodyBalanceAfter } = await engine.fetchCustodyTokenAccount();
                const balanceChange = fastOrder.amountIn + fastOrder.maxFee;
                expect(offerBalanceAfter).equals(offerBalanceBefore - balanceChange);
                expect(custodyBalanceAfter).equals(custodyBalanceBefore + balanceChange);

                await checkAfterEffects({ txDetails, fastVaa, offerPrice });
            });

            it("Cannot Place Initial Offer (Invalid VAA)", async function () {
                const fastVaa = await postLiquidityLayerVaa(
                    connection,
                    offerAuthorityOne,
                    MOCK_GUARDIANS,
                    ethRouter,
                    wormholeSequence++,
                    Buffer.from("deadbeef", "hex")
                );

                const auction = await VaaAccount.fetch(connection, fastVaa).then((vaa) =>
                    engine.auctionAddress(vaa.digest())
                );

                const ix = await engine.placeInitialOfferIx(
                    {
                        payer: offerAuthorityOne.publicKey,
                        fastVaa,
                        auction,
                        fromRouterEndpoint: engine.routerEndpointAddress(ethChain),
                        toRouterEndpoint: engine.routerEndpointAddress(arbChain),
                    },
                    baseFastOrder.maxFee
                );
                await expectIxErr(connection, [ix], [offerAuthorityOne], "InvalidVaa");
            });

            it("Cannot Place Initial Offer (Invalid Payload)", async function () {
                const message = new LiquidityLayerMessage({
                    fastFill: {
                        amount: 1000n,
                        fill: {
                            sourceChain: ethChain,
                            orderSender: Array.from(baseFastOrder.sender),
                            redeemer: Array.from(baseFastOrder.redeemer),
                            redeemerMessage: baseFastOrder.redeemerMessage,
                        },
                    },
                });

                const fastVaa = await postLiquidityLayerVaa(
                    connection,
                    offerAuthorityOne,
                    MOCK_GUARDIANS,
                    ethRouter,
                    wormholeSequence++,
                    message
                );

                const auction = await VaaAccount.fetch(connection, fastVaa).then((vaa) =>
                    engine.auctionAddress(vaa.digest())
                );

                const ix = await engine.placeInitialOfferIx(
                    {
                        payer: offerAuthorityOne.publicKey,
                        fastVaa,
                        auction,
                        fromRouterEndpoint: engine.routerEndpointAddress(ethChain),
                        toRouterEndpoint: engine.routerEndpointAddress(arbChain),
                    },
                    baseFastOrder.maxFee
                );
                await expectIxErr(connection, [ix], [offerAuthorityOne], "NotFastMarketOrder");
            });

            it("Cannot Place Initial Offer (Deadline Exceeded)", async function () {
                const fastMarketOrder = { ...baseFastOrder } as FastMarketOrder;

                // Set the deadline to the previous block timestamp.
                fastMarketOrder.deadline = await connection
                    .getSlot()
                    .then((slot) => connection.getBlockTime(slot))
                    .then((blockTime) => blockTime! - 1);

                const fastVaa = await postLiquidityLayerVaa(
                    connection,
                    offerAuthorityOne,
                    MOCK_GUARDIANS,
                    ethRouter,
                    wormholeSequence++,
                    new LiquidityLayerMessage({ fastMarketOrder })
                );

                const ix = await engine.placeInitialOfferIx(
                    {
                        payer: offerAuthorityOne.publicKey,
                        fastVaa,
                    },
                    fastMarketOrder.maxFee
                );

                await expectIxErr(connection, [ix], [offerAuthorityOne], "FastMarketOrderExpired");
            });

            it("Cannot Place Initial Offer (Offer Price Too High)", async function () {
                const offerPrice = baseFastOrder.maxFee + 1n;

                const fastVaa = await postLiquidityLayerVaa(
                    connection,
                    offerAuthorityOne,
                    MOCK_GUARDIANS,
                    ethRouter,
                    wormholeSequence++,
                    new LiquidityLayerMessage({ fastMarketOrder: baseFastOrder })
                );

                const ix = await engine.placeInitialOfferIx(
                    {
                        payer: offerAuthorityOne.publicKey,
                        fastVaa,
                    },
                    offerPrice
                );
                await expectIxErr(connection, [ix], [offerAuthorityOne], "OfferPriceTooHigh");
            });

            it("Cannot Place Initial Offer (Invalid Emitter Chain)", async function () {
                const fastVaa = await postLiquidityLayerVaa(
                    connection,
                    payer,
                    MOCK_GUARDIANS,
                    ethRouter,
                    wormholeSequence++,
                    new LiquidityLayerMessage({ fastMarketOrder: baseFastOrder }),
                    "acala"
                );

                const { maxFee: offerPrice } = baseFastOrder;
                await expectIxErr(
                    connection,
                    [
                        await engine.placeInitialOfferIx(
                            {
                                payer: offerAuthorityOne.publicKey,
                                fastVaa,
                                fromRouterEndpoint: engine.routerEndpointAddress(ethChain),
                            },
                            offerPrice
                        ),
                    ],
                    [offerAuthorityOne],
                    "ErrInvalidSourceRouter"
                );
            });

            it("Cannot Place Initial Offer (Invalid Emitter Address)", async function () {
                const fastVaa = await postLiquidityLayerVaa(
                    connection,
                    payer,
                    MOCK_GUARDIANS,
                    arbRouter,
                    wormholeSequence++,
                    new LiquidityLayerMessage({ fastMarketOrder: baseFastOrder })
                );

                const { maxFee: offerPrice } = baseFastOrder;
                await expectIxErr(
                    connection,
                    [
                        await engine.placeInitialOfferIx(
                            {
                                payer: offerAuthorityOne.publicKey,
                                fastVaa,
                            },
                            offerPrice
                        ),
                    ],
                    [offerAuthorityOne],
                    "ErrInvalidSourceRouter"
                );
            });

            it("Cannot Place Initial Offer (Invalid Target Router Chain)", async function () {
                // Change the fast order chain Id.
                const fastMarketOrder = { ...baseFastOrder } as FastMarketOrder;
                fastMarketOrder.targetChain = wormholeSdk.CHAINS.acala;

                const fastVaa = await postLiquidityLayerVaa(
                    connection,
                    payer,
                    MOCK_GUARDIANS,
                    ethRouter,
                    wormholeSequence++,
                    new LiquidityLayerMessage({ fastMarketOrder })
                );

                const { maxFee: offerPrice } = fastMarketOrder;
                await expectIxErr(
                    connection,
                    [
                        await engine.placeInitialOfferIx(
                            {
                                payer: offerAuthorityOne.publicKey,
                                fastVaa,
                                toRouterEndpoint: engine.routerEndpointAddress(arbChain),
                            },
                            offerPrice
                        ),
                    ],
                    [offerAuthorityOne],
                    "ErrInvalidTargetRouter"
                );
            });

            it("Cannot Place Initial Offer Again", async function () {
                const fastVaa = await postLiquidityLayerVaa(
                    connection,
                    payer,
                    MOCK_GUARDIANS,
                    ethRouter,
                    wormholeSequence++,
                    new LiquidityLayerMessage({ fastMarketOrder: baseFastOrder })
                );

                const { maxFee: offerPrice } = baseFastOrder;
                const ix = await engine.placeInitialOfferIx(
                    {
                        payer: offerAuthorityOne.publicKey,
                        fastVaa,
                    },
                    offerPrice
                );
                await expectIxOk(connection, [ix], [offerAuthorityOne]);

                // TODO: find specific address already in use
                await expectIxErr(connection, [ix], [offerAuthorityOne], "already in use");
            });

            async function checkAfterEffects(args: {
                txDetails: VersionedTransactionResponse;
                fastVaa: PublicKey;
                offerPrice: bigint;
            }) {
                const { txDetails, fastVaa, offerPrice } = args;

                // Confirm the auction data.
                const vaaAccount = await VaaAccount.fetch(connection, fastVaa);
                const { fastMarketOrder } = LiquidityLayerMessage.decode(vaaAccount.payload());

                const vaaHash = vaaAccount.digest();
                const auctionData = await engine.fetchAuction(vaaHash);
                const { bump } = auctionData;

                const offerToken = splToken.getAssociatedTokenAddressSync(
                    USDC_MINT_ADDRESS,
                    offerAuthorityOne.publicKey
                );

                expect(fastMarketOrder).is.not.undefined;
                const { amountIn, maxFee } = fastMarketOrder!;

                const expectedAmountIn = bigintToU64BN(amountIn);
                expect(auctionData).to.eql(
                    new Auction(
                        bump,
                        Array.from(vaaHash),
                        { active: {} },
                        {
                            configId: 0,
                            bestOfferToken: offerToken,
                            initialOfferToken: offerToken,
                            startSlot: numberToU64BN(txDetails.slot),
                            amountIn: expectedAmountIn,
                            securityDeposit: bigintToU64BN(maxFee),
                            offerPrice: bigintToU64BN(offerPrice),
                            amountOut: expectedAmountIn,
                        }
                    )
                );
            }
        });

        describe("Improve Offer", function () {
            for (const newOffer of [0n, baseFastOrder.maxFee / 2n, baseFastOrder.maxFee - 1n]) {
                it(`Improve Offer (Price == ${newOffer})`, async function () {
                    const { auction, auctionDataBefore } = await placeInitialOfferForTest(
                        offerAuthorityOne,
                        wormholeSequence++,
                        baseFastOrder,
                        ethRouter
                    );

                    const initialOfferBalanceBefore = await getUsdcAtaBalance(
                        connection,
                        offerAuthorityOne.publicKey
                    );
                    const newOfferBalanceBefore = await getUsdcAtaBalance(
                        connection,
                        offerAuthorityTwo.publicKey
                    );
                    const { amount: custodyBalanceBefore } =
                        await engine.fetchCustodyTokenAccount();

                    const ix = await engine.improveOfferIx(
                        {
                            auction,
                            offerAuthority: offerAuthorityTwo.publicKey,
                        },
                        newOffer
                    );

                    await expectIxOk(connection, [ix], [offerAuthorityTwo]);

                    await checkAfterEffects(
                        auction,
                        offerAuthorityTwo.publicKey,
                        newOffer,
                        auctionDataBefore,
                        {
                            custodyToken: custodyBalanceBefore,
                            bestOfferToken: newOfferBalanceBefore,
                            prevBestOfferToken: initialOfferBalanceBefore,
                        }
                    );

                    // Validate balance changes.
                    // const initialOfferBalanceAfter = await getUsdcAtaBalance(
                    //     connection,
                    //     offerAuthorityOne.publicKey
                    // );
                    // const newOfferBalanceAfter = await getUsdcAtaBalance(
                    //     connection,
                    //     offerAuthorityTwo.publicKey
                    // );
                    // const { amount: custodyBalanceAfter } = await engine.fetchCustodyTokenAccount();

                    // const balanceChange = baseFastOrder.maxFee + baseFastOrder.amountIn;
                    // expect(newOfferBalanceAfter).equals(newOfferBalanceBefore - balanceChange);
                    // expect(initialOfferBalanceAfter).equals(
                    //     initialOfferBalanceBefore + balanceChange
                    // );
                    // expect(custodyBalanceAfter).equals(custodyBalanceBefore);

                    // // Confirm the auction data.
                    // const auctionDataAfter = await engine.fetchAuction(vaaHash);
                    // const { info: infoAfter } = auctionDataAfter;
                    // expect(infoAfter).is.not.null;

                    // const newOfferToken = splToken.getAssociatedTokenAddressSync(
                    //     USDC_MINT_ADDRESS,
                    //     offerAuthorityTwo.publicKey
                    // );
                    // const initialOfferToken = splToken.getAssociatedTokenAddressSync(
                    //     USDC_MINT_ADDRESS,
                    //     offerAuthorityOne.publicKey
                    // );

                    // // TODO: clean up to check deep equal Auction vs Auction
                    // expect(auctionDataAfter.vaaHash).to.eql(Array.from(vaaHash));
                    // expect(auctionDataAfter.status).to.eql({ active: {} });
                    // expect(infoAfter!.bestOfferToken).to.eql(newOfferToken);
                    // expect(infoAfter!.initialOfferToken).to.eql(initialOfferToken);
                    // expect(infoAfter!.startSlot.toString()).to.eql(
                    //     infoBefore!.startSlot.toString()
                    // );
                    // expect(infoAfter!.amountIn.toString()).to.eql(infoBefore!.amountIn.toString());
                    // expect(infoAfter!.securityDeposit.toString()).to.eql(
                    //     infoBefore!.securityDeposit.toString()
                    // );
                    // expect(infoAfter!.offerPrice.toString()).to.eql(newOffer.toString());
                });
            }

            it("Improve Offer With Same Best Offer Token Account", async function () {
                const { auction, auctionDataBefore } = await placeInitialOfferForTest(
                    offerAuthorityOne,
                    wormholeSequence++,
                    baseFastOrder,
                    ethRouter
                );

                const initialOfferBalanceBefore = await getUsdcAtaBalance(
                    connection,
                    offerAuthorityOne.publicKey
                );
                const { amount: custodyBalanceBefore } = await engine.fetchCustodyTokenAccount();

                // New Offer from offerAuthorityOne.
                const newOffer = BigInt(auctionDataBefore.info!.offerPrice.subn(100).toString());

                const ix = await engine.improveOfferIx(
                    {
                        auction,
                        offerAuthority: offerAuthorityOne.publicKey,
                    },
                    newOffer
                );

                await expectIxOk(connection, [ix], [offerAuthorityOne]);

                await checkAfterEffects(
                    auction,
                    offerAuthorityOne.publicKey,
                    newOffer,
                    auctionDataBefore,
                    {
                        custodyToken: custodyBalanceBefore,
                        bestOfferToken: initialOfferBalanceBefore,
                    }
                );
            });

            it("Cannot Improve Offer (Auction Expired)", async function () {
                const { auction, auctionDataBefore } = await placeInitialOfferForTest(
                    offerAuthorityOne,
                    wormholeSequence++,
                    baseFastOrder,
                    ethRouter
                );

                const { startSlot, offerPrice } = auctionDataBefore.info!;
                const { duration, gracePeriod } = await engine.fetchAuctionParameters();
                await waitUntilSlot(
                    connection,
                    startSlot.addn(duration + gracePeriod - 1).toNumber()
                );

                // New Offer from offerAuthorityOne.
                const newOffer = BigInt(offerPrice.subn(100).toString());

                const ix = await engine.improveOfferIx(
                    {
                        auction,
                        offerAuthority: offerAuthorityOne.publicKey,
                    },
                    newOffer
                );

                await expectIxErr(
                    connection,
                    [ix],
                    [offerAuthorityOne],
                    "Error Code: AuctionPeriodExpired"
                );
            });

            it("Cannot Improve Offer (Invalid Best Offer Token Account)", async function () {
                const { auction, auctionDataBefore } = await placeInitialOfferForTest(
                    offerAuthorityOne,
                    wormholeSequence++,
                    baseFastOrder,
                    ethRouter
                );

                // New Offer from offerAuthorityOne.
                const newOffer = BigInt(auctionDataBefore.info!.offerPrice.subn(100).toString());

                const ix = await engine.improveOfferIx(
                    {
                        auction,
                        offerAuthority: offerAuthorityOne.publicKey,
                        bestOfferToken: engine.custodyTokenAccountAddress(),
                    },
                    newOffer
                );
                await expectIxErr(
                    connection,
                    [ix],
                    [offerAuthorityOne],
                    "Error Code: BestOfferTokenMismatch"
                );
            });

            it("Cannot Improve Offer (Offer Price Not Improved)", async function () {
                const { auction, auctionDataBefore } = await placeInitialOfferForTest(
                    offerAuthorityOne,
                    wormholeSequence++,
                    baseFastOrder,
                    ethRouter
                );

                const newOffer = BigInt(auctionDataBefore.info!.offerPrice.toString());
                const ix = await engine.improveOfferIx(
                    {
                        auction,
                        offerAuthority: offerAuthorityTwo.publicKey,
                    },
                    newOffer
                );

                await expectIxErr(
                    connection,
                    [ix],
                    [offerAuthorityTwo],
                    "Error Code: OfferPriceNotImproved"
                );
            });

            async function checkAfterEffects(
                auction: PublicKey,
                newOfferAuthority: PublicKey,
                offerPrice: bigint,
                auctionDataBefore: Auction,
                balancesBefore: {
                    custodyToken: bigint;
                    bestOfferToken: bigint;
                    prevBestOfferToken?: bigint;
                }
            ) {
                const {
                    custodyToken: custodyTokenBefore,
                    bestOfferToken: bestOfferTokenBefore,
                    prevBestOfferToken: prevBestOfferTokenBefore,
                } = balancesBefore;

                const bestOfferToken = splToken.getAssociatedTokenAddressSync(
                    USDC_MINT_ADDRESS,
                    newOfferAuthority
                );

                const { bump, vaaHash, status, info } = auctionDataBefore;
                const {
                    configId,
                    bestOfferToken: prevBestOfferToken,
                    initialOfferToken,
                    startSlot,
                    amountIn,
                    securityDeposit,
                    offerPrice: prevOfferPrice,
                    amountOut,
                } = info!;
                expect(offerPrice).not.equals(BigInt(prevOfferPrice.toString()));

                const auctionDataAfter = await engine.fetchAuction({ address: auction });
                expect(auctionDataAfter).to.eql(
                    new Auction(bump, vaaHash, status, {
                        configId,
                        bestOfferToken,
                        initialOfferToken,
                        startSlot,
                        amountIn,
                        securityDeposit,
                        offerPrice: bigintToU64BN(offerPrice),
                        amountOut,
                    })
                );

                // Custody token should be unchanged.
                const { amount: custodyTokenAfter } = await engine.fetchCustodyTokenAccount();
                expect(custodyTokenAfter).equals(custodyTokenBefore);

                const balanceChange = BigInt(amountIn.add(securityDeposit).toString());

                if (prevBestOfferTokenBefore !== undefined) {
                    expect(bestOfferToken).to.not.eql(prevBestOfferToken);

                    // New offer change.
                    const { amount: bestOfferTokenAfter } = await splToken.getAccount(
                        connection,
                        bestOfferToken
                    );
                    expect(bestOfferTokenAfter).equals(bestOfferTokenBefore - balanceChange);

                    // Previous offer refunded.
                    const { amount: prevBestOfferTokenAfter } = await splToken.getAccount(
                        connection,
                        prevBestOfferToken
                    );
                    expect(prevBestOfferTokenAfter).equals(
                        prevBestOfferTokenBefore + balanceChange
                    );
                } else {
                    expect(bestOfferToken).to.eql(prevBestOfferToken);

                    // Should be no change.
                    const { amount: bestOfferTokenAfter } = await splToken.getAccount(
                        connection,
                        bestOfferToken
                    );
                    expect(bestOfferTokenAfter).equals(bestOfferTokenBefore);
                }
            }
        });

        describe("Execute Fast Order", function () {
            const localVariables = new Map<string, any>();

            it("Execute Fast Order Within Grace Period", async function () {
                // Start the auction with offer two so that we can
                // check that the initial offer is refunded.
                const { fastVaa, fastVaaAccount, auction } = await placeInitialOfferForTest(
                    offerAuthorityTwo,
                    wormholeSequence++,
                    baseFastOrder,
                    ethRouter
                );

                const { auctionDataBefore } = await improveOfferForTest(
                    auction,
                    offerAuthorityOne,
                    100
                );
                const { bestOfferToken, initialOfferToken } = auctionDataBefore.info!;

                // Fetch the balances before.
                const { amount: bestOfferTokenBefore } = await splToken.getAccount(
                    connection,
                    bestOfferToken
                );
                const { amount: initialOfferTokenBefore } = await splToken.getAccount(
                    connection,
                    initialOfferToken
                );
                const { amount: custodyTokenBefore } = await engine.fetchCustodyTokenAccount();

                const { duration, gracePeriod } = await engine.fetchAuctionParameters();
                await waitUntilSlot(
                    connection,
                    auctionDataBefore.info!.startSlot.addn(duration + gracePeriod - 1).toNumber()
                );

                const ix = await engine.executeFastOrderCctpIx({
                    payer: offerAuthorityOne.publicKey,
                    fastVaa,
                });

                const txDetails = await expectIxOkDetails(connection, [ix], [offerAuthorityOne]);

                await checkAfterEffects(
                    txDetails!,
                    auction,
                    auctionDataBefore,
                    {
                        custodyToken: custodyTokenBefore,
                        bestOfferToken: bestOfferTokenBefore,
                        initialOfferToken: initialOfferTokenBefore,
                    },
                    offerAuthorityOne.publicKey,
                    false, // hasPenalty
                    "ethereum",
                    "arbitrum"
                );

                localVariables.set("auction", auction);
            });

            it("Cannot Improve Offer", async function () {
                const auction = localVariables.get("auction") as PublicKey;
                expect(localVariables.delete("auction")).is.true;

                const ix = await engine.improveOfferIx(
                    {
                        offerAuthority: offerAuthorityOne.publicKey,
                        auction,
                    },
                    baseFastOrder.maxFee
                );

                await expectIxErr(
                    connection,
                    [ix],
                    [offerAuthorityOne],
                    "Error Code: AuctionNotActive"
                );
            });

            it("Execute Fast Order After Grace Period", async function () {
                // Start the auction with offer two so that we can
                // check that the initial offer is refunded.
                const { fastVaa, fastVaaAccount, auction } = await placeInitialOfferForTest(
                    offerAuthorityTwo,
                    wormholeSequence++,
                    baseFastOrder,
                    ethRouter
                );

                const { auctionDataBefore } = await improveOfferForTest(
                    auction,
                    offerAuthorityOne,
                    100
                );
                const { bestOfferToken, initialOfferToken } = auctionDataBefore.info!;

                // Fetch the balances before.
                const { amount: bestOfferTokenBefore } = await splToken.getAccount(
                    connection,
                    bestOfferToken
                );
                const { amount: initialOfferTokenBefore } = await splToken.getAccount(
                    connection,
                    initialOfferToken
                );
                const { amount: custodyTokenBefore } = await engine.fetchCustodyTokenAccount();

                const { duration, gracePeriod, penaltySlots } =
                    await engine.fetchAuctionParameters();
                await waitUntilSlot(
                    connection,
                    auctionDataBefore
                        .info!.startSlot.addn(duration + gracePeriod + penaltySlots / 2)
                        .toNumber()
                );

                const ix = await engine.executeFastOrderCctpIx({
                    payer: offerAuthorityOne.publicKey,
                    fastVaa,
                });

                const txDetails = await expectIxOkDetails(connection, [ix], [offerAuthorityOne]);

                await checkAfterEffects(
                    txDetails!,
                    auction,
                    auctionDataBefore,
                    {
                        custodyToken: custodyTokenBefore,
                        bestOfferToken: bestOfferTokenBefore,
                        initialOfferToken: initialOfferTokenBefore,
                    },
                    offerAuthorityOne.publicKey,
                    true, // hasPenalty
                    "ethereum",
                    "arbitrum"
                );
            });

            it("Execute Fast Order After Grace Period with Liquidator", async function () {
                // Start the auction with offer two so that we can
                // check that the initial offer is refunded.
                const { fastVaa, fastVaaAccount, auction } = await placeInitialOfferForTest(
                    offerAuthorityTwo,
                    wormholeSequence++,
                    baseFastOrder,
                    ethRouter
                );

                const { auctionDataBefore } = await improveOfferForTest(
                    auction,
                    offerAuthorityOne,
                    100
                );
                const { bestOfferToken, initialOfferToken } = auctionDataBefore.info!;

                // Fetch the balances before.
                const { amount: bestOfferTokenBefore } = await splToken.getAccount(
                    connection,
                    bestOfferToken
                );
                const { amount: initialOfferTokenBefore } = await splToken.getAccount(
                    connection,
                    initialOfferToken
                );
                const { amount: custodyTokenBefore } = await engine.fetchCustodyTokenAccount();

                const liquidatorToken = splToken.getAssociatedTokenAddressSync(
                    USDC_MINT_ADDRESS,
                    liquidator.publicKey
                );
                const { amount: executorTokenBefore } = await splToken.getAccount(
                    connection,
                    liquidatorToken
                );

                const { duration, gracePeriod, penaltySlots } =
                    await engine.fetchAuctionParameters();
                await waitUntilSlot(
                    connection,
                    auctionDataBefore
                        .info!.startSlot.addn(duration + gracePeriod + penaltySlots / 2)
                        .toNumber()
                );

                const ix = await engine.executeFastOrderCctpIx({
                    payer: liquidator.publicKey,
                    fastVaa,
                });

                const txDetails = await expectIxOkDetails(connection, [ix], [liquidator]);

                await checkAfterEffects(
                    txDetails!,
                    auction,
                    auctionDataBefore,
                    {
                        custodyToken: custodyTokenBefore,
                        bestOfferToken: bestOfferTokenBefore,
                        initialOfferToken: initialOfferTokenBefore,
                        executorToken: executorTokenBefore,
                    },
                    liquidator.publicKey,
                    true, // hasPenalty
                    "ethereum",
                    "arbitrum"
                );
            });

            it("Execute Fast Order After Penalty Period with Liquidator", async function () {
                // Start the auction with offer two so that we can
                // check that the initial offer is refunded.
                const { fastVaa, fastVaaAccount, auction } = await placeInitialOfferForTest(
                    offerAuthorityTwo,
                    wormholeSequence++,
                    baseFastOrder,
                    ethRouter
                );

                const { auctionDataBefore } = await improveOfferForTest(
                    auction,
                    offerAuthorityOne,
                    100
                );
                const { bestOfferToken, initialOfferToken } = auctionDataBefore.info!;

                // Fetch the balances before.
                const { amount: bestOfferTokenBefore } = await splToken.getAccount(
                    connection,
                    bestOfferToken
                );
                const { amount: initialOfferTokenBefore } = await splToken.getAccount(
                    connection,
                    initialOfferToken
                );
                const { amount: custodyTokenBefore } = await engine.fetchCustodyTokenAccount();

                const liquidatorToken = splToken.getAssociatedTokenAddressSync(
                    USDC_MINT_ADDRESS,
                    liquidator.publicKey
                );
                const { amount: executorTokenBefore } = await splToken.getAccount(
                    connection,
                    liquidatorToken
                );

                const { duration, gracePeriod, penaltySlots } =
                    await engine.fetchAuctionParameters();
                await waitUntilSlot(
                    connection,
                    auctionDataBefore
                        .info!.startSlot.addn(duration + gracePeriod + penaltySlots + 2)
                        .toNumber()
                );

                const ix = await engine.executeFastOrderCctpIx({
                    payer: liquidator.publicKey,
                    fastVaa,
                });

                const txDetails = await expectIxOkDetails(connection, [ix], [liquidator]);

                await checkAfterEffects(
                    txDetails!,
                    auction,
                    auctionDataBefore,
                    {
                        custodyToken: custodyTokenBefore,
                        bestOfferToken: bestOfferTokenBefore,
                        initialOfferToken: initialOfferTokenBefore,
                        executorToken: executorTokenBefore,
                    },
                    liquidator.publicKey,
                    true, // hasPenalty
                    "ethereum",
                    "arbitrum"
                );
            });

            // Cannot perform this test w/o solana endpoint.
            it.skip("Cannot Execute Fast Order (Invalid Chain)", async function () {
                const fastOrder = { ...baseFastOrder };
                fastOrder.targetChain = ethChain;
                fastOrder.destinationCctpDomain = ethDomain;

                const { fastVaa, auctionDataBefore } = await placeInitialOfferForTest(
                    offerAuthorityOne,
                    wormholeSequence++,
                    fastOrder,
                    ethRouter
                );

                const { duration, gracePeriod } = await engine.fetchAuctionParameters();
                await waitUntilSlot(
                    connection,
                    auctionDataBefore.info!.startSlot.addn(duration + gracePeriod - 2).toNumber()
                );

                const ix = await engine.executeFastOrderCctpIx({
                    payer: offerAuthorityOne.publicKey,
                    fastVaa,
                });
                await expectIxErr(
                    connection,
                    [ix],
                    [offerAuthorityOne],
                    "Error Code: InvalidChain"
                );
            });

            it("Cannot Execute Fast Order with VAA Hash Mismatch", async function () {
                const { fastVaaAccount, auction, auctionDataBefore } =
                    await placeInitialOfferForTest(
                        offerAuthorityOne,
                        wormholeSequence++,
                        baseFastOrder,
                        ethRouter,
                        baseFastOrder.maxFee
                    );

                const { fastVaa: anotherFastVaa, fastVaaAccount: anotherFastVaaAccount } =
                    await placeInitialOfferForTest(
                        offerAuthorityOne,
                        wormholeSequence++,
                        baseFastOrder,
                        ethRouter,
                        baseFastOrder.maxFee
                    );
                expect(fastVaaAccount.digest()).to.not.eql(anotherFastVaaAccount.digest());

                const { duration, gracePeriod } = await engine.fetchAuctionParameters();
                await waitUntilSlot(
                    connection,
                    auctionDataBefore.info!.startSlot.addn(duration + gracePeriod - 2).toNumber()
                );

                const ix = await engine.executeFastOrderCctpIx({
                    payer: offerAuthorityOne.publicKey,
                    fastVaa: anotherFastVaa,
                    auction,
                });

                await expectIxErr(
                    connection,
                    [ix],
                    [offerAuthorityOne],
                    "account: auction. Error Code: ConstraintSeeds"
                );
            });

            it("Cannot Execute Fast Order (Invalid Best Offer Token Account)", async function () {
                const { fastVaa, auctionDataBefore } = await placeInitialOfferForTest(
                    offerAuthorityOne,
                    wormholeSequence++,
                    baseFastOrder,
                    ethRouter
                );

                const bogusToken = engine.custodyTokenAccountAddress();

                const { bestOfferToken } = auctionDataBefore.info!;
                expect(bogusToken).to.not.eql(bestOfferToken);

                const ix = await engine.executeFastOrderCctpIx({
                    payer: offerAuthorityOne.publicKey,
                    fastVaa,
                    bestOfferToken: bogusToken,
                });

                // Pass the wrong address for the best offer token account.
                await expectIxErr(
                    connection,
                    [ix],
                    [offerAuthorityOne],
                    "Error Code: BestOfferTokenMismatch"
                );
            });

            it("Cannot Execute Fast Order (Invalid Initial Offer Token Account)", async function () {
                const { fastVaa, auctionDataBefore } = await placeInitialOfferForTest(
                    offerAuthorityOne,
                    wormholeSequence++,
                    baseFastOrder,
                    ethRouter
                );

                const bogusToken = engine.custodyTokenAccountAddress();

                const { initialOfferToken } = auctionDataBefore.info!;
                expect(bogusToken).to.not.eql(initialOfferToken);

                const ix = await engine.executeFastOrderCctpIx({
                    payer: offerAuthorityOne.publicKey,
                    fastVaa,
                    initialOfferToken: bogusToken,
                });

                // Pass the wrong address for the best offer token account.
                await expectIxErr(
                    connection,
                    [ix],
                    [offerAuthorityOne],
                    "Error Code: InitialOfferTokenMismatch"
                );
            });

            it("Execute Fast Order", async function () {
                // Start the auction with offer two so that we can
                // check that the initial offer is refunded.
                const { fastVaa, auctionDataBefore } = await placeInitialOfferForTest(
                    offerAuthorityTwo,
                    wormholeSequence++,
                    baseFastOrder,
                    ethRouter
                );

                const { duration, gracePeriod } = await engine.fetchAuctionParameters();
                await waitUntilSlot(
                    connection,
                    auctionDataBefore.info!.startSlot.addn(duration + gracePeriod - 1).toNumber()
                );

                const ix = await engine.executeFastOrderCctpIx({
                    payer: offerAuthorityOne.publicKey,
                    fastVaa,
                });

                await expectIxOk(connection, [ix], [offerAuthorityOne]);

                localVariables.set("ix", ix);
            });

            it("Cannot Execute Fast Order on Auction Completed", async function () {
                const ix = localVariables.get("ix") as TransactionInstruction;
                expect(localVariables.delete("ix")).is.true;

                await expectIxErr(
                    connection,
                    [ix],
                    [offerAuthorityOne],
                    "Error Code: AuctionNotActive"
                );
            });

            it("Cannot Execute Fast Order (Auction Period Not Expired)", async function () {
                const { fastVaa } = await placeInitialOfferForTest(
                    offerAuthorityOne,
                    wormholeSequence++,
                    baseFastOrder,
                    ethRouter
                );

                const ix = await engine.executeFastOrderCctpIx({
                    payer: offerAuthorityOne.publicKey,
                    fastVaa,
                });

                await expectIxErr(
                    connection,
                    [ix],
                    [offerAuthorityOne],
                    "Error Code: AuctionPeriodNotExpired"
                );
            });

            it("Cannot Execute Fast Order Solana (Invalid Chain)", async function () {
                const { fastVaa, fastVaaAccount } = await placeInitialOfferForTest(
                    offerAuthorityOne,
                    wormholeSequence++,
                    baseFastOrder,
                    ethRouter
                );

                await expectIxErr(
                    connection,
                    [
                        await engine.executeFastOrderLocalIx({
                            payer: offerAuthorityOne.publicKey,
                            fastVaa,
                            toRouterEndpoint: engine.routerEndpointAddress(arbChain),
                        }),
                    ],
                    [offerAuthorityOne],
                    "Error Code: ConstraintSeeds"
                );
            });

            async function checkAfterEffects(
                txDetails: VersionedTransactionResponse,
                auction: PublicKey,
                auctionDataBefore: Auction,
                balancesBefore: {
                    custodyToken: bigint;
                    bestOfferToken: bigint;
                    initialOfferToken: bigint;
                    executorToken?: bigint;
                },
                executor: PublicKey,
                hasPenalty: boolean,
                fromChainName: wormholeSdk.ChainName,
                toChainName: wormholeSdk.ChainName
            ) {
                const {
                    custodyToken: custodyTokenBefore,
                    bestOfferToken: bestOfferTokenBefore,
                    initialOfferToken: initialOfferTokenBefore,
                    executorToken: executorTokenBefore,
                } = balancesBefore;

                const { bump, vaaHash, info } = auctionDataBefore;

                const auctionDataAfter = await engine.fetchAuction({ address: auction });
                expect(auctionDataAfter).to.eql(
                    new Auction(
                        bump,
                        vaaHash,
                        { completed: { slot: bigintToU64BN(BigInt(txDetails.slot)) } },
                        info
                    )
                );

                const { bestOfferToken, initialOfferToken, securityDeposit, amountIn, offerPrice } =
                    info!;

                // Validate balance changes.
                const { amount: bestOfferTokenAfter } = await splToken.getAccount(
                    connection,
                    bestOfferToken
                );
                const { amount: initialOfferTokenAfter } = await splToken.getAccount(
                    connection,
                    initialOfferToken
                );

                const { penalty, userReward } = await engine.computeDepositPenalty(
                    info!,
                    BigInt(txDetails.slot),
                    info!.configId
                );

                const {
                    initAuctionFee,
                    destinationCctpDomain,
                    sender: orderSender,
                    redeemer,
                    redeemerMessage,
                } = baseFastOrder;

                if (hasPenalty) {
                    expect(penalty > 0n).is.true;
                    expect(userReward > 0n).is.true;

                    let depositAndFee =
                        BigInt(offerPrice.add(securityDeposit).toString()) - userReward;
                    const executorToken = splToken.getAssociatedTokenAddressSync(
                        USDC_MINT_ADDRESS,
                        executor
                    );
                    if (!executorToken.equals(bestOfferToken)) {
                        depositAndFee -= penalty;

                        const { amount: executorTokenAfter } = await splToken.getAccount(
                            connection,
                            executorToken
                        );
                        expect(executorTokenAfter).equals(executorTokenBefore! + penalty);
                    }

                    if (bestOfferToken.equals(initialOfferToken)) {
                        expect(bestOfferTokenAfter).equals(
                            bestOfferTokenBefore + depositAndFee + initAuctionFee
                        );
                    } else {
                        expect(bestOfferTokenAfter).equals(bestOfferTokenBefore + depositAndFee);
                        expect(initialOfferTokenAfter).equals(
                            initialOfferTokenBefore + initAuctionFee
                        );
                    }
                } else {
                    expect(penalty).equals(0n);
                    expect(userReward).equals(0n);

                    const depositAndFee = BigInt(offerPrice.add(securityDeposit).toString());

                    if (bestOfferToken.equals(initialOfferToken)) {
                        expect(bestOfferTokenAfter).equals(
                            bestOfferTokenBefore + depositAndFee + initAuctionFee
                        );
                    } else {
                        expect(bestOfferTokenAfter).equals(bestOfferTokenBefore + depositAndFee);
                        expect(initialOfferTokenAfter).equals(
                            initialOfferTokenBefore + initAuctionFee
                        );
                    }
                }

                const { amount: custodyTokenAfter } = await engine.fetchCustodyTokenAccount();
                expect(custodyTokenAfter).equals(
                    custodyTokenBefore - BigInt(amountIn.add(securityDeposit).toString())
                );

                // Validate the core message.
                const message = await engine.getCoreMessage(executor);
                const {
                    message: { payload },
                } = await getPostedMessage(connection, message);
                const parsed = LiquidityLayerMessage.decode(payload);
                expect(parsed.deposit?.message.fill).is.not.undefined;

                const {
                    header: {
                        amount: actualAmount,
                        destinationCctpDomain: actualDestinationCctpDomain,
                        mintRecipient,
                    },
                    message: { fill },
                } = parsed.deposit!;

                const userAmount =
                    BigInt(amountIn.sub(offerPrice).toString()) - initAuctionFee + userReward;
                expect(actualAmount).equals(userAmount);
                expect(actualDestinationCctpDomain).equals(destinationCctpDomain);

                const sourceChain = wormholeSdk.coalesceChainId(fromChainName);
                const { mintRecipient: expectedMintRecipient } = await engine.fetchRouterEndpoint(
                    wormholeSdk.coalesceChainId(toChainName)
                );
                expect(mintRecipient).to.eql(expectedMintRecipient);

                const expectedFill: Fill = {
                    sourceChain,
                    orderSender,
                    redeemer,
                    redeemerMessage,
                };
                expect(fill).to.eql(expectedFill);
            }
        });

        describe("Prepare Order Response", function () {
            const localVariables = new Map<string, any>();

            // TODO: add negative tests

            it("Prepare Order Response", async function () {
                const redeemer = Keypair.generate();

                const sourceCctpDomain = 0;
                const cctpNonce = testCctpNonce++;
                const amountIn = 690000n; // 69 cents

                // Concoct a Circle message.
                const burnSource = Array.from(Buffer.alloc(32, "beefdead", "hex"));
                const { destinationCctpDomain, burnMessage, encodedCctpMessage, cctpAttestation } =
                    await craftCctpTokenBurnMessage(engine, sourceCctpDomain, cctpNonce, amountIn);

                const fastMessage = new LiquidityLayerMessage({
                    fastMarketOrder: {
                        amountIn,
                        minAmountOut: 0n,
                        targetChain: wormholeSdk.CHAIN_ID_SOLANA as number,
                        destinationCctpDomain,
                        redeemer: Array.from(redeemer.publicKey.toBuffer()),
                        sender: new Array(32).fill(0),
                        refundAddress: new Array(32).fill(0),
                        maxFee: 42069n,
                        initAuctionFee: 2000n,
                        deadline: 2,
                        redeemerMessage: Buffer.from("Somebody set up us the bomb"),
                    },
                });

                const finalizedMessage = new LiquidityLayerMessage({
                    deposit: new LiquidityLayerDeposit(
                        {
                            tokenAddress: burnMessage.burnTokenAddress,
                            amount: amountIn,
                            sourceCctpDomain,
                            destinationCctpDomain,
                            cctpNonce,
                            burnSource,
                            mintRecipient: Array.from(
                                engine.custodyTokenAccountAddress().toBuffer()
                            ),
                        },
                        {
                            slowOrderResponse: {
                                baseFee: 420n,
                            },
                        }
                    ),
                });

                const fastVaa = await postLiquidityLayerVaa(
                    connection,
                    payer,
                    MOCK_GUARDIANS,
                    ethRouter,
                    wormholeSequence++,
                    fastMessage
                );
                const finalizedVaa = await postLiquidityLayerVaa(
                    connection,
                    payer,
                    MOCK_GUARDIANS,
                    ethRouter,
                    wormholeSequence++,
                    finalizedMessage
                );

                const ix = await engine.prepareOrderResponseCctpIx(
                    {
                        payer: payer.publicKey,
                        fastVaa,
                        finalizedVaa,
                        mint: USDC_MINT_ADDRESS,
                    },
                    {
                        encodedCctpMessage,
                        cctpAttestation,
                    }
                );

                const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
                    units: 250_000,
                });

                await expectIxOk(connection, [computeIx, ix], [payer]);

                // TODO: validate prepared slow order
                const fastVaaHash = await VaaAccount.fetch(connection, fastVaa).then((vaa) =>
                    vaa.digest()
                );
                const preparedOrderResponse = engine.preparedOrderResponseAddress(
                    payer.publicKey,
                    fastVaaHash
                );

                // Save for later.
                localVariables.set("ix", ix);
                localVariables.set("preparedOrderResponse", preparedOrderResponse);
            });

            it("Cannot Prepare Order Response for Same VAAs", async function () {
                const ix = localVariables.get("ix") as TransactionInstruction;
                expect(localVariables.delete("ix")).is.true;

                const preparedOrderResponse = localVariables.get(
                    "preparedOrderResponse"
                ) as PublicKey;
                expect(localVariables.delete("preparedOrderResponse")).is.true;

                await expectIxErr(
                    connection,
                    [ix],
                    [payer],
                    `Allocate: account Address { address: ${preparedOrderResponse.toString()}, base: None } already in use`
                );
            });
        });

        describe("Settle Auction", function () {
            describe("Auction Complete", function () {
                it("Cannot Settle Auction in Active Status", async function () {
                    const { prepareIx, preparedOrderResponse, auction } =
                        await prepareOrderResponse({
                            initAuction: true,
                            executeOrder: false,
                            prepareOrderRespsonse: false,
                        });

                    const settleIx = await engine.settleAuctionCompleteIx({
                        preparedOrderResponse,
                        preparedBy: payer.publicKey,
                        auction,
                    });

                    await expectIxErr(
                        connection,
                        [prepareIx!, settleIx],
                        [payer],
                        "Error Code: AuctionNotCompleted"
                    );
                });

                it.skip("Prepare and Settle", async function () {
                    const {
                        fastVaa,
                        fastVaaAccount,
                        finalizedVaa,
                        prepareIx,
                        preparedOrderResponse,
                        auction,
                    } = await prepareOrderResponse({
                        initAuction: true,
                        executeOrder: true,
                        prepareOrderRespsonse: false,
                    });

                    const settleIx = await engine.settleAuctionCompleteIx({
                        preparedOrderResponse,
                        preparedBy: payer.publicKey,
                        auction,
                    });

                    await expectIxOk(connection, [prepareIx!, settleIx], [payer]);
                });
            });

            describe("Settle No Auction (CCTP)", function () {
                const localVariables = new Map<string, any>();

                it("Settle", async function () {
                    const { fastVaa, fastVaaAccount, finalizedVaaAccount, preparedOrderResponse } =
                        await prepareOrderResponse({
                            initAuction: false,
                            executeOrder: false,
                            prepareOrderRespsonse: true,
                        });

                    const settleIx = await engine.settleAuctionNoneCctpIx({
                        payer: payer.publicKey,
                        fastVaa,
                        preparedOrderResponse,
                    });

                    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
                        units: 250_000,
                    });

                    const { amount: feeBalanceBefore } = await splToken.getAccount(
                        connection,
                        feeRecipientToken
                    );
                    const { amount: custodyBalanceBefore } =
                        await engine.fetchCustodyTokenAccount();

                    await expectIxOk(connection, [computeIx, settleIx], [payer]);

                    const deposit = LiquidityLayerMessage.decode(finalizedVaaAccount.payload())
                        .deposit!;

                    const { baseFee } = deposit.message.slowOrderResponse!;
                    const { amount: feeBalanceAfter } = await splToken.getAccount(
                        connection,
                        feeRecipientToken
                    );
                    expect(feeBalanceAfter).equals(feeBalanceBefore + baseFee);

                    const { amount } = deposit.header;
                    const { amount: custodyBalanceAfter } = await engine.fetchCustodyTokenAccount();
                    expect(custodyBalanceAfter).equals(custodyBalanceBefore - amount);

                    const fastVaaHash = fastVaaAccount.digest();
                    const auctionData = await engine.fetchAuction(fastVaaHash);
                    const { bump } = auctionData;
                    expect(auctionData).to.eql(
                        new Auction(
                            bump,
                            Array.from(fastVaaHash),
                            {
                                settled: {
                                    baseFee: bigintToU64BN(baseFee),
                                    penalty: null,
                                },
                            },
                            null
                        )
                    );
                });
            });

            async function prepareOrderResponse(args: {
                initAuction: boolean;
                executeOrder: boolean;
                prepareOrderRespsonse: boolean;
            }) {
                const { initAuction, executeOrder, prepareOrderRespsonse } = args;

                const redeemer = Keypair.generate();
                const sourceCctpDomain = 0;
                const cctpNonce = testCctpNonce++;
                const amountIn = 690000n; // 69 cents

                // Concoct a Circle message.
                const burnSource = Array.from(Buffer.alloc(32, "beefdead", "hex"));
                const { destinationCctpDomain, burnMessage, encodedCctpMessage, cctpAttestation } =
                    await craftCctpTokenBurnMessage(engine, sourceCctpDomain, cctpNonce, amountIn);

                const maxFee = 42069n;
                const currTime = await connection.getBlockTime(await connection.getSlot());
                const fastMessage = new LiquidityLayerMessage({
                    fastMarketOrder: {
                        amountIn,
                        minAmountOut: 0n,
                        targetChain: arbChain,
                        destinationCctpDomain: arbDomain,
                        redeemer: Array.from(redeemer.publicKey.toBuffer()),
                        sender: new Array(32).fill(0),
                        refundAddress: new Array(32).fill(0),
                        maxFee,
                        initAuctionFee: 2000n,
                        deadline: currTime! + 2,
                        redeemerMessage: Buffer.from("Somebody set up us the bomb"),
                    },
                });

                const finalizedMessage = new LiquidityLayerMessage({
                    deposit: new LiquidityLayerDeposit(
                        {
                            tokenAddress: burnMessage.burnTokenAddress,
                            amount: amountIn,
                            sourceCctpDomain,
                            destinationCctpDomain,
                            cctpNonce,
                            burnSource,
                            mintRecipient: Array.from(
                                engine.custodyTokenAccountAddress().toBuffer()
                            ),
                        },
                        {
                            slowOrderResponse: {
                                baseFee: 420n,
                            },
                        }
                    ),
                });

                const fastVaa = await postLiquidityLayerVaa(
                    connection,
                    payer,
                    MOCK_GUARDIANS,
                    ethRouter,
                    wormholeSequence++,
                    fastMessage
                );
                const fastVaaAccount = await VaaAccount.fetch(connection, fastVaa);

                const finalizedVaa = await postLiquidityLayerVaa(
                    connection,
                    payer,
                    MOCK_GUARDIANS,
                    ethRouter,
                    wormholeSequence++,
                    finalizedMessage
                );
                const finalizedVaaAccount = await VaaAccount.fetch(connection, finalizedVaa);

                const prepareIx = await engine.prepareOrderResponseCctpIx(
                    {
                        payer: payer.publicKey,
                        fastVaa,
                        finalizedVaa,
                    },
                    {
                        encodedCctpMessage,
                        cctpAttestation,
                    }
                );

                const fastVaaHash = fastVaaAccount.digest();
                const preparedBy = payer.publicKey;
                const preparedOrderResponse = engine.preparedOrderResponseAddress(
                    preparedBy,
                    fastVaaHash
                );
                const auction = engine.auctionAddress(fastVaaHash);

                if (initAuction) {
                    const ix = await engine.placeInitialOfferIx(
                        {
                            payer: offerAuthorityOne.publicKey,
                            fastVaa,
                        },
                        maxFee
                    );
                    await expectIxOk(connection, [ix], [offerAuthorityOne]);

                    if (executeOrder) {
                        // TODO
                    }
                }

                if (prepareOrderRespsonse) {
                    await expectIxOk(connection, [prepareIx], [payer]);
                }

                return {
                    fastVaa,
                    fastVaaAccount,
                    finalizedVaa,
                    finalizedVaaAccount,
                    prepareIx: prepareOrderRespsonse ? null : prepareIx,
                    preparedOrderResponse,
                    auction,
                    preparedBy,
                };
            }
        });
    });

    async function placeInitialOfferForTest(
        offerAuthority: Keypair,
        sequence: bigint,
        fastMarketOrder: FastMarketOrder,
        emitter: number[],
        feeOffer?: bigint,
        chainName?: wormholeSdk.ChainName
    ): Promise<{
        fastVaa: PublicKey;
        fastVaaAccount: VaaAccount;
        txDetails: VersionedTransactionResponse;
        auction: PublicKey;
        auctionDataBefore: Auction;
    }> {
        const fastVaa = await postLiquidityLayerVaa(
            connection,
            offerAuthority,
            MOCK_GUARDIANS,
            emitter,
            sequence,
            new LiquidityLayerMessage({ fastMarketOrder }),
            chainName
        );

        // Place the initial offer.
        const ix = await engine.placeInitialOfferIx(
            {
                payer: offerAuthority.publicKey,
                fastVaa,
            },
            feeOffer ?? fastMarketOrder.maxFee
        );

        const txDetails = await expectIxOkDetails(connection, [ix], [offerAuthority]);
        if (txDetails === null) {
            throw new Error("Transaction details is null");
        }

        const fastVaaAccount = await VaaAccount.fetch(connection, fastVaa);
        const auction = engine.auctionAddress(fastVaaAccount.digest());
        const auctionDataBefore = await engine.fetchAuction({ address: auction });

        return { fastVaa, fastVaaAccount, txDetails, auction, auctionDataBefore };
    }

    async function improveOfferForTest(
        auction: PublicKey,
        offerAuthority: Keypair,
        improveBy: number
    ) {
        const auctionData = await engine.fetchAuction({ address: auction });
        const newOffer = BigInt(auctionData.info!.offerPrice.subn(improveBy).toString());

        const improveIx = await engine.improveOfferIx(
            {
                auction,
                offerAuthority: offerAuthority.publicKey,
            },
            newOffer
        );

        // Improve the bid with offer one.
        await expectIxOk(connection, [improveIx], [offerAuthority]);

        const auctionDataBefore = await engine.fetchAuction({ address: auction });
        expect(BigInt(auctionDataBefore.info!.offerPrice.toString())).equals(newOffer);

        return {
            auctionDataBefore,
        };
    }
});

async function craftCctpTokenBurnMessage(
    engine: MatchingEngineProgram,
    sourceCctpDomain: number,
    cctpNonce: bigint,
    amount: bigint,
    overrides: { destinationCctpDomain?: number } = {}
) {
    const { destinationCctpDomain: inputDestinationCctpDomain } = overrides;

    const messageTransmitterProgram = engine.messageTransmitterProgram();
    const { version, localDomain } = await messageTransmitterProgram.fetchMessageTransmitterConfig(
        messageTransmitterProgram.messageTransmitterConfigAddress()
    );
    const destinationCctpDomain = inputDestinationCctpDomain ?? localDomain;

    const tokenMessengerMinterProgram = engine.tokenMessengerMinterProgram();
    const { tokenMessenger: sourceTokenMessenger } =
        await tokenMessengerMinterProgram.fetchRemoteTokenMessenger(
            tokenMessengerMinterProgram.remoteTokenMessengerAddress(sourceCctpDomain)
        );

    const burnMessage = new CctpTokenBurnMessage(
        {
            version,
            sourceDomain: sourceCctpDomain,
            destinationDomain: destinationCctpDomain,
            nonce: cctpNonce,
            sender: sourceTokenMessenger,
            recipient: Array.from(tokenMessengerMinterProgram.ID.toBuffer()), // targetTokenMessenger
            targetCaller: Array.from(engine.custodianAddress().toBuffer()), // targetCaller
        },
        0,
        Array.from(wormholeSdk.tryNativeToUint8Array(ETHEREUM_USDC_ADDRESS, "ethereum")), // sourceTokenAddress
        Array.from(engine.custodyTokenAccountAddress().toBuffer()), // mint recipient
        amount,
        new Array(32).fill(0) // burnSource
    );

    const encodedCctpMessage = burnMessage.encode();
    const cctpAttestation = new CircleAttester().createAttestation(encodedCctpMessage);

    return {
        destinationCctpDomain,
        burnMessage,
        encodedCctpMessage,
        cctpAttestation,
    };
}
