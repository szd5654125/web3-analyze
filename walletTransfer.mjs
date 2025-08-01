import * as crypto from 'node:crypto';


export const CHAIN     = 501;   // Solana 的 chainIndex（OKX 官方定义）
export const SOL_MINT  = 'So11111111111111111111111111111111111111112'; // SOL 的 mint 地址

export function buildOkxHeaders({method, path, query = '', body = ''}) {
  const ts   = new Date().toISOString();
  const pre  = ts + method.toUpperCase() + path + query + body;
  const sign = crypto
               .createHmac('sha256', process.env.OKX_API_SECRET)
               .update(pre)
               .digest('base64');
  return {
    'OK-ACCESS-KEY'      : process.env.OKX_API_KEY,
    'OK-ACCESS-PASSPHRASE': process.env.OKX_API_PASSPHRASE,
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-SIGN'     : sign,
    'Content-Type'       : 'application/json'
  };
}

export async function executeOkxSwap(lamports, outMint, myWallet, conn){
  /* ---------- ① 报价 ---------- */
  const quotePath   = '/api/v5/dex/aggregator/quote';
  const quoteQuery  = `?chainIndex=${CHAIN}&amount=${lamports}` +
                      `&fromTokenAddress=${SOL_MINT}&toTokenAddress=${outMint}` +
                      `&swapMode=exactIn`;
  const quoteRes = await fetch(
    `https://web3.okx.com${quotePath}${quoteQuery}`,
    { method:'GET', headers: buildOkxHeaders({method:'GET', path:quotePath, query:quoteQuery}) }
  ).then(r=>r.json());

  if (quoteRes.code !== '0') throw new Error(`Quote failed: ${quoteRes.msg}`);

  /* ---------- ② 构造 swap-instruction ---------- */
  const swapPath  = '/api/v5/dex/aggregator/swap-instruction';
  const swapQuery = quoteQuery + '&slippage=0.005' +   // 0.5 % 可自行调
                    `&userWalletAddress=${myWallet.publicKey.toBase58()}`;
  const swapRes = await fetch(
    `https://web3.okx.com${swapPath}${swapQuery}`,
    { method:'GET', headers: buildOkxHeaders({method:'GET', path:swapPath, query:swapQuery}) }
  ).then(r=>r.json());

  if (swapRes.code !== '0') throw new Error(`swap-instruction error: ${swapRes.msg}`);

  const { instructionLists, addressLookupTableAccount } = swapRes.data;

  /* ---------- ③ 组装 VersionedTransaction ---------- */
  const lookupTables = await Promise.all(
    addressLookupTableAccount.map(addr =>
      conn.getAddressLookupTable(new PublicKey(addr)).then(r=>r.value)
    )
  );
  const instructions = instructionLists.map(ix => new TransactionInstruction({
      programId : new PublicKey(ix.programId),
      keys      : ix.accounts.map(a=>({
                     pubkey    : new PublicKey(a.pubkey),
                     isSigner  : a.isSigner,
                     isWritable: a.isWritable
                   })),
      data      : Buffer.from(ix.data, 'base64')
  }));

  const {blockhash,lastValidBlockHeight} = await conn.getLatestBlockhash('finalized');
  const msg = new TransactionMessage({
      payerKey       : myWallet.publicKey,
      recentBlockhash: blockhash,
      instructions
  }).compileToV0Message(lookupTables.filter(Boolean));

  const vtx = new VersionedTransaction(msg);
  vtx.sign([myWallet]);

  /* ---------- ④ 广播 ---------- */
  const sig = await conn.sendRawTransaction(vtx.serialize(), {skipPreflight:true});
  await conn.confirmTransaction({signature:sig, blockhash, lastValidBlockHeight});
  return sig;
}

// oneShot.mjs
import 'dotenv/config';
import bs58                       from 'bs58';
import { Keypair, Connection }    from '@solana/web3.js';


// 1) 准备钱包 & 连接
const kp   = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY));
const conn = new Connection('https://api.mainnet-beta.solana.com','confirmed');

// 2) 设置买入目标 & 花费
const lamports = 0.1 * 1e9;   // 0.1 SOL
const outMint  = '83kGGSggYGP2ZEEyvX54SkZR1kFn84RgGCDyptbDbonk';   // BONK 例

// 3) 调用
try {
  const sig = await executeOkxSwap(lamports, outMint, kp, conn);
  console.log('✅ 成功，tx:', sig);
} catch (e) {
  console.error('❌ 失败:', e.message);
}