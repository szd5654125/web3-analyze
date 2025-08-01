const { Connection, PublicKey, clusterApiUrl } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } = require('@solana/spl-token');

class SolanaWalletMonitor {
    constructor(walletAddress, rpcUrl = null) {
        this.walletAddress = new PublicKey(walletAddress);
        this.connection = new Connection(rpcUrl || clusterApiUrl('mainnet-beta'), 'confirmed');
        this.accountSubId = null;
        this.logSubId = null;
        this.isMonitoring = false;
        
        // 稳定币/蓝筹代币白名单
        this.stableTokens = new Set([
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
            'So11111111111111111111111111111111111111112',  // WSOL
            'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
            'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
            'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
        ]);
    }

    /**
     * 开始监控钱包交易
     */
    async startMonitoring() {
        if (this.isMonitoring) {
            console.log('监控已经在运行中...');
            return;
        }

        try {
            console.log(`开始监控钱包: ${this.walletAddress.toString()}`);
            this.isMonitoring = true;

            // 监听日志变化 (修复：使用 mentions 过滤器)
            this.logSubId = this.connection.onLogs(
                { mentions: [this.walletAddress.toBase58()] },
                (logs, context) => {
                    this.handleLogs(logs, context);
                },
                'confirmed'
            );

            console.log('监控已启动，等待交易...');
        } catch (error) {
            console.error('启动监控失败:', error);
            this.isMonitoring = false;
        }
    }

    /**
     * 停止监控
     */
    async stopMonitoring() {
        if (this.accountSubId) {
            await this.connection.removeAccountChangeListener(this.accountSubId);
            this.accountSubId = null;
        }
        if (this.logSubId) {
            await this.connection.removeOnLogsListener(this.logSubId);
            this.logSubId = null;
        }
        this.isMonitoring = false;
        console.log('监控已停止');
    }

