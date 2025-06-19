import { ethers } from 'ethers';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const ETHERSCAN_API_URL = 'https://api.etherscan.io/api';

export async function analyzeWalletActivity(address) {
  console.log(`📡 正在分析地址: ${address}`);

  const txList = await getTxHistory(address);
  if (!txList || txList.length === 0) {
    console.log('❌ 无交易记录，可能为冷钱包');
    return;
  }

  let contractCalls = 0;
  let contractCreations = 0;
  let flashbotsCount = 0;
  const contractCallMap = new Map();

  for (const tx of txList) {
  if (!tx.to || tx.to === '') contractCreations++;
  if (tx.input !== '0x') {
      contractCalls++;

      // 记录调用的合约地址
      const to = tx.to.toLowerCase();
      contractCallMap.set(to, (contractCallMap.get(to) || 0) + 1);
  }
  if (tx.isError === '0' && tx.blockNumber && parseInt(tx.confirmations) < 2) flashbotsCount++;
  }

  console.log(`📊 交易总数: ${txList.length}`);
  console.log(`🧠 合约调用数: ${contractCalls}`);
  console.log(`🚀 创建合约数: ${contractCreations}`);
  console.log(`⛽️ Flashbots 风格（低确认）交易数: ${flashbotsCount}`);
  console.log(`📊 合约调用分布 (前10):`);
  const sorted = [...contractCallMap.entries()].sort((a, b) => b[1] - a[1]);
  for (const [addr, count] of sorted.slice(0, 10)) {
    console.log(`  📍 ${addr} 被调用 ${count} 次`);}

  const isLikelyBot =
    contractCalls / txList.length > 0.5 &&
    (flashbotsCount > 0 || contractCreations > 0);

  if (isLikelyBot) {
    console.log('🤖 此地址很可能是一个套利机器人');
  } else {
    console.log('👤 此地址暂时不像是一个典型的套利机器人');
  }
}

async function getTxHistory(address) {
  const url = `${ETHERSCAN_API_URL}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=asc&apikey=${ETHERSCAN_API_KEY}`;
  try {
    const res = await axios.get(url);
    if (res.data.status === '1') return res.data.result;
    console.error('Etherscan API 错误:', res.data.message);
    return [];
  } catch (err) {
    console.error('无法获取交易历史:', err);
    return [];
  }
}

// 示例调用（调试时使用）
analyzeWalletActivity('0x520ca19798fe4d591244a0e539330b5e5bc47bd4');
