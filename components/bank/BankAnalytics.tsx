
import React, { useMemo, useState, useEffect } from 'react';
import { BankTransaction, SavingsGoal, APIConfig } from '../../types';

interface Props {
    transactions: BankTransaction[];
    goals: SavingsGoal[];
    currency: string;
    onDeleteTx: (id: string) => void;
    apiConfig?: APIConfig;
    dailyBudget?: number;
}

// Category definitions with icons and colors
const CATEGORIES: Record<string, { icon: string; label: string; color: string; gradient: string }> = {
    food: { icon: '🍔', label: '餐饮', color: '#FF7043', gradient: 'from-orange-400 to-red-500' },
    transport: { icon: '🚗', label: '交通', color: '#42A5F5', gradient: 'from-blue-400 to-indigo-500' },
    shopping: { icon: '🛍️', label: '购物', color: '#AB47BC', gradient: 'from-purple-400 to-pink-500' },
    entertainment: { icon: '🎮', label: '娱乐', color: '#66BB6A', gradient: 'from-green-400 to-teal-500' },
    bills: { icon: '📱', label: '账单', color: '#FFA726', gradient: 'from-yellow-400 to-orange-500' },
    health: { icon: '💊', label: '医疗', color: '#EF5350', gradient: 'from-red-400 to-rose-500' },
    education: { icon: '📚', label: '学习', color: '#5C6BC0', gradient: 'from-indigo-400 to-purple-500' },
    other: { icon: '📦', label: '其他', color: '#78909C', gradient: 'from-gray-400 to-slate-500' }
};

