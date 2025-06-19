import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const ETHERSCAN_API_URL = 'https://api.etherscan.io/api';

export async function analyzeContract(address) {
  console.log(`🔍 正在分析合约: ${address}`);

  const info = await fetchContractSourceCode(address);
  const abi = await fetchContractABI(address);

  if (!info) {
    console.log('❌ 无法获取合约源代码，可能未验证或地址错误');
    return;
  }

  if (info.ContractName === '') {
    console.log('⚠️  此合约未在 Etherscan 验证');
  } else {
    console.log(`✅ 合约名称: ${info.ContractName}`);
    console.log(`🧾 编译器版本: ${info.CompilerVersion}`);
    console.log(`📅 创建时间未知（Etherscan 不提供创建时间 API）`);
  }

  if (abi) {
    const hasSeaportLike = abi.some(fn =>
      fn.name?.toLowerCase().includes('fulfillbasicorder') ||
      fn.name?.toLowerCase().includes('fulfilladvancedorder')
    );
    if (hasSeaportLike) {
      console.log('🔗 此合约包含 Seaport 协议函数，可能为 NFT 市场撮合器');
    }
  }
}

async function fetchContractSourceCode(address) {
  try {
    const url = `${ETHERSCAN_API_URL}?module=contract&action=getsourcecode&address=${address}&apikey=${ETHERSCAN_API_KEY}`;
    const res = await axios.get(url);
    if (res.data.status === '1') {
      return res.data.result[0];
    } else {
      console.error('Etherscan API 错误:', res.data.message);
      return null;
    }
  } catch (err) {
    console.error('获取合约源码失败:', err);
    return null;
  }
}

async function fetchContractABI(address) {
  try {
    const url = `${ETHERSCAN_API_URL}?module=contract&action=getabi&address=${address}&apikey=${ETHERSCAN_API_KEY}`;
    const res = await axios.get(url);
    if (res.data.status === '1') {
      return JSON.parse(res.data.result);
    } else {
      console.error('ABI 获取失败:', res.data.message);
      return null;
    }
  } catch (err) {
    console.error('解析 ABI 失败:', err);
    return null;
  }
}

// 示例调用
analyzeContract('0x0000000000000068f116a894984e2db1123eb395');