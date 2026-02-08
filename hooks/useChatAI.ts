
import { useState } from 'react';
import { CharacterProfile, UserProfile, Message, Emoji, EmojiCategory, GroupProfile, RealtimeConfig } from '../types';
import { DB } from '../utils/db';
import { ChatPrompts } from '../utils/chatPrompts';
import { ChatParser } from '../utils/chatParser';
import { RealtimeContextManager, NotionManager, FeishuManager } from '../utils/realtimeContext';

interface UseChatAIProps {
    char: CharacterProfile | undefined;
    userProfile: UserProfile;
    apiConfig: any;
    groups: GroupProfile[];
    emojis: Emoji[];
    categories: EmojiCategory[];
    addToast: (msg: string, type: 'info'|'success'|'error') => void;
    setMessages: (msgs: Message[]) => void; // Callback to update UI messages
    realtimeConfig?: RealtimeConfig; // 新增：实时配置
    translationConfig?: { enabled: boolean; sourceLang: string; targetLang: string };
}

export const useChatAI = ({
    char,
    userProfile,
    apiConfig,
    groups,
    emojis,
    categories,
    addToast,
    setMessages,
    realtimeConfig,  // 新增
    translationConfig
}: UseChatAIProps) => {
    
    const [isTyping, setIsTyping] = useState(false);
    const [recallStatus, setRecallStatus] = useState<string>('');
    const [searchStatus, setSearchStatus] = useState<string>('');
    const [lastTokenUsage, setLastTokenUsage] = useState<number | null>(null);

    const triggerAI = async (currentMsgs: Message[]) => {
        if (isTyping || !char) return;
        if (!apiConfig.baseUrl) { alert("请先在设置中配置 API URL"); return; }

        setIsTyping(true);
        setRecallStatus('');

        try {
            const baseUrl = apiConfig.baseUrl.replace(/\/+$/, '');
            const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey || 'sk-none'}` };

            // 1. Build System Prompt (包含实时世界信息)
            let systemPrompt = await ChatPrompts.buildSystemPrompt(char, userProfile, groups, emojis, categories, currentMsgs, realtimeConfig);

            // 1.5 Inject bilingual output instruction when translation is enabled
            if (translationConfig?.enabled && translationConfig.sourceLang && translationConfig.targetLang) {
                systemPrompt += `\n\n[双语输出模式]\n本次对话采用双语输出。你的每条消息都包含两种语言，用 %%BILINGUAL%% 分隔。\n格式要求（严格遵守）：\n1. 先写${translationConfig.sourceLang}版本\n2. 换行写 %%BILINGUAL%%\n3. 再换行写${translationConfig.targetLang}版本\n4. 多条消息之间必须用 --- 独占一行分隔\n\n正确示例：\nこんにちは！\n%%BILINGUAL%%\n你好！\n---\n今日は何する？\n%%BILINGUAL%%\n今天做什么？\n\n错误示例（禁止）：\nこんにちは！今日は何する？\n%%BILINGUAL%%\n你好！今天做什么？\n\n每条 --- 分隔的消息都必须各自包含 %%BILINGUAL%%。语气风格情感完全一致，角色人设不变。`;
            }

            // 2. Build Message History
            const limit = char.contextLimit || 500;
            const { apiMessages, historySlice } = ChatPrompts.buildMessageHistory(currentMsgs, limit, char, userProfile, emojis);

            // 2.5 Strip %%BILINGUAL%% from previous messages to save tokens
            const cleanedApiMessages = apiMessages.map((msg: any) => {
                if (typeof msg.content === 'string' && msg.content.includes('%%BILINGUAL%%')) {
                    return { ...msg, content: msg.content.substring(0, msg.content.indexOf('%%BILINGUAL%%')).trim() };
                }
                return msg;
            });

            const fullMessages = [{ role: 'system', content: systemPrompt }, ...cleanedApiMessages];

            // 3. API Call
            let response = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST', headers,
                body: JSON.stringify({ model: apiConfig.model, messages: fullMessages, temperature: 0.85, stream: false })
            });

            if (!response.ok) throw new Error(`API Error ${response.status}`);
            let data = await response.json();
            if (data.usage?.total_tokens) setLastTokenUsage(data.usage.total_tokens);

            // 4. Initial Cleanup
            let aiContent = data.choices?.[0]?.message?.content || '';
            aiContent = aiContent.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*?\]/g, '');
            aiContent = aiContent.replace(/^[\w\u4e00-\u9fa5]+:\s*/, ''); 
            aiContent = aiContent.replace(/\[(?:你|User|用户|System)\s*发送了表情包[:：]\s*(.*?)\]/g, '[[SEND_EMOJI: $1]]');

            // 5. Handle Recall (Loop if needed)
            const recallMatch = aiContent.match(/\[\[RECALL:\s*(\d{4})[-/年](\d{1,2})\]\]/);
            if (recallMatch) {
                const year = recallMatch[1];
                const month = recallMatch[2];
                setRecallStatus(`正在调阅 ${year}年${month}月 的详细档案...`);
                
                // Helper to fetch detailed logs (duplicated logic from Chat.tsx, moved inside hook context)
                const getDetailedLogs = (y: string, m: string) => {
                    if (!char.memories) return null;
                    const target = `${y}-${m.padStart(2, '0')}`;
                    const logs = char.memories.filter(mem => {
                        return mem.date.includes(target) || mem.date.includes(`${y}年${parseInt(m)}月`);
                    });
                    if (logs.length === 0) return null;
                    return logs.map(mem => `[${mem.date}] (${mem.mood || 'normal'}): ${mem.summary}`).join('\n');
                };

                const detailedLogs = getDetailedLogs(year, month);
                
                if (detailedLogs) {
                    const recallMessages = [...fullMessages, { role: 'system', content: `[系统: 已成功调取 ${year}-${month} 的详细日志]\n${detailedLogs}\n[系统: 现在请结合这些细节回答用户。保持对话自然。]` }];
                    response = await fetch(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers,
                        body: JSON.stringify({ model: apiConfig.model, messages: recallMessages, temperature: 0.8, stream: false })
                    });
                    if (response.ok) {
                        data = await response.json();
                        aiContent = data.choices?.[0]?.message?.content || '';
                        // Re-clean
                        aiContent = aiContent.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*?\]/g, '');
                        aiContent = aiContent.replace(/^[\w\u4e00-\u9fa5]+:\s*/, '');
                        aiContent = aiContent.replace(/\[(?:你|User|用户|System)\s*发送了表情包[:：]\s*(.*?)\]/g, '[[SEND_EMOJI: $1]]');
                        addToast(`已调用 ${year}-${month} 详细记忆`, 'info');
                    }
                }
            }
            setRecallStatus('');

            // 5.5 Handle Active Search (主动搜索)
            const searchMatch = aiContent.match(/\[\[SEARCH:\s*(.+?)\]\]/);
            if (searchMatch && realtimeConfig?.newsEnabled && realtimeConfig?.newsApiKey) {
                const searchQuery = searchMatch[1].trim();
                console.log('🔍 [Search] AI触发搜索:', searchQuery);
                setSearchStatus(`正在搜索: ${searchQuery}...`);

                try {
                    const searchResult = await RealtimeContextManager.performSearch(searchQuery, realtimeConfig.newsApiKey);
                    console.log('🔍 [Search] 搜索结果:', searchResult);

                    if (searchResult.success && searchResult.results.length > 0) {
                        // 构建搜索结果字符串
                        const resultsStr = searchResult.results.map((r, i) =>
                            `${i + 1}. ${r.title}\n   ${r.description}`
                        ).join('\n\n');

                        console.log('🔍 [Search] 注入结果到AI，重新生成回复...');

                        // 重新调用 API，注入搜索结果
                        const cleanedForSearch = aiContent.replace(/\[\[SEARCH:.*?\]\]/g, '').trim() || '让我搜一下...';
                        const searchMessages = [
                            ...fullMessages,
                            { role: 'assistant', content: cleanedForSearch },
                            { role: 'system', content: `[系统: 搜索完成！以下是关于"${searchQuery}"的搜索结果]\n\n${resultsStr}\n\n[系统: 现在请根据这些真实信息回复用户。用自然的语气分享，比如"我刚搜了一下发现..."、"诶我看到说..."。不要再输出[[SEARCH:...]]了。]` }
                        ];

                        response = await fetch(`${baseUrl}/chat/completions`, {
                            method: 'POST', headers,
                            body: JSON.stringify({ model: apiConfig.model, messages: searchMessages, temperature: 0.8, stream: false })
                        });

                        if (response.ok) {
                            data = await response.json();
                            aiContent = data.choices?.[0]?.message?.content || '';
                            console.log('🔍 [Search] AI基于搜索结果生成的新回复:', aiContent.slice(0, 100) + '...');
                            // Re-clean
                            aiContent = aiContent.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*?\]/g, '');
                            aiContent = aiContent.replace(/^[\w\u4e00-\u9fa5]+:\s*/, '');
                            aiContent = aiContent.replace(/\[(?:你|User|用户|System)\s*发送了表情包[:：]\s*(.*?)\]/g, '[[SEND_EMOJI: $1]]');
                            addToast(`🔍 搜索完成: ${searchQuery}`, 'success');
                        }
                    } else {
                        console.log('🔍 [Search] 搜索失败或无结果:', searchResult.message);
                        addToast(`搜索失败: ${searchResult.message}`, 'error');
                        // 搜索失败，移除搜索标记继续
                        aiContent = aiContent.replace(searchMatch[0], '').trim();
                    }
                } catch (e) {
                    console.error('Search execution failed:', e);
                    aiContent = aiContent.replace(searchMatch[0], '').trim();
                }
            } else if (searchMatch) {
                console.log('🔍 [Search] 检测到搜索意图但未配置API Key');
                // 没有配置 API Key，移除搜索标记
                aiContent = aiContent.replace(searchMatch[0], '').trim();
            }
            setSearchStatus('');

            // 清理残留的搜索标记
            aiContent = aiContent.replace(/\[\[SEARCH:.*?\]\]/g, '').trim();

            // 5.6 Handle Diary Writing (写日记到 Notion)
            // 支持两种格式:
            //   旧格式: [[DIARY: 标题 | 内容]]
            //   新格式: [[DIARY_START: 标题 | 心情]]\n多行内容...\n[[DIARY_END]]
            const diaryStartMatch = aiContent.match(/\[\[DIARY_START:\s*(.+?)\]\]\n?([\s\S]*?)\[\[DIARY_END\]\]/);
            const diaryMatch = diaryStartMatch || aiContent.match(/\[\[DIARY:\s*(.+?)\]\]/s);

            if (diaryMatch && realtimeConfig?.notionEnabled && realtimeConfig?.notionApiKey && realtimeConfig?.notionDatabaseId) {
                let title = '';
                let content = '';
                let mood = '';

                if (diaryStartMatch) {
                    // 新格式: [[DIARY_START: 标题 | 心情]]\n内容\n[[DIARY_END]]
                    const header = diaryStartMatch[1].trim();
                    content = diaryStartMatch[2].trim();

                    if (header.includes('|')) {
                        const parts = header.split('|');
                        title = parts[0].trim();
                        mood = parts.slice(1).join('|').trim();
                    } else {
                        title = header;
                    }
                    console.log('📔 [Diary] AI写了一篇长日记:', title, '心情:', mood);
                } else {
                    // 旧格式: [[DIARY: 标题 | 内容]]
                    const diaryRaw = diaryMatch[1].trim();
                    console.log('📔 [Diary] AI想写日记:', diaryRaw);

                    if (diaryRaw.includes('|')) {
                        const parts = diaryRaw.split('|');
                        title = parts[0].trim();
                        content = parts.slice(1).join('|').trim();
                    } else {
                        content = diaryRaw;
                    }
                }

                // 没有标题时用日期
                if (!title) {
                    const now = new Date();
                    title = `${char.name}的日记 - ${now.getMonth() + 1}/${now.getDate()}`;
                }

                try {
                    const result = await NotionManager.createDiaryPage(
                        realtimeConfig.notionApiKey,
                        realtimeConfig.notionDatabaseId,
                        { title, content, mood: mood || undefined, characterName: char.name }
                    );

                    if (result.success) {
                        console.log('📔 [Diary] 写入成功:', result.url);
                        await DB.saveMessage({
                            charId: char.id,
                            role: 'system',
                            type: 'text',
                            content: `📔 ${char.name}写了一篇日记「${title}」`
                        });
                        addToast(`📔 ${char.name}写了一篇日记!`, 'success');
                    } else {
                        console.error('📔 [Diary] 写入失败:', result.message);
                        addToast(`日记写入失败: ${result.message}`, 'error');
                    }
                } catch (e) {
                    console.error('📔 [Diary] 写入异常:', e);
                }

                // 移除日记标记，不在聊天中显示
                aiContent = aiContent.replace(diaryMatch[0], '').trim();
            } else if (diaryMatch) {
                console.log('📔 [Diary] 检测到日记意图但未配置Notion');
                aiContent = aiContent.replace(diaryMatch[0], '').trim();
            }

            // 清理残留的日记标记（两种格式都清理）
            aiContent = aiContent.replace(/\[\[DIARY:.*?\]\]/gs, '').trim();
            aiContent = aiContent.replace(/\[\[DIARY_START:.*?\]\][\s\S]*?\[\[DIARY_END\]\]/g, '').trim();

            // 5.7 Handle Read Diary (翻阅日记)
            const readDiaryMatch = aiContent.match(/\[\[READ_DIARY:\s*(.+?)\]\]/);
            if (readDiaryMatch && realtimeConfig?.notionEnabled && realtimeConfig?.notionApiKey && realtimeConfig?.notionDatabaseId) {
                const dateInput = readDiaryMatch[1].trim();
                console.log('📖 [ReadDiary] AI想翻阅日记:', dateInput);

                // 解析日期输入 - 支持 YYYY-MM-DD, 昨天, 前天, N天前, M月D日 等
                let targetDate = '';
                const now = new Date();

                if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
                    targetDate = dateInput;
                } else if (dateInput === '今天') {
                    targetDate = now.toISOString().split('T')[0];
                } else if (dateInput === '昨天') {
                    const d = new Date(now); d.setDate(d.getDate() - 1);
                    targetDate = d.toISOString().split('T')[0];
                } else if (dateInput === '前天') {
                    const d = new Date(now); d.setDate(d.getDate() - 2);
                    targetDate = d.toISOString().split('T')[0];
                } else if (/^(\d+)天前$/.test(dateInput)) {
                    const days = parseInt(dateInput.match(/^(\d+)天前$/)![1]);
                    const d = new Date(now); d.setDate(d.getDate() - days);
                    targetDate = d.toISOString().split('T')[0];
                } else if (/(\d{1,2})月(\d{1,2})[日号]?$/.test(dateInput)) {
                    const m = dateInput.match(/(\d{1,2})月(\d{1,2})/);
                    if (m) {
                        const month = m[1].padStart(2, '0');
                        const day = m[2].padStart(2, '0');
                        targetDate = `${now.getFullYear()}-${month}-${day}`;
                    }
                } else {
                    // 尝试直接作为日期解析
                    const parsed = new Date(dateInput);
                    if (!isNaN(parsed.getTime())) {
                        targetDate = parsed.toISOString().split('T')[0];
                    }
                }

                if (targetDate) {
                    try {
                        // 1. 按日期查找日记
                        const findResult = await NotionManager.getDiaryByDate(
                            realtimeConfig.notionApiKey,
                            realtimeConfig.notionDatabaseId,
                            char.name,
                            targetDate
                        );

                        if (findResult.success && findResult.entries.length > 0) {
                            // 2. 读取每篇日记的内容（一天可能有多篇）
                            const diaryContents: string[] = [];
                            for (const entry of findResult.entries) {
                                const readResult = await NotionManager.readDiaryContent(
                                    realtimeConfig.notionApiKey,
                                    entry.id
                                );
                                if (readResult.success) {
                                    diaryContents.push(`📔「${entry.title}」(${entry.date})\n${readResult.content}`);
                                }
                            }

                            if (diaryContents.length > 0) {
                                const diaryText = diaryContents.join('\n\n---\n\n');
                                console.log('📖 [ReadDiary] 成功读取', findResult.entries.length, '篇日记');

                                // 3. 重新调用 API，注入日记内容
                                const cleanedForDiary = aiContent.replace(/\[\[READ_DIARY:.*?\]\]/g, '').trim() || '让我翻翻日记...';
                                const diaryMessages = [
                                    ...fullMessages,
                                    { role: 'assistant', content: cleanedForDiary },
                                    { role: 'system', content: `[系统: 你翻开了自己 ${targetDate} 的日记，以下是你当时写的内容]\n\n${diaryText}\n\n[系统: 你已经看完了日记。现在请你：\n1. 先正常回应用户刚才说的话（这是最重要的！用户还在等你回复）\n2. 自然地把日记中的回忆融入你的回复中，比如"我想起来了那天..."、"看了日记才发现..."等\n3. 可以分享日记中有趣的细节，表达当时的情绪\n4. 用多条消息回复，别只说一句话就结束\n5. 严禁再输出[[READ_DIARY:...]]标记]` }
                                ];

                                response = await fetch(`${baseUrl}/chat/completions`, {
                                    method: 'POST', headers,
                                    body: JSON.stringify({ model: apiConfig.model, messages: diaryMessages, temperature: 0.8, stream: false })
                                });

                                if (response.ok) {
                                    data = await response.json();
                                    aiContent = data.choices?.[0]?.message?.content || '';
                                    aiContent = aiContent.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*?\]/g, '');
                                    aiContent = aiContent.replace(/^[\w\u4e00-\u9fa5]+:\s*/, '');
                                    aiContent = aiContent.replace(/\[(?:你|User|用户|System)\s*发送了表情包[:：]\s*(.*?)\]/g, '[[SEND_EMOJI: $1]]');
                                    addToast(`📖 ${char.name}翻阅了${targetDate}的日记`, 'info');
                                }
                            } else {
                                console.log('📖 [ReadDiary] 日记内容为空');
                                aiContent = aiContent.replace(readDiaryMatch[0], '').trim();
                            }
                        } else {
                            console.log('📖 [ReadDiary] 该日期没有日记:', targetDate);
                            // 注入"没找到"的信息让AI自然处理
                            const cleanedForNoDiary = aiContent.replace(/\[\[READ_DIARY:.*?\]\]/g, '').trim() || '让我翻翻日记...';
                            const nodiaryMessages = [
                                ...fullMessages,
                                { role: 'assistant', content: cleanedForNoDiary },
                                { role: 'system', content: `[系统: 你翻了翻日记本，发现 ${targetDate} 那天没有写日记。请你：\n1. 先正常回应用户刚才说的话（用户还在等你回复！）\n2. 自然地提到没找到那天的日记，比如"嗯...那天好像没写日记"、"翻了翻没找到诶"\n3. 用多条消息回复，保持对话自然\n4. 严禁再输出[[READ_DIARY:...]]标记]` }
                            ];

                            response = await fetch(`${baseUrl}/chat/completions`, {
                                method: 'POST', headers,
                                body: JSON.stringify({ model: apiConfig.model, messages: nodiaryMessages, temperature: 0.8, stream: false })
                            });

                            if (response.ok) {
                                data = await response.json();
                                aiContent = data.choices?.[0]?.message?.content || '';
                                aiContent = aiContent.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*?\]/g, '');
                                aiContent = aiContent.replace(/^[\w\u4e00-\u9fa5]+:\s*/, '');
                                aiContent = aiContent.replace(/\[(?:你|User|用户|System)\s*发送了表情包[:：]\s*(.*?)\]/g, '[[SEND_EMOJI: $1]]');
                            }
                        }
                    } catch (e) {
                        console.error('📖 [ReadDiary] 读取异常:', e);
                        aiContent = aiContent.replace(readDiaryMatch[0], '').trim();
                    }
                } else {
                    console.log('📖 [ReadDiary] 无法解析日期:', dateInput);
                    aiContent = aiContent.replace(readDiaryMatch[0], '').trim();
                }
            } else if (readDiaryMatch) {
                console.log('📖 [ReadDiary] 检测到读日记意图但未配置Notion');
                aiContent = aiContent.replace(readDiaryMatch[0], '').trim();
            }

            // 清理残留的读日记标记
            aiContent = aiContent.replace(/\[\[READ_DIARY:.*?\]\]/g, '').trim();

            // 5.8 Handle Feishu Diary Writing (写日记到飞书多维表格 - 独立于 Notion)
            const fsDiaryStartMatch = aiContent.match(/\[\[FS_DIARY_START:\s*(.+?)\]\]\n?([\s\S]*?)\[\[FS_DIARY_END\]\]/);
            const fsDiaryMatch = fsDiaryStartMatch || aiContent.match(/\[\[FS_DIARY:\s*(.+?)\]\]/s);

            if (fsDiaryMatch && realtimeConfig?.feishuEnabled && realtimeConfig?.feishuAppId && realtimeConfig?.feishuAppSecret && realtimeConfig?.feishuBaseId && realtimeConfig?.feishuTableId) {
                let fsTitle = '';
                let fsContent = '';
                let fsMood = '';

                if (fsDiaryStartMatch) {
                    const header = fsDiaryStartMatch[1].trim();
                    fsContent = fsDiaryStartMatch[2].trim();
                    if (header.includes('|')) {
                        const parts = header.split('|');
                        fsTitle = parts[0].trim();
                        fsMood = parts.slice(1).join('|').trim();
                    } else {
                        fsTitle = header;
                    }
                    console.log('📒 [Feishu] AI写了一篇长日记:', fsTitle, '心情:', fsMood);
                } else {
                    const diaryRaw = fsDiaryMatch[1].trim();
                    console.log('📒 [Feishu] AI想写日记:', diaryRaw);
                    if (diaryRaw.includes('|')) {
                        const parts = diaryRaw.split('|');
                        fsTitle = parts[0].trim();
                        fsContent = parts.slice(1).join('|').trim();
                    } else {
                        fsContent = diaryRaw;
                    }
                }

                if (!fsTitle) {
                    const now = new Date();
                    fsTitle = `${char.name}的日记 - ${now.getMonth() + 1}/${now.getDate()}`;
                }

                try {
                    const result = await FeishuManager.createDiaryRecord(
                        realtimeConfig.feishuAppId,
                        realtimeConfig.feishuAppSecret,
                        realtimeConfig.feishuBaseId,
                        realtimeConfig.feishuTableId,
                        { title: fsTitle, content: fsContent, mood: fsMood || undefined, characterName: char.name }
                    );

                    if (result.success) {
                        console.log('📒 [Feishu] 写入成功:', result.recordId);
                        await DB.saveMessage({
                            charId: char.id,
                            role: 'system',
                            type: 'text',
                            content: `📒 ${char.name}写了一篇日记「${fsTitle}」(飞书)`
                        });
                        addToast(`📒 ${char.name}写了一篇日记! (飞书)`, 'success');
                    } else {
                        console.error('📒 [Feishu] 写入失败:', result.message);
                        addToast(`飞书日记写入失败: ${result.message}`, 'error');
                    }
                } catch (e) {
                    console.error('📒 [Feishu] 写入异常:', e);
                }

                aiContent = aiContent.replace(fsDiaryMatch[0], '').trim();
            } else if (fsDiaryMatch) {
                console.log('📒 [Feishu] 检测到日记意图但未配置飞书');
                aiContent = aiContent.replace(fsDiaryMatch[0], '').trim();
            }

            // 清理残留的飞书日记标记
            aiContent = aiContent.replace(/\[\[FS_DIARY:.*?\]\]/gs, '').trim();
            aiContent = aiContent.replace(/\[\[FS_DIARY_START:.*?\]\][\s\S]*?\[\[FS_DIARY_END\]\]/g, '').trim();

            // 5.9 Handle Feishu Read Diary (翻阅飞书日记)
            const fsReadDiaryMatch = aiContent.match(/\[\[FS_READ_DIARY:\s*(.+?)\]\]/);
            if (fsReadDiaryMatch && realtimeConfig?.feishuEnabled && realtimeConfig?.feishuAppId && realtimeConfig?.feishuAppSecret && realtimeConfig?.feishuBaseId && realtimeConfig?.feishuTableId) {
                const dateInput = fsReadDiaryMatch[1].trim();
                console.log('📖 [Feishu ReadDiary] AI想翻阅飞书日记:', dateInput);

                let targetDate = '';
                const now = new Date();

                if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
                    targetDate = dateInput;
                } else if (dateInput === '今天') {
                    targetDate = now.toISOString().split('T')[0];
                } else if (dateInput === '昨天') {
                    const d = new Date(now); d.setDate(d.getDate() - 1);
                    targetDate = d.toISOString().split('T')[0];
                } else if (dateInput === '前天') {
                    const d = new Date(now); d.setDate(d.getDate() - 2);
                    targetDate = d.toISOString().split('T')[0];
                } else if (/^(\d+)天前$/.test(dateInput)) {
                    const days = parseInt(dateInput.match(/^(\d+)天前$/)![1]);
                    const d = new Date(now); d.setDate(d.getDate() - days);
                    targetDate = d.toISOString().split('T')[0];
                } else if (/(\d{1,2})月(\d{1,2})[日号]?$/.test(dateInput)) {
                    const m = dateInput.match(/(\d{1,2})月(\d{1,2})/);
                    if (m) {
                        const month = m[1].padStart(2, '0');
                        const day = m[2].padStart(2, '0');
                        targetDate = `${now.getFullYear()}-${month}-${day}`;
                    }
                } else {
                    const parsed = new Date(dateInput);
                    if (!isNaN(parsed.getTime())) {
                        targetDate = parsed.toISOString().split('T')[0];
                    }
                }

                if (targetDate) {
                    try {
                        const findResult = await FeishuManager.getDiaryByDate(
                            realtimeConfig.feishuAppId,
                            realtimeConfig.feishuAppSecret,
                            realtimeConfig.feishuBaseId,
                            realtimeConfig.feishuTableId,
                            char.name,
                            targetDate
                        );

                        if (findResult.success && findResult.entries.length > 0) {
                            const diaryContents: string[] = [];
                            for (const entry of findResult.entries) {
                                diaryContents.push(`📒「${entry.title}」(${entry.date})\n${entry.content}`);
                            }

                            if (diaryContents.length > 0) {
                                const diaryText = diaryContents.join('\n\n---\n\n');
                                console.log('📖 [Feishu ReadDiary] 成功读取', findResult.entries.length, '篇日记');

                                const cleanedForFsDiary = aiContent.replace(/\[\[FS_READ_DIARY:.*?\]\]/g, '').trim() || '让我翻翻日记...';
                                const diaryMessages = [
                                    ...fullMessages,
                                    { role: 'assistant', content: cleanedForFsDiary },
                                    { role: 'system', content: `[系统: 你翻开了自己 ${targetDate} 的日记（飞书），以下是你当时写的内容]\n\n${diaryText}\n\n[系统: 你已经看完了日记。现在请你：\n1. 先正常回应用户刚才说的话（这是最重要的！用户还在等你回复）\n2. 自然地把日记中的回忆融入你的回复中，比如"我想起来了那天..."、"看了日记才发现..."等\n3. 可以分享日记中有趣的细节，表达当时的情绪\n4. 用多条消息回复，别只说一句话就结束\n5. 严禁再输出[[FS_READ_DIARY:...]]标记]` }
                                ];

                                response = await fetch(`${baseUrl}/chat/completions`, {
                                    method: 'POST', headers,
                                    body: JSON.stringify({ model: apiConfig.model, messages: diaryMessages, temperature: 0.8, stream: false })
                                });

                                if (response.ok) {
                                    data = await response.json();
                                    aiContent = data.choices?.[0]?.message?.content || '';
                                    aiContent = aiContent.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*?\]/g, '');
                                    aiContent = aiContent.replace(/^[\w\u4e00-\u9fa5]+:\s*/, '');
                                    aiContent = aiContent.replace(/\[(?:你|User|用户|System)\s*发送了表情包[:：]\s*(.*?)\]/g, '[[SEND_EMOJI: $1]]');
                                    addToast(`📖 ${char.name}翻阅了${targetDate}的飞书日记`, 'info');
                                }
                            } else {
                                aiContent = aiContent.replace(fsReadDiaryMatch[0], '').trim();
                            }
                        } else {
                            const cleanedForFsNoDiary = aiContent.replace(/\[\[FS_READ_DIARY:.*?\]\]/g, '').trim() || '让我翻翻日记...';
                            const nodiaryMessages = [
                                ...fullMessages,
                                { role: 'assistant', content: cleanedForFsNoDiary },
                                { role: 'system', content: `[系统: 你翻了翻飞书日记本，发现 ${targetDate} 那天没有写日记。请你：\n1. 先正常回应用户刚才说的话（用户还在等你回复！）\n2. 自然地提到没找到那天的日记，比如"嗯...那天好像没写日记"、"翻了翻没找到诶"\n3. 用多条消息回复，保持对话自然\n4. 严禁再输出[[FS_READ_DIARY:...]]标记]` }
                            ];

                            response = await fetch(`${baseUrl}/chat/completions`, {
                                method: 'POST', headers,
                                body: JSON.stringify({ model: apiConfig.model, messages: nodiaryMessages, temperature: 0.8, stream: false })
                            });

                            if (response.ok) {
                                data = await response.json();
                                aiContent = data.choices?.[0]?.message?.content || '';
                                aiContent = aiContent.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*?\]/g, '');
                                aiContent = aiContent.replace(/^[\w\u4e00-\u9fa5]+:\s*/, '');
                                aiContent = aiContent.replace(/\[(?:你|User|用户|System)\s*发送了表情包[:：]\s*(.*?)\]/g, '[[SEND_EMOJI: $1]]');
                            }
                        }
                    } catch (e) {
                        console.error('📖 [Feishu ReadDiary] 读取异常:', e);
                        aiContent = aiContent.replace(fsReadDiaryMatch[0], '').trim();
                    }
                } else {
                    console.log('📖 [Feishu ReadDiary] 无法解析日期:', dateInput);
                    aiContent = aiContent.replace(fsReadDiaryMatch[0], '').trim();
                }
            } else if (fsReadDiaryMatch) {
                console.log('📖 [Feishu ReadDiary] 检测到读日记意图但未配置飞书');
                aiContent = aiContent.replace(fsReadDiaryMatch[0], '').trim();
            }

            // 清理残留的飞书读日记标记
            aiContent = aiContent.replace(/\[\[FS_READ_DIARY:.*?\]\]/g, '').trim();

            // 6. Parse Actions (Poke, Transfer, Schedule, etc.)
            aiContent = await ChatParser.parseAndExecuteActions(aiContent, char.id, char.name, addToast);

            // 7. Handle Quote/Reply Logic (Robust: handles [[QUOTE:...]], [QUOTE:...], 「...」 prefix quotes)
            let aiReplyTarget: { id: number, content: string, name: string } | undefined;
            const firstQuoteMatch = aiContent.match(/\[{1,2}QUOTE:\s*(.*?)\]{1,2}/);
            if (firstQuoteMatch) {
                const quotedText = firstQuoteMatch[1].trim();
                if (quotedText) {
                    // Try exact include first, then fuzzy match (first 10 chars)
                    const targetMsg = historySlice.slice().reverse().find((m: Message) => m.role === 'user' && m.content.includes(quotedText))
                        || (quotedText.length > 10 ? historySlice.slice().reverse().find((m: Message) => m.role === 'user' && m.content.includes(quotedText.slice(0, 10))) : undefined);
                    if (targetMsg) aiReplyTarget = { id: targetMsg.id, content: targetMsg.content, name: userProfile.name };
                }
            }
            // Clean all quote tag variants from content
            aiContent = aiContent.replace(/\[{1,2}QUOTE:\s*.*?\]{1,2}/g, '').trim();

            // 8. Split and Stream (Simulate Typing)
            // Fallback: if second-pass API calls (search/diary) returned empty, provide a minimal response
            if (!aiContent.trim() && (searchMatch || readDiaryMatch || fsReadDiaryMatch)) {
                aiContent = '嗯...';
            }
            if (aiContent) {
                const parts = ChatParser.splitResponse(aiContent);

                for (let partIndex = 0; partIndex < parts.length; partIndex++) {
                    const part = parts[partIndex];

                    if (part.type === 'emoji') {
                        const foundEmoji = emojis.find(e => e.name === part.content);
                        if (foundEmoji) {
                            const delay = Math.random() * 500 + 300;
                            await new Promise(r => setTimeout(r, delay));
                            await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'emoji', content: foundEmoji.url });
                            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                        }
                    } else if (part.content.includes('%%BILINGUAL%%')) {
                        // Bilingual mode: split on --- separators first, then parse each block
                        // This handles AI outputting multiple bilingual messages in one response
                        const blocks = part.content.split(/^\s*---\s*$/m).filter(b => b.trim());

                        for (let bi = 0; bi < blocks.length; bi++) {
                            let block = blocks[bi].trim();
                            if (!block) continue;

                            // If block contains multiple %%BILINGUAL%%, only keep the first pair
                            const biIdx = block.indexOf('%%BILINGUAL%%');
                            let biContent: string;
                            if (biIdx !== -1) {
                                const langA = block.substring(0, biIdx).trim();
                                let langB = block.substring(biIdx + '%%BILINGUAL%%'.length);
                                // Strip any further %%BILINGUAL%% markers that leaked in
                                langB = langB.replace(/%%BILINGUAL%%/g, '\n').trim();
                                biContent = langA && langB ? `${langA}\n%%BILINGUAL%%\n${langB}` : (langA || langB);
                            } else {
                                // No bilingual marker in this block - just plain text
                                biContent = block;
                            }

                            // Strip residual junk
                            biContent = biContent
                                .replace(/%%TRANS%%[\s\S]*/g, '')
                                .replace(/^\s*---\s*$/gm, '')
                                .replace(/\n{3,}/g, '\n\n')
                                .trim();
                            if (!biContent) continue;

                            // Handle QUOTE tags
                            const biQuoteMatch = biContent.match(/\[{1,2}QUOTE:\s*(.*?)\]{1,2}/);
                            let biReplyTarget: { id: number, content: string, name: string } | undefined;
                            if (biQuoteMatch) {
                                const quotedText = biQuoteMatch[1].trim();
                                if (quotedText) {
                                    const targetMsg = historySlice.slice().reverse().find((m: Message) => m.role === 'user' && m.content.includes(quotedText))
                                        || (quotedText.length > 10 ? historySlice.slice().reverse().find((m: Message) => m.role === 'user' && m.content.includes(quotedText.slice(0, 10))) : undefined);
                                    if (targetMsg) biReplyTarget = { id: targetMsg.id, content: targetMsg.content, name: userProfile.name };
                                }
                                biContent = biContent.replace(/\[{1,2}QUOTE:\s*.*?\]{1,2}/g, '').trim();
                            }
                            const replyData = biReplyTarget || (partIndex === 0 && bi === 0 ? aiReplyTarget : undefined);

                            const delay = Math.min(Math.max(biContent.length * 30, 400), 2000);
                            await new Promise(r => setTimeout(r, delay));
                            await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: biContent, replyTo: replyData });
                            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                        }
                    } else {
                        const chunks = ChatParser.chunkText(part.content);
                        if (chunks.length === 0 && part.content.trim()) chunks.push(part.content.trim());

                        for (let i = 0; i < chunks.length; i++) {
                            let chunk = chunks[i];
                            const delay = Math.min(Math.max(chunk.length * 50, 500), 2000);
                            await new Promise(r => setTimeout(r, delay));

                            let chunkReplyTarget: { id: number, content: string, name: string } | undefined;
                            const chunkQuoteMatch = chunk.match(/\[{1,2}QUOTE:\s*(.*?)\]{1,2}/);
                            if (chunkQuoteMatch) {
                                const quotedText = chunkQuoteMatch[1].trim();
                                if (quotedText) {
                                    const targetMsg = historySlice.slice().reverse().find((m: Message) => m.role === 'user' && m.content.includes(quotedText))
                                        || (quotedText.length > 10 ? historySlice.slice().reverse().find((m: Message) => m.role === 'user' && m.content.includes(quotedText.slice(0, 10))) : undefined);
                                    if (targetMsg) chunkReplyTarget = { id: targetMsg.id, content: targetMsg.content, name: userProfile.name };
                                }
                                chunk = chunk.replace(/\[{1,2}QUOTE:\s*.*?\]{1,2}/g, '').trim();
                            }

                            const replyData = chunkReplyTarget || (partIndex === 0 && i === 0 ? aiReplyTarget : undefined);

                            // Skip chunks that are just separators/markers after cleanup
                            const cleanedChunk = chunk
                                .replace(/%%BILINGUAL%%/g, '')
                                .replace(/%%TRANS%%[\s\S]*/g, '')
                                .replace(/^\s*---\s*$/gm, '')
                                .trim();
                            if (cleanedChunk) {
                                await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: chunk, replyTo: replyData });
                                setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                            }
                        }
                    }
                }
            } else {
                // If content was empty (e.g. only actions), just refresh
                setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
            }

        } catch (e: any) {
            await DB.saveMessage({ charId: char.id, role: 'system', type: 'text', content: `[连接中断: ${e.message}]` });
            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
        } finally {
            setIsTyping(false);
            setRecallStatus('');
            setSearchStatus('');
        }
    };

    return {
        isTyping,
        recallStatus,
        searchStatus,
        lastTokenUsage,
        setLastTokenUsage, // Allow manual reset if needed
        triggerAI
    };
};