const BankAnalytics: React.FC<Props> = ({ transactions, goals, currency, onDeleteTx, apiConfig, dailyBudget = 100 }) => {
    const [viewMode, setViewMode] = useState<'today' | 'week' | 'month'>('today');
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [categorizedTx, setCategorizedTx] = useState<Record<string, string>>({});
    const [aiSummary, setAiSummary] = useState<string>('');

    // Get date ranges
    const today = new Date().toISOString().split('T')[0];
    const currentMonth = new Date().toISOString().slice(0, 7);

    // Calculate week start (Monday)
    const getWeekStart = () => {
        const now = new Date();
        const day = now.getDay();
        const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday
        const weekStart = new Date(now.setDate(diff));
        return weekStart.toISOString().split('T')[0];
    };
    const weekStart = getWeekStart();

    // Filter transactions by time period
    const filteredTx = useMemo(() => {
        return transactions.filter(tx => {
            if (viewMode === 'today') return tx.dateStr === today;
            if (viewMode === 'week') return tx.dateStr >= weekStart;
            if (viewMode === 'month') return tx.dateStr.startsWith(currentMonth);
            return true;
        });
    }, [transactions, viewMode, today, weekStart, currentMonth]);

    // Calculate totals
    const totalSpent = useMemo(() => filteredTx.reduce((sum, tx) => sum + tx.amount, 0), [filteredTx]);

    // Group by category
    const categoryData = useMemo(() => {
        const groups: Record<string, { total: number; count: number; items: BankTransaction[] }> = {};

        filteredTx.forEach(tx => {
            const cat = categorizedTx[tx.id] || guessCategory(tx.note);
            if (!groups[cat]) groups[cat] = { total: 0, count: 0, items: [] };
            groups[cat].total += tx.amount;
            groups[cat].count++;
            groups[cat].items.push(tx);
        });

        return Object.entries(groups)
            .map(([key, data]) => ({ category: key, ...data, percentage: totalSpent > 0 ? (data.total / totalSpent) * 100 : 0 }))
            .sort((a, b) => b.total - a.total);
    }, [filteredTx, categorizedTx, totalSpent]);

    // Simple keyword-based category guessing
    function guessCategory(note: string): string {
        const lower = note.toLowerCase();
        if (/饭|餐|吃|外卖|食|奶茶|咖啡|早|午|晚|火锅|烧烤|面|饮/.test(lower)) return 'food';
        if (/车|地铁|公交|打车|油|加油|停车|出租/.test(lower)) return 'transport';
        if (/买|购|淘宝|京东|拼多多|商场|超市|衣服/.test(lower)) return 'shopping';
        if (/游戏|电影|娱乐|ktv|酒吧|玩/.test(lower)) return 'entertainment';
        if (/话费|水电|房租|网费|会员|订阅/.test(lower)) return 'bills';
        if (/医|药|健康|体检|看病/.test(lower)) return 'health';
        if (/书|课|学习|培训|教育/.test(lower)) return 'education';
        return 'other';
    }

    // AI categorization and summary
    const analyzeWithAI = async () => {
        if (!apiConfig?.apiKey || filteredTx.length === 0) return;

        setIsAnalyzing(true);
        try {
            const txList = filteredTx.map(tx => `- ${tx.note}: ${currency}${tx.amount}`).join('\n');
            const periodLabel = viewMode === 'today' ? '今天' : viewMode === 'week' ? '本周' : '本月';

            const prompt = `作为一个财务分析助手，分析以下消费记录：

${txList}

任务：
1. 为每笔消费分配类别 (food/transport/shopping/entertainment/bills/health/education/other)
2. 写一段简短有趣的总结（2-3句话），用轻松的语气评价${periodLabel}的消费习惯

输出JSON格式：
{
  "categories": { "消费备注1": "类别", "消费备注2": "类别" },
  "summary": "总结文字"
}`;

            const res = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'user', content: prompt }] })
            });

            if (res.ok) {
                const data = await res.json();
                let jsonStr = data.choices[0].message.content.replace(/```json/g, '').replace(/```/g, '').trim();
                const result = JSON.parse(jsonStr);

                // Map categories to transaction IDs
                const newCategories: Record<string, string> = { ...categorizedTx };
                filteredTx.forEach(tx => {
                    if (result.categories[tx.note]) {
                        newCategories[tx.id] = result.categories[tx.note];
                    }
                });
                setCategorizedTx(newCategories);
                setAiSummary(result.summary || '');
            }
        } catch (e) {
            console.error('AI analysis failed:', e);
        } finally {
            setIsAnalyzing(false);
        }
    };

    // Total savings progress
    const totalSaved = useMemo(() => goals.reduce((sum, g) => sum + g.currentAmount, 0), [goals]);
    const nextGoal = useMemo(() => goals.find(g => !g.isCompleted) || goals[0], [goals]);

    // Budget status for today
    const budgetRemaining = dailyBudget - (viewMode === 'today' ? totalSpent : 0);
    const budgetStatus = budgetRemaining >= 0 ? 'good' : 'over';

    return (
        <div className="min-h-full pb-24" style={{ background: 'linear-gradient(180deg, #FDF6E3 0%, #FFF8E1 100%)' }}>

            {/* Hero Section - Summary Card */}
            <div className="relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-[#6D4C41] via-[#5D4037] to-[#4E342E]"></div>
                <div className="absolute top-0 right-0 w-48 h-48 bg-white/5 rounded-full blur-3xl -mr-20 -mt-20"></div>
                <div className="absolute bottom-0 left-0 w-32 h-32 bg-white/5 rounded-full blur-2xl -ml-10 -mb-10"></div>

                <div className="relative z-10 p-5 pt-3">
                    {/* Period Selector */}
                    <div className="flex bg-white/10 backdrop-blur-sm p-1 rounded-2xl mb-5">
                        {[
                            { key: 'today', label: '今日', icon: '☀️' },
                            { key: 'week', label: '本周', icon: '📆' },
                            { key: 'month', label: '本月', icon: '📅' }
                        ].map(p => (
                            <button
                                key={p.key}
                                onClick={() => setViewMode(p.key as any)}
                                className={`flex-1 py-2.5 text-xs font-bold rounded-xl transition-all duration-300 flex items-center justify-center gap-1.5 ${
                                    viewMode === p.key
                                        ? 'bg-white text-[#5D4037] shadow-lg'
                                        : 'text-white/70 hover:text-white'
                                }`}
                            >
                                <span>{p.icon}</span>
                                <span>{p.label}</span>
                            </button>
                        ))}
                    </div>

                    {/* Main Stats */}
                    <div className="text-center mb-4">
                        <div className="text-xs text-white/60 uppercase tracking-widest mb-1">
                            {viewMode === 'today' ? '今日支出' : viewMode === 'week' ? '本周支出' : '本月支出'}
                        </div>
                        <div className="text-5xl font-black text-white font-mono tracking-tight">
                            {currency}{totalSpent.toFixed(0)}
                        </div>
                        <div className="text-sm text-white/50 mt-1">
                            共 {filteredTx.length} 笔
                        </div>
                    </div>

                    {/* Budget Status (Today only) */}
                    {viewMode === 'today' && (
                        <div className={`p-4 rounded-2xl backdrop-blur-md border ${
                            budgetStatus === 'good'
                                ? 'bg-green-500/20 border-green-400/30'
                                : 'bg-red-500/20 border-red-400/30'
                        }`}>
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <span className="text-2xl">{budgetStatus === 'good' ? '💪' : '😱'}</span>
                                    <span className="text-sm text-white font-medium">
                                        {budgetStatus === 'good' ? '预算还剩' : '已超支'}
                                    </span>
                                </div>
                                <span className={`text-2xl font-black font-mono ${budgetStatus === 'good' ? 'text-green-300' : 'text-red-300'}`}>
                                    {budgetStatus === 'good' ? '+' : ''}{currency}{Math.abs(budgetRemaining).toFixed(0)}
                                </span>
                            </div>
                            <div className="mt-2 h-2 bg-black/20 rounded-full overflow-hidden">
                                <div
                                    className={`h-full rounded-full transition-all duration-500 ${
                                        budgetStatus === 'good' ? 'bg-green-400' : 'bg-red-400'
                                    }`}
                                    style={{ width: `${Math.min(100, (totalSpent / dailyBudget) * 100)}%` }}
                                ></div>
                            </div>
                            <div className="text-[10px] text-white/50 mt-1 text-right">
                                预算 {currency}{dailyBudget}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Content Area */}
            <div className="p-5 space-y-5">

                {/* AI Summary Card */}
                {(aiSummary || filteredTx.length > 0) && (
                    <div className="bg-white rounded-3xl p-5 shadow-lg border border-[#E8DCC8] relative overflow-hidden">
                        <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br from-[#FFE0B2]/30 to-transparent rounded-full -mr-8 -mt-8"></div>

                        <div className="flex items-center justify-between mb-3 relative z-10">
                            <div className="flex items-center gap-2">
                                <span className="w-8 h-8 bg-gradient-to-br from-[#FFD54F] to-[#FFB300] rounded-xl flex items-center justify-center text-lg shadow-md">🤖</span>
                                <span className="text-sm font-bold text-[#5D4037]">AI 智能分析</span>
                            </div>
                            <button
                                onClick={analyzeWithAI}
                                disabled={isAnalyzing || !apiConfig?.apiKey}
                                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                                    isAnalyzing
                                        ? 'bg-[#EFEBE9] text-[#BCAAA4]'
                                        : 'bg-gradient-to-r from-[#42A5F5] to-[#1E88E5] text-white shadow-md hover:shadow-lg active:scale-95'
                                }`}
                            >
                                {isAnalyzing ? (
                                    <span className="flex items-center gap-1.5">
                                        <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                                        分析中
                                    </span>
                                ) : '生成总结'}
                            </button>
                        </div>

                        {aiSummary ? (
                            <div className="bg-gradient-to-r from-[#FFF8E1] to-[#FFF3E0] p-4 rounded-2xl text-sm text-[#5D4037] leading-relaxed relative z-10">
                                <span className="text-lg mr-2">💡</span>
                                {aiSummary}
                            </div>
                        ) : (
                            <div className="text-center py-4 text-[#BCAAA4] text-xs">
                                点击"生成总结"让 AI 分析你的消费习惯
                            </div>
                        )}
                    </div>
                )}

                {/* Category Breakdown */}
                {categoryData.length > 0 && (
                    <div className="bg-white rounded-3xl p-5 shadow-md border border-[#E8DCC8]">
                        <div className="flex items-center gap-2 mb-4">
                            <span className="w-8 h-8 bg-gradient-to-br from-[#AB47BC] to-[#7B1FA2] rounded-xl flex items-center justify-center text-lg shadow-md">📊</span>
                            <span className="text-sm font-bold text-[#5D4037]">消费分类</span>
                        </div>

                        <div className="space-y-3">
                            {categoryData.map(({ category, total, count, percentage }) => {
                                const cat = CATEGORIES[category] || CATEGORIES.other;
                                return (
                                    <div key={category} className="group">
                                        <div className="flex items-center justify-between mb-1.5">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xl">{cat.icon}</span>
                                                <span className="text-sm font-bold text-[#5D4037]">{cat.label}</span>
                                                <span className="text-[10px] text-[#A1887F] bg-[#FDF6E3] px-2 py-0.5 rounded-full">{count}笔</span>
                                            </div>
                                            <span className="font-mono font-bold text-[#5D4037]">{currency}{total.toFixed(0)}</span>
                                        </div>
                                        <div className="h-3 bg-[#EFEBE9] rounded-full overflow-hidden">
                                            <div
                                                className={`h-full bg-gradient-to-r ${cat.gradient} rounded-full transition-all duration-700 relative`}
                                                style={{ width: `${percentage}%` }}
                                            >
                                                <div className="absolute inset-0 bg-gradient-to-b from-white/30 to-transparent"></div>
                                            </div>
                                        </div>
                                        <div className="text-right text-[10px] text-[#A1887F] mt-0.5">{percentage.toFixed(1)}%</div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Transaction List */}
                <div className="bg-white rounded-3xl p-5 shadow-md border border-[#E8DCC8]">
                    <div className="flex items-center gap-2 mb-4">
                        <span className="w-8 h-8 bg-gradient-to-br from-[#66BB6A] to-[#43A047] rounded-xl flex items-center justify-center text-lg shadow-md">📝</span>
                        <span className="text-sm font-bold text-[#5D4037]">消费明细</span>
                    </div>

                    {filteredTx.length === 0 ? (
                        <div className="text-center py-12">
                            <div className="text-6xl mb-3 opacity-40">📭</div>
                            <div className="text-sm text-[#A1887F]">
                                {viewMode === 'today' ? '今天还没有消费记录' : viewMode === 'week' ? '本周暂无记录' : '本月暂无记录'}
                            </div>
                            <div className="text-xs text-[#BCAAA4] mt-1">点击右上角开始记账吧！</div>
                        </div>
                    ) : (
                        <div className="space-y-3 max-h-[400px] overflow-y-auto no-scrollbar">
                            {filteredTx.map(tx => {
                                const cat = CATEGORIES[categorizedTx[tx.id] || guessCategory(tx.note)] || CATEGORIES.other;
                                return (
                                    <div key={tx.id} className="flex items-center justify-between p-3 rounded-2xl bg-[#FDF6E3] hover:bg-[#FFF8E1] transition-colors group relative">
                                        <div className="flex items-center gap-3">
                                            <div className="w-11 h-11 rounded-xl bg-white flex items-center justify-center text-xl shadow-inner">
                                                {cat.icon}
                                            </div>
                                            <div>
                                                <div className="font-bold text-[#5D4037] text-sm">{tx.note}</div>
                                                <div className="text-[10px] text-[#A1887F] flex items-center gap-2">
                                                    <span>{new Date(tx.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
                                                    <span className="px-1.5 py-0.5 bg-white rounded text-[9px]" style={{ color: cat.color }}>{cat.label}</span>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="font-mono font-bold text-[#E64A19]">-{currency}{tx.amount}</div>

                                        <button
                                            onClick={() => onDeleteTx(tx.id)}
                                            className="absolute right-1 top-1 w-5 h-5 rounded-full bg-red-50 text-red-400 hover:bg-red-100 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all text-xs"
                                        >
                                            ×
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Savings Progress */}
                {goals.length > 0 && (
                    <div className="bg-gradient-to-br from-[#8D6E63] to-[#5D4037] rounded-3xl p-5 shadow-lg text-white relative overflow-hidden">
                        <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full blur-2xl -mr-10 -mt-10"></div>

                        <div className="flex items-center gap-2 mb-3 relative z-10">
                            <span className="text-xl">🎯</span>
                            <span className="text-sm font-bold">储蓄进度</span>
                        </div>

                        <div className="text-3xl font-black font-mono mb-3 relative z-10">{currency}{totalSaved.toFixed(0)}</div>

                        {nextGoal && (
                            <div className="bg-white/15 backdrop-blur-sm rounded-xl p-3 relative z-10">
                                <div className="flex justify-between text-xs mb-2">
                                    <span className="opacity-80">下一目标: {nextGoal.name}</span>
                                    <span className="font-bold">{currency}{nextGoal.targetAmount - nextGoal.currentAmount}</span>
                                </div>
                                <div className="h-2 bg-black/20 rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-gradient-to-r from-[#FFE0B2] to-[#FFAB91] rounded-full"
                                        style={{ width: `${Math.min(100, (nextGoal.currentAmount / nextGoal.targetAmount) * 100)}%` }}
                                    ></div>
                                </div>
                            </div>
                        )}
                    </div>
                )}

            </div>
        </div>
    );
};

export default BankAnalytics;
