// Mints devnet test tokens (1 token = 100 minutes) to a wallet's ATA. Usage: node scripts/mint-test-tokens.ts <recipient> <tokens>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import devnet from "../devnet.json" with { type: "json" };

const [recipient, tokens] = process.argv.slice(2);
if (!recipient || !(Number(tokens) > 0)) throw new Error("usage: node scripts/mint-test-tokens.ts <recipient> <tokens>");
const conn = new Connection(devnet.rpc, "confirmed");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))));
const mint = new PublicKey(devnet.mint);
const ata = await getOrCreateAssociatedTokenAccount(conn, admin, mint, new PublicKey(recipient), true);
const sig = await mintTo(conn, admin, mint, ata.address, admin, BigInt(Math.round(Number(tokens) * 1e6)));
console.log(`minted ${tokens} to ${ata.address.toBase58()} (${sig})`);