    /**
     * 处理账户变化
     */
    handleAccountChange(accountInfo, context) {
        console.log('账户变化检测到:', {
            slot: context.slot,
            lamports: accountInfo.lamports,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * 处理日志变化
     */
    async handleLogs(logs, context) {
        try {
            /* ---------- ① 快速过滤无关日志 ---------- */
            if (!logs.logs.some(line =>
                    line.includes('swap') ||           // Jupiter / Raydium / Orca 等聚合器
                    line.includes('transfer')          // 普通 SPL 转账
            )) {
                return;                               // 非代币相关日志，直接跳过
            }
            // 获取交易详情
            const signature = logs.signature;
            const transaction = await this.connection.getTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            });

            if (transaction) {
                await this.analyzeTransaction(transaction, signature);
            }
        } catch (error) {
            console.error('处理日志失败:', error);
        }
    }

    /**
     * 分析交易详情
     */
    async analyzeTransaction(transaction, signature) {
        try {
            const preBalances = transaction.meta.preBalances;
            const postBalances = transaction.meta.postBalances;
            const accountKeys = transaction.transaction.message.accountKeys;

            // 查找钱包地址在交易中的位置
            let walletIndex = -1;
            for (let i = 0; i < accountKeys.length; i++) {
                if (accountKeys[i].equals(this.walletAddress)) {
                    walletIndex = i;
                    break;
                }
            }

            if (walletIndex === -1) return;

            // 计算 SOL 余额变化
            const solChange = (postBalances[walletIndex] - preBalances[walletIndex]) / 1e9;
            
            // 分析代币变化
            const tokenChanges = await this.analyzeTokenChanges(transaction);

            // 判断交易类型
            const transactionType = this.determineTransactionType(solChange, tokenChanges);

            // 输出交易信息
            this.logTransaction({
                signature,
                type: transactionType,
                solChange,
                tokenChanges,
                timestamp: new Date(transaction.blockTime * 1000).toISOString(),
                slot: transaction.slot
            });

        } catch (error) {
            console.error('分析交易失败:', error);
        }
    }

    /**
     * 分析代币变化
     */
    async analyzeTokenChanges(transaction) {
        const tokenChanges = [];
        
        if (transaction.meta.preTokenBalances && transaction.meta.postTokenBalances) {
            // 创建代币余额映射
            const preTokenMap = new Map();
            const postTokenMap = new Map();

            transaction.meta.preTokenBalances.forEach(balance => {
                if (balance.owner === this.walletAddress.toString()) {
                    preTokenMap.set(balance.mint, balance.uiTokenAmount.uiAmount || 0);
                }
            });

            transaction.meta.postTokenBalances.forEach(balance => {
                if (balance.owner === this.walletAddress.toString()) {
                    postTokenMap.set(balance.mint, balance.uiTokenAmount.uiAmount || 0);
                }
            });

            // 计算变化
            const allMints = new Set([...preTokenMap.keys(), ...postTokenMap.keys()]);
            
            for (const mint of allMints) {
                const preAmount = preTokenMap.get(mint) || 0;
                const postAmount = postTokenMap.get(mint) || 0;
                const change = postAmount - preAmount;

                if (Math.abs(change) > 0.000001) { // 忽略极小的变化
                    tokenChanges.push({
                        mint,
                        change,
                        preAmount,
                        postAmount
                    });
                }
            }
        }

        return tokenChanges;
    }

    /**
     * 判断交易类型 (修复：使用稳定币白名单判定)
     */
    determineTransactionType(solChange, tokenChanges) {
        if (tokenChanges.length === 0) {
            return solChange > 0 ? 'SOL_RECEIVE' : 'SOL_SEND';
        }

        // 检查是否为 WSOL wrap/unwrap
        const wsolChange = tokenChanges.find(change => 
            change.mint === 'So11111111111111111111111111111111111111112'
        );
        
        if (wsolChange && tokenChanges.length === 1) {
            return wsolChange.change > 0 ? 'WSOL_WRAP' : 'WSOL_UNWRAP';
        }

        // 分析代币交易
        const stableIn = tokenChanges.filter(change => 
            change.change > 0 && this.stableTokens.has(change.mint)
        );
        const stableOut = tokenChanges.filter(change => 
            change.change < 0 && this.stableTokens.has(change.mint)
        );
        const tokenIn = tokenChanges.filter(change => 
            change.change > 0 && !this.stableTokens.has(change.mint)
        );
        const tokenOut = tokenChanges.filter(change => 
            change.change < 0 && !this.stableTokens.has(change.mint)
        );

        // 买入逻辑：稳定币/蓝筹流出 + 小币流入
        if (stableOut.length > 0 && tokenIn.length > 0) {
            return 'TOKEN_BUY';
        }
        
        // 卖出逻辑：小币流出 + 稳定币/蓝筹流入
        if (tokenOut.length > 0 && stableIn.length > 0) {
            return 'TOKEN_SELL';
        }

        // 其他情况
        const hasTokenIncrease = tokenChanges.some(change => change.change > 0);
        const hasTokenDecrease = tokenChanges.some(change => change.change < 0);

        if (hasTokenIncrease && !hasTokenDecrease) {
            return 'TOKEN_RECEIVE';
        } else if (hasTokenDecrease && !hasTokenIncrease) {
            return 'TOKEN_SEND';
        } else {
            return 'COMPLEX_TRANSACTION';
        }
    }

    /**
     * 记录交易信息
     */
    logTransaction(transactionData) {
        const { signature, type, solChange, tokenChanges, timestamp, slot } = transactionData;
        
        console.log('\n=== 交易检测 ===');
        console.log(`交易类型: ${type}`);
        console.log(`交易签名: ${signature}`);
        console.log(`时间: ${timestamp}`);
        console.log(`区块: ${slot}`);
        console.log(`SOL 变化: ${solChange.toFixed(6)} SOL`);
        
        if (tokenChanges.length > 0) {
            console.log('代币变化:');
            tokenChanges.forEach(change => {
                const isStable = this.stableTokens.has(change.mint);
                const tokenType = isStable ? '[稳定币/蓝筹]' : '[小币]';
                console.log(`  ${tokenType} 代币: ${change.mint}`);
                console.log(`  变化: ${change.change > 0 ? '+' : ''}${change.change}`);
                console.log(`  前: ${change.preAmount} -> 后: ${change.postAmount}`);
            });
        }
        
        console.log('==================\n');

        // 触发自定义事件处理
        this.onTransaction(transactionData);
    }

    /**
     * 自定义事件处理函数 - 可以被重写
     */
    onTransaction(transactionData) {
        // 这里可以添加自定义逻辑，比如：
        // - 发送通知
        // - 保存到数据库
        // - 触发其他操作
        const { type, tokenChanges } = transactionData;
        
        if (type === 'TOKEN_BUY') {
            console.log('🟢 检测到买入操作！');
            this.logBuyDetails(tokenChanges);
        } else if (type === 'TOKEN_SELL') {
            console.log('🔴 检测到卖出操作！');
            this.logSellDetails(tokenChanges);
        } else if (type === 'WSOL_WRAP') {
            console.log('🔄 检测到 WSOL 包装操作');
        } else if (type === 'WSOL_UNWRAP') {
            console.log('🔄 检测到 WSOL 解包操作');
        }
    }

    /**
     * 记录买入详情
     */
    logBuyDetails(tokenChanges) {
        const stableOut = tokenChanges.filter(change => 
            change.change < 0 && this.stableTokens.has(change.mint)
        );
        const tokenIn = tokenChanges.filter(change => 
            change.change > 0 && !this.stableTokens.has(change.mint)
        );
        
        console.log('买入详情:');
        stableOut.forEach(change => {
            console.log(`  支出: ${Math.abs(change.change)} ${this.getTokenSymbol(change.mint)}`);
        });
        tokenIn.forEach(change => {
            console.log(`  获得: ${change.change} ${change.mint.slice(0, 8)}...`);
        });
    }

    /**
     * 记录卖出详情
     */
    logSellDetails(tokenChanges) {
        const tokenOut = tokenChanges.filter(change => 
            change.change < 0 && !this.stableTokens.has(change.mint)
        );
        const stableIn = tokenChanges.filter(change => 
            change.change > 0 && this.stableTokens.has(change.mint)
        );
        
        console.log('卖出详情:');
        tokenOut.forEach(change => {
            console.log(`  卖出: ${Math.abs(change.change)} ${change.mint.slice(0, 8)}...`);
        });
        stableIn.forEach(change => {
            console.log(`  获得: ${change.change} ${this.getTokenSymbol(change.mint)}`);
        });
    }

    /**
     * 获取代币符号
     */
    getTokenSymbol(mint) {
        const symbols = {
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
            'So11111111111111111111111111111111111111112': 'WSOL',
            'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
            'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 'mSOL',
            'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 'jitoSOL',
        };
        return symbols[mint] || mint.slice(0, 8) + '...';
    }

    /**
     * 获取钱包当前余额
     */
    async getWalletBalance() {
        try {
            const balance = await this.connection.getBalance(this.walletAddress);
            return balance / 1e9; // 转换为 SOL
        } catch (error) {
            console.error('获取余额失败:', error);
            return 0;
        }
    }

    /**
     * 获取钱包代币余额
     */
    async getTokenBalances() {
        try {
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                this.walletAddress,
                { programId: TOKEN_PROGRAM_ID }
            );

            return tokenAccounts.value.map(account => ({
                mint: account.account.data.parsed.info.mint,
                amount: account.account.data.parsed.info.tokenAmount.uiAmount,
                decimals: account.account.data.parsed.info.tokenAmount.decimals
            }));
        } catch (error) {
            console.error('获取代币余额失败:', error);
            return [];
        }
    }
}

// 使用示例
async function main() {
    // 替换为你要监控的钱包地址
    const walletAddress = '你的钱包地址';
    
    // 可选：使用自定义 RPC 端点
    const rpcUrl = 'https://api.mainnet-beta.solana.com'; // 或使用其他 RPC 服务
    
    const monitor = new SolanaWalletMonitor(walletAddress, rpcUrl);
    
    // 重写事件处理函数
    monitor.onTransaction = (transactionData) => {
        const { type, signature, solChange, tokenChanges } = transactionData;
        
        if (type === 'TOKEN_BUY') {
            console.log('🚀 买入提醒！');
            // 发送买入通知
        } else if (type === 'TOKEN_SELL') {
            console.log('💰 卖出提醒！');
            // 发送卖出通知
        }
        
        // 可以在这里添加其他逻辑，比如：
        // - 保存到数据库
        // - 发送 Webhook
        // - 触发其他交易
    };
    
    // 开始监控
    await monitor.startMonitoring();
    
    // 监控运行，直到手动停止
    process.on('SIGINT', async () => {
        console.log('\n正在停止监控...');
        await monitor.stopMonitoring();
        process.exit(0);
    });
}

// 启动监控
if (require.main === module) {
    main().catch(console.error);
}

module.exports = SolanaWalletMonitor;